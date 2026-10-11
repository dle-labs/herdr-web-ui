import { lazy, Suspense, useEffect, useState } from "react";
import { X } from "lucide-react";

import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { changedField, revealField } from "../lib/commentDom.ts";
import type { FileComment } from "../lib/fileComments.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useOpeningPaneLane } from "../lib/chatLane.ts";
import "./FilesDialog.css";

const ChangesView = lazy(() => import("./ChangesView.tsx"));

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  paneId: string;
  connected: boolean;
  initialComment?: FileComment | null;
  /** a file is open above this dialog: Escape belongs to the viewer, which closes first */
  viewing: boolean;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

/** The files of the pane's folder (and any other), each opened in the file viewer. */
export function FilesDialog({ start, paneId, connected, initialComment = null, viewing, onOpenFile, onClose }: FilesDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<"files" | "changes">(initialComment === null ? "files" : "changes");
  const surface = useFocusTrap<HTMLElement>(true);
  const machineId = useMachineId();
  useOpeningPaneLane(surface, paneStorageId(machineId, paneId));
  const leave = (): boolean => {
    const field = changedField(surface.current);
    if (field === null) return true;
    revealField(field);
    return false;
  };
  const close = (): void => { if (leave()) onClose(); };
  useSheetSwipe(surface, viewing ? null : close);
  useEffect(() => {
    if (viewing) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && !nativeModalOver(surface.current)) {
        const field = changedField(surface.current);
        if (field !== null) { event.preventDefault(); revealField(field); } else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={surface} className={`modal files-dialog${tab === "changes" ? " files-dialog-changes" : ""}`}  role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <div className="segmented" role="group" aria-label={t("Files view")}>
            <button type="button" aria-pressed={tab === "files"} onClick={() => { if (leave()) setTab("files"); }}>{t("Files")}</button>
            <button type="button" aria-pressed={tab === "changes"} onClick={() => { if (leave()) setTab("changes"); }}>{t("Changes")}</button>
          </div>
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          {tab === "files" ? <DirectoryBrowser start={start} onOpenFile={onOpenFile} /> :
            <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
              <ChangesView paneId={paneId} connected={connected} initialComment={initialComment} onOpenFile={onOpenFile} />
            </Suspense>}
        </div>
      </section>
    </div>
  );
}
