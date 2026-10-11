import type { DelegationEvidence } from "../shared/protocol.ts";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const str = (v: unknown, max = 240): string | null => typeof v === "string" && v.trim() ? v.slice(0, max) : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
const statuses = new Set(["queued", "running", "completed", "steered", "aborted", "stopped", "error", "background", "failed", "killed", "paused"]);
const status = (v: unknown): string | null => typeof v === "string" && statuses.has(v) ? v : null;
const tools = new Set(["Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"]);
const resultLimit = 16_000;
function resultText(d: Row): string {
  const output = str(d.result, resultLimit + 1) ?? str(d.resultPreview, resultLimit + 1);
  const error = str(d.error, resultLimit + 1);
  // A failed run may have empty or partial output as well as its failure reason.
  // Preserve both explicitly, before applying the common result bound.
  return [error ? `Error: ${error}` : null, output].filter(Boolean).join("\n\n").slice(0, resultLimit + 1);
}
function evidence(d: Row, source: DelegationEvidence["evidence"], workflow = false): DelegationEvidence {
  const result = resultText(d);
  const start = num(d.startedAt ?? d.startTime), end = num(d.completedAt ?? d.endTime);
  return {
    id: str(d.agentId ?? d.id ?? d.taskId), type: workflow ? "workflow" : "agent",
    name: str(d.description ?? d.displayName ?? d.name) ?? str(d.agentId ?? d.id ?? d.taskId) ?? (workflow ? "SubagentWorkflow" : "Agent"),
    agent: str(d.subagentType ?? d.type), model: str(d.modelName), status: status(d.status), evidence: source,
    duration_ms: num(d.durationMs) ?? (start !== null && end !== null && end >= start ? end - start : null),
    result: result.slice(0, resultLimit), ...(result.length > resultLimit ? { result_cut: true } : {}),
  };
}

/** Exact extension names and selected scalar fields only; no paths, journal reads or token estimates. */
export function piToolDelegation(name: string, details: unknown, text = ""): DelegationEvidence | undefined {
  if (!tools.has(name)) return undefined;
  const d = row(details);
  if (name === "SubagentWorkflow") return str(d.taskId) ? evidence(d, "tool", true) : undefined;
  if (name === "get_subagent_result") {
    // 0.20.0 persists text only for this tool. Require its whole header, never search prose.
    const match = /^Agent: ([^\n]{1,240})\nType: ([^|\n]{1,240}) \| Status: ([a-z]+)[^\n]{0,1000}\nDescription: ([^\n]{1,240})\n\n/.exec(text.slice(0, 2000));
    if (!match || status(match[3]) === null) return undefined;
    return evidence({ id: match[1], type: match[2], status: match[3], description: match[4], result: text.slice(match[0].length) }, "tool");
  }
  if (name === "steer_subagent") {
    const match = /^Steering message (sent to|queued for) agent ([^\n.]{1,240})\. (?:The agent will process it after its current tool execution\.|It will be delivered once the session initializes\.)/.exec(text.slice(0, 600));
    if (!match) return undefined;
    return { ...evidence({ id: match[2], status: "steered", result: text }, "tool"), status: match[1] === "queued for" ? "steer_queued" : "steered" };
  }
  // AgentDetails: unknown or malformed shapes stay generic.
  if (!str(d.displayName) || !str(d.subagentType) || status(d.status) === null) return undefined;
  return evidence(d, "tool");
}

export function piDelegationRecords(value: unknown): DelegationEvidence[] | null {
  const entry = row(value);
  if (entry.type === "custom_message" && entry.customType === "subagent-notification") {
    if (entry.display === false) return null;
    const d = row(entry.details);
    const tasks = [d, ...(Array.isArray(d.others) ? d.others.slice(0, 31).map(row) : [])]
      .filter((item) => str(item.id) && status(item.status) !== null)
      // 0.20.0's workflow completion uses the same notification channel, but
      // src/workflow/task.ts reserves wf_ + twelve hex digits for its task IDs.
      .map((item) => evidence(item, "notification", typeof item.id === "string" && /^wf_[a-f0-9]{12}$/.test(item.id)));
    return tasks.length ? tasks : null;
  }
  if (entry.type !== "custom") return null;
  const d = row(entry.data);
  if (entry.customType === "subagents:record" && str(d.id) && status(d.status) !== null) return [evidence(d, "record")];
  if (entry.customType === "subagents:workflow" && str(d.name) && status(d.status) !== null && num(d.startTime) !== null) return [evidence(d, "workflow", true)];
  return null;
}

/** Known custom records with a future/malformed shape still have a plain, bounded fallback.
 * Only explicit text fields are retained, never a JSON dump of arbitrary extension details. */
export function piDelegationFallback(value: unknown): { kind: "notice"; source: string; text: string } | null {
  const entry = row(value);
  if (entry.type !== "custom" || (entry.customType !== "subagents:record" && entry.customType !== "subagents:workflow")) return null;
  const d = row(entry.data);
  return { kind: "notice", source: entry.customType, text: resultText(d).slice(0, resultLimit) || str(d.description ?? d.name, resultLimit) || entry.customType };
}

/** Only identical persisted runs, or the notification preview of the latest run, coalesce.
 * A resumed tool launch clears only its own preview identity; distinct resumed runs have distinct timestamps. */
export function freshPiDelegations(value: unknown, tasks: DelegationEvidence[], seen: Set<string>): DelegationEvidence[] {
  const entry = row(value), d = row(entry.data);
  return tasks.filter((task) => {
    const preview = `pi-preview:${task.id}:${task.status}:${task.result.slice(0, 299)}`;
    const run = [num(d.startedAt), num(d.completedAt), num(d.startTime), num(d.endTime)];
    const key = task.evidence === "record" || task.evidence === "workflow"
      ? `pi-record:${JSON.stringify([task, ...run, run.every((v) => v === null) ? str(entry.timestamp) : null])}`
      : `pi-notification:${JSON.stringify([task, str(entry.timestamp)])}`;
    // A notification lacks run timestamps. Consume the record's matching preview once;
    // do not merge a later mention/resume notification merely because its answer is identical.
    const fromRecord = task.evidence === "notification" && seen.delete(preview);
    const duplicate = seen.has(key) || fromRecord;
    seen.add(key);
    if (task.evidence === "record") seen.add(preview);
    // This is a per-page dedup book, not an unbounded runtime registry.
    while (seen.size > 512) seen.delete(seen.values().next().value!);
    return !duplicate;
  });
}
