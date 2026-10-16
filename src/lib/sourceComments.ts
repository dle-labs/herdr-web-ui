import type { SelectedLineRange } from "@pierre/diffs";
import type { FileTarget } from "./fileComments.ts";

/** Only complete, loaded source lines may be quoted; reverse drags use ascending coordinates. */
export function sourceCommentTarget(file: { path: string; label: string; lines: readonly string[]; loaded: number }, range: SelectedLineRange): FileTarget | null {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > file.loaded || end > file.lines.length) return null;
  const source = file.lines.slice(start - 1, end);
  return { path: file.path, label: file.label, view: "code", lines: [start, end], source, quoteLines: source };
}
