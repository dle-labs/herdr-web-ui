import { describe, expect, it } from "bun:test";
import { focusAfter } from "./commentPins.ts";
import { changedAttrs, changedField, firstPin, focusOpenField, hasChangedComment, hasCommentDialog, pinAnchors, pinAttrs, pinByAnchor, pinById, revealField, savedPins } from "./commentDom.ts";

/** A stand-in for a comment surface: `querySelectorAll` hands back pins carrying these anchors (and ids `id-<anchor>`), in this order. */
function surfaceWith(anchors: readonly string[]): { view: Element; pins: { dataset: { commentAnchor: string; commentId: string } }[]; asked: string[] } {
  const pins = anchors.map((commentAnchor) => ({ dataset: { commentAnchor, commentId: `id-${commentAnchor}` } }));
  const asked: string[] = [];
  const view = {
    querySelectorAll: (selector: string) => {
      asked.push(selector);
      return selector.includes(".comment-pin") ? pins : [];
    },
  } as unknown as Element;
  return { view, pins, asked };
}

describe("firstPin", () => {
  it("is the pin of the first anchor that has one, in the order given", () => {
    const { view, pins } = surfaceWith(["a", "b", "c"]);
    expect(firstPin(view, ["c", "a"])).toBe(pins[2] as unknown as HTMLElement);
    expect(firstPin(view, ["z", "b"])).toBe(pins[1] as unknown as HTMLElement);
  });
  it("is null with no anchor drawn, none asked for, or no surface", () => {
    const { view } = surfaceWith(["a"]);
    expect(firstPin(view, ["z"])).toBeNull();
    expect(firstPin(view, [])).toBeNull();
    expect(firstPin(null, ["a"])).toBeNull();
  });
});

describe("pinAnchors", () => {
  it("lists the pins' anchors in the document's order, which is reading order", () => {
    expect(pinAnchors(surfaceWith(["b", "a", "c"]).view)).toEqual(["b", "a", "c"]);
    expect(pinAnchors(null)).toEqual([]);
  });
  it("with focusAfter and firstPin, names the next pin after a delete, else the previous one", () => {
    const { view, pins } = surfaceWith(["a", "b", "c"]);
    expect(firstPin(view, focusAfter(pinAnchors(view), "b"))).toBe(pins[2] as unknown as HTMLElement);
    const last = surfaceWith(["a", "b"]);
    expect(firstPin(last.view, focusAfter(pinAnchors(last.view), "b"))).toBe(last.pins[0] as unknown as HTMLElement);
  });
});

describe("pinByAnchor and pinById", () => {
  it("find a pin by its comment's anchor or id, null where it is not drawn", () => {
    const { view, pins } = surfaceWith(["a", "b"]);
    expect(pinByAnchor(view, "b")).toBe(pins[1] as unknown as HTMLElement);
    expect(pinById(view, "id-a")).toBe(pins[0] as unknown as HTMLElement);
    expect(pinByAnchor(view, "z")).toBeNull();
    expect(pinById(view, "id-z")).toBeNull();
    expect(pinByAnchor(null, "a")).toBeNull();
    expect(pinById(null, "id-a")).toBeNull();
  });
});

describe("savedPins", () => {
  it("asks for saved comments' pins only, not the provisional one, inside `within` when given", () => {
    const { view, pins, asked } = surfaceWith(["a"]);
    expect(savedPins(view)).toEqual(pins as unknown as HTMLElement[]);
    expect(savedPins(view, ".chat-view")).toEqual(pins as unknown as HTMLElement[]);
    expect(asked).toEqual([".comment-pin[data-comment-id]:not(.is-pending)", ".chat-view .comment-pin[data-comment-id]:not(.is-pending)"]);
  });
});

describe("the attributes the popover and the pins render", () => {
  it("mark a changed popover, and a saved comment's pin", () => {
    expect(changedAttrs(true)).toEqual({ "data-comment-changed": "" });
    expect(changedAttrs(false)).toEqual({ "data-comment-changed": undefined });
    expect(pinAttrs("c1", "r:1")).toEqual({ "data-comment-id": "c1", "data-comment-anchor": "r:1" });
  });
});

/** A scope (a pane's stack, a surface) holding `inScope`, in a document holding `portalled`, each found by its selector. */
function scopeWith(inScope: Record<string, object>, portalled: Record<string, object>): Element {
  const ownerDocument = { querySelector: (selector: string) => portalled[selector] ?? null };
  return { ownerDocument, querySelector: (selector: string) => inScope[selector] ?? null } as unknown as Element;
}

describe("changedField", () => {
  const here = { field: "here" };
  const sheet = { field: "sheet" };

  it("finds a changed popover's field in the scope first", () => {
    expect(changedField(scopeWith({ ".comment-popover[data-comment-changed] textarea": here }, { ".modal.comment-popover[data-comment-changed] textarea": sheet }))).toBe(here as unknown as HTMLTextAreaElement);
  });
  it("finds a changed dialog's field portalled to the document's body", () => {
    expect(changedField(scopeWith({}, { ".modal.comment-popover[data-comment-changed] textarea": sheet }))).toBe(sheet as unknown as HTMLTextAreaElement);
  });
  it("is null with nothing changed, or no scope", () => {
    expect(changedField(scopeWith({ ".comment-popover textarea": here }, { ".modal.comment-popover textarea": sheet }))).toBeNull();
    expect(changedField(null)).toBeNull();
  });
});

describe("hasChangedComment and hasCommentDialog", () => {
  const root = (found: Record<string, object>) => ({ querySelector: (selector: string) => found[selector] ?? null }) as unknown as ParentNode;
  it("finds a changed popover or dialog anywhere in the document", () => {
    // a dialog's box is a `.comment-popover` too, so the one selector finds either
    expect(hasChangedComment(root({ ".comment-popover[data-comment-changed] textarea": {} }))).toBe(true);
    expect(hasChangedComment(root({ ".comment-popover textarea": {} }))).toBe(false);
  });
  it("finds a popover drawn as a dialog by its scrim", () => {
    expect(hasCommentDialog(root({ ".comment-popover-scrim": {} }))).toBe(true);
    expect(hasCommentDialog(root({}))).toBe(false);
  });
});

describe("focusOpenField", () => {
  const focusable = (calls: unknown[]) => ({ focus: (options: unknown) => calls.push(options) });

  it("focuses the field in the scope without scrolling, else a dialog's in the document", () => {
    const here: unknown[] = [];
    const sheet: unknown[] = [];
    focusOpenField(scopeWith({ ".comment-popover textarea": focusable(here) }, { ".modal.comment-popover textarea": focusable(sheet) }));
    expect(here).toEqual([{ preventScroll: true }]);
    expect(sheet).toEqual([]);
    focusOpenField(scopeWith({}, { ".modal.comment-popover textarea": focusable(sheet) }));
    expect(sheet).toEqual([{ preventScroll: true }]);
  });
  it("does nothing without one", () => {
    expect(() => focusOpenField(scopeWith({}, {}))).not.toThrow();
    expect(() => focusOpenField(null)).not.toThrow();
  });
});

describe("revealField", () => {
  it("focuses the field without scrolling and brings its popover into view", () => {
    const calls: unknown[] = [];
    const popover = { scrollIntoView: (options: unknown) => calls.push(["scroll", options]) };
    const field = { focus: (options: unknown) => calls.push(["focus", options]), closest: (selector: string) => selector === ".comment-popover" ? popover : null };
    revealField(field as unknown as HTMLTextAreaElement);
    expect(calls).toEqual([["focus", { preventScroll: true }], ["scroll", { block: "nearest" }]]);
  });
});
