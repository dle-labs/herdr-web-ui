import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type { FileSearchResult, RepoCommitSearch, RepoDiffFile, RepoDiffFileList, RepoDiffFilePatch, RepoDiffRepository, RepoDiffScope, RepoDiffStatus } from "../shared/protocol.ts";
import { errorResponse, jsonResponse } from "./http.ts";
import { Inspection } from "./inspection-worker.ts";

/**
 * What changed in the repository a pane (or a named folder) sits in, read with git and never
 * written: the list of changed files, and one file's patch at a time. The two are separate reads
 * so a repository with one enormous change does not cost every other file its diff.
 *
 * Every git call is an argv array (no shell), with external diff drivers, textconv filters, the
 * fsmonitor hook, optional locks and pathspec magic switched off, a byte cap on what is read and
 * a deadline after which the process is killed. A patch is sent whole or not at all: one that
 * passes its cap is reported as unavailable, never cut in the middle of a hunk.
 *
 * It reads what this server's user can read in that repository, which is no more than the
 * terminal the same browser can already type `git diff` into.
 */

/** A list holds at most this many files; `truncated` and `total` say when there were more. */
export const REPO_DIFF_MAX_FILES = 2_000;
/** What one listing command may print before it is stopped (names, statuses, line counts). */
export const REPO_DIFF_MAX_LIST_BYTES = 2 * 1024 * 1024;
/** One file's patch; a larger one is answered as `too_large` with no patch text. */
export const REPO_DIFF_MAX_PATCH_BYTES = 1024 * 1024;
/** Unchanged lines around each change, as `git diff` prints by default. */
export const REPO_DIFF_CONTEXT_LINES = 3;
/** Aggregate request deadline, shared by every inspection process and recheck. */
export const REPO_DIFF_DEADLINE_MS = 10_000;
const MAX_PATH_BYTES = 4_096;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_INSPECTION_BYTES = 8 * 1024 * 1024;

export interface RepoDiffOptions {
  /** the git to run (a stand-in, in tests) */
  git?: string;
  deadlineMs?: number;
  maxFiles?: number;
  maxListBytes?: number;
  maxPatchBytes?: number;
  maxInspectionBytes?: number;
  signal?: AbortSignal;
}

/** A refusal in the API's own words: it never carries git's stderr. */
export class RepoDiffError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

interface GitRun { code: number | null; stdout: string; overflow: boolean; bytes?: Buffer }

interface Context {
  fs: Inspection;
  git: string;
  deadlineAt: number;
  remainingBytes: number;
  signal?: AbortSignal;
  maxFiles: number;
  maxListBytes: number;
  maxPatchBytes: number;
}

async function inspect<T>(options: RepoDiffOptions, read: (context: Context) => Promise<T>): Promise<T> {
  const context = {
    git: options.git ?? "git",
    deadlineAt: Date.now() + Math.min(options.deadlineMs ?? REPO_DIFF_DEADLINE_MS, REPO_DIFF_DEADLINE_MS),
    remainingBytes: Math.min(options.maxInspectionBytes ?? MAX_INSPECTION_BYTES, MAX_INSPECTION_BYTES),
    signal: options.signal,
    maxFiles: Math.min(options.maxFiles ?? REPO_DIFF_MAX_FILES, REPO_DIFF_MAX_FILES),
    maxListBytes: Math.min(options.maxListBytes ?? REPO_DIFF_MAX_LIST_BYTES, REPO_DIFF_MAX_LIST_BYTES),
    maxPatchBytes: Math.min(options.maxPatchBytes ?? REPO_DIFF_MAX_PATCH_BYTES, REPO_DIFF_MAX_PATCH_BYTES),
  } as Context;
  context.fs = new Inspection(context.deadlineAt, context.signal, context);
  try { return await read(context); }
  catch (error) {
    if (error instanceof Error && "code" in error && "status" in error && !(error instanceof RepoDiffError)) throw new RepoDiffError(String(error.code), error.message, Number(error.status));
    throw error;
  } finally { context.fs.close(); }
}

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside (a hook, a test runner) is not the one asked about
    if (value === undefined || name.startsWith("GIT_")) continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** One git process in `cwd`: stdout up to `maxBytes`, killed at the deadline or once it prints more. */
async function runGit(context: Context, cwd: string, args: string[], maxBytes: number): Promise<GitRun> {
  if (context.signal?.aborted) throw new RepoDiffError("git_cancelled", "git inspection was cancelled", 499);
  const remainingMs = context.deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RepoDiffError("git_timeout", "git did not answer in time", 504);
  if (context.remainingBytes <= 0) throw new RepoDiffError("git_output_limit", "git inspection exceeded its output budget", 413);
  const argv = [context.git, "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "color.ui=never", "-C", cwd, ...args];
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment() });
  } catch {
    throw new RepoDiffError("git_unavailable", "git could not be started on this PC", 503);
  }
  const reader = proc.stdout.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    void reader.cancel().catch(() => undefined);
  }, remainingMs);
  const cancel = () => { proc.kill("SIGKILL"); void reader.cancel().catch(() => undefined); };
  context.signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      context.remainingBytes -= value.byteLength;
      if (context.remainingBytes < 0) { cancel(); throw new RepoDiffError("git_output_limit", "git inspection exceeded its output budget", 413); }
      if (size > maxBytes) {
        overflow = true;
        const keep = value.byteLength - (size - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        proc.kill("SIGKILL");
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    const code = await proc.exited;
    if (context.signal?.aborted) throw new RepoDiffError("git_cancelled", "git inspection was cancelled", 499);
    if (timedOut || Date.now() >= context.deadlineAt) throw new RepoDiffError("git_timeout", "git did not answer in time", 504);
    const bytes = Buffer.concat(chunks);
    return { code: overflow ? null : code, stdout: bytes.toString("utf8"), bytes, overflow };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", cancel);
  }
}

async function repositoryOf(context: Context, cwd: string): Promise<RepoDiffRepository> {
  if (!isAbsolute(cwd)) throw new RepoDiffError("invalid_cwd", "directory must be an existing absolute directory on this PC", 400);
  cwd = await context.fs.call("canonical", cwd);
  const top = await runGit(context, cwd, ["rev-parse", "--show-toplevel"], 16 * 1024);
  let root = top.stdout.replace(/\r?\n$/, "");
  if (top.code !== 0 || root === "") throw new RepoDiffError("not_a_repository", "that folder is not inside a git working tree", 409);
  root = await context.fs.call("canonical", root);
  const [branch, head] = await Promise.all([
    runGit(context, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 16 * 1024),
    runGit(context, root, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], 1024),
  ]);
  const oid = head.code === 0 ? head.stdout.trim() : "";
  const name = branch.code === 0 ? branch.stdout.replace(/\r?\n$/, "") : "";
  return { root, branch: name === "" ? null : name, head: oid === "" ? null : oid, detached: name === "" && oid !== "", unborn: oid === "" };
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/;

async function resolveRevision(context: Context, root: string, name: string, value: string): Promise<string> {
  if (!REVISION.test(value) || value.includes("..")) throw new RepoDiffError("invalid_revision", `${name} must name one commit: a hash, a branch, a tag or an expression such as HEAD~1`, 400);
  const parsed = await runGit(context, root, ["rev-parse", "--quiet", "--verify", "--end-of-options", `${value}^{commit}`], 1024);
  const oid = parsed.stdout.trim();
  if (parsed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new RepoDiffError("revision_not_found", `${name} names no commit in this repository`, 404);
  return oid;
}

function scopeOf(value: string | null): RepoDiffScope {
  if (value === null || value === "" || value === "workspace") return "workspace";
  if (value === "all" || value === "staged" || value === "commit") return value;
  throw new RepoDiffError("invalid_scope", "scope must be all, workspace, staged or commit", 400);
}

/** A path inside the repository, as git names it: relative, forward slashes, no `..`. */
function repositoryPath(name: string, value: string): string {
  const segments = value.split("/");
  if (value === "" || value.includes("\0") || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value) || Buffer.byteLength(value) > MAX_PATH_BYTES || segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new RepoDiffError("invalid_path", `${name} must be a file path relative to the repository root`, 400);
  }
  return value;
}

interface Comparison { scope: RepoDiffScope; base: string | null; head: string | null; args: string[] }

async function comparisonOf(context: Context, repository: RepoDiffRepository, params: URLSearchParams): Promise<Comparison> {
  const root = repository.root;
  const scope = scopeOf(params.get("scope"));
  const base = params.get("base");
  const head = params.get("head");
  if (scope !== "commit") {
    if (head !== null || (base !== null && scope !== "all")) throw new RepoDiffError("invalid_revision", "base applies to all or commit; head applies to commit only", 400);
    if (scope === "workspace") return { scope, base: null, head: null, args: [] };
    let from = repository.head;
    if (base !== null) {
      if (!/^[0-9a-f]{40,64}$/.test(base) || !repository.head) throw new RepoDiffError("invalid_revision", "base must be a full reachable commit ID", 400);
      from = await reachableRevision(context, repository, base);
      if (!from || from !== base) throw new RepoDiffError("revision_not_found", "base names no reachable commit in this repository", 404);
    }
    if (!from) {
      const empty = await runGit(context, root, ["hash-object", "-t", "tree", "--stdin"], 1024);
      if (empty.code !== 0) throw new RepoDiffError("git_failed", "git could not inspect this repository", 500);
      from = empty.stdout.trim();
    }
    return { scope, base: from, head: repository.head, args: scope === "staged" ? ["--cached", from] : [from] };
  }
  if (base === null) throw new RepoDiffError("invalid_revision", "scope=commit needs a base revision", 400);
  const [from, to] = await Promise.all([resolveRevision(context, root, "base", base), resolveRevision(context, root, "head", head ?? "HEAD")]);
  return { scope, base: from, head: to, args: [from, to] };
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=dirty", "--src-prefix=a/", "--dst-prefix=b/"];

const STATUS: Record<string, RepoDiffStatus> = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "copied", T: "type_changed", U: "unmerged" };

/** The whole NUL-terminated fields of `-z` output: what follows the last NUL was cut short. */
function fields(output: string): string[] {
  const end = output.lastIndexOf("\0");
  return end < 0 ? [] : output.slice(0, end).split("\0");
}

interface Listing { files: RepoDiffFile[]; complete: boolean; replacements: Set<string> }

async function changedFiles(context: Context, root: string, comparison: Comparison): Promise<Listing> {
  const tail = [...comparison.args, "--"];
  const [names, counts, others, conflicts] = await Promise.all([
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...tail], context.maxListBytes),
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", ...tail], context.maxListBytes),
    (comparison.scope === "workspace" || comparison.scope === "all")
      ? runGit(context, root, ["ls-files", "-z", "--others", "--exclude-standard", "--"], context.maxListBytes)
      : Promise.resolve<GitRun>({ code: 0, stdout: "", overflow: false }),
    comparison.scope !== "commit" ? runGit(context, root, ["ls-files", "--unmerged", "-z", "--"], context.maxListBytes)
      : Promise.resolve<GitRun>({ code: 0, stdout: "", overflow: false }),
  ]);
  for (const run of [names, counts, others, conflicts]) {
    if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare this repository", 500);
  }
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const numbers = fields(counts.stdout);
  for (let index = 0; index < numbers.length; index += 1) {
    const [added, deleted, ...rest] = numbers[index]!.split("\t");
    if (added === undefined || deleted === undefined) break;
    let path = rest.join("\t");
    // a rename: the counts stand alone, then the old and the new name
    if (path === "") { path = numbers[index + 2] ?? ""; index += 2; }
    if (path === "") break;
    const binary = added === "-" || deleted === "-";
    stats.set(path, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  const found = new Map<string, RepoDiffFile>();
  const named = fields(names.stdout);
  for (let index = 0; index < named.length;) {
    const letter = named[index]![0] ?? "";
    const status = STATUS[letter];
    const paired = letter === "R" || letter === "C";
    const path = named[index + (paired ? 2 : 1)];
    if (status === undefined || path === undefined) break;
    // a conflict's counts are those of a combined diff, which no one is shown
    const stat = status === "unmerged" ? undefined : stats.get(path);
    const file: RepoDiffFile = { path, old_path: paired ? named[index + 1]! : null, status, additions: stat?.additions ?? null, deletions: stat?.deletions ?? null, binary: stat?.binary ?? null };
    // a conflicted file can be named twice; the conflict is what there is to say about it
    if (found.get(path)?.status !== "unmerged") found.set(path, file);
    index += paired ? 3 : 2;
  }
  const replacements = new Set<string>();
  const recreated = new Set<string>();
  if (comparison.scope === "all") for (const file of found.values()) {
    if (file.status !== "deleted") continue;
    const path = repositoryPath("path", file.path);
    // Git's base/index/worktree diff omits an index-deleted path recreated on disk.
    // Even an ignored replacement belongs to its existing immutable-base identity.
    const current = await context.fs.call("disk", root, path);
    if (current.content === null && current.unavailable === null) continue;
    const old = await gitSide(context, root, comparison.base, path);
    recreated.add(path);
    if (old.digest && old.digest === current.digest && old.mode === current.mode) { found.delete(path); continue; }
    replacements.add(path);
    found.set(path, { path, old_path: null, status: old.mode && current.mode && (old.mode === "120000") !== (current.mode === "120000") ? "type_changed" : "modified", additions: null, deletions: null, binary: old.unavailable === "binary" || current.unavailable === "binary" ? true : null });
  }
  for (const path of fields(others.stdout)) {
    if (path.endsWith("/")) continue; // embedded repositories are directory entries, not files
    repositoryPath("path", path);
    if (!found.has(path) && !recreated.has(path)) found.set(path, { path, old_path: null, status: "untracked", additions: null, deletions: null, binary: null });
  }
  for (const entry of fields(conflicts.stdout)) {
    const path = entry.slice(entry.indexOf("\t") + 1);
    found.set(path, { path, old_path: null, status: "unmerged", additions: null, deletions: null, binary: null });
  }
  for (const file of found.values()) {
    repositoryPath("path", file.path);
    if (file.old_path) repositoryPath("old_path", file.old_path);
  }
  const files = [...found.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, replacements, complete: !names.overflow && !counts.overflow && !others.overflow && !conflicts.overflow };
}

async function reachableRevision(context: Context, repository: RepoDiffRepository, value: string): Promise<string | null> {
  if (!repository.head || !/^[0-9a-fA-F]{4,64}$/.test(value)) return null;
  // --disambiguate consults object identities only, never a same-named branch/tag.
  const parsed = await runGit(context, repository.root, ["rev-parse", `--disambiguate=${value.toLowerCase()}`], 1024);
  const ids = parsed.stdout.trim().split("\n");
  const oid = ids[0] ?? "";
  if (parsed.overflow || parsed.code !== 0 || ids.length !== 1 || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
  const type = await runGit(context, repository.root, ["cat-file", "-t", oid], 32);
  if (type.code !== 0 || type.stdout.trim() !== "commit") return null;
  const reachable = await runGit(context, repository.root, ["merge-base", "--is-ancestor", oid, repository.head], 1024);
  return reachable.code === 0 ? oid : null;
}

/** Shared bounded Git inventory for filename search; directory/gitlink entries are omitted. */
export async function repoDiffFileInventory(cwd: string, options: RepoDiffOptions = {}): Promise<Pick<FileSearchResult, "root" | "files" | "incomplete">> {
  return inspect(options, async (context) => {
  const repository = await repositoryOf(context, cwd);
  const [tracked, others] = await Promise.all([
    runGit(context, repository.root, ["ls-files", "--stage", "-z"], context.maxListBytes),
    runGit(context, repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], context.maxListBytes),
  ]);
  for (const run of [tracked, others]) if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository", 500);
  const incomplete: FileSearchResult["incomplete"] = tracked.overflow || others.overflow ? ["output"] : [];
  const paths = fields(tracked.stdout).filter((entry) => !entry.startsWith("160000 ") && !entry.startsWith("040000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const files = new Set<string>();
  for (const path of [...paths, ...fields(others.stdout)]) {
    if (Date.now() >= context.deadlineAt) { incomplete.push("deadline"); break; }
    if (files.has(path) || path.endsWith("/")) continue;
    if (files.size >= 5_000) { incomplete.push("entries"); break; }
    repositoryPath("path", path);
    // Git's stored mode already excludes gitlinks. Keep tracked identities even when
    // their current parents were replaced by symlinks; opening them is a separate refusal.
    files.add(path);
  }
  return { root: repository.root, files: [...files], incomplete };
  });
}

/** GET /api/workspace/diff/commits: bounded message search from the captured immutable HEAD. */
export async function repoDiffCommits(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoCommitSearch> {
  return inspect(options, async (context) => {
  const repository = await repositoryOf(context, cwd);
  if (!repository.head) return { repository, head: null, commits: [], truncated: false };
  const query = (params.get("q") ?? "").trim();
  if (query.length > 512 || query.includes("\0")) throw new RepoDiffError("invalid_query", "commit search is limited to 512 characters", 400);
  const commit = await reachableRevision(context, repository, query);
  // Parse whole bounded records in JS: literal Unicode case folding, never regex or revision injection.
  const run = await runGit(context, repository.root, ["log", "-z", "--format=%H%x00%s%x00%an%x00%aI%x00%B", ...(commit ? ["-1", commit] : [repository.head]), "--"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not search this history", 500);
  const parts = fields(run.stdout);
  const commits: RepoCommitSearch["commits"] = [];
  let matches = 0;
  for (let index = 0; index + 4 < parts.length; index += 5) {
    const id = parts[index]!;
    if (!/^[0-9a-f]{40,64}$/.test(id)) break;
    if (!commit && query && !parts[index + 4]!.toLowerCase().includes(query.toLowerCase())) continue;
    matches += 1;
    if (commits.length < 100) commits.push({ id, subject: parts[index + 1]!, author: parts[index + 2]!, date: parts[index + 3]! });
  }
  return { repository, head: repository.head, commits, truncated: run.overflow || matches > 100 };
  });
}

function checkDeadline(context: Context): void {
  if (context.signal?.aborted) throw new RepoDiffError("git_cancelled", "git inspection was cancelled", 499);
  if (Date.now() >= context.deadlineAt) throw new RepoDiffError("git_timeout", "git did not answer in time", 504);
}

interface Snapshot { listing: Listing; fingerprint: string }
async function snapshot(context: Context, repository: RepoDiffRepository, comparison: Comparison): Promise<Snapshot> {
  const index = await runGit(context, repository.root, ["rev-parse", "--git-path", "index"], 16 * 1024);
  if (index.code !== 0 || index.overflow) throw new RepoDiffError("git_failed", "git could not inspect this repository", 500);
  const indexName = index.stdout.replace(/\r?\n$/, "");
  const indexPath = isAbsolute(indexName) ? indexName : join(repository.root, indexName);
  const before = await context.fs.call("metadata", indexPath);
  const head = await runGit(context, repository.root, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], 1024);
  if ((head.code === 0 ? head.stdout.trim() : null) !== repository.head) throw new RepoDiffError("stale_comparison", "the comparison changed; refresh it", 409);
  const listing = await changedFiles(context, repository.root, comparison);
  if (before !== await context.fs.call("metadata", indexPath)) throw new RepoDiffError("stale_comparison", "the index changed; refresh the comparison", 409);
  const paths = comparison.scope === "commit" || comparison.scope === "staged" ? [] : listing.files.flatMap((file) => file.old_path ? [file.path, file.old_path] : [file.path]);
  const work = await context.fs.call("states", repository.root, paths);
  checkDeadline(context);
  const fingerprint = createHash("sha256").update(JSON.stringify([comparison.scope, comparison.base, comparison.head, repository.head, comparison.scope === "commit" ? null : before, listing.complete, listing.files, work])).digest("hex");
  return { listing, fingerprint };
}

/** GET /api/workspace/diff/files */
export async function repoDiffFiles(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFileList> {
  return inspect(options, async (context) => {
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository, params);
  const { listing, fingerprint } = await snapshot(context, repository, comparison);
  const path = params.get("path");
  if (path !== null) repositoryPath("path", path);
  const files = path === null ? listing.files : listing.files.filter((file) => file.path === path || file.old_path === path);
  return { repository, scope: comparison.scope, base: comparison.base, head: comparison.head, fingerprint: listing.complete ? fingerprint : undefined,
    files: files.slice(0, context.maxFiles), total: listing.complete ? files.length : null,
    truncated: !listing.complete || files.length > context.maxFiles,
    limits: { max_files: context.maxFiles, max_list_bytes: context.maxListBytes } };
  });
}

interface Side { content: string | null; unavailable: RepoDiffFilePatch["unavailable"]; mode?: string; digest?: string }
function textSide(bytes: Buffer): Side {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.includes(0)) return { content: null, unavailable: "binary", digest };
  try { return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), unavailable: null, digest }; }
  catch { return { content: null, unavailable: "binary", digest }; }
}

async function gitSide(context: Context, root: string, revision: string | null, path: string): Promise<Side> {
  const run = await runGit(context, root, revision === null ? ["ls-files", "--stage", "-z", "--", path] : ["ls-tree", "-z", revision, "--", path], 16 * 1024);
  if (run.overflow || run.code !== 0) return { content: null, unavailable: "unsupported" };
  const entry = fields(run.stdout).find((field) => field.slice(field.indexOf("\t") + 1) === path);
  if (!entry) return { content: null, unavailable: null };
  const [mode, typeOrId, idOrStage] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (mode === "160000" || mode === "040000" || (revision === null && idOrStage !== "0")) return { content: null, unavailable: mode === "160000" || mode === "040000" ? "unsupported" : "unmerged" };
  const id = revision === null ? typeOrId : idOrStage;
  if (!id || !/^[0-9a-f]{40,64}$/.test(id)) return { content: null, unavailable: "unsupported" };
  const blob = await runGit(context, root, ["cat-file", "blob", id], MAX_CONTENT_BYTES);
  if (blob.overflow) return { content: null, unavailable: "too_large" };
  if (blob.code !== 0) return { content: null, unavailable: "unsupported" };
  return { ...textSide(blob.bytes!), mode };
}

/** Validate Git's hunks against the exact selected sides, including untouched spans and final newlines.
 * This is not a diff generator. It refuses mixed patch/source reads even if a path was replaced and
 * restored between metadata rechecks. The filesystem still is not an atomic snapshot. */
function patchMatchesSides(patch: string, oldContent: string | null, newContent: string | null): boolean {
  const linesOf = (content: string | null): string[] => content?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldLines = linesOf(oldContent);
  const newLines = linesOf(newContent);
  const rows = patch.split("\n");
  let oldEnd = 0;
  let newEnd = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[index]!);
    if (!header) continue;
    let oldCount = Number(header[2] ?? 1);
    let newCount = Number(header[4] ?? 1);
    const oldStart = Number(header[1]) - (oldCount === 0 ? 0 : 1);
    const newStart = Number(header[3]) - (newCount === 0 ? 0 : 1);
    if (oldStart < oldEnd || newStart < newEnd || oldLines.slice(oldEnd, oldStart).join("") !== newLines.slice(newEnd, newStart).join("")) return false;
    oldEnd = oldStart; newEnd = newStart;
    while (oldCount > 0 || newCount > 0) {
      const row = rows[++index];
      if (row === undefined || ![" ", "+", "-"].includes(row[0] ?? "")) return false;
      const noNewline = rows[index + 1]?.startsWith("\\ No newline at end of file");
      const content = `${row.slice(1)}${noNewline ? "" : "\n"}`;
      if (row[0] !== "+") { if (oldCount <= 0 || oldLines[oldEnd++] !== content) return false; oldCount -= 1; }
      if (row[0] !== "-") { if (newCount <= 0 || newLines[newEnd++] !== content) return false; newCount -= 1; }
      if (noNewline) index += 1;
    }
  }
  return oldLines.slice(oldEnd).join("") === newLines.slice(newEnd).join("");
}

/** GET /api/workspace/diff/file */
export async function repoDiffFile(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFilePatch> {
  return inspect(options, async (context) => {
  const path = repositoryPath("path", params.get("path") ?? "");
  const oldParam = params.get("old_path");
  const oldPath = oldParam === null || oldParam === "" ? null : repositoryPath("old_path", oldParam);
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository, params);
  const initial = await snapshot(context, repository, comparison);
  if (!initial.listing.complete) throw new RepoDiffError("incomplete_comparison", "the comparison inventory exceeded its limit", 413);
  if (params.has("fingerprint") && params.get("fingerprint") !== initial.fingerprint) throw new RepoDiffError("stale_comparison", "the comparison changed; refresh it", 409);
  // The full captured listing owns rename/untracked identity. A path-scoped redetection
  // can turn a reused original name into the rename's deletion and select the wrong sides.
  const file = initial.listing.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
  if (oldPath !== null && file.old_path !== oldPath) throw new RepoDiffError("invalid_path", "old_path no longer belongs to this file's change; refresh the list", 400);
  const pathspec = file.old_path && file.old_path !== path ? [file.old_path, path] : [path];

  let oldContent: string | null = null;
  let newContent: string | null = null;
  const answer = (patch: string | null, unavailable: RepoDiffFilePatch["unavailable"], described: RepoDiffFile = file): RepoDiffFilePatch => ({
    repository,
    scope: comparison.scope,
    base: comparison.base,
    head: comparison.head,
    fingerprint: initial.fingerprint,
    old_content: unavailable === null ? oldContent : null,
    new_content: unavailable === null ? newContent : null,
    file: described,
    patch,
    unavailable,
    truncated: unavailable === "too_large",
    limits: { max_patch_bytes: context.maxPatchBytes, context_lines: REPO_DIFF_CONTEXT_LINES },
  });

  if (file.status === "unmerged") return answer(null, "unmerged");
  if (file.binary === true) return answer(null, "binary");

  const previousPath = file.old_path ?? path;
  const oldSide: Side = file.status === "untracked" ? { content: null, unavailable: null } : await gitSide(context, repository.root, comparison.scope === "workspace" ? null : comparison.base, previousPath);
  const newSide: Side = comparison.scope === "commit" ? await gitSide(context, repository.root, comparison.head, path)
    : comparison.scope === "staged" ? await gitSide(context, repository.root, null, path)
    : await context.fs.call("disk", repository.root, path);
  const unavailable = oldSide.unavailable ?? newSide.unavailable;
  if (unavailable) return answer(null, unavailable, unavailable === "binary" ? { ...file, binary: true } : file);
  oldContent = oldSide.content;
  newContent = newSide.content;
  const beforePatch = await snapshot(context, repository, comparison);
  if (beforePatch.fingerprint !== initial.fingerprint) return answer(null, "stale");

  let run: GitRun;
  if (file.status === "type_changed") return answer(null, "unsupported");
  if (initial.listing.replacements.has(path)) {
    // Use Git's own diff on the exact selected copies: an index deletion must not hide
    // the actual recreated working file. No repository/index/object writes are needed.
    const copies = await context.fs.call("copies", oldContent ?? "", newContent ?? "", oldSide.mode, newSide.mode);
    run = await runGit(context, repository.root, ["diff", "--no-index", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, "--", join(copies, "old"), join(copies, "new")], context.maxPatchBytes);
    if (!run.overflow && run.code !== 1 && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare that file", 500);
    const quote = (name: string) => /[\x00-\x1f"\\]/.test(name) ? JSON.stringify(name) : name;
    // Only metadata headers are renamed; hunk text is left byte-for-byte as Git produced it.
    run.stdout = run.stdout.replace(/^diff --git .*\n/, () => `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\n`)
      .replace(/^--- .*\n/m, () => `--- ${quote(`a/${path}`)}\n`).replace(/^\+\+\+ .*\n/m, () => `+++ ${quote(`b/${path}`)}\n`);
    if (Buffer.byteLength(run.stdout) > context.maxPatchBytes) run.overflow = true;
  } else if (file.status === "untracked") {
    // an untracked file has no index entry to compare with: it is shown as a new file, whole
    run = await runGit(context, repository.root, ["diff", "--no-index", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, "--", "/dev/null", path], context.maxPatchBytes);
    if (!run.overflow && run.code !== 1 && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read that file", 500);
  } else {
    run = await runGit(context, repository.root, ["diff", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, ...comparison.args, "--", ...pathspec], context.maxPatchBytes);
    if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare that file", 500);
  }
  const afterPatch = await snapshot(context, repository, comparison);
  if (afterPatch.fingerprint !== initial.fingerprint) return answer(null, "stale");
  if (run.overflow) return answer(null, "too_large");
  // the file changed between the listing and this read, or git printed a form no patch reader takes
  if (run.stdout === "") throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
  if (!run.stdout.startsWith("diff --git ")) return answer(null, "unsupported");
  if (!patchMatchesSides(run.stdout, oldContent, newContent)) return answer(null, "stale");
  return answer(run.stdout, null, file.status === "untracked" ? { ...file, binary: false } : file);
  });
}

/** The HTTP answer of either route, with every refusal in the `{ error: { code, message } }` envelope. */
export async function repoDiffResponse(kind: "files" | "file" | "commits", cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<Response> {
  try {
    const body = kind === "files" ? await repoDiffFiles(cwd, params, options) : kind === "commits" ? await repoDiffCommits(cwd, params, options) : await repoDiffFile(cwd, params, options);
    return jsonResponse(body, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof RepoDiffError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
