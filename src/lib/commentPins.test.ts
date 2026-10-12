import { describe, expect, it } from "bun:test";
import { endTip, focusAfter, isCommentPoint, lastLine, nearestScroller, pinRightMargin, placePins, pointAt, pointIn, POINT_BOUNDS, scrollsSideways, unionBox, visibleAnchor, visiblePoint } from "./commentPins.ts";

const column = { right: 600, size: 24, gap: 4 };
/** a pin whose tip is at (x, y) */
const tip = (id: string, x: number, y: number) => ({ id, tip: { x, y } });

describe("placePins", () => {
  it("puts a pin's top left corner, its tip, on its anchor's tip", () => {
    expect(placePins([tip("a", 204, 110)], column)).toEqual([{ id: "a", left: 204, top: 110 }]);
  });
  it("keeps a pin inside the column", () => {
    expect(placePins([tip("a", 594, 110)], column)).toEqual([{ id: "a", left: 576, top: 110 }]);
  });
  it("keeps a pin off the column's left edge", () => {
    expect(placePins([tip("a", -30, 110)], column)).toEqual([{ id: "a", left: 0, top: 110 }]);
  });
  it("puts pins on one spot side by side, in reading order", () => {
    expect(placePins([tip("a", 204, 110), tip("b", 204, 110)], column).map((p) => p.left)).toEqual([204, 232]);
  });
  it("moves a row of pins that runs past the column back inside, whole", () => {
    expect(placePins([tip("a", 594, 110), tip("b", 594, 110)], column).map((p) => p.left)).toEqual([548, 576]);
  });
  it("leaves pins on different lines where they are", () => {
    expect(placePins([tip("a", 204, 110), tip("b", 204, 150)], column).map((p) => p.left)).toEqual([204, 204]);
  });
  it("returns the pins in reading order, whatever order they come in", () => {
    expect(placePins([tip("b", 204, 310), tip("a", 204, 110)], column).map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("leaves a pin on the next line alone when it sits left of the one above", () => {
    expect(placePins([tip("a", 404, 110), tip("b", 204, 130)], column).map((p) => p.left)).toEqual([404, 204]);
  });
  it("moves no pin of points that stagger without touching", () => {
    expect(placePins([tip("a", 204, 110), tip("b", 504, 130), tip("c", 454, 150)], column).map((p) => p.left)).toEqual([204, 504, 454]);
  });
  it("still separates pins that overlap on adjacent lines", () => {
    expect(placePins([tip("a", 204, 110), tip("b", 214, 120)], column).map((p) => p.left)).toEqual([204, 232]);
  });
  it("places two clicked points of one paragraph where they were clicked, when they do not touch", () => {
    expect(placePins([tip("a", 120, 100), tip("b", 300, 100)], column)).toEqual([{ id: "a", left: 120, top: 100 }, { id: "b", left: 300, top: 100 }]);
  });
});

describe("endTip", () => {
  it("is just after the end of the last line, at its vertical middle", () => {
    expect(endTip({ left: 10, top: 100, right: 200, bottom: 120 }, 4)).toEqual({ x: 204, y: 110 });
  });
});

describe("unionBox", () => {
  it("is none without a rect", () => {
    expect(unionBox([])).toBeUndefined();
  });
  it("spans every rect", () => {
    expect(unionBox([{ left: 40, top: 100, right: 300, bottom: 120 }, { left: 10, top: 120, right: 120, bottom: 140 }])).toEqual({ left: 10, top: 100, right: 300, bottom: 140 });
  });
});

describe("pointIn and pointAt", () => {
  const box = { left: 100, top: 200, right: 500, bottom: 300 };
  it("measures a point as fractions of the box", () => {
    expect(pointIn(box, { x: 200, y: 250 })).toEqual({ x: 0.25, y: 0.5 });
    expect(pointIn(box, { x: 100, y: 200 })).toEqual({ x: 0, y: 0 });
  });
  it("finds the point again on the box, and on the box after a reflow", () => {
    const point = pointIn(box, { x: 200, y: 250 })!;
    expect(pointAt(box, point)).toEqual({ x: 200, y: 250 });
    // the text rewrapped narrower and taller: the pin keeps its place relative to it
    expect(pointAt({ left: 100, top: 200, right: 300, bottom: 400 }, point)).toEqual({ x: 150, y: 300 });
  });
  it("takes a click right of a short line as more than the box's width", () => {
    expect(pointIn(box, { x: 900, y: 250 })).toEqual({ x: 2, y: 0.5 });
  });
  it("holds a point inside the bounds a stored one may take", () => {
    expect(pointIn(box, { x: 100_000, y: -100_000 })).toEqual({ x: POINT_BOUNDS.x[1], y: POINT_BOUNDS.y[0] });
    expect(isCommentPoint(pointIn(box, { x: 100_000, y: -100_000 }))).toBe(true);
  });
  it("rounds to four decimals", () => {
    expect(pointIn({ left: 0, top: 0, right: 3, bottom: 3 }, { x: 1, y: 2 })).toEqual({ x: 0.3333, y: 0.6667 });
  });
  it("is none on a box without width or height, or for a point that is no number", () => {
    expect(pointIn({ left: 10, top: 10, right: 10, bottom: 30 }, { x: 10, y: 20 })).toBeUndefined();
    expect(pointIn({ left: 10, top: 10, right: 30, bottom: 10 }, { x: 10, y: 10 })).toBeUndefined();
    expect(pointIn(box, { x: Number.NaN, y: 250 })).toBeUndefined();
  });
});

describe("isCommentPoint", () => {
  it("is finite fractions inside the bounds", () => {
    expect(isCommentPoint({ x: 0.5, y: 0.5 })).toBe(true);
    expect(isCommentPoint({ x: -1, y: 2 })).toBe(true);
    expect(isCommentPoint({ x: 8, y: -1 })).toBe(true);
  });
  it("is not anything else", () => {
    for (const value of [null, undefined, 3, "0.5,0.5", [0.5, 0.5], {}, { x: 0.5 }, { x: "0.5", y: 0.5 }, { x: Number.NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 8.01, y: 0 }, { x: -1.01, y: 0 }, { x: 0, y: 2.01 }, { x: 0, y: -1.5 }]) {
      expect(isCommentPoint(value)).toBe(false);
    }
  });
});

describe("visiblePoint", () => {
  const scroller = { left: 100, top: 0, right: 500, bottom: 400 };
  it("shows any point outside a scroller", () => {
    expect(visiblePoint({ x: -50, y: 900 }, null)).toBe(true);
  });
  it("shows a point inside its scroller's visible box, edges included", () => {
    expect(visiblePoint({ x: 300, y: 100 }, scroller)).toBe(true);
    expect(visiblePoint({ x: 500, y: 400 }, scroller)).toBe(true);
  });
  it("hides a point scrolled out of view, on any side", () => {
    expect(visiblePoint({ x: 99, y: 100 }, scroller)).toBe(false);
    expect(visiblePoint({ x: 501, y: 100 }, scroller)).toBe(false);
    expect(visiblePoint({ x: 300, y: 401 }, scroller)).toBe(false);
  });
});

describe("lastLine", () => {
  it("is none without a rect", () => {
    expect(lastLine([])).toBeUndefined();
  });
  it("spans every text node on the last rect's line, at that rect's height", () => {
    // a code line of three tokens after a wrapped line above it
    const rects = [{ left: 10, top: 80, right: 590, bottom: 100 }, { left: 40, top: 100, right: 120, bottom: 120 }, { left: 120, top: 102, right: 200, bottom: 118 }, { left: 200, top: 100, right: 260, bottom: 120 }];
    expect(lastLine(rects)).toEqual({ left: 40, top: 100, right: 260, bottom: 120 });
  });
  it("keeps a line's start where only its last token is scrolled out of view", () => {
    const scroller = { left: 0, top: 0, right: 300, bottom: 400 };
    const line = lastLine([{ left: 40, top: 100, right: 280, bottom: 120 }, { left: 280, top: 100, right: 520, bottom: 120 }])!;
    expect(visibleAnchor(line, scroller)).toEqual({ left: 40, top: 100, right: 300, bottom: 120 });
  });
});

describe("scrollsSideways", () => {
  it("is an element that lets its content scroll and holds more than it shows", () => {
    expect(scrollsSideways({ overflowX: "auto", scrollWidth: 900, clientWidth: 600 })).toBe(true);
    expect(scrollsSideways({ overflowX: "scroll", scrollWidth: 900, clientWidth: 600 })).toBe(true);
  });
  it("is not one whose content fits", () => {
    expect(scrollsSideways({ overflowX: "auto", scrollWidth: 600, clientWidth: 600 })).toBe(false);
  });
  it("is not one that lets it show or cuts it off", () => {
    expect(scrollsSideways({ overflowX: "visible", scrollWidth: 900, clientWidth: 600 })).toBe(false);
    expect(scrollsSideways({ overflowX: "hidden", scrollWidth: 900, clientWidth: 600 })).toBe(false);
  });
});

describe("nearestScroller", () => {
  // text → span → line → pre (scrolls) → body (the surface), as a node and its parent's name
  const parents: Record<string, string | null> = { text: "span", span: "line", line: "pre", pre: "body", body: "page", page: null };
  const parentOf = (node: string): string | null => parents[node] ?? null;
  it("finds the nearest ancestor that scrolls sideways", () => {
    expect(nearestScroller("text", "body", parentOf, (node) => node === "pre")).toBe("pre");
    expect(nearestScroller("text", "body", parentOf, (node) => node === "pre" || node === "line")).toBe("line");
  });
  it("stops at the surface, whose own scroll the pins follow", () => {
    expect(nearestScroller("text", "body", parentOf, (node) => node === "body" || node === "page")).toBeNull();
  });
  it("is none without a start, or with no scroller on the way", () => {
    expect(nearestScroller(null, "body", parentOf, () => true)).toBeNull();
    expect(nearestScroller("text", "body", parentOf, () => false)).toBeNull();
  });
});

describe("visibleAnchor", () => {
  const scroller = { left: 100, top: 0, right: 500, bottom: 400 };
  it("keeps a line outside any scroller", () => {
    const line = { left: 10, top: 100, right: 900, bottom: 120 };
    expect(visibleAnchor(line, null)).toBe(line);
  });
  it("keeps a line inside its scroller's visible box", () => {
    const line = { left: 120, top: 100, right: 300, bottom: 120 };
    expect(visibleAnchor(line, scroller)).toBe(line);
  });
  it("cuts a line that runs past the visible box at its right side", () => {
    expect(visibleAnchor({ left: 120, top: 100, right: 900, bottom: 120 }, scroller)).toEqual({ left: 120, top: 100, right: 500, bottom: 120 });
  });
  it("keeps a line partly scrolled out to the left, its end where it is", () => {
    expect(visibleAnchor({ left: -200, top: 100, right: 150, bottom: 120 }, scroller)).toEqual({ left: -200, top: 100, right: 150, bottom: 120 });
  });
  it("drops a line scrolled wholly out of view, on either side", () => {
    expect(visibleAnchor({ left: -200, top: 100, right: 100, bottom: 120 }, scroller)).toBeNull();
    expect(visibleAnchor({ left: 500, top: 100, right: 700, bottom: 120 }, scroller)).toBeNull();
    expect(visibleAnchor({ left: 120, top: 400, right: 300, bottom: 420 }, scroller)).toBeNull();
  });
});

describe("pinRightMargin", () => {
  it("keeps the margin where the hit area is the pin", () => {
    expect(pinRightMargin(8, 24, 24)).toBe(8);
  });
  it("keeps a touch hit area inside the column", () => {
    expect(pinRightMargin(8, 24, 44)).toBe(10);
    expect(pinRightMargin(8, 24, 49)).toBe(13);
  });
});

describe("focusAfter", () => {
  const cards = ["a", "b", "c"];

  it("is the next card, then the previous one: where the reader was, once the card is gone", () => {
    expect(focusAfter(cards, "a")).toEqual(["b", "c"]);
    expect(focusAfter(cards, "b")).toEqual(["c", "a"]);
    expect(focusAfter(cards, "c")).toEqual(["b", "a"]);
  });
  it("goes on past the nearest two, so a pin not drawn next to the card does not end the search", () => {
    expect(focusAfter(["a", "b", "c", "d", "e"], "c")).toEqual(["d", "e", "b", "a"]);
    expect(focusAfter(["a", "b", "c", "d"], "d")).toEqual(["c", "b", "a"]);
    expect(focusAfter(["a", "b", "c", "d"], "a")).toEqual(["b", "c", "d"]);
  });
  it("is nothing for a host with no other card, or a card that is not in it", () => {
    expect(focusAfter(["a"], "a")).toEqual([]);
    expect(focusAfter([], "a")).toEqual([]);
    expect(focusAfter(cards, "z")).toEqual([]);
  });
});
