import { describe, expect, it } from "bun:test";
import { commentTabTarget, hasOpenComment } from "./commentDom.ts";

function navigation() {
  let layout: Element;
  const own = { dataset: { commentId: "one" }, closest: () => layout } as unknown as HTMLElement;
  const next = { dataset: { commentId: "two" }, closest: () => layout } as unknown as HTMLElement;
  const field = { tabIndex: 0, getClientRects: () => [1], closest: () => layout } as unknown as HTMLElement;
  const hidden = { tabIndex: 0, getClientRects: () => [], closest: () => layout } as unknown as HTMLElement;
  const last = { tabIndex: 0, getClientRects: () => [1], closest: () => layout } as unknown as HTMLElement;
  // This branch keeps inactive voice controls mounted but outside the tab order.
  const inactive = { tabIndex: -1, getClientRects: () => [1], closest: () => layout } as unknown as HTMLElement;
  const host = { dataset: { commentId: "one" }, querySelectorAll: () => [field, hidden, last, inactive] };
  layout = { querySelector: () => host, querySelectorAll: () => [own, next], contains: (node: Element) => node === layout } as unknown as Element;
  const trap = { contains: (node: Element) => node === layout } as unknown as Element;
  return { layout, trap, own, next, field, last };
}

describe("comment keyboard order", () => {
  it("uses the same logical boundaries in a surface and an enclosing modal trap", () => {
    const { layout, trap, own, next, field, last } = navigation();
    for (const scope of [layout, trap]) {
      expect(commentTabTarget(scope, own, false)).toBe(field);
      expect(commentTabTarget(scope, field, true)).toBe(own);
      expect(commentTabTarget(scope, last, false)).toBe(next);
      expect(commentTabTarget(scope, next, true)).toBe(last);
      expect(commentTabTarget(scope, field, false)).toBeNull();
    }
  });
  it("does not move focus out of another modal or invent an order with no active comment", () => {
    const { trap, own } = navigation();
    expect(commentTabTarget(trap, null, false)).toBeNull();
    expect(commentTabTarget({ contains: () => false } as unknown as Element, own, false)).toBeNull();
    expect(commentTabTarget(trap, { closest: () => null } as unknown as Element, false)).toBeNull();
  });
});

describe("hasOpenComment", () => {
  const scope = (inLayout: boolean, sheet: boolean): Element => ({
    closest: () => ({ querySelector: () => inLayout ? {} : null }),
    ownerDocument: { querySelector: () => sheet ? {} : null },
  }) as unknown as Element;
  it("suspends automatic following for floating, docked and modal editors", () => {
    expect(hasOpenComment(scope(true, false))).toBe(true);
    expect(hasOpenComment(scope(false, true))).toBe(true);
    expect(hasOpenComment(scope(false, false))).toBe(false);
    const waiting = scope(false, false);
    waiting.hasAttribute = (name) => name === "data-comment-editing";
    expect(hasOpenComment(waiting)).toBe(true);
    expect(hasOpenComment(null)).toBe(false);
  });
});
