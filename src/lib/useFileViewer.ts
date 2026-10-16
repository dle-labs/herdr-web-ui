import { useCallback, useEffect, useRef, useState } from "react";
import { outsideSettings } from "./settingsHistory.ts";
import type { FilePresentation } from "./filePresentation.ts";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
  presentation?: FilePresentation;
  /** the id of a file comment of the pane to open the viewer at (the composer's walk) */
  comment?: string;
}
const HISTORY_KEY = "herdr-web-ui:file-preview";

function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  if (typeof value.path !== "string" || typeof value.machineId !== "string" || (value.paneId !== null && typeof value.paneId !== "string")) return null;
  if (value.comment !== undefined && typeof value.comment !== "string") return null;
  return { path: value.path, machineId: value.machineId, paneId: value.paneId, ...(value.presentation === "panel" || value.presentation === "popup" ? { presentation: value.presentation } : {}), ...(value.comment === undefined ? {} : { comment: value.comment }) };
}

/** Android Back traverses history: a preview must be an entry above the chat, not just a modal. */
export function useFileViewer(canLeave: () => boolean = () => true) {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);
  const current = useRef(viewing);
  current.current = viewing;
  const leave = useRef(canLeave);
  leave.current = canLeave;
  const entry = useRef({ state: window.history.state, url: window.location.href });
  useEffect(() => {
    // App writes its deep-link URL in an effect too: capture after those effects.
    let live = true;
    queueMicrotask(() => { if (live && current.current) entry.current = { state: window.history.state, url: window.location.href }; });
    return () => { live = false; };
  });

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      const next = previewFromState(event.state);
      const previous = current.current;
      const replacing = previous !== null && (next?.path !== previous.path || next?.paneId !== previous.paneId || next?.machineId !== previous.machineId || next?.comment !== previous.comment);
      if (replacing && !leave.current()) {
        // Keep the document and its draft mounted; restore a Back entry before
        // App's selection/deep-link listeners can act on the refused destination.
        window.history.pushState({ ...entry.current.state, [HISTORY_KEY]: previous }, "", entry.current.url);
        event.stopImmediatePropagation();
        return;
      }
      // Forward restores the preview with its original PC/pane, including after reload.
      setViewing(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview, replace = false) => {
    if (closing.current || !leave.current()) return;
    // a preview opened over Settings is no entry of Settings: a reload on it closes Settings and keeps the file
    const state = { ...outsideSettings(window.history.state), [HISTORY_KEY]: preview };
    // Choosing a different file inside an open preview must not add another Back step.
    if (replace || previewFromState(window.history.state)) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current || !leave.current()) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button.
      window.history.back();
    } else setViewing(null);
  }, []);

  const setPresentation = useCallback((presentation: FilePresentation) => {
    const preview = previewFromState(window.history.state);
    if (closing.current || preview === null || preview.presentation === presentation) return;
    const next = { ...preview, presentation };
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: next }, "");
    setViewing(next);
  }, []);

  /** Hands the file's entry to a move to another pane: the file leaves it without a traversal, and the viewer closes. */
  const releaseFile = useCallback(() => {
    const { [HISTORY_KEY]: _, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(rest, "");
    setViewing(null);
  }, []);

  return { viewing, openFile, closeFile, setPresentation, releaseFile };
}
