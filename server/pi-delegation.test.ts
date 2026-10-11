import { describe, expect, it } from "bun:test";
import { freshPiDelegations, piDelegationRecords, piToolDelegation } from "./pi-delegation.ts";
import { parseOmpTranscript } from "./transcript-records.ts";

const details = { agentId: "a1", displayName: "Explore", subagentType: "explore", description: "Review parser", modelName: "model", status: "background", durationMs: 25, tokens: "33.8k token" };
const entry = (data: Record<string, unknown>) => ({ type: "custom", customType: "subagents:record", data: { id: "a1", type: "explore", status: "completed", result: "Found it", startedAt: 100, completedAt: 200, ...data } });
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const message = (role: string, content: unknown, extra = {}) => ({ type: "message", message: { role, content, ...extra } });

describe("bounded pi-subagents evidence", () => {
  it("normalizes AgentDetails without leaking arbitrary details or inventing token counts", () => {
    const task = piToolDelegation("Agent", { ...details, outputFile: "/secret", nested: { secret: true } });
    expect(task).toMatchObject({ id: "a1", model: "model", status: "background", duration_ms: 25 });
    expect(JSON.stringify(task)).not.toContain("secret");
    expect(task).not.toHaveProperty("tokens");
    expect(piToolDelegation("agent", details)).toBeUndefined();
    expect(piToolDelegation("Agent", { ...details, status: "new-version" })).toBeUndefined();
    expect(piToolDelegation("Agent", { ...details, durationMs: Infinity })?.duration_ms).toBeNull();
  });
  it("reads exact get-result/steer text envelopes and retains unknown formats as generic tools", () => {
    const output = "Agent: a1\nType: Explore | Status: stopped | Tool uses: 2 | 33.8k token | Duration: 5s\nDescription: Review\n\nPartial output";
    expect(piToolDelegation("get_subagent_result", {}, output)).toMatchObject({ id: "a1", status: "stopped", result: "Partial output", duration_ms: null });
    expect(piToolDelegation("steer_subagent", {}, "Steering message sent to agent a1. The agent will process it after its current tool execution.")).toMatchObject({ status: "steered" });
    expect(piToolDelegation("steer_subagent", {}, "Steering message queued for agent a1. It will be delivered once the session initializes.")).toMatchObject({ status: "steer_queued" });
    expect(piToolDelegation("get_subagent_result", {}, `Quoted:\n${output}`)).toBeUndefined();
    expect(piToolDelegation("steer_subagent", {}, "Agent not found")).toBeUndefined();
    expect(piToolDelegation("SubagentWorkflow", { taskId: "wf1", arbitrary: true })).toMatchObject({ id: "wf1", type: "workflow", status: null });
  });
  it("bounds grouped notifications and ignores nested others/unknown fields", () => {
    const d = { id: "a1", status: "error", resultPreview: "x".repeat(20000), durationMs: -1, others: [{ id: "nested", status: "completed" }] };
    const tasks = piDelegationRecords({ type: "custom_message", customType: "subagent-notification", details: { ...d, others: Array(100).fill(d) } })!;
    expect(tasks).toHaveLength(32);
    expect(tasks[0]).toMatchObject({ duration_ms: null, result_cut: true });
    expect(tasks[0]!.result).toHaveLength(16000);
    expect(tasks.some((t) => t.id === "nested")).toBe(false);
  });
  it("recognizes workflow completions on the shared notification channel", () => {
    const tasks = piDelegationRecords({ type: "custom_message", customType: "subagent-notification", details: {
      id: "wf_012345abcdef", description: "Workflow review", status: "completed", resultPreview: "Review finished",
    } });
    expect(tasks?.[0]).toMatchObject({ type: "workflow", status: "completed", evidence: "notification" });
  });
  it("keeps settled workflow snapshots without exposing replay journal or child runtime state", () => {
    const tasks = piDelegationRecords({ type: "custom", customType: "subagents:workflow", data: { name: "Audit", status: "failed", startTime: 10, endTime: 60, progress: [{ secret: true }] } });
    expect(tasks?.[0]).toMatchObject({ name: "Audit", status: "failed", duration_ms: 50, type: "workflow" });
    expect(JSON.stringify(tasks)).not.toContain("secret");
  });
  it("deduplicates a record and its notification but not a later resumed run", () => {
    const seen = new Set<string>();
    const r = entry({});
    expect(freshPiDelegations(r, piDelegationRecords(r)!, seen)).toHaveLength(1);
    expect(freshPiDelegations(r, piDelegationRecords(r)!, seen)).toHaveLength(0);
    const notice = { type: "custom_message", customType: "subagent-notification", details: { id: "a1", status: "completed", resultPreview: "Found it" } };
    expect(freshPiDelegations(notice, piDelegationRecords(notice)!, seen)).toHaveLength(0);
    const resume = entry({ startedAt: 300, completedAt: 400 });
    expect(freshPiDelegations(resume, piDelegationRecords(resume)!, seen)).toHaveLength(1);
    const notificationsOnly = new Set<string>();
    for (const timestamp of ["2026-10-10T00:00:00Z", "2026-10-10T00:01:00Z"]) {
      const next = { ...notice, timestamp };
      expect(freshPiDelegations(next, piDelegationRecords(next)!, notificationsOnly)).toHaveLength(1);
    }
  });
  it("attaches metadata while preserving original input/output and completion boundaries", () => {
    const turns = parseOmpTranscript(jsonl(
      message("assistant", [{ type: "toolCall", id: "c1", name: "Agent", arguments: { prompt: "review" } }]),
      message("toolResult", [{ type: "text", text: "Original output" }], { toolCallId: "c1", details }),
      message("assistant", [{ type: "text", text: "Parent answer" }], { stopReason: "stop" }),
      entry({}),
      { type: "custom_message", customType: "subagent-notification", content: "generic duplicate", details: { id: "a1", status: "completed", resultPreview: "Found it" } },
      message("assistant", [{ type: "text", text: "Follow-up" }]),
    ));
    expect(turns[0]?.parts[0]).toMatchObject({ kind: "tool", output: "Original output", delegation: { status: "background" } });
    expect(turns.flatMap((t) => t.parts).filter((p) => p.kind === "delegation")).toHaveLength(1);
    expect(turns.at(-1)?.parts).toEqual([{ kind: "text", text: "Follow-up" }]);
    expect(turns.some((t) => t.parts.some((p) => p.kind === "text" && p.text === "Parent answer") && t.parts.some((p) => p.kind === "text" && p.text === "Follow-up"))).toBe(false);
  });
  it("keeps a malformed custom record's text without forwarding unknown data", () => {
    const turns = parseOmpTranscript(jsonl(entry({ status: "future-status", result: "Original result", nested: { secret: "hidden" } })));
    expect(turns[0]?.parts).toEqual([{ kind: "notice", source: "subagents:record", text: "Original result" }]);
    expect(JSON.stringify(turns)).not.toContain("hidden");
  });
  it("preserves failure reasons alongside empty or partial output, including fallbacks", () => {
    for (const result of ["", "Partial findings"]) {
      expect(piDelegationRecords(entry({ status: "error", result, error: "401 Unauthorized" }))?.[0]?.result)
        .toBe(result ? `Error: 401 Unauthorized\n\n${result}` : "Error: 401 Unauthorized");
      const fallback = parseOmpTranscript(jsonl(entry({ status: "future-status", result, error: "401 Unauthorized" })));
      expect(JSON.stringify(fallback)).toContain("401 Unauthorized");
      if (result) expect(JSON.stringify(fallback)).toContain(result);
    }
    expect(piDelegationRecords({ type: "custom_message", customType: "subagent-notification", details: {
      id: "a1", status: "error", resultPreview: "Partial findings", error: "Failure",
    } })?.[0]?.result).toBe("Error: Failure\n\nPartial findings");
  });
  it("does not reveal display:false notifications or their structured details", () => {
    const turns = parseOmpTranscript(jsonl({ type: "custom_message", customType: "subagent-notification", display: false,
      content: "Hidden notification", details: { id: "a1", status: "completed", resultPreview: "Hidden result" },
    }));
    expect(turns).toEqual([]);
  });
  it("keeps completion deduplication across an unrelated agent launch", () => {
    const turns = parseOmpTranscript(jsonl(entry({}),
      message("assistant", [{ type: "toolCall", id: "c2", name: "Agent", arguments: { prompt: "Other work" } }]),
      message("toolResult", [{ type: "text", text: "Launched B" }], { toolCallId: "c2", details: { ...details, agentId: "b2" } }),
      { type: "custom_message", customType: "subagent-notification", details: { id: "a1", status: "completed", resultPreview: "Found it" } },
    ));
    expect(turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "delegation")).toHaveLength(1);
  });
  it("invalidates only the resumed agent's old preview, including a resolved handle", () => {
    for (const resume of ["a1", "reviewer"]) {
      const turns = parseOmpTranscript(jsonl(entry({}), entry({ id: "b2" }),
        message("assistant", [{ type: "toolCall", id: "c2", name: "Agent", arguments: { resume, prompt: "Continue" } }]),
        message("toolResult", [{ type: "text", text: "Resumed A" }], { toolCallId: "c2", details }),
        { type: "custom_message", customType: "subagent-notification", details: { id: "a1", status: "completed", resultPreview: "Found it" } },
        { type: "custom_message", customType: "subagent-notification", details: { id: "b2", status: "completed", resultPreview: "Found it" } },
      ));
      const tasks = turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "delegation" ? part.tasks : []));
      expect(tasks.filter((task) => task.id === "a1")).toHaveLength(2);
      expect(tasks.filter((task) => task.id === "b2")).toHaveLength(1);
    }
  });
  it("leaves malformed notifications visible as ordinary notices", () => {
    expect(parseOmpTranscript(jsonl({ type: "custom_message", customType: "subagent-notification", content: "Unknown extension output", details: { odd: true } }))[0]?.parts).toEqual([{ kind: "notice", source: "subagent-notification", text: "Unknown extension output" }]);
  });
});
