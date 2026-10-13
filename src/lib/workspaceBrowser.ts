import type { GitChangesResponse } from "../../shared/protocol.ts";
import { languageForPath } from "./highlight.ts";
import { workspaceChildPath } from "./workspaceFileTree.ts";

export type WorkspaceFileIntent = "browse" | "changes";
const normalize = (path: string) => path.replace(/\\/g, "/");

/** A deleted path or a rename's old path can still open its diff without a stat. */
export function changedWorkspacePath(inventory: GitChangesResponse, absolute: string): string | null {
  const target = normalize(absolute);
  return inventory.files.find((file) => normalize(workspaceChildPath(inventory.root, file.path)) === target
    || file.old_path !== undefined && normalize(workspaceChildPath(inventory.root, file.old_path)) === target)?.path ?? null;
}

/** The current Markdown document, never a deleted or binary diff's contents. */
export function changedMarkdownPreviewPath(inventory: GitChangesResponse, path: string): string | null {
  const file = inventory.files.find((file) => file.path === path);
  return file && file.status !== "deleted" && !file.binary && languageForPath(file.path) === "markdown"
    ? workspaceChildPath(inventory.root, file.path) : null;
}

/** Browsing a Markdown document must not turn into source just because Git lists it. */
export function workspacePreviewPath(inventory: GitChangesResponse, absolute: string, intent: WorkspaceFileIntent): string | null {
  const changed = changedWorkspacePath(inventory, absolute);
  if (changed === null) return absolute;
  if (intent === "changes") return null;
  const preview = changedMarkdownPreviewPath(inventory, changed);
  // A rename's old link still opens its diff; it must not pretend the new document is the old one.
  return preview !== null && normalize(preview) === normalize(absolute) ? preview : null;
}
