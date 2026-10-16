import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { blockComments } from "../lib/blockComments.ts";
import { focusOpenField } from "../lib/commentDom.ts";
import { measureFileSelection } from "../lib/fileCommentDom.ts";
import { watchFileCommentHighlights } from "../lib/fileCommentHighlight.ts";
import { fileCommentAt, linesText, type FileComment, type FileTarget } from "../lib/fileComments.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { DiffCommentEditor } from "./DiffViewer.tsx";
import type { FileComments, FileCommentScope } from "./FileComments.tsx";
import { useCommentPopover } from "./useCommentPopover.ts";
import { useSelectionComment } from "./useSelectionComment.ts";
import "./SelectionComment.css";

/** Rendered Markdown keeps native text selection and offers an explicit Comment action. */
export function PreviewComments({ scope, comments, preview, surface, connected, initialId, requestKey }: {
  scope: FileCommentScope; comments: FileComments; preview: RefObject<HTMLDivElement | null>;
  surface: RefObject<HTMLDivElement | null>; connected: boolean; initialId: string | null; requestKey: number;
}) {
  const t = useT();
  const { settings } = useSettings();
  const popover = useCommentPopover<FileTarget>({ enabled: settings.comments, persist: (owner, target, value) => { blockComments.saveFile(owner, target, value); } });
  const marks = useRef<ReturnType<typeof watchFileCommentHighlights> | null>(null);
  useLayoutEffect(() => {
    if (!preview.current || !surface.current || !settings.comments) return;
    const watching = watchFileCommentHighlights(surface.current, preview.current);
    marks.current = watching;
    return () => { watching.dispose(); marks.current = null; };
  }, [preview, surface, settings.comments]);
  useLayoutEffect(() => {
    marks.current?.show(comments.shown.filter(({ comment }) => comment.view === "preview").map(({ comment, lines }) => ({ ...comment, lines })));
    marks.current?.setPending(popover.open === null ? null : { id: "preview-pending", ...popover.open.target });
  }, [comments.shown, popover.open, settings.comments]);
  const selection = useSelectionComment({ view: preview, enabled: settings.comments,
    measure: measureFileSelection,
    onComment: (found) => {
      if (found.lines[1] > scope.loaded) return;
      const target: FileTarget = { path: scope.path, label: scope.label, view: "preview", ...found, source: scope.lines.slice(found.lines[0] - 1, found.lines[1]) };
      if (!popover.show(scope.owner, target, fileCommentAt(comments.all, target) ?? null, true)) focusOpenField(surface.current);
    },
  });
  function edit(comment: FileComment): void {
    if (!popover.show(scope.owner, { ...comment, anchor: comment.anchor }, comment)) focusOpenField(surface.current);
  }
  const opened = useRef("");
  useEffect(() => {
    if (!initialId || opened.current === `${initialId}:${requestKey}`) return;
    const comment = comments.all.find((comment) => comment.id === initialId && comment.view === "preview");
    if (!comment) return;
    opened.current = `${initialId}:${requestKey}`;
    edit(comment);
  }, [initialId, requestKey, comments.all]);
  if (!settings.comments) return null;
  return <div className="preview-comments">
    {selection.action !== null && <button type="button" className="btn comment-selection"
      style={{ left: selection.action.left, top: selection.action.top }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => { event.stopPropagation(); selection.activate(); }}>{t("Comment")}</button>}
    {comments.all.filter((comment) => comment.view === "preview" && comment.id !== popover.open?.commentId).map((comment) => <button type="button" className="diff-comment-card" key={comment.id} onClick={() => edit(comment)}>
      <span>{comment.label}:{linesText(comment.lines)}</span><span>{comment.comment}</span>
    </button>)}
    {popover.open !== null && <DiffCommentEditor key={popover.open.id} open={popover.open} connected={connected} text={popover.text}
      reveal onSave={popover.save} onClose={popover.close} onDelete={popover.remove} />}
  </div>;
}
