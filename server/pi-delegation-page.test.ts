import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, transcriptPage } from "./conversation.ts";
import type { ConversationTurn } from "../shared/protocol.ts";

const roots: string[] = [];
afterEach(() => { forgetTranscriptState(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const file = () => { const root = mkdtempSync(join(tmpdir(), "herdr-pi-delegation-")); roots.push(root); return join(root, "session.jsonl"); };
const row = (id: string, parentId: string | null, extra: object) => ({ id, parentId, timestamp: "2026-10-10T00:00:00Z", ...extra });
const message = (id: string, parent: string | null, role: string, content: unknown, extra = {}) => row(id, parent, { type: "message", message: { role, content, ...extra } });
const terminal = (id: string, parent: string, task = id) => row(id, parent, { type: "custom", customType: "subagents:record", data: { id: task, type: "explore", description: task, status: "completed", result: "result", startedAt: 10, completedAt: 20 } });
const write = (path: string, rows: object[]) => writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const cards = (turns: ConversationTurn[]) => turns.flatMap((t) => t.parts).flatMap((p) => p.kind === "delegation" ? p.tasks : p.kind === "tool" && p.delegation ? [p.delegation] : []);

describe("pi delegation pages", () => {
  it("retains metadata and custom records across warm reads, cold reads, appends and branch selection", () => {
    const path = file();
    write(path, [message("u", null, "user", "inspect"), message("a", "u", "assistant", [{ type: "toolCall", id: "c", name: "Agent", arguments: {} }]),
      message("r", "a", "toolResult", [{ type: "text", text: "launched" }], { toolCallId: "c", details: { displayName: "Explore", subagentType: "explore", agentId: "task", status: "background" } }),
      message("end", "r", "assistant", "Parent ended", { stopReason: "stop" }), terminal("record", "end", "task")]);
    const cold = transcriptPage("pi-transcript", path);
    expect(cards(cold.turns).map((t) => t.status)).toEqual(["background", "completed"]);
    expect(transcriptPage("pi-transcript", path).turns).toEqual(cold.turns);
    appendFileSync(path, JSON.stringify(message("next", "record", "user", "next question")) + "\n");
    const warm = transcriptPage("pi-transcript", path);
    forgetTranscriptState();
    expect(transcriptPage("pi-transcript", path).turns).toEqual(warm.turns);
    // Move the active branch behind both launch and completion: no cached task leaks across it.
    appendFileSync(path, JSON.stringify(message("branch", "u", "assistant", "Different answer", { stopReason: "stop" })) + "\n");
    expect(cards(transcriptPage("pi-transcript", path).turns)).toEqual([]);
  });
  it("deduplicates notifications across settled/live parser stretches without hiding completion boundaries", () => {
    const path = file();
    const notice = row("n", "u2", { type: "custom_message", customType: "subagent-notification", content: "recorded notification", details: { id: "task", status: "completed", resultPreview: "result" } });
    write(path, [message("u", null, "user", "inspect"), message("a", "u", "assistant", "Parent answer", { stopReason: "stop" }), terminal("r", "a", "task")]);
    transcriptPage("pi-transcript", path);
    appendFileSync(path, [message("u2", "r", "user", "next"), notice, message("answer", "n", "assistant", "Follow-up", { stopReason: "stop" })].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const warm = transcriptPage("pi-transcript", path);
    expect(cards(warm.turns)).toHaveLength(1);
    forgetTranscriptState();
    expect(transcriptPage("pi-transcript", path).turns).toEqual(warm.turns);
  });
  it("keeps standalone mention completions reachable on older pages and stable after cache reset", () => {
    const path = file();
    const rows: object[] = [];
    let parent: string | null = null;
    for (let n = 0; n < 140; n++) {
      rows.push(message(`u${n}`, parent, "user", `question ${n}`));
      rows.push(message(`a${n}`, `u${n}`, "assistant", `answer ${n}`, { stopReason: "stop" }));
      rows.push(terminal(`d${n}`, `a${n}`));
      parent = `d${n}`;
    }
    write(path, rows);
    const all = () => {
      const ids: (string | null)[] = [];
      let page = transcriptPage("pi-transcript", path);
      for (let guard = 0; guard < 20; guard++) {
        ids.push(...cards(page.turns).map((t) => t.id));
        if (!page.cursor) break;
        page = transcriptPage("pi-transcript", path, { before: page.cursor });
      }
      return ids;
    };
    const cold = all();
    expect(new Set(cold).size).toBe(140);
    expect(all()).toEqual(cold);
    forgetTranscriptState();
    expect(all()).toEqual(cold);
  });
});
