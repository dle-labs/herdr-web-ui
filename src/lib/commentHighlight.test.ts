import { describe, expect, it } from "bun:test";
import { notifyRanges, PENDING_COMMENT_ID, registerCommentSurface, showOpenComment, SurfaceMarks, walkScroll, watchSurfaceRanges, type CommentSurface } from "./commentHighlight.ts";

type Ranges = ReadonlyMap<string, readonly Range[]>;

/** A surface with no DOM: only its ranges matter here, and the open comments it is told of (`opened`). */
function fakeSurface(ranges: Ranges, opened: (string | null)[] = []): CommentSurface {
  return { mark() {}, activate() {}, open: (id) => { opened.push(id); }, boxOf: () => null, ranges: () => ranges };
}

/** A view key: the registries are WeakMaps, any object does. */
const fakeView = (): Element => ({}) as Element;

const someRanges = (): Ranges => new Map([["a", [{} as Range]]]);

describe("watchSurfaceRanges", () => {
  it("reaches a watcher that came before the surface registered, at its registration and its rebuilds", () => {
    const view = fakeView();
    const heard: Ranges[] = [];
    watchSurfaceRanges(view, (ranges) => heard.push(ranges));
    expect(heard).toEqual([]);
    const ranges = someRanges();
    registerCommentSurface(view, fakeSurface(ranges));
    expect(heard).toEqual([ranges]);
    notifyRanges(view);
    expect(heard).toEqual([ranges, ranges]);
  });

  it("hands a later watcher the ranges at once, only when there are some", () => {
    const view = fakeView();
    registerCommentSurface(view, fakeSurface(new Map()));
    const none: Ranges[] = [];
    watchSurfaceRanges(view, (ranges) => none.push(ranges));
    expect(none).toEqual([]);
    const other = fakeView();
    const ranges = someRanges();
    registerCommentSurface(other, fakeSurface(ranges));
    const heard: Ranges[] = [];
    watchSurfaceRanges(other, (next) => heard.push(next));
    expect(heard).toEqual([ranges]);
  });

  it("sends an empty map when the surface unregisters", () => {
    const view = fakeView();
    const unregister = registerCommentSurface(view, fakeSurface(someRanges()));
    const heard: Ranges[] = [];
    watchSurfaceRanges(view, (ranges) => heard.push(ranges));
    unregister();
    expect(heard.length).toBe(2);
    expect(heard[1]!.size).toBe(0);
  });

  it("follows a later registration, and a superseded registration's cleanup stays silent", () => {
    const view = fakeView();
    const first = registerCommentSurface(view, fakeSurface(someRanges()));
    const heard: Ranges[] = [];
    watchSurfaceRanges(view, (ranges) => heard.push(ranges));
    const later = someRanges();
    registerCommentSurface(view, fakeSurface(later));
    expect(heard.at(-1)).toBe(later);
    const count = heard.length;
    first();
    expect(heard.length).toBe(count);
    notifyRanges(view);
    expect(heard.at(-1)).toBe(later);
  });

  it("ends only its own subscription: the same listener given twice is followed twice", () => {
    const view = fakeView();
    registerCommentSurface(view, fakeSurface(someRanges()));
    let calls = 0;
    const listener = (): void => { calls += 1; };
    const stop = watchSurfaceRanges(view, listener);
    watchSurfaceRanges(view, listener);
    calls = 0;
    notifyRanges(view);
    expect(calls).toBe(2);
    stop();
    stop();
    notifyRanges(view);
    expect(calls).toBe(3);
  });
});

describe("showOpenComment", () => {
  it("tells the registered surface which saved comment's popover is open, and that none is", () => {
    const view = fakeView();
    const opened: (string | null)[] = [];
    registerCommentSurface(view, fakeSurface(new Map(), opened));
    expect(opened).toEqual([null]);
    showOpenComment(view, "c1");
    showOpenComment(view, null);
    expect(opened).toEqual([null, "c1", null]);
  });

  it("keeps the open comment for a surface that registers later (its highlights watched anew)", () => {
    const view = fakeView();
    showOpenComment(view, "c1");
    const opened: (string | null)[] = [];
    registerCommentSurface(view, fakeSurface(new Map(), opened));
    expect(opened).toEqual(["c1"]);
    showOpenComment(view, null);
    const again: (string | null)[] = [];
    registerCommentSurface(view, fakeSurface(new Map(), again));
    expect(again).toEqual([null]);
  });

  it("reaches only its own view", () => {
    const view = fakeView();
    const other = fakeView();
    const opened: (string | null)[] = [];
    registerCommentSurface(other, fakeSurface(new Map(), opened));
    showOpenComment(view, "c1");
    expect(opened).toEqual([null]);
  });
});

describe("walkScroll", () => {
  // a view 100 to 500 on screen
  const view = { top: 100, height: 400 };

  it("centres the text and its card when they fit", () => {
    expect(walkScroll({ top: 600, bottom: 700 }, { top: 710, bottom: 740 }, view)).toBe(370);
    expect(walkScroll({ top: 0, bottom: 40 }, { top: 50, bottom: 80 }, view)).toBe(-260);
  });

  it("brings the card's bottom to the view's bottom when they are taller than the view", () => {
    expect(walkScroll({ top: 200, bottom: 1200 }, { top: 1210, bottom: 1240 }, view)).toBe(740);
    expect(walkScroll({ top: -900, bottom: 80 }, { top: 90, bottom: 120 }, view)).toBe(-380);
  });

  it("keeps the card on screen when the text runs on below it", () => {
    expect(walkScroll({ top: 200, bottom: 1300 }, { top: 1210, bottom: 1240 }, view)).toBe(740);
  });
});

describe("SurfaceMarks", () => {
  /** A view that only takes the focus attribute: without the highlight API the marks touch nothing else. */
  const markedView = (): Element => ({ toggleAttribute() {}, removeAttribute() {} }) as unknown as Element;

  it("lists the comment being written under PENDING_COMMENT_ID only while there is one, and tells the watchers", () => {
    const view = markedView();
    const marks = new SurfaceMarks(view);
    registerCommentSurface(view, marks);
    const heard: Ranges[] = [];
    watchSurfaceRanges(view, (ranges) => heard.push(ranges));
    const saved = [{} as Range];
    const pending = [{} as Range];
    marks.publish(new Map([["a", saved]]), pending);
    expect([...heard.at(-1)!]).toEqual([["a", saved], [PENDING_COMMENT_ID, pending]]);
    marks.publish(new Map([["a", saved]]), null);
    expect([...heard.at(-1)!]).toEqual([["a", saved]]);
    expect(marks.comments.get("a")).toBe(saved);
    expect(marks.pending).toBeNull();
  });
});
