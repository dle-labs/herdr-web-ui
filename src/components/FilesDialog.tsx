import { FileToolbarContext, MobileFilesToolbar, MOBILE_FILES_QUERY } from "./MobileFilesToolbar.tsx";
import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, Columns2, FolderOpen, RefreshCw, Rows2, WrapText, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { focusInOtherModal, nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { onSettingsHistory, settingsEntry } from "../lib/settingsHistory.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import type { WorkspaceFileIntent } from "../lib/workspaceBrowser.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import "./FilesDialog.css";
import { MarkdownDocuments } from "./MarkdownDocuments.tsx";
import { PullRequestPanel } from "./PullRequestPanel.tsx";

const ChangesView = lazy(() => import("./ChangesView.tsx"));
const subscribeSettingsHistory = (notify: () => void) => onSettingsHistory(() => notify());
const settingsInHistory = () => settingsEntry(window.history.state) !== null;

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  paneId: string | null;
  connected: boolean;
  /** this browser drives the PC: with Settings → Edit text files on, a text file can be edited */
  editable?: boolean;
  /** Changed Markdown opens as a document when browsing, as a diff when reviewing changes. */
  initialIntent?: WorkspaceFileIntent;
  initialComment?: FileComment | null;
  initialPath?: string | null;
  initialCommentId?: string | null;
  /** Settings or the command palette above the browser owns Escape and focus. */
  keyboardActive?: boolean;
  onBrowseFolders?: (path: string) => void;
  onClose: () => void;
  /** beside the pane on a wide window (Settings → Files beside the pane, or a file that opens there), not a dialog over it */
  docked?: boolean;
  /** drawn first in the docked column (its resize edge) */
  panelStart?: ReactNode;
  /** docked, with a web page in its place: kept, with its tree and reader, for when that closes */
  covered?: boolean;
}

/** What the browser shows: the files and their changes, the branch's pull request, or the folder's Markdown documents. */
type FilesView = "files" | "pr" | "docs";

/** One workspace surface for its file tree, current diffs and embedded file previews. */
export function FilesDialog({ start, paneId, connected, editable = false, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, keyboardActive = true, onBrowseFolders, onClose, docked = false, panelStart, covered = false }: FilesDialogProps) {
  const t = useT();
  // Opening Files focuses a document control, never the nested finder.
  const initialFocus = useRef<HTMLButtonElement>(null);
  // docked beside the pane, the rest of the page stays reachable: no trap, swipe or Back entry
  const surface = useFocusTrap<HTMLElement>(!docked, { initialFocus });
  const narrow = useMediaQuery(MOBILE_FILES_QUERY);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileTitle, setMobileTitle] = useState<HTMLDivElement | null>(null);
  const [mobileMode, setMobileMode] = useState<HTMLDivElement | null>(null);
  const [mobileActions, setMobileActions] = useState<HTMLDivElement | null>(null);
  const [mobileOverlay, setMobileOverlay] = useState<HTMLDivElement | null>(null);
  const [showFile, setShowFile] = useState(initialPath !== null || initialComment !== null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [hasDiffs, setHasDiffs] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Pull request and Documents are read with their first visit and kept, as the files keep their tree
  const [view, setView] = useState<FilesView>("files");
  const [prVisited, setPrVisited] = useState(false);
  const [docsVisited, setDocsVisited] = useState(false);
  // a document picked in Documents opens in the files view's reader
  const [openRequest, setOpenRequest] = useState<{ path: string; token: number } | null>(null);
  // Closing Settings traverses asynchronously. Reclaiming a sheet before that lands would
  // copy its Settings entry, so the first Back would reopen Settings instead of returning here.
  const settingsHistoryActive = useSyncExternalStore(subscribeSettingsHistory, settingsInHistory);
  const browserActive = keyboardActive && !searchOpen && !moreOpen && !covered;
  const filesActive = browserActive && view === "files";
  const mobileToolbar = useMemo(() => narrow ? { title: mobileTitle, mode: mobileMode, actions: mobileActions, overlay: mobileOverlay, document: showFile } : null, [narrow, mobileTitle, mobileMode, mobileActions, mobileOverlay, showFile]);
  useEffect(() => { if (!narrow || !keyboardActive || searchOpen) setMoreOpen(false); }, [narrow, keyboardActive, searchOpen]);
  // A global palette or Settings replaces the local finder, rather than being hidden under it.
  useEffect(() => { if (!keyboardActive) setSearchOpen(false); }, [keyboardActive]);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const [gitToolsHost, setGitToolsHost] = useState<HTMLDivElement | null>(null);
  const { settings, update } = useSettings();
  const machineId = useMachineId();
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  const leave = (): boolean => {
    const field = changedField(surface.current);
    if (field === null) return true;
    revealField(field);
    return false;
  };
  const close = (): boolean => {
    if (!leave()) return false;
    onClose();
    return true;
  };
  const openSearch = (): void => { if (leave()) setSearchOpen(true); };
  const show = (next: FilesView): void => {
    if (next === view || !leave()) return;
    setView(next);
    if (next === "pr") setPrVisited(true);
    if (next === "docs") setDocsVisited(true);
  };
  const openDocument = (path: string): void => {
    setView("files");
    setOpenRequest((last) => ({ path, token: (last?.token ?? 0) + 1 }));
  };
  // Files, Pull request and Documents: one choice of three for the pane's folder; none without a pane
  const views = paneId !== null && <div className="segmented files-dialog-views" role="group" aria-label={t("Show")}>
    <button type="button" aria-pressed={view === "files"} onClick={() => show("files")}>{t("Files")}</button>
    <button type="button" aria-pressed={view === "pr"} onClick={() => show("pr")}>{t("Pull request")}</button>
    <button type="button" aria-pressed={view === "docs"} onClick={() => show("docs")}>{t("Documents")}</button>
  </div>;
  // Content gestures belong to native scrollers, even when a list is at its top.
  useSheetSwipe(surface, browserActive && !docked ? close : null, ".files-dialog-header");
  // A nested palette owns Back meanwhile; a file link already owns useFileViewer's entry.
  usePhoneSheetBack(close, !docked && keyboardActive && !searchOpen && !settingsHistoryActive && initialPath === null, true);
  useEffect(() => {
    const dialog = surface.current;
    if (!dialog || paneId === null || !filesActive) return;
    // Mod+P belongs only to Files, never to a terminal elsewhere on the page.
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [paneId, filesActive]);
  // the listener stays put across renders: an earlier listener of the same key that re-renders the app (the split
  // guide Escape puts away) would otherwise swap it out mid-dispatch, and a listener removed then never runs (#2631)
  const onEscape = useEffectEvent((event: KeyboardEvent): void => {
    if (!browserActive || event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    // one Escape closes one dialog, the one with the keyboard: Settings opened with Files open holds the focus
    // (it closes first), and Settings under Files may have taken this Escape already (#3037)
    if (focusInOtherModal(surface.current)) return;
    // docked, the pane beside it is live: Escape there is the terminal's, so only one inside the panel closes it
    if (docked && !surface.current?.contains(document.activeElement)) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    if (nativeModalOver(surface.current)) return;
    const field = changedField(surface.current);
    if (field !== null) { event.preventDefault(); revealField(field); } else onClose();
  });
  useEffect(() => {
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);
  const content = <>
        {narrow ? <MobileFilesToolbar showFile={showFile} onBack={() => { if (leave()) setShowFile(false); }} onClose={close}
          open={moreOpen} onOpenChange={setMoreOpen} titleHost={setMobileTitle} modeHost={setMobileMode} actionsHost={setMobileActions} overlayHost={setMobileOverlay}>
          {paneId !== null && <><div ref={setToolsHost} className="files-dialog-tools" /><div ref={setGitToolsHost} className="files-dialog-tools" />
            <button type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button></>}
          {onBrowseFolders && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={() => { if (leave()) onBrowseFolders(start || "~"); }}><FolderOpen aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Wrap long lines")} title={t("Wrap long lines")} aria-pressed={settings.wrapCode} onClick={() => { if (leave()) update({ wrapCode: !settings.wrapCode }); }}><WrapText aria-hidden="true" /></button>
        </MobileFilesToolbar> : (
        <header className="modal-header files-dialog-header">
          <h2 className="modal-title">{t("Files")}</h2>
          {views}
          <div className="files-dialog-actions">
            {paneId !== null && <div className="files-dialog-action-group files-dialog-git-actions" hidden={view !== "files"}>
              <div ref={setGitToolsHost} className="files-dialog-tools" />
              <button ref={initialFocus} type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button>
              {hasDiffs && <div className="segmented" role="group" aria-label={t("Diff layout")}>
                <button type="button" aria-label={t("Unified")} title={t("Unified")} aria-pressed={narrow || settings.diffStyle === "unified"} onClick={() => { if (leave()) update({ diffStyle: "unified" }); }}><Rows2 aria-hidden="true" /></button>
                <button type="button" aria-label={t("Split")} title={t("Split")} aria-pressed={!narrow && settings.diffStyle === "split"} disabled={narrow} onClick={() => { if (leave()) update({ diffStyle: "split" }); }}><Columns2 aria-hidden="true" /></button>
              </div>}
            </div>}
            {(paneId !== null || onBrowseFolders || (narrow && showFile)) && <div className="files-dialog-action-group files-dialog-folder-actions" hidden={view !== "files"}>
              {narrow && showFile && <button type="button" className="icon-button" aria-label={t("Back to files")} title={t("Back to files")} onClick={() => { if (leave()) setShowFile(false); }}><ArrowLeft aria-hidden="true" /></button>}
              {paneId !== null && <div ref={setToolsHost} className="files-dialog-tools" />}
              {onBrowseFolders && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={() => { if (leave()) onBrowseFolders(start || "~"); }}><FolderOpen aria-hidden="true" /></button>}
            </div>}
            <button type="button" className="icon-button" aria-label={t("Wrap long lines")} title={t("Wrap long lines")} aria-pressed={settings.wrapCode} hidden={view !== "files"}
              onClick={() => { if (leave()) update({ wrapCode: !settings.wrapCode }); }}><WrapText aria-hidden="true" /></button>
            <button ref={paneId === null ? initialFocus : undefined} type="button" className="icon-button" aria-label={t("Close files")} title={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
          </div>
        </header>
        )}
        {narrow && !showFile && views && <div className="files-dialog-views-row">{views}</div>}
        <div className="modal-body">
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <ChangesView hidden={view !== "files"} openRequest={openRequest} start={start} paneId={paneId} connected={connected} editable={editable} initialIntent={initialIntent} initialComment={initialComment} initialPath={initialPath} initialCommentId={initialCommentId}
              showFile={showFile} onShowFile={() => setShowFile(true)} refreshToken={refreshToken} keyboardActive={filesActive} onHideFile={() => setShowFile(false)} onDiffsChange={setHasDiffs} toolsHost={toolsHost} gitToolsHost={gitToolsHost}
              searchOpen={searchOpen} searchActive={keyboardActive} onSearchOpen={openSearch} onSearchClose={() => setSearchOpen(false)} />
          </Suspense>
          {/* one panel per PC and pane: an answer or a merge still on its way for the last pane never lands in this one */}
          {paneId !== null && prVisited && <div className="files-dialog-view-panel" hidden={view !== "pr"}><PullRequestPanel key={`${machineId}:${paneId}`} paneId={paneId} directory={start} /></div>}
          {/* one list per PC and pane: a pane switch reads the new pane's folder */}
          {paneId !== null && docsVisited && <div className="files-dialog-view-panel" hidden={view !== "docs"}><MarkdownDocuments key={`${machineId}:${paneId}`} paneId={paneId} onOpenFile={openDocument} /></div>}
        </div>
  </>;
  if (docked) return (
    <aside ref={surface} className="file-panel files-panel" aria-label={t("Files")} tabIndex={-1} hidden={covered}>
      {panelStart}
      <FileToolbarContext.Provider value={mobileToolbar}><section className="files-dialog files-dialog-changes files-dialog-docked" data-show-file={showFile || undefined}>
        {content}
      </section></FileToolbarContext.Provider>
    </aside>
  );
  return (
    <div className="modal-scrim workspace-files-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <FileToolbarContext.Provider value={mobileToolbar}><section ref={surface} className={`modal files-dialog files-dialog-changes${narrow ? " files-dialog-mobile" : ""}`} data-show-file={showFile || undefined} role="dialog" aria-modal="true" aria-label={t("Files")} tabIndex={-1}>
        {content}
      </section></FileToolbarContext.Provider>
    </div>
  );
}
