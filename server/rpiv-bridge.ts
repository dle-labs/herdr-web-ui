import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { companionPath, privateDirectory, processIdentity, RPIV_MAX_BYTES, RPIV_TTL, RPIV_VERSION, type BridgeSnapshot, type BridgeView } from "./rpiv-runtime.ts";
import { herdrRpc, paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";
import { piTranscriptPath } from "./pi.ts";
import { parseRpivQuestionnaire } from "./rpiv-questionnaire.ts";
import type { PromptAnswer } from "../shared/protocol.ts";

function ownedRpivSnapshot(value: unknown, session: string, pids: readonly number[], now = Date.now()): value is BridgeSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as BridgeSnapshot;
  if (s.schema !== 1 || s.version !== RPIV_VERSION || s.session !== session || s.closed !== false
    || !pids.includes(s.pid) || s.process !== processIdentity(s.pid) || !s.process
    || typeof s.request !== "string" || !/^[\w-]{20,80}$/.test(s.request)
    || typeof s.toolCall !== "string" || s.toolCall.length === 0 || s.toolCall.length > 500
    || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Number.isFinite(s.updated) || now < s.updated || now - s.updated > RPIV_TTL) return false;
  return true;
}

export function validRpivSnapshot(value: unknown, session: string, pids: readonly number[], now = Date.now()): value is BridgeSnapshot {
  if (!ownedRpivSnapshot(value, session, pids, now)) return false;
  const v = value.view;
  if (!v || v.mounted !== true || v.focused !== true || v.hidden !== false || v.externalEditor !== false || v.notes !== false || v.collapsed !== false
    || !Number.isInteger(v.tab) || !Number.isInteger(v.count) || v.count < 1 || v.count > 4 || v.tab < 0 || v.tab >= v.count
    || !Number.isInteger(v.cursor) || typeof v.inputMode !== "boolean" || typeof v.multi !== "boolean"
    || typeof v.question !== "string" || v.question.length > 8000 || typeof v.header !== "string" || v.header.length > 100
    || typeof v.input !== "string" || v.input.length > 8000
    || !Array.isArray(v.options) || v.options.length < 2 || v.options.length > 4
    || v.options.some(o => !o || typeof o.label !== "string" || o.label.length > 1000 || typeof o.description !== "string" || o.description.length > 8000 || (o.preview !== undefined && (typeof o.preview !== "string" || o.preview.length > 12_000)))
    || !Array.isArray(v.rows) || v.rows.length !== v.options.length + (v.multi ? 2 : 1)
    || v.rows.some((r, i) => !r || typeof r.label !== "string" || r.label.length > 1000 || (i < v.options.length && r.label !== v.options[i]!.label) || r.kind !== (i < v.options.length ? "option" : i === v.options.length ? "other" : "next"))
    || v.cursor < 0 || v.cursor >= v.rows.length || v.inputMode !== (v.rows[v.cursor]?.kind === "other")
    || !Array.isArray(v.checked) || v.checked.length > v.options.length || new Set(v.checked).size !== v.checked.length || v.checked.some(n => !Number.isInteger(n) || n < 0 || n >= v.options.length)
    || !v.actions || Object.values(v.actions).some(a => !a || typeof a.kind !== "string")) return false;
  return true;
}

export function isRpivPiProcess(argv: readonly string[]): boolean {
  const pi = /(?:^|\/)pi(?:\.[cm]?js)?$/;
  const cli = /\/(?:@earendil-works|@mariozechner)\/pi-coding-agent\/dist\/cli\.js$/;
  return pi.test(argv[0] ?? "") || ((/(?:^|\/)(?:node|bun)$/.test(argv[0] ?? "")) && (pi.test(argv[1] ?? "") || cli.test(argv[1] ?? "")));
}

/** The only path comes from Pi's pane-owned canonical store, never a descriptor/output path. */
export async function readRpivState(paneId: string): Promise<{ snapshot: BridgeSnapshot | null; present: boolean }> {
  const absent = { snapshot: null, present: false };
  if (process.platform !== "linux") return absent;
  const [session, info] = await Promise.all([
    piTranscriptPath(paneId),
    herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId }),
  ]);
  const file = session && ("path" in session ? session.path : session.unwritten.path);
  if (!file) return absent;
  const path = companionPath(file);
  if (!privateDirectory(dirname(path))) return absent;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > RPIV_MAX_BYTES) return absent;
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const pids = (info.process_info?.foreground_processes ?? []).filter(p => isRpivPiProcess(p.argv ?? [])).map(p => p.pid);
    return { snapshot: validRpivSnapshot(value, file, pids) ? value : null, present: ownedRpivSnapshot(value, file, pids) };
  } catch { return absent; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function readRpivSnapshot(paneId: string): Promise<BridgeSnapshot | null> {
  return (await readRpivState(paneId)).snapshot;
}

export function rpivScreenMatches(s: BridgeSnapshot, screen: string): boolean {
  const parsed = parseRpivQuestionnaire(screen);
  if (!parsed || parsed.state !== "question" || !s.view) return false;
  const normalize = (text: string) => text.replace(/\s+/g, "");
  const body = normalize(parsed.body);
  const lines = parsed.body.split("\n").map(line => line.trim());
  const cursors = lines.filter(line => line.startsWith("❯"));
  if (cursors.length !== 1) return false;
  const numbered = cursors[0]!.match(/^❯\s*(\d+)\./);
  const cursor = numbered ? Number(numbered[1]) - 1 : normalize(cursors[0]!.slice(1)) === normalize(s.view.rows.at(-1)?.label ?? "") ? s.view.rows.length - 1 : -1;
  if (cursor !== s.view.cursor) return false;
  if (s.view.multi) {
    const checks = new Map<number, boolean>();
    for (const line of lines) {
      const match = line.match(/^(?:❯\s*)?(\d+)\.\s+\[( |✔)\]/);
      if (match && Number(match[1]) <= s.view.options.length) {
        const index = Number(match[1]) - 1;
        if (checks.has(index)) return false;
        checks.set(index, match[2] === "✔");
      }
    }
    if (checks.size !== s.view.options.length || s.view.options.some((_, i) => checks.get(i) !== s.view!.checked.includes(i))) return false;
  }
  // Full question/option text and current cursor/checks must corroborate the snapshot.
  return body.includes(normalize(s.view.question)) && s.view.options.every(o => body.includes(normalize(o.label)));
}
export function rpivPreview(v: BridgeView): string {
  return v.options.filter(o => o.preview).map(o => `${o.label}\n${o.preview}`).join("\n\n");
}
export function rpivActionable(s: BridgeSnapshot): boolean {
  const v = s.view!;
  if (rpivPreview(v).length > 12_000) return false;
  const expected = v.inputMode ? "confirm" : v.multi ? (v.rows[v.cursor]?.kind === "next" ? "multi_confirm" : "toggle") : "confirm";
  return v.actions.enter?.kind === expected && v.actions.up?.kind === "nav" && v.actions.down?.kind === "nav";
}
const viewKey = (v: BridgeView) => JSON.stringify(v);
export interface RpivIO {
  read(): Promise<{ snapshot: BridgeSnapshot | null; screen: string }>;
  key(key: string): Promise<unknown>; text(text: string): Promise<unknown>;
  alive(): boolean; sent(): void;
}
export function rpivIO(paneId: string, alive: () => boolean, sent: () => void): RpivIO {
  return {
    async read() {
      const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
      // A slow screen read may span closing one form and opening an identical
      // successor. Read ownership last so the old request cannot authorize it.
      const snapshot = await readRpivSnapshot(paneId);
      return { snapshot, screen };
    },
    key: key => paneSendKeys(paneId, [key], undefined, alive), text: text => paneSendText(paneId, text, undefined, alive), alive, sent,
  };
}
export class RpivAnswerError extends Error {}
/** One transition at a time. Unknown delivery outcomes throw and never replay. */
export async function answerRpiv(initial: BridgeSnapshot, answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">, io: RpivIO): Promise<boolean> {
  let current = initial;
  const answerDeadline = Date.now() + 15_000;
  const initialView = initial.view!;
  const supplied = [answer.option_index, answer.option_indices, answer.custom_text].filter(x => x !== undefined).length;
  const custom = answer.custom_text;
  const choices = answer.option_indices ?? (answer.option_index === undefined ? [] : [answer.option_index]);
  if (supplied !== 1 || (custom !== undefined && (typeof custom !== "string" || !custom.trim() || custom.length > 4000 || /[\x00-\x1f\x7f]/.test(custom)))
    || !Array.isArray(choices) || choices.some(n => !Number.isInteger(n) || n < 0 || n >= initialView.options.length)
    || new Set(choices).size !== choices.length || (custom === undefined && !initialView.multi && choices.length !== 1)) throw new RpivAnswerError("Invalid questionnaire answer.");
  const content = (v: BridgeView) => JSON.stringify([v.question, v.header, v.count, v.multi, v.options, v.rows]);
  const sameRequest = (s: BridgeSnapshot) => s.request === initial.request && s.session === initial.session && s.process === initial.process && s.pid === initial.pid && s.view?.tab === initialView.tab && content(s.view) === content(initialView);
  const fresh = async () => {
    const left = Math.min(1800, answerDeadline - Date.now());
    if (!io.alive() || left <= 0) return null;
    const read = await Promise.race([io.read(), Bun.sleep(left).then(() => null)]);
    const s = read?.snapshot;
    // A slow screen read must not extend the lifetime of the snapshot read before it.
    return read && s && Date.now() <= answerDeadline && Date.now() >= s.updated && Date.now() - s.updated <= RPIV_TTL
      && processIdentity(s.pid) === s.process && sameRequest(s) && rpivScreenMatches(s, read.screen) && io.alive() ? s : null;
  };
  const check = async () => { const s = await fresh(); return !!s && viewKey(s.view!) === viewKey(current.view!); };
  const transition = async (key: string | null, kind: string, expected: (v: BridgeView) => boolean, text?: string): Promise<boolean> => {
    if (!(await check()) || (key !== null && current.view!.actions[key]?.kind !== kind)) return false;
    io.sent();
    if (key !== null) await io.key(key); else await io.text(text!);
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      const next = await fresh();
      if (Date.now() > deadline || !io.alive()) return false;
      if (!next) { await Bun.sleep(Math.min(40, Math.max(0, deadline - Date.now()))); continue; }
      if (next.revision > current.revision) {
        if (!expected(next.view!)) return false;
        current = next; return true;
      }
      await Bun.sleep(Math.min(40, Math.max(0, deadline - Date.now())));
    }
    return false;
  };
  const move = async (target: number) => {
    for (let steps = 0; current.view!.cursor !== target && steps < 8; steps++) {
      const v = current.view!;
      const key = target < v.cursor ? "up" : "down";
      const nextIndex = v.actions[key]?.nextIndex;
      const expected = { ...v, cursor: nextIndex, inputMode: v.rows[nextIndex ?? -1]?.kind === "other" };
      if (!(await transition(key, "nav", n => n.cursor === expected.cursor && n.inputMode === expected.inputMode && n.input === v.input && JSON.stringify(n.checked) === JSON.stringify(v.checked)))) return false;
    }
    return current.view!.cursor === target;
  };
  if (custom !== undefined) {
    if (!(await move(initialView.options.length))) return false;
    if (current.view!.input) {
      if (!(await transition("ctrl+u", "input_clear", v => v.input === "" && v.inputMode && v.cursor === current.view!.cursor && JSON.stringify(v.checked) === JSON.stringify(current.view!.checked)))) return false;
    }
    if (!(await transition(null, "", v => v.input === custom && v.inputMode && v.cursor === current.view!.cursor && JSON.stringify(v.checked) === JSON.stringify(current.view!.checked), custom))) return false;
  } else if (initialView.multi) {
    for (let index = 0; index < initialView.options.length; index++) {
      if (current.view!.checked.includes(index) === choices.includes(index)) continue;
      if (!(await move(index))) return false;
      const checked = new Set(current.view!.checked); checked.has(index) ? checked.delete(index) : checked.add(index);
      if (!(await transition("space", "toggle", v => v.cursor === index && !v.inputMode && v.input === current.view!.input && JSON.stringify(v.checked) === JSON.stringify([...checked].sort((a,b) => a-b))))) return false;
    }
    if (!(await move(initialView.options.length + 1))) return false;
  } else if (!(await move(choices[0]!))) return false;
  if (!(await check())) return false;
  const kind = custom !== undefined || !initialView.multi ? "confirm" : "multi_confirm";
  if (current.view!.actions.enter?.kind !== kind || !io.alive()) return false;
  io.sent(); await io.key("enter");
  // Confirmation can close the entire UI or advance to review (terminal-only). Never chain another question.
  return true;
}
