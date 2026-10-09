/**
 * The file viewer's comment layer: comments on lines of the file the viewer shows, kept with the
 * pane it was opened from. It finds this file's comments in the pane's store and places each one
 * on the lines it was written on, or where those lines moved (`placeFileComment`); one that is
 * nowhere to be found is outdated. It highlights what each comment is on, and shows a pin on each
 * comment's text, where it was made or after its end (CommentPins.tsx, as in the chat). The viewer's one comment popover
 * (`useCommentSurface`) is opened by a pin, by a mouse's drag over text, or by a click or tap on a line (the code
 * view's line, the preview's line element; a preview paragraph is one block). The
 * viewer's header walks the file's comments (`useFileCommentWalk`), an outdated one in a dialog.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { blockComments, isReplyComment, quoteExcerpt, useBlockComments } from "../lib/blockComments.ts";
import { markCurrentComment, PENDING_COMMENT_ID, showWalkStop } from "../lib/commentHighlight.ts";
import { changedField, pinById, revealField } from "../lib/commentDom.ts";
import { popoverOutlived } from "../lib/commentPopover.ts";
import { pointOnText } from "../lib/commentSelection.ts";
import { lastFileStop } from "../lib/commentWalk.ts";
import { clickedLines, lineElementsIn, lineRanges, measureFileSelection, unfoldAt } from "../lib/fileCommentDom.ts";
import { watchFileCommentHighlights } from "../lib/fileCommentHighlight.ts";
import { fileAnchor, fileCommentAt, placeFileComment, sortFileComments, type FileComment, type FileTarget, type FileView, type LineRange } from "../lib/fileComments.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { CommentPopover } from "./CommentPopover.tsx";
import { useCommentSurface, type CommentSurfaceProps, type SurfaceComment } from "./useCommentSurface.tsx";

/** The file a viewer shows comments on, and of which pane. */
export interface FileCommentScope {
  /** the pane's store owner, `paneStorageId(machineId, paneId)` */
  owner: string;
  /** absolute, as the viewer resolved it (`FileInfo.path`) */
  path: string;
  /** how a quote names the file (`pathLabel`) */
  label: string;
  view: FileView;
  /** the file's lines as loaded (`fileLines`) */
  lines: readonly string[];
  /** how many leading lines are complete: a file cut at the load limit takes comments up to its cut */
  loaded: number;
  /** whether the file was cut at the load limit: then a comment stays on its lines or is outdated, never moved (`placeFileComment`) */
  truncated: boolean;
}

/** A comment of the file with the lines it is on now. */
export interface PlacedFileComment {
  comment: FileComment;
  lines: LineRange;
}

/** The comments of a file in its pane, as placed in the file loaded (`useFileComments`). */
export interface FileComments {
  /** placed, and of the view shown */
  shown: PlacedFileComment[];
  /** their lines are nowhere in the loaded file */
  outdated: FileComment[];
  /** every comment of the file, of either view */
  all: FileComment[];
}

/** A selection in the file the viewer can comment on (`measureFileSelection`). */
type MeasuredFileSelection = ReturnType<typeof measureFileSelection> & {};

/** Bound once: a class method handed on loses its `this`. */
const persistFile = blockComments.saveFile.bind(blockComments);

/**
 * The target a stored comment was written on, to edit it: with its stored anchor, so the edit
 * replaces this comment wherever a move left it (`saveFile`), never the one now on its lines' anchor.
 */
function targetOf(comment: FileComment): FileTarget {
  const { path, label, view, lines, source, quoteLines, selection, anchor, point } = comment;
  return { path, label, view, lines, source, quoteLines, anchor, ...(selection === undefined ? {} : { selection }), ...(point === undefined ? {} : { point }) };
}

/**
 * `target` with the point `at` (client pixels; none: none) on the text its highlight will cover in `root` (the lines'
 * ranges, as `watchFileCommentHighlights` builds them): where a new comment's pin goes.
 */
function pointed(root: Element, target: FileTarget, at: { x: number; y: number } | undefined): FileTarget {
  const point = at === undefined ? undefined : pointOnText(lineRanges(lineElementsIn(root, target.lines), target.selection), at);
  return point === undefined ? target : { ...target, point };
}

/** The anchor the pin of a comment on `target` carries: a stored comment's own, else the one a save gives it (`saveFile`). */
const anchorOf = (target: FileTarget): string => target.anchor ?? fileAnchor(target);

/**
 * The comments of `scope`'s file in its pane: those shown (placed, of this view), those outdated
 * (their lines are nowhere in the loaded file) and all of them. Placing runs again only when the
 * comments or the file's lines change. A comment found again on other lines is moved there in the
 * store, once, so the next message names the lines it is on now. With comments turned off the
 * store lists none (`BlockCommentStore.setEnabled`): the file has none, and nothing stored is moved,
 * so what another tab that still has them on stores meanwhile is left as it is.
 */
export function useFileComments(scope: FileCommentScope | null): FileComments {
  const comments = useBlockComments(scope?.owner ?? "");
  const owner = scope?.owner;
  const path = scope?.path;
  const view = scope?.view;
  const lines = scope?.lines;
  const loaded = scope?.loaded ?? 0;
  const truncated = scope?.truncated ?? false;
  const all = useMemo(() => path === undefined ? [] : comments.filter((c): c is FileComment => !isReplyComment(c) && c.path === path), [comments, path]);
  const placed = useMemo(() => all.map((comment) => ({ comment, lines: lines === undefined ? null : placeFileComment(comment, lines, loaded, truncated) })), [all, lines, loaded, truncated]);
  const moved = useRef(new Set<string>());
  useEffect(() => {
    if (owner === undefined) return;
    for (const { comment, lines: now } of placed) {
      if (now === null || (now[0] === comment.lines[0] && now[1] === comment.lines[1])) continue;
      const key = `${comment.id}:${now[0]}-${now[1]}`;
      if (moved.current.has(key)) continue;
      moved.current.add(key);
      blockComments.moveFile(owner, comment.id, now);
    }
  }, [owner, placed]);
  return useMemo(() => ({
    shown: placed.filter((p): p is PlacedFileComment => p.lines !== null && p.comment.view === view),
    outdated: placed.filter((p) => p.lines === null).map((p) => p.comment),
    all,
  }), [placed, view, all]);
}

/**
 * The comment layer of the viewer's `surface` (its scrolling body) over the file's `content` (the code's `<pre>`, or the
 * preview's `.markdown` root), for `scope`'s file; the view takes no comments while `scope` is null. The comments are
 * wired by `useCommentSurface`: a click on a line comments on all of it, as a click on a reply's block does in the chat,
 * among the lines loaded whole (`clickedLines`); a mouse's drag over text on what it selected (`measureFileSelection`).
 * `overlay` goes into the surface (the pins with the open
 * popover); `surfaceProps` go on the surface; `escape` is the viewer's Escape asked first (`popoverEscape`): it closes
 * an open popover with its text unchanged, wherever the focus is, and keeps a changed one, its field taking the focus
 * back, so the viewer never closes and loses that text; true while a popover had it, and the viewer then stays;
 * `comments` are the file's comments as placed, for the header's counter and walk (none while comments are off).
 */
export function useFileCommentLayer(scope: FileCommentScope | null, surface: RefObject<HTMLDivElement>, content: RefObject<HTMLElement>): {
  overlay: ReactNode;
  surfaceProps: CommentSurfaceProps;
  escape: () => boolean;
  comments: FileComments;
} {
  const t = useT();
  const { settings } = useSettings();
  const comments = useFileComments(scope);
  const { shown } = comments;
  // read as a click or a drag lets go, which comes after the render that drew what it landed on
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const owner = scope?.owner ?? null;
  const path = scope?.path ?? null;
  const view = scope?.view ?? null;

  // a pin for each comment shown, named as the comment
  const surfaceComments = useMemo<SurfaceComment<FileTarget>[]>(() => shown.map(({ comment }) => ({
    id: comment.id,
    anchor: comment.anchor,
    label: t("Comment on “{quote}”: {comment}", { quote: quoteExcerpt(comment.selection?.text ?? comment.quoteLines.join(" ")), comment: comment.comment }),
    ...(comment.point === undefined ? {} : { point: comment.point }),
    target: targetOf(comment),
    comment: comment.comment,
  })), [shown, t]);

  /** The target `found` lines make in the file loaded; null without a scope, or on the cut-off last line of a file cut short. */
  const linesTarget = (found: { lines: LineRange; quoteLines: string[]; selection?: FileTarget["selection"] }): { owner: string; target: FileTarget } | null => {
    const current = scopeRef.current;
    if (current === null || found.lines[1] > current.loaded) return null;
    return {
      owner: current.owner,
      target: {
        path: current.path, label: current.label, view: current.view, lines: found.lines,
        source: current.lines.slice(found.lines[0] - 1, found.lines[1]), quoteLines: found.quoteLines,
        ...(found.selection === undefined ? {} : { selection: found.selection }),
      },
    };
  };

  // the new comment being written on this file and view, shown pending by the highlights' watcher (below). One opened on
  // another file or view (the viewer moved on meanwhile) is not on these lines
  const pendingRef = useRef<{ owner: string; target: FileTarget } | null>(null);
  const watcher = useRef<ReturnType<typeof watchFileCommentHighlights> | null>(null);
  const applyPending = (): void => {
    const pending = pendingRef.current;
    const current = scopeRef.current;
    const here = pending !== null && current !== null && pending.owner === current.owner && pending.target.path === current.path && pending.target.view === current.view;
    watcher.current?.setPending(here ? { id: PENDING_COMMENT_ID, lines: pending.target.lines, selection: pending.target.selection } : null);
  };

  const { overlay, surfaceProps, escape } = useCommentSurface<FileTarget, MeasuredFileSelection>({
    surface,
    enabled: settings.comments,
    active: scope !== null,
    // only while the content is drawn: with none, a click opens nothing and a double click closes nothing either
    drawn: () => content.current !== null,
    persist: persistFile,
    owner,
    comments: surfaceComments,
    anchorOf,
    // the comment written there already (`fileCommentAt`, as the store finds it on save), as itself: an edit replaces
    // it, and its pin is found by its own anchor where it was
    existing: (targetOwner, target) => {
      const found = fileCommentAt(blockComments.list(targetOwner).filter((c): c is FileComment => !isReplyComment(c)), target);
      return found === undefined ? null : { id: found.id, comment: found.comment, target: targetOf(found) };
    },
    pointed: (_owner, target, at) => {
      const root = content.current;
      return root === null ? target : pointed(root, target, at);
    },
    targetAtClick: (element) => {
      const root = content.current;
      const found = root === null ? null : clickedLines(root, element);
      return found === null ? null : linesTarget(found);
    },
    selection: {
      // a selection in the loaded lines of the file; one in a popover, or on the cut-off last line, is none
      measure: (selection) => {
        const root = content.current;
        const found = root === null ? null : measureFileSelection(selection, root);
        return found !== null && found.lines[1] <= (scopeRef.current?.loaded ?? 0) ? found : null;
      },
      target: linesTarget,
    },
    describe: ({ target, commentId }) => ({
      quote: { text: target.quoteLines.join("\n") },
      // a stored comment is named by the lines it is on now
      reference: { path: target.path, lines: (commentId === null ? undefined : shown.find(({ comment }) => comment.id === commentId)?.lines) ?? target.lines },
    }),
    // a Delete with no pin left lets the focus go: the viewer has no composer
    focusFallback: () => null,
    showPending: (targetOwner, target) => {
      pendingRef.current = { owner: targetOwner, target };
      applyPending();
      return () => {
        pendingRef.current = null;
        applyPending();
      };
    },
  });

  // the content as drawn now: another one (a view switched, a file reloaded) is watched anew
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setRoot(scope === null ? null : content.current); });

  // what each comment is on is highlighted, and the lines a new comment is being written on (`showPending` above, in
  // the commit that opens it, before its popover is placed: CommentPins waits for this highlight to put the provisional
  // pin and the popover beside it)
  useLayoutEffect(() => {
    const body = surface.current;
    if (root === null || body === null) return;
    const watching = watchFileCommentHighlights(body, root);
    watcher.current = watching;
    return () => {
      watching.dispose();
      if (watcher.current === watching) watcher.current = null;
    };
  }, [root, surface]);
  const marks = useMemo(() => shown.map(({ comment, lines }) => ({ id: comment.id, lines, selection: comment.selection })), [shown]);
  useLayoutEffect(() => { watcher.current?.show(marks); }, [marks, root]);
  // a new watcher, or another file or view: the pending comment is shown again where it is on these lines, else not
  useLayoutEffect(applyPending, [root, owner, path, view]);

  return { overlay, surfaceProps, escape, comments };
}

/** How long a stop waits for its pin to be drawn (a view switched, a code block unfolded, the pins placed) before it gives up. */
const STOP_WAIT_MS = 1000;

/**
 * The walk through the comments of the viewer's file, one stop per tap of the header's counter, in
 * the order they are sent (`sortFileComments`), from the one after the stop visited last
 * (`lastFileStop`), wrapping. A stop on a comment written in the other view switches the view
 * (`showView`) and goes on once its pin is drawn; a code block of the preview that folds its lines
 * away is unfolded first (`unfoldAt`). A stop opens its pin's popover to edit (`pin.click()`) and marks the
 * pin current, scrolled to (`showWalkStop`); an outdated one opens in a dialog, its field filled, with a note that its
 * part of the file has changed, and one whose pin is not drawn within `STOP_WAIT_MS` without a note. `goTo` is one stop, by comment id; `openInEditor` opens a stored
 * comment in that dialog with another note, where its file cannot be shown to place it (the viewer
 * opened at it on a file it cannot read); `editor` goes into the viewer, and `editorOpen` keeps its
 * Escape for the dialog. The dialog closes as the popover does: with comments turned off, and, while
 * nothing is typed in it, once its comment is no longer stored.
 */
export function useFileCommentWalk({ owner, view, comments, surface, content, showView }: {
  /** the pane's store owner; null without a pane */
  owner: string | null;
  /** the view shown now; null while it takes no comments */
  view: FileView | null;
  comments: FileComments;
  /** the viewer's body, the comment surface the pins are in */
  surface: RefObject<HTMLDivElement>;
  /** the file's content root in the view shown (the code's `<pre>`, the preview's `.markdown`) */
  content: RefObject<HTMLElement>;
  /** shows the file in `view` */
  showView: (view: FileView) => void;
}): { next: () => void; goTo: (id: string) => boolean; openInEditor: (comment: FileComment, note: string) => void; editor: ReactNode; editorOpen: boolean } {
  const t = useT();
  const { settings } = useSettings();
  // the comment open in the dialog, and why it is there rather than on its lines
  const [modal, setModal] = useState<{ opening: number; comment: FileComment; note?: string } | null>(null);
  const openings = useRef(0);
  // what its field holds (`onText`): a change typed keeps the dialog when its comment leaves the store
  const modalText = useRef("");
  // where the focus goes back to as the dialog closes: what had it as the dialog opened (the counter)
  const returnTo = useRef<HTMLElement | null>(null);
  const showModal = useCallback((comment: FileComment, note?: string): void => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalText.current = comment.comment;
    setModal({ opening: ++openings.current, comment, ...(note === undefined ? {} : { note }) });
  }, []);
  const stored = useBlockComments(owner ?? "");
  useEffect(() => {
    if (modal === null) return;
    if (!settings.comments || popoverOutlived({ commentId: modal.comment.id, initialComment: modal.comment.comment }, stored, modalText.current)) setModal(null);
  }, [modal, settings.comments, stored]);
  const latest = useRef({ owner, view, comments, showView, content });
  latest.current = { owner, view, comments, showView, content };
  // the stop's place in the walk where its id is gone (an edit gives a comment a new id)
  const position = useRef(-1);
  const frame = useRef(0);
  /** The pin the walk stands on (`is-current`, set by hand as the composer's walk does), until the next stop or a click. */
  const current = useRef<HTMLElement | null>(null);
  const clearCurrent = useCallback((): void => {
    const note = current.current;
    if (note === null) return;
    note.classList.remove("is-current");
    markCurrentComment(surface.current ?? note, null);
    current.current = null;
  }, [surface]);
  useEffect(() => {
    // a click, not a press, as in the composer's walk: in the capture phase, so the counter's own click clears the old mark first.
    // A stop still waiting for its pin is given up too: what was clicked meanwhile is not covered by a dialog later. The
    // stop's own clicks (its pin, a Show all) come while it is not waiting
    const onClick = (): void => {
      window.cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearCurrent();
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.cancelAnimationFrame(frame.current);
      clearCurrent();
    };
  }, [clearCurrent]);

  /**
   * Stands on the pin of comment `id` once it is drawn in the view shown: its lines unfolded first (`unfoldAt`), then
   * its popover opened and the pin marked; after `STOP_WAIT_MS` without one, the comment opens in the dialog. The scroll that brings the popover into
   * view waits for the walk's own (CommentPins.tsx).
   */
  const stopAt = useCallback((id: string): void => {
    window.cancelAnimationFrame(frame.current);
    const deadline = performance.now() + STOP_WAIT_MS;
    const attempt = (): void => {
      frame.current = 0;
      const body = surface.current;
      const root = latest.current.content.current;
      const placed = latest.current.comments.shown.find(({ comment }) => comment.id === id);
      const pin = body === null || root === null || placed === undefined || !unfoldAt(root, placed.lines[1]) ? null
        : pinById(body, id);
      if (body !== null && pin !== null) {
        clearCurrent();
        // its popover opens to edit, and its field takes the focus as it mounts. The pin is marked after the click:
        // the click is one, and the document's click listener above clears the mark
        pin.click();
        pin.classList.add("is-current");
        current.current = pin;
        showWalkStop(body, pin);
        return;
      }
      if (performance.now() < deadline) { frame.current = window.requestAnimationFrame(attempt); return; }
      // no pin by then (its text is not drawn: a line the preview has no element for, a view that did not switch):
      // it opens in the dialog, as a comment without a pin does
      const comment = latest.current.comments.all.find((c) => c.id === id);
      if (comment !== undefined) showModal(comment);
    };
    attempt();
  }, [surface, clearCurrent, showModal]);

  const goTo = useCallback((id: string): boolean => {
    const { owner, view, comments, showView } = latest.current;
    const comment = comments.all.find((c) => c.id === id);
    if (owner === null || comment === undefined) return false;
    lastFileStop.set(owner, id);
    window.cancelAnimationFrame(frame.current);
    clearCurrent();
    if (comments.outdated.some((c) => c.id === id)) {
      showModal(comment, t("This part of the file has changed since."));
      return true;
    }
    if (comment.view !== view) showView(comment.view);
    stopAt(id);
    return true;
  }, [clearCurrent, stopAt, showModal, t]);

  const openInEditor = useCallback((comment: FileComment, note: string): void => {
    const { owner } = latest.current;
    if (owner === null) return;
    lastFileStop.set(owner, comment.id);
    window.cancelAnimationFrame(frame.current);
    clearCurrent();
    showModal(comment, note);
  }, [clearCurrent, showModal]);

  const next = useCallback((): void => {
    const { owner, comments } = latest.current;
    if (owner === null) return;
    // a comment being written keeps its place: the walk gives the focus back to it, as the composer's does
    const unsaved = changedField(surface.current);
    if (unsaved !== null) {
      revealField(unsaved);
      return;
    }
    const stops = sortFileComments(comments.all);
    if (stops.length === 0) return;
    const last = lastFileStop.get(owner);
    const found = stops.findIndex((c) => c.id === last);
    const at = ((found >= 0 ? found : position.current) + 1) % stops.length;
    position.current = at;
    goTo(stops[at]!.id);
  }, [goTo, surface]);

  const closeEditor = useCallback(() => setModal(null), []);
  const editor = owner !== null && modal !== null && settings.comments && <CommentPopover
    key={modal.opening}
    placement="dialog"
    quote={{ text: modal.comment.quoteLines.join("\n") }}
    reference={{ path: modal.comment.path, lines: modal.comment.lines }}
    note={modal.note}
    comment={modal.comment.comment}
    onText={(text) => { modalText.current = text; }}
    onSave={(text) => {
      // an edit gives the comment a new id: the walk goes on from it
      const saved = persistFile(owner, targetOf(modal.comment), text);
      if (saved !== null) lastFileStop.set(owner, saved);
      setModal(null);
    }}
    onDelete={() => {
      blockComments.remove(owner, [modal.comment.id]);
      setModal(null);
    }}
    onClose={closeEditor}
    // asked after the commit that closes it: what had the focus as it opened (the counter), while it is still there
    opener={() => returnTo.current?.isConnected ? returnTo.current : null}
    fallback={() => null}
  />;
  return { next, goTo, openInEditor, editor, editorOpen: modal !== null };
}
