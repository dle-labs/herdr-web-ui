/**
 * A comment surface's one comment popover (the chat's, the file viewer's): which comment it edits,
 * and what its field holds. Opened by a pin, a block click or tap, or a mouse's drag over text: on the
 * comment there, its field filled with it, else on a new one, its field empty. Only one is open at a
 * time, and one whose text was changed keeps its place: another opening then does nothing, and its
 * caller gives the focus back to that field (useCommentSurface.tsx, lib/commentDom.ts `focusOpenField`). The surface says what a comment is on (`T`) and how one is kept (`persist`).
 * CommentPopover.tsx draws it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { blockComments, useBlockComments } from "../lib/blockComments.ts";
import { popoverChanged, popoverOutlived, popoverStart } from "../lib/commentPopover.ts";

/** The comment the popover is open on: kept as it was opened, so it outlives its text re-rendering or leaving. */
export interface OpenComment<T> {
  /** one per opening: another comment opened, or the same one opened again, is another popover */
  id: number;
  owner: string;
  target: T;
  /** the stored comment edited; null for a new one */
  commentId: string | null;
  initialComment: string;
  /** opened by a mouse's drag, for the text selected (not by a pin or a block click) */
  fromSelection: boolean;
}

export function useCommentPopover<T>({ persist, enabled }: {
  /** keeps the comment written on `target` of `owner`'s pane; "" deletes */
  persist: (owner: string, target: T, comment: string) => void;
  /** the setting: turning it off closes whatever is open */
  enabled: boolean;
}): {
  open: OpenComment<T> | null;
  /** opens `target`: on its existing comment, the field filled with it, else on a new one. False, changing nothing, while the open one is changed (`popoverChanged`): the caller then gives the focus back to its field (`focusOpenField`) */
  show: (owner: string, target: T, existing: { id: string; comment: string } | null, fromSelection?: boolean) => boolean;
  save: (comment: string) => void;
  remove: () => void;
  close: () => void;
  /** what the open field holds, kept across a redraw */
  text: { read: () => string; write: (value: string) => void };
} {
  const [open, setOpen] = useState<OpenComment<T> | null>(null);
  // read by the callbacks, which may run twice before a render (a press outside closes, its click opens)
  const openRef = useRef(open);
  const set = useCallback((next: OpenComment<T> | null): void => {
    openRef.current = next;
    setOpen(next);
  }, []);
  const opened = useRef(0);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // what the open field holds (CommentPopover's `onText`): changed, another opening does not take its place
  const fieldText = useRef("");
  const text = useMemo(() => ({
    read: (): string => fieldText.current,
    write: (value: string): void => { fieldText.current = value; },
  }), []);

  const close = useCallback((): void => {
    fieldText.current = "";
    set(null);
  }, [set]);

  const show = useCallback((owner: string, target: T, existing: { id: string; comment: string } | null, fromSelection = false): boolean => {
    if (!enabledRef.current) return false;
    if (popoverChanged(openRef.current, fieldText.current)) return false;
    const start = popoverStart(existing);
    fieldText.current = start.initialComment;
    set({ id: ++opened.current, owner, target, ...start, fromSelection });
    return true;
  }, [set]);

  const save = useCallback((comment: string): void => {
    const current = openRef.current;
    if (current === null) return;
    // a blank edit deletes the comment there (the store's rule); a blank new one never gets here (`commentCanSave`)
    persistRef.current(current.owner, current.target, comment);
    // the selection was for this comment: it is made. A pin or a block opened it: whatever is selected meanwhile stays
    if (current.fromSelection) window.getSelection()?.removeAllRanges();
    close();
  }, [close]);

  // at once, without a question or an undo: a comment is cheap to write again
  const remove = useCallback((): void => {
    const current = openRef.current;
    if (current === null) return;
    if (current.commentId !== null) blockComments.remove(current.owner, [current.commentId]);
    close();
  }, [close]);

  // the setting turned off, or the comment edited is no longer stored (a send acknowledged it, another tab deleted it)
  // while its field is unchanged
  const stored = useBlockComments(open?.owner ?? "");
  useEffect(() => {
    // only the opening this render drew: one shown since is checked by its own render
    if (open === null || openRef.current !== open) return;
    if (!enabled || popoverOutlived(open, stored, fieldText.current)) close();
  }, [open, enabled, stored, close]);

  return { open, show, save, remove, close, text };
}
