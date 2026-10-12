import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, X } from "lucide-react";

import { useT } from "../lib/i18n.ts";
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
export function FilesDialog({ start, paneId, connected, initialIntent = "browse", initialComment = null, initialPath = null, initialCommentId = null, keyboardActive = true, onClose }: FilesDialogProps) {
  const t = useT();
  const surface = useFocusTrap<HTMLElement>(true);
  const narrow = useMediaQuery("(max-width: 768px)");
  const [showFile, setShowFile] = useState(initialPath !== null || initialComment !== null);
  const [refreshToken, setRefreshToken] = useState(0);
  const machineId = useMachineId();
  useOpeningPaneLane(surface, paneId === null ? null : paneStorageId(machineId, paneId));
  const leave = (): boolean => {
    const field = changedField(surface.current);
    if (field === null) return true;
    revealField(field);
    return false;
  };
  const close = (): void => { if (leave()) onClose(); };
  useSheetSwipe(surface, keyboardActive ? close : null);
  // A file link already owns useFileViewer's history entry; ordinary browsing owns a sheet entry.
  usePhoneSheetBack(close, keyboardActive && initialPath === null);
  useEffect(() => {
    if (!keyboardActive) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !nativeModalOver(surface.current)) {
        const field = changedField(surface.current);
        if (field !== null) { event.preventDefault(); revealField(field); } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive]);
  return (
    <div className="modal-scrim workspace-files-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={surface} className="modal files-dialog files-dialog-changes"  role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>
        <header className="modal-header">
          {narrow && showFile && <button type="button" className="icon-button" aria-label={t("Back to files")} onClick={() => { if (leave()) setShowFile(false); }}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          {paneId !== null && <button type="button" className="icon-button" aria-label={t("Refresh changes")} onClick={() => { if (leave()) setRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></button>}
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <ChangesView start={start} paneId={paneId} connected={connected} initialIntent={initialIntent} initialComment={initialComment} initialPath={initialPath} initialCommentId={initialCommentId}
              showFile={showFile} onShowFile={() => setShowFile(true)} refreshToken={refreshToken} keyboardActive={keyboardActive} onClose={close} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
