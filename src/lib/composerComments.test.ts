import { describe, expect, it } from "bun:test";
import { outgoingMessage, type BlockComment } from "./blockComments.ts";
import { composerFileComments } from "./composerComments.ts";
import { fileAnchor, type FileComment } from "./fileComments.ts";
import { parseMarkdown } from "../../shared/markdown.ts";

const legacy: BlockComment = { id: "old-reply", anchor: "turn:0:0", block: parseMarkdown("Old reply")[0]!, order: [1, 0, 0], comment: "Do not send this." };
const file: FileComment = {
  kind: "file", id: "file-note", anchor: "", created: 2, comment: "Fix this line.",
  path: "/repo/a.ts", label: "a.ts", view: "code", lines: [1, 1], source: ["const a = 1;"], quoteLines: ["const a = 1;"],
};
file.anchor = fileAnchor(file);

describe("composer file comments", () => {
  it("ignores old reply notes for counts, navigation and outgoing messages", () => {
    const comments = composerFileComments([legacy, file]);
    expect(comments).toEqual([file]);
    const outgoing = outgoingMessage(comments, "Please review", { answering: false, agent: true });
    expect(outgoing.sentIds).toEqual([file.id]);
    expect(outgoing.sent).toEqual([file]);
    expect(composerFileComments([legacy])).toEqual([]);
    expect(outgoingMessage(composerFileComments([legacy]), "", { answering: false, agent: true }).sendable).toBe(false);
  });

  it("retains old Preview notes but holds all file comments away from shells, answers and commands", () => {
    const preview: FileComment = { ...file, id: "preview-note", view: "preview" };
    const comments = composerFileComments([legacy, preview]);
    expect(comments).toEqual([preview]);
    for (const [text, options, reason] of [
      ["Hello", { answering: false, agent: false }, "no-agent"],
      ["Yes", { answering: true, agent: true }, "answer"],
      ["/help", { answering: false, agent: true }, "command"],
    ] as const) {
      const outgoing = outgoingMessage(comments, text, options);
      expect(outgoing.sentIds).toEqual([]);
      expect(outgoing.commentsHeld).toBe(reason);
    }
  });
});
