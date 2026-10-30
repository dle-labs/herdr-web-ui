import { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommitsResponse, WorkspaceFilesResponse } from "../shared/protocol.ts";
import { GitDiffError, GitReader } from "./git-diff.ts";

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 12;
const LIMIT = 100;

async function repositoryRoot(reader: GitReader, cwd: string): Promise<string | null> {
  const out = await reader.run(cwd, ["rev-parse", "--show-toplevel"], true);
  return out.length ? realpath(out.toString().replace(/\r?\n$/, "")) : null;
}

export async function gitCommits(cwd: string, query = ""): Promise<GitCommitsResponse> {
  const reader = new GitReader();
  const root = await repositoryRoot(reader, cwd);
  if (!root) throw new GitDiffError("not_git_repository", "The pane is not in a Git working tree", 404);
  const head = (await reader.run(root, ["rev-parse", "--verify", "HEAD"], true)).toString().trim();
  if (!head) return { commits: [], truncated: false };
  const needle = query.trim();
  if (needle.includes("\0")) throw new GitDiffError("invalid_query", "Commit search cannot contain NUL characters");
  let revision = head;
  let hashMatch = false;
  // Only hexadecimal object IDs can become revisions. Resolve abbreviations through
  // Git, reject noncommits, and prove reachability against the same captured HEAD.
  if (/^[a-f0-9]{4,64}$/i.test(needle)) {
    const resolved = (await reader.run(root, ["rev-parse", "--verify", `${needle}^{commit}`], true)).toString().trim();
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(resolved) && resolved.startsWith(needle.toLowerCase())) {
      const ancestor = (await reader.run(root, ["merge-base", resolved, head], true)).toString().trim();
      if (ancestor === resolved) { revision = resolved; hashMatch = true; }
    }
  }
  // Git filters before max-count, so a refined message query can find old history.
  // --grep= keeps even option-looking text a value; fixed strings disables regexps.
  const filter = needle && !hashMatch ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${needle}`] : [];
  const output = await reader.run(root, ["log", "--no-show-signature", "--encoding=UTF-8", `--max-count=${hashMatch ? 1 : LIMIT + 1}`, ...filter, "--format=%H%x00%s%x00%an%x00%aI%x00", revision, "--"], false, undefined, true);
  const fields = output.toString().split("\0");
  const commits: GitCommitsResponse["commits"] = [];
  for (let i = 0; i + 4 < fields.length; i += 4) {
    const id = fields[i]!.trim();
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) commits.push({ id, subject: fields[i + 1]!, author: fields[i + 2]!, date: fields[i + 3]! });
  }
  return { commits: commits.slice(0, LIMIT), truncated: reader.truncated || commits.length > LIMIT };
}

function score(path: string, query: string): number {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (!query) return 0;
  if (name === query) return 4;
  if (name.includes(query)) return 3;
  if (lower.includes(query)) return 2;
  let at = 0;
  for (const character of lower) if (character === query[at]) at++;
  return at === query.length ? 1 : -1;
}

export async function workspaceFiles(cwd: string, query = ""): Promise<WorkspaceFilesResponse> {
  const reader = new GitReader();
  let repo: string | null;
  try { repo = await repositoryRoot(reader, cwd); }
  catch (error) { if (error instanceof GitDiffError && error.code === "git_unavailable") repo = null; else throw error; }
  const root = repo ?? await realpath(cwd);
  let files: string[] = [];
  let truncated = false;
  if (repo) {
    const output = await reader.run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], false, undefined, true);
    const records = output.toString().split("\0");
    // Only consume complete NUL-terminated records, including when the byte budget stops Git.
    records.pop();
    const unique = [...new Set(records.filter((path) => path && !path.endsWith("/")))];
    truncated = reader.truncated || unique.length > MAX_ENTRIES;
    files = unique.slice(0, MAX_ENTRIES);
  } else {
    let visited = 0;
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || Date.now() >= reader.deadline) { truncated = true; return; }
      try {
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (++visited > MAX_ENTRIES || Date.now() >= reader.deadline) { truncated = true; break; }
          if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
          const path = prefix + entry.name;
          if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`, depth + 1);
          else if (entry.isFile()) files.push(path);
          if (visited > MAX_ENTRIES) break;
        }
      } catch { truncated = true; }
    };
    await walk(root, "", 0);
  }
  const needle = query.trim().toLowerCase();
  const matches = files.map((path) => ({ path, score: score(path, needle) })).filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { root, files: matches.slice(0, LIMIT).map((item) => item.path), truncated: truncated || matches.length > LIMIT };
}
