import type { PaneComment } from "./blockComments.ts";

/** Reply and file comments both accompany the next message to the agent. */
export function composerComments(comments: readonly PaneComment[]): readonly PaneComment[] {
  return comments;
}
