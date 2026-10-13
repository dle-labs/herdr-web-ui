/**
 * What the comment popover (CommentPopover.tsx, beside its pin or as a dialog) is written with: a
 * comment's text with its field and its keys, and where the focus goes when the editor closes.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import "./CommentPopover.css";

import { COMMENT_SURFACE } from "../lib/commentHighlight.ts";
import { commentCanSave, commentChanged } from "../lib/commentPopover.ts";
import { restoreFocusTarget } from "../lib/commentSelection.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { consumeDictationEscape, useDictation, type Dictation } from "./VoiceInput.tsx";
import { nativeModalOver } from "../lib/useFocusTrap.ts";

/**
 * Whether a key or a press (its `target`) while a comment's popover or dialog (`box`) is up belongs to another modal
 * dialog, one that does not hold the box (Settings by its shortcut, a question it asks, the file viewer opened from a reply). That
 * dialog's own then: its Escape never closes the comment beneath, which listens on the whole window, nor does a press in
 * it count as one outside the comment (CommentPopover.tsx).
 */
export function inAnotherDialog(target: EventTarget | null, box: Element | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (nativeModalOver(box instanceof HTMLElement ? box : null)) return true;
  const dialog = element?.closest("[aria-modal='true'], dialog[open]") ?? null;
  // the dialog is the comment's own (its box), or one it lies in (the file viewer): not another
  return dialog !== null && !(box !== null && dialog.contains(box));
}

/** A comment being written in the popover: its text, its field and its keys. */
export interface CommentDraft {
  /** the editor's own box */
  surface: RefObject<HTMLDivElement>;
  field: RefObject<HTMLTextAreaElement>;
  value: string;
  dictation: Dictation;
  note: string | null;
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
  owner: string;
  connected: boolean;
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
  { connected, opener: given, fallback, inline = false, focusField = true, startValue, onText }: CommentDraftOptions,
): CommentDraft {
  const surface = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const { settings } = useSettings();
  const [value, setStoredValue] = useState(startValue ?? initialComment);
  const valueRef = useRef(value);
  valueRef.current = value;
  const dictatedCaret = useRef<{ value: string; caret: number } | null>(null);
  const setValue = (text: string): void => {
    dictatedCaret.current = null;
    valueRef.current = text;
    setStoredValue(text);
  };
  const [note, setNote] = useState<string | null>(null);
  const dictation = useDictation({
    mode: "comment", connected, box: field, surface, polish: settings.voicePolishChat,
    read: () => valueRef.current,
    write: (text, caret) => {
      dictatedCaret.current = { value: text, caret };
      valueRef.current = text;
      setStoredValue(text);
    },
    onNote: setNote,
  });
  // Restore the engine's caret only after React committed its text, without taking focus.
  useLayoutEffect(() => {
    const pending = dictatedCaret.current;
    dictatedCaret.current = null;
    const node = field.current;
    if (pending !== null && pending.value === value && node?.value === value) {
      node.setSelectionRange(pending.caret, pending.caret);
    }
  }, [value]);
  const close = (): void => { dictation.cancel(); onClose(); };
  const save = (): void => {
    dictation.cancel();
    if (value.trim() === initialComment.trim()) onClose(); else onSave(value);
  };
  const refocus = (): void => field.current?.focus({ preventScroll: true });
  const told = useRef(onText);
  told.current = onText;
  useLayoutEffect(() => told.current?.(value), [value]);

  // Measure outside the reading surface: resetting the live field to auto on
  // every key forces its entire diff grid to reflow, even when height is unchanged.
  const measuringField = useRef<HTMLTextAreaElement | null>(null);
  const resizeField = useCallback(() => {
    const node = field.current;
    if (!node) return;
    const clientWidth = node.clientWidth;
    if (clientWidth === 0) return;
    let measure = measuringField.current;
    if (measure === null) {
      measure = node.ownerDocument.createElement("textarea");
      measure.className = "comment-editor-measure";
      measure.tabIndex = -1;
      measure.setAttribute("aria-hidden", "true");
      measure.inert = true;
      node.ownerDocument.body.append(measure);
      measuringField.current = measure;
    }
    const style = getComputedStyle(node);
    for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-stretch", "line-height", "letter-spacing", "text-indent", "text-transform", "tab-size", "white-space", "word-break", "overflow-wrap", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style", "box-sizing"]) {
      const next = style.getPropertyValue(property);
      if (measure.style.getPropertyValue(property) !== next) measure.style.setProperty(property, next);
    }
    const pixels = (property: string) => Number.parseFloat(style.getPropertyValue(property)) || 0;
    const borderBox = style.boxSizing === "border-box";
    const width = `${clientWidth + (borderBox ? pixels("border-left-width") + pixels("border-right-width") : -pixels("padding-left") - pixels("padding-right"))}px`;
    if (measure.style.width !== width) measure.style.width = width;
    if (measure.placeholder !== node.placeholder) measure.placeholder = node.placeholder;
    if (measure.value !== node.value) measure.value = node.value;
    const height = `${measure.scrollHeight + (borderBox ? pixels("border-top-width") + pixels("border-bottom-width") : -pixels("padding-top") - pixels("padding-bottom"))}px`;
    if (node.style.height !== height) node.style.height = height;
  }, []);
  useLayoutEffect(resizeField, [value, resizeField]);
  useLayoutEffect(() => () => {
    measuringField.current?.remove();
    measuringField.current = null;
  }, []);
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      resizeField();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [resizeField]);

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
  closeRef.current = close;
  useEffect(() => {
    if (inline) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || inAnotherDialog(event.target, surface.current)) return;
      if (consumeDictationEscape(event, surface.current)) return;
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
    dictation.cancel();
    if (!changed) {
      onClose();
      return true;
    }
    refocus();
    return false;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (consumeDictationEscape(event.nativeEvent, surface.current)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
      close();
      return;
    }
    // a dialog keeps Tab inside through its focus trap (CommentPopover.tsx, `useFocusTrap`); a popover is in the page's
    // flow, and Tab goes on from it
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target === field.current) {
      event.preventDefault();
      // Keyboard Save also invalidates pending speech, even when the visible draft is unchanged.
      dictation.cancel();
      // as a Save button: nothing to save is no save, and the editor stays
      if (canSave) save();
    }
  };

  return { surface, field, value, canSave, changed, setValue, save, leave, onKeyDown, dictation, note };
}

/** The comment's field, in its popover. */
export function CommentField({ draft }: { draft: CommentDraft }) {
  const t = useT();
  return <textarea
    ref={draft.field}
    className="comment-editor-field"
    value={draft.value}
    rows={1}
    aria-label={t("Comment")}
    placeholder={t("Write a comment…")}
    onChange={(event) => draft.setValue(event.target.value)}
  />;
}
