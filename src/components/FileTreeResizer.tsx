import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import "./FileTreeResizer.css";

import { clampFileTreeWidth, fileTreeMaxWidth, FILE_TREE_COLLAPSE_WIDTH, FILE_TREE_MIN_WIDTH, keyedFileTreeWidth, storeFileTreeWidth } from "../lib/fileTreeWidth.ts";
import { useT } from "../lib/i18n.ts";

export interface FileTreeResizerProps {
  /** the chosen width in px; null is the default one */
  width: number | null;
  onResize(width: number | null): void;
  /** a drag that ends past the tree's minimum, or Enter: the tree folds to its expand button and keeps its width for then */
  onCollapse(): void;
}

/**
 * The Files tree column's right edge: drag it to resize, past the minimum to collapse, double-click to go back to
 * the default width. Drawn inside the tree column it sizes, which is the positioned parent, as FilePanelResizer is.
 */
export function FileTreeResizer({ width, onResize, onCollapse }: FileTreeResizerProps) {
  const t = useT();
  const drag = useRef<{ start: number | null; left: number; grip: number; layout: number; width: number; moved: boolean; collapse: boolean } | null>(null);
  const [dragging, setDragging] = useState<"resize" | "collapse" | null>(null);
  // the widest the layout allows, measured when the edge is pressed or focused
  const [limit, setLimit] = useState<number | undefined>(undefined);
  const column = (element: HTMLElement): DOMRect | undefined => element.parentElement?.getBoundingClientRect();
  const layoutWidth = (element: HTMLElement): number => element.parentElement?.parentElement?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
  const shown = (element: HTMLElement | null): number => Math.round((element && column(element)?.width) || width || FILE_TREE_MIN_WIDTH);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const rect = column(event.currentTarget);
    if (!rect) return;
    // no text selection in the file while the edge moves
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setLimit(fileTreeMaxWidth(layoutWidth(event.currentTarget)));
    drag.current = { start: width, left: rect.left, grip: rect.right - event.clientX, layout: layoutWidth(event.currentTarget), width: Math.round(rect.width), moved: false, collapse: false };
    setDragging("resize");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    // the column's left edge stays put, so the width is what lies between it and the grip
    const raw = event.clientX + state.grip - state.left;
    const collapse = raw < FILE_TREE_COLLAPSE_WIDTH;
    if (collapse !== state.collapse) { state.collapse = collapse; setDragging(collapse ? "collapse" : "resize"); }
    const next = clampFileTreeWidth(raw, state.layout);
    if (next === state.width) return;
    state.width = next;
    state.moved = true;
    onResize(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // dropped past the minimum: fold the tree and keep the width it had before this drag for when it comes back
    if (state.collapse && event.type === "pointerup") { onResize(state.start); onCollapse(); return; }
    // a press that moved nothing chooses no width
    if (state.moved) storeFileTreeWidth(state.width);
  };
  const reset = (): void => {
    storeFileTreeWidth(null);
    onResize(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter") { event.preventDefault(); onCollapse(); return; }
    const next = keyedFileTreeWidth(shown(event.currentTarget), event.key, layoutWidth(event.currentTarget));
    if (next === null) return;
    event.preventDefault();
    storeFileTreeWidth(next);
    onResize(next);
  };

  return (
    <div
      className={`file-tree-resizer${dragging ? " is-dragging" : ""}${dragging === "collapse" ? " is-collapsing" : ""}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("Resize file tree")}
      aria-valuemin={FILE_TREE_MIN_WIDTH}
      aria-valuemax={limit}
      aria-valuenow={width ?? undefined}
      title={t("Drag to resize · double-click to reset")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
      onFocus={(event) => setLimit(fileTreeMaxWidth(layoutWidth(event.currentTarget)))}
      onKeyDown={onKeyDown}
    />
  );
}
