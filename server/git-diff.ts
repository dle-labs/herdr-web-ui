import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { GitChangedFile, GitChangesResponse, GitDiffMode, GitFileDiffResponse } from "../shared/protocol.ts";
import { herdrRpc, HerdrError, sessionSnapshot } from "./herdr/client.ts";

const FILE_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 10_000;
const MAX_FILES = 20_000;
export class GitDiffError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function isGitDiffMode(mode: string | null): mode is GitDiffMode {
  return mode === "all" || mode === "unstaged" || mode === "staged";
}

export async function paneGitCwd(paneId: string): Promise<string> {
  const pane = (await sessionSnapshot()).panes.find((entry) => entry.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", "The pane no longer exists");
  const info = await herdrRpc<{ process_info?: { shell_pid?: number; foreground_processes?: { pid?: number }[] } }>("pane.process_info", { pane_id: paneId });
  if (process.platform === "linux") {
    for (const pid of [...(info.process_info?.foreground_processes ?? []).map((entry) => entry.pid), info.process_info?.shell_pid]) {
      if (!Number.isSafeInteger(pid) || !pid || pid < 1) continue;
      try { return readlinkSync(`/proc/${pid}/cwd`); } catch { /* exited or inaccessible; use the pane's known cwd */ }
    }
  }
  const cwd = pane.foreground_cwd || pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", "The pane has no working directory");
  return cwd;
}

export class GitReader {
  readonly deadline = Date.now() + REQUEST_MS;
  bytes = 0;
  truncated = false;
  async run(cwd: string, args: string[], allowFailure = false, input?: Uint8Array, truncate = false): Promise<Buffer> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new GitDiffError("git_timeout", "Git inspection timed out", 504);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" });
    let proc;
    try {
      proc = Bun.spawn(["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", cwd, ...args], {
        env, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe",
      });
    } catch { throw new GitDiffError("git_unavailable", "Git is not available", 503); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, remaining);
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
      const parts: Uint8Array[] = [];
      const source = stream.getReader();
      try {
        while (true) {
          const { done, value: chunk } = await source.read();
          if (done) break;
          const available = Math.max(0, OUTPUT_BYTES - this.bytes);
          this.bytes += chunk.length;
          if (this.bytes > OUTPUT_BYTES) {
            proc.kill();
            if (!truncate) throw new GitDiffError("git_too_large", "Git inspection exceeds the output budget", 413);
            this.truncated = true;
            parts.push(chunk.subarray(0, available));
            break;
          }
          parts.push(chunk);
        }
      } finally { source.releaseLock(); }
      return Buffer.concat(parts);
    };
    try {
      const [out, , code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      if (timedOut) throw new GitDiffError("git_timeout", "Git inspection timed out", 504);
      if (truncate && this.truncated) return out;
      if (code !== 0 && !allowFailure) throw new GitDiffError("git_failed", "Git could not inspect this repository", 422);
      return code === 0 ? out : Buffer.alloc(0);
    } finally { clearTimeout(timer); }
  }
}

function checkedPath(path: string): void {
  if (!path || isAbsolute(path) || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "." || !part)
    || (process.platform === "win32" && (path.includes("\\") || path.includes(":")))) {
    throw new GitDiffError("invalid_path", "Use a repository-relative changed file path");
  }
}

// Never traverse a working-tree directory symlink. A file symlink is represented by its link text.
function workingStat(root: string, path: string): ReturnType<typeof lstatSync> | null {
  checkedPath(path);
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index++) {
    try {
      const stat = lstatSync(join(root, ...parts.slice(0, index)));
      if (stat.isSymbolicLink()) throw new GitDiffError("git_unsafe_path", "A changed path traverses a directory symlink", 403);
      if (!stat.isDirectory()) return null;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  try { return lstatSync(join(root, path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

interface Entry { file: GitChangedFile; oldMode: string; newMode: string; oldOid: string; newOid: string }
interface Inventory { root: string; revision: string; entries: Entry[]; compare: string[] }
const statuses: Record<string, GitChangedFile["status"]> = { A: "added", M: "modified", T: "modified", D: "deleted", R: "renamed", C: "added", U: "conflicted" };
const diffFlags = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--find-renames", "--no-relative"];
export function validateBaseCommit(mode: GitDiffMode, baseCommit?: string): void {
  if (baseCommit !== undefined && (mode !== "all" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(baseCommit))) {
    throw new GitDiffError("invalid_base_commit", "base_commit must be a full commit ID and requires mode=all");
  }
}

async function inventory(reader: GitReader, cwd: string, mode: GitDiffMode, baseCommit?: string): Promise<Inventory> {
  validateBaseCommit(mode, baseCommit);
  const rootOutput = await reader.run(cwd, ["rev-parse", "--show-toplevel"], true);
  if (!rootOutput.length) throw new GitDiffError("not_git_repository", "The pane is not in a Git working tree", 404);
  const root = realpathSync(rootOutput.toString().replace(/\r?\n$/, ""));
  const head = (await reader.run(root, ["rev-parse", "--verify", "HEAD"], true)).toString().trim();
  if (baseCommit !== undefined) {
    const resolved = (await reader.run(root, ["rev-parse", "--verify", `${baseCommit}^{commit}`], true)).toString().trim();
    if (resolved !== baseCommit.toLowerCase()) throw new GitDiffError("invalid_base_commit", "base_commit does not name a commit in this repository");
  }
  const base = baseCommit?.toLowerCase() || head || (await reader.run(root, ["hash-object", "-t", "tree", "--stdin"], false, new Uint8Array())).toString().trim();
  const compare = mode === "unstaged" ? [] : mode === "staged" ? ["--cached", base] : [base];
  const index = (await reader.run(root, ["ls-files", "--stage", "-z"])).toString();
  const tracked = index.split("\0").filter(Boolean).map((record) => record.slice(record.indexOf("\t") + 1));
  // Git reports embedded repositories as directory entries ending in '/'. Their contents
  // are unsupported here; omit them without relaxing validation for ordinary file paths.
  const untracked = mode === "staged" ? [] : (await reader.run(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter((path) => path && !path.endsWith("/"));
  const paths = [...new Set([...tracked, ...untracked])].sort();
  if (paths.length > MAX_FILES) throw new GitDiffError("git_too_large", "Repository inventory exceeds the file budget", 413);
  const fingerprint = createHash("sha256").update(mode).update(head).update(baseCommit?.toLowerCase() ?? "").update(index);
  if (mode !== "staged") for (const path of paths) {
    if (Date.now() > reader.deadline) throw new GitDiffError("git_timeout", "Git inspection timed out", 504);
    const stat = workingStat(root, path);
    fingerprint.update(JSON.stringify([path, stat ? [stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino] : null]));
  }
  const raw = (await reader.run(root, ["diff", ...diffFlags, "--raw", "--no-abbrev", "-z", ...compare, "--"])).toString().split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i < raw.length && raw[i];) {
    const [oldMode, newMode, oldOid, newOid, status] = raw[i++]!.slice(1).split(" ");
    const first = raw[i++]!;
    const renamed = status?.startsWith("R");
    const copied = status?.startsWith("C");
    const path = renamed || copied ? raw[i++]! : first;
    checkedPath(path);
    entries.push({ file: { path, status: statuses[status?.[0] ?? ""] ?? "modified", ...(renamed ? { old_path: first } : {}) }, oldMode: oldMode!, newMode: newMode!, oldOid: oldOid!, newOid: newOid! });
  }
  // Unstaged raw output may report both U and M for one unmerged path.
  const byPath = new Map(entries.map((entry) => [entry.file.path, entry]));
  const conflicts = new Set(index.split("\0").filter((record) => /^\d+ [a-f0-9]+ [123]\t/.test(record)).map((record) => record.slice(record.indexOf("\t") + 1)));
  for (const path of conflicts) {
    const existing = byPath.get(path);
    if (existing) existing.file.status = "conflicted";
    else byPath.set(path, { file: { path, status: "conflicted" }, oldMode: "0", newMode: "0", oldOid: "0", newOid: "0" });
  }
  for (const path of untracked) if (!byPath.has(path)) {
    byPath.set(path, { file: { path, status: "untracked" }, oldMode: "000000", newMode: "100644", oldOid: "0", newOid: "0" });
  }
  const unique = [...byPath.values()].sort((a, b) => a.file.path.localeCompare(b.file.path));
  if (unique.length > MAX_FILES) throw new GitDiffError("git_too_large", "Changes inventory exceeds the file budget", 413);
  fingerprint.update(JSON.stringify(unique));
  return { root, revision: fingerprint.digest("hex"), entries: unique, compare };
}

export async function gitChanges(cwd: string, mode: GitDiffMode, baseCommit?: string): Promise<GitChangesResponse> {
  const { root, revision, entries } = await inventory(new GitReader(), cwd, mode, baseCommit);
  return { root, revision, ...(baseCommit === undefined ? {} : { base_commit: baseCommit.toLowerCase() }), files: entries.map((entry) => entry.file) };
}

function workingBytes(root: string, path: string): Buffer | null {
  const stat = workingStat(root, path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(join(root, path)));
  if (!stat.isFile()) throw new GitDiffError("git_submodule", "Directory and submodule diffs are not supported", 415);
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    const actual = realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : join(root, path));
    const inside = relative(root, actual);
    if (inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside)) {
      throw new GitDiffError("git_unsafe_path", "The changed file is outside this repository", 403);
    }
    if (stat.ino !== current.ino || stat.dev !== current.dev) throw new GitDiffError("git_changed", "The file changed during inspection; refresh changes", 409);
    if (!current.isFile() || current.size > FILE_BYTES) throw new GitDiffError("git_too_large", "Selected file exceeds the 2 MiB limit", 413);
    const bytes = Buffer.alloc(FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > FILE_BYTES) throw new GitDiffError("git_too_large", "Selected file exceeds the 2 MiB limit", 413);
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export async function gitFileDiff(cwd: string, mode: GitDiffMode, path: string, baseCommit?: string): Promise<GitFileDiffResponse> {
  checkedPath(path);
  const reader = new GitReader();
  const before = await inventory(reader, cwd, mode, baseCommit);
  const entry = before.entries.find((candidate) => candidate.file.path === path);
  if (!entry) throw new GitDiffError("git_path_not_changed", "The path is not in this changes inventory", 404);
  if (entry.file.status === "conflicted") throw new GitDiffError("git_conflict", "Resolve this file's conflict before comparing two sides", 409);
  if (entry.oldMode === "160000" || entry.newMode === "160000") throw new GitDiffError("git_submodule", "Submodule diffs are not supported", 415);
  const blob = async (oid: string): Promise<Buffer | null> => {
    if (/^0+$/.test(oid)) return null;
    const size = Number((await reader.run(before.root, ["cat-file", "-s", oid])).toString());
    if (size > FILE_BYTES) throw new GitDiffError("git_too_large", "Selected file exceeds the 2 MiB limit", 413);
    return reader.run(before.root, ["cat-file", "blob", oid]);
  };
  const oldBytes = await blob(entry.oldOid);
  // A raw deletion has no new side even when `git rm --cached` leaves the file on disk.
  const newBytes = entry.newMode === "000000" ? null : mode === "staged" ? await blob(entry.newOid) : workingBytes(before.root, path);
  let binary = [oldBytes, newBytes].some((bytes) => bytes !== null && (bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)));
  let patch = "";
  if (entry.file.status === "untracked") {
    if (!binary && newBytes !== null) {
      const text = newBytes.toString();
      const lines = text ? text.replace(/\n$/, "").split("\n") : [];
      const quoted = JSON.stringify(`b/${path}`);
      patch = `diff --git ${JSON.stringify(`a/${path}`)} ${quoted}\nnew file mode ${workingStat(before.root, path)?.isSymbolicLink() ? "120000" : "100644"}\n--- /dev/null\n+++ ${quoted}\n`;
      if (lines.length) patch += `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}${text.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
    }
  } else {
    patch = (await reader.run(before.root, ["diff", ...diffFlags, "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", ...before.compare, "--", ...(entry.file.old_path ? [entry.file.old_path] : []), path])).toString();
  }
  binary ||= /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);
  const after = await inventory(reader, cwd, mode, baseCommit);
  if (before.revision !== after.revision) throw new GitDiffError("git_changed", "The repository changed during inspection; refresh changes", 409);
  const side = (bytes: Buffer | null, name: string) => bytes === null ? null : { name, contents: binary ? "" : bytes.toString("utf8") };
  return { root: before.root, revision: before.revision, ...(baseCommit === undefined ? {} : { base_commit: baseCommit.toLowerCase() }), path, ...(entry.file.old_path ? { old_path: entry.file.old_path } : {}), patch, binary,
    old_file: side(oldBytes, entry.file.old_path ?? path), new_file: side(newBytes, path) };
}
