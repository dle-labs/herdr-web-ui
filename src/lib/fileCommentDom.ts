/**
 * The file viewer's side of a comment: it turns text selected in its line elements (an element
 * carrying `data-source-line`, and `data-source-end` when it covers several source lines: a code
 * line, a block or a table row of the preview) into what `fileComments.ts` stores, and back into
 * DOM ranges to highlight. A line element's text is `lineQuoteText`: what the quote shows, a table
 * row's cells set off by `" | "`. A selection is kept as columns in that text, so the same columns
 * find the selection again in a fresh render. The line elements do not nest. The first helpers
 * are pure; the rest needs a DOM.
 */
import { outsideMath, textUnits, type Separator } from "./commentSelection.ts";
import type { FileSelection, LineRange } from "./fileComments.ts";

const LINE = "[data-source-line]";
const CELL_SEPARATOR = " | ";

type Units = readonly (string | Separator)[];

const lengthOf = (unit: string | Separator): number => typeof unit === "string" ? unit.length : unit.sep.length;

const isSeparator = (unit: object | string): unit is Separator => typeof unit === "object" && "sep" in unit;

/**
 * A line element's units without the separators at its ends: `textUnits` sets off a table row's
 * first cell, and a preview's paragraph line ends in the `<br>` that breaks it. They separate
 * nothing there, so a quote neither starts nor ends with one, and a column counts from the text.
 */
export function trimSeparators<T extends object | string>(units: readonly (T | Separator)[]): (T | Separator)[] {
  let from = 0;
  let to = units.length;
  while (from < to && isSeparator(units[from]!)) from++;
  while (to > from && isSeparator(units[to - 1]!)) to--;
  return units.slice(from, to);
}

/** A line element's text units (`textUnits`), cells set off by `" | "`, without separators at its ends. */
function lineUnits(element: Element): (Text | Separator)[] {
  return trimSeparators(textUnits(element, CELL_SEPARATOR));
}

/** A line element's text: its text units with the separators between them, which count as characters of a column. */
export function unitsText(units: Units): string {
  return units.map((unit) => typeof unit === "string" ? unit : unit.sep).join("");
}

/** The column of `offset` characters into `units[unit]`: the length of everything before it, separators included. */
export function unitsColumn(units: Units, unit: number, offset: number): number {
  let column = offset;
  for (let i = 0; i < unit && i < units.length; i++) column += lengthOf(units[i]!);
  return column;
}

/**
 * The text unit and the offset in it that `column` stands for. A column inside a separator is no
 * place in a text node: a start moves on to the next text unit, an end back to the previous one.
 * Between two text units a start belongs to the later, an end to the earlier. Null where no text
 * unit is left to move to, or past the text.
 */
export function columnUnit(units: Units, column: number, asEnd: boolean): { unit: number; offset: number } | null {
  let at = 0;
  let previous: { unit: number; offset: number } | null = null;
  let candidate: { unit: number; offset: number } | null = null;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (typeof unit === "string") {
      if (column >= at && column <= at + unit.length) {
        const hit = { unit: i, offset: column - at };
        if (asEnd) return hit;
        candidate = hit;
      } else if (candidate !== null) return candidate;
      else if (column < at) return asEnd ? previous : { unit: i, offset: 0 };
      else previous = { unit: i, offset: unit.length };
    }
    at += lengthOf(unit);
  }
  return candidate ?? (asEnd && column <= at ? previous : null);
}

/** The source lines a line element covers (`data-source-line` to `data-source-end`, else that one). */
export function lineSpan(element: Element): LineRange {
  const first = Number(element.getAttribute("data-source-line"));
  const last = Number(element.getAttribute("data-source-end") ?? first);
  return [first, Math.max(first, last)];
}

/** Every line element of `root` in document order. */
function lineElements(root: Element): Element[] {
  return [...root.querySelectorAll(LINE)];
}

/**
 * The line elements a click on `target` comments on, in document order; none outside `root`'s line elements. A code
 * line, a heading, a list item's text, a table row or a formula is its own line element. A preview paragraph is one
 * block, though each of its source lines is a line element of its own (a `<span>` each): a click on one of its lines,
 * or beside them in the paragraph, takes all of them. DOM-light: reads only `closest`, `contains`, `children` and
 * `matches`.
 */
export function clickedLineElements(root: Element, target: Element): Element[] {
  const line = target.closest(LINE);
  const paragraph = (line ?? target).closest("p");
  if (paragraph !== null && root.contains(paragraph) && (line === null || line.parentElement === paragraph)) {
    const lines = [...paragraph.children].filter((child) => child.matches(LINE));
    if (lines.length > 0) return lines;
  }
  return line !== null && root.contains(line) ? [line] : [];
}

/** The line element of `root` that `target` lies in (a paragraph's lines together, `clickedLineElements`), with its lines and its quote; null outside one. */
export function clickedLines(root: Element, target: Element): { lines: LineRange; quoteLines: string[] } | null {
  const elements = clickedLineElements(root, target);
  if (elements.length === 0) return null;
  return { lines: [lineSpan(elements[0]!)[0], lineSpan(elements[elements.length - 1]!)[1]], quoteLines: elements.map(lineQuoteText) };
}

/** A folded code block's "Show all" button in the preview (Markdown.tsx), which names the block's last source line. */
const FOLDED = ".markdown-code-more[aria-expanded='false'][data-fold-end]";

/**
 * Unfolds the folded preview code block holding source line `line` (its first drawn `.hl-line` to its
 * `data-fold-end`), by its "Show all" button: a line folded away cannot be highlighted, pinned or scrolled to. True
 * when that line is drawn already (no folded block holds it, or it is in the block's head), false when it was folded
 * and the block is unfolding. DOM-light: reads only `querySelectorAll`, `closest`, `querySelector` and attributes.
 */
export function unfoldAt(root: Element, line: number): boolean {
  for (const more of root.querySelectorAll<HTMLElement>(FOLDED)) {
    const block = more.closest(".markdown-code");
    const first = Number(block?.querySelector(".hl-line[data-source-line]")?.getAttribute("data-source-line"));
    const end = Number(more.getAttribute("data-fold-end"));
    if (block === null || !Number.isFinite(first) || !(first <= line && line <= end)) continue;
    if (block.querySelector(`.hl-line[data-source-line="${line}"]`) !== null) return true;
    more.click();
    return false;
  }
  return true;
}

/** The line elements of `root` whose lines meet `lines`, in document order. */
export function lineElementsIn(root: Element, lines: LineRange): Element[] {
  return lineElements(root).filter((element) => {
    const [first, last] = lineSpan(element);
    return first <= lines[1] && last >= lines[0];
  });
}

/**
 * A lookup of the `items` (in document order, each covering the lines `spanOf` gives) that meet a
 * range of lines, in that order. Built once for many ranges: a lookup costs the lines it asks for,
 * not a pass over every item. An item without a finite span is never found.
 */
export function lineLookup<T>(items: readonly T[], spanOf: (item: T) => LineRange): (lines: LineRange) => T[] {
  const byLine = new Map<number, number[]>();
  let lowest = Infinity;
  let highest = -Infinity;
  items.forEach((item, index) => {
    const [first, last] = spanOf(item);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
    for (let line = first; line <= last; line++) {
      const at = byLine.get(line);
      if (at === undefined) byLine.set(line, [index]);
      else at.push(index);
    }
    lowest = Math.min(lowest, first);
    highest = Math.max(highest, last);
  });
  return ([from, to]) => {
    const found = new Set<number>();
    for (let line = Math.max(from, lowest); line <= Math.min(to, highest); line++) {
      for (const index of byLine.get(line) ?? []) found.add(index);
    }
    return [...found].sort((a, b) => a - b).map((index) => items[index]!);
  };
}

/**
 * `lineElementsIn` for many ranges of one render: the line elements of `root` are read once, so a
 * highlight rebuild on a long file does not query and filter all of its lines per comment.
 */
export function lineElementIndex(root: Element): (lines: LineRange) => Element[] {
  return lineLookup(lineElements(root), lineSpan);
}

const textOf = (units: readonly (Text | Separator)[]): (string | Separator)[] => units.map((unit) => unit instanceof Text ? unit.data : unit);

/** What a line element reads as in a quote: its own text, its cells set off by `" | "` (`lineUnits`). */
export function lineQuoteText(element: Element): string {
  return unitsText(textOf(lineUnits(element)));
}

/**
 * The column in the text of `units` that the boundary point (`container`, `offset`) stands for.
 * A separator before the point counts only once a text node past it is behind the point too, so a
 * point right after a text node is not pushed over the separator that follows it.
 */
function pointColumn(units: readonly (Text | Separator)[], container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  let column = 0;
  let pending = 0;
  for (const unit of units) {
    if (!(unit instanceof Text)) { pending += unit.sep.length; continue; }
    if (unit === container) return column + pending + Math.min(offset, unit.length);
    if (point.comparePoint(unit, unit.length) > 0) break;
    column += pending + unit.length;
    pending = 0;
  }
  return column;
}

/** Which line element an end of a selection belongs to, and where in it (null: the element's own start or end). */
interface Edge { index: number; point: [Node, number] | null }

/**
 * The line element a selection's start (or its end) lies in. A point between lines or past them
 * (the "\n" between a code block's lines, the padding around them) belongs to the nearest line
 * element on the selection's side, when nothing but blanks lies between; text of anything else
 * there (a heading) makes it null.
 */
function edgeOf(range: Range, elements: readonly Element[], asEnd: boolean): Edge | null {
  const container = asEnd ? range.endContainer : range.startContainer;
  const offset = asEnd ? range.endOffset : range.startOffset;
  const inside = elements.findIndex((element) => element.contains(container));
  if (inside >= 0) return { index: inside, point: outsideMath(container, offset, asEnd) };
  let nearest = -1;
  elements.forEach((element, index) => {
    if (range.intersectsNode(element) && (asEnd || nearest < 0)) nearest = index;
  });
  if (nearest < 0) return null;
  const element = elements[nearest]!;
  const gap = document.createRange();
  if (asEnd) { gap.setStart(element, element.childNodes.length); gap.setEnd(container, offset); }
  else { gap.setStart(container, offset); gap.setEnd(element, 0); }
  return gap.toString().trim() === "" ? { index: nearest, point: null } : null;
}

/**
 * The comment the current selection makes in `root`, or null: it is not collapsed, both ends lie
 * in line elements of `root` (or in blanks right next to them, `edgeOf`) and some of what it covers
 * is not blank. Line elements the selection covers only with blanks are left out at both ends, so
 * a selection that ends at the start of the next line (a triple click) belongs to the line before.
 * `selection`'s indexes count the measured line elements (0 = the first), its columns count the
 * text of `lineQuoteText`, which `quoteLines` holds for each of them.
 */
export function measureFileSelection(selection: Selection | null, root: Element): {
  lines: LineRange;
  quoteLines: string[];
  selection: FileSelection;
} | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const first = selection.getRangeAt(0);
  const last = selection.getRangeAt(selection.rangeCount - 1);
  const range = document.createRange();
  range.setStart(first.startContainer, first.startOffset);
  range.setEnd(last.endContainer, last.endOffset);
  const elements = lineElements(root);
  const from = edgeOf(range, elements, false);
  const to = edgeOf(range, elements, true);
  if (from === null || to === null || from.index > to.index) return null;
  const covered = elements.slice(from.index, to.index + 1);
  const units = covered.map(lineUnits);
  const texts = units.map((line) => unitsText(textOf(line)));
  const cuts = covered.map((_, i): [number, number] => [
    i === 0 && from.point !== null ? pointColumn(units[i]!, ...from.point) : 0,
    i === covered.length - 1 && to.point !== null ? pointColumn(units[i]!, ...to.point) : texts[i]!.length,
  ]);
  const picked = texts.map((text, i) => text.slice(...cuts[i]!));
  const firstLine = picked.findIndex((text) => text.trim() !== "");
  if (firstLine < 0) return null;
  let lastLine = picked.length - 1;
  while (picked[lastLine]!.trim() === "") lastLine--;
  const kept = covered.slice(firstLine, lastLine + 1);
  const lines: LineRange = [lineSpan(kept[0]!)[0], lineSpan(kept[kept.length - 1]!)[1]];
  const start: [number, number] = [0, cuts[firstLine]![0]];
  const end: [number, number] = [lastLine - firstLine, cuts[lastLine]![1]];
  const text = picked.slice(firstLine, lastLine + 1).join("\n");
  return {
    lines,
    quoteLines: texts.slice(firstLine, lastLine + 1),
    selection: { text, start, end },
  };
}

/**
 * The ranges that show a comment on the line `elements` its lines meet, in document order
 * (`lineElementIndex`): one per line element with text, over all of its text, or over the part
 * `selection` covers (its indexes count those elements, as at measuring). A column that no longer
 * fits the text gives no range. A boundary in a formula moves out to take it whole.
 */
export function lineRanges(elements: readonly Element[], selection: FileSelection | undefined): Range[] {
  const ranges: Range[] = [];
  elements.forEach((element, index) => {
    const units = lineUnits(element);
    const text = textOf(units);
    let from = 0;
    let to = unitsText(text).length;
    if (selection !== undefined) {
      if (index < selection.start[0] || index > selection.end[0]) return;
      if (index === selection.start[0]) from = selection.start[1];
      if (index === selection.end[0]) to = selection.end[1];
    }
    const startAt = columnUnit(text, from, false);
    const endAt = columnUnit(text, to, true);
    if (startAt === null || endAt === null) return;
    const [startNode, startOffset] = outsideMath(units[startAt.unit] as Text, startAt.offset, false);
    const [endNode, endOffset] = outsideMath(units[endAt.unit] as Text, endAt.offset, true);
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    if (!range.collapsed) ranges.push(range);
  });
  return ranges;
}
