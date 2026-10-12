import { describe, expect, it } from "bun:test";
import { commentPlace } from "./commentPins.ts";

describe("commentPlace", () => {
  const view = { left: 0, top: 0, right: 800, bottom: 600 };
  const size = { width: 300, height: 200 };
  const options = { pinSize: 20, gap: 8, margin: 8 };
  const paragraph = [{ left: 100, top: 150, right: 450, bottom: 220 }];
  it("places outside the whole paragraph, even when clicked in its middle", () => {
    expect(commentPlace(paragraph, { left: 200, top: 170 }, view, size, options)).toEqual({ left: 458, top: 170, side: "right" });
  });
  it("uses the left side when the text reaches the right edge", () => {
    expect(commentPlace([{ left: 400, top: 150, right: 780, bottom: 220 }], { left: 600, top: 170 }, view, size, options)).toEqual({ left: 92, top: 170, side: "left" });
  });
  it("puts the editor below all lines, not below the clicked line", () => {
    expect(commentPlace(paragraph, { left: 200, top: 170 }, { ...view, right: 500 }, size, options)).toEqual({ left: 60, top: 228, side: "below" });
  });
  it("uses above the entire paragraph for a bottom-edge click", () => {
    expect(commentPlace([{ left: 20, top: 450, right: 480, bottom: 580 }], { left: 200, top: 540 }, { ...view, right: 500 }, size, options)).toEqual({ left: 60, top: 242, side: "above" });
  });
  it("adjusts vertically without crossing the text", () => {
    expect(commentPlace([{ left: 100, top: 500, right: 450, bottom: 580 }], { left: 200, top: 550 }, view, size, options)).toEqual({ left: 458, top: 392, side: "right" });
  });
  it("accounts for every range, including another paragraph in a selection", () => {
    expect(commentPlace([...paragraph, { left: 100, top: 240, right: 600, bottom: 270 }], { left: 200, top: 170 }, view, size, options)).toEqual({ left: 60, top: 278, side: "below" });
  });
  it("requests reserved space when no non-overlapping candidate fits", () => {
    expect(commentPlace([{ left: 10, top: 10, right: 490, bottom: 590 }], { left: 200, top: 170 }, { ...view, right: 500 }, size, options)).toBeNull();
  });
  it("requests reserved space for oversized editors or missing geometry", () => {
    expect(commentPlace(paragraph, { left: 200, top: 170 }, view, { width: 800, height: 200 }, options)).toBeNull();
    expect(commentPlace(paragraph, { left: 200, top: 170 }, view, { width: 300, height: 600 }, options)).toBeNull();
    expect(commentPlace([], { left: 200, top: 170 }, view, size, options)).toBeNull();
  });
  it("uses the clipped visible viewport, not the whole scrolling surface", () => {
    expect(commentPlace(paragraph, { left: 200, top: 170 }, { ...view, top: 180, bottom: 400 }, size, options)).toEqual({ left: 458, top: 188, side: "right" });
  });
  it("switches to reserved space when editor growth removes its last candidate", () => {
    const rects = [{ left: 10, top: 150, right: 490, bottom: 220 }];
    const tight = { ...view, right: 500, bottom: 450 };
    expect(commentPlace(rects, { left: 200, top: 170 }, tight, size, options)?.side).toBe("below");
    expect(commentPlace(rects, { left: 200, top: 170 }, tight, { ...size, height: 300 }, options)).toBeNull();
  });
  it("never returns an overlapping or out-of-bounds box across click points and widths", () => {
    for (const width of [320, 500, 800, 1200]) for (const height of [250, 600]) for (const x of [50, 200, 450]) for (const y of [40, 170, 550]) {
      const at = commentPlace(paragraph, { left: x, top: y }, { ...view, right: width, bottom: height }, size, options);
      if (at === null) continue;
      expect(at.left).toBeGreaterThanOrEqual(options.margin);
      expect(at.top).toBeGreaterThanOrEqual(options.margin);
      expect(at.left + size.width).toBeLessThanOrEqual(width - options.margin);
      expect(at.top + size.height).toBeLessThanOrEqual(height - options.margin);
      expect(paragraph.every((r) => at.left >= r.right + options.gap || at.left + size.width <= r.left - options.gap
        || at.top >= r.bottom + options.gap || at.top + size.height <= r.top - options.gap)).toBe(true);
    }
  });
});
