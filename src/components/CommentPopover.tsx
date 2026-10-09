/**
 * The open comment of a comment surface (useCommentPopover.ts): beside its pin (`placement`
 * "popover", drawn in place by CommentPins.tsx inside the scrolling content), or as a dialog of its
 * own, centred and a bottom sheet on a phone (`placement` "dialog", portalled here). Every comment
 * opens to be edited, as in Claude: a saved one straight into its field, filled with its text, a
 * new one into an empty field. Top to bottom: the file and lines a comment on a file is on, and why
 * it is shown here, with the quote (at most about five lines), and beside them at the right ✕ (a
 * dialog's and a sheet's only: beside its pin there is none). Beside its pin there is no quote, new
 * or saved (the highlighted text beside it shows it): the card is the input box (a file comment's
 * file and lines are said to assistive tech only). Then the field, bare in the card, and a row under it with a saved
 * comment's Delete at the left and the ↑ save button at the right (`useCommentDraft`).
 *
 * Nothing typed is ever lost: Escape, a press outside it (beside its pin) or on the scrim (a
 * dialog) and ✕ (where there is one) close it only while its text is unchanged; otherwise each
 * puts the focus back in the field. Such a press does nothing else: its click opens no comment where it
 * lands (`markDismissingPress`; a drag it starts opens its selection's), but a press on another pin opens that pin's comment. Cmd/Ctrl+Enter saves, Enter is a line break. Delete is
 * immediate, without an undo. The field takes the focus as it opens, its caret at the end, but for
 * a saved comment on a touch screen (`popoverFocusesField`): there the box does, and no keyboard
 * rises until the field is tapped. On close the focus goes back to the `opener` (its pin, found
 * again after the commit), else to the `fallback` (the pane's composer), not on a touch screen:
 * `restoreFocusTarget`. A dialog keeps Tab inside (`useFocusTrap`).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Trash2, X } from "lucide-react";

import "./CommentPopover.css";

import { blockContent } from "../lib/blockComments.ts";
import { markDismissingPress } from "../lib/commentClick.ts";
import { changedAttrs, inPinLayer, POPOVER_CLASS, POPOVER_SCRIM_CLASS } from "../lib/commentDom.ts";
import { popoverFocusesField } from "../lib/commentPopover.ts";
import { useT } from "../lib/i18n.ts";
import type { MarkdownBlock } from "../lib/markdown.ts";
import { isMacPlatform } from "../lib/shortcuts.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { CommentField, inAnotherDialog, useCommentDraft } from "./CommentDraft.tsx";
import type { PopoverPlacement } from "./CommentPins.tsx";
import { FileReferenceLabel, type FileReference } from "./FileReference.tsx";
import { MarkdownBlocks } from "./Markdown.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";

export interface CommentPopoverProps {
  placement: PopoverPlacement;
  quote: { text: string } | { block: MarkdownBlock };
  reference?: FileReference;
  /** why it is shown here (an outdated file comment) */
  note?: string;
  /** the saved comment; "" for a new one */
  comment: string;
  /** the field's text when it is not `comment`: what was typed before a redraw */
  startValue?: string;
  onText?: (value: string) => void;
  onSave: (text: string) => void;
  /** a saved comment's Delete; a new one has none */
  onDelete: () => void;
  onClose: () => void;
  /** where the focus goes back to: the pin, found again after the commit */
  opener: (scope: Element | null) => HTMLElement | null;
  /** where it goes when the opener is gone: the pane's composer, or null */
  fallback: (scope: Element | null) => HTMLElement | null;
}

interface FrameProps {
  placement: PopoverPlacement;
  surface: RefObject<HTMLDivElement>;
  /** the box takes the focus itself (a saved comment opened on a touch screen: its field does not) */
  focusable: boolean;
  /** its text is changed (`commentChanged`): the composer's Send comes here first (`data-comment-changed`) */
  changed: boolean;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /**
   * a press outside it, beside its pin, or on a dialog's scrim: closes it where nothing would be lost (true); false
   * where it keeps it, the focus back in its field, and the press then moves the focus nowhere else
   */
  dismiss: () => boolean;
  children: ReactNode;
}

/**
 * The box of the popover. Beside its pin it lies in the surface's scrolling content, and a press
 * anywhere outside it but on a pin (whose own click decides, through `show`) is a `dismiss`. As a
 * dialog it is the shared modal primitive, a bottom sheet at phone width with a grip, and a press
 * on the scrim is a `dismiss`; it is the topmost focus trap then (`useFocusTrap`), so a dialog it
 * lies over (the file viewer) does not pull Tab out of it. Where the focus goes as it closes is
 * the popover's own to say (`restoreFocusTarget`), not the trap's.
 */
function Frame({ placement, surface, focusable, changed, onKeyDown, dismiss, children }: FrameProps): JSX.Element {
  const t = useT();
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const dialog = placement === "dialog";
  const trap = useFocusTrap<HTMLDivElement>(dialog, { shouldRestore: () => false });
  const setBox = useCallback((node: HTMLDivElement | null): void => {
    (surface as MutableRefObject<HTMLDivElement | null>).current = node;
    trap.current = node;
  }, [surface, trap]);
  useEffect(() => {
    if (placement !== "popover") return;
    // a press the popover kept (text typed) gave the focus back to its field: its `mousedown`, which comes after, would
    // move it to what was pressed (or the body), so its default is held back
    let kept = false;
    // nor is a press in a modal dialog that lies over the surface (Settings, a question, the file viewer): that one's own
    const outside = (event: Event): boolean => {
      const target = event.target;
      if (!(target instanceof Node) || (surface.current?.contains(target) ?? false) || inAnotherDialog(target, surface.current)) return false;
      return !inPinLayer(target);
    };
    // a press outside it only dismisses it: closed, or kept with the focus back in its field. Its click opens nothing else, no
    // comment on the block or line under it (`markDismissingPress`); a drag it starts opens its own selection's (`useSelectionComment`). A press on a pin
    // is not one: that pin's comment opens in its place (`show`)
    const onPointer = (event: PointerEvent): void => {
      if (!outside(event)) { kept = false; return; }
      markDismissingPress(event);
      kept = !dismissRef.current();
    };
    const onMouse = (event: MouseEvent): void => {
      if (kept && outside(event)) event.preventDefault();
      kept = false;
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("mousedown", onMouse, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mousedown", onMouse, true);
    };
  }, [placement, surface]);

  const box = (
    <div
      ref={setBox}
      className={dialog ? `modal ${POPOVER_CLASS}` : POPOVER_CLASS}
      role="dialog"
      aria-modal={dialog ? true : undefined}
      aria-label={t("Comment")}
      tabIndex={focusable ? -1 : undefined}
      {...changedAttrs(changed)}
      onKeyDown={onKeyDown}
    >
      {dialog && <span className="comment-popover-grip" aria-hidden="true" />}
      {children}
    </div>
  );
  if (!dialog) return box;
  // a portal's events still bubble through the React tree: a click on the scrim or in the dialog would reach the
  // surface's block-click handler (ChatView, FileViewer) and open a comment on whatever block is under it. Not
  // `.modal-scrim` in COMMENT_CLICK_IGNORED: the file viewer itself lies in one. A press on the scrim the dialog kept
  // (text typed) leaves the focus in its field
  return createPortal(
    <div className={`modal-scrim ${POPOVER_SCRIM_CLASS}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !dismissRef.current()) event.preventDefault(); }} onClick={(event) => event.stopPropagation()}>{box}</div>,
    document.body,
  );
}

/**
 * The popover's top row: what the comment is on (the file and lines with why it is shown here, then the `quote`,
 * scrolling past about five lines; none where the highlighted text beside it already shows it), and its `actions`
 * (a dialog's ✕) at the right, level with the first line.
 */
function Top({ quote, reference, note, actions }: Pick<CommentPopoverProps, "reference" | "note"> & {
  quote: CommentPopoverProps["quote"] | null;
  actions: ReactNode | null;
}): JSX.Element {
  return <div className="comment-popover-top">
    <div className="comment-popover-context">
      {reference !== undefined && <p className="comment-popover-reference"><FileReferenceLabel reference={reference} /></p>}
      {note !== undefined && <p className="comment-popover-note">{note}</p>}
      {quote !== null && <Quote quote={quote} reference={reference} />}
    </div>
    {actions !== null && <div className="comment-popover-actions">{actions}</div>}
  </div>;
}

function Quote({ quote, reference }: Pick<CommentPopoverProps, "quote" | "reference">): JSX.Element {
  return <>
    <div className="comment-popover-quote">
      {"text" in quote
        ? reference !== undefined ? <pre className="comment-popover-plain">{quote.text}</pre> : <p className="comment-popover-plain">{quote.text}</p>
        // a stored block comes from localStorage, maybe from another version: one that cannot be drawn shows as text
        : <RenderBoundary resetKey={quote.block} fallback={() => <p className="comment-popover-plain">{blockContent(quote.block)}</p>}>
          <MarkdownBlocks blocks={[quote.block]} quoted />
        </RenderBoundary>}
    </div>
  </>;
}

/**
 * The popover of one opening: a new comment, or a saved one, to edit. A caller keys it by the opening
 * (`OpenComment.id`), so another comment opened is another popover.
 */
export function CommentPopover({ placement, quote, reference, note, comment, startValue, onText, onSave, onDelete, onClose, opener, fallback }: CommentPopoverProps): JSX.Element {
  const t = useT();
  const saved = comment !== "";
  const inline = placement === "popover";
  // decided as it opens: a saved comment tapped open on a touch screen raises no keyboard (`popoverFocusesField`)
  const [focusField] = useState(() => popoverFocusesField(saved, window.matchMedia("(pointer: coarse)").matches));
  const draft = useCommentDraft(comment, onSave, onClose, { opener, fallback, inline, focusField, startValue, onText });
  const saveTitle = `${t("Save comment")} (${isMacPlatform() ? "⌘↵" : "Ctrl+Enter"})`;
  // beside its pin there is no ✕, as in Claude: Escape and a press outside close it while its text is unchanged. A
  // dialog, and a phone's sheet, keep ✕, the one visible way out where a keyboard covers the page; with a change typed
  // it only puts the focus back in the field
  // beside its pin the card is the input box alone, new or saved: what it is on is
  // the highlighted text beside it. A dialog and a sheet, with that text out of view or under them, quote it
  const quoted = inline ? null : quote;
  const actions = inline ? null : <button type="button" className="icon-button comment-popover-action" aria-label={t("Close")} title={t("Close")} onClick={draft.leave}>
    <X aria-hidden="true" />
  </button>;
  return <Frame placement={placement} surface={draft.surface} focusable={!focusField} changed={draft.changed} onKeyDown={draft.onKeyDown} dismiss={draft.leave}>
    {/* beside its pin the card is the field alone: a file comment's file and lines are no matter while it is written (the
        pin stands on the text), so they are only said to assistive tech; a dialog and a sheet show them over the quote */}
    {inline
      ? reference !== undefined && <p className="comment-popover-reference visually-hidden"><FileReferenceLabel reference={reference} /></p>
      : <Top quote={quoted} reference={reference} note={note} actions={actions} />}
    <div className="comment-popover-edit">
      <CommentField draft={draft} />
      <div className="comment-popover-edit-footer">
        {/* always in view, never behind a menu: immediate, the focus handed on to the next pin as it closes (useCommentSurface.tsx) */}
        {saved && <button type="button" className="icon-button comment-popover-delete" aria-label={t("Delete comment")} title={t("Delete comment")} onClick={onDelete}>
          <Trash2 aria-hidden="true" />
        </button>}
        <button type="button" className="comment-popover-save" aria-label={t("Save comment")} title={saveTitle} disabled={!draft.canSave} onClick={draft.save}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </div>
  </Frame>;
}
