import type { Locator } from "playwright-core";

/** The editor is inside the visible surface and leaves every visible line of its source uncovered. */
export function commentClearOfSource(surface: Locator): Promise<boolean> {
  return surface.evaluate((node) => {
    const layout = node.closest(".comment-surface-layout") ?? node;
    const editor = layout.querySelector(".comment-popover");
    if (editor === null) return false;
    const box = editor.getBoundingClientRect();
    const outer = node.getBoundingClientRect();
    const available = layout.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || box.left < available.left - 1 || box.right > available.right + 1
      || box.top < available.top - 1 || box.bottom > available.bottom + 1) return false;
    const highlights = (CSS as unknown as { highlights?: { get(name: string): Iterable<AbstractRange> | undefined } }).highlights;
    const here = (range: AbstractRange): range is Range => range instanceof Range && node.contains(range.commonAncestorContainer);
    const pending = [...(highlights?.get("block-comment-pending") ?? [])].filter(here);
    const active = [...(highlights?.get("block-comment-active") ?? [])].filter(here);
    const ranges = pending.length > 0 ? pending : active;
    if (ranges.length === 0) return false;
    return ranges.every((range) => {
      let clip = { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom };
      // A code block may clip text sideways inside the surface; hidden text is not an obstacle.
      let ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      while (ancestor && ancestor !== node) {
        const style = getComputedStyle(ancestor);
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          const inner = ancestor.getBoundingClientRect();
          clip = { ...clip, left: Math.max(clip.left, inner.left), right: Math.min(clip.right, inner.right) };
        }
        ancestor = ancestor.parentElement;
      }
      return [...range.getClientRects()].every((rect) => {
        const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
        const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
        return right <= left || bottom <= top || box.left >= right - 1 || box.right <= left + 1 || box.top >= bottom - 1 || box.bottom <= top + 1;
      });
    });
  });
}
