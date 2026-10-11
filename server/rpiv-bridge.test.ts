import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { companionPath, createBridge, processIdentity, type BridgeSnapshot, type BridgeView } from "./rpiv-runtime.ts";
import { answerRpiv, rpivActionable, rpivPreview, validRpivSnapshot, type RpivIO } from "./rpiv-bridge.ts";

function fixture(multi = false): BridgeSnapshot {
  return { schema: 1, version: "2.12.0", session: "/fixture/session.jsonl", pid: process.pid, process: processIdentity(process.pid)!, request: "11111111-1111-1111-1111-111111111111", toolCall: "fixture-call", updated: Date.now(), revision: 1, closed: false,
    view: { mounted: true, focused: true, hidden: false, externalEditor: false, tab: 0, count: 1, cursor: 0, inputMode: false, notes: false, collapsed: false,
      question: "Which store?", header: "Store", multi, options: [{ label: "Memory", description: "Local" }, { label: "Redis", description: "Remote" }],
      rows: [{ kind: "option", label: "Memory" }, { kind: "option", label: "Redis" }, { kind: "other", label: "Type something." }, ...(multi ? [{ kind: "next", label: "Submit" }] : [])], checked: multi ? [0] : [], input: "", actions: {} } };
}
function routed(v: BridgeView) {
  v.actions = {
    up: { kind: "nav", nextIndex: (v.cursor + v.rows.length - 1) % v.rows.length }, down: { kind: "nav", nextIndex: (v.cursor + 1) % v.rows.length },
    enter: { kind: v.inputMode || !v.multi ? "confirm" : v.rows[v.cursor]?.kind === "next" ? "multi_confirm" : "toggle" },
    space: { kind: v.multi && !v.inputMode && v.rows[v.cursor]?.kind === "option" ? "toggle" : "ignore" }, "ctrl+u": { kind: v.inputMode ? "input_clear" : "ignore" }, esc: { kind: "cancel" },
  };
}
function screen(v: BridgeView): string {
  return ["─".repeat(100), v.header, v.question, ...v.rows.map((row, index) => `${index === v.cursor ? "❯ " : "  "}${index + 1}. ${v.multi && index < v.options.length ? `[${v.checked.includes(index) ? "✔" : " "}] ` : ""}${row.label}`), "─".repeat(100), "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"].join("\n");
}
function harness(multi = false) {
  const snapshot = fixture(multi); routed(snapshot.view!);
  const sent: string[] = [];
  let dead = false;
  const io: RpivIO = {
    async read() {
      const copy = structuredClone(snapshot);
      return { snapshot: validRpivSnapshot(copy, copy.session, [process.pid]) ? copy : null, screen: screen(snapshot.view!) };
    },
    async key(key) {
      sent.push(key);
      const v = snapshot.view!;
      if (key === "up" || key === "down") { v.cursor = v.actions[key]!.nextIndex!; v.inputMode = v.rows[v.cursor]!.kind === "other"; }
      if (key === "space") v.checked = v.checked.includes(v.cursor) ? v.checked.filter(n => n !== v.cursor) : [...v.checked, v.cursor].sort();
      if (key === "ctrl+u") v.input = "";
      snapshot.revision++; routed(v);
    },
    async text(text) { sent.push(`text:${text}`); snapshot.view!.input += text; snapshot.revision++; },
    alive: () => !dead, sent() {},
  };
  return { snapshot, sent, io, stop() { dead = true; } };
}

describe.skipIf(process.platform !== "linux")("RPIV live bridge", () => {
  test("single moved choice rechecks each cursor transition", async () => {
    const h = harness();
    expect(await answerRpiv(structuredClone(h.snapshot), { option_index: 1 }, h.io)).toBe(true);
    expect(h.sent).toEqual(["down", "enter"]);
  });
  test("checkbox changes use toggles then explicit sentinel confirmation", async () => {
    const h = harness(true);
    expect(await answerRpiv(structuredClone(h.snapshot), { option_indices: [1] }, h.io)).toBe(true);
    expect(h.sent).toEqual(["space", "down", "space", "down", "down", "enter"]);
    expect(h.snapshot.view!.checked).toEqual([1]);
  });
  test("preview text is literal and oversized previews cannot offer actions", () => {
    const h = harness(); h.snapshot.view!.options[0]!.preview = "<script>fiction</script>";
    expect(rpivPreview(h.snapshot.view!)).toBe("Memory\n<script>fiction</script>");
    expect(rpivActionable(h.snapshot)).toBe(true);
    h.snapshot.view!.options[0]!.preview = "x".repeat(12_000); expect(rpivActionable(h.snapshot)).toBe(false);
  });
  test("empty checkbox answer explicitly unchecks then confirms Next", async () => {
    const h = harness(true);
    expect(await answerRpiv(structuredClone(h.snapshot), { option_indices: [] }, h.io)).toBe(true);
    expect(h.sent).toEqual(["space", "down", "down", "down", "enter"]);
  });
  test("custom text enters by navigation, clears existing draft, verifies text before Enter", async () => {
    const h = harness(true); h.snapshot.view!.input = "old draft";
    expect(await answerRpiv(structuredClone(h.snapshot), { custom_text: "New answer" }, h.io)).toBe(true);
    expect(h.sent).toEqual(["down", "down", "ctrl+u", "text:New answer", "enter"]);
  });
  test("rejects newline/control injection and malformed answers without keys", async () => {
    for (const answer of [{ custom_text: "x\ny" }, { custom_text: "\x1b[A" }, { option_index: 20 }, { option_indices: [0, 0] }]) {
      const h = harness(); await expect(answerRpiv(h.snapshot, answer, h.io)).rejects.toThrow(); expect(h.sent).toEqual([]);
    }
  });
  test("remap, wrong screen, replaced request, concurrent cursor and disconnect abort", async () => {
    for (const mode of ["remap", "screen", "request", "cursor", "offline"]) {
      const h = harness(); const initial = structuredClone(h.snapshot);
      if (mode === "remap") h.snapshot.view!.actions.enter = { kind: "ignore" };
      if (mode === "request") h.snapshot.request = "22222222-2222-2222-2222-222222222222";
      if (mode === "cursor") h.snapshot.view!.cursor = 1;
      if (mode === "offline") h.stop();
      if (mode === "screen") h.io.read = async () => ({ snapshot: h.snapshot, screen: "ordinary shell" });
      expect(await answerRpiv(initial, { option_index: 1 }, h.io)).toBe(false); expect(h.sent).toEqual([]);
    }
  });
  test("uncertain delivery never retries; wrong toggle transition sends no confirmation", async () => {
    const h = harness(); h.io.key = async key => { h.sent.push(key); throw new Error("uncertain delivery"); };
    await expect(answerRpiv(h.snapshot, { option_index: 1 }, h.io)).rejects.toThrow("uncertain"); expect(h.sent).toEqual(["down"]);
    const m = harness(true); m.io.key = async key => { m.sent.push(key); m.snapshot.revision++; m.snapshot.view!.cursor = 1; };
    expect(await answerRpiv(structuredClone(m.snapshot), { option_indices: [1] }, m.io)).toBe(false); expect(m.sent).toEqual(["space"]);
  });
  test.each(["replacement", "hidden", "focus", "editor"])("stops after an intermediate write loses %s ownership", async mode => {
    for (const phase of ["move", "toggle", "text"]) {
      const h = harness(phase === "toggle");
      const initial = structuredClone(h.snapshot);
      const interrupt = () => {
        if (mode === "replacement") h.snapshot.request = "22222222-2222-2222-2222-222222222222";
        if (mode === "hidden") h.snapshot.view!.hidden = true;
        if (mode === "focus") h.snapshot.view!.focused = false;
        if (mode === "editor") h.snapshot.view!.externalEditor = true;
      };
      const key = h.io.key, text = h.io.text;
      h.io.key = async value => { await key(value); if ((phase === "move" && value === "down") || (phase === "toggle" && value === "space")) interrupt(); };
      h.io.text = async value => { await text(value); interrupt(); };
      const answer = phase === "move" ? { option_index: 1 } : phase === "toggle" ? { option_indices: [1] } : { custom_text: "New answer" };
      expect(await answerRpiv(initial, answer, h.io)).toBe(false);
      expect(h.sent).toEqual(phase === "move" ? ["down"] : phase === "toggle" ? ["space"] : ["down", "down", "text:New answer"]);
    }
  }, 10_000);
  test("fresh ownership rejects stale, closed, crash/restart, review, notes and unsupported bindings", () => {
    const s = fixture(); routed(s.view!);
    expect(validRpivSnapshot(s, s.session, [process.pid])).toBe(true);
    for (const changed of [{ updated: Date.now() - 2000 }, { closed: true }, { process: "previous process" }, { pid: 2147483647 }, { version: "2.13.0" }]) expect(validRpivSnapshot({ ...s, ...changed }, s.session, [process.pid])).toBe(false);
    expect(validRpivSnapshot(s, "/another/session.jsonl", [process.pid])).toBe(false);
    expect(validRpivSnapshot(s, s.session, [])).toBe(false);
    for (const change of [{ notes: true }, { tab: 1 }, { hidden: true }, { focused: false }, { externalEditor: true }]) expect(validRpivSnapshot({ ...s, view: { ...s.view, ...change } }, s.session, [process.pid])).toBe(false);
    s.view!.actions.enter = { kind: "ignore" }; expect(rpivActionable(s)).toBe(false);
  });
  test("private bounded companion closes without transcript bloat", () => {
    const dir = mkdtempSync(join(tmpdir(), "rpiv-fixture-"));
    try {
      const session = join(dir, "fiction.jsonl"); writeFileSync(session, "fictional session\n");
      const bridge = createBridge(session, "test-call"); const v = fixture().view!; routed(v);
      bridge.mount(() => v);
      const path = companionPath(session);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).closed).toBe(false);
      bridge.close(); bridge.publish(); // a late render cannot reopen the closed record
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ closed: true, view: null });
      expect(readFileSync(session, "utf8")).toBe("fictional session\n");
      const again = createBridge(session, "next-call"); again.mount(() => ({ ...v, input: "x".repeat(70_000) }));
      expect(JSON.parse(readFileSync(path, "utf8")).view).toBeNull(); expect(statSync(path).size).toBeLessThan(64_000);
      again.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
