import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, MessageSquarePlus, Trash2, X } from "lucide-react";
import { FileDiff, useStableCallback, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import { parseDiffFromFile, type DiffLineEventBaseProps } from "@pierre/diffs";
import type { GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";
import { blockComments, useBlockComments } from "../lib/blockComments.ts";
import { changedAttrs, focusOpenField } from "../lib/commentDom.ts";
import { diffCommentTarget } from "../lib/diffComments.ts";
import { fileAnchor, fileCommentAt, linesText, type FileComment, type FileTarget } from "../lib/fileComments.ts";
import { popoverChanged } from "../lib/commentPopover.ts";
import { PIERRE_THEME } from "../lib/pierreTheme.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { CommentField, useCommentDraft } from "./CommentDraft.tsx";
import { useCommentPopover, type OpenComment } from "./useCommentPopover.ts";
import { MicButton, VoiceRecordingPill } from "./VoiceInput.tsx";
import "./DiffViewer.css";

function DiffCommentEditor({ open, connected, text, onSave, onClose, onDelete }: {
  open: OpenComment<FileTarget>; connected: boolean; text: { read: () => string; write: (value: string) => void };
  onSave: (text: string) => void; onClose: () => void; onDelete: () => void;
}) {
  const t = useT();
  const draft = useCommentDraft(open.initialComment, onSave, onClose, {
    owner: open.owner, connected, inline: true, fallback: () => null, startValue: text.read(), onText: text.write,
  });
  const showDictation = draft.dictation.shown && (draft.dictation.voice.available || draft.dictation.voice.state !== "idle" || draft.dictation.recovery !== null);
  return <div ref={draft.surface} className="comment-popover diff-comment-editor" {...changedAttrs(draft.changed)} onKeyDown={draft.onKeyDown}>
    <div className="diff-comment-heading"><span>{open.target.label}:{linesText(open.target.lines)} · {open.target.diff?.side === "old" ? t("Old") : t("New")}</span>
      <button type="button" className="icon-button" aria-label={t("Close comment")} onClick={draft.leave}><X aria-hidden="true" /></button></div>
    <CommentField draft={draft} />
    <div className="diff-comment-actions">
      {open.commentId !== null && <button type="button" className="icon-button" aria-label={t("Delete comment")} onClick={() => { draft.dictation.cancel(); onDelete(); }}><Trash2 aria-hidden="true" /></button>}
      {showDictation && <MicButton dictation={draft.dictation} />}
      <span>{t("Saved comments are included with your next chat message.")}</span>
      <button type="button" className="icon-button" aria-label={t("Save comment")} disabled={!draft.canSave} onClick={draft.save}><ArrowUp aria-hidden="true" /></button>
    </div>
    {draft.note !== null && <p className="comment-dictation-note" role="alert">{draft.note}</p>}
    {showDictation && <VoiceRecordingPill dictation={draft.dictation} align="end" />}
  </div>;
}

/** Saved comparisons remain editable even after their files leave the changed-path inventory. */
export function DiffOrphanComments({ owner, connected, root, mode, paths, initialId }: {
  owner: string; connected: boolean; root: string; mode: GitDiffMode; paths: readonly string[]; initialId?: string;
}) {
  const t = useT();
  const { settings } = useSettings();
  const surface = useRef<HTMLDivElement>(null);
  const comments = useBlockComments(owner).filter((comment): comment is FileComment => comment.kind === "file" && comment.diff !== undefined
    && (comment.id === initialId || comment.diff.repository === root) && comment.diff.mode === mode && !paths.includes(comment.diff.path));
  const popover = useCommentPopover<FileTarget>({ enabled: settings.comments, persist: (owner, target, text) => { blockComments.saveFile(owner, target, text); } });
  if (comments.length === 0 && popover.open === null) return null;
  return <div ref={surface} className="diff-outdated changes-orphan-comments" data-comment-surface="">
    <h3>{t("Outdated comments")}</h3>
    {comments.map((comment) => <button type="button" className="diff-comment-card" key={comment.id} onClick={() => {
      if (!popover.show(owner, { ...comment, anchor: comment.anchor }, comment)) focusOpenField(surface.current);
    }}><span>{comment.label}:{linesText(comment.lines)} · {comment.diff?.side === "old" ? t("Old") : t("New")}</span><span>{comment.comment}</span></button>)}
    {popover.open !== null && <DiffCommentEditor key={popover.open.id} open={popover.open} connected={connected} text={popover.text}
      onSave={popover.save} onClose={popover.close} onDelete={popover.remove} />}
  </div>;
}

type Annotation = { comment: FileComment } | { pending: true };

/** Custom utility slots do not get Pierre's native utility drag handler. */
function DiffGutterButton({ hovered, pointerLine, onRange, onPreview }: {
  hovered: () => { lineNumber: number; side?: SelectedLineRange["side"] } | undefined;
  pointerLine: () => { lineNumber: number; side?: SelectedLineRange["side"] } | undefined;
  onRange: (range: SelectedLineRange, toggle: boolean) => void;
  onPreview: (range: SelectedLineRange) => void;
}) {
  const t = useT();
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  return <button type="button" className="diff-comment-plus" aria-label={t("Add comment")}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const first = hovered();
      if (!first) return;
      event.preventDefault(); event.stopPropagation();
      cleanup.current();
      const document = event.currentTarget.ownerDocument;
      const pointerId = event.pointerId;
      let range: SelectedLineRange = { start: first.lineNumber, end: first.lineNumber, side: first.side };
      let dragged = false;
      const move = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        // Pierre's utility getter follows the selected endpoint, not the pointer
        // during a controlled selection. Its line-enter callback supplies the latter.
        const last = pointerLine();
        if (!last) return;
        next.preventDefault();
        range = { start: first.lineNumber, end: last.lineNumber, side: first.side, endSide: last.side };
        dragged ||= last.lineNumber !== first.lineNumber || last.side !== first.side;
        onPreview(range);
      };
      const end = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        cleanup.current();
        onRange(range, !dragged);
      };
      const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) cleanup.current(); };
      cleanup.current = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", cancel);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);
      document.addEventListener("pointercancel", cancel);
    }}
    onClick={(event) => {
      if (event.detail !== 0) return;
      const line = hovered();
      if (line) onRange({ start: line.lineNumber, end: line.lineNumber, side: line.side }, true);
    }}><MessageSquarePlus aria-hidden="true" /></button>;
}

export function DiffViewer({ file, mode, owner, connected, split }: {
  file: GitFileDiffResponse; mode: GitDiffMode; owner: string; connected: boolean; split: boolean;
}) {
  const t = useT();
  const { settings, resolvedTheme } = useSettings();
  const surface = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);
  const stored = useBlockComments(owner);
  const comments = stored.filter((comment): comment is FileComment => comment.kind === "file" && comment.diff !== undefined
    && comment.diff.repository === file.root && comment.diff.mode === mode
    && (comment.diff.path === file.path || comment.diff.path === file.old_path));
  const popover = useCommentPopover<FileTarget>({ enabled: settings.comments, persist: (owner, target, text) => { blockComments.saveFile(owner, target, text); } });
  const shown = comments.filter((comment) => comment.diff?.revision === file.revision);
  const outdated = comments.filter((comment) => comment.diff?.revision !== file.revision);
  const metadata = useMemo(() => file.binary ? null : parseDiffFromFile(
    file.old_file === null ? null : { ...file.old_file, cacheKey: `${file.root}:${mode}:${file.revision}:old:${file.old_path ?? file.path}` },
    file.new_file === null ? null : { ...file.new_file, cacheKey: `${file.root}:${mode}:${file.revision}:new:${file.path}` },
  ), [file, mode]);
  const annotations: DiffLineAnnotation<Annotation>[] = shown.map((comment) => ({
    side: comment.diff?.side === "old" ? "deletions" : "additions", lineNumber: comment.lines[1], metadata: { comment },
  }));
  if (popover.open !== null && popover.open.target.diff?.revision === file.revision) annotations.push({
    side: popover.open.target.diff?.side === "old" ? "deletions" : "additions",
    lineNumber: popover.open.target.lines[1],
    metadata: { pending: true },
  });
  function edit(comment: FileComment): void {
    if (!popover.show(owner, { ...comment, anchor: comment.anchor }, comment)) focusOpenField(surface.current);
  }
  function add(range: SelectedLineRange, toggle = false): void {
    if (!settings.comments) return;
    const target = diffCommentTarget(file, mode, range);
    if (target === null) return;
    // A second + on the same coordinates closes only an untouched editor. Comparing
    // full anchors also distinguishes old/new sides, revisions and selected ranges.
    if (toggle && popover.open !== null && fileAnchor(popover.open.target) === fileAnchor(target)) {
      if (popoverChanged(popover.open, popover.text.read())) focusOpenField(surface.current);
      else { popover.close(); setSelected(null); }
      return;
    }
    if (!popover.show(owner, target, fileCommentAt(comments, target) ?? null, !toggle)) focusOpenField(surface.current);
    else setSelected(range);
  }
  // Pierre compares option callback identities before rendering. A new handler
  // on parent hover updates would rebuild its gutter and lose the active button.
  const onLineSelectionEnd = useStableCallback((range: SelectedLineRange | null) => { if (range !== null) add(range); });
  const onGutterRange = useStableCallback((range: SelectedLineRange, toggle: boolean) => add(range, toggle));
  const pointerLine = useRef<{ lineNumber: number; side: SelectedLineRange["side"] }>();
  const onLineEnter = useStableCallback((line: DiffLineEventBaseProps) => {
    pointerLine.current = { lineNumber: line.lineNumber, side: line.annotationSide };
  });
  const editor = popover.open === null ? null : <DiffCommentEditor key={popover.open.id} open={popover.open} connected={connected}
    text={popover.text}
    onSave={(text) => { popover.save(text); setSelected(null); }}
    onClose={() => { popover.close(); setSelected(null); }}
    onDelete={() => { popover.remove(); setSelected(null); }} />;
  const renderAnnotation = ({ metadata }: DiffLineAnnotation<Annotation>) => "pending" in metadata ? editor : (
    popover.open?.commentId === metadata.comment.id ? null : <button type="button" className="diff-comment-card" onClick={() => edit(metadata.comment)}>
      <span>{metadata.comment.label}:{linesText(metadata.comment.lines)} · {metadata.comment.diff?.side === "old" ? t("Old") : t("New")}</span>
      <span>{metadata.comment.comment}</span>
    </button>
  );
  return <div className="diff-viewer" ref={surface} data-comment-surface="">
    {/* A fresh renderer prevents a worker's previous token AST from surviving the
        plain-text threshold change. The draft text lives outside this subtree. */}
    {metadata !== null && <FileDiff key={String(settings.highlightCode)} fileDiff={metadata} lineAnnotations={annotations} selectedLines={selected} options={{
      diffStyle: split ? "split" : "unified", theme: PIERRE_THEME, themeType: resolvedTheme,
      overflow: settings.wrapCode ? "wrap" : "scroll", disableFileHeader: true, diffIndicators: "classic", enableLineSelection: settings.comments,
      // Pierre's zero threshold takes its plain-text rendering path (including
      // async highlights), rather than tokenizing and merely hiding the colors.
      tokenizeMaxLength: settings.highlightCode ? undefined : 0,
      enableGutterUtility: settings.comments, onLineSelected: setSelected,
      onLineSelectionStart: setSelected, onLineSelectionChange: setSelected,
      onLineSelectionEnd, onLineEnter,
      unsafeCSS: ":host { --diffs-bg: var(--bg-panel); --diffs-fg: var(--text); --diffs-font-family: var(--font-mono); --diffs-font-size: var(--fs-xs); --diffs-line-height: var(--lh-base); }",
    }} renderAnnotation={renderAnnotation} renderGutterUtility={(hovered) => <DiffGutterButton hovered={hovered} pointerLine={() => pointerLine.current} onRange={onGutterRange} onPreview={setSelected} />} />}
    {file.binary && <p role="status">{t("Binary files cannot be displayed as a text diff.")}</p>}
    {outdated.length > 0 && <section className="diff-outdated"><h3>{t("Outdated comments")}</h3>
      {outdated.map((comment) => <button type="button" className="diff-comment-card" key={comment.id} onClick={() => edit(comment)}>
        <span>{comment.label}:{linesText(comment.lines)} · {comment.diff?.side === "old" ? t("Old") : t("New")}</span><span>{comment.comment}</span>
      </button>)}
    </section>}
    {(metadata === null || popover.open?.target.diff?.revision !== file.revision) && editor}
  </div>;
}
