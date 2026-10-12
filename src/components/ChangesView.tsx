import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { GitChangesResponse, GitFileDiffResponse } from "../../shared/protocol.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
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

function DiffSection({ paneId, inventory, path, owner, connected, split, scrollRoot, queue, selected, onActive }: {
  paneId: string; inventory: GitChangesResponse; path: string; owner: string;
  connected: boolean; split: boolean; scrollRoot: RefObject<HTMLDivElement>;
  queue: ReturnType<typeof createDiffQueue>; selected: boolean; onActive: (path: string) => void;
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
        const next = await fetchGitDiff(paneId, "all", path);
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
  }, [near, queue, fetchGitDiff, paneId, path, inventory.revision, inventory.root, attempt, t]);
  return <section ref={surface} className="changes-diff-section" aria-label={path} data-diff-path={path} onMouseEnter={() => onActive(path)}>
    {error && <p className="changes-note" role="alert">{error} <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>{t("Retry")}</button></p>}
    {!file && !error && <p className="changes-diff-placeholder changes-note" role="status">{t("Loading…")}</p>}
    {file && <RenderBoundary resetKey={`${file.revision}:${file.path}`} fallback={(retry) => <p role="alert">{t("This diff could not be displayed.")} <button type="button" className="btn" onClick={retry}>{t("Retry")}</button></p>}>
      <DiffViewer file={file} mode="all" owner={owner} connected={connected} split={split} />
    </RenderBoundary>}
  </section>;
}

export default function ChangesView({ paneId, start, connected, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, showFile, onShowFile, refreshToken, keyboardActive, onHideFile }: {
  paneId: string | null; start: string; connected: boolean; initialIntent?: WorkspaceFileIntent; initialComment?: FileComment | null;
  initialPath?: string | null; initialCommentId?: string | null; showFile: boolean; onShowFile: () => void; refreshToken: number; keyboardActive: boolean; onHideFile: () => void;
}) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchGitChanges, fetchFileInfo } = useMachineApi();
  const { settings } = useSettings();
  const [inventory, setInventory] = useState<GitChangesResponse | null>(null);
  const [path, setPath] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [preview, setPreview] = useState<string | null>(initialComment?.diff ? null : initialPath);
  const [documentClosed, setDocumentClosed] = useState(false);
  // An inventory read already in flight must not reselect a file after it closes.
  const closed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [jump, setJump] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [queue] = useState(createDiffQueue);
  const narrow = useMediaQuery("(max-width: 768px)");
  const surface = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const canLeave = useCallback(() => {
    const field = changedField(surface.current);
    if (field !== null) { revealField(field); return false; }
    return true;
  }, []);
  useEffect(() => {
    if (paneId === null || !canLeave()) return;
    let live = true;
    setLoading(true);
    fetchGitChanges(paneId, "all").then((next) => {
      if (!live || !canLeave()) return;
      setInventory(next);
      setError(null);
      if (!closed.current) setPath((selected) => next.files.some((file) => file.path === selected) ? selected : next.files[0]?.path ?? null);
    }).catch(() => {
      if (live) setError(t("Git changes could not be loaded. Check that this pane is in a Git repository and its bridge supports diffs."));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [fetchGitChanges, paneId, refreshToken, t, canLeave]);
  // Chat links may be relative, home-relative or bare names. Resolve them with the
  // same machine-bound reader as ordinary files before selecting a changed path.
  const resolvedInitial = useRef(false);
  useEffect(() => {
    if (!initialPath || !inventory || resolvedInitial.current || initialComment?.diff) return;
    const candidate = /^(?:[A-Za-z]:|\/|~)/.test(initialPath) ? initialPath : absolutePath(start, initialPath);
    const direct = changedWorkspacePath(inventory, candidate);
    if (direct && !initialComment && !initialCommentId && canLeave()) {
      resolvedInitial.current = true;
      const document = workspacePreviewPath(inventory, candidate, initialIntent);
      setPreview(document); setPath(direct); setJump(document === null ? direct : null);
      return;
    }
    let live = true;
    fetchFileInfo(initialPath, paneId).then((info) => {
      if (!live || resolvedInitial.current || "candidates" in info || !canLeave()) return;
      resolvedInitial.current = true;
      const changed = changedWorkspacePath(inventory, info.path);
      if (changed && !initialComment && !initialCommentId) {
        const document = workspacePreviewPath(inventory, info.path, initialIntent);
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
  function select(absolute: string) {
    if (!canLeave()) return;
    resolvedInitial.current = true;
    closed.current = false;
    setDocumentClosed(false);
    onShowFile();
    const changed = inventory ? changedWorkspacePath(inventory, absolute) : null;
    const document = inventory ? workspacePreviewPath(inventory, absolute, initialIntent) : absolute;
    setPreview(document); setPath(changed); setJump(document === null ? changed : null);
  }
  function closeDocument() {
    if (!canLeave()) return;
    resolvedInitial.current = true;
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
  const owner = paneId === null ? null : paneStorageId(machineId, paneId);
  return <div ref={surface} className={`changes-view${narrow && showFile ? " is-showing-file" : ""}`}>
    {markdownPath !== null && (!narrow || showFile) && <div className="changes-markdown-mode">
      <div className="segmented" role="group" aria-label={t("Markdown view")}>
        <button type="button" aria-pressed={preview !== null} onClick={() => showMarkdown("preview")}>{t("Preview")}</button>
        <button type="button" aria-pressed={preview === null} onClick={() => showMarkdown("diff")}>{t("Diff")}</button>
      </div>
    </div>}
    <div className="changes-layout">
      <aside className="changes-navigation"><WorkspaceFileTree root={root} paneId={paneId} files={inventory?.files ?? []} refreshToken={refreshToken} selected={preview ?? (path ? absolutePath(root, path) : null)} onSelect={select} /></aside>
      <div className="changes-detail" ref={documentRef} aria-label={t("File diff")} onScroll={() => {
        if (preview || documentClosed) return;
        const container = documentRef.current;
        // When every section fits, layout/scrollIntoView events are not navigation:
        // keep the explicitly selected document for Preview instead of picking the first diff.
        if (!container || container.scrollHeight <= container.clientHeight) return;
        const top = container.getBoundingClientRect().top;
        const nodes = [...container.querySelectorAll<HTMLElement>("[data-diff-path]")];
        const active = nodes.find((node) => node.getBoundingClientRect().bottom > top + 60);
        // Loading placeholders can briefly overflow and then collapse, producing a
        // programmatic scroll. They must not change which document Preview will open.
        if (active?.dataset.diffPath && !active.querySelector(".changes-diff-placeholder")) setPath(active.dataset.diffPath);
      }}>
        {documentClosed ? <p className="changes-note" role="status">{t("Select a file to view.")}</p> : preview ? <FileViewer key={`${preview}:${refreshToken}`} keyboardActive={keyboardActive} path={preview} paneId={paneId} machineId={machineId} paneFolder={start} connected={connected}
          commentId={initialComment?.diff ? null : initialComment?.id ?? initialCommentId} onOpen={select} onClose={closeDocument} /> : <>
          {loading && !inventory && <p className="changes-note" role="status">{t("Loading…")}</p>}
          {error !== null && <p className="changes-note" role="alert">{error}</p>}
          {inventory?.files.length === 0 && <p className="changes-note" role="status">{t("No changes in this comparison.")}</p>}
          <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
            {paneId !== null && owner !== null && inventory?.files.map((file) => <DiffSection key={`${owner}:${inventory.root}:${inventory.revision}:${file.path}`} paneId={paneId} inventory={inventory} path={file.path} owner={owner} connected={connected} split={settings.splitDiff && !narrow} scrollRoot={documentRef} queue={queue} selected={path === file.path} onActive={(next) => { if (!narrow) setPath(next); }} />)}
          </WorkerPoolContextProvider>
        </>}
      </div>
    </div>
    {owner !== null && (inventory !== null || initialComment?.diff !== undefined) && <DiffOrphanComments owner={owner} connected={connected}
      root={inventory?.root ?? initialComment!.diff!.repository} mode="all" initialId={initialComment?.id}
      paths={inventory?.files.flatMap((file) => file.old_path === undefined ? [file.path] : [file.path, file.old_path]) ?? []} />}
  </div>;
}
