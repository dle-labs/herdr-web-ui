/**
 * Where the walk through a pane's file comments stands. The viewer's counter walks one file's
 * comments; once the viewer is closed, the composer's walk goes on after the file comment visited
 * last. Kept in memory only: after a reload the walk starts from the first comment again.
 */

/** Owner (`paneStorageId`) → id of the file comment the viewer last walked to. */
export const lastFileStop = new Map<string, string>();
