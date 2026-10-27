import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FolderSearch, GitCompareArrows, FolderInput } from "lucide-react";
import { WorkspaceFileSearch } from "./WorkspaceFileSearch.tsx";
import { CommitPicker } from "./CommitPicker.tsx";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { GitChangesResponse, GitFileDiffResponse } from "../../shared/protocol.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { workspaceChanges } from "../lib/workspaceChanges.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useSettings } from "../lib/settings.ts";
import { PIERRE_THEME } from "../lib/pierreTheme.ts";
import { changedMarkdownPreviewPath, changedWorkspacePath, workspacePreviewPath, type WorkspaceFileIntent } from "../lib/workspaceBrowser.ts";
import { useT } from "../lib/i18n.ts";
import { WorkspaceFileTree } from "./WorkspaceFileTree.tsx";
import { DiffOrphanComments, DiffViewer } from "./DiffViewer.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import "./ChangesView.css";

const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = { theme: PIERRE_THEME, tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000 };
const absolutePath = (root: string, path: string) => `${root.replace(/[\\/]$/, "")}/${path}`;

/** One queue survives revisions so superseded requests still count toward the bound. */
function createDiffQueue() {
  let active = 0;
  const waiting: Array<() => Promise<void>> = [];
  function pump() {
    while (active < 3 && waiting.length) {
      const job = waiting.shift()!;
      active++;
      void job().finally(() => { active--; pump(); });
    }
  }
  return (job: () => Promise<void>) => { waiting.push(job); pump(); };
}

function DiffSection({ paneId, inventory, path, owner, connected, split, scrollRoot, queue, selected, onActive, onReveal, initialId, findActive, keyboardActive }: {
  paneId: string; inventory: GitChangesResponse; path: string; owner: string;
  connected: boolean; split: boolean; scrollRoot: RefObject<HTMLDivElement | null>;
  queue: ReturnType<typeof createDiffQueue>; selected: boolean; onActive: (path: string) => void; onReveal: (path: string) => void; initialId?: string; findActive: boolean; keyboardActive: boolean;
}) {
  const t = useT();
  const { fetchGitDiff } = useMachineApi();
  const surface = useRef<HTMLElement>(null);
  const [near, setNear] = useState(selected);
  const [file, setFile] = useState<GitFileDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (selected) setNear(true); }, [selected]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { root: scrollRoot.current, rootMargin: "600px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRoot]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    setError(null);
    queue(async () => {
      if (!live) return;
      try {
        const next = await fetchGitDiff(paneId, "all", path, inventory.base_commit);
        if (!live) return;
        if (next.revision !== inventory.revision || next.root !== inventory.root) {
          setError(t("Files changed while this diff was loading. Refresh to review the latest changes."));
        } else {
          setFile(next);
        }
      } catch {
        if (live) setError(t("This diff could not be loaded. The file may have changed, be too large, or have unresolved conflicts."));
      }
    });
    return () => { live = false; };
  }, [near, queue, fetchGitDiff, paneId, path, inventory.revision, inventory.root, inventory.base_commit, attempt, t]);
  const fallbackComments = <DiffOrphanComments owner={owner} connected={connected} root={inventory.root} mode="all" paths={[]} onlyPaths={[path, ...inventory.files.filter((entry) => entry.path === path && entry.old_path).map((entry) => entry.old_path!)]} initialId={initialId} />;
  return <section ref={surface} className="changes-diff-section" aria-label={path} data-diff-path={path} data-find-owner={findActive} onPointerDown={() => onActive(path)}>
    <header className="changes-diff-header">
      <h3 className="changes-diff-title" title={path} aria-label={path}>
        {path.includes("/") && <span className="changes-diff-directory" aria-hidden="true">{path.slice(0, path.lastIndexOf("/") + 1)}</span>}
        <span className="changes-diff-filename" aria-hidden="true">{path.slice(path.lastIndexOf("/") + 1)}</span>
      </h3>
      <button type="button" className="icon-button" aria-label={t("Reveal in file tree")} title={t("Reveal in file tree")} onPointerDown={(event) => event.stopPropagation()} onClick={() => onReveal(path)}><FolderInput aria-hidden="true" /></button>
    </header>
    {error && <p className="changes-note" role="alert">{error} <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>{t("Retry")}</button></p>}
    {!file && !error && <p className="changes-diff-placeholder changes-note" role="status">{t("Loading…")}</p>}
    {error && fallbackComments}
    {file && <RenderBoundary resetKey={`${file.revision}:${file.path}`} fallback={(retry) => <><p role="alert">{t("This diff could not be displayed.")} <button type="button" className="btn" onClick={retry}>{t("Retry")}</button></p>{fallbackComments}</>}>
      <DiffViewer file={file} mode="all" owner={owner} connected={connected} split={split} initialId={initialId} findActive={findActive} keyboardActive={keyboardActive} onFindActive={() => onActive(path)} />
    </RenderBoundary>}
  </section>;
}

export default function ChangesView({ paneId, start, connected, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, showFile, onShowFile, refreshToken, keyboardActive, onHideFile, onDiffsChange, toolsHost, gitToolsHost, searchOpen, searchActive, onSearchOpen, onSearchClose }: {
  paneId: string | null; start: string; connected: boolean; initialIntent?: WorkspaceFileIntent; initialComment?: FileComment | null;
  initialPath?: string | null; initialCommentId?: string | null; showFile: boolean; onShowFile: () => void; refreshToken: number; keyboardActive: boolean; onHideFile: () => void; onDiffsChange: (hasDiffs: boolean) => void; toolsHost: HTMLElement | null; gitToolsHost: HTMLElement | null;
  searchOpen: boolean; searchActive: boolean; onSearchOpen: () => void; onSearchClose: () => void;
}) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchGitChanges, fetchFileInfo } = useMachineApi();
  const { settings } = useSettings();
  const [inventory, setInventory] = useState<GitChangesResponse | null>(null);
  const [path, setPath] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [revealToken, setRevealToken] = useState(0);
  const [preview, setPreview] = useState<string | null>(initialComment?.diff ? null : initialPath);
  const [documentClosed, setDocumentClosed] = useState(!initialPath && !initialComment);
  const [comparisonVersion, setComparisonVersion] = useState(0);
  const [comparisonActive, setComparisonActive] = useState(!!initialComment?.diff);
  const [baseCommit, setBaseCommit] = useState<string | undefined>(initialComment?.diff?.base_commit);
  const [comparisonPath, setComparisonPath] = useState<string | null>(null);
  // undefined: closed, null: all files, string: one repository-relative file.
  const [compareTarget, setCompareTarget] = useState<string | null | undefined>(undefined);
  useEffect(() => { if (searchOpen) setCompareTarget(undefined); }, [searchOpen]);
  useEffect(() => {
    onDiffsChange(inventory?.files.some((file) => comparisonPath === null || file.path === comparisonPath || file.old_path === comparisonPath) ?? false);
  }, [inventory, comparisonPath, onDiffsChange]);
  const [initialRequestActive, setInitialRequestActive] = useState(true);
  const initialRequest = useRef(true);
  // An inventory read already in flight must not reselect a file after it closes.
  const closed = useRef(!initialPath && !initialComment);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [jump, setJump] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [queue] = useState(createDiffQueue);
  const narrow = useMediaQuery("(max-width: 768px)");
  const surface = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!keyboardActive || preview || compareTarget !== undefined || searchOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      const focused = document.activeElement;
      if (focused instanceof Element && (focused.closest(".comment-popover, .command-palette, .commit-picker, dialog") || focused.closest("[aria-modal='true']") !== surface.current?.closest("[aria-modal='true']"))) return;
      const section = surface.current?.querySelector<HTMLElement>('.changes-diff-section[data-find-owner="true"]');
      const button = section?.querySelector<HTMLButtonElement>(".diff-find-button");
      if (!button) return;
      event.preventDefault(); event.stopPropagation();
      if (!button.disabled) button.click();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [keyboardActive, preview, compareTarget, searchOpen]);
  const canLeave = useCallback(() => {
    const field = changedField(surface.current);
    if (field !== null) { revealField(field); return false; }
    return true;
  }, []);
  useEffect(() => {
    if (paneId === null || !canLeave()) return;
    let live = true;
    setLoading(true);
    fetchGitChanges(paneId, "all", baseCommit).then((next) => {
      if (!live || !canLeave()) return;
      if (baseCommit === undefined) workspaceChanges.publish({ machineId, paneId, cwd: start }, next);
      setInventory(next);
      setError(null);
      const requested = initialRequest.current && initialComment?.diff
        ? changedWorkspacePath(next, absolutePath(next.root, initialComment.diff.path)) : null;
      if (requested) { setPath(requested); setJump(requested); }
      else if (!closed.current) setPath((selected) => next.files.some((file) => file.path === selected) ? selected : null);
    }).catch(() => {
      if (live) setError(t("Git changes could not be loaded. Check that this pane is in a Git repository and its bridge supports diffs."));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [fetchGitChanges, paneId, refreshToken, baseCommit, comparisonVersion, t, canLeave]);
  // Chat links may be relative, home-relative or bare names. Resolve them with the
  // same machine-bound reader as ordinary files before selecting a changed path.
  const resolvedInitial = useRef(false);
  useEffect(() => {
    if (!initialPath || !inventory || resolvedInitial.current || initialComment?.diff) return;
    const candidate = /^(?:[A-Za-z]:|\/|~)/.test(initialPath) ? initialPath : absolutePath(start, initialPath);
    const direct = changedWorkspacePath(inventory, candidate);
    if (direct && !initialComment && !initialCommentId && canLeave()) {
      resolvedInitial.current = true;
      const document = workspacePreviewPath(inventory, candidate, initialIntent === "browse" ? "preview" : initialIntent);
      setPreview(document); setPath(direct); setJump(document === null ? direct : null);
      return;
    }
    let live = true;
    fetchFileInfo(initialPath, paneId).then((info) => {
      if (!live || resolvedInitial.current || "candidates" in info || !canLeave()) return;
      resolvedInitial.current = true;
      const changed = changedWorkspacePath(inventory, info.path);
      if (changed && !initialComment && !initialCommentId) {
        const document = workspacePreviewPath(inventory, info.path, initialIntent === "browse" ? "preview" : initialIntent);
        setPreview(document); setPath(changed); setJump(document === null ? changed : null);
      } else setPreview(info.path);
    }).catch(() => { /* The embedded reader shows the file error or candidate choices. */ });
    return () => { live = false; };
  }, [initialPath, start, inventory, fetchFileInfo, paneId, initialIntent, initialComment, initialCommentId, canLeave]);
  useEffect(() => {
    if (!jump || preview || !showFile && narrow) return;
    const element = [...documentRef.current?.querySelectorAll<HTMLElement>("[data-diff-path]") ?? []].find((node) => node.dataset.diffPath === jump);
    if (element) { element.scrollIntoView({ block: "start" }); setJump(null); }
  }, [jump, inventory, preview, showFile, narrow]);
  function select(absolute: string, intent: WorkspaceFileIntent | "preview" = comparisonActive ? "changes" : initialIntent) {
    if (!canLeave()) return;
    resolvedInitial.current = true;
    initialRequest.current = false;
    setInitialRequestActive(false);
    closed.current = false;
    setDocumentClosed(false);
    onShowFile();
    const changed = inventory ? changedWorkspacePath(inventory, absolute) : null;
    const document = inventory ? workspacePreviewPath(inventory, absolute, intent) : absolute;
    setComparisonPath(baseCommit ? changed : null);
    setPreview(document); setPath(changed); setJump(document === null ? changed : null);
  }
  function revealInTree(relative: string) {
    if (!canLeave()) return;
    resolvedInitial.current = true;
    initialRequest.current = false;
    setInitialRequestActive(false);
    setPath(relative);
    setRevealToken((value) => value + 1);
    if (narrow) onHideFile();
  }
  function compare(commit: string | null) {
    if (!canLeave()) return;
    resolvedInitial.current = true;
    initialRequest.current = false;
    setInitialRequestActive(false);
    closed.current = false;
    setDocumentClosed(false);
    setPreview(null);
    setPath(compareTarget ?? null);
    setJump(compareTarget ?? null);
    setComparisonPath(compareTarget ?? null);
    setInventory(null);
    setError(null);
    setBaseCommit(commit ?? undefined);
    setComparisonActive(true);
    setCompareTarget(undefined);
    setComparisonVersion((value) => value + 1);
    onShowFile();
  }
  function closeDocument() {
    if (!canLeave()) return;
    resolvedInitial.current = true;
    initialRequest.current = false;
    setInitialRequestActive(false);
    closed.current = true;
    setDocumentClosed(true);
    setPreview(null); setPath(null); setJump(null);
    onHideFile();
  }
  // Once the embedded preview unmounts, return keyboard focus to navigation.
  useEffect(() => {
    if (!documentClosed) return;
    const target = surface.current?.querySelector<HTMLElement>(".workspace-tree-row") ?? surface.current?.closest<HTMLElement>(".files-dialog");
    target?.focus();
  }, [documentClosed]);
  const root = inventory?.root ?? start;
  const selectedChanged = preview && inventory ? changedWorkspacePath(inventory, preview) : path;
  const markdownPath = inventory && selectedChanged ? changedMarkdownPreviewPath(inventory, selectedChanged) : null;
  function showMarkdown(mode: "preview" | "diff") {
    if (!markdownPath || !selectedChanged || !canLeave()) return;
    resolvedInitial.current = true;
    setPath(selectedChanged);
    setPreview(mode === "preview" ? markdownPath : null);
    setJump(mode === "diff" ? selectedChanged : null);
    onShowFile();
  }
  // Canonical navigation must not replace the document opened by the initial link.
  const readerPath = initialRequestActive && initialPath ? initialPath : preview;
  const owner = paneId === null ? null : paneStorageId(machineId, paneId);
  return <div ref={surface} data-show-file={showFile || undefined} className={`changes-view${narrow && showFile ? " is-showing-file" : ""}`}>
    {paneId !== null && toolsHost !== null && createPortal(
      <button type="button" className="icon-button" aria-label={t("Find files…")} title={t("Find files…")} aria-haspopup="dialog" aria-expanded={searchOpen}
        onClick={onSearchOpen}><FolderSearch aria-hidden="true" /></button>, toolsHost)}
    {paneId !== null && gitToolsHost !== null && createPortal(<>
      <button type="button" className="icon-button file-compare-button" data-commit-picker-trigger="" data-base-commit={baseCommit} aria-expanded={compareTarget !== undefined}
        aria-label={t("Compare with…")} title={baseCommit ? `${t("Compare with…")} ${baseCommit} → ${t("Working tree")}` : t("Compare with…")}
        onClick={() => setCompareTarget((target) => target === null ? undefined : null)}><GitCompareArrows aria-hidden="true" /></button>
      {compareTarget !== undefined && <CommitPicker paneId={paneId} label={compareTarget ?? t("All files")} onSelect={compare} onClose={() => setCompareTarget(undefined)} />}
    </>, gitToolsHost)}
    {paneId !== null && searchOpen && createPortal(<WorkspaceFileSearch paneId={paneId} refreshToken={refreshToken} keyboardActive={searchActive}
      onSelect={(absolute) => { select(absolute); onSearchClose(); }} onClose={onSearchClose} />, document.body)}
    {markdownPath !== null && (!narrow || showFile) && <div className="changes-markdown-mode">
      <div className="segmented" role="group" aria-label={t("Markdown view")}>
        <button type="button" aria-pressed={preview !== null} onClick={() => showMarkdown("preview")}>{t("Preview")}</button>
        <button type="button" aria-pressed={preview === null} onClick={() => showMarkdown("diff")}>{t("Diff")}</button>
      </div>
    </div>}
    <div className="changes-layout">
      <aside className="changes-navigation"><WorkspaceFileTree root={root} paneId={paneId} files={inventory?.files ?? []} refreshToken={refreshToken} revealToken={revealToken} selected={preview ?? (path ? absolutePath(root, path) : null)} onSelect={select} onCompare={paneId === null ? undefined : (relative) => setCompareTarget(relative)} /></aside>
      {/* Scrolling a comment into view (or collapsing it after Save) is not file navigation. */}
      <div className="changes-detail" ref={documentRef} aria-label={t("File diff")}>
        {documentClosed ? <p className="changes-note" role="status">{t("Select a file to view.")}</p> : preview ? <FileViewer key={`${readerPath}:${refreshToken}`} keyboardActive={keyboardActive} path={readerPath!} paneId={paneId} machineId={machineId} paneFolder={start} connected={connected}
          commentId={!initialRequestActive || initialComment?.diff ? null : initialComment?.id ?? initialCommentId} onOpen={(absolute) => select(absolute, "preview")} onClose={closeDocument} /> : <>
          {loading && !inventory && <p className="changes-note" role="status">{t("Loading…")}</p>}
          {error !== null && <p className="changes-note" role="alert">{error}</p>}
          {inventory && (inventory.files.length === 0 || comparisonPath !== null && !inventory.files.some((file) => file.path === comparisonPath || file.old_path === comparisonPath)) && <p className="changes-note" role="status">{t("No changes in this comparison.")}</p>}
          <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
            {paneId !== null && owner !== null && inventory?.files.filter((file) => comparisonPath === null || file.path === comparisonPath || file.old_path === comparisonPath).map((file, index) => <DiffSection key={`${owner}:${inventory.root}:${inventory.revision}:${file.path}`} paneId={paneId} inventory={inventory} path={file.path} owner={owner} connected={connected} split={settings.diffStyle === "split" && !narrow} findActive={path === file.path || path === null && index === 0} keyboardActive={keyboardActive && compareTarget === undefined && !searchOpen} scrollRoot={documentRef} queue={queue} initialId={initialRequestActive && (file.path === initialComment?.diff?.path || file.old_path === initialComment?.diff?.path) ? initialComment?.id : undefined} selected={path === file.path} onActive={setPath} onReveal={revealInTree} />)}
          </WorkerPoolContextProvider>
        </>}
      </div>
    </div>
    {owner !== null && (inventory !== null || error !== null && initialComment?.diff !== undefined) && <DiffOrphanComments owner={owner} connected={connected}
      root={inventory?.root ?? initialComment!.diff!.repository} mode="all" initialId={initialRequestActive ? initialComment?.id : undefined}
      paths={inventory?.files.filter((file) => !documentClosed && preview === null && (comparisonPath === null || file.path === comparisonPath || file.old_path === comparisonPath)).flatMap((file) => file.old_path === undefined ? [file.path] : [file.path, file.old_path]) ?? []} />}
  </div>;
}
