import { describe, expect, it } from "bun:test";

import { clampFileTreeWidth, fileTreeMaxWidth, FILE_TREE_MIN_WIDTH, FILE_TREE_WIDTH_STEP, keyedFileTreeWidth, parseFileTreeWidth } from "./fileTreeWidth.ts";

describe("clampFileTreeWidth", () => {
  it("keeps the tree at its minimum and leaves the detail 240px, in whole pixels", () => {
    expect(clampFileTreeWidth(10)).toBe(FILE_TREE_MIN_WIDTH);
    expect(clampFileTreeWidth(5000)).toBe(5000);
    expect(clampFileTreeWidth(900, 1000)).toBe(760);
    expect(clampFileTreeWidth(260.4, 1000)).toBe(260);
    expect(fileTreeMaxWidth(300)).toBe(FILE_TREE_MIN_WIDTH);
  });
});

describe("keyedFileTreeWidth", () => {
  it("widens with ArrowRight and narrows with ArrowLeft, as the edge is on the right", () => {
    expect(keyedFileTreeWidth(300, "ArrowRight")).toBe(300 + FILE_TREE_WIDTH_STEP);
    expect(keyedFileTreeWidth(300, "ArrowLeft")).toBe(300 - FILE_TREE_WIDTH_STEP);
    expect(keyedFileTreeWidth(FILE_TREE_MIN_WIDTH, "ArrowLeft")).toBe(FILE_TREE_MIN_WIDTH);
    expect(keyedFileTreeWidth(300, "Home")).toBe(FILE_TREE_MIN_WIDTH);
    expect(keyedFileTreeWidth(300, "End", 1000)).toBe(760);
    expect(keyedFileTreeWidth(300, "Enter")).toBeNull();
  });
});

describe("parseFileTreeWidth", () => {
  it("reads only a whole number of pixels", () => {
    expect(parseFileTreeWidth(null)).toBeNull();
    expect(parseFileTreeWidth("abc")).toBeNull();
    expect(parseFileTreeWidth("-5")).toBeNull();
    expect(parseFileTreeWidth("20")).toBe(FILE_TREE_MIN_WIDTH);
    expect(parseFileTreeWidth("420")).toBe(420);
  });
});
