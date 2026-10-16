import { useCallback, useState } from "react";
import type { Machine } from "../../shared/protocol.ts";
import { changedField, revealField } from "./commentDom.ts";
import type { FileComment } from "./fileComments.ts";
import type { Settings } from "./settings.ts";
import { useFileViewer } from "./useFileViewer.ts";
import { useRepoDiffViewer } from "./useRepoDiffViewer.ts";
import { useWebPanel } from "./useWebPanel.ts";
import type { WorkspaceFileIntent } from "./workspaceBrowser.ts";

interface FilePanelsParams {
  machines: readonly Machine[];
  settings: Settings;
  filePanelAvailable: boolean;
  selectedPaneId: string | null;
  selectedMachineId: string;
}

export function useFilePanels({ machines, settings, filePanelAvailable, selectedPaneId, selectedMachineId }: FilePanelsParams) {
  // One Files browser, whether opened from its button, a path link or a comment.
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesTarget, setFilesTarget] = useState<{ machineId: string; paneId: string; start: string } | null>(null);
  const canLeaveFiles = useCallback(() => {
    const field = changedField(document.querySelector(".files-dialog"));
    if (field === null) return true;
    revealField(field);
    return false;
  }, []);
  const openFilesFor = useCallback((paneId: string, machineId: string, intent: WorkspaceFileIntent) => {
    if (!canLeaveFiles()) return;
    const pane = machines.find((machine) => machine.id === machineId)?.snapshot?.panes.find((pane) => pane.pane_id === paneId);
    setFilesTarget({ machineId, paneId, start: pane?.foreground_cwd ?? pane?.cwd ?? "" });
    setDiffCommentView(null);
    setFilesIntent(intent);
    setFilesOpen(true);
  }, [machines, canLeaveFiles]);
  const [filesIntent, setFilesIntent] = useState<WorkspaceFileIntent>("browse");
  const [diffCommentView, setDiffCommentView] = useState<{ paneId: string; machineId: string; comment: FileComment } | null>(null);
  const { viewing, openFile, closeFile, releaseFile } = useFileViewer(canLeaveFiles);
  const viewFile = useCallback((path: string) => {
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId]);
  // Chat turn change links retain their repository comparison and history entry.
  const { viewing: diffViewing, closeDiff } = useRepoDiffViewer();
  // the composer's walk stops at a file comment: its file opens in the viewer, at that comment
  const viewFileComment = useCallback((paneId: string, machineId: string, comment: FileComment) => {
    if (!canLeaveFiles()) return;
    if (comment.diff !== undefined) {
      setDiffCommentView({ paneId, machineId, comment });
      setFilesIntent("changes");
      setFilesOpen(true);
      return;
    }
    openFile({ path: comment.path, paneId, machineId, comment: comment.id });
  }, [openFile, canLeaveFiles]);
  const [paneRole, setPaneRole] = useState<{ machineId: string; paneId: string; mode: "observe" | "interact" } | null>(null);
  const { webPage, closeWebPage, openWebPage } = useWebPanel({ settings, filePanelAvailable });
  return { filesOpen, setFilesOpen, filesTarget, filesIntent, diffCommentView, setDiffCommentView, canLeaveFiles, openFilesFor, viewing, openFile, closeFile, releaseFile, viewFile, diffViewing, closeDiff, viewFileComment, paneRole, setPaneRole, webPage, closeWebPage, openWebPage };
}

/** A browse request selects its pane without raising the phone keyboard. */
export function useWorkspaceFilesOpener({ canLeaveFiles, selectPane, openFilesFor, selectedMachineId }: {
  canLeaveFiles: () => boolean;
  selectPane: (paneId: string, focusInput: boolean) => void;
  openFilesFor: (paneId: string, machineId: string, intent: WorkspaceFileIntent) => void;
  selectedMachineId: string;
}) {
  return useCallback((paneId: string) => {
    if (!canLeaveFiles()) return;
    selectPane(paneId, false);
    openFilesFor(paneId, selectedMachineId, "browse");
  }, [selectPane, selectedMachineId, openFilesFor, canLeaveFiles]);
}
