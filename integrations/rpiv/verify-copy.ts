/** Explicit opt-in verification ONLY: bun integrations/rpiv/verify-copy.ts /path/to/disposable/patched/package
 * Does not apply patches, write package files, load an extension factory or start Pi.
 */
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { answerRpiv, validRpivSnapshot } from "../../server/rpiv-bridge.ts";
import { processIdentity, type BridgeSnapshot } from "../../server/rpiv-runtime.ts";

assert.equal(process.platform, "linux", "This opt-in bridge supports Linux only");
const root = realpathSync(process.argv[2] ?? "");
assert(!root.includes("/node_modules/"), "Use a disposable package COPY outside installed node_modules");
assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2.12.0");
const require = createRequire(join(root, "package.json"));
const { KeybindingsManager, TUI_KEYBINDINGS } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const { QuestionnaireSession } = await import(pathToFileURL(join(root, "state/questionnaire-session.ts")).href);
const execute = readFileSync(join(root, "ask-user-question.ts"), "utf8");
assert(execute.includes("bridge.close();") && execute.includes("config.bridge.mount(() => session.bridgeSnapshot())"));

for (const multi of [false, true]) {
  const kb = new KeybindingsManager(TUI_KEYBINDINGS);
  let input = "", notes = "";
  let completed = false;
  const questions = [{ question: "Which store?", header: "Store", multiSelect: multi, options: [{ label: "Memory", description: "Local" }, { label: "Redis", description: "Remote" }] }];
  const rows = [{ kind: "option", label: "Memory" }, { kind: "option", label: "Redis" }, { kind: "other", label: "Type something." }, ...(multi ? [{ kind: "next", label: "Submit" }] : [])];
  // Exercise the patched real controller/router/reducer; only rendering and editor cells are fixture adapters.
  const controller = Object.create(QuestionnaireSession.prototype);
  Object.assign(controller, {
    state: { currentTab: 0, optionIndex: 0, inputMode: false, notesVisible: false, answers: new Map(), multiSelectChecked: new Set(), customDraftsByTab: new Map(), notesByTab: new Map(), submitChoiceIndex: 0, notesDraft: "", collapsed: false },
    questions, isMulti: false, itemsByTab: [rows], keybindings: kb, collapseKey: "ctrl+]", canReopenWhileHidden: true,
    inputEditorOpen: false, bridgeEnded: false,
    overlayHandle: { isFocused: () => true, isHidden: () => false },
    inlineInput: { getCursor: () => ({ line: 0, col: input.length }), getLines: () => [input], getText: () => input, setText: (text: string) => { input = text; }, handleInput: (text: string) => { input += text; } },
    notesInput: { getText: () => notes, setText: (text: string) => { notes = text; } }, viewAdapter: { apply() {} }, done() { completed = true; },
  });
  const snapshot = (): BridgeSnapshot => ({ schema: 1, version: "2.12.0", session: "/fixture/session.jsonl", pid: process.pid, process: processIdentity(process.pid)!, request: "11111111-1111-1111-1111-111111111111", toolCall: "copy-test", updated: Date.now(), revision, closed: false, view: controller.bridgeSnapshot() });
  let revision = 1;
  assert(validRpivSnapshot(snapshot(), "/fixture/session.jsonl", [process.pid]));
  assert.equal(snapshot().view!.actions.enter.kind, multi ? "toggle" : "confirm");
  kb.setUserBindings({ "tui.select.confirm": "ctrl+enter", "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" });
  assert.equal(snapshot().view!.actions.enter.kind, "ignore");
  kb.setUserBindings({});
  const { RPIV_KEYS } = await import(pathToFileURL(join(root, "herdr-bridge.ts")).href);
  const send = async (answer: object) => answerRpiv(snapshot(), answer, {
    alive: () => true, sent() {},
    async read() { const s = snapshot(); return { snapshot: s, screen: ["─".repeat(100), s.view!.question, ...rows.map((r, i) => `${i === s.view!.cursor ? "❯ " : "  "}${i + 1}. ${multi && i < questions[0].options.length ? `[${s.view!.checked.includes(i) ? "✔" : " "}] ` : ""}${r.label}`), "─".repeat(100), "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"].join("\n") }; },
    async key(key) { controller.dispatch(RPIV_KEYS[key]); revision++; },
    async text(text) { controller.dispatch(text); revision++; },
  });
  assert(await send(multi ? { option_indices: [1] } : { option_index: 1 }));
  assert(completed);
  assert.equal(controller.state.answers.get(0)?.[multi ? "selected" : "answer"]?.toString(), "Redis");

  completed = false; controller.bridgeEnded = false; controller.state.optionIndex = 0; controller.state.inputMode = false;
  assert(await send({ custom_text: "Custom answer" }));
  assert(completed); assert.equal(controller.state.answers.get(0).answer, "Custom answer");
  if (multi) {
    completed = false; controller.bridgeEnded = false; controller.state.optionIndex = 0; controller.state.inputMode = false;
    assert(await send({ option_indices: [] }));
    assert(completed); assert.deepEqual(controller.state.answers.get(0).selected, []);
  }

  // Real multi-question reducer transitions: each WebUI action answers only its
  // current question. The last answer opens review, never submits the whole form.
  questions.push({ ...questions[0], question: "Which backup store?", header: "Backup" });
  controller.isMulti = true;
  if (multi) rows.at(-1)!.label = "Next";
  controller.itemsByTab = [rows, rows];
  controller.state = { ...controller.state, currentTab: 0, optionIndex: 0, inputMode: false,
    answers: new Map(), multiSelectChecked: new Set(), customDraftsByTab: new Map() };
  completed = false; controller.bridgeEnded = false; input = "";
  assert(await send(multi ? { option_indices: [1] } : { option_index: 1 }));
  assert.equal(controller.state.currentTab, 1);
  assert.equal(completed, false, "advancing one question does not finish the questionnaire");
  assert(await send(multi ? { option_indices: [0] } : { option_index: 0 }));
  assert.equal(controller.state.currentTab, 2);
  assert.equal(completed, false, "the final answer stops at review without submitting");
  assert.equal(validRpivSnapshot(snapshot(), "/fixture/session.jsonl", [process.pid]), false, "review remains terminal-only");
}
console.log("Patched RPIV 2.12.0 controller/router/reducer: single, multi, custom, multi-question review and live remapping verified.");
