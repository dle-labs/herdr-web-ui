/**
 * Text a mouse drags over on a comment surface (the chat's final replies, the file viewer) opens its comment as the
 * mouse lets go, as in Claude: there is no Comment button. The surface says what a selection makes (`measure`) and what
 * opening it does (`onComment`); this only follows the mouse.
 *
 * A drag is a press of the mouse's primary button that is one click (`mousedown`'s `detail` is 1: a double or triple
 * click selects a word or a line by itself, to copy it) and moves at least `DRAG_MIN_PX` before it lets go
 * (`isCommentDrag`). A selection
 * made otherwise (the keyboard, a touch screen's handles, a double or triple click) opens nothing: a click or a tap on a
 * block or line comments on all of it (`useCommentClick`), and that is the way on a touch screen. A selection inside a
 * comment's field is none: the popover is in the view, but its text is not the surface's. A drag that starts while a
 * popover is open closes it with its press and opens the new selection's comment as it lets go: selecting text is
 * asking for a comment on it. (A plain click outside an open popover only closes it, `useCommentClick`.) Where the
 * open one kept its typed text instead, its field holds the focus, and the drag opens nothing.
 */
import { useEffect, useRef, type RefObject } from "react";

import { isCommentDrag } from "../lib/commentClick.ts";

/**
 * Opens the comment on the text a mouse's drag selected in `view` (what `measure` finds in it, a frame after the
 * release, once the browser has settled the selection), at the client point it let go at: there the new comment's pin
 * goes. Only while `enabled` (comments are on and the surface takes them).
 */
export function useSelectionComment<T>({ view, enabled, measure, onComment }: {
  view: RefObject<HTMLElement>;
  enabled: boolean;
  measure: (selection: Selection | null, view: Element) => T | null;
  /** opens the comment on `found`, its pin at `at` (client pixels), where the drag let go */
  onComment: (found: T, at: { x: number; y: number }) => void;
}): void {
  // read when the mouse lets go: a surface's measure may be a new function every render
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const onCommentRef = useRef(onComment);
  onCommentRef.current = onComment;

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    // where the mouse's primary button went down, and its click count (`mousedown`'s detail: a pointer event has none)
    let down: { x: number; y: number; clicks: number } | null = null;
    const onPointerDown = (event: PointerEvent): void => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      down = event.pointerType === "mouse" && event.button === 0 ? { x: event.clientX, y: event.clientY, clicks: 0 } : null;
    };
    const onMouseDown = (event: MouseEvent): void => { if (down !== null && event.button === 0) down.clicks = event.detail; };
    const onPointerUp = (event: PointerEvent): void => {
      const from = down;
      down = null;
      const at = { x: event.clientX, y: event.clientY };
      if (from === null || !isCommentDrag(event.pointerType, from.clicks, from, at)) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const node = view.current;
        const field = document.activeElement;
        // a comment being written in the view: its field holds the focus, and a drag elsewhere makes no other one
        if (node === null || (field instanceof HTMLTextAreaElement && node.contains(field))) return;
        const found = measureRef.current(window.getSelection(), node);
        if (found !== null) onCommentRef.current(found, at);
      });
    };
    const onPointerCancel = (): void => { down = null; };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [view, enabled]);
}
