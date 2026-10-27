import type { DiffFindMatch } from "./repoDiffFind.ts";
type DiffMark = Pick<DiffFindMatch, "side" | "line" | "start" | "end">;

/** The mounted row of a logical line: split draws each side in its own column; unified draws a deletion by its old number, the rest by their new one. */
export function markRow(shadow: ShadowRoot, mark: DiffMark): HTMLElement | null {
  const split = shadow.querySelector("pre")?.getAttribute("data-diff-type") === "split";
  if (split) return shadow.querySelector<HTMLElement>(`code[data-${mark.side === "old" ? "deletions" : "additions"}] [data-line="${mark.line}"]`);
  return shadow.querySelector<HTMLElement>(mark.side === "old"
    ? `[data-line="${mark.line}"][data-line-type="change-deletion"]`
    : `[data-line="${mark.line}"]:not([data-line-type="change-deletion"])`);
}

/** The range of columns `start`..`end` of a row's text, across the token spans it is drawn in. */
export function textRange(row: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) { range.setStart(node, start - offset); started = true; }
    if (started && end <= offset + length) { range.setEnd(node, end - offset); return range; }
    offset += length;
  }
  return null;
}

/**
 * Brings a match's columns into view in its row's horizontal scroller (unwrapped rows; in split, its
 * side's column), centred beside the sticky line numbers; a match already in view stays put.
 */
export function revealColumns(row: HTMLElement, mark: DiffMark): void {
  const scroller = row.closest<HTMLElement>("[data-code]");
  if (scroller === null || scroller.scrollWidth <= scroller.clientWidth + 1) return;
  const range = textRange(row, mark.start, mark.end);
  if (range === null) return;
  const match = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const left = Math.max(box.left, scroller.querySelector("[data-gutter]")?.getBoundingClientRect().right ?? box.left);
  const right = box.left + scroller.clientWidth;
  if (match.left >= left && match.right <= right) return;
  scroller.scrollLeft += (match.left + match.right) / 2 - (left + right) / 2;
}
