import { lazy, Suspense, useEffect } from "react";
import { X } from "lucide-react";

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
  onClose: () => void;
}

/** One workspace surface for its file tree, current diffs and embedded file previews. */
export function FilesDialog({ start, paneId, connected, initialComment = null, viewing, onClose }: FilesDialogProps) {
  const t = useT();
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
    <div className="modal-scrim workspace-files-scrim" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={surface} className="modal files-dialog files-dialog-changes"  role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={close}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <Suspense fallback={<p role="status">{t("Loading…")}</p>}>
            <ChangesView start={start} paneId={paneId} connected={connected} initialComment={initialComment} />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
