/**
 * Where the comment pins go: small speech bubbles whose square top left corner (the tip) sits on a
 * point of the commented text. A comment made by a click remembers where it was clicked
 * (`CommentPoint`, fractions of its text's box); any other has its tip just after the end of its
 * last line. Pure geometry, no DOM: the caller measures each comment's text and draws the pins where
 * `placePins` says.
 */

/** A rectangle in the surface's scrolled content coordinates. */
export interface PinBox { left: number; top: number; right: number; bottom: number }

/** A point, in whatever coordinates its caller uses (client or the surface's content). */
export interface PinPoint { x: number; y: number }

/**
 * Where a comment's pin points: fractions of the bounding box of its highlighted text (the union of its
 * highlight ranges' client rects), 0 at the box's left or top, 1 at its right or bottom. Fractions keep
 * the pin where it was put on the text as that rewraps. A click right of a short heading is `x > 1`.
 */
export interface CommentPoint { x: number; y: number }

/** The fractions a stored `CommentPoint` may take: anything else is no point (`isCommentPoint`). */
export const POINT_BOUNDS = { x: [-1, 8], y: [-1, 2] } as const;

const within = (value: unknown, [low, high]: readonly [number, number]): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;

/** Whether a stored value is a point a pin can be placed at: finite fractions inside `POINT_BOUNDS`. */
export function isCommentPoint(value: unknown): value is CommentPoint {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return within(x, POINT_BOUNDS.x) && within(y, POINT_BOUNDS.y);
}

/** The box around `rects` (a comment's text, line by line); undefined for none. */
export function unionBox(rects: Iterable<PinBox>): PinBox | undefined {
  let box: PinBox | undefined;
  for (const { left, top, right, bottom } of rects) {
    box = box === undefined ? { left, top, right, bottom }
      : { left: Math.min(box.left, left), top: Math.min(box.top, top), right: Math.max(box.right, right), bottom: Math.max(box.bottom, bottom) };
  }
  return box;
}

const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.min(high, Math.max(low, value));
/** four decimals: a hundredth of a pixel on a box a hundred pixels wide, and a short stored entry */
const fraction = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * The point `at` as fractions of `box` (both in the same coordinates), held inside `POINT_BOUNDS` so that
 * it reads back (`isCommentPoint`). Undefined for a box without width or height: no fraction of it says where.
 */
export function pointIn(box: PinBox, at: PinPoint): CommentPoint | undefined {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (!(width > 0 && height > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return undefined;
  return { x: fraction(clamp((at.x - box.left) / width, POINT_BOUNDS.x)), y: fraction(clamp((at.y - box.top) / height, POINT_BOUNDS.y)) };
}

/** Where `point` lies on `box`, in the box's coordinates: the inverse of `pointIn`. */
export function pointAt(box: PinBox, point: CommentPoint): PinPoint {
  return { x: box.left + point.x * (box.right - box.left), y: box.top + point.y * (box.bottom - box.top) };
}

/** The tip of a pin without a point: `gap` after the end of its comment's last line, at that line's vertical middle. */
export function endTip(last: PinBox, gap: number): PinPoint {
  return { x: last.right + gap, y: (last.top + last.bottom) / 2 };
}

/** A comment's pin tip (`point`, or `endTip`), in the surface's scrolled content coordinates. */
export interface PinAnchor { id: string; tip: PinPoint }

/** Where a pin goes: its top left corner, which is its tip. */
export interface PinPlace { id: string; left: number; top: number }

/**
 * Each pin's top left corner (its tip) sits on its anchor's tip, so the bubble hangs down and right of
 * it. Two pins overlap when they are less than `size` apart vertically and their horizontal ranges
 * `[left, left + size + gap)` intersect. A pin that overlaps one already placed moves to its right
 * (again, until it is clear) and joins its chain. A chain that runs past the column's `right` edge
 * moves back inside whole, and never past the left edge. The result is in reading order: top to
 * bottom, then left to right.
 */
export function placePins(
  anchors: readonly PinAnchor[],
  { right, size, gap }: { right: number; size: number; gap: number },
): PinPlace[] {
  const wanted = anchors
    .map(({ id, tip }) => ({ id, left: tip.x, top: tip.y }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const placed: PinPlace[] = [];
  // chain[i]: the first pin of pin i's chain (a pin that overlapped two chains joins them)
  const chain: number[] = [];
  const root = (i: number): number => (chain[i] === i ? i : (chain[i] = root(chain[i]!)));
  const overlaps = (pin: PinPlace, other: PinPlace) =>
    Math.abs(pin.top - other.top) < size && pin.left < other.left + size + gap && other.left < pin.left + size + gap;

  for (const pin of wanted) {
    const index = placed.length;
    chain.push(index);
    for (let hit = placed.findIndex((other) => overlaps(pin, other)); hit >= 0; hit = placed.findIndex((other) => overlaps(pin, other))) {
      pin.left = placed[hit]!.left + size + gap;
      chain[root(hit)] = index;
    }
    placed.push(pin);
  }

  const overflow = new Map<number, number>();
  placed.forEach((pin, i) => overflow.set(root(i), Math.max(overflow.get(root(i)) ?? 0, pin.left + size - right)));
  placed.forEach((pin, i) => { pin.left = Math.max(0, pin.left - overflow.get(root(i))!); });
  return placed;
}

/**
 * The last line of text a comment's `rects` (one per text node and line, in document order, as `textRects` gives them)
 * lie on: from the leftmost to the rightmost of those on the last rect's line, which is the last rect's height. Its
 * right end is where the pin goes; its left end tells, where an element scrolls the text sideways, whether any of the
 * line is in view (`visibleAnchor`): the last text node alone (a code line's closing token) may not be while the rest is.
 */
export function lastLine(rects: readonly PinBox[]): PinBox | undefined {
  const last = rects.at(-1);
  if (last === undefined) return undefined;
  const middle = (last.top + last.bottom) / 2;
  let { left, right } = last;
  for (const rect of rects) {
    if (rect.top > middle || rect.bottom < middle) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return { left, top: last.top, right, bottom: last.bottom };
}

/** What tells whether an element scrolls sideways: its `overflow-x`, and how wide its content is against what it shows. */
export interface SidewaysFacts { overflowX: string; scrollWidth: number; clientWidth: number }

/** Whether an element scrolls its content sideways: it lets it scroll (`auto`, `scroll`) and holds more than it shows. */
export function scrollsSideways({ overflowX, scrollWidth, clientWidth }: SidewaysFacts): boolean {
  return (overflowX === "auto" || overflowX === "scroll") && scrollWidth > clientWidth;
}

/**
 * The nearest of `from` and its ancestors (`parentOf`) that scrolls sideways (`scrolls`), below `stop` (the comment
 * surface, whose own scroll the pins follow by lying in its content); null for none.
 */
export function nearestScroller<T>(from: T | null, stop: T, parentOf: (node: T) => T | null, scrolls: (node: T) => boolean): T | null {
  for (let node = from; node !== null && node !== stop; node = parentOf(node)) if (scrolls(node)) return node;
  return null;
}

/**
 * A comment's last line as a pin without a point is placed from it, against the visible `box` of the element that
 * scrolls it sideways (null: none; a code view without wrapping, a chat code block or table): null where the line lies
 * wholly outside that box, scrolled out of view, so no pin floats beside other text; else its right end cut at the box's
 * right side, so the pin sits at the edge of what shows.
 */
export function visibleAnchor(last: PinBox, box: PinBox | null): PinBox | null {
  if (box === null) return last;
  if (last.right <= box.left || last.left >= box.right || last.bottom <= box.top || last.top >= box.bottom) return null;
  return last.right > box.right ? { ...last, right: box.right } : last;
}

/**
 * Whether a pin's tip at `point` (a comment's `CommentPoint` on its text) shows, against the visible `box` of the
 * element that scrolls its text sideways (null: none): a point that lies outside that box is scrolled out of view, and
 * its pin is hidden, so it never floats beside other text.
 */
export function visiblePoint(point: PinPoint, box: PinBox | null): boolean {
  return box === null || (point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom);
}

/**
 * The room a pin of `size` keeps from the column's right side: at least `margin`, and at least half
 * of what its hit area (`hit` wide, centred on it) reaches past it, so that area stays inside too.
 */
export function pinRightMargin(margin: number, size: number, hit: number): number {
  return Math.max(margin, Math.ceil((hit - size) / 2));
}

/**
 * Where a box of `size` goes under a line `anchor`, both in the coordinates of the visible `view`: centred on the
 * anchor's `right`, `gap` below it, above it instead when there is no room below and there is above, and `margin`
 * inside the view's sides. A popover with no room beside its pin goes under it this way (`besidePlace`).
 */
function belowPlace(
  anchor: { top: number; bottom: number; right: number },
  view: { width: number; height: number },
  size: { width: number; height: number },
  { gap, margin }: { gap: number; margin: number },
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(anchor.right - size.width / 2, view.width - size.width - margin));
  const above = anchor.top - gap - size.height;
  const under = anchor.bottom + gap;
  const top = under + size.height > view.height && above >= 0 ? above : under;
  return { left, top };
}

/** The side of its pin a comment's popover opens on (`besidePlace`). */
export type PopoverSide = "right" | "left" | "below";

/**
 * Where a comment's popover of `size` goes beside its pin (`pin`: the pin's top left corner and its side `pinSize`),
 * all in the coordinates of the visible `view`. First to the right of the pin, `gap` from it, its top level with the
 * pin's top; else to its left, the same way; else below it (`belowPlace`, centred on the pin). Beside the pin it is
 * shifted up as far as it would run past the view's bottom (`margin` inside it), but never so far that it no longer
 * reaches the pin's bottom, nor above the view's top `margin` while the pin is below that.
 */
export function besidePlace(
  pin: { left: number; top: number },
  view: { width: number; height: number },
  size: { width: number; height: number },
  { pinSize, gap, margin }: { pinSize: number; gap: number; margin: number },
): { left: number; top: number; side: PopoverSide } {
  const top = Math.max(Math.min(pin.top, view.height - margin - size.height), pin.top + pinSize - size.height, Math.min(pin.top, margin));
  const right = pin.left + pinSize + gap;
  if (right + size.width <= view.width - margin) return { left: right, top, side: "right" };
  const left = pin.left - gap - size.width;
  if (left >= margin) return { left, top, side: "left" };
  const below = belowPlace({ top: pin.top, bottom: pin.top + pinSize, right: pin.left + pinSize / 2 }, view, size, { gap, margin });
  return { ...below, side: "below" };
}

/**
 * The pins of one surface (their anchors, in reading order: lib/commentDom.ts `pinAnchors`) that take the focus, in
 * order of preference, when the pin `removed` leaves it: the ones after it, nearest first, then the ones before it,
 * nearest first. Not just the two next to it: one of them can be missing (a pin not drawn), and `firstPin` takes the
 * first that is there. Empty when nothing else is there; the caller then falls back (the pane's composer).
 */
export function focusAfter(anchors: readonly string[], removed: string): string[] {
  const at = anchors.indexOf(removed);
  if (at < 0) return [];
  return [...anchors.slice(at + 1), ...anchors.slice(0, at).reverse()];
}
