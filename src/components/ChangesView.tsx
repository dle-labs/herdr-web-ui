import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, FolderOpen, RefreshCw } from "lucide-react";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { GitChangesResponse, GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useT } from "../lib/i18n.ts";
import { ChangesTree } from "./ChangesTree.tsx";
import { DiffOrphanComments, DiffViewer } from "./DiffViewer.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import "./ChangesView.css";

const poolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = { theme: { dark: "pierre-dark" as const, light: "pierre-light" as const }, tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000 };

export default function ChangesView({ paneId, connected, initialComment = null, onOpenFile }: {
  paneId: string; connected: boolean; initialComment?: FileComment | null; onOpenFile: (path: string) => void;
}) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchGitChanges, fetchGitDiff } = useMachineApi();
  const [mode, setMode] = useState<GitDiffMode>(initialComment?.diff?.mode ?? "all");
  const [inventory, setInventory] = useState<GitChangesResponse | null>(null);
  const [path, setPath] = useState<string | null>(initialComment?.diff?.path ?? null);
  const [file, setFile] = useState<GitFileDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [split, setSplit] = useState(true);
  const [showFile, setShowFile] = useState(initialComment !== null);
  const narrow = useMediaQuery("(max-width: 768px)");
  const surface = useRef<HTMLDivElement>(null);
  const inventoryRequest = useRef(0);
  const fileRequest = useRef(0);
  const selected = useRef(path);
  selected.current = path;
  const canLeave = useCallback(() => {
    const field = changedField(surface.current);
    if (field !== null) { revealField(field); return false; }
    return true;
  }, []);
  const refresh = useCallback(async () => {
    if (!canLeave()) return;
    const id = ++inventoryRequest.current;
    ++fileRequest.current;
    setLoading(true); setFile(null); setFileError(null);
    try {
      const next = await fetchGitChanges(paneId, mode);
      if (id !== inventoryRequest.current) return;
      setInventory(next); setError(null);
      const chosen = next.files.find((file) => file.path === selected.current || file.old_path === selected.current)?.path ?? next.files[0]?.path ?? null;
      setPath(chosen);
    } catch {
      if (id === inventoryRequest.current) { setInventory(null); setError(t("Git changes could not be loaded. Check that this pane is in a Git repository and its bridge supports diffs.")); }
    } finally { if (id === inventoryRequest.current) setLoading(false); }
  }, [fetchGitChanges, paneId, mode, t, canLeave]);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { ++inventoryRequest.current; ++fileRequest.current; document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useEffect(() => {
    if (inventory === null || path === null || loading) return;
    const id = ++fileRequest.current;
    setFile(null); setFileLoading(true); setFileError(null);
    fetchGitDiff(paneId, mode, path).then((next) => {
      if (id !== fileRequest.current) return;
      if (next.revision !== inventory.revision) {
        setFileError(t("Files changed while this diff was loading. Refresh to review the latest changes.")); return;
      }
      setFile(next);
    }).catch(() => {
      if (id === fileRequest.current) setFileError(t("This diff could not be loaded. The file may have changed, be too large, or have unresolved conflicts."));
    }).finally(() => { if (id === fileRequest.current) setFileLoading(false); });
    return () => { ++fileRequest.current; };
  }, [inventory, path, paneId, mode, loading, fetchGitDiff, t]);
  function select(next: string): void {
    if (!canLeave()) return;
    setPath(next); setShowFile(true);
  }
  return <div ref={surface} className={`changes-view${narrow && showFile ? " is-showing-file" : ""}`}>
    <div className="changes-toolbar">
      <label className="changes-mode">{t("Compare")}
        <select className="select" value={mode} disabled={loading} onChange={(event) => {
          if (!canLeave()) return;
          ++inventoryRequest.current; ++fileRequest.current; setInventory(null); setFile(null); setMode(event.target.value as GitDiffMode);
        }}>
          <option value="all">{t("All changes")}</option><option value="unstaged">{t("Unstaged")}</option><option value="staged">{t("Staged")}</option>
        </select>
      </label>
      <button type="button" className="icon-button" aria-label={t("Refresh changes")} disabled={loading} onClick={() => void refresh()}><RefreshCw aria-hidden="true" /></button>
      <span className="changes-root" title={inventory?.root}>{inventory?.root}</span>
      {!narrow && <button type="button" className="btn" aria-pressed={split} onClick={() => setSplit((value) => !value)}>{split ? t("Unified") : t("Split")}</button>}
    </div>
    {loading && <p className="changes-note" role="status">{t("Loading…")}</p>}
    {error !== null && <p className="changes-note" role="alert">{error}</p>}
    {!loading && inventory !== null && inventory.files.length === 0 && <p className="changes-note" role="status">{t("No changes in this comparison.")}</p>}
    {!loading && inventory !== null && inventory.files.length > 0 && <div className="changes-layout">
      <aside className="changes-navigation"><ChangesTree files={inventory.files} selected={path} onSelect={select} /></aside>
      <section className="changes-detail" aria-label={t("File diff")}>
        <header className="changes-filebar">
          {narrow && <button type="button" className="icon-button" aria-label={t("Changed files")} onClick={() => { if (canLeave()) setShowFile(false); }}><ArrowLeft aria-hidden="true" /></button>}
          <span className="changes-path" title={path ?? undefined}>{path}</span>
          <button type="button" className="btn" disabled={file === null || file.new_file === null} onClick={() => {
            if (file && canLeave()) onOpenFile(`${file.root.replace(/[\\/]$/, "")}/${file.path}`);
          }}><FolderOpen aria-hidden="true" />{t("Open file")}</button>
        </header>
        {fileLoading && <p className="changes-note" role="status">{t("Loading…")}</p>}
        {fileError !== null && <p className="changes-note" role="alert">{fileError}</p>}
        {file !== null && <RenderBoundary resetKey={`${file.root}:${mode}:${file.revision}:${file.path}`} fallback={(retry) => <p role="alert">{t("This diff could not be displayed.")} <button type="button" className="btn" onClick={retry}>{t("Retry")}</button></p>}>
          <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
            <DiffViewer key={`${machineId}:${paneId}:${mode}:${file.revision}:${file.path}`} file={file} mode={mode} owner={paneStorageId(machineId, paneId)} connected={connected} split={split && !narrow} />
          </WorkerPoolContextProvider>
        </RenderBoundary>}
      </section>
    </div>}
    {(inventory !== null || initialComment?.diff !== undefined) && <DiffOrphanComments owner={paneStorageId(machineId, paneId)} connected={connected}
      root={inventory?.root ?? initialComment!.diff!.repository} mode={mode} initialId={initialComment?.id}
      paths={inventory?.files.flatMap((file) => file.old_path === undefined ? [file.path] : [file.path, file.old_path]) ?? []} />}
  </div>;
}
