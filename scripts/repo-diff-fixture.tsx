import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/fonts/fonts.css";
import "../src/styles.css";
import { DirectoryBrowser } from "../src/components/DirectoryBrowser.tsx";
import { FilesDialog } from "../src/components/FilesDialog.tsx";
import { RepoChanges, type RepoChangesProps } from "../src/components/RepoChanges.tsx";
import { RepoDiffViewer } from "../src/components/RepoDiffViewer.tsx";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { SettingsProvider, useSettings, type Settings } from "../src/lib/settings.ts";
import { useFileViewer } from "../src/lib/useFileViewer.ts";
import { useRepoDiffViewer } from "../src/lib/useRepoDiffViewer.ts";
import type { RepoDiffTarget } from "../src/lib/repoDiff.ts";
import { nativeModalOver, useFocusTrap } from "../src/lib/useFocusTrap.ts";
import { useSheetSwipe } from "../src/lib/sheets.ts";
import { usePhoneSheetBack } from "../src/lib/sheetHistory.ts";

interface Files { machine: string; paneId: string; directory: string }
declare global { interface Window { repoDiffQA: { openFiles: (machine: string, paneId: string, directory: string) => void; closeFiles: () => void; settings: (patch: Partial<Settings>) => void; openDiff: (target: RepoDiffTarget) => void } } }

/**
 * Test-only legacy comparison shell. App's FilesDialog is the unified tree/diff browser, not
 * these Browse/Changes tabs. This shell keeps exercising the retained RepoChanges component
 * and the standalone RepoDiffViewer (also reached from chat's edited-file links), with the
 * production focus, sheet and history hooks rather than a second implementation of them.
 */
function LegacyComparisons({ files, viewing, onOpenFile, onOpenDiff, onClose }: {
  files: Files; viewing: boolean; onOpenFile: (path: string) => void;
  onOpenDiff: RepoChangesProps["onOpenDiff"]; onClose: () => void;
}) {
  const surface = useFocusTrap<HTMLElement>(true);
  const [tab, setTab] = useState<"browse" | "changes">("browse");
  const [changesVisited, setChangesVisited] = useState(false);
  useSheetSwipe(surface, viewing ? null : onClose);
  usePhoneSheetBack(onClose, !viewing);
  useEffect(() => {
    if (viewing) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !nativeModalOver(surface.current)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);
  return <div className="modal-scrim" onMouseDown={(event) => { if (!viewing && event.target === event.currentTarget) onClose(); }}>
    <section ref={surface} className="modal files-dialog files-dialog-changes" role="dialog" aria-modal="true" aria-label="Legacy repository comparisons" tabIndex={-1}>
      <header className="modal-header">
        <h2 className="modal-title">Legacy repository comparisons</h2>
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === "browse"} onClick={() => setTab("browse")}>Browse</button>
          <button type="button" aria-pressed={tab === "changes"} onClick={() => { setTab("changes"); setChangesVisited(true); }}>Changes</button>
        </div>
        <button type="button" className="btn" onClick={onClose}>Close comparisons</button>
      </header>
      <div className="modal-body" style={{ display: "block", overflowY: "auto" }}>
        <div hidden={tab !== "browse"}><DirectoryBrowser start={files.directory} onOpenFile={onOpenFile} /></div>
        {changesVisited && <div hidden={tab !== "changes"}><RepoChanges paneId={files.paneId} directory={files.directory} onOpenDiff={onOpenDiff} /></div>}
      </div>
    </section>
  </div>;
}

function Fixture() {
  const [files, setFiles] = useState<Files | null>(null);
  const { viewing: file, openFile, closeFile } = useFileViewer();
  const { viewing: diff, openDiff, closeDiff } = useRepoDiffViewer();
  const { update } = useSettings();
  window.repoDiffQA = { openFiles: (machine, paneId, directory) => setFiles({ machine, paneId, directory }), closeFiles: () => setFiles(null), settings: update, openDiff };
  return <main>
    <button type="button" id="outside">Outside</button>
    {files && <MachineContext.Provider value={files.machine}>
      <LegacyComparisons files={files} viewing={file !== null || diff !== null}
        onOpenFile={(path) => openFile({ path, paneId: files.paneId, machineId: files.machine })}
        onOpenDiff={(comparison, entry) => openDiff({ machineId: files.machine, paneId: files.paneId, directory: files.directory, ...comparison, path: entry.path, oldPath: entry.old_path })}
        onClose={() => setFiles(null)} />
    </MachineContext.Provider>}
    {diff && <MachineContext.Provider value={diff.machineId}>
      <RepoDiffViewer key={`${diff.scope}:${diff.path}`} target={diff} onClose={closeDiff} onOpenFile={(path) => openFile({ path, paneId: diff.paneId, machineId: diff.machineId })} keyboardActive={file === null} />
    </MachineContext.Provider>}
    {file && <MachineContext.Provider value={file.machineId}>
      {/* The real unified browser, above this test's standalone comparison. Absolute file paths
          need no live pane or git inventory; the owning PC still supplies every file read. */}
      <div style={{ position: "relative", zIndex: "calc(var(--z-modal) + 2)" }}>
        <FilesDialog key={file.path} start={file.path.slice(0, file.path.lastIndexOf("/")) || "/"} paneId={null}
          connected={false} initialPath={file.path} onClose={closeFile} />
      </div>
    </MachineContext.Provider>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
