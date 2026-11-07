import { describe, expect, it } from "bun:test";
import { commentCanSave, commentChanged, popoverChanged, popoverEscape, popoverFocusesField, popoverOutlived, popoverStart } from "./commentPopover.ts";

describe("commentChanged", () => {
  it("is unchanged while a new comment is still empty", () => {
    expect(commentChanged("", "")).toBe(false);
  });
  it("is unchanged while an edit is as it opened", () => {
    expect(commentChanged("Fix this", "Fix this")).toBe(false);
  });
  it("is changed once a new comment has any text, whitespace included", () => {
    expect(commentChanged("x", "")).toBe(true);
    expect(commentChanged(" ", "")).toBe(true);
  });
  it("is changed once an edit differs from how it opened, even when it was emptied", () => {
    expect(commentChanged("Fix that", "Fix this")).toBe(true);
    expect(commentChanged("", "Fix this")).toBe(true);
  });
});

describe("commentCanSave", () => {
  it("has nothing to save in a new comment that is empty or blank", () => {
    expect(commentCanSave("", "")).toBe(false);
    expect(commentCanSave("  \n", "")).toBe(false);
  });
  it("saves a new comment with text", () => {
    expect(commentCanSave("Fix this", "")).toBe(true);
  });
  it("has nothing to save in an edit left as it opened", () => {
    expect(commentCanSave("Fix this", "Fix this")).toBe(false);
  });
  it("saves an edit, also emptied: a blank edit deletes the comment", () => {
    expect(commentCanSave("Fix that", "Fix this")).toBe(true);
    expect(commentCanSave("", "Fix this")).toBe(true);
  });
});

describe("popoverStart", () => {
  it("opens a saved comment to edit, its field filled with it", () => {
    expect(popoverStart({ id: "c1", comment: "tighten this" })).toEqual({ commentId: "c1", initialComment: "tighten this" });
  });
  it("opens a new comment to write, its field empty", () => {
    expect(popoverStart(null)).toEqual({ commentId: null, initialComment: "" });
  });
});

describe("popoverChanged", () => {
  it("holds nothing while none is open", () => {
    expect(popoverChanged(null, "typed")).toBe(false);
  });
  it("holds a new comment with something typed, blanks included", () => {
    expect(popoverChanged({ initialComment: "" }, "a")).toBe(true);
    expect(popoverChanged({ initialComment: "" }, " ")).toBe(true);
  });
  it("does not hold an untouched field, a saved comment's opened filled included", () => {
    expect(popoverChanged({ initialComment: "" }, "")).toBe(false);
    expect(popoverChanged({ initialComment: "saved" }, "saved")).toBe(false);
  });
  it("holds an edit that changed the comment, emptied included", () => {
    expect(popoverChanged({ initialComment: "saved" }, "saved!")).toBe(true);
    expect(popoverChanged({ initialComment: "saved" }, "")).toBe(true);
  });
});

describe("popoverEscape", () => {
  it("leaves the key alone with no popover open", () => {
    expect(popoverEscape(null, "")).toBe("none");
  });
  it("closes an untouched field, a saved comment's opened filled included", () => {
    expect(popoverEscape({ initialComment: "" }, "")).toBe("close");
    expect(popoverEscape({ initialComment: "saved" }, "saved")).toBe("close");
  });
  it("keeps a field with text typed", () => {
    expect(popoverEscape({ initialComment: "" }, "draft")).toBe("keep");
    expect(popoverEscape({ initialComment: "saved" }, "")).toBe("keep");
  });
});

describe("popoverOutlived", () => {
  const stored = [{ id: "a" }, { id: "b" }];
  it("keeps a comment still stored, changed or not", () => {
    expect(popoverOutlived({ commentId: "a", initialComment: "saved" }, stored, "saved")).toBe(false);
    expect(popoverOutlived({ commentId: "a", initialComment: "saved" }, stored, "changed")).toBe(false);
  });
  it("ends an untouched comment no longer stored (sent, or deleted in another tab)", () => {
    expect(popoverOutlived({ commentId: "gone", initialComment: "saved" }, stored, "saved")).toBe(true);
    expect(popoverOutlived({ commentId: "a", initialComment: "saved" }, [], "saved")).toBe(true);
  });
  it("keeps a comment no longer stored while a change is typed in it", () => {
    expect(popoverOutlived({ commentId: "gone", initialComment: "saved" }, stored, "saved, changed")).toBe(false);
    expect(popoverOutlived({ commentId: "gone", initialComment: "saved" }, stored, "")).toBe(false);
  });
  it("never ends a new comment", () => {
    expect(popoverOutlived({ commentId: null, initialComment: "" }, [], "")).toBe(false);
    expect(popoverOutlived({ commentId: null, initialComment: "" }, [], "draft")).toBe(false);
  });
});

describe("popoverFocusesField", () => {
  it("focuses a new comment's field, with a mouse and on a touch screen", () => {
    expect(popoverFocusesField(false, false)).toBe(true);
    expect(popoverFocusesField(false, true)).toBe(true);
  });
  it("focuses a saved comment's field with a mouse", () => {
    expect(popoverFocusesField(true, false)).toBe(true);
  });
  it("leaves a saved comment's field alone on a touch screen: no keyboard rises for a tap on its pin", () => {
    expect(popoverFocusesField(true, true)).toBe(false);
  });
});
