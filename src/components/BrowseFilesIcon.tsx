import { FolderOpen } from "lucide-react";
import { useWorkspaceChanges } from "../lib/useWorkspaceChanges.ts";
import "./BrowseFilesIcon.css";

export function BrowseFilesIcon({ changed }: { changed: boolean }) {
  return <span className="browse-files-icon" aria-hidden="true" data-has-changes={changed ? "" : undefined}>
    <FolderOpen />
    {changed && <span className="browse-files-dot" />}
  </span>;
}

/** Mounted only while the menu is open, under its explicitly captured machine. */
export function BrowseFilesMenuIcon({ paneId, cwd, connected, status }: { paneId: string; cwd: string; connected: boolean; status: string }) {
  const changed = useWorkspaceChanges(paneId, cwd, connected, status, true);
  return <BrowseFilesIcon changed={changed} />;
}
