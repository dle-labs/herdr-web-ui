import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { File, useStableCallback, type FileProps } from "@pierre/diffs/react";
import type { LineEventBaseProps, SelectedLineRange } from "@pierre/diffs";
import { blockComments } from "../lib/blockComments.ts";
import { focusOpenField } from "../lib/commentDom.ts";
import { popoverChanged } from "../lib/commentPopover.ts";
import { fileAnchor, fileCommentAt, linesText, type FileComment, type FileTarget } from "../lib/fileComments.ts";
import { sourceCommentTarget } from "../lib/sourceComments.ts";
import { contentKey, keepEmptyRows, SHADOW_CSS, SOURCE_THEME } from "../lib/sourceTheme.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { DiffCommentEditor, DiffGutterButton } from "./DiffViewer.tsx";
import { DiffWorkerPool } from "./DiffWorkerPool.tsx";
import { type FileComments, type FileCommentScope } from "./FileComments.tsx";
import { useCommentPopover } from "./useCommentPopover.ts";
import VirtualSource from "./VirtualSource.tsx";

// Contextual ligatures make very long wrapped operator runs expensive to shape.
// Independent source glyphs retain wrapping, selection and annotation geometry.
const SOURCE_SHADOW_CSS = `${SHADOW_CSS}
[data-overflow=wrap] [data-line] { font-variant-ligatures: none; }
`;

export type SourceInteraction = Pick<FileProps<ReactNode, undefined>, "lineAnnotations" | "selectedLines" | "renderGutterUtility"> & {
  options: Pick<NonNullable<FileProps<ReactNode, undefined>["options"]>, "enableLineSelection" | "enableGutterUtility" | "onLineSelected" | "onLineSelectionStart" | "onLineSelectionChange" | "onLineSelectionEnd" | "onLineEnter">;
};

/** Working source and diffs share their gutter gesture, inline editor and draft safety. */
export function SourceComments({ scope, comments, text, virtual, markedLine, connected, initialId, requestKey = 0 }: {
  scope: FileCommentScope; comments: FileComments; text: string | null; virtual: { colored: boolean } | null;
  markedLine: number | null; connected: boolean; initialId?: string | null; requestKey?: number;
}) {
  const t = useT();
  const { settings, resolvedTheme } = useSettings();
  const surface = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectedLineRange | null>(null);
  const [revealedLine, setRevealedLine] = useState<number | null>(null);
  const popover = useCommentPopover<FileTarget>({ enabled: settings.comments, persist: (owner, target, value) => { blockComments.saveFile(owner, target, value); } });
  const opened = useRef<string | undefined>(undefined);
  function edit(comment: FileComment, reveal = false): void {
    if (!popover.show(scope.owner, { ...comment, anchor: comment.anchor }, comment)) focusOpenField(surface.current);
    else if (reveal) setRevealedLine(comments.shown.find((placed) => placed.comment.id === comment.id)?.lines[1] ?? null);
  }
  useEffect(() => {
    if (!initialId || opened.current === `${initialId}:${requestKey}`) return;
    const comment = comments.all.find((comment) => comment.id === initialId);
    if (!comment) return;
    opened.current = `${initialId}:${requestKey}`;
    edit(comment, true);
  }, [initialId, requestKey, comments.all, popover.show, scope.owner]);
  function add(range: SelectedLineRange, toggle = false): void {
    if (!settings.comments) return;
    const target = sourceCommentTarget(scope, range);
    if (target === null) return;
    if (toggle && popover.open !== null && fileAnchor(popover.open.target) === fileAnchor(target)) {
      if (popoverChanged(popover.open, popover.text.read())) focusOpenField(surface.current);
      else { popover.close(); setSelected(null); }
      return;
    }
    if (!popover.show(scope.owner, target, fileCommentAt(comments.all, target) ?? null, !toggle)) focusOpenField(surface.current);
    else setSelected(range);
  }
  const onEnd = useStableCallback((range: SelectedLineRange | null) => { if (range !== null) add(range); });
  const onRange = useStableCallback((range: SelectedLineRange, toggle: boolean) => add(range, toggle));
  const pointerLine = useRef<{ lineNumber: number } | undefined>(undefined);
  const onLineEnter = useStableCallback((line: LineEventBaseProps) => { pointerLine.current = { lineNumber: line.lineNumber }; });
  const editor = popover.open === null ? null : <DiffCommentEditor key={popover.open.id} open={popover.open} connected={connected} text={popover.text}
    reveal={initialId === popover.open.commentId}
    onSave={(value) => { popover.save(value); setSelected(null); }}
    onClose={() => { popover.close(); setSelected(null); }}
    onDelete={() => { popover.remove(); setSelected(null); }} />;
  const openLine = popover.open === null ? null : popover.open.commentId === null ? popover.open.target.lines[1]
    : comments.shown.find((placed) => placed.comment.id === popover.open?.commentId)?.lines[1] ?? null;
  const card = (comment: FileComment) => <button type="button" className="diff-comment-card" key={comment.id} onClick={() => edit(comment)}>
    <span>{comment.label}:{linesText(comment.lines)}</span><span>{comment.comment}</span>
  </button>;
  const interaction: SourceInteraction = {
    lineAnnotations: [
      ...comments.shown.filter(({ comment }) => comment.id !== popover.open?.commentId).map(({ comment, lines }) => ({ lineNumber: lines[1], metadata: card(comment) })),
      ...(editor !== null && openLine !== null ? [{ lineNumber: openLine, metadata: editor }] : []),
    ],
    selectedLines: selected,
    options: { enableLineSelection: settings.comments, enableGutterUtility: settings.comments, onLineSelected: setSelected,
      onLineSelectionStart: setSelected, onLineSelectionChange: setSelected, onLineSelectionEnd: onEnd, onLineEnter },
    renderGutterUtility: (hovered) => <DiffGutterButton hovered={hovered} pointerLine={() => pointerLine.current} onRange={onRange} onPreview={setSelected} />,
  };
  const file = useMemo(() => ({ name: scope.path, contents: text ?? "", cacheKey: contentKey(scope.path, text ?? "") }), [scope.path, text]);
  // Colors arrive asynchronously. Reveal a requested source line only after it is drawn,
  // once per request; normal edits and later highlighting must not move the document.
  const lastReveal = useRef<string | null>(null);
  const onPostRender = useStableCallback((node: HTMLElement) => {
    if (node.shadowRoot !== null) keepEmptyRows(node.shadowRoot);
    const line = revealedLine ?? markedLine;
    if (line === null) return;
    const key = `${scope.path}:${line}:${requestKey}`;
    const row = node.shadowRoot?.querySelector(`[data-line="${line}"]`);
    if (row === null || row === undefined || lastReveal.current === key) return;
    requestAnimationFrame(() => {
      // A worker result may have replaced the row since onPostRender. Resolve it
      // again rather than consuming a reveal for a detached, pre-highlight node.
      const current = node.shadowRoot?.querySelector(`[data-line="${line}"]`);
      if (current === null || current === undefined || !current.isConnected || lastReveal.current === key) return;
      lastReveal.current = key;
      current.scrollIntoView({ block: "center", inline: "nearest" });
    });
  });
  return <div ref={surface} className={`source-comments${virtual !== null ? " source-comments-virtual" : ""}`} data-comment-surface="">
    {text !== null && (virtual !== null
      ? <VirtualSource name={scope.path} text={text} colored={virtual.colored} wrap={settings.wrapCode} theme={resolvedTheme} markedLine={revealedLine ?? markedLine} interaction={interaction} />
      : <DiffWorkerPool><File className="source-comments-file" file={file} lineAnnotations={interaction.lineAnnotations} selectedLines={selected ?? (markedLine === null ? null : { start: markedLine, end: markedLine })}
        renderAnnotation={({ metadata }) => metadata} renderGutterUtility={interaction.renderGutterUtility} options={{
          disableFileHeader: true, theme: SOURCE_THEME, themeType: resolvedTheme, overflow: settings.wrapCode ? "wrap" : "scroll", unsafeCSS: SOURCE_SHADOW_CSS, onPostRender,
          ...interaction.options,
        }} /></DiffWorkerPool>)}
    {comments.outdated.length > 0 && <section className="diff-outdated"><h3>{t("Outdated comments")}</h3>{comments.outdated.map(card)}</section>}
    {text === null && comments.shown.map(({ comment }) => card(comment))}
    {(text === null || openLine === null) && editor}
  </div>;
}
