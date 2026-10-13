import { describe, expect, it } from "bun:test";
import { appendCommentToDraft, type CommentReference } from "./commentDraft.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";

describe("appendCommentToDraft", () => {
  const reply: CommentReference = { kind: "reply", text: "Original reply" };

  it("labels reply context and trims only the comment's edges", () => {
    expect(appendCommentToDraft("", reply, " \nPlease revise.\nKeep this line.\t ")).toBe(
      "Reply:\n> Original reply\n\nPlease revise.\nKeep this line.",
    );
  });

  it("labels file context with its path and quotes every line, normalizing CRLF", () => {
    expect(appendCommentToDraft("", {
      kind: "file", path: "src/example file.ts", text: "  first\r\n\r\nlast\r\n",
    }, "Fix this.")).toBe(
      "File: src/example file.ts\n>   first\n> \n> last\n> \n\nFix this.",
    );
  });

  it("rejects blank comments without creating context-only drafts", () => {
    for (const comment of ["", " \t\r\n", "\u00a0"]) {
      expect(appendCommentToDraft("existing", reply, comment)).toBeNull();
    }
  });

  it("preserves a nonempty draft byte-for-byte, including whitespace and CRLF", () => {
    for (const draft of ["  existing\r\ntext \n\n", " \t\r\n"]) {
      expect(appendCommentToDraft(draft, reply, "Comment")).toBe(
        `${draft}\n\nReply:\n> Original reply\n\nComment`,
      );
    }
  });

  it("quotes empty source text and adds no leading separator to an empty draft", () => {
    expect(appendCommentToDraft("", { kind: "reply", text: "" }, "Comment")).toBe(
      "Reply:\n> \n\nComment",
    );
  });

  it("accepts exactly the size limit and rejects one character over, counting the draft separator", () => {
    const annotation = "Reply:\n> Original reply\n\nComment";
    const draft = "x".repeat(MAX_COMPOSER_CHARS - annotation.length - 2);
    expect(appendCommentToDraft(draft, reply, "Comment")).toBe(`${draft}\n\n${annotation}`);
    expect(appendCommentToDraft(`${draft}x`, reply, "Comment")).toBeNull();
  });

  it("accepts an exact-size annotation without a draft and never truncates oversized comments or quotes", () => {
    const prefix = "Reply:\n> Original reply\n\n";
    const comment = "c".repeat(MAX_COMPOSER_CHARS - prefix.length);
    expect(appendCommentToDraft("", reply, comment)).toBe(prefix + comment);
    expect(appendCommentToDraft("", reply, `${comment}c`)).toBeNull();
    expect(appendCommentToDraft("", {
      kind: "file", path: "large.ts", text: "q".repeat(MAX_COMPOSER_CHARS),
    }, "Keep the whole quote.")).toBeNull();
    expect(appendCommentToDraft("x".repeat(MAX_COMPOSER_CHARS), reply, "Keep the whole draft.")).toBeNull();
  });
});
