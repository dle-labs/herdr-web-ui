import { describe, expect, it } from "bun:test";
import { restoreFocusTarget, sliceText, spanText } from "./commentSelection.ts";

describe("sliceText", () => {
  it("takes the characters start–end across the text units", () => {
    expect(sliceText(["Hello ", "world"], 3, 8)).toBe("lo wo");
    expect(sliceText(["Hello ", "world"], 0, 11)).toBe("Hello world");
  });
  it("keeps a separator only between two selected characters", () => {
    const units = ["a", { sep: "\n" }, "b"];
    expect(sliceText(units, 0, 2)).toBe("a\nb");
    expect(sliceText(units, 0, 1)).toBe("a");
    expect(sliceText(units, 1, 2)).toBe("b");
  });
  it("does not count a separator as a character", () => {
    expect(sliceText(["ab", { sep: "\n" }, "cd"], 1, 3)).toBe("b\nc");
  });
  it("never doubles a separator, and a line break replaces a trailing space", () => {
    expect(sliceText(["a", { sep: "\n" }, { sep: "\n" }, "b"], 0, 2)).toBe("a\nb");
    expect(sliceText(["a", { sep: " " }, { sep: " " }, "b"], 0, 2)).toBe("a b");
    expect(sliceText(["a", { sep: " " }, { sep: "\n" }, "b"], 0, 2)).toBe("a\nb");
    expect(sliceText(["a\n", { sep: " " }, "b"], 0, 3)).toBe("a\nb");
  });
  it("skips empty units", () => {
    expect(sliceText(["", "ab", "", { sep: "\n" }, "", "c"], 1, 3)).toBe("b\nc");
  });
  it("is empty outside the text or for an empty range", () => {
    expect(sliceText(["abc"], 3, 5)).toBe("");
    expect(sliceText(["abc"], 1, 1)).toBe("");
    expect(sliceText([], 0, 2)).toBe("");
  });
});

describe("spanText", () => {
  const para = (text: string) => [text];
  it("quotes a selection inside one part as sliceText does", () => {
    expect(spanText([{ units: ["Hello ", "world"], start: 3, end: 8 }])).toEqual({ first: 0, last: 0, text: "lo wo" });
  });
  it("quotes a selection over several parts whole, a line break between parts", () => {
    const slices = [{ units: para("Alpha beta"), start: 6, end: 10 }, { units: ["one", { sep: "\n" }, "more"], start: 0, end: 7 }, { units: para("Omega end"), start: 0, end: 5 }];
    expect(spanText(slices)).toEqual({ first: 0, last: 2, text: "beta\none\nmore\nOmega" });
  });
  it("starts and ends at the first and last part with selected text", () => {
    // a drag from a paragraph's end into the next, ending at the start of the one after
    const slices = [{ units: para("Alpha"), start: 5, end: 5 }, { units: para("Middle"), start: 0, end: 6 }, { units: para("Omega"), start: 0, end: 0 }];
    expect(spanText(slices)).toEqual({ first: 1, last: 1, text: "Middle" });
  });
  it("skips a part between whose selected text is blank, and keeps its place in the count", () => {
    const slices = [{ units: para("a"), start: 0, end: 1 }, { units: para("  "), start: 0, end: 2 }, { units: para("b"), start: 0, end: 1 }];
    expect(spanText(slices)).toEqual({ first: 0, last: 2, text: "a\nb" });
  });
  it("drops the trailing spaces of each part's text", () => {
    const slices = [{ units: para("Alpha beta  "), start: 6, end: 12 }, { units: para("one "), start: 0, end: 4 }, { units: para("Omega end"), start: 0, end: 6 }];
    expect(spanText(slices)).toEqual({ first: 0, last: 2, text: "beta\none\nOmega" });
  });
  it("is null when nothing but blanks is selected", () => {
    expect(spanText([])).toBeNull();
    expect(spanText([{ units: para("a  b"), start: 1, end: 3 }, { units: para("c"), start: 0, end: 0 }])).toBeNull();
  });
});


describe("restoreFocusTarget", () => {
  const live = { isConnected: true };
  const gone = { isConnected: false };
  const other = { isConnected: true };

  it("is the opener while it is connected", () => {
    expect(restoreFocusTarget(live, other, false)).toBe(live);
    expect(restoreFocusTarget(live, other, true)).toBe(live);
  });
  it("is the fallback when the opener is gone (a deleted comment takes its card with it)", () => {
    expect(restoreFocusTarget(gone, other, false)).toBe(other);
    expect(restoreFocusTarget(null, other, true)).toBe(other);
  });
  it("is the fallback for a modal even when it is not connected: nothing else can have the focus", () => {
    expect(restoreFocusTarget(gone, gone, false)).toBe(gone);
    expect(restoreFocusTarget(null, null, false)).toBeNull();
  });
  it("is null for an inline form when the target is not connected, so the focus is left where it is", () => {
    expect(restoreFocusTarget(gone, gone, true)).toBeNull();
    expect(restoreFocusTarget(null, gone, true)).toBeNull();
    expect(restoreFocusTarget(null, null, true)).toBeNull();
  });
});

describe("restoreFocusTarget on a coarse pointer", () => {
  const live = { isConnected: true };
  const other = { isConnected: true };
  const gone = { isConnected: false };

  it("still gives the focus back to the opener", () => {
    expect(restoreFocusTarget(live, other, false, true)).toBe(live);
    expect(restoreFocusTarget(live, other, true, true)).toBe(live);
  });
  it("lets the focus go instead of taking the fallback, which would raise the keyboard", () => {
    expect(restoreFocusTarget(gone, other, false, true)).toBeNull();
    expect(restoreFocusTarget(null, other, true, true)).toBeNull();
  });
  it("keeps the fallback on a fine pointer", () => {
    expect(restoreFocusTarget(gone, other, false, false)).toBe(other);
    expect(restoreFocusTarget(gone, other, false)).toBe(other);
  });
});
