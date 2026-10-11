import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { GitChangesResponse, GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { PIERRE_THEME } from "../lib/pierreTheme.ts";
import { firstEditedLine } from "../lib/workspaceFollow.ts";
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

function DiffSection({ paneId, inventory, path, mode, owner, connected, split, scrollRoot, queue, selected, onActive, onOpen, follow, refreshToken, canApply, onEdited, introduced }: {
  paneId: string; inventory: GitChangesResponse; path: string; mode: GitDiffMode; owner: string;
  connected: boolean; split: boolean; scrollRoot: RefObject<HTMLDivElement>;
  introduced: boolean; follow: boolean; refreshToken: number; canApply: () => boolean; onEdited: (path: string, line: number) => void;
  queue: ReturnType<typeof createDiffQueue>; selected: boolean; onActive: (path: string) => void; onOpen: (path: string) => void;
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
    if ((!near && !follow) || file?.revision === inventory.revision && attempt === 0) return;
    let live = true;
    setError(null);
    queue(async () => {
      if (!live || follow && document.visibilityState !== "visible") return;
      try {
        const next = await fetchGitDiff(paneId, mode, path);
        if (!live || follow && document.visibilityState !== "visible") return;
        if (next.revision !== inventory.revision || next.root !== inventory.root) {
          setError(t("Files changed while this diff was loading. Refresh to review the latest changes."));
        } else if (file === null || canApply()) {
          // Loading a previously unseen section cannot discard another section's draft.
          const line = file ? firstEditedLine(file, next) : introduced ? 1 : null;
          setFile(next);
          if (line !== null) onEdited(path, line);
        }
      } catch {
        if (live) setError(t("This diff could not be loaded. The file may have changed, be too large, or have unresolved conflicts."));
      }
    });
    return () => { live = false; };
  }, [near, follow, refreshToken, queue, fetchGitDiff, paneId, mode, path, inventory.revision, inventory.root, attempt, t, canApply, onEdited, introduced]);
  return <section ref={surface} className="changes-diff-section" data-diff-path={path} onMouseEnter={() => onActive(path)}>
    <header className="changes-filebar">
      <span className="changes-path" title={path}>{path}</span>
      <button type="button" className="btn" disabled={!file?.new_file} onClick={() => onOpen(absolutePath(inventory.root, path))}><FolderOpen aria-hidden="true" />{t("Open file")}</button>
    </header>
    {error && <p className="changes-note" role="alert">{error} <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>{t("Retry")}</button></p>}
    {!file && !error && <p className="changes-diff-placeholder changes-note" role="status">{t("Loading…")}</p>}
    {file && <RenderBoundary resetKey={`${file.revision}:${file.path}`} fallback={(retry) => <p role="alert">{t("This diff could not be displayed.")} <button type="button" className="btn" onClick={retry}>{t("Retry")}</button></p>}>
      <DiffViewer file={file} mode={mode} owner={owner} connected={connected} split={split} />
    </RenderBoundary>}
  </section>;
}

export default function ChangesView({ paneId, start, connected, initialComment = null }: {
  paneId: string; start: string; connected: boolean; initialComment?: FileComment | null;
}) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchGitChanges } = useMachineApi();
  const [mode, setMode] = useState<GitDiffMode>(initialComment?.diff?.mode ?? "all");
  const [inventory, setInventory] = useState<GitChangesResponse | null>(null);
  const [path, setPath] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(true);
  const [follow, setFollow] = useState(false);
  const [showFile, setShowFile] = useState(true);
  const [jump, setJump] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [queue] = useState(createDiffQueue);
  const [refreshToken, setRefreshToken] = useState(0);
  const [lineJump, setLineJump] = useState<{ path: string; line: number } | null>(null);
  const automatic = useRef(false);
  automatic.current = follow && connected;
  const followedRevision = useRef<string | null>(null);
  const introducedPaths = useRef(new Set<string>());
  const narrow = useMediaQuery("(max-width: 768px)");
  const surface = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const inventoryRequest = useRef(0);
  const requestTail = useRef<Promise<void>>(Promise.resolve());
  const currentInventory = useRef(inventory);
  currentInventory.current = inventory;
  const canLeave = useCallback(() => {
    const field = changedField(surface.current);
    if (field !== null) { revealField(field); return false; }
    return true;
  }, []);
  const refresh = useCallback((auto = false): Promise<void> => {
    const id = inventoryRequest.current;
    const allowed = () => id === inventoryRequest.current && (!auto || automatic.current && document.visibilityState === "visible");
    // Promise chaining serializes old/new comparisons without a busy-wait or overlapping reads.
    const request = requestTail.current.then(async () => {
      if (!allowed() || !canLeave()) return;
      setLoading(true);
      try {
        const next = await fetchGitChanges(paneId, mode);
        if (!allowed() || !canLeave()) return;
        const previous = currentInventory.current;
        if (previous?.revision !== next.revision || previous.root !== next.root) {
          introducedPaths.current = new Set(previous && previous.root === next.root
            ? next.files.filter((file) => !previous.files.some((old) => old.path === file.path)).map((file) => file.path) : []);
          setInventory(next);
        }
        setRefreshToken((value) => value + 1);
        setError(null);
        setPath((selected) => next.files.some((file) => file.path === selected) ? selected : next.files[0]?.path ?? null);
      } catch {
        if (allowed()) setError(t("Git changes could not be loaded. Check that this pane is in a Git repository and its bridge supports diffs."));
      } finally {
        if (id === inventoryRequest.current) setLoading(false);
      }
    });
    requestTail.current = request;
    return request;
  }, [fetchGitChanges, paneId, mode, t, canLeave]);
  useEffect(() => {
    void refresh();
    return () => { ++inventoryRequest.current; };
  }, [refresh]);
  useEffect(() => {
    if (!follow || !connected) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh(true);
      if (live) timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 3000);
    return () => { live = false; clearTimeout(timer); };
  }, [refresh, follow, connected]);
  const onEdited = useCallback((editedPath: string, line: number) => {
    if (!automatic.current || document.visibilityState !== "visible" || !canLeave()) return;
    const revision = currentInventory.current?.revision ?? null;
    // Follow one observed edit per snapshot. Git has no edit timestamps here:
    // request completion order identifies a changed file, not the most recently edited file.
    if (followedRevision.current === revision) return;
    followedRevision.current = revision;
    setPath(editedPath); setShowFile(true); setJump(editedPath); setLineJump({ path: editedPath, line });
  }, [canLeave]);
  useEffect(() => {
    if (!lineJump || !automatic.current) return;
    const section = [...documentRef.current?.querySelectorAll<HTMLElement>("[data-diff-path]") ?? []].find((node) => node.dataset.diffPath === lineJump.path);
    if (!section) return;
    let frame = 0;
    const deadline = performance.now() + 2000;
    const locate = () => {
      if (!automatic.current || !canLeave()) return;
      for (const host of section.querySelectorAll("diffs-container")) {
        const line = host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${lineJump.line}"]:not([data-line-type="change-deletion"])`)
          ?? host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${lineJump.line}"]`);
        // The section was already aligned at its header. Centering an early line
        // can scroll back into the preceding file and undo the active selection.
        if (line) { line.scrollIntoView({ block: "nearest" }); return; }
      }
      if (performance.now() < deadline) frame = requestAnimationFrame(locate);
    };
    frame = requestAnimationFrame(locate);
    return () => cancelAnimationFrame(frame);
  }, [lineJump, canLeave]);
  useEffect(() => {
    if (!jump || preview || !showFile) return;
    const element = [...documentRef.current?.querySelectorAll<HTMLElement>("[data-diff-path]") ?? []].find((node) => node.dataset.diffPath === jump);
    if (element) { element.scrollIntoView({ block: "start" }); setJump(null); }
  }, [jump, inventory, preview, showFile]);
  function select(absolute: string) {
    if (!canLeave()) return;
    setFollow(false);
    setShowFile(true);
    const changed = inventory?.files.find((file) => absolutePath(inventory.root, file.path) === absolute || file.old_path && absolutePath(inventory.root, file.old_path) === absolute);
    if (changed) { setPreview(null); setPath(changed.path); setJump(changed.path); }
    else setPreview(absolute);
  }
  function openPreview(absolute: string) {
    if (!canLeave()) return;
    setFollow(false); setPreview(absolute); setShowFile(true);
  }
  const root = inventory?.root ?? start;
  const owner = paneStorageId(machineId, paneId);
  return <div ref={surface} className={`changes-view${narrow && showFile ? " is-showing-file" : ""}`}>
    <div className="changes-toolbar">
      {narrow && <button type="button" className="icon-button" aria-label={t("Files")} aria-expanded={!showFile} onClick={() => { if (canLeave()) { setFollow(false); setShowFile((value) => !value); } }}><FolderOpen aria-hidden="true" /></button>}
      <label className="changes-mode">{t("Compare")}
        <select className="select" value={mode} disabled={loading} onChange={(event) => {
          if (!canLeave()) return;
          setFollow(false); setInventory(null); setMode(event.target.value as GitDiffMode);
        }}>
          <option value="all">{t("All changes")}</option><option value="unstaged">{t("Unstaged")}</option><option value="staged">{t("Staged")}</option>
        </select>
      </label>
      <button type="button" className="icon-button" aria-label={t("Refresh changes")} disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" /></button>
      <button type="button" className="btn" aria-pressed={follow} disabled={!connected} onClick={() => { if (canLeave()) { setPreview(null); setFollow((value) => !value); } }}>{t("Follow edits")}</button>
      <span className="changes-root" title={root}>{root}</span>
      {!narrow && <button type="button" className="btn" aria-pressed={split} onClick={() => setSplit((value) => !value)}>{split ? t("Unified") : t("Split")}</button>}
    </div>
    <div className="changes-layout">
      <aside className="changes-navigation"><WorkspaceFileTree root={root} paneId={paneId} files={inventory?.files ?? []} selected={preview ?? (path ? absolutePath(root, path) : null)} onSelect={select} /></aside>
      <div className="changes-detail" ref={documentRef} aria-label={t("File diff")} onPointerDownCapture={() => setFollow(false)} onWheel={() => setFollow(false)} onTouchStart={() => setFollow(false)} onKeyDown={(event) => {
        if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) setFollow(false);
      }} onScroll={() => {
        if (preview) return;
        const container = documentRef.current;
        if (!container) return;
        const top = container.getBoundingClientRect().top;
        const nodes = [...container.querySelectorAll<HTMLElement>("[data-diff-path]")];
        const active = nodes.find((node) => node.getBoundingClientRect().bottom > top + 60);
        if (active?.dataset.diffPath) setPath(active.dataset.diffPath);
      }}>
        {preview ? <>
          <button type="button" className="btn changes-back" onClick={() => { if (canLeave()) setPreview(null); }}><ArrowLeft aria-hidden="true" />{t("All changes")}</button>
          <FileViewer embedded path={preview} paneId={paneId} machineId={machineId} paneFolder={start} connected={connected} onOpen={select} onClose={() => { if (canLeave()) setPreview(null); }} />
        </> : <>
          {loading && !inventory && <p className="changes-note" role="status">{t("Loading…")}</p>}
          {error !== null && <p className="changes-note" role="alert">{error}</p>}
          {inventory?.files.length === 0 && <p className="changes-note" role="status">{t("No changes in this comparison.")}</p>}
          <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
            {inventory?.files.map((file) => <DiffSection key={`${owner}:${inventory.root}:${mode}:${file.path}`} paneId={paneId} inventory={inventory} path={file.path} mode={mode} owner={owner} connected={connected} split={split && !narrow} scrollRoot={documentRef} queue={queue} selected={path === file.path} onActive={setPath} onOpen={openPreview} follow={follow && connected} refreshToken={refreshToken} canApply={canLeave} onEdited={onEdited} introduced={introducedPaths.current.has(file.path)} />)}
          </WorkerPoolContextProvider>
        </>}
      </div>
    </div>
    {(inventory !== null || initialComment?.diff !== undefined) && <DiffOrphanComments owner={owner} connected={connected}
      root={inventory?.root ?? initialComment!.diff!.repository} mode={mode} initialId={initialComment?.id}
      paths={inventory?.files.flatMap((file) => file.old_path === undefined ? [file.path] : [file.path, file.old_path]) ?? []} />}
  </div>;
}
