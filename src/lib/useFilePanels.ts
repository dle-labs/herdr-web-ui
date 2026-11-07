import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Machine } from "../../shared/protocol.ts";
import { CHANGED_ATTR, changedField, revealField } from "./commentDom.ts";
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

type Preview = Parameters<ReturnType<typeof useFileViewer>["openFile"]>[0];
const LEFT_FILES_KEPT = 10;
const paneKey = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;

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
  const { viewing, openFile, closeFile, releaseFile, hideFile, fileFromPop } = useFileViewer(canLeaveFiles);
  // Match upstream's Files list: a pane/PC switch starts at the newly selected pane.
  // An explicit preview retains its own history owner. A dirty editor must finish before
  // its browser can be replaced; observe the editor so saving/discarding catches up at once.
  useLayoutEffect(() => {
    if (!filesOpen || viewing !== null || diffCommentView !== null) return;
    if (filesTarget?.machineId === selectedMachineId && filesTarget.paneId === selectedPaneId) return;
    const follow = (): boolean => {
      if (changedField(document.querySelector(".files-dialog")) !== null) return false;
      const pane = machines.find((machine) => machine.id === selectedMachineId)?.snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId);
      setFilesTarget(pane ? { machineId: selectedMachineId, paneId: pane.pane_id, start: pane.foreground_cwd ?? pane.cwd ?? "" } : null);
      setDiffCommentView(null);
      setFilesIntent("browse");
      return true;
    };
    if (follow()) return;
    const surface = document.querySelector(".files-dialog");
    if (surface === null) return;
    const observer = new MutationObserver(() => { if (follow()) observer.disconnect(); });
    observer.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: [CHANGED_ATTR] });
    return () => observer.disconnect();
  }, [filesOpen, filesTarget, viewing, diffCommentView, selectedMachineId, selectedPaneId, machines]);
  // Settings > Files > Reopen files on return (#3179): the file a tab switch left behind, by its
  // pane, shown again when an in-app switch comes back to that pane. Back needs none of it: the file's
  // own entry stays under the switch and shows the file again.
  const leftFiles = useRef(new Map<string, Preview>());
  useEffect(() => {
    if (viewing?.paneId) leftFiles.current.delete(paneKey(viewing.machineId, viewing.paneId));
  }, [viewing]);
  const forgetLeftFiles = useCallback((paneLive: (machineId: string, paneId: string) => boolean) => {
    const left = leftFiles.current;
    for (const [key, file] of left) if (file.paneId !== null && !paneLive(file.machineId, file.paneId)) left.delete(key);
  }, []);
  const leaveFile = useCallback((paneLive: (machineId: string, paneId: string) => boolean = () => true, wasShown = true) => {
    if (!settings.reopenFileOnReturn || viewing?.paneId == null || !wasShown || !paneLive(viewing.machineId, viewing.paneId)) {
      releaseFile();
      return false;
    }
    const left = leftFiles.current;
    forgetLeftFiles(paneLive);
    const key = paneKey(viewing.machineId, viewing.paneId);
    // the oldest left beyond the cap is forgotten (a Map keeps insertion order)
    left.delete(key);
    left.set(key, viewing);
    for (const oldest of left.keys()) if (left.size > LEFT_FILES_KEPT) left.delete(oldest);
    hideFile();
    return true;
  }, [settings.reopenFileOnReturn, viewing, releaseFile, hideFile, forgetLeftFiles]);
  const restoreFile = useCallback((machineId: string, paneId: string) => {
    if (!settings.reopenFileOnReturn) return;
    const key = paneKey(machineId, paneId);
    const left = leftFiles.current.get(key);
    if (left === undefined) return;
    leftFiles.current.delete(key);
    openFile(left);
  }, [settings.reopenFileOnReturn, openFile]);
  const viewFile = useCallback((path: string) => {
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId]);
  // Chat turn change links retain their repository comparison and history entry.
  const { viewing: diffViewing, openDiff, closeDiff } = useRepoDiffViewer();
  // the composer's walk stops at a file comment: its file opens in the viewer, at that comment
  const viewFileComment = useCallback((paneId: string, machineId: string, comment: FileComment) => {
    if (!canLeaveFiles()) return;
    if (comment.diff !== undefined) {
      setFilesTarget({ paneId, machineId, start: comment.diff.repository });
      setDiffCommentView({ paneId, machineId, comment });
      setFilesIntent("changes");
      setFilesOpen(true);
      return;
    }
    openFile({ path: comment.path, paneId, machineId, comment: comment.id });
  }, [openFile, canLeaveFiles]);
  const [paneRole, setPaneRole] = useState<{ machineId: string; paneId: string; mode: "observe" | "interact" } | null>(null);
  const { webPage, closeWebPage, openWebPage } = useWebPanel({ settings, filePanelAvailable });
  return { filesOpen, setFilesOpen, filesTarget, filesIntent, diffCommentView, setDiffCommentView, canLeaveFiles, openFilesFor, viewing, openFile, closeFile, releaseFile, hideFile, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, viewFile, diffViewing, openDiff, closeDiff, viewFileComment, paneRole, setPaneRole, webPage, closeWebPage, openWebPage };
}
