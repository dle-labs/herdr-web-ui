import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/fonts/fonts.css";
import "../src/styles.css";
import { RepoChanges } from "../src/components/RepoChanges.tsx";
import { FileViewer } from "../src/components/FileViewer.tsx";
import { RepoDiffViewer } from "../src/components/RepoDiffViewer.tsx";
import { MachineContext } from "../src/lib/machineContext.tsx";
import { SettingsProvider, useSettings, type Settings } from "../src/lib/settings.ts";
import { useFileViewer } from "../src/lib/useFileViewer.ts";
import { useRepoDiffViewer } from "../src/lib/useRepoDiffViewer.ts";
import { nativeModalOver, useFocusTrap } from "../src/lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../src/lib/sheetHistory.ts";

interface Files { machine: string; paneId: string; directory: string }
const UNSTAGED = { scope: "workspace", base: null, head: null } as const;
declare global { interface Window { repoDiffQA: { openFiles: (machine: string, paneId: string, directory: string) => void; closeFiles: () => void; settings: (patch: Partial<Settings>) => void } } }

/** Directly exercise the preserved standalone viewers; the real-app demo covers integrated Files. */
function ChangesHost({ files, viewing, onOpenDiff, onClose }: { files: Files; viewing: boolean; onOpenDiff: React.ComponentProps<typeof RepoChanges>["onOpenDiff"]; onClose: () => void }) {
  const surface = useFocusTrap<HTMLElement>(true);
  const [changes, setChanges] = useState(false);
  usePhoneSheetBack(onClose, !viewing);
  React.useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (!viewing && event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [viewing, onClose]);
  return <div className="modal-scrim"><section ref={surface} className="modal" role="dialog" aria-modal="true" aria-label="Files" tabIndex={-1}>
    <header className="modal-header"><h2 className="modal-title">Files</h2><button type="button" onClick={() => setChanges(true)}>Changes</button></header>
    {changes && <RepoChanges paneId={files.paneId} directory={files.directory} comparison={UNSTAGED} onOpenDiff={onOpenDiff} />}
  </section></div>;
}
function Fixture() {
  const [files, setFiles] = useState<Files | null>(null);
  const { viewing: file, openFile, closeFile } = useFileViewer();
  const { viewing: diff, openDiff, closeDiff } = useRepoDiffViewer();
  const { update } = useSettings();
  window.repoDiffQA = { openFiles: (machine, paneId, directory) => setFiles({ machine, paneId, directory }), closeFiles: () => setFiles(null), settings: update };
  return <main>
    <button type="button" id="outside">Outside</button>
    {files && <MachineContext.Provider value={files.machine}>
      <ChangesHost files={files} viewing={file !== null || diff !== null} onOpenDiff={(comparison, entry) => openDiff({ machineId: files.machine, paneId: files.paneId, directory: files.directory, ...comparison, path: entry.path, oldPath: entry.old_path })} onClose={() => setFiles(null)} />
    </MachineContext.Provider>}
    {diff && <MachineContext.Provider value={diff.machineId}>
      <RepoDiffViewer key={`${diff.scope}:${diff.path}`} target={diff} onClose={closeDiff} onOpenFile={(path) => openFile({ path, paneId: diff.paneId, machineId: diff.machineId })} keyboardActive={file === null} />
    </MachineContext.Provider>}
    {file && <MachineContext.Provider value={file.machineId}>
      <FileViewer key={file.path} path={file.path} paneId={file.paneId} onClose={closeFile} />
    </MachineContext.Provider>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
