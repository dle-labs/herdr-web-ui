/**
 * What the comment popover (CommentPopover.tsx, beside its pin or as a dialog) is written with: a
 * comment's text with its field and its keys, and where the focus goes when the editor closes.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import "./CommentPopover.css";

import { COMMENT_SURFACE } from "../lib/commentHighlight.ts";
import { commentCanSave, commentChanged } from "../lib/commentPopover.ts";
import { restoreFocusTarget } from "../lib/commentSelection.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Whether a key or a press (its `target`) while a comment's popover or dialog (`box`) is up belongs to another modal
 * dialog, one that does not hold the box (Settings by its shortcut, a question it asks, the file viewer opened from a reply). That
 * dialog's own then: its Escape never closes the comment beneath, which listens on the whole window, nor does a press in
 * it count as one outside the comment (CommentPopover.tsx).
 */
export function inAnotherDialog(target: EventTarget | null, box: Element | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const dialog = element?.closest("[aria-modal='true']") ?? null;
  // the dialog is the comment's own (its box), or one it lies in (the file viewer): not another
  return dialog !== null && !(box !== null && dialog.contains(box));
}

/** Longest comment, in UTF-16 units as `maxLength` counts. */
export const COMMENT_MAX_CHARS = 2000;

/** A comment being written in the popover: its text, its field and its keys. */
export interface CommentDraft {
  /** the editor's own box */
  surface: RefObject<HTMLDivElement>;
  field: RefObject<HTMLTextAreaElement>;
  value: string;
  /** Save does something (`commentCanSave`): a new comment with only blanks, or a saved one unchanged, has nothing to save */
  canSave: boolean;
  /** the text is changed (`commentChanged`): the popover is not given up by a key, nor passed over by the composer's Send */
  changed: boolean;
  setValue: (value: string) => void;
  /** saves the text, or only closes when it is unchanged */
  save: () => void;
  /**
   * Gives the editor up where nothing would be lost (✕, a press outside it or on its scrim): closes it while nothing is
   * typed (true), else keeps it and puts the focus back in its field (false)
   */
  leave: () => boolean;
  /** on the editor's box: Cmd/Ctrl+Enter in the field saves when `canSave`; in a popover beside its pin Escape closes while nothing was typed */
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export interface CommentDraftOptions {
  /**
   * What gets the focus back on close. An element or null for none; by default what had the focus
   * as the editor opened. A function is asked after the commit that closes the editor, so it can
   * find an element the same commit drew again (the pin of the comment that was edited): it gets
   * the comment surface the editor was in (`scope`: the chat view, the file viewer; null for a
   * dialog, which sits outside it).
   */
  opener?: HTMLElement | null | ((scope: Element | null) => HTMLElement | null);
  /** where the focus goes when its opener is gone (the composer of the pane): asked once, as the editor opens */
  fallback: (scope: Element | null) => HTMLElement | null;
  /** a popover beside its pin, not a dialog: Escape only from inside it, and the focus is given back only if the editor still had it */
  inline?: boolean;
  /**
   * Whether the field takes the focus as the editor opens (`popoverFocusesField`); else its box (`surface`, which then
   * needs `tabIndex={-1}`) does, so Escape is the editor's and no keyboard rises on a touch screen. Default: the field
   */
  focusField?: boolean;
  /** the text the field starts with when it is not `initialComment`: a comment that was being written in, drawn again */
  startValue?: string;
  /** told the text as it changes */
  onText?: (value: string) => void;
}

/**
 * The behaviour of the comment popover's editing, beside its pin or as a dialog. The field grows with the comment, takes the focus with
 * its caret at the end (unless `focusField` is false: then the box takes it), and Escape cancels, only while nothing was typed in it (what was typed is
 * never lost to a key: the key puts the focus back in the field instead): anywhere while a dialog is up; from inside a popover beside its pin (`inline`), which
 * leaves the rest of the page usable. Cmd/Ctrl+Enter saves only what Save would (`canSave`).
 * "Typed" here means changed (`commentChanged`), the one ChatView uses to keep a comment being written from being replaced. On close the focus goes back to
 * the `opener` (by default what had it when the editor opened), else to the `fallback` element: a
 * deleted comment takes its own pin, the opener, with it. `fallback()` is asked once, as the
 * editor opens (the caller's own composer: its chat may be gone when the editor closes, and
 * another pane's composer is not its). The target is chosen after the commit that closes the
 * editor (`restoreFocusTarget`), when a deleted pin is out of the document too. A popover beside its pin
 * gives the focus back only when it still has it (or nothing has): the user may be typing
 * elsewhere when it closes or its chat goes. On a touch screen the fallback is not focused (no
 * keyboard unasked): the focus is let go.
 */
export function useCommentDraft(
  initialComment: string,
  onSave: (comment: string) => void,
  onClose: () => void,
  { opener: given, fallback, inline = false, focusField = true, startValue, onText }: CommentDraftOptions,
): CommentDraft {
  const surface = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(startValue ?? initialComment);
  const save = (): void => { if (value.trim() === initialComment.trim()) onClose(); else onSave(value); };
  const refocus = (): void => field.current?.focus({ preventScroll: true });
  const told = useRef(onText);
  told.current = onText;
  useEffect(() => told.current?.(value), [value]);

  // one line to start, growing with the comment up to the cap in CSS, as the composer's box does
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
  }, [value]);

  // the opener and the fallback as the editor opened: read once, they do not change while it is up
  const askFallback = useRef(fallback);
  const openedBy = useRef(given);
  const nonModal = useRef(inline);
  useLayoutEffect(() => {
    const scope = surface.current?.closest(`[${COMMENT_SURFACE}]`) ?? null;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener = (): HTMLElement | null => {
      const by = openedBy.current;
      return typeof by === "function" ? by(scope) : by !== undefined ? by : active;
    };
    const back = askFallback.current(scope);
    return () => {
      // still in the document here: React runs this before it takes the editor's elements out
      if (nonModal.current) {
        const now = document.activeElement;
        const held = now === null || now === document.body || (surface.current?.contains(now) ?? false);
        if (!held) return;
      }
      // chosen after the commit: a deleted comment's pin is still in the document here, and
      // React removes it right after, which would leave the focus on the body
      // (a touch screen lets it go instead of raising the keyboard in the composer, as the bar's X does).
      // Unless something took the focus meanwhile: the field of the editor drawn in its place (a popover
      // that became a dialog) keeps it
      queueMicrotask(() => {
        const now = document.activeElement;
        if (now instanceof HTMLElement && now !== document.body && now.isConnected) return;
        restoreFocusTarget(opener(), back, nonModal.current, window.matchMedia("(pointer: coarse)").matches)?.focus({ preventScroll: true });
      });
    };
  }, []);
  // in the commit, so inside the tap or click that opened the editor: iOS raises its keyboard only for a
  // focus given while that event is handled (not a frame later), and a phone's user would else tap the field.
  // Without `focusField` the box takes it instead: the editor holds the focus (its Escape, a dialog's trap) and no
  // keyboard rises; a tap into the field starts editing
  const focusesField = useRef(focusField);
  useLayoutEffect(() => {
    if (!focusesField.current) {
      surface.current?.focus({ preventScroll: true });
      return;
    }
    const node = field.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  // A dialog's Escape is its own, not the composer's or the chat's underneath: anywhere, from the window in the capture
  // phase. A popover beside its pin handles it in its surface's `onKeyDown` below, so only from inside it. Either closes only
  // while nothing was typed, else puts the focus back in the field; a dialog's still keeps the key from what is underneath
  // (a file viewer would close on it)
  const changedNow = useRef(false);
  // a caller may hand a new onClose on every render: read here, the listener stays where it is in the window's order
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (inline) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || inAnotherDialog(event.target, surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (changedNow.current) field.current?.focus({ preventScroll: true });
      else closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inline]);

  const changed = commentChanged(value, initialComment);
  changedNow.current = changed;
  const canSave = commentCanSave(value, initialComment);
  const leave = (): boolean => {
    if (!changed) {
      onClose();
      return true;
    }
    refocus();
    return false;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // React's root dispatches after every document- and window-capture listener, so the walk's Escape (Composer.tsx, on
    // the document) has already run when a popover gives up here, whatever the order the listeners were added in.
    // Only an untouched popover gives up: what was typed is not thrown away by a key (the key puts the focus back in the field), and
    // the event goes on unstopped, to the walk's Escape and whatever else listens above
    if (inline && event.key === "Escape") {
      if (changed) {
        refocus();
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      onClose();
      return;
    }
    // a dialog keeps Tab inside through its focus trap (CommentPopover.tsx, `useFocusTrap`); a popover is in the page's
    // flow, and Tab goes on from it
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target === field.current) {
      event.preventDefault();
      // as a Save button: nothing to save is no save, and the editor stays
      if (canSave) save();
    }
  };

  return { surface, field, value, canSave, changed, setValue, save, leave, onKeyDown };
}

/** The comment's field, in its popover. */
export function CommentField({ draft }: { draft: CommentDraft }) {
  const t = useT();
  return <textarea
    ref={draft.field}
    className="comment-editor-field"
    value={draft.value}
    maxLength={COMMENT_MAX_CHARS}
    rows={1}
    aria-label={t("Comment")}
    placeholder={t("Write a comment…")}
    onChange={(event) => draft.setValue(event.target.value)}
  />;
}
