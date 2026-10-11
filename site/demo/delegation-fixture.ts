import type { ConversationTurn, DelegationEvidence } from "../../shared/protocol.ts";

/** Fictional, bounded evidence for the demo and browser regression; never server imports. */
const task: DelegationEvidence = {
  id: "review-demo", type: "agent", name: "Review retry handling", agent: "reviewer", model: "demo-model",
  status: "background", evidence: "tool", duration_ms: null, result: "",
};
export const PI_DELEGATION_TURNS: ConversationTurn[] = [
  { role: "assistant", ts: "2026-09-25T09:23:00Z", end_ts: "2026-09-25T09:23:05Z", parts: [
    { kind: "tool", name: "Agent", summary: "Review retry handling", input: '{"subagent_type":"reviewer","prompt":"Review retries"}', output: "Original delegation launch output", delegation: task },
    { kind: "tool", name: "SubagentWorkflow", summary: "Retry audit", input: '{"name":"Retry audit"}', output: "Workflow launched: wf-demo", delegation: { ...task, id: "wf-demo", type: "workflow", name: "Retry audit", status: null, agent: null, model: null } },
    { kind: "text", text: "The review was delegated. My turn ending is not evidence that the review ended." },
  ] },
  { role: "user", ts: "2026-09-25T09:24:00Z", parts: [{ kind: "delegation", tasks: [
    { ...task, status: "stopped", evidence: "record", duration_ms: 42_000, result: "Partial review: the transport retry test is covered. The reviewer was stopped before checking the README." },
    { ...task, id: null, type: "workflow", name: "Retry audit", agent: null, model: null, status: "failed", evidence: "workflow", duration_ms: 43_000, result: "" },
  ] }] },
  { role: "assistant", ts: "2026-09-25T09:24:05Z", end_ts: "2026-09-25T09:24:07Z", parts: [
    { kind: "tool", name: "steer_subagent", summary: "Focus docs review", input: '{"agent_id":"docs-demo","message":"Check the environment table"}', output: "Steering message sent to agent docs-demo. The agent will process it after its current tool execution.", delegation: { ...task, id: "docs-demo", name: "Docs review", status: "steered", result: "", evidence: "tool" } },
    { kind: "text", text: "The separate docs reviewer received a steering message; its final outcome is not recorded here." },
  ] },
];
