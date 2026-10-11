/** Opt-in companion for @juicesharp/rpiv-ask-user-question 2.12.0.
 * MIT; attribution and installation: integrations/rpiv/README.md in herdr-web-ui.
 * Standalone so the same file can be copied into the opt-in package, while native
 * bridge bundles already include it under server/ without new packaging rules.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const RPIV_VERSION = "2.12.0";
export const RPIV_TTL = 1500;
export const RPIV_MAX_BYTES = 64_000;
export const RPIV_KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", space: " ", "ctrl+u": "\x15", esc: "\x1b" } as const;
export type BridgeAction = { kind: string; nextIndex?: number };
export interface BridgeView {
  mounted: boolean; focused: boolean; hidden: boolean; externalEditor: boolean;
  tab: number; count: number; cursor: number; inputMode: boolean; notes: boolean; collapsed: boolean;
  question: string; header: string; multi: boolean;
  options: { label: string; description: string; preview?: string }[];
  rows: { kind: string; label: string }[]; checked: number[]; input: string;
  actions: Record<string, BridgeAction>;
}
export interface BridgeSnapshot {
  schema: 1; version: string; session: string; pid: number; process: string;
  request: string; toolCall: string; updated: number; revision: number; closed: boolean; view: BridgeView | null;
}
export function processIdentity(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || !/^\d+$/.test(fields[19] ?? "")) return null;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch { return null; }
}
export function canonicalSession(file: string): string {
  // Session files can be absent before Pi's first answer; the existing parent is canonical.
  return join(realpathSync(dirname(file)), basename(file));
}
export function companionPath(session: string): string {
  return join(dirname(session), ".herdr-rpiv", `${createHash("sha256").update(session).digest("hex")}.json`);
}
export function privateDirectory(path: string): boolean {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o700; } catch { return false; }
}
/** No transcript append, no input transport. Failure disables telemetry, never the questionnaire. */
export function createBridge(sessionFile: string | undefined, toolCall: string) {
  let path: string | null = null;
  let snapshot: BridgeSnapshot | null = null;
  let getter: (() => BridgeView) | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let previous = "";
  try {
    const identity = processIdentity(process.pid);
    if (sessionFile && identity) {
      const session = canonicalSession(sessionFile);
      path = companionPath(session);
      mkdirSync(dirname(path), { mode: 0o700 });
      snapshot = { schema: 1, version: RPIV_VERSION, session, pid: process.pid, process: identity, request: randomUUID(), toolCall, updated: 0, revision: 0, closed: false, view: null };
    }
  } catch (error) {
    // An already created private directory is expected; initialize below on EEXIST.
    if ((error as { code?: string }).code === "EEXIST" && sessionFile && path && privateDirectory(dirname(path))) {
      const identity = processIdentity(process.pid);
      if (identity) snapshot = { schema: 1, version: RPIV_VERSION, session: canonicalSession(sessionFile), pid: process.pid, process: identity, request: randomUUID(), toolCall, updated: 0, revision: 0, closed: false, view: null };
    }
  }
  const publish = (heartbeat = false) => {
    if (!snapshot || !path || !privateDirectory(dirname(path))) return;
    try {
      if (!snapshot.closed) snapshot.view = getter?.() ?? null;
      const state = JSON.stringify(snapshot.view);
      if (state === previous && !heartbeat && !snapshot.closed) return;
      if (state !== previous) { snapshot.revision++; previous = state; }
      snapshot.updated = Date.now();
      let data = JSON.stringify(snapshot);
      if (Buffer.byteLength(data) > RPIV_MAX_BYTES) { snapshot.view = null; data = JSON.stringify(snapshot); }
      if (Buffer.byteLength(data) > RPIV_MAX_BYTES) return;
      const temporary = `${path}.${process.pid}.${snapshot.request}.tmp`;
      writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch { /* unreadable/oversized state never grants control */ }
  };
  return {
    mount(read: () => BridgeView) { getter = read; publish(); timer = setInterval(() => publish(true), 400); timer.unref?.(); },
    publish: () => publish(),
    close() { if (timer) clearInterval(timer); if (snapshot) { snapshot.closed = true; snapshot.view = null; publish(); } getter = null; },
  };
}
