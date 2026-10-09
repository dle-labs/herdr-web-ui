/**
 * The markup of the comment UI that other code queries: the popover (CommentPopover.tsx) and the pin layer
 * (CommentPins.tsx) render with these names, and everything that has to find them (the composer's Send and walk, the
 * Settings switch, a surface's clicks and focus) asks through the queries here, never with a selector of its own. A
 * change to that markup is then made here once, and a query that no longer finds anything cannot hide in another file.
 *
 * The queries need only `querySelector`/`querySelectorAll`/`closest` and an element's `dataset`, so a stand-in object
 * tests them without a DOM.
 */

/** A comment popover's box, beside its pin or as a dialog (`.modal` too, portalled to the document's body). */
export const POPOVER_CLASS = "comment-popover";
/** The scrim under a popover drawn as a dialog. */
export const POPOVER_SCRIM_CLASS = "comment-popover-scrim";
/** A surface's pin layer, which also holds the popover beside its pin. */
export const PINS_CLASS = "comment-pins";
/** A comment's pin, a saved one's or the provisional one of a comment being written (`PENDING_PIN_CLASS`). */
export const PIN_CLASS = "comment-pin";
/** The provisional pin of a comment being written: shown, never pressed or focused. */
export const PENDING_PIN_CLASS = "is-pending";
/** On a popover's box while its text is changed (`commentChanged`). */
export const CHANGED_ATTR = "data-comment-changed";
/** On a saved comment's pin: the comment's id (a new one with every edit). */
export const PIN_ID_ATTR = "data-comment-id";
/** On a saved comment's pin: the comment's anchor (kept by an edit). */
export const PIN_ANCHOR_ATTR = "data-comment-anchor";

const POPOVER = `.${POPOVER_CLASS}`;
const DIALOG = `.modal${POPOVER}`;
const CHANGED = `[${CHANGED_ATTR}]`;
const PIN_WITH_ANCHOR = `.${PIN_CLASS}[${PIN_ANCHOR_ATTR}]`;
/** The pin layer, for a selector of what is not a comment's text (lib/commentSelection.ts). */
export const PINS_SELECTOR = `.${PINS_CLASS}`;
/** The comment UI on a surface: the pin layer (which holds a popover beside its pin) and a popover anywhere. */
export const COMMENT_UI_SELECTOR = `${PINS_SELECTOR}, ${POPOVER}`;

/** The attributes of a popover's box that say whether its text is changed. */
export function changedAttrs(changed: boolean): Record<typeof CHANGED_ATTR, "" | undefined> {
  return { [CHANGED_ATTR]: changed ? "" : undefined };
}

/** The attributes of a saved comment's pin. */
export function pinAttrs(id: string, anchor: string): Record<typeof PIN_ID_ATTR | typeof PIN_ANCHOR_ATTR, string> {
  return { [PIN_ID_ATTR]: id, [PIN_ANCHOR_ATTR]: anchor };
}

function elementOf(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) return target;
  return typeof Node !== "undefined" && target instanceof Node ? target.parentElement : null;
}

/** Whether `target` lies in the comment UI: a popover (beside its pin or a dialog) or the pin layer. */
export function isCommentUi(target: EventTarget | null): boolean {
  return elementOf(target)?.closest(COMMENT_UI_SELECTOR) != null;
}

/** Whether `target` lies in a surface's pin layer (a pin, or the popover beside its pin). */
export function inPinLayer(target: EventTarget | null): boolean {
  return elementOf(target)?.closest(PINS_SELECTOR) != null;
}

/** Whether `target` lies in a popover whose text is unchanged: an Escape there closes it. */
export function inUnchangedPopover(target: EventTarget | null): boolean {
  return elementOf(target)?.closest(`${POPOVER}:not(${CHANGED})`) != null;
}

/** Whether `element` lies in a comment popover. */
export function inPopover(element: Element): boolean {
  return element.closest(POPOVER) !== null;
}

/** Whether a comment popover is drawn as a dialog anywhere in `root` (its scrim is up). */
export function hasCommentDialog(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(`.${POPOVER_SCRIM_CLASS}`) !== null;
}

/**
 * The field of a comment popover in `scope` (a pane's stack, a surface) whose text is changed (`commentChanged`), else
 * of one drawn as a dialog anywhere in `scope`'s document (a phone's sheet; a comment the file viewer opened on another
 * file): a dialog is modal, so it is the one being written in, wherever it came from. Null for none: a message sent or
 * a walk taken then loses nothing.
 */
export function changedField(scope: Element | null): HTMLTextAreaElement | null {
  if (scope === null) return null;
  return scope.querySelector<HTMLTextAreaElement>(`${POPOVER}${CHANGED} textarea`)
    ?? scope.ownerDocument.querySelector<HTMLTextAreaElement>(`${DIALOG}${CHANGED} textarea`);
}

/**
 * Whether a comment popover anywhere in `root` (the document: beside its pin in any pane, the chat's or the file
 * viewer's, or drawn as a dialog) is changed. Turning comments off would lose it, so Settings asks first.
 */
export function hasChangedComment(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(`${POPOVER}${CHANGED} textarea`) !== null;
}

/**
 * Gives the open popover's field in `scope` (a comment surface), else of one drawn as a dialog in its document, the
 * focus: an opening refused while that popover is changed (`popoverChanged`) leaves the user where the text is.
 */
export function focusOpenField(scope: Element | null): void {
  if (scope === null) return;
  const field = scope.querySelector<HTMLTextAreaElement>(`${POPOVER} textarea`) ?? scope.ownerDocument.querySelector<HTMLTextAreaElement>(`${DIALOG} textarea`);
  field?.focus({ preventScroll: true });
}

/** Focuses a popover's `field` and brings its popover into view: a send or a walk held back for it shows it. */
export function revealField(field: HTMLTextAreaElement): void {
  field.focus({ preventScroll: true });
  field.closest(POPOVER)?.scrollIntoView({ block: "nearest" });
}

/** The pins of saved comments in `scope` (not the provisional one), in reading order (the document's), `within` a selector when given. */
export function savedPins(scope: ParentNode, within?: string): HTMLElement[] {
  const pin = `.${PIN_CLASS}[${PIN_ID_ATTR}]:not(.${PENDING_PIN_CLASS})`;
  return [...scope.querySelectorAll<HTMLElement>(within === undefined ? pin : `${within} ${pin}`)];
}

/** The pin of saved comment `id` in `scope`; null where it is not drawn. */
export function pinById(scope: ParentNode | null, id: string): HTMLElement | null {
  if (scope === null) return null;
  return [...scope.querySelectorAll<HTMLElement>(`.${PIN_CLASS}[${PIN_ID_ATTR}]`)].find((pin) => pin.dataset.commentId === id) ?? null;
}

/** The anchors of the pins in the comment surface `scope`, in reading order (the pins' order in the document). */
export function pinAnchors(scope: ParentNode | null): string[] {
  if (scope === null) return [];
  return [...scope.querySelectorAll<HTMLElement>(PIN_WITH_ANCHOR)].map((pin) => pin.dataset.commentAnchor!);
}

/**
 * The first of the pins at `anchors` (in order of preference, `focusAfter`) in the comment surface `scope`: where the
 * focus goes after a comment is deleted. Null for none.
 */
export function firstPin(scope: ParentNode | null, anchors: readonly string[]): HTMLElement | null {
  if (scope === null) return null;
  const pins = [...scope.querySelectorAll<HTMLElement>(PIN_WITH_ANCHOR)];
  for (const anchor of anchors) {
    const pin = pins.find((found) => found.dataset.commentAnchor === anchor);
    if (pin !== undefined) return pin;
  }
  return null;
}

/** The pin of the comment at `anchor` in `scope`; null where it is not drawn. */
export function pinByAnchor(scope: ParentNode | null, anchor: string): HTMLElement | null {
  return firstPin(scope, [anchor]);
}
