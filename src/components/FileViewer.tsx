import { getTransport } from "../lib/transport.ts";
import { useResourceUrl } from "../lib/useResourceUrl.ts";
import { createPortal } from "react-dom";
import { FileToolbarContext } from "./MobileFilesToolbar.tsx";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Braces, Check, Code, Copy, Download, ExternalLink, Link2, MessageSquare, TriangleAlert, X } from "lucide-react";

import "./FileViewer.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useFileComments, type FileCommentScope } from "./FileComments.tsx";
import { PreviewComments } from "./PreviewComments.tsx";
import { SourceComments } from "./SourceComments.tsx";
import { useHighlightedLines } from "./HighlightedCode.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { TextFileView } from "./TextFileView.tsx";
import { MarkdownImageContext } from "./Markdown.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
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
import { changedField, revealField } from "../lib/commentDom.ts";
import { lastFileStop } from "../lib/commentWalk.ts";
import { MAX_INLINE_IMAGE_BYTES, markdownImagePreview } from "../lib/markdownImages.ts";
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { knownPreview, parsePreviewOffThread } from "../lib/markdownPreview.ts";
import { hasPreview, type TextViewMode } from "../lib/textPreview.ts";
import { readFilePreviewText, SOURCE_PREVIEW_LINES, type FilePreviewText } from "../lib/filePreviewText.ts";
import { readerHref } from "../lib/fileReader.ts";

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
  /** The containing review can also show this Markdown document as a diff. */
  onShowDiff?: () => void;
  initialMode?: TextViewMode;
  connected?: boolean;
  /** A document-only page, without the enclosing workspace browser. */
  page?: boolean;
  /** absolute, `~/…`, or relative to the pane's folder; optionally with a line reference */
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
}

/**
 * Copies the whole file; owns its "copied" flip, so only the button re-renders for it. When nothing
 * copies it (no clipboard API on plain-HTTP LAN, and the browser's copy command refused: copyText)
 * it selects the source `<pre>` instead; in a Markdown Preview there is none, and a virtualized
 * source has no element holding the whole text, so `onShowSource` shows a selectable source first
 * and the viewer selects it once rendered.
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
 * In the installed app's window, where a new tab of this origin would open another app window,
 * the address is copied instead, to paste into a browser. As a menu item it closes the menu.
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

/** Selects a source element for a copy by hand: a text box selects its value, anything else its contents. */
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
export function FileViewer({ connected = false, page = false, path: asked, paneId, machineId: givenMachineId, paneFolder = null, onClose, onOpen, commentId = null, onShowDiff, initialMode }: FileViewerProps) {
  const t = useT();
  const toolbar = useContext(FileToolbarContext);
  const compact = toolbar !== null;
  const locale = useLocale();
  const appWindow = useAppWindow();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const contextMachineId = useMachineId();
  const machineId = givenMachineId ?? contextMachineId;
  const remote = machineId !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  // the path as given, until a choice among files of that name replaces it
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
  const [error, setError] = useState<"missing" | "unreadable" | null>(null);
  const [source, setSource] = useState(target.line !== null);
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
  // Copy failed in a Preview: select the source as soon as the Code view has rendered
  const selectSourceOnCode = useRef(false);
  /** Switches a Preview to its source and has it selected once rendered, for Copy without a clipboard. */
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
        clearTimeout(deadline);
        const timeoutMs = Math.max(1, budget.timeoutMs - (Date.now() - started));
        const body = await readFilePreviewText(response, budget.bytes, { signal: download.signal, maxLines: budget.lines, timeoutMs, partialOnTimeout: true });
        if (!cancelled) setLoaded(body);
      } finally { clearTimeout(deadline); }
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      // a folder is listed from the pane's folder, as a file is found from it
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(target.path))) {
        try {
          const listing = await fetchDirectories(target.path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch { /* retain the file error when the target is not a readable directory */ }
      }
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? "missing" : "unreadable");
    });
    return () => { cancelled = true; clearTimeout(deadline); download.abort(); };
  }, [target.path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? target.path, paneId);
  const textFile = info?.kind === "text";
  const language = languageForPath(info?.path ?? target.path);
  // a Preview its parser gave up on (too slow, or failed) opens the source instead
  const preview = useMarkdownPreview(textFile && loaded !== null && mode === "preview" && hasPreview(language) ? loaded.text : null);
  const previewRefused = preview.status === "failed";
  const previewable = hasPreview(language) && !previewRefused;
  const view = previewable && mode === "preview" ? "markdown" : "code";
  const htmlPage = info !== null && info.kind === "text" && info.mime === "text/html";
  const pageUrl = `${url}&render=1`;
  const urlSrc = useResourceUrl(url);
  const pageSrc = useResourceUrl(pageUrl);
  const imageSrc = useResourceUrl(info?.kind === "image" ? `${url}&revision=${encodeURIComponent(`${info.modified}:${info.size}`)}` : null);
  const modes = <div className="segmented file-viewer-modes" role="group" aria-label={t("Show the HTML file as")}>
    <button type="button" aria-pressed={!source} onClick={() => { if (leaveComment()) setSource(false); }}>{t("Page")}</button>
    <button type="button" aria-pressed={source} onClick={() => { if (leaveComment()) setSource(true); }}>{t("Source")}</button>
  </div>;
  const codeShown = textFile && loaded !== null && view === "code" && (!htmlPage || source);
  // the source as shown (a cut prefix without the row after its final newline): past
  // VIRTUAL_SOURCE_LINES it is the virtualizer's rows, colored in its worker while small enough
  // (virtualHighlightable), else plain with the notice; below, CodeLines
  const sourceText = useMemo(() => codeShown ? shownSource(normalizeCode(loaded.text), loaded.truncated) : "", [codeShown, loaded]);
  const sourceLines = useMemo(() => countLines(sourceText), [sourceText]);
  const layout = sourceLayout(sourceLines);
  const colorable = canHighlight(language);
  const virtual = useMemo(() => codeShown && layout === "virtual" ? { text: sourceText, colored: colorable && virtualHighlightable(sourceText.length, sourceLines) } : null, [codeShown, layout, sourceText, colorable, sourceLines]);
  // CodeLines' code has no length limit of its own (the layout bounds it): only a worker that gave up leaves it plain
  const code = useHighlightedLines(codeShown && layout === "elements" && (page || paneId === null || selectable) ? sourceText : "", codeShown ? language : null);
  const shownPath = info?.path ?? target.path;
  const { stem, extension } = pathParts(info?.name ?? shownPath);
  const { folder } = pathParts(shownPath);
  // what holds for the whole file is said with its size, where it is seen first, not after a megabyte of text
  const cutShort = textFile && (!htmlPage || source) && loaded !== null && loaded.truncated;
  const budget = textFile ? readBudget(language, info.size) : null;
  // a cut at the byte budget is told in sizes; one at the line cap in lines; one by the deadline
  // (a slow link) only says part is shown, since its size is not the budget's
  const cutBytes = cutShort && budget !== null && loaded.truncatedBy !== "lines" && loaded.truncatedBy !== "time" && (loaded.total ?? info.size) > budget.bytes ? { shown: budget.bytes, total: loaded.total ?? info.size } : null;
  // a cut prefix's lines are the reader's count of complete lines: the line just past the cap is unseen
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
  const markdown = info?.kind === "text" && /\.(?:md|markdown)$/i.test(info.name);
  // a page of just the document, not the app over it (FileReader)
  const previewUrl = readerHref(machineId, shownPath + (target.line === null ? "" : `#L${target.line}`));
  const newTabHref = htmlPage && !source ? pageUrl : markdown ? previewUrl : url;
  const newTabSrc = useResourceUrl(newTabHref);
  const downloadHref = useResourceUrl(fileUrl(shownPath, paneId, true));
  // images of a markdown file load through the file endpoint, as the file itself does
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
    if (error !== null) return <p className="file-viewer-note" role="alert">{error === "missing" ? t("No readable file at this path.") : t("The file could not be opened.")}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">{t("Several files are named {name}:", { name: target.path.split("/").pop() ?? target.path })}</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate + path.slice(target.path.length))}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return null;
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
        if (htmlPage && !source) return <>{modes}<iframe className="file-viewer-page" src={pageSrc ?? undefined} sandbox="allow-scripts" title={info.name} /></>;
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
  const title = <div className="file-viewer-title">
      {/* a long name is cut inside its stem, so its type stays in view */}
      <Heading className="modal-title"><span className="file-viewer-stem">{stem}</span>{extension}</Heading>
      <p className="file-viewer-meta" title={shownPath}>
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
        {folder !== "" && <span className="file-viewer-path"><span dir="ltr">{info && <span className="file-viewer-dot" aria-hidden="true">·</span>}{folder}</span></span>}
      </p>
    </div>;
  const actions = <div className="file-viewer-actions">
      {!page && commentsShown && <div className="file-viewer-group">
        <button type="button" className="icon-button file-viewer-action file-viewer-comments" aria-label={countLabel} title={`${countLabel}\n${t("Go to the next comment")}`} onClick={nextComment}>
          <MessageSquare aria-hidden="true" />
          <span className="file-viewer-comments-count" aria-hidden="true">{fileComments > 99 ? "99+" : fileComments}</span>
        </button>
      </div>}
      {/* Preview/source is one toggle; the enclosing Files header owns the shared wrap toggle. */}
      {!compact && textFile && previewable && <div className="file-viewer-group">
        <button type="button" className="icon-button file-viewer-action" aria-pressed={mode === "code"} aria-label={t("Show source")} title={t("Show source")} onClick={() => { if (leaveComment()) setChosen({ path, mode: mode === "code" ? "preview" : "code" }); }}><Braces aria-hidden="true" /></button>
      </div>}
      {/* the file itself: a Markdown tab is the reader; raw and download keep the original bytes */}
      <div className="file-viewer-group">
        {!page && !appWindow && <a className="icon-button file-viewer-action" href={newTabSrc ?? undefined} target="_blank" rel="noopener" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>}
        {(page || markdown) && !appWindow && <a className="icon-button file-viewer-action" href={urlSrc ?? undefined} target="_blank" rel="noopener" aria-label={t("Open raw file")} title={t("Open raw file")}><Code aria-hidden="true" /></a>}
        {!page && appWindow && <CopyLinkButton href={newTabHref} />}
        <a className="icon-button file-viewer-action" href={downloadHref ?? undefined} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
        {copyable && <CopyFileButton text={loaded.text} sourceRef={sourceRef} onShowSource={showSourceToSelect} />}
      </div>
    </div>;
  const header = <header className={
    "modal-header file-viewer-header file-viewer-header-stacked" + (page ? " file-reader-header" : "")
  }>
    {title}
    {actions}
    {!page && <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close file")} title={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>}
  </header>;
  // a virtualized source fills the viewer: its rows are a window the user scrolls, so the body
  // takes a definite height for the scroll root to fill, instead of growing with the text
  const bodyClass = virtual !== null && view === "code" ? "file-viewer-body file-viewer-body-virtual" : "file-viewer-body";
  if (page) return (
    <main ref={surface} className="file-reader">
      {header}
      {/* the focus starts here, as in the popup: a scroll box takes Space and the arrows */}
      <div ref={bodyRef} className={`${bodyClass} file-reader-body`} tabIndex={-1}>{body}{openingNote}</div>
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
        <div ref={bodyRef} className={bodyClass}>
          {body}{openingNote}
          {view === "markdown" && preview.status === "ready" && scope !== null
            ? <PreviewComments key={`${owner}:${scope.path}`} scope={scope} comments={comments} preview={previewRef} surface={bodyRef}
                connected={connected} initialId={requestedComment} requestKey={commentRequest} />
            : (!codeShown || selectable) && fileComments > 0 && sourceComments}
        </div>
      </section>
    </div>
  );
}
