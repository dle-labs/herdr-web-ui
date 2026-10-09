import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Check, Code, Copy, Download, ExternalLink, MessageSquare, TriangleAlert, X } from "lucide-react";

import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useFileCommentLayer, useFileCommentWalk, type FileCommentScope } from "./FileComments.tsx";
import { useHighlightedLines } from "./HighlightedCode.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { TextFileView } from "./TextFileView.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { blockComments, isReplyComment, useBlockComments } from "../lib/blockComments.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { copyText, selectContents } from "../lib/clipboard.ts";
import { fileLines, pathLabel, type FileComment, type FileView, type LineRange } from "../lib/fileComments.ts";
import { pathParts } from "../lib/filePaths.ts";
import { languageForPath } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { previewHosts, type MarkdownBlock } from "../lib/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "../lib/markdownPreview.ts";
import { hasPreview, readTextStart, TEXT_START_HEADERS, type LoadedText, type TextViewMode } from "../lib/textPreview.ts";

/** Bigger images are offered as a download: a phone decodes an image whole. */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

type Preview = { status: "none" | "pending" | "failed" } | { status: "ready"; blocks: MarkdownBlock[] };

const NO_PREVIEW: Preview = { status: "none" };
const PENDING_PREVIEW: Preview = { status: "pending" };
const FAILED_PREVIEW: Preview = { status: "failed" };

/**
 * The Preview of `text` (null: none is asked for), parsed in a worker so the page never waits for
 * the parser: pending until it answers, failed when it gave up or ran over its budget.
 */
function useMarkdownPreview(text: string | null): Preview {
  const known = useMemo((): Preview | null => {
    if (text === null) return NO_PREVIEW;
    const blocks = knownPreview(text);
    if (blocks === undefined) return null;
    return blocks === null ? FAILED_PREVIEW : { status: "ready", blocks };
  }, [text]);
  const [answer, setAnswer] = useState<{ text: string; blocks: MarkdownBlock[] | null } | null>(null);
  useEffect(() => {
    if (known !== null || text === null) return;
    let live = true;
    const job = parsePreviewOffThread(text);
    void job.promise.then((blocks) => { if (live) setAnswer({ text, blocks }); });
    return () => { live = false; job.cancel(); };
  }, [known, text]);
  // a new object each render is fine: only its status and its (stable) blocks are read
  if (known !== null) return known;
  if (answer === null || answer.text !== text) return PENDING_PREVIEW;
  return answer.blocks === null ? FAILED_PREVIEW : { status: "ready", blocks: answer.blocks };
}

export interface FileViewerProps {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  paneId: string | null;
  /** the PC of the pane: its comments are kept under `paneStorageId(machineId, paneId)` */
  machineId: string;
  /** the pane's working folder (null: not known here): a comment names a file inside it relative to it */
  paneFolder: string | null;
  onClose: () => void;
  /** Settings can open above this preview; its Escape must not also close the file. */
  keyboardActive?: boolean;
  /** a file chosen in a folder's listing: opened as the preview, so history and a reload keep it */
  onOpen?: (path: string) => void;
  /** a file comment of the pane to open at (the composer's walk): its view shows, and the walk stops at it */
  commentId?: string | null;
}

/**
 * Copies the whole file; owns its "copied" flip, so only the button re-renders for it. Without a
 * clipboard API (plain-HTTP LAN) it selects the source `<pre>` instead; in a Markdown Preview there
 * is none, so `onShowSource` switches to Code first and the viewer selects it once rendered.
 */
function CopyFileButton({ text, sourceRef, onShowSource }: { text: string; sourceRef: RefObject<HTMLPreElement>; onShowSource: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("File copied") : t("Copy file");
  /** Copies the file, or selects its source for a long press; from a Preview, shows the source first. */
  const copy = async (): Promise<void> => {
    // the code <pre> is the source text alone: line numbers are a CSS counter, not text
    const source = sourceRef.current;
    if (await copyText(text, source)) setCopied(true);
    else if (!source) onShowSource();
  };
  return <button type="button" className="icon-button file-viewer-action" aria-label={label} title={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </button>;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, and the start of a text file. Each opens whole in a new tab (a
 * text file raw), and anything can be downloaded: an installed app on a phone opens a new tab in
 * an in-app view, which does not always offer to save it.
 */
export function FileViewer({ path: asked, paneId, machineId, paneFolder, onClose, onOpen, commentId = null, keyboardActive = true }: FileViewerProps) {
  const t = useT();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const remote = useMachineId() !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  // the path as given, until a choice among files of that name replaces it
  const [path, setPath] = useState(asked);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  // Escape closes it, Tab stays in it, and the focus goes back to the row that opened it
  const surface = useFocusTrap<HTMLElement>(true);
  // Settings → Chat width, Default: the Preview is as wide as the chat of the pane that opened it
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  // a kind, not a message: it is said in the language of the moment it shows
  const [error, setError] = useState<"missing" | "unreadable" | null>(null);
  const [loaded, setLoaded] = useState<LoadedText | null>(null);
  // the mode is the user's choice for this path, else Preview: derived, so a new path never paints the old mode
  // opened at a comment: in the view it was written in, so the other one is not drawn first
  const [chosen, setChosen] = useState<{ path: string; mode: TextViewMode } | null>(() => {
    const comment = commentId === null || paneId === null ? undefined : blockComments.list(paneStorageId(machineId, paneId)).find((c) => c.id === commentId);
    return comment === undefined || isReplyComment(comment) ? null : { path: asked, mode: comment.view === "code" ? "code" : "preview" };
  });
  const mode = chosen?.path === path ? chosen.mode : "preview";
  // the code <pre> while the code shows, which Copy selects when the clipboard is out of reach
  const sourceRef = useRef<HTMLPreElement>(null);
  // the Markdown preview's root while it shows, where the comments measure a selection
  const previewRef = useRef<HTMLDivElement>(null);
  // Copy failed in a Preview: select the source as soon as the Code view has rendered
  const selectSourceOnCode = useRef(false);
  /** Switches a Preview to its source and has it selected once rendered, for Copy without a clipboard. */
  const showSourceToSelect = (): void => {
    selectSourceOnCode.current = true;
    setChosen({ path, mode: "code" });
  };
  useLayoutEffect(() => {
    if (!selectSourceOnCode.current || mode !== "code") return;
    selectSourceOnCode.current = false;
    if (sourceRef.current) selectContents(sourceRef.current);
  }, [mode, loaded]);

  useEffect(() => setPath(asked), [asked]);

  useEffect(() => {
    let cancelled = false;
    // a closed viewer, or another file, stops the download of up to a quarter megabyte
    const download = new AbortController();
    setInfo(null); setCandidates(null); setError(null); setLoaded(null); setDirectory(null);
    fetchFileInfo(path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // only the first part of a text file travels
      const text = await readTextStart(await fetch(fileUrl(next.path, paneId), { headers: TEXT_START_HEADERS, signal: download.signal }));
      if (!cancelled) setLoaded(text);
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      // a folder is listed from the pane's folder, as a file is found from it
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path))) {
        try {
          const listing = await fetchDirectories(path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch { /* retain the file error when the target is not a readable directory */ }
      }
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? "missing" : "unreadable");
    });
    return () => { cancelled = true; download.abort(); };
  }, [path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote]);

  // A comment popover is open: Escape is its own first, wherever the focus is. It closes one with nothing typed in it
  // and keeps one with text typed (`popoverEscape`), and the viewer stays either way, so no typed text is lost; the
  // walk's dialog takes its own Escape. With none open, Escape closes the viewer
  const commentEscape = useRef<() => boolean>(() => false);
  const walkDialogOpen = useRef(false);
  useEffect(() => {
    if (!keyboardActive) return;
    // the FilesDialog beneath listens on window too (and stands down while this is open); this
    // one is the topmost overlay, so it takes the key, unless a native modal (Add PC) is over it
    /** Escape closes the open comment popover, else the viewer, from anywhere in it, unless something in it took the key. */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || walkDialogOpen.current || nativeModalOver(surface.current)) return;
      if (commentEscape.current()) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? path, paneId);
  const textFile = info?.kind === "text";
  const language = languageForPath(info?.path ?? path);
  // a Preview its parser gave up on (too slow, or failed) opens the source instead
  const preview = useMarkdownPreview(textFile && loaded !== null && mode === "preview" && hasPreview(language) ? loaded.text : null);
  const previewRefused = preview.status === "failed";
  const previewable = hasPreview(language) && !previewRefused;
  const view = previewable && mode === "preview" ? "markdown" : "code";
  const codeShown = textFile && loaded !== null && view === "code";
  // a file's code has no length limit (the load limit bounds it): only a worker that gave up leaves it plain
  const code = useHighlightedLines(codeShown ? loaded.text : "", codeShown ? language : null);
  const shownPath = info?.path ?? path;
  const { stem, extension } = pathParts(info?.name ?? shownPath);
  const { folder } = pathParts(shownPath);
  // what holds for the whole file is said with its size, where it is seen first, not after a megabyte of text
  const cutShort = textFile && loaded !== null && loaded.truncated;
  const notes = [
    cutShort && t("Showing the first {shown}", { shown: formatBytes(loaded.limit) }),
    textFile && loaded !== null && previewRefused && t("Too long to preview"),
    codeShown && code.tooLong && t("Too long to highlight"),
  ].filter((note): note is string => typeof note === "string");
  const noticed = notes.length > 0;
  const copyable = textFile && loaded !== null && !loaded.truncated;
  // Comments on the file's lines, kept with the pane the file was opened from: only with a pane, and
  // only on the lines loaded. The lines are numbered as the code view numbers them: a last line
  // ending is no line of its own, and a cut file's text ends where its last whole line does
  const owner = paneId === null ? null : paneStorageId(machineId, paneId);
  const sourceText = textFile && loaded !== null ? loaded.text : null;
  const sourceLines = useMemo(() => sourceText === null ? null : fileLines(sourceText.replace(/(?:\r\n|\r|\n)$/, "")), [sourceText]);
  const filePath = info?.path ?? null;
  const wholeLines = sourceLines === null || loaded === null ? 0 : loaded.truncated && !/[\r\n]$/.test(loaded.text) ? sourceLines.length - 1 : sourceLines.length;
  // the preview's blocks a card can follow, from the blocks the preview draws (parsed in the worker
  // with their lines). A preview still parsing takes no comments yet
  const previewBlocks = owner !== null && view === "markdown" && preview.status === "ready" ? preview.blocks : null;
  const hosts = useMemo<LineRange[] | null>(() => previewBlocks === null ? null : previewHosts(previewBlocks), [previewBlocks]);
  const commentView = codeShown ? "code" : hosts !== null ? "preview" : null;
  const scope = useMemo<FileCommentScope | null>(() => owner === null || commentView === null || filePath === null || sourceLines === null ? null
    : { owner, path: filePath, label: pathLabel(filePath, paneFolder), view: commentView, lines: sourceLines, loaded: wholeLines, truncated: cutShort },
  [owner, commentView, filePath, paneFolder, sourceLines, wholeLines, cutShort]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = commentView === "preview" ? previewRef : sourceRef;
  const comments = useFileCommentLayer(scope, bodyRef, contentRef);
  // the header's counter walks this file's comments, switching to the view one was written in
  const walk = useFileCommentWalk({
    owner, view: commentView, comments: comments.comments, surface: bodyRef, content: contentRef,
    showView: (next: FileView) => setChosen({ path, mode: next === "code" ? "code" : "preview" }),
  });
  // Escape is the open popover's first, or the walk's dialog's, before it is the viewer's
  commentEscape.current = comments.escape;
  walkDialogOpen.current = walk.editorOpen;
  // the pane's comments of any kind: the one the viewer was opened at is looked up among them (none while comments are off)
  const paneComments = useBlockComments(owner ?? "");
  // Opened at a comment (the composer's walk): the walk stops at it once the file's comments are
  // placed, which waits for the file's text (and a preview's parse). Where the file cannot show it
  // (gone, unreadable, no longer text), it opens in a dialog over what the viewer says
  const [pendingStop, setPendingStop] = useState(commentId);
  useEffect(() => setPendingStop(commentId), [commentId]);
  const { goTo, openInEditor } = walk;
  const previewPending = preview.status === "pending";
  useEffect(() => {
    if (pendingStop === null) return;
    const comment = paneComments.find((c): c is FileComment => !isReplyComment(c) && c.id === pendingStop);
    // gone meanwhile (sent, deleted): the viewer just shows its file
    if (comment === undefined) { setPendingStop(null); return; }
    if (scope !== null) {
      // not among this file's comments: it was written on a path the viewer does not resolve to now
      if (!goTo(comment.id)) openInEditor(comment, t("This part of the file has changed since."));
      setPendingStop(null);
      return;
    }
    const unshown = error !== null ? (error === "missing" ? t("No readable file at this path.") : t("The file could not be opened."))
      : directory !== null || (info !== null && info.kind !== "text") ? t("The file could not be opened.")
      : textFile && loaded !== null && !previewPending ? t("This preview can't be shown.")
      : null;
    // still opening
    if (unshown === null) return;
    openInEditor(comment, unshown);
    setPendingStop(null);
  }, [pendingStop, paneComments, scope, error, directory, info, textFile, loaded, previewPending, goTo, openInEditor, t]);
  const fileComments = comments.comments.all.length;
  const commentsShown = owner !== null && fileComments > 0;
  const outdatedCount = comments.comments.outdated.length;
  const counted = t(fileComments === 1 ? "{count} comment" : "{count} comments", { count: fileComments });
  const countLabel = outdatedCount > 0 ? `${counted} · ${t("{count} outdated", { count: outdatedCount })}` : counted;
  // a phone stacks the actions under the name once there are two or more, and one fits beside it:
  // every file has Download, and all but a binary one a new tab (Raw for text) as well; a binary
  // one has a second action only in its comments
  const stacked = info?.kind !== "binary" || commentsShown;
  /** What the viewer shows below its header: a folder, an error, a choice of files, or the file. */
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <p className="file-viewer-note" role="alert">{error === "missing" ? t("No readable file at this path.") : t("The file could not be opened.")}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">Several files are named {path.split("/").pop()}:</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate)}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return <p className="file-viewer-note">{t("Opening…")}</p>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">{t("This image is {size}; open it in a new tab to view it.", { size: formatBytes(info.size) })}</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "text":
        return loaded === null || (view === "markdown" && preview.status !== "ready")
          ? <p className="file-viewer-note">{t("Opening…")}</p>
          // a text the renderer cannot draw fails here, not the app: the header (Show source, Raw,
          // Close) stays, and a Preview that fails offers its source
          : <RenderBoundary key={view} resetKey={loaded} fallback={() => view === "markdown"
            ? <div className="file-viewer-note" role="alert">
              <p>{t("This preview can't be shown.")}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setChosen({ path, mode: "code" })}>{t("Show source")}</button>
            </div>
            : <p className="file-viewer-note" role="alert">{t("The file could not be opened.")}</p>}>
            <TextFileView path={info.path} blocks={view === "markdown" && preview.status === "ready" ? preview.blocks : null} lines={code.lines} onOpen={onOpen ?? setPath} sourceRef={sourceRef} previewRef={previewRef} />
          </RenderBoundary>;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path} ref={surface} tabIndex={-1}>
        {/* three groups, spaced apart: how the text shows, the file itself, the window */}
        <header className={stacked ? "modal-header file-viewer-header file-viewer-header-stacked" : "modal-header file-viewer-header"}>
          <div className="file-viewer-title">
            {/* a long name is cut inside its stem, so its type stays in view */}
            <h2 className="modal-title"><span className="file-viewer-stem">{stem}</span>{extension}</h2>
            <p className="file-viewer-meta" title={shownPath}>
              {/* a partial view is told by the size ("256 KB of 1.3 MB") in the warning color, beside an
                  icon so the color is not the only sign; what it means is the tooltip (and read out) */}
              {info && (noticed
                ? <span className="file-viewer-notice" title={notes.join("\n")}>
                  <TriangleAlert aria-hidden="true" />
                  <span>{cutShort ? t("{done} of {total}", { done: formatBytes(loaded.limit), total: formatBytes(loaded.size ?? info.size) }) : formatBytes(info.size)}</span>
                  <span className="visually-hidden">{notes.join(". ")}</span>
                </span>
                : <span className="file-viewer-size">{formatBytes(info.size)}</span>)}
              {/* the dot is the folder's, so where the folder has no room left no dot dangles */}
              {folder !== "" && <span className="file-viewer-path"><span dir="ltr">{info && <span className="file-viewer-dot" aria-hidden="true">·</span>}{folder}</span></span>}
            </p>
          </div>
          <div className="file-viewer-actions">
            {/* how the text shows: Preview or source is one choice of two, so one toggle; wrapping is a
                setting (Settings → File viewer), not an action here */}
            {/* the comments: this file's, walked one per tap */}
            {commentsShown && <div className="file-viewer-group">
              <button type="button" className="icon-button file-viewer-action file-viewer-comments" aria-label={countLabel} title={`${countLabel}\n${t("Go to the next comment")}`} onClick={walk.next}>
                <MessageSquare aria-hidden="true" />
                {/* the count as a bubble on the icon; the full text (with any outdated) is the name and tooltip */}
                <span className="file-viewer-comments-count" aria-hidden="true">{fileComments > 99 ? "99+" : fileComments}</span>
              </button>
            </div>}
            {textFile && previewable && <div className="file-viewer-group">
              <button type="button" className="icon-button file-viewer-action" aria-pressed={mode === "code"} aria-label={t("Show source")} title={t("Show source")} onClick={() => setChosen({ path, mode: mode === "code" ? "preview" : "code" })}><Code aria-hidden="true" /></button>
            </div>}
            {/* the file itself: a new tab shows it whole (Raw for text), except a file no tab can
                show, and a download saves it, also where a new tab is an app's in-app view */}
            <div className="file-viewer-group">
              {info?.kind !== "binary" && <a className="icon-button file-viewer-action" href={url} target="_blank" rel="noopener" aria-label={textFile ? t("Raw") : t("Open in a new tab")} title={textFile ? t("Raw") : t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>}
              <a className="icon-button file-viewer-action" href={fileUrl(shownPath, paneId, true)} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
              {copyable && <CopyFileButton text={loaded.text} sourceRef={sourceRef} onShowSource={showSourceToSelect} />}
            </div>
          </div>
          <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {/* with comments the body is their surface (lib/commentHighlight.ts), the place the pins and the popover
            are positioned in, and a click on a line in it comments on that line, a mouse's drag on what it selected */}
        <div ref={bodyRef} className="file-viewer-body" {...comments.surfaceProps}>
          {body}
          {comments.overlay}
          {walk.editor}
        </div>
      </section>
    </div>
  );
}
