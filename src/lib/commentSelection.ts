/**
 * Measuring a comment surface's text, and where the focus goes around a comment. A comment in the chat starts from a
 * block of an agent's final reply that was clicked, or from text a mouse dragged over in it: the commentable parts on
 * screen (`rememberCommentPart`, `commentPartOf`), and a selection measured in a part's own text (`selectionComment`,
 * the offsets `selectionTarget` keeps and the highlight maps back to text nodes with `textRange`). For either surface
 * (the chat, the file viewer) the text a comment covers on screen (`textRects`, `textBox`) and the point on it its pin
 * keeps (`pointOnText`). Then the focus: the pane's composer (`paneComposer`) and what a closing popover gives the
 * focus back to (`restoreFocusTarget`). Everything but `sliceText`, `spanText` and `restoreFocusTarget` needs a DOM.
 *
 * The comment UI's own markup (popover, pins) is queried through lib/commentDom.ts, and the pins' and the popover's
 * geometry is lib/commentPins.ts.
 */
import type { CommentTarget, PartLookup } from "./blockComments.ts";
import { PINS_SELECTOR } from "./commentDom.ts";
import { pointIn, unionBox, type CommentPoint, type PinBox } from "./commentPins.ts";

/** A rendered part that can carry comments: its pane, its target, and the parts of its reply (`replyParts`). */
export interface CommentPart {
  owner: string;
  target: CommentTarget;
  parts: PartLookup;
}

/** The commentable parts on screen, by element: Markdown.tsx adds one while it is mounted and commentable. */
const parts = new WeakMap<Element, CommentPart>();

export function rememberCommentPart(element: Element, part: CommentPart): void { parts.set(element, part); }
export function forgetCommentPart(element: Element): void { parts.delete(element); }
export function commentPartOf(element: Element): CommentPart | undefined { return parts.get(element); }

/** Never text of a reply, neither counted nor seen as selected: the pin layer, controls, a code block's header. */
const NOT_TEXT = `${PINS_SELECTOR}, .markdown-code-header, button:not(.markdown-file)`;

/**
 * Not a part's own text (`NOT_TEXT`): its pins, its controls (a file path is a button but reads as the
 * text it replaced), a code block's header, anything hidden from assistive technology. KaTeX draws
 * its formula twice, as MathML and as glyphs (aria-hidden): of a formula only its TeX source counts.
 */
const SKIPPED = `${NOT_TEXT}, [aria-hidden='true']`;
/** Elements that start a new line in the quote; a table cell is set off by the caller's separator (`textUnits`). */
const BLOCK = /^(?:P|DIV|LI|UL|OL|TR|TABLE|PRE|BLOCKQUOTE|H[1-6])$/;

/** A break between two pieces of text: it is not a character of the part's text, only of its quote. */
export interface Separator { sep: string }

/**
 * An element's own text nodes in document order (`SKIPPED` left out), with the breaks between its
 * lines, rows and cells: a line break for a block or a `<br>`, `cellSeparator` before a table cell.
 * A reply part's cells are set off by a space; a surface whose quote keeps a table's columns apart
 * (the file viewer's preview) passes its own.
 */
export function textUnits(element: Element, cellSeparator: string): (Text | Separator)[] {
  const units: (Text | Separator)[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node instanceof Element) return node.matches(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      const parent = node.parentElement;
      return parent?.closest(".katex") && !parent.closest("annotation") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text) units.push(node);
    else if (node.nodeName === "BR") units.push({ sep: "\n" });
    else if (node.nodeName === "TD" || node.nodeName === "TH") units.push({ sep: cellSeparator });
    else if (BLOCK.test(node.nodeName)) units.push({ sep: "\n" });
  }
  return units;
}

/** A reply part's own text units (`textUnits`), a table cell set off by a space. */
function partUnits(part: Element): (Text | Separator)[] {
  return textUnits(part, " ");
}

/**
 * The text nodes of a part's own content, in document order: what a selection's offsets count.
 * The lengths of these nodes are what `textRange` takes to map offsets back to a DOM range.
 */
export function partTextNodes(part: Element): Text[] {
  return partUnits(part).filter((unit): unit is Text => unit instanceof Text);
}

/**
 * The characters `start`–`end` of text units (`string`s, counted) and separators (not counted):
 * a separator shows only between two selected characters, never twice in a row, and a line break
 * takes the place of a space before it.
 */
export function sliceText(units: readonly (string | Separator)[], start: number, end: number): string {
  let out = "";
  let at = 0;
  for (const unit of units) {
    if (typeof unit === "string") {
      const from = Math.max(start - at, 0);
      const to = Math.min(end - at, unit.length);
      if (to > from) out += unit.slice(from, to);
      at += unit.length;
      if (at >= end) break;
    } else if (out !== "" && at > start && at < end) {
      if (unit.sep === "\n") { if (!out.endsWith("\n")) out = `${out.replace(/ +$/, "")}\n`; }
      else if (!/\s$/.test(out)) out += unit.sep;
    }
  }
  return out;
}

/** A part a selection runs over: its text units (`partUnits`, text as strings) and the selection's offsets in its text. */
export interface PartSlice {
  units: readonly (string | Separator)[];
  start: number;
  end: number;
}

/**
 * Of the parts a selection runs over, in document order, the first and the last whose selected
 * text is not blank (indexes into `slices`), and the quote: the selected text of each part from
 * the first to the last, its trailing spaces dropped, a line break between two parts, a blank one
 * left out. Null when nothing but blanks is selected.
 */
export function spanText(slices: readonly PartSlice[]): { first: number; last: number; text: string } | null {
  let first = -1;
  let last = -1;
  const texts: string[] = [];
  slices.forEach((slice, index) => {
    const text = sliceText(slice.units, slice.start, slice.end);
    if (text.trim() === "") return;
    if (first < 0) first = index;
    last = index;
    texts.push(text.replace(/[ \t]+$/, ""));
  });
  return first < 0 ? null : { first, last, text: texts.join("\n") };
}

/** Where a boundary point lies in the text of `nodes`: the characters of the nodes before it. */
function offsetIn(nodes: readonly Text[], container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  let total = 0;
  for (const node of nodes) {
    if (node === container) return total + Math.min(offset, node.length);
    if (point.comparePoint(node, node.length) > 0) break;
    total += node.length;
  }
  return total;
}

/**
 * A boundary inside a formula moves to its edge (before it for a start, after it for an end): a
 * formula is quoted whole, and highlighted whole (its glyphs, not only its hidden MathML).
 */
export function outsideMath(container: Node, offset: number, after: boolean): [Node, number] {
  const element = container instanceof Element ? container : container.parentElement;
  const math = element?.closest(".katex");
  const parent = math?.parentNode;
  if (!math || !parent) return [container, offset];
  const index = Array.prototype.indexOf.call(parent.childNodes, math);
  return [parent, after ? index + 1 : index];
}

/** What a selection in a chat view can be commented as: the part it starts in, and where it ends when it runs on. */
export interface SelectionComment extends CommentPart {
  /** the selected text of all the parts it covers, its lines kept, a line break between parts (`spanText`) */
  text: string;
  /** offsets in the first part's text (`partTextNodes`); `end` stops at the part's end */
  start: number;
  end: number;
  /** a selection over several parts: the last part with selected text, and the offset in its text where it ends */
  until?: CommentPart & { end: number };
}

/**
 * The comment the current selection makes in `view`, or null. It qualifies when it is not
 * collapsed, both ends lie in one reply part's root (`[data-comment-root]`, a final answer), and
 * it selects text that is not blank in a commentable part. It starts in the first such part and,
 * when it runs on over later ones, ends in the last (`until`): an end on a rule, or at the very
 * start of a part (a triple click), belongs to the part before. An end just past the root with
 * nothing selected out there (a triple click on a reply's last paragraph ends at the start of
 * what follows) counts as the root's end.
 */
export function selectionComment(selection: Selection | null, view: Element): SelectionComment | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const first = selection.getRangeAt(0);
  const last = selection.getRangeAt(selection.rangeCount - 1);
  const range = document.createRange();
  range.setStart(first.startContainer, first.startOffset);
  range.setEnd(last.endContainer, last.endOffset);
  const root = elementOf(range.startContainer)?.closest("[data-comment-root]");
  if (!root || !view.contains(root)) return null;
  if (elementOf(range.endContainer)?.closest("[data-comment-root]") !== root) {
    const outside = document.createRange();
    outside.setStart(root, root.childNodes.length);
    outside.setEnd(range.endContainer, range.endOffset);
    if (outside.collapsed || outside.toString().trim() !== "") return null;
    range.setEnd(root, root.childNodes.length);
  }
  // the parts the selection reaches into, in document order (no part holds another), measured in their own text
  const from = outsideMath(range.startContainer, range.startOffset, false);
  const to = outsideMath(range.endContainer, range.endOffset, true);
  const parts: CommentPart[] = [];
  const slices: PartSlice[] = [];
  for (const element of root.querySelectorAll(".is-commentable")) {
    const found = range.intersectsNode(element) ? commentPartOf(element) : undefined;
    if (found === undefined) continue;
    const units = partUnits(element);
    const nodes = units.filter((unit): unit is Text => unit instanceof Text);
    parts.push(found);
    slices.push({
      units: units.map((unit) => unit instanceof Text ? unit.data : unit),
      start: offsetIn(nodes, ...from),
      end: offsetIn(nodes, ...to),
    });
  }
  const span = spanText(slices);
  if (span === null) return null;
  const { start, end } = slices[span.first]!;
  const until = span.last === span.first
    ? {}
    : { until: { ...parts[span.last]!, end: slices[span.last]!.end } };
  return { ...parts[span.first]!, text: span.text, start, end, ...until };
}

/**
 * Not where a selection shows: as `SKIPPED`, but a formula counts by the glyphs on screen
 * (aria-hidden), not by its MathML, which is there only for assistive technology.
 */
const UNSEEN = `${NOT_TEXT}, .katex-mathml`;

/**
 * The lines of text `range` selects on screen, in document order: the client rects of each text
 * node in it, clipped to its ends, without pins, controls and a code block's header. Not a whole
 * element's box: a part selected whole would be one tall rect around its lines, and the gap
 * between two parts no line.
 */
export function textRects(range: Range): DOMRect[] {
  const container = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (container instanceof Text) nodes.push(container);
  else {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Text && range.intersectsNode(node)) nodes.push(node);
    }
  }
  const rects: DOMRect[] = [];
  for (const node of nodes) {
    if (node.parentElement?.closest(UNSEEN)) continue;
    const piece = document.createRange();
    piece.selectNodeContents(node);
    if (node === range.startContainer) piece.setStart(node, range.startOffset);
    if (node === range.endContainer) piece.setEnd(node, range.endOffset);
    for (const rect of piece.getClientRects()) if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

/**
 * The box around the text `ranges` show on screen (`textRects` of each, `unionBox`), in client pixels: what a comment's
 * `CommentPoint` is a fraction of. Undefined where none of it is drawn.
 */
export function textBox(ranges: readonly Range[]): PinBox | undefined {
  return unionBox(ranges.flatMap(textRects));
}

/**
 * Where the client point `at` lies on the text `ranges` show (`textBox`, `pointIn`): the point a comment made there keeps
 * for its pin. Undefined where none of that text is drawn.
 */
export function pointOnText(ranges: readonly Range[], at: { x: number; y: number }): CommentPoint | undefined {
  const box = textBox(ranges);
  return box === undefined ? undefined : pointIn(box, at);
}

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** The composer's field of the pane a chat view is in; null without one. */
export function paneComposer(view: Element | null): HTMLElement | null {
  return view?.closest(".terminal-stack")?.querySelector<HTMLElement>(".composer-text") ?? null;
}

/**
 * What a closing comment popover gives the focus back to: its opener while that is still in the
 * document, else `fallback` (a deleted comment takes its own pin, the opener, with it). A dialog
 * focuses whatever that is; a popover beside its pin (`inline`) only an element that is in the
 * document, so it leaves the focus where it is otherwise. On a touch screen (`coarse`) the fallback is a composer's
 * field, and focusing it raises the keyboard unasked: the focus is only let go (null).
 */
export function restoreFocusTarget<T extends { isConnected: boolean }>(opener: T | null, fallback: T | null, inline: boolean, coarse = false): T | null {
  const to = opener?.isConnected ? opener : fallback;
  if (coarse && to === fallback) return null;
  return !inline || to?.isConnected ? to : null;
}
