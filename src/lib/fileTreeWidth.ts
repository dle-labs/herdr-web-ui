/** The Files tree column's width and whether it is collapsed: per device, like the file panel's. */
const WIDTH_KEY = "ovis:file-tree-width";
const COLLAPSED_KEY = "ovis:file-tree-collapsed";

export const FILE_TREE_MIN_WIDTH = 140;
/** what the file or diff beside the tree always keeps */
export const FILE_TREE_DETAIL_MIN_WIDTH = 240;
/** a drag that ends this narrow collapses the tree instead of sizing it */
export const FILE_TREE_COLLAPSE_WIDTH = 72;
/** one arrow key press on the focused edge */
export const FILE_TREE_WIDTH_STEP = 16;

/** The widest the tree may be in a layout this wide: the detail keeps its minimum, even below the tree's own. */
export function fileTreeMaxWidth(layoutWidth: number): number {
  return Math.max(FILE_TREE_MIN_WIDTH, Math.floor(layoutWidth - FILE_TREE_DETAIL_MIN_WIDTH));
}

export function clampFileTreeWidth(width: number, layoutWidth = Number.POSITIVE_INFINITY): number {
  return Math.round(Math.min(fileTreeMaxWidth(layoutWidth), Math.max(FILE_TREE_MIN_WIDTH, width)));
}

/** Where a key moves the edge from `current`; the edge is the tree's right one, so ArrowRight widens. Null for a key that is not the edge's. */
export function keyedFileTreeWidth(current: number, key: string, layoutWidth = Number.POSITIVE_INFINITY): number | null {
  if (key === "ArrowRight") return clampFileTreeWidth(current + FILE_TREE_WIDTH_STEP, layoutWidth);
  if (key === "ArrowLeft") return clampFileTreeWidth(current - FILE_TREE_WIDTH_STEP, layoutWidth);
  if (key === "Home") return clampFileTreeWidth(FILE_TREE_MIN_WIDTH, layoutWidth);
  if (key === "End") return fileTreeMaxWidth(layoutWidth);
  return null;
}

/** The stored value as a width, or null when nothing usable is stored (the default width applies). */
export function parseFileTreeWidth(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  return clampFileTreeWidth(Number(stored));
}

export function storedFileTreeWidth(): number | null {
  try {
    return parseFileTreeWidth(window.localStorage.getItem(WIDTH_KEY));
  } catch {
    return null;
  }
}

/** null forgets the choice: the tree goes back to its default width. */
export function storeFileTreeWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(WIDTH_KEY);
    else window.localStorage.setItem(WIDTH_KEY, String(clampFileTreeWidth(width)));
  } catch {
    /* private mode: the width simply is not remembered */
  }
}

export function storedFileTreeCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeFileTreeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, "1");
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* private mode: the tree opens expanded next time */
  }
}
