/**
 * A comment surface's whole comment wiring, for the chat (ChatView.tsx) and the file viewer (FileComments.tsx): its one
 * popover (`useCommentPopover`), opened by a pin, by a click or tap on a block or line (`useCommentClick`) or by a
 * mouse's drag over text (`useSelectionComment`); the pin layer with that popover (CommentPins.tsx, CommentPopover.tsx);
 * the new comment's pending highlight; and where the focus goes as the popover closes. The host says only what differs
 * between surfaces, in its own terms (`T`, what a comment is on): what a click or a selection comments on, the comment
 * already there, the pins, what the popover quotes.
 *
 * What it keeps so that no host has to:
 * - one popover per opening (keyed by `OpenComment.id`), its text carried across a redraw (a popover beside its pin that
 *   becomes a dialog keeps what was typed);
 * - an opening refused while the open popover is changed gives the focus back to that popover's field;
 * - a new comment's text shows as pending in the commit that opens it (`showPending`): the pin layer waits for that
 *   highlight to place the provisional pin and the popover beside it;
 * - a double click closes a new, unchanged popover the first click opened, and goes on to select a word;
 * - after Delete the focus goes to the next pin, else the previous one (`focusAfter`), else to `focusFallback`, through
 *   the popover's own close-time restore (CommentDraft.tsx): the opener it asks is that pin, for the opening the Delete
 *   happened in, so there is one place that moves the focus;
 * - the pin layer is memoized and gets only props that keep their identity while the comments and the opening do: a
 *   host that re-renders often (the chat, on every conversation poll while an agent streams) does not redraw it.
 */
import { memo, useCallback, useLayoutEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { PENDING_COMMENT_ID } from "../lib/commentHighlight.ts";
import { firstPin, focusOpenField, pinAnchors, pinByAnchor } from "../lib/commentDom.ts";
import { focusAfter, type CommentPoint } from "../lib/commentPins.ts";
import { popoverChanged, popoverEscape } from "../lib/commentPopover.ts";
import { CommentPins as CommentPinLayer, type PinnedComment, type PopoverPlacement } from "./CommentPins.tsx";
import { CommentPopover, type CommentPopoverProps } from "./CommentPopover.tsx";
import type { FileReference } from "./FileReference.tsx";
import { useCommentClick } from "./useCommentClick.ts";
import { useCommentPopover, type OpenComment } from "./useCommentPopover.ts";
import { useSelectionComment } from "./useSelectionComment.ts";

/** A saved comment on the surface: its pin, and what opening it edits. */
export interface SurfaceComment<T> extends PinnedComment {
  /** the target to edit it as (an edit replaces this comment) */
  target: T;
  /** its text */
  comment: string;
}

/** What goes on the surface's scrolling element. */
export interface CommentSurfaceProps {
  "data-comment-surface"?: "";
  "data-comments"?: "";
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export interface CommentSurfaceOptions<T, S> {
  /** the scrolling element: it gets `surfaceProps`, and the pin layer lies in its content */
  surface: RefObject<HTMLDivElement>;
  /** the Comments setting: off, nothing is drawn and an open popover closes */
  enabled: boolean;
  /**
   * the surface takes new comments now (the file viewer: a view of a text file of a known pane); default true. While it
   * does not, a click or a drag opens nothing and the surface is not marked as one, but a popover already open stays,
   * as a dialog, with what was typed
   */
  active?: boolean;
  /** whether the surface's content is drawn now: a click, or a double click, does nothing without it; default true */
  drawn?: () => boolean;
  /** keeps the comment written on `target` of `owner`'s pane; "" deletes */
  persist: (owner: string, target: T, comment: string) => void;
  /** whose pins `comments` are (the pane's store owner); null: none */
  owner: string | null;
  /** the pins, memoized by the host: a new list is a redraw of the pin layer */
  comments: readonly SurfaceComment<T>[];
  /** the anchor a target's comment has, or a save gives it: where its pin is found again */
  anchorOf: (target: T) => string;
  /** the comment already on `target`, with the target to edit it as; null for none */
  existing: (owner: string, target: T) => { id: string; comment: string; target: T } | null;
  /** `target` with its `CommentPoint` at the client point `at`, on the text its highlight will cover */
  pointed: (owner: string, target: T, at: { x: number; y: number }) => T;
  /** what a plain click on `element` comments on; null for nothing */
  targetAtClick: (element: Element) => { owner: string; target: T } | null;
  /** a mouse's drag: `measure` the selection in `view`, and the comment a measured selection makes (null: none) */
  selection: {
    measure: (selection: Selection | null, view: Element) => S | null;
    target: (found: S) => { owner: string; target: T } | null;
  };
  /** what a dialog or a sheet shows of the open comment */
  describe: (open: OpenComment<T>) => { quote: CommentPopoverProps["quote"]; reference?: FileReference };
  /** where the focus goes when the closed comment's pin is gone (the chat's composer; null: it is let go) */
  focusFallback: (surface: HTMLElement | null) => HTMLElement | null;
  /**
   * shows a new comment's text as pending on the surface, and returns its undo. Run in a layout effect in the commit
   * that opens it, before the pin layer measures
   */
  showPending: (owner: string, target: T) => () => void;
}

/** The pin layer, which gets only props that keep their identity while the comments and the opening do. */
const CommentPins = memo(CommentPinLayer);

/**
 * The comment wiring of `surface` (see the module comment). Returns the props for the scrolling element
 * (`surfaceProps`), the pin layer with the popover to render in it after its content (`overlay`, null while comments
 * are off), the open comment, and `escape`: an Escape that no popover took itself (the file viewer asks it first)
 * closes an unchanged popover, or gives a changed one's field the focus back; true while a popover had it.
 */
export function useCommentSurface<T extends { point?: CommentPoint }, S>(options: CommentSurfaceOptions<T, S>): {
  surfaceProps: CommentSurfaceProps;
  overlay: ReactNode;
  open: OpenComment<T> | null;
  escape: () => boolean;
} {
  const { surface, enabled, active = true, persist, comments } = options;
  // the host's callbacks may be new functions on every render: read when they are used
  const latest = useRef(options);
  latest.current = options;

  const { open, show, save, remove, close, text } = useCommentPopover<T>({ persist, enabled });

  /** opens `target`: on the comment there, as itself, else on a new one with its pin at `at` */
  const openOn = (owner: string, target: T, fromSelection: boolean, at: { x: number; y: number }): void => {
    const { existing, pointed } = latest.current;
    const found = existing(owner, target);
    const opened = found === null
      ? show(owner, pointed(owner, target, at), null, fromSelection)
      : show(owner, found.target, { id: found.id, comment: found.comment }, fromSelection);
    // the open popover is changed and keeps its place: the focus goes back to its field
    if (!opened) focusOpenField(surface.current);
  };

  const takes = enabled && active;
  useSelectionComment({
    view: surface,
    enabled: takes,
    measure: (selection, view) => latest.current.selection.measure(selection, view),
    onComment: (found, at) => {
      const made = latest.current.selection.target(found);
      if (made !== null) openOn(made.owner, made.target, true, at);
    },
  });
  const drawn = (): boolean => latest.current.drawn?.() ?? true;
  const handlers = useCommentClick({
    enabled: takes,
    closesOnDoubleClick: () => drawn() && open !== null && open.commentId === null && !popoverChanged(open, text.read()),
    close,
    onComment: (element, at) => {
      if (!drawn()) return;
      const found = latest.current.targetAtClick(element);
      if (found !== null) openOn(found.owner, found.target, false, at);
    },
  });

  // a new comment's text shows as its comment's will, until it is saved or given up
  const pending = open !== null && open.commentId === null ? open : null;
  useLayoutEffect(() => {
    if (pending === null) return;
    return latest.current.showPending(pending.owner, pending.target);
  }, [pending]);

  // a pin opens its comment; read through a ref, so the pin layer keeps the same handler
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const onPin = useCallback((id: string): void => {
    const owner = latest.current.owner;
    const found = commentsRef.current.find((comment) => comment.id === id);
    if (owner === null || found === undefined) return;
    if (!show(owner, found.target, { id, comment: found.comment })) focusOpenField(surface.current);
  }, [show, surface]);

  // Where the focus goes as a Delete closes the popover: the pins next to it, recorded for the opening it happened in.
  // The popover's close-time restore asks its opener after the commit, and finds the first of them still drawn
  const deleted = useRef<{ opening: number; near: string[] } | null>(null);
  const popover = useMemo(() => {
    if (open === null) return null;
    const anchor = latest.current.anchorOf(open.target);
    const onDelete = (): void => {
      deleted.current = { opening: open.id, near: focusAfter(pinAnchors(surface.current), anchor) };
      remove();
    };
    // the pin, found again after the commit that closes it; a dialog (portalled out of the surface, `scope` null) goes back to it too
    const opener = (scope: Element | null): HTMLElement | null => {
      const within = scope ?? surface.current;
      const gone = deleted.current;
      return gone !== null && gone.opening === open.id ? firstPin(within, gone.near) : pinByAnchor(within, anchor);
    };
    const fallback = (): HTMLElement | null => latest.current.focusFallback(surface.current);
    return (placement: PopoverPlacement): JSX.Element => {
      const { quote, reference } = latest.current.describe(open);
      return <CommentPopover
        key={open.id}
        placement={placement}
        quote={quote}
        reference={reference}
        comment={open.initialComment}
        startValue={text.read()}
        onText={text.write}
        onSave={save}
        onDelete={onDelete}
        onClose={close}
        opener={opener}
        fallback={fallback}
      />;
    };
  }, [open, surface, text, save, remove, close]);

  const escape = (): boolean => {
    const outcome = popoverEscape(open, text.read());
    if (outcome === "close") close();
    else if (outcome === "keep") focusOpenField(surface.current);
    return outcome !== "none";
  };

  // the pins while the surface takes comments, and the popover while one is open: one opened before the surface stopped
  // taking them (the file viewer moved on to another file or view) shows as a dialog, with what was typed
  const openId = open === null ? null : open.commentId ?? PENDING_COMMENT_ID;
  const overlay = enabled && (active || open !== null)
    ? <CommentPins surface={surface} comments={comments} openId={openId} pendingPoint={pending?.target.point} popover={popover} onPin={onPin} />
    : null;
  return {
    surfaceProps: {
      "data-comment-surface": active ? "" : undefined,
      "data-comments": takes ? "" : undefined,
      ...handlers,
    },
    overlay,
    open,
    escape,
  };
}
