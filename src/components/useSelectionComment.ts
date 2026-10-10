/** Text selection offers a quick action; only explicit activation opens the comment editor. */
import { useEffect, useRef, useState, type RefObject } from "react";

import { isCommentUi } from "../lib/commentDom.ts";

export function useSelectionComment<T>({ view, enabled, measure, onComment }: {
  view: RefObject<HTMLElement>;
  enabled: boolean;
  measure: (selection: Selection | null, view: Element) => T | null;
  onComment: (found: T, at: { x: number; y: number }) => void;
}): {
  action: { at: { x: number; y: number }; left: number; top: number } | null;
  activate: () => void;
  dismiss: () => void;
} {
  const latest = useRef({ measure, onComment });
  latest.current = { measure, onComment };
  const [action, setAction] = useState<{ at: { x: number; y: number }; left: number; top: number } | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;
  const dismiss = (): void => { actionRef.current = null; setAction(null); };

  useEffect(() => {
    setAction(null);
    if (!enabled) return;
    let frame = 0;
    let pressing = false;
    let startedHere = false;
    let release: { x: number; y: number } | null = null;
    const clear = (): void => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      actionRef.current = null;
      setAction(null);
    };
    const update = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (pressing) return;
        const node = view.current;
        const selection = window.getSelection();
        const field = document.activeElement;
        const dialog = field?.closest("[aria-modal='true'], dialog[open]");
        if (!node || !selection || selection.isCollapsed || !selection.rangeCount
          || (dialog && !dialog.contains(node))
          || (field instanceof HTMLTextAreaElement && node.contains(field))) { clear(); return; }
        const found = latest.current.measure(selection, node);
        if (found === null) { clear(); return; }
        const rects = selection.getRangeAt(0).getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) { clear(); return; }
        const at = release ?? { x: rect.right, y: rect.bottom };
        setAction({ at,
          left: Math.max(8, Math.min(at.x, window.innerWidth - 112)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 48)),
        });
      });
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (isCommentUi(event.target)) return;
      pressing = true;
      startedHere = event.target instanceof Node && !!view.current?.contains(event.target);
      release = null;
      clear();
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (isCommentUi(event.target)) return;
      pressing = false;
      if (!startedHere) return;
      startedHere = false;
      release = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null;
      update();
    };
    const onPointerCancel = (): void => { pressing = false; clear(); };
    const onSelectionChange = (): void => { release = null; update(); };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // Own this Escape before the file viewer's bubbling listener can close the viewer.
      if (actionRef.current !== null) {
        event.preventDefault();
        event.stopPropagation();
      }
      clear();
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !view.current?.contains(event.target)) clear();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
      window.removeEventListener("blur", clear);
    };
  }, [view, enabled]);

  return {
    action: enabled ? action : null,
    activate: () => {
      const node = view.current;
      // Revalidate before activation: a changed selection must never comment on stale text.
      const found = node && latest.current.measure(window.getSelection(), node);
      if (enabled && action && found != null) latest.current.onComment(found, action.at);
      dismiss();
    },
    dismiss,
  };
}
