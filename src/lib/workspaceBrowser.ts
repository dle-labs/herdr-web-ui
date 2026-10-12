import type { GitChangesResponse } from "../../shared/protocol.ts";
import { workspaceChildPath } from "./workspaceFileTree.ts";

/** A deleted path or a rename's old path can still open its diff without a stat. */
export function changedWorkspacePath(inventory: GitChangesResponse, absolute: string): string | null {
  const normalize = (path: string) => path.replace(/\\/g, "/");
  const target = normalize(absolute);
  return inventory.files.find((file) => normalize(workspaceChildPath(inventory.root, file.path)) === target
    || file.old_path !== undefined && normalize(workspaceChildPath(inventory.root, file.old_path)) === target)?.path ?? null;
}
