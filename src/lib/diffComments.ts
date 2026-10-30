import type { SelectedLineRange } from "@pierre/diffs";
import type { GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";
import { fileLines, type FileTarget } from "./fileComments.ts";

/** Diff coordinates are file-side coordinates, never rendered row indexes. Cross-side ranges are ambiguous. */
export function diffCommentTarget(file: GitFileDiffResponse, mode: GitDiffMode, range: SelectedLineRange): FileTarget | null {
  const side = range.side ?? "additions";
  if (range.endSide !== undefined && range.endSide !== side) return null;
  const first = Math.min(range.start, range.end);
  const last = Math.max(range.start, range.end);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1) return null;
  const sourceFile = side === "deletions" ? file.old_file : file.new_file;
  if (sourceFile === null || file.binary) return null;
  const lines = fileLines(sourceFile.contents);
  // A trailing newline terminates a line; it does not create another commentable line.
  if (/\r\n$|[\r\n]$/.test(sourceFile.contents)) lines.pop();
  if (last > lines.length) return null;
  const path = side === "deletions" ? file.old_path ?? file.path : file.path;
  const source = lines.slice(first - 1, last);
  return {
    path: `${file.root.replace(/[\\/]$/, "")}/${path}`, label: path, view: "code", lines: [first, last], source, quoteLines: source,
    diff: { side: side === "deletions" ? "old" : "new", mode, revision: file.revision, ...(file.base_commit ? { base_commit: file.base_commit } : {}), repository: file.root, path },
  };
}
