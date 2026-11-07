/**
 * The detection of a click that comments on a comment surface (the chat, the file viewer's body), for
 * useCommentSurface.tsx. The surface keeps what a click comments on: the chat a reply block or a part of one, the
 * viewer a line.
 */
import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { clickFacts, isCommentClick, isDismissingPress, typingOnTouch, type ClickFacts } from "../lib/commentClick.ts";
import { isCommentUi } from "../lib/commentDom.ts";

/** The handlers of a click on a comment surface, for the element that holds it (`useCommentClick`). */
export interface CommentClickHandlers {
  onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/**
 * Finds the click that comments on a surface (`isCommentClick`: a plain single click, on nothing interactive, that ends
 * no selection) and hands its target and where it landed on (`onComment`); the handlers go on the element that holds the
 * surface.
 *
 * A tap that puts a phone's keyboard away opens nothing: whether a field had the focus is read as the press comes down
 * (a press on text takes the focus from the field before the click), and again as the click comes down, before the
 * surface's own tap handler (`dismissKeyboardOn`, a listener on this element, which React's bubbling handler runs after)
 * blurs it. A double click goes on to select a word: a new comment the first click opened, with nothing typed, closes
 * (`closesOnDoubleClick`). A click in the dialog's portal never gets here (CommentPopover stops it at its scrim).
 *
 * A press that dismissed an open popover (a press outside it, `isDismissingPress`) only did that: its click opens
 * nothing, nor closes anything more. The mark is read off the press's own event, as it comes down, and a later press
 * reads its own, so it never outlives that click.
 */
export function useCommentClick({ enabled, closesOnDoubleClick, close, onComment }: {
  /** comments are on and the surface takes them */
  enabled: boolean;
  /** the open popover is a new comment with nothing typed in it, which a double click closes */
  closesOnDoubleClick: () => boolean;
  close: () => void;
  /** a plain single click on `target`, at the client point `at`: open the comment of what it lands on, its pin there */
  onComment: (target: Element, at: { x: number; y: number }) => void;
}): CommentClickHandlers {
  const pressedTyping = useRef(false);
  // the press dismissed an open popover (CommentPopover.tsx marks it on the document, before this runs)
  const pressedDismissing = useRef(false);
  const clicked = useRef<{ event: Event; facts: ClickFacts } | null>(null);
  return {
    onPointerDownCapture: (event) => {
      pressedTyping.current = enabled && typingOnTouch();
      pressedDismissing.current = isDismissingPress(event.nativeEvent);
    },
    onClickCapture: (event) => {
      const facts = clickFacts(event.nativeEvent);
      clicked.current = enabled && !pressedDismissing.current ? { event: event.nativeEvent, facts: pressedTyping.current ? { ...facts, dismissesKeyboard: true } : facts } : null;
      pressedTyping.current = false;
      pressedDismissing.current = false;
    },
    onClick: (event) => {
      const seen = clicked.current;
      clicked.current = null;
      if (!enabled || seen === null || seen.event !== event.nativeEvent) return;
      if (event.detail >= 2) {
        // a double click in the popover itself (its field, a word of its quote) or on a pin selects there, and closes nothing
        const onPopover = isCommentUi(event.target);
        if (!onPopover && closesOnDoubleClick()) close();
        return;
      }
      if (!isCommentClick(seen.facts)) return;
      if (event.target instanceof Element) onComment(event.target, { x: event.clientX, y: event.clientY });
    },
  };
}
