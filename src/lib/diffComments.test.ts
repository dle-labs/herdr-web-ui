import { describe, expect, test } from "bun:test";
import type { GitFileDiffResponse } from "../../shared/protocol.ts";
import { diffCommentTarget } from "./diffComments.ts";

const file: GitFileDiffResponse = {
  root: "/repo", revision: "snapshot-1", path: "src/new.ts", old_path: "src/old.ts", patch: "", binary: false,
  old_file: { name: "src/old.ts", contents: "old one\nold two\nold three\n" },
  new_file: { name: "src/new.ts", contents: "new one\nnew two\nnew three\n" },
};
describe("diffCommentTarget", () => {
  test("uses the new filename and original 1-based coordinates for reversed ranges", () => {
    expect(diffCommentTarget(file, "unstaged", { start: 3, end: 2, side: "additions" })).toEqual({
      path: "/repo/src/new.ts", label: "src/new.ts", view: "code", lines: [2, 3], source: ["new two", "new three"], quoteLines: ["new two", "new three"],
      diff: { repository: "/repo", revision: "snapshot-1", mode: "unstaged", side: "new", path: "src/new.ts" },
    });
  });
  test("historical comments retain their exact base for reopening", () => {
    const base = "a".repeat(40);
    expect(diffCommentTarget({ ...file, base_commit: base }, "all", { start: 1, end: 1 })?.diff?.base_commit).toBe(base);
  });
  test("deleted lines use the previous filename and side", () => {
    const target = diffCommentTarget(file, "staged", { start: 2, end: 2, side: "deletions" });
    expect(target?.path).toBe("/repo/src/old.ts");
    expect(target?.source).toEqual(["old two"]);
    expect(target?.diff?.side).toBe("old");
  });
  test("does not treat diff rows or cross-side ranges as valid coordinates", () => {
    expect(diffCommentTarget(file, "all", { start: 1, end: 2, side: "deletions", endSide: "additions" })).toBeNull();
    for (const line of [0, -1, 1.5, 4, NaN]) expect(diffCommentTarget(file, "all", { start: line, end: line })).toBeNull();
  });
  test("handles missing sides, binary files, CRLF, and files without final newline", () => {
    expect(diffCommentTarget({ ...file, old_file: null }, "all", { start: 1, end: 1, side: "deletions" })).toBeNull();
    expect(diffCommentTarget({ ...file, binary: true }, "all", { start: 1, end: 1 })).toBeNull();
    const crlf = { ...file, new_file: { name: file.path, contents: "a\r\nb" } };
    expect(diffCommentTarget(crlf, "all", { start: 2, end: 2 })?.source).toEqual(["b"]);
  });
});
