/**
 * The comments on a file shown in the file viewer, highlighted with the same CSS Custom Highlight
 * API highlights the chat uses (`commentHighlight.ts`): a selection's text, a comment on whole lines
 * all of their text; over them the comment whose pin the pointer or the focus is on, or whose popover is open, and over that
 * the one the composer's walk stands on. A comment on whole lines also marks each of its `.hl-line`s
 * `is-commented`, for the code view's own line styling. The viewer is a comment surface of its own
 * (`SurfaceMarks`, `watchSurface`), so the pins bring their text up as in the chat. Needs a DOM.
 */
import { SurfaceMarks, watchSurface } from "./commentHighlight.ts";
import { lineElementIndex, lineRanges } from "./fileCommentDom.ts";
import type { FileSelection, LineRange } from "./fileComments.ts";

/** A comment to show: its lines, and the selection it is on (none: all of its lines). */
export interface ShownFileComment {
  id: string;
  lines: LineRange;
  selection?: FileSelection;
}

const sameRange = (a: Range, b: Range): boolean =>
  a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;

/** `fresh` with each range swapped for the one at its place in `held` whose boundaries did not move: the shared highlights then touch only what changed. */
function reuse(held: readonly Range[] | undefined, fresh: Range[]): Range[] {
  if (held === undefined) return fresh;
  return fresh.map((range, index) => {
    const before = held[index];
    return before !== undefined && sameRange(before, range) ? before : range;
  });
}

/** Which text of the file's lines each comment covers, published to the viewer's `SurfaceMarks`. */
class FileHighlights {
  private comments: readonly ShownFileComment[] = [];
  private pending: ShownFileComment | null = null;
  /** the `.hl-line`s marked `is-commented` */
  private marked = new Set<Element>();

  constructor(private marks: SurfaceMarks, private content: Element) {}

  setComments(comments: readonly ShownFileComment[]): void { this.comments = comments; }
  setPending(pending: ShownFileComment | null): void { this.pending = pending; }

  rebuild(): void {
    const next = new Map<string, Range[]>();
    const whole = new Set<Element>();
    // the line elements are read once per rebuild, not once per comment: a long file has tens of thousands of them
    const elementsOn = lineElementIndex(this.content);
    for (const { id, lines, selection } of this.comments) {
      const elements = elementsOn(lines);
      next.set(id, reuse(this.marks.comments.get(id), lineRanges(elements, selection)));
      if (selection !== undefined) continue;
      for (const element of elements) if (element.classList.contains("hl-line")) whole.add(element);
    }
    for (const element of this.marked) if (!whole.has(element)) element.classList.remove("is-commented");
    for (const element of whole) element.classList.add("is-commented");
    this.marked = whole;
    const pending = this.pending === null ? null : reuse(this.marks.pending ?? undefined, lineRanges(elementsOn(this.pending.lines), this.pending.selection));
    this.marks.publish(next, pending);
  }

  dispose(): void {
    for (const element of this.marked) element.classList.remove("is-commented");
    this.marked.clear();
  }
}

/**
 * Shows the comments `show` is given in `content` (the file's lines, inside `surface`, the element
 * carrying `data-comment-surface`) until `dispose` runs; `setPending` shows the one being written
 * (null: none) with the stronger tint. The ranges are rebuilt at most once per frame after a call
 * to either or a change in `content`'s DOM (a file reloaded, a preview
 * rendered again). A rewrap needs nothing: a range follows its text.
 */
export function watchFileCommentHighlights(surface: Element, content: Element): {
  show(comments: readonly ShownFileComment[]): void;
  setPending(comment: ShownFileComment | null): void;
  dispose(): void;
} {
  const marks = new SurfaceMarks(surface);
  const highlights = new FileHighlights(marks, content);
  // any change in the content can move or end a range: the pins are not in it (they lie in the surface's pin layer)
  const watching = watchSurface(marks, content, () => highlights.rebuild());
  return {
    show(comments) {
      highlights.setComments(comments);
      watching.schedule();
    },
    setPending(comment) {
      highlights.setPending(comment);
      watching.schedule();
    },
    dispose() {
      watching.dispose();
      highlights.dispose();
    },
  };
}
