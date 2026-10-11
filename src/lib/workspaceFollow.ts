import type { GitFileDiffResponse } from "../../shared/protocol.ts";

/** Compare content, not repository revision: a revision can change for another file. */
export function firstEditedLine(previous: GitFileDiffResponse, next: GitFileDiffResponse): number | null {
  if ((previous.new_file === null) !== (next.new_file === null) || (previous.old_file === null) !== (next.old_file === null)) return 1;
  let before = previous.new_file?.contents ?? "";
  let after = next.new_file?.contents ?? "";
  if (before === after) {
    before = previous.old_file?.contents ?? "";
    after = next.old_file?.contents ?? "";
  }
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return Math.min(index + 1, b.length);
}
