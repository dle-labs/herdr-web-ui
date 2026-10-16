/** Why an agent-only message was refused, named for the pane's condition; nothing of it was typed. */
export type SubmitRefusal = { code: "agent_not_found" | "agent_not_ready" | "agent_queue_busy"; message: string };

/** What submitText does with a message agent.prompt refused: type it, pass the error on, or refuse it with its own reason. */
export type SubmitRoute = "type" | "rethrow" | { refuse: SubmitRefusal };

/**
 * Decides the fate of a message after agent.prompt failed with `code`.
 * `queuedOnly`: the agent is a Codex "blocked" only by questions waiting in its queue.
 * `agentOnly`: the message quotes the agent's reply and must never be typed into a pane's input.
 */
export function submitRoute(code: string, queuedOnly: boolean, agentOnly: boolean): SubmitRoute {
  const noAgent = code === "agent_not_found" || code === "agent_not_ready";
  if (!noAgent && !queuedOnly) return "rethrow";
  if (!agentOnly) return "type";
  // an agent-only message is not typed into a Codex busy with its queue either: the typed text would land among its questions
  if (queuedOnly) return { refuse: { code: "agent_queue_busy", message: "the agent is busy with questions it queued, and this message only goes to it directly; nothing was typed" } };
  // herdr's agent_not_ready: an agent may run there, but its input state is not known
  if (code === "agent_not_ready") return { refuse: { code: "agent_not_ready", message: "the agent is not ready for a message yet, and this message only goes to it directly; nothing was typed" } };
  return { refuse: { code: "agent_not_found", message: "no agent runs in this pane, and this message is only sent to one; nothing was typed" } };
}
