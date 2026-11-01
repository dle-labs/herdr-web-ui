import { describe, expect, test } from "bun:test";
import { submitRoute } from "./submit-route.ts";

describe("submitRoute", () => {
  test("a plain message falls back to typing when no agent takes it", () => {
    expect(submitRoute("agent_not_found", false, false)).toBe("type");
    expect(submitRoute("agent_not_ready", false, false)).toBe("type");
    expect(submitRoute("agent_blocked", true, false)).toBe("type");
  });
  test("other refusals are passed on", () => {
    expect(submitRoute("agent_blocked", false, false)).toBe("rethrow");
    expect(submitRoute("agent_blocked", false, true)).toBe("rethrow");
    expect(submitRoute("read_only", false, true)).toBe("rethrow");
  });
  test("an agent-only message is never typed, and its refusal names the pane's condition", () => {
    expect(submitRoute("agent_not_found", false, true)).toEqual({ refuse: { code: "agent_not_found", message: expect.stringContaining("nothing was typed") } });
    expect(submitRoute("agent_not_ready", false, true)).toEqual({ refuse: { code: "agent_not_ready", message: expect.stringContaining("nothing was typed") } });
    expect(submitRoute("agent_blocked", true, true)).toEqual({ refuse: { code: "agent_queue_busy", message: expect.stringContaining("nothing was typed") } });
    // a Codex busy with its queue is refused for that, whatever agent.prompt answered
    expect(submitRoute("agent_not_ready", true, true)).toMatchObject({ refuse: { code: "agent_queue_busy" } });
  });
});
