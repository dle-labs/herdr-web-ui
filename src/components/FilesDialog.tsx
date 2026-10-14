import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Columns2, FolderSearch, GitCompare, RefreshCw, Rows3, Search, X } from "lucide-react";
import type { FileSearchResult, RepoCommitSearch, RepoDiffFile, RepoDiffFileList } from "../../shared/protocol.ts";
import { FileViewer } from "./FileViewer.tsx";
import { RepoDiffViewer } from "./RepoDiffViewer.tsx";
import { FilesTree } from "./FilesTree.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import { ReviewNotesButton, useReviewNotes } from "./ReviewNotes.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { ApiError } from "../lib/api.ts";
import { fileLineTarget } from "../lib/filePaths.ts";
import { comparisonWord, diffErrorMessage, repoDiffIdentity, repositoryFilePath, type RepoComparison, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { reviewNotes } from "../lib/reviewNotes.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useSettings } from "../lib/settings.ts";
import { subscribeFilesFolder, takeFilesFolder } from "../lib/paletteFolders.ts";
import "./FilesDialog.css";

export interface FilesDialogProps {
  start: string;
  paneId: string;
  viewing: boolean;
  onBrowseFolders: (path: string) => void;
  onClose: () => void;
}
type Detail = { kind: "file"; path: string; relative: string | null } | { kind: "diff"; target: RepoDiffTarget };
type PickerKind = "files" | "commits";

/** Nested picker: owns focus, Escape and mobile Back without taking Files' document away. */
function FilesPicker({ kind, paneId, directory, onFile, onCommit, onClose }: {
  kind: PickerKind; paneId: string; directory: string; onFile: (root: string, path: string) => void; onCommit: (id: string) => void; onClose: () => void;
}) {
  const t = useT();
  const { searchPaneFiles, fetchRepoCommits } = useMachineApi();
  const surface = useFocusTrap<HTMLElement>(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [load, setLoad] = useState<FileSearchResult | RepoCommitSearch | null>(null);
  const [error, setError] = useState<unknown>(null);
  const request = useRef(0);
  const composing = useRef(false);
  usePhoneSheetBack(onClose);
  useEffect(() => {
    const id = ++request.current, abort = new AbortController();
    setLoad(null); setError(null); setSelected(0);
    const timer = window.setTimeout(() => {
      const result = kind === "files" ? searchPaneFiles(paneId, query, abort.signal) : fetchRepoCommits(paneId, directory, query, abort.signal);
      void result.then((answer) => { if (id === request.current) setLoad(answer); }, (reason: unknown) => { if (id === request.current && !abort.signal.aborted) setError(reason); });
    }, 120);
    return () => { request.current++; clearTimeout(timer); abort.abort(); };
  }, [query, paneId, directory, kind, searchPaneFiles, fetchRepoCommits]);
  const files = load && "files" in load ? load : null;
  const history = load && "commits" in load ? load : null;
  const count = files?.files.length ?? history?.commits.length ?? 0;
  const choose = (index: number): void => {
    if (!reviewNotes.guard()) return;
    if (files?.files[index]) onFile(files.root, files.files[index]!);
    else if (history?.commits[index]) onCommit(history.commits[index]!.id);
  };
  useEffect(() => { surface.current?.querySelector<HTMLElement>(`[data-choice="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return <div className="files-picker-scrim" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section ref={surface} className="files-find modal" role="dialog" aria-modal="true" aria-label={t(kind === "files" ? "Find files…" : "Choose a historical base")} tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (count) setSelected((current) => (current + (event.key === "ArrowDown" ? 1 : count - 1)) % count); }
      else if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); choose(selected); }
    }}>
      <header className="modal-header"><h2 className="modal-title">{t(kind === "files" ? "Find files…" : "Choose a historical base")}</h2><button type="button" className="icon-button" aria-label={t("Close picker")} onClick={onClose}><X aria-hidden="true" /></button></header>
      <input className="input" type="search" aria-label={t(kind === "files" ? "Filename or path" : "Commit message or hexadecimal ID")} value={query} autoFocus autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      {error !== null ? <p role="alert">{kind === "commits" ? diffErrorMessage(t, error) : t("Files could not be searched.")}</p> : load === null ? <p role="status">{t("Loading…")}</p> : <ul className="files-picker-results" role="listbox">
        {files?.files.map((path, index) => <li key={path}><button type="button" role="option" aria-selected={index === selected} data-choice={index} onClick={() => choose(index)}>{path}</button></li>)}
        {history?.commits.map((commit, index) => <li key={commit.id}><button type="button" role="option" aria-selected={index === selected} data-choice={index} onClick={() => choose(index)}><strong>{commit.subject}</strong><small>{commit.id.slice(0, 8)} · {commit.author} · {commit.date}</small></button></li>)}
        {count === 0 && <li>{t("No matches")}</li>}
      </ul>}
      {load?.truncated && <p className="files-incomplete" role="status">{t("Results are incomplete. Narrow the search or refresh.")}{files?.incomplete.length ? ` (${files.incomplete.join(", ")})` : ""}</p>}
      {kind === "commits" && <p className="files-picker-hint">{t("Searches messages and reachable commit IDs, not author or date.")}</p>}
    </section>
  </div>;
}

/** One bounded Files surface, one selected virtualized diff, and the existing preview readers. */
export function FilesDialog({ start, paneId, viewing, onBrowseFolders, onClose }: FilesDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const { searchPaneFiles, fetchDirectories } = useMachineApi();
  const { settings, update } = useSettings();
  useReviewNotes();
  const reviewOpen = reviewNotes.draft !== null || reviewNotes.listOwner !== null;
  const phone = useMediaQuery("(max-width: 768px)");
  const surface = useFocusTrap<HTMLElement>(true);
  const [root, setRoot] = useState<string | null>(null);
  const [rootError, setRootError] = useState(false);
  const [changes, setChanges] = useState<RepoDiffFileList | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<RepoComparison>({ scope: "all", base: null, head: null });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailShown, setDetailShown] = useState(false);
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [reveal, setReveal] = useState<string | null>(null);
  const [fileScoped, setFileScoped] = useState(false);
  const guarded = (action: () => void): void => { if (reviewNotes.close()) action(); };
  const close = useCallback((): boolean => { if (!reviewNotes.close()) return false; onClose(); return true; }, [onClose]);
  const back = useCallback((): boolean => {
    if (!reviewNotes.close()) return false;
    if (picker !== null) { setPicker(null); return true; }
    if (detailShown) { setDetailShown(false); return false; }
    onClose(); return true;
  }, [picker, detailShown, onClose]);
  useSheetSwipe(surface, reviewOpen || picker !== null ? null : close);
  usePhoneSheetBack(back, !viewing && picker === null && !reviewOpen);
  useEffect(() => {
    const abort = new AbortController(); let live = true;
    setRoot(null); setRootError(false);
    void searchPaneFiles(paneId, "", abort.signal).then((inventory) => { if (live) setRoot(inventory.root); }, async (reason: unknown) => {
      // An older bridge can still browse its general reader's known absolute pane folder.
      // Never fall back to an empty path or the server process's working directory.
      if (reason instanceof ApiError && reason.code === "inventory_unsupported" && /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(start)) {
        try { const listing = await fetchDirectories(start, true, true, paneId); if (live) setRoot(listing.path); return; } catch { /* show the failed owner-bound root */ }
      }
      if (live) setRootError(true);
    });
    return () => { live = false; abort.abort(); };
  }, [paneId, start, searchPaneFiles, fetchDirectories]);
  useEffect(() => {
    const nextFolder = (): void => { const path = takeFilesFolder(); if (path !== null) guarded(() => { setRoot(path); setDetail(null); setDetailShown(false); }); };
    nextFolder(); return subscribeFilesFolder(nextFolder);
  }, []);
  useEffect(() => {
    if (viewing || picker !== null) return;
    const key = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || reviewNotes.composing || nativeModalOver(surface.current)) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p" && surface.current?.contains(event.target as Node)) { event.preventDefault(); guarded(() => setPicker("files")); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [viewing, picker, close]);
  const relative = detail?.kind === "diff" ? detail.target.path : detail?.relative ?? null;
  const openFile = (path: string, relativePath: string | null = null): void => guarded(() => {
    const plain = fileLineTarget(path).path.replaceAll("\\", "/"), prefix = root === null ? null : `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
    const relative = relativePath ?? (prefix && plain.startsWith(prefix) ? plain.slice(prefix.length) : null);
    setDetail({ kind: "file", path, relative }); setDetailShown(true); if (relative) setReveal(relative);
  });
  const openDiff = (answered: RepoComparison, file: RepoDiffFile): void => guarded(() => {
    setDetail({ kind: "diff", target: { machineId, paneId, directory: start || null, ...answered, path: file.path, oldPath: file.old_path } }); setDetailShown(true);
  });
  const updateListing = useCallback((listing: RepoDiffFileList): void => { setChanges(listing); setRoot(listing.repository.root); }, []);
  const title = detail?.kind === "diff" ? comparisonWord(t, detail.target) : comparisonWord(t, comparison);
  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={surface} className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1} data-detail={detailShown ? "" : undefined}>
      <header className="modal-header files-header">
        <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
        <div className="files-git-actions">
          <button type="button" className="icon-button" aria-pressed={comparing} aria-label={t("Compare")} title={t("Compare")} onClick={() => guarded(() => { setComparing((value) => !value); setDetailShown(false); })}><GitCompare aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Refresh files and changes")} title={t("Refresh files and changes")} onClick={() => guarded(() => { setRefresh((value) => value + 1); setDetail(null); setDetailShown(false); })}><RefreshCw aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Diff layout")} title={phone ? t("Split view needs a wider screen") : t("Diff layout")} disabled={phone} onClick={() => guarded(() => update({ diffStyle: settings.diffStyle === "split" ? "unified" : "split" }))}>{settings.diffStyle === "split" && !phone ? <Columns2 aria-hidden="true" /> : <Rows3 aria-hidden="true" />}</button>
        </div>
        <div className="files-nav-actions">
          <button type="button" className="icon-button" aria-label={t("Find files…")} title={t("Find files…")} onClick={() => guarded(() => setPicker("files"))}><Search aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={() => guarded(() => onBrowseFolders(root ?? start))}><FolderSearch aria-hidden="true" /></button>
        </div>
        <button type="button" className="icon-button files-close" aria-label={t("Close files")} title={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
      </header>
      {comparing && <div className="files-comparison-bar"><span>{title}</span><button className="btn btn-ghost" type="button" onClick={() => guarded(() => setPicker("commits"))}>{t("Choose a historical base")}</button>{comparison.base && <button className="btn btn-ghost" type="button" onClick={() => guarded(() => { setComparison({ scope: "all", base: null, head: null }); setDetail(null); })}>{t("Reset to current changes")}</button>}{relative && <label><input type="checkbox" checked={fileScoped} onChange={(event) => guarded(() => setFileScoped(event.target.checked))} />{t("This file only")}</label>}</div>}
      <div className="files-workspace">
        <div className="files-list" hidden={phone && detailShown}>
          <div hidden={comparing}>{root ? <FilesTree root={root} paneId={paneId} changes={root === changes?.repository.root ? changes.files : []} selected={relative} reveal={reveal} refresh={refresh} onOpen={(path) => {
            const deleted = root === changes?.repository.root ? changes.files.find((file) => file.path === path && file.status === "deleted") : undefined;
            if (deleted && changes) openDiff({ scope: changes.scope, base: changes.base, head: changes.head, fingerprint: changes.fingerprint }, deleted);
            else openFile(repositoryFilePath(root, path), path);
          }} /> : <p role={rootError ? "alert" : "status"}>{t(rootError ? "The pane's folder could not be read." : "Loading…")}</p>}</div>
          <div hidden={!comparing}><RepoChanges paneId={paneId} directory={start} comparison={comparison} onComparisonChange={(next) => { setComparison(next); setDetail(null); setDetailShown(false); }} onListing={updateListing} refresh={refresh} filePath={fileScoped ? relative : null} onOpenDiff={openDiff} /></div>
        </div>
        <div className="files-detail" hidden={phone && !detailShown}>
          {detail !== null && <div className="files-detail-nav">{phone && <button className="btn btn-ghost" type="button" onClick={() => guarded(() => setDetailShown(false))}><ArrowLeft aria-hidden="true" />{t("Back to files")}</button>}{relative && <button className="btn btn-ghost" type="button" onClick={() => guarded(() => { setReveal(relative); setComparing(false); setDetailShown(false); })}>{t("Reveal in file tree")}</button>}<ReviewNotesButton owner={paneStorageId(machineId, paneId)} /></div>}
          {detail?.kind === "file" ? <FileViewer key={detail.path} embedded path={detail.path} paneId={paneId} onClose={() => guarded(() => setDetailShown(false))} onOpen={(path) => openFile(path)} /> : detail?.kind === "diff" ? <RepoDiffViewer key={repoDiffIdentity(detail.target)} embedded target={detail.target} onClose={() => guarded(() => setDetailShown(false))} onOpenFile={(path) => openFile(path, detail.target.path)} /> : <p className="files-empty">{t("Choose a file to preview, or compare repository changes.")}</p>}
        </div>
      </div>
      {picker !== null && <FilesPicker kind={picker} paneId={paneId} directory={start} onClose={() => setPicker(null)} onFile={(inventoryRoot, path) => { setRoot(inventoryRoot); setPicker(null); setComparing(false); openFile(repositoryFilePath(inventoryRoot, path), path); }} onCommit={(id) => { setPicker(null); setComparison({ scope: "all", base: id, head: null }); setComparing(true); setDetail(null); setDetailShown(false); }} />}
    </section>
  </div>;
}
