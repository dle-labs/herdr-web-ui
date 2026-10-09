import { describe, expect, it } from "bun:test";
import { DRAG_MIN_PX, isCommentClick, isCommentDrag, isDismissingPress, markDismissingPress, type ClickFacts } from "./commentClick.ts";

const plain: ClickFacts = { button: 0, detail: 1, interactive: false, selectionCollapsed: true, dismissesKeyboard: false };

describe("isCommentClick", () => {
  it("takes a plain primary click", () => {
    expect(isCommentClick(plain)).toBe(true);
  });
  it("ignores another button", () => {
    expect(isCommentClick({ ...plain, button: 2 })).toBe(false);
  });
  it("ignores a double or triple click", () => {
    expect(isCommentClick({ ...plain, detail: 2 })).toBe(false);
    expect(isCommentClick({ ...plain, detail: 3 })).toBe(false);
  });
  it("ignores a click on something interactive", () => {
    expect(isCommentClick({ ...plain, interactive: true })).toBe(false);
  });
  it("ignores a click that ends a selection", () => {
    expect(isCommentClick({ ...plain, selectionCollapsed: false })).toBe(false);
  });
  it("ignores a tap that puts the keyboard away", () => {
    expect(isCommentClick({ ...plain, dismissesKeyboard: true })).toBe(false);
  });
});

describe("isDismissingPress", () => {
  it("holds for the press that dismissed a popover, and only for it", () => {
    const press = new Event("pointerdown");
    const next = new Event("pointerdown");
    expect(isDismissingPress(press)).toBe(false);
    markDismissingPress(press);
    expect(isDismissingPress(press)).toBe(true);
    expect(isDismissingPress(next)).toBe(false);
  });
  it("holds for no press", () => {
    expect(isDismissingPress(null)).toBe(false);
    expect(isDismissingPress(undefined)).toBe(false);
  });
});

describe("isCommentDrag", () => {
  const from = { x: 100, y: 100 };
  it("takes a mouse's single press that moved before it let go, across lines too", () => {
    expect(isCommentDrag("mouse", 1, from, { x: 100 + DRAG_MIN_PX, y: 100 })).toBe(true);
    expect(isCommentDrag("mouse", 1, from, { x: 40, y: 180 })).toBe(true);
  });
  it("takes a press whose click count was not seen", () => {
    expect(isCommentDrag("mouse", 0, from, { x: 160, y: 100 })).toBe(true);
  });
  it("ignores a click, or a hand that shook", () => {
    expect(isCommentDrag("mouse", 1, from, from)).toBe(false);
    expect(isCommentDrag("mouse", 1, from, { x: 102, y: 102 })).toBe(false);
  });
  it("ignores a double or triple click, which selects a word or a line to copy", () => {
    expect(isCommentDrag("mouse", 2, from, { x: 160, y: 100 })).toBe(false);
    expect(isCommentDrag("mouse", 3, from, { x: 160, y: 100 })).toBe(false);
  });
  it("ignores a finger or a pen: a touch selection opens nothing, a tap on a block comments", () => {
    expect(isCommentDrag("touch", 1, from, { x: 160, y: 100 })).toBe(false);
    expect(isCommentDrag("pen", 1, from, { x: 160, y: 100 })).toBe(false);
  });
});
