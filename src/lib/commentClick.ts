/**
 * Which click on a reply block or a file line opens a comment, and which mouse drag opens one on the text it selected.
 * `isCommentClick` and `isCommentDrag` decide from plain facts and need no DOM; `clickFacts` reads a click's facts off
 * its event.
 */
import { COMMENT_UI_SELECTOR, inPopover } from "./commentDom.ts";

/** What a click is made of, as far as commenting cares. */
export interface ClickFacts {
  button: number;
  detail: number;
  /** the target is inside an interactive element, a pin or a popover (`COMMENT_CLICK_IGNORED`) */
  interactive: boolean;
  /** the document's selection is collapsed */
  selectionCollapsed: boolean;
  /** a touch screen with a text field outside a comment popover focused: the tap puts the keyboard away */
  dismissesKeyboard: boolean;
}

/** A click inside any of these never opens a comment: it belongs to the element, or to the comment UI itself. */
export const COMMENT_CLICK_IGNORED =
  `a, button, summary, input, textarea, select, label, [role='button'], [contenteditable], .markdown-code-header, .markdown-code-more, ${COMMENT_UI_SELECTOR}`;

/**
 * The presses that dismissed an open popover (a press outside it, `markDismissingPress`, CommentPopover.tsx): such a
 * press only closes it, or gives its field the focus back: the click that follows it opens no comment
 * (`isDismissingPress`, asked with the same press event by `useCommentClick`). A drag that starts with it still opens
 * its selection's comment (`useSelectionComment`). Kept by the event itself, so a mark never reaches another press.
 */
const dismissingPresses = new WeakSet<Event>();

/** `press` (a `pointerdown`) dismissed an open popover: it opens nothing. */
export function markDismissingPress(press: Event): void {
  dismissingPresses.add(press);
}

/** Whether `press` (a `pointerdown`) dismissed an open popover (`markDismissingPress`); none never did. */
export function isDismissingPress(press: Event | null | undefined): boolean {
  return press != null && dismissingPresses.has(press);
}

/** How far a mouse moves between its press and its release for a drag: less is a click, or a hand that shook. */
export const DRAG_MIN_PX = 4;

/**
 * Whether a press and its release are a mouse's drag that selected text to comment on (`useSelectionComment`): a mouse
 * (not a finger or a pen), one click (`clicks`, the press's `mousedown` detail: a double or triple click selects a word
 * or a line by itself, to copy it), moved at least `DRAG_MIN_PX` between the press and the release.
 */
export function isCommentDrag(pointerType: string, clicks: number, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return pointerType === "mouse" && clicks < 2 && Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_MIN_PX;
}

/** A plain primary single click, on nothing interactive, that does not end a selection or put the keyboard away. */
export function isCommentClick(facts: ClickFacts): boolean {
  return facts.button === 0 && facts.detail === 1 && !facts.interactive && facts.selectionCollapsed && !facts.dismissesKeyboard;
}

/**
 * DOM: a touch screen with a text field outside a comment popover focused, whose keyboard a tap elsewhere puts away.
 * Read it as the press comes down too: a press on text that cannot take the focus takes it from the field before
 * the click (`clickFacts` alone would then miss it).
 */
export function typingOnTouch(): boolean {
  const active = document.activeElement;
  const typing = active instanceof Element && active.matches("textarea, input, [contenteditable]") && !inPopover(active);
  return typing && window.matchMedia("(pointer: coarse)").matches;
}

/** DOM: the facts of `event`. */
export function clickFacts(event: MouseEvent): ClickFacts {
  const target = event.target instanceof Element ? event.target : null;
  return {
    button: event.button,
    detail: event.detail,
    interactive: target?.closest(COMMENT_CLICK_IGNORED) != null,
    selectionCollapsed: window.getSelection()?.isCollapsed ?? true,
    dismissesKeyboard: typingOnTouch(),
  };
}
