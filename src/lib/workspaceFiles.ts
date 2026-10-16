import { createContext } from "react";

/** Open the unified workspace viewer for the explicitly chosen pane. */
export const WorkspaceFilesContext = createContext<((paneId: string) => void) | null>(null);
