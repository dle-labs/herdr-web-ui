/**
 * The text of every comment shown in the chat, highlighted with the CSS Custom Highlight API
 * (`::highlight(block-comment)` in BlockComments.css): a selection's text part by part, a comment
 * on a whole part all of that part's text. Over them the comment whose pin the pointer or
 * the focus is on, or whose popover is open (`block-comment-active`), and over that the one the composer's walk stands on
 * (`block-comment-current`). While either is shown the view carries `data-comment-focus`, and the
 * stylesheet fades the other comments' marks so the active one stands out. The text a new comment is
 * being written on in its popover (`block-comment-pending`) looks the same: a selection's, which the
 * field took the browser's selection away from, or a whole block clicked. Where the
 * browser lacks the API there is no highlight. Needs a DOM.
 *
 * The chat is one comment surface; the file viewer is another. An element carrying
 * `data-comment-surface` (`COMMENT_SURFACE`) registers how its pins bring their text up
 * (`registerCommentSurface`): a pin's pointer and focus (`activateComment`), the open popover
 * (`showOpenComment`) and the composer's walk (`markCurrentComment`, `showWalkStop`) reach the surface
 * the pin is in, whichever it is. Every surface shows its comments through a `SurfaceMarks`; only which
 * text a comment covers is the surface's own.
 * A surface also publishes its ranges after each rebuild (`watchSurfaceRanges`): the pin layer
 * (CommentPins.tsx) places its pins from them. That layer is a sibling of the transcript (of the
 * file's content root), never inside it, so a pin drawn or moved is no mutation the highlights
 * watch, and a rebuild never follows from one.
 */
import { blockComments, draftComment, partSegments, textRange, type BlockComment, type CommentTarget, type PartSegment } from "./blockComments.ts";
import { unionBox } from "./commentPins.ts";
import { commentPartOf, outsideMath, partTextNodes } from "./commentSelection.ts";

export const COMMENT_HIGHLIGHT = "block-comment";
export const ACTIVE_COMMENT_HIGHLIGHT = "block-comment-active";
export const CURRENT_COMMENT_HIGHLIGHT = "block-comment-current";
export const PENDING_COMMENT_HIGHLIGHT = "block-comment-pending";
/** Set on a comment surface while a pin's comment is up (pointer, keyboard focus, its open popover or the walk): the stylesheet fades the others. */
export const FOCUS_ATTRIBUTE = "data-comment-focus";
/** Marks an element whose comment pins bring their text up through a registered `CommentSurface`. */
export const COMMENT_SURFACE = "data-comment-surface";
/** the id the comment being written (pending) has in a surface's ranges */
export const PENDING_COMMENT_ID = "";

/**
 * How a comment surface shows a comment's text: what the walk, the pointer and the focus ask of it.
 * A `pin` (`.comment-pin`, CommentPins.tsx) names its comment in `data-comment-id`.
 */
export interface CommentSurface {
  /** the walk stands on `pin`, or on nothing */
  mark(pin: HTMLElement | null): void;
  /** the pointer is over `pin`, or the focus on or in it (`on`), or no longer */
  activate(pin: HTMLElement, by: "pointer" | "focus", on: boolean): void;
  /** the popover of the saved comment `id` is open, or none is (null) */
  open(id: string | null): void;
  /** the box around the text of the comment `pin` shows, if it has some */
  boxOf(pin: HTMLElement): DOMRect | null;
  /**
   * each comment's ranges as of the last rebuild, by id, in document order; the one being written
   * under `PENDING_COMMENT_ID`. The pin layer (CommentPins.tsx) places its pins from them
   */
  ranges(): ReadonlyMap<string, readonly Range[]>;
}

type RangesListener = (ranges: ReadonlyMap<string, readonly Range[]>) => void;

const surfaces = new WeakMap<Element, CommentSurface>();
/** the saved comment whose popover is open on each view (`showOpenComment`), whether a surface is registered on it yet or not */
const openComments = new WeakMap<Element, string>();
/** who follows each view's ranges (`watchSurfaceRanges`), whether a surface is registered on it yet or not */
const rangeListeners = new WeakMap<Element, Set<RangesListener>>();
const NO_RANGE_MAP: ReadonlyMap<string, readonly Range[]> = new Map();

/**
 * Hands the ranges of the surface on `view` (none without one) to everyone following them: a
 * surface calls it at the end of each rebuild.
 */
export function notifyRanges(view: Element): void {
  const listeners = rangeListeners.get(view);
  if (listeners === undefined || listeners.size === 0) return;
  const ranges = surfaces.get(view)?.ranges() ?? NO_RANGE_MAP;
  for (const listener of [...listeners]) listener(ranges);
}

/**
 * `view` (which carries `COMMENT_SURFACE`) shows its pins' text through `surface` until the
 * returned cleanup runs. A later registration for the same view takes over; an earlier cleanup then
 * leaves it alone. Whoever follows the view's ranges hears of either.
 */
export function registerCommentSurface(view: Element, surface: CommentSurface): () => void {
  surfaces.set(view, surface);
  surface.open(openComments.get(view) ?? null);
  notifyRanges(view);
  return () => {
    if (surfaces.get(view) !== surface) return;
    surfaces.delete(view);
    notifyRanges(view);
  };
}

/**
 * Calls `listener` with the ranges of the surface on `view` after each of its rebuilds, and at once
 * if it already has some. Works whether that surface registers before or after this call,
 * and follows a later registration. Returns the cleanup.
 */
export function watchSurfaceRanges(view: Element, listener: (ranges: ReadonlyMap<string, readonly Range[]>) => void): () => void {
  let listeners = rangeListeners.get(view);
  if (listeners === undefined) {
    listeners = new Set();
    rangeListeners.set(view, listeners);
  }
  // a function of its own: the same listener given twice is followed twice, and each cleanup ends one
  const own: RangesListener = (ranges) => listener(ranges);
  listeners.add(own);
  const ranges = surfaces.get(view)?.ranges();
  if (ranges !== undefined && ranges.size > 0) own(ranges);
  return () => { rangeListeners.get(view)?.delete(own); };
}

/** The surface `element` lies in (itself included); undefined outside one. */
function surfaceOf(element: Element): CommentSurface | undefined {
  const view = element.closest(`[${COMMENT_SURFACE}]`);
  return view === null ? undefined : surfaces.get(view);
}

/** Which highlight paints over which where they overlap: the walk's over a pin's or the one being written over the rest. */
const PRIORITY: Record<string, number> = { [COMMENT_HIGHLIGHT]: 0, [ACTIVE_COMMENT_HIGHLIGHT]: 1, [PENDING_COMMENT_HIGHLIGHT]: 1, [CURRENT_COMMENT_HIGHLIGHT]: 2 };

const supported = (): boolean => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/**
 * The one `Highlight` of `name` every chat view shares (several panes can be mounted), each view
 * adding and deleting only its own ranges; null without the API.
 */
function shared(name: string): Highlight | null {
  if (!supported()) return null;
  let highlight = CSS.highlights.get(name);
  if (highlight === undefined) {
    highlight = new Highlight();
    highlight.priority = PRIORITY[name] ?? 0;
    CSS.highlights.set(name, highlight);
  }
  return highlight;
}

const NO_RANGES: readonly Range[] = [];

/**
 * A view's ranges in one shared highlight (`name`, made on first use with its `PRIORITY`): a change
 * adds and deletes only the ranges that came or went, so several views can share it.
 */
export class SharedRanges {
  private ranges: readonly Range[] = NO_RANGES;

  constructor(private name: string) {}

  set(ranges: readonly Range[]): void {
    const highlight = shared(this.name);
    if (highlight !== null) {
      const next = new Set(ranges);
      for (const range of this.ranges) if (!next.has(range)) highlight.delete(range);
      const had = new Set(this.ranges);
      for (const range of next) if (!had.has(range)) highlight.add(range);
    }
    this.ranges = ranges;
  }
}

/**
 * How far the chat view (`view`, its top and height on screen) scrolls for the walk to show a
 * comment's text and its pin: both in the middle when they fit, else the pin's
 * bottom at the view's bottom, so the pin the walk focuses is on screen.
 */
export function walkScroll(text: { top: number; bottom: number }, pin: { top: number; bottom: number }, view: { top: number; height: number }): number {
  const top = Math.min(text.top, pin.top);
  const bottom = Math.max(text.bottom, pin.bottom);
  return bottom - top > view.height ? pin.bottom - (view.top + view.height) : (top + bottom) / 2 - (view.top + view.height / 2);
}

/**
 * Adds to `next` the ranges of the `segments` in `part`, by comment id, one per segment whose
 * offsets still fit the part's text. A range in `held` (the ranges before) whose boundaries did not
 * move is kept. True when it added one.
 */
function addRanges(part: Element, segments: readonly PartSegment[], held: ReadonlyMap<string, readonly Range[]>, next: Map<string, Range[]>): boolean {
  if (segments.length === 0) return false;
  const nodes = partTextNodes(part);
  const lengths = nodes.map((node) => node.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let added = false;
  for (const { comment, start, end: until } of segments) {
    const end = until ?? total;
    const at = end > start ? textRange(lengths, start, end) : null;
    if (at === null) continue;
    // the offsets count a formula's hidden MathML: a boundary in it moves out, so the range
    // takes the formula whole, its glyphs too
    const [startNode, startOffset] = outsideMath(nodes[at.startNode]!, at.startOffset, false);
    const [endNode, endOffset] = outsideMath(nodes[at.endNode]!, at.endOffset, true);
    const ranges = next.get(comment.id) ?? [];
    const kept = held.get(comment.id)?.[ranges.length];
    const same = kept !== undefined && kept.startContainer === startNode && kept.startOffset === startOffset && kept.endContainer === endNode && kept.endOffset === endOffset;
    let range = kept;
    if (!same) {
      range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
    }
    ranges.push(range!);
    next.set(comment.id, ranges);
    added = true;
  }
  return added;
}

/**
 * Adds to `next` the ranges of `comment` (a draft, `draftComment`: the one being written) in the commentable parts of
 * `owner`'s pane in `root`, as `addRanges` does; returns the parts that got one.
 */
function addDraftRanges(root: Element, owner: string, comment: BlockComment, held: ReadonlyMap<string, readonly Range[]>, next: Map<string, Range[]>): Element[] {
  const touched: Element[] = [];
  for (const part of root.querySelectorAll(".is-commentable")) {
    const found = commentPartOf(part);
    if (found?.owner === owner && addRanges(part, partSegments([comment], found.target, found.parts), held, next)) touched.push(part);
  }
  return touched;
}

/**
 * The ranges a comment on `target` of `owner`'s pane gets in `root` (a chat view), as its highlight builds them while it
 * is being written and once it is saved: a block's whole text, or a selection's part by part. What its `CommentPoint` is
 * measured on as it is made. Needs a DOM.
 */
export function draftRanges(root: Element, owner: string, target: CommentTarget): Range[] {
  const next = new Map<string, Range[]>();
  addDraftRanges(root, owner, draftComment(target), new Map(), next);
  return [...next.values()].flat();
}

/**
 * How strongly a surface shows each comment's text, whatever text that is (the chat's `ViewHighlights`, the file
 * viewer's `FileHighlights` decide it and `publish` it here): every comment the common tint; over it the comment whose
 * pin the pointer or the focus is on, or whose popover is open (active); over that the one the walk stands on
 * (current); the one being written the pending tint. Registered as the surface on `view` (`watchSurface`).
 */
export class SurfaceMarks implements CommentSurface {
  private all = new SharedRanges(COMMENT_HIGHLIGHT);
  private active = new SharedRanges(ACTIVE_COMMENT_HIGHLIGHT);
  private currentShown = new SharedRanges(CURRENT_COMMENT_HIGHLIGHT);
  private pendingShown = new SharedRanges(PENDING_COMMENT_HIGHLIGHT);
  private commentRanges: ReadonlyMap<string, readonly Range[]> = NO_RANGE_MAP;
  private pendingRanges: readonly Range[] | null = null;
  private current: HTMLElement | null = null;
  private pointed: HTMLElement | null = null;
  private focused: HTMLElement | null = null;
  /** the saved comment whose popover is open */
  private opened: string | null = null;

  /** `view` carries `COMMENT_SURFACE` and takes the focus mode */
  constructor(readonly view: Element) {}

  /** Each saved comment's ranges as last published: a rebuild keeps those whose boundaries did not move. */
  get comments(): ReadonlyMap<string, readonly Range[]> { return this.commentRanges; }

  /** The ranges of the comment being written as last published; null while none is. */
  get pending(): readonly Range[] | null { return this.pendingRanges; }

  /**
   * A rebuild's result: each saved comment's ranges by id, in document order, and those of the one being written (null:
   * none is). The shared highlights change only by the ranges that came or went; whoever follows the surface's ranges
   * hears of them (`notifyRanges`).
   */
  publish(commentRanges: ReadonlyMap<string, readonly Range[]>, pending: readonly Range[] | null): void {
    // a pin that left without its pointerleave or blur (re-rendered, deleted) is no longer pointed at, focused or walked to
    if (this.pointed?.isConnected === false) this.pointed = null;
    if (this.focused?.isConnected === false) this.focused = null;
    if (this.current?.isConnected === false) this.current = null;
    this.commentRanges = commentRanges;
    this.pendingRanges = pending;
    const pendingRanges = pending ?? NO_RANGES;
    // the text being written on takes the tint every comment has, and the stronger tint over it
    this.all.set([...[...commentRanges.values()].flat(), ...pendingRanges]);
    this.pendingShown.set(pendingRanges);
    this.showMarks();
    notifyRanges(this.view);
  }

  /** Each comment's ranges by id, and those of the one being written under `PENDING_COMMENT_ID` while there is one. */
  ranges(): ReadonlyMap<string, readonly Range[]> {
    const all = new Map<string, readonly Range[]>(this.commentRanges);
    if (this.pendingRanges !== null) all.set(PENDING_COMMENT_ID, this.pendingRanges);
    return all;
  }

  /** The walk stands on `pin`, or on nothing. Its ranges are the current highlight while the pin is in the view. */
  mark(pin: HTMLElement | null): void {
    this.current = pin;
    this.showMarks();
  }

  /** The pointer is over `pin`, or the focus on it (`on`), or no longer: its comment's text comes up while either holds. */
  activate(pin: HTMLElement, by: "pointer" | "focus", on: boolean): void {
    if (by === "pointer") this.pointed = on ? pin : this.pointed === pin ? null : this.pointed;
    else this.focused = on ? pin : this.focused === pin ? null : this.focused;
    this.showMarks();
  }

  /** The popover of the saved comment `id` is open (null: none is): its text comes up while it is, wherever the focus or the pointer goes. */
  open(id: string | null): void {
    this.opened = id;
    this.showMarks();
  }

  /** The box around the text of the comment `pin` shows, if it has some. */
  boxOf(pin: HTMLElement): DOMRect | null {
    const rects = this.rangesOf(pin).map((range) => range.getBoundingClientRect()).filter((rect) => rect.width !== 0 || rect.height !== 0);
    const box = unionBox(rects);
    return box === undefined ? null : new DOMRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  }

  /** The ranges of the comment `pin` shows, by its current id: an edit gives the comment a new id but keeps the pin's element. */
  private rangesOf(pin: HTMLElement | null): readonly Range[] {
    const id = pin?.isConnected ? pin.dataset.commentId : undefined;
    return id === undefined ? NO_RANGES : this.commentRanges.get(id) ?? NO_RANGES;
  }

  private showMarks(): void {
    const current = this.rangesOf(this.current);
    const opened = this.opened === null ? NO_RANGES : this.commentRanges.get(this.opened) ?? NO_RANGES;
    const active = [...new Set([...this.rangesOf(this.pointed), ...this.rangesOf(this.focused), ...opened])];
    this.currentShown.set(current);
    this.active.set(active);
    // focus mode, per surface (two panes are independent): the stylesheet fades every other comment's marks while a pin's
    // text is up. Only when there is such text: a pin whose text is gone would fade the rest for nothing
    this.view.toggleAttribute(FOCUS_ATTRIBUTE, current.length + active.length > 0);
  }

  dispose(): void {
    this.all.set(NO_RANGES);
    this.active.set(NO_RANGES);
    this.currentShown.set(NO_RANGES);
    this.pendingShown.set(NO_RANGES);
    this.commentRanges = NO_RANGE_MAP;
    this.pendingRanges = null;
    this.current = this.pointed = this.focused = null;
    this.opened = null;
    this.view.removeAttribute(FOCUS_ATTRIBUTE);
  }
}

/**
 * Registers `marks` as the surface on its view and runs `rebuild` at most once per frame after `schedule` or a mutation
 * in `observed` that `touches` lets through (any, by default), until `dispose` runs, which clears the marks too.
 */
export function watchSurface(marks: SurfaceMarks, observed: Element, rebuild: () => void, touches: (records: readonly MutationRecord[]) => boolean = () => true): {
  schedule(): void;
  dispose(): void;
} {
  const unregister = registerCommentSurface(marks.view, marks);
  let frame = 0;
  const schedule = (): void => {
    if (frame === 0) frame = window.requestAnimationFrame(() => { frame = 0; rebuild(); });
  };
  const observer = new MutationObserver((records) => { if (frame === 0 && touches(records)) schedule(); });
  observer.observe(observed, { childList: true, subtree: true, characterData: true });
  return {
    schedule,
    dispose() {
      window.cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      unregister();
      marks.dispose();
    },
  };
}

/** Which text of one chat view's transcript each comment covers, published to the view's `SurfaceMarks`. */
class ViewHighlights {
  /** the parts the ranges lie in: a change in one of them, or its removal, can move or end a range */
  private parts = new Set<Element>();
  /** the comment being written in the popover, not saved yet (ChatView) */
  private pending: { owner: string; comment: BlockComment } | null = null;
  /** its ranges by its draft id, as `addDraftRanges` keeps the unmoved ones */
  private pendingRanges = new Map<string, Range[]>();

  constructor(private marks: SurfaceMarks, private transcript: Element) {}

  /**
   * Whether these transcript mutations can touch a highlight: a change inside a commented part or
   * one holding a range, a commented part added, or a part holding a range removed. Another turn
   * streaming touches none, and nor does a pin: the pin layer is outside the transcript.
   */
  touches(records: readonly MutationRecord[]): boolean {
    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target.parentElement;
      const part = element?.closest(".is-commentable");
      if (part && (part.classList.contains("is-commented") || this.parts.has(part))) return true;
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(".is-commented") || node.querySelector(".is-commented") !== null)) return true;
      }
      for (const node of record.removedNodes) {
        for (const held of this.parts) if (node.contains(held)) return true;
      }
    }
    return false;
  }

  /**
   * Every comment shown in the transcript gets a range per part it covers (`partSegments`), never
   * one across parts: what lies between them would be painted too. A segment whose offsets no
   * longer fit the part's text gets none. A range whose boundaries did not move is kept, and the
   * shared highlights are touched only for the ranges that came or went. The comment being written
   * gets its ranges the same way (`draftComment`).
   */
  rebuild(): void {
    const next = new Map<string, Range[]>();
    const parts = new Set<Element>();
    for (const part of this.transcript.querySelectorAll(".is-commented")) {
      const found = commentPartOf(part);
      if (found === undefined) continue;
      const segments = partSegments(blockComments.list(found.owner), found.target, found.parts);
      if (addRanges(part, segments, this.marks.comments, next)) parts.add(part);
    }
    // the selection a comment is being written on: every part of its reply may hold some of it
    const pending = new Map<string, Range[]>();
    if (this.pending !== null) {
      for (const part of addDraftRanges(this.transcript, this.pending.owner, this.pending.comment, this.pendingRanges, pending)) parts.add(part);
    }
    this.pendingRanges = pending;
    this.parts = parts;
    this.marks.publish(next, this.pending === null ? null : [...pending.values()].flat());
  }

  /** A comment is being written on `target` of `owner`'s pane (null: none any more): its text shows as the comment's will. */
  setPending(pending: { owner: string; target: CommentTarget } | null): void {
    this.pending = pending === null ? null : { owner: pending.owner, comment: draftComment(pending.target) };
    this.rebuild();
  }
}

const views = new WeakMap<Element, ViewHighlights>();

/**
 * Highlights the comments in `view`'s `transcript` until the returned cleanup runs: the ranges
 * are rebuilt at most once per frame after a change in the transcript's DOM that can touch them
 * (a poll that re-rendered a commented reply, a page of history, a code block unfolded) or after
 * any comment changed. A rewrap needs nothing: a range follows its text.
 */
export function watchCommentHighlights(view: Element, transcript: Element): () => void {
  const marks = new SurfaceMarks(view);
  const highlights = new ViewHighlights(marks, transcript);
  views.set(view, highlights);
  const watching = watchSurface(marks, transcript, () => highlights.rebuild(), (records) => highlights.touches(records));
  const unsubscribe = blockComments.subscribe(watching.schedule);
  watching.schedule();
  return () => {
    unsubscribe();
    watching.dispose();
    if (views.get(view) === highlights) views.delete(view);
  };
}

/**
 * The composer's walk stands on `pin` in `view` (null: on nothing), whose surface is the one
 * `view` lies in: its comment's text takes the current highlight. Returns the box around that text,
 * for scrolling to it; null without one.
 */
export function markCurrentComment(view: Element, pin: HTMLElement | null): DOMRect | null {
  const surface = surfaceOf(view);
  if (surface === undefined) return null;
  surface.mark(pin);
  return pin === null ? null : surface.boxOf(pin);
}

/**
 * The walk's stop on `pin` (`.comment-pin`: the composer's walk in the chat, the file viewer's) in the
 * scrolling `view`, once the caller has marked it as its own: its text takes the current highlight,
 * and the view scrolls the text and its pin into the middle, or, taller than the view, the text's
 * end and the pin at its bottom: the focused pin is always on screen (`walkScroll`). The pin
 * alone where its text could not be found. Then the focus goes to the pin: a pin the walk opened
 * gives it to its popover as that mounts (CommentPins.tsx), which brings itself into view only once
 * this scroll has ended.
 */
export function showWalkStop(view: Element, pin: HTMLElement): void {
  const marked = markCurrentComment(view, pin);
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (marked === null || marked.height === 0) pin.scrollIntoView({ block: "center", behavior });
  else {
    const top = view.getBoundingClientRect().top + view.clientTop;
    view.scrollBy({ top: walkScroll(marked, pin.getBoundingClientRect(), { top, height: view.clientHeight }), behavior });
  }
  // a pin is a button named after its comment: with the focus on it a screen reader reads the comment
  pin.focus({ preventScroll: true });
}

/**
 * A comment is being written on `target` in `view` (a selection, or a block clicked), of the pane `owner` (null:
 * no longer): its text is highlighted as a comment's, with the stronger tint, until it is saved or
 * given up. Focusing the comment's field took the browser's own selection away.
 */
export function showPendingComment(view: Element, pending: { owner: string; target: CommentTarget } | null): void {
  views.get(view)?.setPending(pending);
}

/**
 * The popover of the saved comment `id` is open on the surface `view` (the element carrying `COMMENT_SURFACE`; null:
 * none is): its text takes the active highlight, and the surface focus mode, until the popover closes, wherever the
 * focus or the pointer goes meanwhile (into the popover's field, out of the pin). Kept for the view, so a surface
 * that registers later (its highlights watched anew) shows it too. A new comment has its pending highlight instead.
 */
export function showOpenComment(view: Element, id: string | null): void {
  if (id === null) openComments.delete(view);
  else openComments.set(view, id);
  surfaces.get(view)?.open(id);
}

/** The pointer entered or left `pin`, or the focus came onto or left it (`on`): its comment's text comes up meanwhile. */
export function activateComment(pin: HTMLElement, by: "pointer" | "focus", on: boolean): void {
  surfaceOf(pin)?.activate(pin, by, on);
}
