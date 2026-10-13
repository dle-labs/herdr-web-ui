import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, FolderSearch, RefreshCw, X } from "lucide-react";
import { RepoChanges, type RepoChangesProps } from "./RepoChanges.tsx";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import type { WorkspaceFileIntent } from "../lib/workspaceBrowser.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import "./FilesDialog.css";

const ChangesView = lazy(() => import("./ChangesView.tsx"));

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  paneId: string | null;
  connected: boolean;
  /** An external scoped diff or document is above this browser. */
  viewing?: boolean;
  /** Main's workspace/index/two-commit comparisons retain their own diff viewer. */
  onOpenDiff?: RepoChangesProps["onOpenDiff"];
  /** Open the owning PC's folder palette above this browser. */
  onBrowseFolders?: (path: string) => void;
  /** Open file from a scoped diff means its source, not another diff. */
  forcePreview?: boolean;
  /** Changed Markdown opens as a document when browsing, as a diff when reviewing changes. */
  initialIntent?: WorkspaceFileIntent;
  initialComment?: FileComment | null;
  initialPath?: string | null;
  initialCommentId?: string | null;
  /** Settings above the browser owns Escape and focus. */
  keyboardActive?: boolean;
  onClose: () => void;
}

/** One workspace surface for its file tree, current diffs and embedded file previews. */
export function FilesDialog({ start, paneId, connected, viewing = false, onOpenDiff, onBrowseFolders, forcePreview = false, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, keyboardActive = true, onClose }: FilesDialogProps) {
  const t = useT();
  const titleId = useId();
  // Moving the finder before Refresh must not auto-open its dropdown over a
  // document reached by a file link. Mod+P still explicitly focuses the finder.
  const initialFocus = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus });
  const narrow = useMediaQuery("(max-width: 768px)");
  const [tab, setTab] = useState<"browse" | "changes">("browse");
  const [changesVisited, setChangesVisited] = useState(false);
  const active = keyboardActive && !viewing;
  const [showFile, setShowFile] = useState(initialPath !== null || initialComment !== null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [hasDiffs, setHasDiffs] = useState(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
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
  useSheetSwipe(surface, active ? close : null);
  // A file link already owns useFileViewer's history entry; ordinary browsing owns a sheet entry.
  usePhoneSheetBack(close, active && initialPath === null);
  useEffect(() => {
    if (!active) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !nativeModalOver(surface.current)) {
        const field = changedField(surface.current);
        if (field !== null) { event.preventDefault(); revealField(field); } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, active]);
  return (
    <div className="modal-scrim workspace-files-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={surface} className="modal files-dialog files-dialog-changes" data-show-file={showFile || undefined} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header files-dialog-header">
          {tab === "browse" && narrow && showFile && <button type="button" className="icon-button" aria-label={t("Back to files")} onClick={() => { if (leave()) setShowFile(false); }}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title" id={titleId}>{t("Files")}</h2>
          {paneId !== null && onOpenDiff && <div className="segmented files-dialog-tabs" role="group" aria-label={t("Files")}>
            <button type="button" aria-pressed={tab === "browse"} onClick={() => { if (leave()) setTab("browse"); }}>{t("Browse")}</button>
            <button type="button" aria-pressed={tab === "changes"} onClick={() => { if (leave()) { setChangesVisited(true); setTab("changes"); } }}>{t("Changes")}</button>
          </div>}
          {paneId !== null && tab === "browse" && <div ref={setToolsHost} className="files-dialog-tools" />}
          {paneId !== null && tab === "browse" && <button ref={initialFocus} type="button" className="icon-button" aria-label={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button>}
          {tab === "browse" && hasDiffs && <div className="segmented" role="group" aria-label={t("Diff layout")}>
            <button type="button" aria-pressed={narrow || !settings.splitDiff} onClick={() => { if (leave()) update({ splitDiff: false }); }}>{t("Unified")}</button>
            <button type="button" aria-pressed={!narrow && settings.splitDiff} disabled={narrow} onClick={() => { if (leave()) update({ splitDiff: true }); }}>{t("Split")}</button>
          </div>}
          {onBrowseFolders && <button type="button" className="icon-button" aria-label={t("Browse folders")} title={t("Browse folders")} onClick={() => { if (leave()) onBrowseFolders(start || "~"); }}><FolderSearch aria-hidden="true" /></button>}
          <button ref={paneId === null || tab === "changes" ? initialFocus : undefined} type="button" className="icon-button" aria-label={t("Close files")} title={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <div className="files-dialog-browser" hidden={tab !== "browse"}>
            <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
              <ChangesView start={start} paneId={paneId} connected={connected} initialIntent={initialIntent} initialComment={initialComment} initialPath={initialPath} initialCommentId={initialCommentId} forcePreview={forcePreview}
                showFile={showFile} onShowFile={() => setShowFile(true)} refreshToken={refreshToken} keyboardActive={active && tab === "browse"} onHideFile={() => setShowFile(false)} onDiffsChange={setHasDiffs} toolsHost={tab === "browse" ? toolsHost : null} />
            </Suspense>
          </div>
          {changesVisited && paneId !== null && onOpenDiff && <div className="files-dialog-repository" hidden={tab !== "changes"}>
            <RepoChanges paneId={paneId} directory={start} onOpenDiff={onOpenDiff} />
          </div>}
        </div>
      </section>
    </div>
  );
}
