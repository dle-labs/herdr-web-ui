/**
 * The way from the composer's walk to a file comment: the composer has no viewer of its own, so App
 * opens its file in the viewer, at that comment (`useFileViewer`'s `comment`), as a history entry
 * Back closes. Null where no viewer is mounted to open it (outside App).
 */
import { createContext } from "react";

import type { FileComment } from "./fileComments.ts";

/** Opens `comment`'s file in the viewer, for the pane `paneId` on the PC `machineId`, at that comment. */
export const FileCommentNavContext = createContext<((paneId: string, machineId: string, comment: FileComment) => void) | null>(null);
