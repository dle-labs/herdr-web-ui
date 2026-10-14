import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { FileSearchResult } from "../shared/protocol.ts";
import { RepoDiffError, repoDiffFileInventory } from "./repo-diff.ts";

const CACHE_MS = 5_000;
const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 6;
const DEADLINE_MS = 3_000;
const SKIP: Record<string, true> = { ".git": true, node_modules: true, dist: true, target: true, ".venv": true };
type Inventory = Pick<FileSearchResult, "root" | "files" | "repository" | "incomplete">;
interface CachedInventory { expires: number; result: Promise<Inventory>; controller: AbortController; users: number; settled: boolean }
const cache = new Map<string, CachedInventory>();

function walkFiles(cwd: string, deadline = Date.now() + DEADLINE_MS): Inventory {
  try { cwd = realpathSync(cwd); }
  catch { return { root: cwd, files: [], repository: false, incomplete: ["traversal"] }; }
  const files: string[] = [];
  const incomplete = new Set<FileSearchResult["incomplete"][number]>();
  let visited = 0;
  let scanned = 0;
  const visit = (directory: string, depth: number): void => {
    if (Date.now() >= deadline) { incomplete.add("deadline"); return; }
    if (depth > MAX_DEPTH) { incomplete.add("depth"); return; }
    if (visited >= MAX_ENTRIES) { incomplete.add("entries"); return; }
    const entries = [];
    try {
      if (!lstatSync(directory).isDirectory()) return;
      const dir = opendirSync(directory);
      try {
        for (;;) {
          if (Date.now() >= deadline) { incomplete.add("deadline"); break; }
          const entry = dir.readSync();
          if (!entry) break;
          scanned += 1;
          if (scanned > MAX_ENTRIES) { incomplete.add("entries"); break; }
          entries.push(entry);
        }
      } finally { dir.closeSync(); }
      if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) { incomplete.add("traversal"); return; }
    } catch { incomplete.add("traversal"); return; }
    entries.sort((left, right) => Number(left.isDirectory()) - Number(right.isDirectory()) || lexical(left.name, right.name));
    for (const entry of entries) {
      if (Date.now() >= deadline) { incomplete.add("deadline"); break; }
      if (visited >= MAX_ENTRIES) { incomplete.add("entries"); break; }
      if (SKIP[entry.name] || entry.isSymbolicLink()) continue;
      visited += 1;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) files.push(relative(cwd, path).split(sep).join("/"));
    }
  };
  visit(cwd, 0);
  files.sort(lexical);
  return { root: cwd, files, repository: false, incomplete: [...incomplete] };
}

async function loadInventory(cwd: string, signal: AbortSignal): Promise<Inventory> {
  const deadline = Date.now() + DEADLINE_MS;
  try {
    const result = await repoDiffFileInventory(cwd, { deadlineMs: DEADLINE_MS, signal });
    const files = result.files.sort(lexical);
    return { root: result.root, files, repository: true, incomplete: result.incomplete };
  } catch (error) {
    if (!(error instanceof RepoDiffError) || error.code === "git_cancelled") throw error;
    if (error.code === "not_a_repository" || error.code === "git_unavailable") {
      const result = walkFiles(cwd, deadline);
      if (error.code === "git_unavailable") result.incomplete.push("traversal");
      return result;
    }
    // A failed Git inventory is not an apparently complete non-Git walk.
    return { root: cwd, files: [], repository: true, incomplete: [error.code === "git_timeout" ? "deadline" : error.code === "git_output_limit" ? "output" : "traversal"] };
  }
}

async function inventory(cwd: string, signal?: AbortSignal): Promise<Inventory> {
  // A missing/relative pane cwd must never fall back to the bridge's own cwd.
  if (!isAbsolute(cwd)) throw new Error("file inventory requires an absolute pane directory");
  if (signal?.aborted) throw new RepoDiffError("git_cancelled", "file inventory was cancelled", 499);
  const canonical = realpathSync(cwd);
  let hit = cache.get(canonical);
  if (!hit || hit.expires <= Date.now() || hit.controller.signal.aborted) {
    const controller = new AbortController();
    hit = { expires: Date.now() + CACHE_MS, result: loadInventory(canonical, controller.signal), controller, users: 0, settled: false };
    cache.set(canonical, hit);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    const entry = hit;
    void hit.result.then(() => { entry.settled = true; }, () => { entry.settled = true; if (cache.get(canonical) === entry) cache.delete(canonical); });
  }
  const entry = hit;
  entry.users += 1;
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new RepoDiffError("git_cancelled", "file inventory was cancelled", 499));
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try { return await (signal ? Promise.race([entry.result, cancelled]) : entry.result); }
  finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
    entry.users -= 1;
    if (!entry.settled && entry.users === 0) entry.controller.abort();
  }
}

function lexical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function subsequence(path: string, query: string): boolean {
  const characters = [...query];
  let index = 0;
  for (const character of path) if (character === characters[index]) index += 1;
  return index === characters.length;
}
function score(path: string, query: string): number {
  if (!query) return 0;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name === query) return 4;
  if (name.includes(query)) return 3;
  if (lower.includes(query)) return 2;
  return subsequence(lower, query) ? 1 : -1;
}
function matches(files: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length > 4_096) return []; // no supported inventory path can match this
  return files.map((path) => ({ path, score: score(path, normalized) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || lexical(left.path, right.path))
    .map((item) => item.path);
}

/** Detailed search is rooted at the canonical repository root, or pane cwd outside Git. */
export async function paneFileSearch(cwd: string, query = "", limit = 100, options: { signal?: AbortSignal } = {}): Promise<FileSearchResult> {
  const result = await inventory(cwd, options.signal);
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 100));
  const ranked = matches(result.files, query);
  const incomplete = [...result.incomplete];
  if (ranked.length > boundedLimit) incomplete.push("matches");
  return { ...result, files: ranked.slice(0, boundedLimit), incomplete, truncated: incomplete.length > 0,
    limits: { max_entries: MAX_ENTRIES, max_results: boundedLimit, max_depth: MAX_DEPTH } };
}

/** Legacy composer callers keep cwd-relative names and the same string[] response. */
export async function paneFiles(cwd: string, query = "", limit = 20): Promise<string[]> {
  const result = await inventory(cwd);
  const prefix = relative(result.root, realpathSync(cwd)).split(sep).join("/");
  const files = prefix ? result.files.filter((path) => path.startsWith(`${prefix}/`)).map((path) => path.slice(prefix.length + 1)) : result.files;
  return matches(files, query).slice(0, Math.min(100, Math.max(1, Math.trunc(limit) || 20)));
}

const walked = new Map<string, { expires: number; files: string[] }>();

/** Agent-written bare names may refer to ignored output: preserve the general-preview walk. */
export function filesNamed(cwd: string, name: string, limit = 10): string[] {
  const suffix = name.replace(/^\.\//, "");
  let hit = walked.get(cwd);
  if (!hit || hit.expires <= Date.now()) {
    hit = { expires: Date.now() + CACHE_MS, files: walkFiles(cwd).files };
    walked.set(cwd, hit);
    if (walked.size > 16) walked.delete(walked.keys().next().value!);
  }
  return hit.files.filter((path) => path === suffix || path.endsWith(`/${suffix}`)).slice(0, limit);
}

export function clearFileCache(): void { for (const entry of cache.values()) if (!entry.settled) entry.controller.abort(); cache.clear(); walked.clear(); }
