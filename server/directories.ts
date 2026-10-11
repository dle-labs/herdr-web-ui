import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";

/** A folder with more subfolders than this lists the first ones and says it stopped. */
export const MAX_DIRECTORY_ENTRIES = 500;

const GIT_IGNORE_MS = 2_000;
const GIT_IGNORE_BYTES = 1024 * 1024;

/** Best-effort metadata for the already bounded listing; never hide or remove entries. */
export async function ignoredDirectories(path: string, directories: string[]): Promise<string[]> {
  if (!directories.length) return [];
  const env = { ...process.env };
  // Inspect this directory, not a repository selected by the bridge's environment.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  let proc;
  try {
    // Keep the index check: --no-index would incorrectly mark tracked folders ignored.
    // NUL framing handles spaces, newlines and leading dashes without a shell or quoting.
    proc = Bun.spawn(["git", "--no-pager", "-c", "core.fsmonitor=false", "-C", path, "check-ignore", "--stdin", "-z"], {
      env, stdin: Buffer.from(directories.map((name) => `./${name}\0`).join("")), stdout: "pipe", stderr: "pipe",
    });
  } catch { return []; }
  let failed = false;
  let bytes = 0;
  const timer = setTimeout(() => { failed = true; proc.kill(); }, GIT_IGNORE_MS);
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > GIT_IGNORE_BYTES) { failed = true; proc.kill(); throw new Error("Git ignore output budget exceeded"); }
        parts.push(value);
      }
      return Buffer.concat(parts);
    } finally { reader.releaseLock(); }
  };
  try {
    const [output, , code] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
    // 1 means no ignored paths; 128 includes a non-Git directory or an unsafe path.
    if (failed || code !== 0) return [];
    const ignored = new Set(output.toString().split("\0"));
    return directories.filter((name) => ignored.has(`./${name}`));
  } catch { return []; }
  finally { clearTimeout(timer); }
}

/**
 * The folders inside one directory, for the new-session dialog's folder browser. One
 * directory at a time, names only, nothing kept between calls: the cost is one readdir.
 * `path` takes an absolute path, `~` or `~/…` (the dialog's own syntax); empty means home.
 * Hidden folders (a leading dot) are left out unless asked for. Null when `path` is not
 * a directory this user can read.
 */
/** `base`: the folder a relative path is read from (a pane's, for a link in its chat); else the server's own. */
export function listDirectories(path: string, hidden = false, withFiles = false, base?: string): DirectoryListing | null {
  const home = homedir();
  const trimmed = path.trim();
  const target = trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? resolve(home, trimmed.slice(2)) : base !== undefined ? resolve(base, trimmed) : resolve(trimmed);
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  const files: { name: string; size: number }[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    // a link is what it points at (a dangling or looping one is neither)
    if (entry.isSymbolicLink()) {
      try { const target_ = statSync(join(target, entry.name)); isDirectory = target_.isDirectory(); isFile = target_.isFile(); } catch { isDirectory = false; isFile = false; }
    }
    if (isDirectory) directories.push(entry.name);
    else if (withFiles && isFile && files.length <= MAX_DIRECTORY_ENTRIES) {
      let size = 0;
      try { size = statSync(join(target, entry.name)).size; } catch { continue; }
      files.push({ name: entry.name, size });
    }
  }
  const byName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
  directories.sort(byName);
  files.sort((left, right) => byName(left.name, right.name));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES || files.length > MAX_DIRECTORY_ENTRIES,
    ...(withFiles ? { files: files.slice(0, MAX_DIRECTORY_ENTRIES) } : {}),
  };
}
