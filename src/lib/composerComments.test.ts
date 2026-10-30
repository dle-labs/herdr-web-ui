import { describe, expect, it } from "bun:test";
import { outgoingMessage, type BlockComment } from "./blockComments.ts";
import { composerComments } from "./composerComments.ts";
import { fileAnchor, type FileComment } from "./fileComments.ts";
import { parseMarkdown } from "../../shared/markdown.ts";

const legacy: BlockComment = { id: "old-reply", anchor: "turn:0:0", block: parseMarkdown("Old reply")[0]!, order: [1, 0, 0], comment: "Do not send this." };
const file: FileComment = {
  kind: "file", id: "file-note", anchor: "", created: 2, comment: "Fix this line.",
  path: "/repo/a.ts", label: "a.ts", view: "code", lines: [1, 1], source: ["const a = 1;"], quoteLines: ["const a = 1;"],
};
file.anchor = fileAnchor(file);

describe("composer file comments", () => {
  it("keeps reply and file notes together in outgoing messages", () => {
    const comments = composerComments([legacy, file]);
    expect(comments).toEqual([legacy, file]);
    const outgoing = outgoingMessage(comments, "Please review", { answering: false, agent: true });
    expect(outgoing.sentIds).toEqual([legacy.id, file.id]);
    expect(outgoing.sent).toEqual([legacy, file]);
    expect(composerComments([legacy])).toEqual([legacy]);
    expect(outgoingMessage(composerComments([legacy]), "", { answering: false, agent: true }).sendable).toBe(true);
  });

  it("retains old Preview notes but holds all file comments away from shells, answers and commands", () => {
    const preview: FileComment = { ...file, id: "preview-note", view: "preview" };
    const comments = composerComments([legacy, preview]);
    expect(comments).toEqual([legacy, preview]);
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
