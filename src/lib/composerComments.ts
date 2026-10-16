import { isReplyComment, type PaneComment } from "./blockComments.ts";
import type { FileComment } from "./fileComments.ts";

/** The composer counts, visits and sends files only; old persisted reply notes stay inert. */
export function composerFileComments(comments: readonly PaneComment[]): FileComment[] {
  return comments.filter((comment): comment is FileComment => !isReplyComment(comment));
}
