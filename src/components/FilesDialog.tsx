import { FileToolbarContext, MobileFilesToolbar, MOBILE_FILES_QUERY } from "./MobileFilesToolbar.tsx";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Columns2, FolderOpen, RefreshCw, Rows2, WrapText, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
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

const ChangesView = lazy(() => import("./ChangesView.tsx"));
const subscribeSettingsHistory = (notify: () => void) => onSettingsHistory(() => notify());
const settingsInHistory = () => settingsEntry(window.history.state) !== null;

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  paneId: string | null;
  connected: boolean;
  /** Changed Markdown opens as a document when browsing, as a diff when reviewing changes. */
  initialIntent?: WorkspaceFileIntent;
  initialComment?: FileComment | null;
  initialPath?: string | null;
  initialCommentId?: string | null;
  /** Settings or the command palette above the browser owns Escape and focus. */
  keyboardActive?: boolean;
  onBrowseFolders?: (path: string) => void;
  onClose: () => void;
}

/** One workspace surface for its file tree, current diffs and embedded file previews. */
export function FilesDialog({ start, paneId, connected, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, keyboardActive = true, onBrowseFolders, onClose }: FilesDialogProps) {
  const t = useT();
  // Opening Files focuses a document control, never the nested finder.
  const initialFocus = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus });
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
  // Closing Settings traverses asynchronously. Reclaiming a sheet before that lands would
  // copy its Settings entry, so the first Back would reopen Settings instead of returning here.
  const settingsHistoryActive = useSyncExternalStore(subscribeSettingsHistory, settingsInHistory);
  const browserActive = keyboardActive && !searchOpen && !moreOpen;
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
  // Content gestures belong to native scrollers, even when a list is at its top.
  useSheetSwipe(surface, browserActive ? close : null, ".files-dialog-header");
  // A nested palette owns Back meanwhile; a file link already owns useFileViewer's entry.
  usePhoneSheetBack(close, keyboardActive && !searchOpen && !settingsHistoryActive && initialPath === null, true);
  useEffect(() => {
    const dialog = surface.current;
    if (!dialog || paneId === null || !browserActive) return;
    // Mod+P belongs only to Files, never to a terminal elsewhere on the page.
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [paneId, browserActive]);
  useEffect(() => {
    if (!browserActive) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !nativeModalOver(surface.current)) {
        const field = changedField(surface.current);
        if (field !== null) { event.preventDefault(); revealField(field); } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, browserActive]);
  return (
    <div className="modal-scrim workspace-files-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <FileToolbarContext.Provider value={mobileToolbar}><section ref={surface} className={`modal files-dialog files-dialog-changes${narrow ? " files-dialog-mobile" : ""}`} data-show-file={showFile || undefined} role="dialog" aria-modal="true" aria-label={t("Files")} tabIndex={-1}>
        {narrow ? <MobileFilesToolbar showFile={showFile} onBack={() => { if (leave()) setShowFile(false); }} onClose={close}
          open={moreOpen} onOpenChange={setMoreOpen} titleHost={setMobileTitle} modeHost={setMobileMode} actionsHost={setMobileActions} overlayHost={setMobileOverlay}>
          {paneId !== null && <><div ref={setToolsHost} className="files-dialog-tools" /><div ref={setGitToolsHost} className="files-dialog-tools" />
            <button type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button></>}
          {onBrowseFolders && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={() => { if (leave()) onBrowseFolders(start || "~"); }}><FolderOpen aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Wrap long lines")} title={t("Wrap long lines")} aria-pressed={settings.wrapCode} onClick={() => { if (leave()) update({ wrapCode: !settings.wrapCode }); }}><WrapText aria-hidden="true" /></button>
        </MobileFilesToolbar> : (
        <header className="modal-header files-dialog-header">
          <h2 className="modal-title">{t("Files")}</h2>
          <div className="files-dialog-actions">
            {paneId !== null && <div className="files-dialog-action-group files-dialog-git-actions">
              <div ref={setGitToolsHost} className="files-dialog-tools" />
              <button ref={initialFocus} type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button>
              {hasDiffs && <div className="segmented" role="group" aria-label={t("Diff layout")}>
                <button type="button" aria-label={t("Unified")} title={t("Unified")} aria-pressed={narrow || settings.diffStyle === "unified"} onClick={() => { if (leave()) update({ diffStyle: "unified" }); }}><Rows2 aria-hidden="true" /></button>
                <button type="button" aria-label={t("Split")} title={t("Split")} aria-pressed={!narrow && settings.diffStyle === "split"} disabled={narrow} onClick={() => { if (leave()) update({ diffStyle: "split" }); }}><Columns2 aria-hidden="true" /></button>
              </div>}
            </div>}
            {(paneId !== null || onBrowseFolders || (narrow && showFile)) && <div className="files-dialog-action-group files-dialog-folder-actions">
              {narrow && showFile && <button type="button" className="icon-button" aria-label={t("Back to files")} title={t("Back to files")} onClick={() => { if (leave()) setShowFile(false); }}><ArrowLeft aria-hidden="true" /></button>}
              {paneId !== null && <div ref={setToolsHost} className="files-dialog-tools" />}
              {onBrowseFolders && <button type="button" className="icon-button" aria-label={t("Browse folders in the palette")} title={t("Browse folders in the palette")} onClick={() => { if (leave()) onBrowseFolders(start || "~"); }}><FolderOpen aria-hidden="true" /></button>}
            </div>}
            <button type="button" className="icon-button" aria-label={t("Wrap long lines")} title={t("Wrap long lines")} aria-pressed={settings.wrapCode}
              onClick={() => { if (leave()) update({ wrapCode: !settings.wrapCode }); }}><WrapText aria-hidden="true" /></button>
            <button ref={paneId === null ? initialFocus : undefined} type="button" className="icon-button" aria-label={t("Close files")} title={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
          </div>
        </header>
        )}
        <div className="modal-body">
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <ChangesView start={start} paneId={paneId} connected={connected} initialIntent={initialIntent} initialComment={initialComment} initialPath={initialPath} initialCommentId={initialCommentId}
              showFile={showFile} onShowFile={() => setShowFile(true)} refreshToken={refreshToken} keyboardActive={browserActive} onHideFile={() => setShowFile(false)} onDiffsChange={setHasDiffs} toolsHost={toolsHost} gitToolsHost={gitToolsHost}
              searchOpen={searchOpen} searchActive={keyboardActive} onSearchOpen={openSearch} onSearchClose={() => setSearchOpen(false)} />
          </Suspense>
        </div>
      </section></FileToolbarContext.Provider>
    </div>
  );
}
