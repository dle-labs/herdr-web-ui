/**
 * The rules of a comment surface's one popover (components/useCommentPopover.ts), without React or
 * the DOM: whether its text is changed and what saving it does, how an opening starts, when the open
 * one keeps its place, and whether its field takes the focus as it opens. Every opening is its field:
 * a saved comment opens straight into editing, filled with its text, and a new one empty.
 */

/**
 * Whether a comment's popover is changed: its field's text differs from the text it opened with (empty for a new
 * comment, the saved comment for an edit). A cleared edit counts as changed; text typed and then undone back to what
 * it opened with does not. This is the one meaning of "changed" for the comment UI (`popoverChanged`,
 * `data-comment-changed`, lib/commentDom.ts `hasChangedComment`): a changed popover is not given up by Escape, a press
 * outside it or the setting, nor replaced by another comment; an unchanged one is.
 */
export function commentChanged(value: string, initialComment: string): boolean {
  return value !== initialComment;
}

/**
 * Whether a comment popover's save (its ↑ and Cmd/Ctrl+Enter) does anything: a new comment with nothing
 * but blanks has nothing to save, nor has an edit left as it opened (`commentChanged`); an edit may be saved
 * blank, which deletes the comment.
 */
export function commentCanSave(value: string, initialComment: string): boolean {
  return commentChanged(value, initialComment) && (initialComment !== "" || value.trim() !== "");
}

/** What an opening shows: the field, filled with a saved comment's text, or empty for a new one. */
export interface PopoverStart {
  /** the stored comment edited; null for a new one */
  commentId: string | null;
  initialComment: string;
}

/** How the popover opens on a target: on a saved comment (`existing`) to edit, or on a new one to write. */
export function popoverStart(existing: { id: string; comment: string } | null): PopoverStart {
  return existing === null
    ? { commentId: null, initialComment: "" }
    : { commentId: existing.id, initialComment: existing.comment };
}

/**
 * Whether the open popover keeps its place against another opening: its field (`field`, what it holds now) is
 * changed (`commentChanged`). None open has nothing to keep.
 */
export function popoverChanged(open: { initialComment: string } | null, field: string): boolean {
  return open !== null && commentChanged(field, open.initialComment);
}

/**
 * What an Escape the open popover did not take itself (the focus is elsewhere in the file viewer, which asks first)
 * does to it: "none" with none open, so the key goes on (the viewer closes); "close" it while it is unchanged;
 * "keep" it changed (`popoverChanged`), which is never lost to a key. Either of the last two takes the key:
 * the viewer stays.
 */
export function popoverEscape(open: { initialComment: string } | null, field: string): "none" | "close" | "keep" {
  if (open === null) return "none";
  return popoverChanged(open, field) ? "keep" : "close";
}

/**
 * Whether the open popover of a saved comment has outlived it: the comment is no longer stored (a
 * send acknowledged it, another tab deleted it) and its field (`field`, what it holds now) is unchanged
 * (`commentChanged`), so nothing would be lost. A changed one stays open (saving it stores the comment
 * again), and a new comment is never closed this way: what is being written stays.
 */
export function popoverOutlived(open: { commentId: string | null; initialComment: string }, stored: readonly { id: string }[], field: string): boolean {
  return open.commentId !== null && !stored.some((comment) => comment.id === open.commentId) && !commentChanged(field, open.initialComment);
}

/**
 * Whether the popover's field takes the focus as it opens. A new comment's always does: it is opened
 * to be written. A saved comment's does not on a touch screen (`coarse`), where a focused field raises
 * the keyboard over what was only tapped to be read: the sheet shows the field filled, and a tap
 * into it starts editing.
 */
export function popoverFocusesField(saved: boolean, coarse: boolean): boolean {
  return !saved || !coarse;
}
