/**
 * The pin layer of a comment surface (the chat's scroller, the file viewer's body): a small speech
 * bubble on each comment's text, and the open comment's popover beside its pin, its text kept up
 * meanwhile (`showOpenComment`). The layer
 * lies in the scrolling content, so pins and popover scroll
 * with the text. It is a sibling of the transcript (of the file's content root), never inside it:
 * the highlights watch only that, so a pin drawn or moved never makes them rebuild.
 *
 * Pins are placed from the ranges the surface's highlights publish (`watchSurfaceRanges`), through
 * `placePins`: a bubble's square top left corner, its tip, sits where the comment was made (its
 * `CommentPoint`, a fraction of its text's box: a block clicked, a selection a mouse dragged), else
 * just after the end of its last line on screen, at that line's middle. A comment whose text is not
 * drawn has none, and nor has one whose point, or last line, an element inside the surface (a code
 * view without wrapping, a chat code block or table) has scrolled out of view sideways
 * (`visiblePoint`, `visibleAnchor`).
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { MessageSquare } from "lucide-react";

import "./CommentPins.css";

import { activateComment, PENDING_COMMENT_ID, showOpenComment, watchSurfaceRanges } from "../lib/commentHighlight.ts";
import { PENDING_PIN_CLASS, PIN_CLASS, PINS_CLASS, pinAttrs } from "../lib/commentDom.ts";
import { besidePlace, endTip, lastLine, nearestScroller, pinRightMargin, placePins, pointAt, scrollsSideways, visibleAnchor, visiblePoint, type CommentPoint, type PinAnchor, type PinBox, type PinPlace } from "../lib/commentPins.ts";
import { textBox, textRects } from "../lib/commentSelection.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

/** A comment the layer shows a pin for. */
export interface PinnedComment {
  id: string;
  anchor: string;
  /** the pin's accessible name */
  label: string;
  /** where its pin's tip goes on its text (`CommentPoint`); absent: after the end of its text */
  point?: CommentPoint;
}

/** Where the open comment's popover is drawn: next to its pin, or as a dialog of its own (centred; a sheet on a phone). */
export type PopoverPlacement = "popover" | "dialog";

/** A pin's side (`var(--space-5)` in CommentPins.css). */
const PIN_SIZE_PX = 20;
/** Room between the end of the text and a pin without a point, and between two pins side by side. */
const PIN_GAP_PX = 4;
/** The least room between a pin and the surface's right side. */
const PIN_MARGIN_PX = 8;
/** The least side of a pin's hit area on a touch screen: `max(44px, var(--touch-target))` in CommentPins.css. */
const PIN_HIT_MIN_PX = 44;
/** Room between a pin and its popover beside it. */
const POPOVER_GAP_PX = 8;
/** The least room between the popover and the surface's sides. */
const POPOVER_MARGIN_PX = 8;
/** Frames the surface's scroll stays put before an opened popover brings itself into view, and the longest it waits for that. */
const SCROLL_STILL_FRAMES = 2;
const SCROLL_SETTLE_MS = 1500;

const NO_RANGES: ReadonlyMap<string, readonly Range[]> = new Map();

/** One opening of a popover: a new object each time `openId` changes, so the same id opened again is a new one. */
interface Opening { id: string | null }

/**
 * The pins as last measured, the comments whose text is drawn but scrolled out of view sideways (`hidden`: no pin),
 * and the opening that measure saw settled (its pin, if any, among them).
 */
/** A pin as measured, with the anchor of the comment it was measured for: an edit gives the comment a new id, not a new anchor */
type MeasuredPin = PinPlace & { anchor?: string };

interface Measured {
  pins: readonly MeasuredPin[];
  hidden: ReadonlySet<string>;
  settled: Opening | null;
}

const samePins = (a: readonly PinPlace[], b: readonly PinPlace[]): boolean =>
  a.length === b.length && a.every((pin, index) => pin.id === b[index]!.id && pin.left === b[index]!.left && pin.top === b[index]!.top);
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id));
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * The room a pin keeps from the surface's right side. On a touch screen its hit area (CommentPins.css,
 * as wide as `max(44px, var(--touch-target))` read on `surface`) reaches past the pin on both sides:
 * kept inside the surface whole, or the surface could pan sideways.
 */
function pinMargin(surface: Element, coarse: boolean): number {
  if (!coarse) return PIN_MARGIN_PX;
  const target = Number.parseFloat(getComputedStyle(surface).getPropertyValue("--touch-target"));
  return pinRightMargin(PIN_MARGIN_PX, PIN_SIZE_PX, Math.max(PIN_HIT_MIN_PX, Number.isFinite(target) ? target : 0));
}

/** The last line of text `ranges` show on screen (`textRects`, `lastLine`), with the range it is of; undefined where none is drawn. */
function lastRect(ranges: readonly Range[]): { rect: PinBox; range: Range } | undefined {
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    const last = lastLine(textRects(range));
    if (last !== undefined) return { rect: last, range };
  }
  return undefined;
}

/**
 * Where the tip of a comment's pin goes, in client pixels, and the range it lies on: at its `point` on the box of the
 * text `ranges` show (`textBox`), else after the end of their last line (`lastRect`, `endTip`). Undefined where none of
 * that text is drawn; null where an element inside `surface` scrolls it sideways and the tip, or the whole last line,
 * is out of its view (`visiblePoint`, `visibleAnchor`).
 */
function tipOf(ranges: readonly Range[], point: CommentPoint | undefined, surface: Element): PinAnchor["tip"] | null | undefined {
  if (point !== undefined) {
    const box = textBox(ranges);
    const range = ranges.at(-1);
    if (box === undefined || range === undefined) return undefined;
    const tip = pointAt(box, point);
    return visiblePoint(tip, sidewaysBox(range, surface)) ? tip : null;
  }
  const found = lastRect(ranges);
  if (found === undefined) return undefined;
  // a line running past the element that scrolls it ends at its edge
  const shown = visibleAnchor(found.rect, sidewaysBox(found.range, surface));
  return shown === null ? null : endTip(shown, PIN_GAP_PX);
}

/**
 * The visible box, in client pixels, of the element inside `surface` that scrolls `range`'s end sideways (a code view
 * without wrapping, a chat code block or table: `nearestScroller`); null where none does.
 */
function sidewaysBox(range: Range, surface: Element): PinBox | null {
  const end = range.endContainer;
  const scroller = nearestScroller(end instanceof Element ? end : end.parentElement, surface, (element) => element.parentElement,
    // the widths first: they are cheap, and most elements on the way hold no more than they show
    (element) => element.scrollWidth > element.clientWidth
      && scrollsSideways({ overflowX: getComputedStyle(element).overflowX, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  if (scroller === null) return null;
  const box = scroller.getBoundingClientRect();
  const left = box.left + scroller.clientLeft;
  const top = box.top + scroller.clientTop;
  return { left, top, right: left + scroller.clientWidth, bottom: top + scroller.clientHeight };
}

/**
 * The pins of `comments` in the surface `surface` (the element carrying `data-comment-surface`),
 * in reading order, which is their tab order, and a provisional one for the comment being written.
 * They are measured at most once a frame: after the surface's highlights rebuilt, the comments
 * changed, the surface or its content resized, or another comment opened.
 *
 * With `openId` set and a `popover` to draw, on a desktop nothing of it is drawn until a measure has
 * seen the opening (and, for a new comment, the highlight of its text): then, with the comment's pin
 * there, `popover("popover")` beside the pin; otherwise `popover("dialog")`, which portals itself. A
 * narrow screen (a phone) draws `popover("dialog")` at once, in the commit that opens it.
 */
export function CommentPins({ surface, comments, openId, pendingPoint, popover, onPin }: {
  /** the scrolling surface carrying `data-comment-surface` */
  surface: RefObject<HTMLElement>;
  /** the comments shown, any order */
  comments: readonly PinnedComment[];
  /**
   * id of the comment whose popover is open; PENDING_COMMENT_ID for a new one; null for none. A
   * caller opening a new one shows its text as pending on the surface first, in the same commit
   * (`showPendingComment`, or the file viewer's `setPending`): its popover waits for that highlight
   * one frame at most, then opens as a dialog without its pin
   */
  openId: string | null;
  /** where the pin of the comment being written points (its `CommentPoint`: a block clicked, a selection a mouse dragged); none: after the end of its text */
  pendingPoint?: CommentPoint;
  /** draws the open comment's popover; called with "dialog" when it has no pin or the screen is narrow */
  popover: ((placement: PopoverPlacement) => ReactNode) | null;
  onPin: (id: string, pin: HTMLButtonElement) => void;
}): JSX.Element {
  const narrow = useMediaQuery("(max-width: 640px)");
  const coarse = useMediaQuery("(pointer: coarse)");
  const coarseRef = useRef(coarse);
  coarseRef.current = coarse;
  const [measured, setMeasured] = useState<Measured>({ pins: [], hidden: NO_IDS, settled: null });
  // read by a measure, which runs in a later frame than the render that scheduled it
  const ranges = useRef(NO_RANGES);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const pendingPointRef = useRef(pendingPoint);
  pendingPointRef.current = pendingPoint;
  const opening = useMemo<Opening>(() => ({ id: openId }), [openId]);
  const openingRef = useRef(opening);
  // a new comment's pin waits for its text's highlight: the surface rebuilds for it in this frame or the
  // next. The measures still to hold its popover back for it: one, then it settles without the highlight
  const awaitingRanges = useRef(0);
  const schedule = useRef<() => void>(() => {});

  useEffect(() => {
    const node = surface.current;
    if (node === null) return;
    let frame = 0;
    // the surface or its content resized (a window, a chat width, a font or an image that arrived): the
    // text rewrapped under the pins. The content is the surface's first child as it is now: a file's
    // body is replaced (loading, then the code, then the preview), and a detached one never resizes
    const resized = new ResizeObserver(() => scheduleMeasure());
    let child: Element | null = null;
    const followChild = (): void => {
      const next = node.firstElementChild;
      if (next === child) return;
      if (child !== null) resized.unobserve(child);
      child = next;
      if (child !== null) resized.observe(child);
    };
    const measure = (): void => {
      followChild();
      // measured against the visible box, then shifted by the scroll: the pins' coordinates are the scrolled content's
      const box = node.getBoundingClientRect();
      const left = box.left + node.clientLeft - node.scrollLeft;
      const top = box.top + node.clientTop - node.scrollTop;
      const all = ranges.current;
      const points = new Map<string, CommentPoint | undefined>(commentsRef.current.map((comment) => [comment.id, comment.point]));
      const anchorOf = new Map(commentsRef.current.map((comment) => [comment.id, comment.anchor]));
      if (all.has(PENDING_COMMENT_ID)) points.set(PENDING_COMMENT_ID, pendingPointRef.current);
      const anchors: PinAnchor[] = [];
      const hidden = new Set<string>();
      for (const [id, point] of points) {
        const tip = tipOf(all.get(id) ?? [], point, node);
        if (tip === undefined) continue;
        // inside an element that scrolls it sideways, a tip out of its view has no pin (`tipOf`)
        if (tip === null) { hidden.add(id); continue; }
        anchors.push({ id, tip: { x: tip.x - left, y: tip.y - top } });
      }
      const pins: MeasuredPin[] = placePins(anchors, { right: node.clientWidth - pinMargin(node, coarseRef.current), size: PIN_SIZE_PX, gap: PIN_GAP_PX })
        .map((pin) => ({ ...pin, anchor: anchorOf.get(pin.id) }));
      let seen: Opening | null = openingRef.current;
      if (awaitingRanges.current > 0) {
        // still no highlight for the new comment: one more frame for it
        awaitingRanges.current -= 1;
        seen = null;
        scheduleMeasure();
      }
      setMeasured((current) => {
        const settled = seen ?? current.settled;
        const keptPins = samePins(current.pins, pins);
        const keptHidden = sameIds(current.hidden, hidden);
        return keptPins && keptHidden && settled === current.settled ? current
          : { pins: keptPins ? current.pins : pins, hidden: keptHidden ? current.hidden : hidden, settled };
      });
    };
    const scheduleMeasure = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(() => { frame = 0; measure(); });
    };
    schedule.current = scheduleMeasure;
    // an element inside the surface scrolled sideways (a code view without wrapping, a chat code block or table): the
    // text in it moved under the pins. Not the surface's own scroll, which the pins follow by lying in its content
    const onInnerScroll = (event: Event): void => {
      if (event.target !== node) scheduleMeasure();
    };
    node.addEventListener("scroll", onInnerScroll, { capture: true, passive: true });
    const unwatch = watchSurfaceRanges(node, (next) => {
      ranges.current = next;
      awaitingRanges.current = 0;
      followChild();
      scheduleMeasure();
    });
    resized.observe(node);
    followChild();
    scheduleMeasure();
    return () => {
      window.cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onInnerScroll, { capture: true });
      unwatch();
      resized.disconnect();
      schedule.current = () => {};
    };
  }, [surface]);

  // what a measure reads of the comments is their ids and points: a new list with the same ones changes no pin
  const ids = comments.map((comment) => `${comment.id} ${comment.point?.x ?? ""} ${comment.point?.y ?? ""}`).join("\n");
  const pendingAt = pendingPoint === undefined ? "" : `${pendingPoint.x} ${pendingPoint.y}`;
  useEffect(() => { schedule.current(); }, [ids, pendingAt, coarse]);
  useLayoutEffect(() => {
    openingRef.current = opening;
    awaitingRanges.current = opening.id === PENDING_COMMENT_ID && !ranges.current.has(PENDING_COMMENT_ID) ? 1 : 0;
    schedule.current();
  }, [opening]);
  // a saved comment's text stays up while its popover is open, in every placement, wherever the focus or the pointer
  // goes (lib/commentHighlight.ts `showOpenComment`): the pin's own pointer and focus no longer hold it once the field
  // has the focus. A new comment shows its pending highlight instead
  useLayoutEffect(() => {
    const node = surface.current;
    if (node === null || openId === null || openId === PENDING_COMMENT_ID) return;
    showOpenComment(node, openId);
    return () => showOpenComment(node, null);
  }, [surface, openId]);

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const byAnchor = new Map(comments.map((comment) => [comment.anchor, comment]));
  // the comment a pin measured for an earlier list is drawn for: the same one, or the one its edit saved in its place
  // (a new id on the same anchor), until the next measure, already scheduled, catches up. The pin stays the same
  // element, so a focus given back to it as the popover closes finds it
  const commentOf = (pin: MeasuredPin): PinnedComment | undefined => byId.get(pin.id) ?? (pin.anchor === undefined ? undefined : byAnchor.get(pin.anchor));
  const settled = openId !== null && popover !== null && measured.settled === opening;
  const pinOfOpen = settled ? measured.pins.find((pin) => pin.id === openId) : undefined;
  // the open comment's pin as last drawn for this opening: its text scrolled out of view sideways since (its pin
  // hidden), the popover stays there, beside the place it was opened at, rather than becoming a dialog under the reader
  const lastOpenPin = useRef<{ opening: Opening; pin: MeasuredPin } | null>(null);
  if (pinOfOpen !== undefined) lastOpenPin.current = { opening, pin: pinOfOpen };
  const heldOpenPin = settled && pinOfOpen === undefined && openId !== null && measured.hidden.has(openId) && lastOpenPin.current?.opening === opening
    ? lastOpenPin.current.pin : undefined;
  const openPin = pinOfOpen ?? heldOpenPin;
  // a narrow screen draws every popover as a dialog (the sheet): there is no pin to wait for, so it is drawn in the
  // commit that opens it, and its field takes the focus inside the tap that opened it, where iOS raises its keyboard
  const placement: PopoverPlacement | null = openId === null || popover === null ? null
    : narrow ? "dialog" : !settled ? null : openPin !== undefined ? "popover" : "dialog";

  // the popover beside its pin (`besidePlace`: to its right, top-aligned, else to its left, else below it), placed before
  // paint: against the visible box, shifted by the scroll
  const place = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<Opening | null>(null);
  const pinLeft = openPin?.left;
  const pinTop = openPin?.top;
  useLayoutEffect(() => {
    const node = place.current;
    const scroller = surface.current;
    if (placement !== "popover" || pinLeft === undefined || pinTop === undefined || node === null || scroller === null) return;
    let size = { width: -1, height: -1 };
    const put = (): void => {
      const next = { width: node.offsetWidth, height: node.offsetHeight };
      if (next.width === size.width && next.height === size.height) return;
      size = next;
      const pin = { left: pinLeft - scroller.scrollLeft, top: pinTop - scroller.scrollTop };
      const at = besidePlace(pin, { width: scroller.clientWidth, height: scroller.clientHeight }, size, { pinSize: PIN_SIZE_PX, gap: POPOVER_GAP_PX, margin: POPOVER_MARGIN_PX });
      node.dataset.side = at.side;
      node.style.left = `${at.left + scroller.scrollLeft}px`;
      node.style.top = `${at.top + scroller.scrollTop}px`;
    };
    put();
    // once per opening: a pin that moved later, or a popover that grew, does not pull the reader back to it. Once the
    // surface has stopped scrolling: the composer's walk opens a pin as it scrolls its text into the middle, smoothly,
    // and a scroll of this one's own would cut that short halfway (bounded: a reader who keeps scrolling is not waited for)
    let frame = 0;
    if (scrolledFor.current !== opening) {
      scrolledFor.current = opening;
      const deadline = performance.now() + SCROLL_SETTLE_MS;
      let seen = scroller.scrollTop;
      let still = 0;
      const settle = (): void => {
        frame = 0;
        const now = scroller.scrollTop;
        still = now === seen ? still + 1 : 0;
        seen = now;
        if (still < SCROLL_STILL_FRAMES && performance.now() < deadline) { frame = window.requestAnimationFrame(settle); return; }
        node.scrollIntoView({ block: "nearest" });
      };
      frame = window.requestAnimationFrame(settle);
    }
    // it changed size (a field that grew): placed again, with the side that fits now
    const resized = new ResizeObserver(put);
    resized.observe(node);
    return () => {
      resized.disconnect();
      // placed again before it was brought into view: the next placement does it
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        scrolledFor.current = null;
      }
    };
  }, [placement, pinLeft, pinTop, opening, surface]);

  // the popover beside its pin comes right after that pin, so Tab goes from the pin into it and on to the next pin,
  // and Shift+Tab from it back to its pin. It is placed absolutely: where it lies in the document moves nothing
  const beside = placement === "popover" && popover !== null ? <div ref={place} className="comment-popover-place">{popover("popover")}</div> : null;
  const besideOf = (id: string): ReactNode => (beside !== null && id === openId ? beside : null);
  // each pin with the popover's place after it, keyed as the pin is: the open comment's keeps the popover where it is
  // in the document while its pin is hidden (scrolled out of view sideways), so the popover is not drawn anew
  const keyOf = (pin: MeasuredPin): string => {
    if (pin.id === PENDING_COMMENT_ID) return "pending";
    const comment = commentOf(pin);
    return comment === undefined ? `id:${pin.id}` : `anchor:${comment.anchor}`;
  };
  const entries = measured.pins.map((pin) => {
    const comment = commentOf(pin);
    // measured for a comment that has gone since: the next measure, already scheduled, drops it
    const drawn = pin.id === PENDING_COMMENT_ID ? <PendingPin left={pin.left} top={pin.top} />
      : comment === undefined ? null : <Pin comment={comment} left={pin.left} top={pin.top} onPin={onPin} />;
    return <Fragment key={keyOf(pin)}>{drawn}{besideOf(pin.id)}</Fragment>;
  });
  if (heldOpenPin !== undefined) entries.push(<Fragment key={keyOf(heldOpenPin)}>{null}{besideOf(heldOpenPin.id)}</Fragment>);

  // not announced: the chat's transcript is a live log (`role="log"`), and a pin or a popover is no entry of it
  return <div className={PINS_CLASS} aria-live="off">
    {entries}
    {placement === "dialog" && popover !== null && popover("dialog")}
  </div>;
}

// a pin the pointer is over or the keyboard's focus is on brings its comment's text up
// (lib/commentHighlight.ts), as for any comment. Not a focus a click left, nor a finger: a touch
// enters a pin on every tap and every scroll that starts on it
const pointerOn = (event: PointerEvent<HTMLElement>): void => {
  if (event.pointerType !== "touch") activateComment(event.currentTarget, "pointer", true);
};
const pointerOff = (event: PointerEvent<HTMLElement>): void => activateComment(event.currentTarget, "pointer", false);
const focusOn = (event: FocusEvent<HTMLElement>): void => {
  if (event.currentTarget.matches(":focus-visible")) activateComment(event.currentTarget, "focus", true);
};
const focusOff = (event: FocusEvent<HTMLElement>): void => activateComment(event.currentTarget, "focus", false);

/** A saved comment's pin: opens its popover. Keyed by anchor, so an edit (a new id) keeps the button and its focus. */
function Pin({ comment, left, top, onPin }: { comment: PinnedComment; left: number; top: number; onPin: (id: string, pin: HTMLButtonElement) => void }): JSX.Element {
  const pin = useRef<HTMLButtonElement>(null);
  // a pin that leaves (its comment deleted or sent, its text gone) gets no pointerleave or blur: release what it held
  // while it is still in the document, or its text stays up (React runs a layout cleanup before it removes the element)
  useLayoutEffect(() => {
    const node = pin.current;
    return () => {
      if (node === null) return;
      activateComment(node, "pointer", false);
      activateComment(node, "focus", false);
    };
  }, []);
  return <button
    ref={pin}
    type="button"
    className={PIN_CLASS}
    style={{ left, top }}
    aria-label={comment.label}
    {...pinAttrs(comment.id, comment.anchor)}
    onPointerEnter={pointerOn}
    onPointerLeave={pointerOff}
    onFocus={focusOn}
    onBlur={focusOff}
    onClick={(event) => onPin(comment.id, event.currentTarget)}
  >
    <MessageSquare aria-hidden="true" strokeWidth={2.75} />
  </button>;
}

/**
 * Where the comment being written will go: shown, never reached or pressed. Its tip is where the block was clicked or
 * the drag let go, under the pointer: a press there goes through it to the text (CommentPins.css), so the second click
 * of a double click selects the word under it, as it would with no pin.
 */
function PendingPin({ left, top }: { left: number; top: number }): JSX.Element {
  return <button type="button" className={`${PIN_CLASS} ${PENDING_PIN_CLASS}`} style={{ left, top }} tabIndex={-1} aria-hidden="true">
    <MessageSquare aria-hidden="true" strokeWidth={2.75} />
  </button>;
}
