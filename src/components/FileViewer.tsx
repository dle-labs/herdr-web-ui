import { createPortal } from "react-dom";
import { FileToolbarContext } from "./MobileFilesToolbar.tsx";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Braces, Check, Code, Copy, Download, ExternalLink, Link2, MessageSquare, Pencil, TableOfContents, TriangleAlert, X } from "lucide-react";

import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useFileComments, type FileCommentScope } from "./FileComments.tsx";
import { PreviewComments } from "./PreviewComments.tsx";
import { SourceComments } from "./SourceComments.tsx";
import { useHighlightedLines } from "./HighlightedCode.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { flushSync } from "react-dom";
import { RelayRenderedPage } from "./RelayRenderedPage.tsx";
import { usePageFocusGuard } from "../lib/usePageFocusGuard.ts";
import { hasDraft, TextFileEditor } from "./TextFileEditor.tsx";
import { TextFileView } from "./TextFileView.tsx";
import { MarkdownImageContext } from "./Markdown.tsx";
import { MarkdownOutline, OUTLINE_COLUMN_MIN_PX, useWideEnough } from "./MarkdownOutline.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { MAX_EDITABLE_TEXT_BYTES } from "../../shared/files.ts";
import { ApiError, errorFrom } from "../lib/api.ts";
import { blockComments, isReplyComment } from "../lib/blockComments.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE, paneStorageId } from "../../shared/machines.ts";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { copyText, selectContents } from "../lib/clipboard.ts";
import { fileLineTarget, pathParts } from "../lib/filePaths.ts";
import { lineRequest, readBudget, shownSource, sourceLayout, virtualHighlightable } from "../lib/sourcePreview.ts";
import { canHighlight, countLines, languageForPath, normalizeCode } from "../lib/highlight.ts";
import { useAppWindow } from "../lib/install.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { fileLines, pathLabel, sortFileComments } from "../lib/fileComments.ts";
import { changedAttrs, changedField, revealField } from "../lib/commentDom.ts";
import { useSettings } from "../lib/settings.ts";
import { lastFileStop } from "../lib/commentWalk.ts";
import { MAX_INLINE_IMAGE_BYTES, markdownImagePreview } from "../lib/markdownImages.ts";
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "../lib/markdownPreview.ts";
import { outlineOf } from "../lib/markdownOutline.ts";
import { hasPreview, type TextViewMode } from "../lib/textPreview.ts";
import { readFilePreviewText, SOURCE_PREVIEW_LINES, type FilePreviewText } from "../lib/filePreviewText.ts";
import { readerHref } from "../lib/fileReader.ts";
import { getTransport } from "../lib/transport.ts";
import { useResourceUrl, useResourceUrlState } from "../lib/useResourceUrl.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { fileFailure, fileFailureText, type FileFailure } from "../lib/fileFailure.ts";

type Preview = { status: "none" | "pending" | "failed" } | { status: "ready"; blocks: MarkdownBlock[] };

const NO_PREVIEW: Preview = { status: "none" };
const PENDING_PREVIEW: Preview = { status: "pending" };
const FAILED_PREVIEW: Preview = { status: "failed" };

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
  if (known !== null) return known;
  if (answer === null || answer.text !== text) return PENDING_PREVIEW;
  return answer.blocks === null ? FAILED_PREVIEW : { status: "ready", blocks: answer.blocks };
}

export interface FileViewerProps {
  /** The containing review can also show this Markdown document as a diff. */
  onShowDiff?: () => void;
  initialMode?: TextViewMode;
  connected?: boolean;
  /** A document-only page, without the enclosing workspace browser. */
  page?: boolean;
  path: string;
  paneId: string | null;
  /** the PC of the pane: its comments are kept under `paneStorageId(machineId, paneId)` */
  machineId?: string;
  /** the pane's working folder (null: not known here): a comment names a file inside it relative to it */
  paneFolder?: string | null;
  onClose: () => void;
  /** Settings can open above this preview; its Escape must not also close the file. */
  keyboardActive?: boolean;
  /** Navigate within the enclosing workspace browser. */
  onOpen?: (path: string) => void;
  /** a file comment of the pane to open at (the composer's walk): its view shows, and the walk stops at it */
  commentId?: string | null;
  /** this browser drives the PC (not a watching device, a Portal visitor or an open LAN window): with Settings → Edit text files on, a text file can be edited */
  editable?: boolean;
}

/**
 * When nothing copies it (no clipboard API on plain-HTTP LAN, and the browser's copy command
 * refused: copyText) it selects the source `<pre>` instead; in a Markdown Preview there is none,
 * and a virtualized source has no element holding the whole text, so `onShowSource` shows a
 * selectable source first and the viewer selects it once rendered.
 */
function CopyFileButton({ text, sourceRef, onShowSource }: { text: string; sourceRef: RefObject<HTMLElement | null>; onShowSource: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("File copied") : t("Copy file");
  const copy = async (): Promise<void> => {
    const source = sourceRef.current;
    if (await copyText(text, source)) setCopied(true);
    else if (!source) onShowSource();
  };
  return <button type="button" className="icon-button file-viewer-action" aria-label={label} title={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </button>;
}

/**
 * In the installed app's window, where a new tab of this origin would open another app window,
 * the address is copied instead, to paste into a browser.
 */
function CopyLinkButton({ href, menuItem = false, onDone }: { href: string; menuItem?: boolean; onDone?: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("Link copied") : t("Copy link");
  const copy = async (): Promise<void> => {
    if (await copyText(new URL(href, window.location.href).href)) setCopied(true);
    onDone?.();
  };
  return menuItem
    ? <button type="button" role="menuitem" className="file-viewer-more-item" onClick={() => void copy()}><Link2 aria-hidden="true" />{label}</button>
    : <button type="button" className="icon-button file-viewer-action" aria-label={label} title={label} onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
    </button>;
}

function selectSource(element: HTMLElement): void {
  if (element instanceof HTMLTextAreaElement) { element.focus(); element.select(); }
  else selectContents(element);
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, and the start of a text file (Markdown images read through the
 * file endpoint). Each opens whole in a new tab (a text file raw), and anything can be downloaded:
 * an installed app on a phone opens a new tab in an in-app view, which does not always offer to save it.
 */
export function FileViewer({ connected = false, page = false, path: asked, paneId, machineId: givenMachineId, paneFolder = null, onClose, onOpen, commentId = null, onShowDiff, initialMode, editable = false }: FileViewerProps) {
  const t = useT();
  const toolbar = useContext(FileToolbarContext);
  const compact = toolbar !== null;
  const { settings } = useSettings();
  // the file's text in an editor (TextFileEditor), and whether it holds changes not saved, which the Files guards keep open
  const [editing, setEditing] = useState(false);
  const [editChanged, setEditChanged] = useState(false);
  const [saves, setSaves] = useState(0);
  const locale = useLocale();
  const appWindow = useAppWindow();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const contextMachineId = useMachineId();
  const machineId = givenMachineId ?? contextMachineId;
  const remote = machineId !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  const [path, setPath] = useState(asked);
  const target = useMemo(() => fileLineTarget(path), [path]);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  // The enclosing Files dialog owns focus, sheet gestures and closing.
  const surface = useRef<HTMLElement>(null);
  const leaveComment = (): boolean => {
    const field = changedField(surface.current);
    if (field === null) return true;
    revealField(field);
    return false;
  };
  // Settings → Chat width, Default: the Preview is as wide as the chat of the pane that opened it
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  // a kind, not a message: it is said in the language of the moment it shows
  const [error, setError] = useState<FileFailure | null>(null);
  const [source, setSource] = useState(target.line !== null);
  // A page is drawn without its scripts until the person asks for them: for the file named here, and for as long
  // as this viewer stays open (another file, a close or a reload starts without them again). `stopped`: the file
  // whose scripts were taken away again because its frame took the keyboard (lib/usePageFocusGuard.ts).
  const [scriptsFor, setScriptsFor] = useState<string | null>(null);
  const [stopped, setStopped] = useState<string | null>(null);
  const pageFrame = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState<FilePreviewText | null>(null);
  // Open at a comment in its view; otherwise a line reference defaults to Code, else Preview.
  // A new path never paints the old choice.
  const [chosen, setChosen] = useState<{ path: string; mode: TextViewMode } | null>(() => {
    const comment = commentId === null || paneId === null ? undefined : blockComments.list(paneStorageId(machineId, paneId)).find((c) => c.id === commentId);
    return comment === undefined || isReplyComment(comment) ? initialMode ? { path: asked, mode: initialMode } : null : { path: asked, mode: comment.view };
  });
  const mode = chosen?.path === path ? chosen.mode : target.line === null ? "preview" : "code";
  // The source <pre>, or a virtualized source's text box, selected when Copy cannot reach the clipboard.
  const sourceRef = useRef<HTMLElement | null>(null);
  // The Markdown preview's root, where comments measure a selection.
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [selectable, setSelectable] = useState(false);
  const selectSourceOnCode = useRef(false);
  const showSourceToSelect = (): void => {
    if (!leaveComment()) return;
    setSource(true);
    selectSourceOnCode.current = true;
    setSelectable(true);
    setChosen({ path, mode: "code" });
  };
  useLayoutEffect(() => {
    if (!selectSourceOnCode.current || mode !== "code") return;
    selectSourceOnCode.current = false;
    if (sourceRef.current) selectSource(sourceRef.current);
  }, [mode, loaded, source, selectable]);

  useEffect(() => setPath(asked), [asked]);
  useEffect(() => { setEditing(false); setEditChanged(false); }, [path]);
  useEffect(() => setSource(target.line !== null), [path, target.line]);

  useEffect(() => {
    let cancelled = false;
    // A closed viewer, another file, or the deadline stops the bounded download.
    const download = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    setInfo(null); setCandidates(null); setError(null); setLoaded(null); setDirectory(null); setSelectable(false);
    fetchFileInfo(target.path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // Read a bounded prefix: Markdown keeps its Preview budget; source also has a line cap.
      const budget = readBudget(languageForPath(next.path), next.size);
      // The request gets the deadline; the body keeps whatever arrived within the remaining time.
      const started = Date.now();
      deadline = setTimeout(() => download.abort(), budget.timeoutMs);
      try {
        const response = await getTransport().fetch(fileUrl(next.path, paneId), { signal: download.signal, headers: { range: `bytes=0-${budget.bytes - 1}` } });
        if (!response.ok && !(response.status === 416 && response.headers.get("content-range")?.trim() === "bytes */0")) {
          if (response.headers.get("content-type")?.includes("application/json")) throw await errorFrom(fileUrl(next.path, paneId), response);
          await response.body?.cancel();
          throw new ApiError(fileUrl(next.path, paneId), response.status, response.statusText, null);
        }
        clearTimeout(deadline);
        const timeoutMs = Math.max(1, budget.timeoutMs - (Date.now() - started));
        const body = await readFilePreviewText(response, budget.bytes, { signal: download.signal, maxLines: budget.lines, timeoutMs, partialOnTimeout: true });
        if (!cancelled) setLoaded(body);
      } finally { clearTimeout(deadline); }
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(target.path))) {
        try {
          const listing = await fetchDirectories(target.path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch {  }
      }
      if (cancelled) return;
      setError(fileFailure(reason));
    });
    return () => { cancelled = true; clearTimeout(deadline); download.abort(); };
  }, [target.path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote, saves]);

  const url = fileUrl(info?.path ?? target.path, paneId);
  const textFile = info?.kind === "text";
  const language = languageForPath(info?.path ?? target.path);
  const preview = useMarkdownPreview(textFile && loaded !== null && mode === "preview" && hasPreview(language) ? loaded.text : null);
  const previewRefused = preview.status === "failed";
  const previewable = hasPreview(language) && !previewRefused;
  const view = previewable && mode === "preview" ? "markdown" : "code";
  const previewBlocks = !editing && view === "markdown" && preview.status === "ready" ? preview.blocks : null;
  const outline = useMemo(() => previewBlocks !== null ? outlineOf(previewBlocks) : [], [previewBlocks]);
  const outlined = outline.length > 1;
  const [split, setSplit] = useState<HTMLDivElement | null>(null);
  const outlineColumn = useWideEnough(outlined ? split : null, OUTLINE_COLUMN_MIN_PX);
  const [outlineChoice, setOutlineChoice] = useState<boolean | null>(null);
  const outlineShown = outlined && (outlineChoice ?? outlineColumn);
  const outlineToggle = useRef<HTMLButtonElement>(null);
  const outlineId = useId();
  const closeOutline = useCallback((refocus: boolean) => {
    setOutlineChoice(null);
    if (refocus) outlineToggle.current?.focus();
  }, []);
  const outlineButton = outlined && <button ref={outlineToggle} type="button" className="icon-button file-viewer-action file-viewer-outline-toggle" aria-expanded={outlineShown} aria-controls={outlineShown ? outlineId : undefined} aria-label={t("Outline")} title={t("Outline")} onClick={() => setOutlineChoice(!outlineShown)}>
    <TableOfContents aria-hidden="true" />
  </button>;
  /** The wrapper is always there (`display: contents` without an outline), so the body is never remounted, its focus and scroll kept, as an outline comes and goes. */
  const withOutline = (box: ReactNode) => <div ref={setSplit} className={outlined ? "file-viewer-split is-outlined" : "file-viewer-split"}>
    {box}
    {outlineShown && <MarkdownOutline id={outlineId} entries={outline} scroller={bodyRef} drawer={!outlineColumn} toggle={outlineToggle} onClose={closeOutline} />}
  </div>;
  const htmlPage = info !== null && info.kind === "text" && info.mime === "text/html";
  const pageUrl = `${url}&render=1`;
  const pageScripts = htmlPage && !source && scriptsFor === info.path;
  // a page with scripts must not take the app's keys: the frame that takes the focus loses its scripts again
  const guard = usePageFocusGuard(pageFrame, pageScripts, () => {
    // at once, not at the next render: only taking the frame away gives the keys back
    flushSync(() => { setScriptsFor(null); setStopped(info?.path ?? null); });
  });
  const modes = <div className="segmented file-viewer-modes" role="group" aria-label={t("Show the HTML file as")}>
    <button type="button" aria-pressed={!source} onClick={() => { if (leaveComment()) setSource(false); }}>{t("Page")}</button>
    <button type="button" aria-pressed={source} onClick={() => { if (leaveComment()) setSource(true); }}>{t("Source")}</button>
  </div>;
  const relay = getTransport().kind === "relay";
  const resource = useResourceUrlState(info !== null && info.kind !== "text" && info.kind !== "image" ? url : null);
  const urlSrc = relay ? resource.url : url;
  const pageSrc = useResourceUrl(!relay && htmlPage && !source ? pageUrl : null);
  // an image past the inline limit is only offered as a download: the body never loads it
  const image = useResourceUrlState(info?.kind === "image" && info.size <= MAX_INLINE_IMAGE_BYTES ? `${url}&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` : null);
  const imageSrc = image.url;
  // The same inert media body can be saved through the download attribute. In blob mode this
  // avoids fetching and retaining a second complete video/PDF merely to draw its download link.
  const mediaDownload = relay && (info?.kind === "video" || info?.kind === "audio" || info?.kind === "pdf");
  const download = useResourceUrlState(info === null || mediaDownload ? null : fileUrl(info.path, paneId, true));
  const downloadHref = mediaDownload ? resource.url : download.url;
  const codeShown = textFile && loaded !== null && view === "code" && (!htmlPage || source);
  const sourceText = useMemo(() => codeShown ? shownSource(normalizeCode(loaded.text), loaded.truncated) : "", [codeShown, loaded]);
  const sourceLines = useMemo(() => countLines(sourceText), [sourceText]);
  const layout = sourceLayout(sourceLines);
  const colorable = canHighlight(language);
  const virtual = useMemo(() => codeShown && layout === "virtual" ? { text: sourceText, colored: colorable && virtualHighlightable(sourceText.length, sourceLines) } : null, [codeShown, layout, sourceText, colorable, sourceLines]);
  const code = useHighlightedLines(codeShown && layout === "elements" && (page || paneId === null || selectable) ? sourceText : "", codeShown ? language : null);
  const shownPath = info?.path ?? target.path;
  const { stem, extension } = pathParts(info?.name ?? shownPath);
  const { folder } = pathParts(shownPath);
  const cutShort = textFile && (!htmlPage || source) && loaded !== null && loaded.truncated;
  const budget = textFile ? readBudget(language, info.size) : null;
  const cutBytes = cutShort && budget !== null && loaded.truncatedBy !== "lines" && loaded.truncatedBy !== "time" && (loaded.total ?? info.size) > budget.bytes ? { shown: budget.bytes, total: loaded.total ?? info.size } : null;
  const request = useMemo(() => codeShown ? lineRequest(target.line, sourceText, loaded.truncated, loaded.lines) : null, [codeShown, target.line, sourceText, loaded]);
  const requestNotice = (() => {
    if (request === null) return null;
    switch (request.kind) {
      case "shown": return null;
      case "past-preview": return t("Line {line} is past the part of this file shown here. Download it to read the rest.", { line: request.line });
      case "past-end": return t("This file has {count} lines; there is no line {line}.", { count: request.lines, line: request.line });
    }
  })();
  const notes = [
    requestNotice,
    cutShort && (loaded.truncatedBy === "lines"
      ? t("Showing the first {count} lines of this file. Download it to read the rest.", { count: SOURCE_PREVIEW_LINES.toLocaleString(locale) })
      : cutBytes !== null
        ? t("Showing the first {shown} of {total}.", { shown: formatBytes(cutBytes.shown), total: formatBytes(cutBytes.total) })
        : t("Only part of this file is shown. Download it to read the rest.")),
    textFile && loaded !== null && previewRefused && t("Too long to preview"),
    codeShown && (code.tooLong || (virtual !== null && colorable && !virtual.colored)) && t("Too long to highlight"),
  ].filter((note): note is string => typeof note === "string");
  const noticed = notes.length > 0;
  const copyable = textFile && loaded !== null && !loaded.truncated;
  // shown as text (an HTML page as its source), in a pane's folder the server checks it lies in, and small enough
  const canEdit = editable && settings.editTextFiles && !page && paneId !== null && textFile && (!htmlPage || source) && info.size <= MAX_EDITABLE_TEXT_BYTES;
  const draftWaits = canEdit && hasDraft(machineId, info.path);
  useEffect(() => { if (draftWaits) setEditing(true); }, [draftWaits]);
  const markdown = info?.kind === "text" && /\.(?:md|markdown)$/i.test(info.name);
  const previewUrl = readerHref(machineId, shownPath + (target.line === null ? "" : `#L${target.line}`));
  const imagePreview = useCallback((src: string) => markdownImagePreview(
    src, shownPath, (target) => fetchFileInfo(target, paneId), (target, download) => fileUrl(target, paneId, download),
  ), [shownPath, paneId, fetchFileInfo, fileUrl]);
  // Comments on the file's lines, kept with the pane the file was opened from: only with a pane, and
  // only on the lines loaded. The lines are numbered as the code view numbers them: a last line
  // ending is no line of its own, and a cut file's text ends where its last whole line does
  const owner = paneId === null ? null : paneStorageId(machineId, paneId);
  // Keep original text for comment offsets; normalization for rendering must not change stored quotes.
  const commentText = textFile && loaded !== null ? loaded.text : null;
  const commentLines = useMemo(() => commentText === null ? null : fileLines(commentText.replace(/(?:\r\n|\r|\n)$/, "")), [commentText]);
  const filePath = info?.path ?? null;
  const wholeLines = commentLines === null || loaded === null ? 0 : loaded.truncated && !/[\r\n]$/.test(loaded.text) ? commentLines.length - 1 : commentLines.length;
  const scope = useMemo<FileCommentScope | null>(() => owner === null ? null
    : { owner, path: filePath ?? target.path, label: pathLabel(filePath ?? target.path, paneFolder), view: "code", lines: commentLines ?? [], loaded: wholeLines, truncated: cutShort },
  [owner, filePath, target.path, paneFolder, commentLines, wholeLines, cutShort]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The standalone reader has no modal trap: its scroll box owns keyboard
  // scrolling on arrival. Preserve any focus the reader already placed inside it.
  useLayoutEffect(() => {
    if (!page || surface.current?.contains(document.activeElement)) return;
    bodyRef.current?.focus({ preventScroll: true });
  }, [page]);
  const comments = useFileComments(scope);
  const [requestedComment, setRequestedComment] = useState(commentId);
  const [commentRequest, setCommentRequest] = useState(0);
  useEffect(() => {
    setRequestedComment(commentId);
    if (commentId !== null) {
      const comment = comments.all.find((comment) => comment.id === commentId);
      const mode = comment?.view ?? "code";
      setChosen({ path, mode }); setSource(mode === "code");
    }
  }, [commentId, path]);
  const nextComment = (): void => {
    const field = changedField(bodyRef.current);
    if (field !== null) { revealField(field); return; }
    if (owner === null) return;
    const sorted = sortFileComments(comments.all);
    const index = sorted.findIndex((comment) => comment.id === lastFileStop.get(owner));
    const next = sorted[(index + 1) % sorted.length];
    if (next === undefined) return;
    lastFileStop.set(owner, next.id);
    setRequestedComment(next.id);
    setCommentRequest((value) => value + 1);
    setChosen({ path, mode: next.view });
    setSource(next.view === "code");
  };
  const sourceComments = scope === null ? null : <SourceComments key={`${owner}:${scope.path}`} scope={scope} comments={comments}
    text={codeShown && !selectable ? sourceText : null} virtual={virtual} markedLine={request?.kind === "shown" ? request.line : null}
    connected={connected} initialId={requestedComment} requestKey={commentRequest} />;
  const fileComments = comments.all.length;
  const commentsShown = owner !== null && fileComments > 0;
  const outdatedCount = comments.outdated.length;
  const counted = t(fileComments === 1 ? "{count} comment" : "{count} comments", { count: fileComments });
  const countLabel = outdatedCount > 0 ? `${counted} · ${t("{count} outdated", { count: outdatedCount })}` : counted;
  const opening = directory === null && error === null && candidates === null
    && (info === null || (info.kind === "text" && (!htmlPage || source) && (loaded === null || (view === "markdown" && preview.status !== "ready"))));
  const openingWords = useAnnouncedText(opening ? t("Opening…") : null);
  const openingNote = <p className={openingWords === null ? "visually-hidden" : "file-viewer-note"} role="status">{openingWords}</p>;
  /** What the viewer shows below its header: a folder, an error, a choice of files, or the file. */
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <>
      <p className="file-viewer-note" role="alert">{fileFailureText(error, t)}</p>
      {error === "unreadable" && <p className="file-viewer-note file-viewer-note-hint">{t("Download it or open the raw file.")}</p>}
    </>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">{t("Several files are named {name}:", { name: target.path.split("/").pop() ?? target.path })}</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate + path.slice(target.path.length))}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return null;
    const resourceError = resource.error ?? image.error;
    if (resourceError) return resourceError instanceof RelayResourceTooLargeError
      ? <p className="file-viewer-note" role="alert">{t("Too large to open on the phone - download on the PC")}</p>
      : <>
        <p className="file-viewer-note" role="alert">{fileFailureText(fileFailure(resourceError), t)}</p>
        {fileFailure(resourceError) === "unreadable" && downloadHref !== null && <p className="file-viewer-note file-viewer-note-hint">{t("Download it or open the raw file.")}</p>}
      </>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">{t("This image is {size}; download it to view.", { size: formatBytes(info.size) })}</p>
          : <img className="file-viewer-media" src={imageSrc ?? undefined} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={urlSrc ?? undefined} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={urlSrc ?? undefined} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={urlSrc ?? undefined} title={info.name} />;
      case "text":
        if (editing && paneId !== null) return <div className="file-editor-host" {...changedAttrs(editChanged)}>
          <TextFileEditor path={info.path} paneId={paneId} name={info.name} onChanged={setEditChanged}
            onDone={(saved) => { setEditing(false); setEditChanged(false); if (saved) setSaves((count) => count + 1); }} />
        </div>;
        if (htmlPage && !source) return <>
          {modes}
          {/* The line stays in the document while the scripts run, clipped and without words: a status line that
              appears together with its words is not announced, and "took the keyboard" has to be. */}
          <div className={pageScripts ? "visually-hidden" : "file-viewer-scripts"}>
            <span role="status">{pageScripts ? null : stopped === info.path ? t("This page took the keyboard, so its scripts are off again.") : t("Scripts in this page are off.")}</span>
            {!pageScripts && <button type="button" className="btn btn-ghost" onClick={() => { setStopped(null); setScriptsFor(info.path); }}>{t("Run scripts")}</button>}
          </div>
          {/* The frame is a new one when the scripts come or go: a frame's sandbox is read as it loads. Without
              `allow-scripts` the page's HTML and CSS still draw, and nothing in it runs. */}
          {/* A press inside a frame is not seen from here. While the page with scripts does not have the focus by the
              person's doing, its frame takes no pointer (`data-page-shield`), so the press comes to this box instead and
              puts the focus in the page (usePageFocusGuard); the next press is the page's. */}
          <div className="file-viewer-page-frame" data-page-shield={guard.shield ? "" : undefined} onClick={guard.shield ? guard.enter : undefined}>
            {relay ? <RelayRenderedPage key={pageScripts ? "scripts" : "static"} path={pageUrl} title={info.name} scripts={pageScripts} frame={pageFrame} />
              : <iframe key={pageScripts ? "scripts" : "static"} ref={pageFrame} className="file-viewer-page" src={pageSrc ?? undefined} sandbox={pageScripts ? "allow-scripts" : ""}
                data-page-scripts={pageScripts ? "on" : "off"} title={info.name} />}
          </div>
        </>;
        return loaded === null || (view === "markdown" && preview.status !== "ready")
          ? null
          // a text the renderer cannot draw fails here, not the app: the header (Show source, Raw,
          // Close) stays, and a Preview that fails offers its source
          : <>
          {previewRefused && <p className="file-viewer-note" role="status">{t("Markdown preview is unavailable. Showing source.")}</p>}
          <RenderBoundary key={view} resetKey={loaded} fallback={() => view === "markdown"
            ? <div className="file-viewer-note" role="alert">
              <p>{t("This preview can't be shown.")}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setChosen({ path, mode: "code" })}>{t("Show source")}</button>
            </div>
            : <p className="file-viewer-note" role="alert">{t("The file could not be opened.")}</p>}>
            <MarkdownImageContext.Provider value={imagePreview}>
              {htmlPage && modes}<TextFileView sourceComments={!page && codeShown && !selectable ? sourceComments : null} path={info.path} blocks={view === "markdown" && preview.status === "ready" ? preview.blocks : null} lines={code.lines} virtual={virtual} selectable={selectable} onOpen={onOpen ?? setPath} sourceRef={sourceRef} previewRef={previewRef} markedLine={request?.kind === "shown" ? request.line : null} />
            </MarkdownImageContext.Provider>
          </RenderBoundary></>;
      default:
        return <p className="file-viewer-note">{t("This file can't be previewed here. Download it to open it.")} <span className="file-viewer-note-meta">{info.mime}, {formatBytes(info.size)}</span></p>;
    }
  })();

  const Heading = page ? "h1" : "h2";
  const locationTitle = remote ? `${machineId} · ${shownPath}` : shownPath;
  const newTabHref = relay ? previewUrl : htmlPage && !source ? pageUrl : markdown ? previewUrl : url;
  const newTabSrc = useResourceUrl(newTabHref);
  const rawSrc = relay ? readerHref(machineId, `${shownPath}#L1`) : urlSrc;
  const title = <div className="file-viewer-title">
      <Heading className="modal-title"><span className="file-viewer-stem">{stem}</span>{extension}</Heading>
      <p className="file-viewer-meta" title={locationTitle}>
        {/* a partial view is told by the size ("256 KB of 1.3 MB") in the warning color, beside an
            icon so the color is not the only sign; what it means is the tooltip (and read out) */}
        {info && (noticed
          ? <span className="file-viewer-notice" title={notes.join("\n")}>
            <TriangleAlert aria-hidden="true" />
            <span>{cutBytes !== null ? t("{done} of {total}", { done: formatBytes(cutBytes.shown), total: formatBytes(cutBytes.total) }) : formatBytes(info.size)}</span>
            <span className="visually-hidden">{notes.join(". ")}</span>
          </span>
          : <span className="file-viewer-size">{formatBytes(info.size)}</span>)}
        {/* the dot is the folder's, so where the folder has no room left no dot dangles */}
        {folder !== "" && <span className="file-viewer-path"><span dir="ltr">{info && <span className="file-viewer-dot" aria-hidden="true">·</span>}{remote ? `${machineId}:${folder}` : folder}</span></span>}
      </p>
    </div>;
  const actions = <div className="file-viewer-actions">
      {!page && commentsShown && <div className="file-viewer-group">
        <button type="button" className="icon-button file-viewer-action file-viewer-comments" aria-label={countLabel} title={`${countLabel}\n${t("Go to the next comment")}`} onClick={nextComment}>
          <MessageSquare aria-hidden="true" />
          <span className="file-viewer-comments-count" aria-hidden="true">{fileComments > 99 ? "99+" : fileComments}</span>
        </button>
      </div>}
      {outlineButton && <div className="file-viewer-group">{outlineButton}</div>}
      {/* Preview/source is one toggle; the enclosing Files header owns the shared wrap toggle. */}
      {!compact && textFile && previewable && !editing && <div className="file-viewer-group">
        <button type="button" className="icon-button file-viewer-action" aria-pressed={mode === "code"} aria-label={t("Show source")} title={t("Show source")} onClick={() => { if (leaveComment()) setChosen({ path, mode: mode === "code" ? "preview" : "code" }); }}><Braces aria-hidden="true" /></button>
      </div>}
      {/* the file itself: a Markdown tab is the reader; raw and download keep the original bytes */}
      <div className="file-viewer-group">
        {!page && !appWindow && <a className="icon-button file-viewer-action" href={newTabSrc ?? undefined} target="_blank" rel="noopener" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>}
        {(page || markdown) && !appWindow && <a className="icon-button file-viewer-action" href={rawSrc ?? undefined} target="_blank" rel="noopener" aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></a>}
        {!page && appWindow && <CopyLinkButton href={newTabHref} />}
        <a className="icon-button file-viewer-action" href={downloadHref ?? undefined} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
        {canEdit && !editing && <button type="button" className="icon-button file-viewer-action" aria-label={t("Edit file")} title={t("Edit file")} onClick={() => { if (leaveComment()) setEditing(true); }}><Pencil aria-hidden="true" /></button>}
        {copyable && !editing && <CopyFileButton text={loaded.text} sourceRef={sourceRef} onShowSource={showSourceToSelect} />}
      </div>
    </div>;
  const header = <header className={
    "modal-header file-viewer-header file-viewer-header-stacked" + (page ? " file-reader-header" : "")
  }>
    {title}
    {actions}
    {!page && <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>}
  </header>;
  const bodyClass = virtual !== null && view === "code" ? "file-viewer-body file-viewer-body-virtual" : "file-viewer-body";
  if (page) return (
    <main ref={surface} className="file-reader">
      {header}
      {withOutline(<div ref={bodyRef} className={`${bodyClass} file-reader-body`} tabIndex={-1}>{body}{openingNote}</div>)}
    </main>
  );

  return (
    <div className="file-viewer-embedded">
      <section className={virtual !== null && view === "code" ? "modal file-viewer file-viewer-virtual" : "modal file-viewer"} role="region" aria-label={info?.name ?? path} ref={surface} tabIndex={-1}>
        {compact ? <>
          {toolbar.document && toolbar.title && createPortal(title, toolbar.title)}
          {toolbar.document && toolbar.mode && (previewable || onShowDiff) && createPortal(
            <select className="files-mobile-view" aria-label={t("File view")} value={view === "markdown" ? "preview" : "source"} onChange={(event) => {
              if (!leaveComment()) return;
              if (event.target.value === "diff") onShowDiff?.();
              else setChosen({ path, mode: event.target.value === "preview" ? "preview" : "code" });
            }}>
              {previewable && <option value="preview">{t("Preview")}</option>}
              <option value="source">{t("Source")}</option>
              {onShowDiff && <option value="diff">{t("Diff")}</option>}
            </select>, toolbar.mode)}
          {toolbar.document && toolbar.actions && createPortal(<><div className="files-mobile-info">{title}</div>{actions}
            <button type="button" className="icon-button" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button></>, toolbar.actions)}
        </> : header}
        {withOutline(<div ref={bodyRef} className={bodyClass}>
          {body}{openingNote}
          {editing ? null : view === "markdown" && preview.status === "ready" && scope !== null
            ? <PreviewComments key={`${owner}:${scope.path}`} scope={scope} comments={comments} preview={previewRef} surface={bodyRef}
                connected={connected} initialId={requestedComment} requestKey={commentRequest} />
            : (!codeShown || selectable) && fileComments > 0 && sourceComments}
        </div>)}
      </section>
    </div>
  );
}
