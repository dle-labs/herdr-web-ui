import { MAX_COMPOSER_CHARS } from "./compose.ts";

export type CommentReference =
  | { kind: "reply"; text: string }
  | { kind: "file"; path: string; text: string };

/** Build an editable annotation only; an oversized draft is rejected whole. */
export function appendCommentToDraft(draft: string, reference: CommentReference, comment: string): string | null {
  const trimmedComment = comment.trim();
  if (!trimmedComment) return null;

  const label = reference.kind === "reply" ? "Reply:" : `File: ${reference.path}`;
  const quote = reference.text.replace(/\r\n/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
  const annotation = `${label}\n${quote}\n\n${trimmedComment}`;
  const result = draft.length > 0 ? `${draft}\n\n${annotation}` : annotation;
  return result.length <= MAX_COMPOSER_CHARS ? result : null;
}
