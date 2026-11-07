import { describe, expect, test } from "bun:test";
import { sourceCommentTarget } from "./sourceComments.ts";
import { fileAnchor, fileQuote } from "./fileComments.ts";

const file = { path: "/work/src/test.ts", label: "src/test.ts", lines: ["one", "two", "three", "partial"], loaded: 3 };
describe("source gutter comment targets", () => {
  test("a gutter click quotes one complete source line without diff metadata", () => {
    const target = sourceCommentTarget(file, { start: 2, end: 2 });
    expect(target).toEqual({ path: file.path, label: file.label, view: "code", lines: [2, 2], source: ["two"], quoteLines: ["two"] });
    expect(fileQuote(target!)).toBe("> src/test.ts:2\n> two");
    expect(fileAnchor(target!)).toBe("file:/work/src/test.ts:code:2-2");
  });
  test("forward and reverse drags quote exactly the same inclusive range", () => {
    const target = sourceCommentTarget(file, { start: 1, end: 3 });
    expect(sourceCommentTarget(file, { start: 3, end: 1 })).toEqual(target);
    expect(target?.source).toEqual(["one", "two", "three"]);
    expect(target?.lines).toEqual([1, 3]);
  });
  test("partial, unloaded, invalid and out-of-file lines cannot receive a comment", () => {
    for (const [start, end] of [[0, 1], [-1, 2], [2, 4], [4, 4], [1, 100], [1.5, 2], [NaN, 2], [1, Infinity]] as const) {
      expect(sourceCommentTarget(file, { start, end })).toBeNull();
    }
    expect(sourceCommentTarget({ ...file, loaded: 10 }, { start: 1, end: 5 })).toBeNull();
  });
  test("original source characters and blank lines are preserved", () => {
    const target = sourceCommentTarget({ ...file, lines: ["\tindented", "", "😀"] }, { start: 1, end: 3 });
    expect(target?.source).toEqual(["\tindented", "", "😀"]);
  });
});
