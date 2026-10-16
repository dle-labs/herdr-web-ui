import type { GitChangesResponse } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";

export interface WorkspaceChangesTarget { machineId: string; paneId: string; cwd: string }
interface Entry {
  target: WorkspaceChangesTarget; changed: boolean | null; root: string | null;
  checkedAt: number | null; version: number; pending: Promise<void> | null;
}
const FRESH_MS = 30_000;
const MAX_ENTRIES = 128;
export const workspaceChangesKey = (target: WorkspaceChangesTarget) => JSON.stringify([paneStorageId(target.machineId, target.paneId), target.cwd]);

/** Read-only HEAD→working-tree snapshots shared by the shortcut, menu and browser.
 * No interval or persistence: visible consumers request reads on meaningful events. */
export class WorkspaceChangesStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  constructor(private now: () => number = Date.now) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get(target: WorkspaceChangesTarget | null): boolean | null {
    return target === null ? null : this.entries.get(workspaceChangesKey(target))?.changed ?? null;
  }
  private notify() { for (const listener of this.listeners) listener(); }
  private entry(target: WorkspaceChangesTarget): Entry {
    const key = workspaceChangesKey(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { target: { ...target }, changed: null, root: null, checkedAt: null, version: 0, pending: null };
      this.entries.set(key, entry);
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    }
    return entry;
  }
  load(target: WorkspaceChangesTarget, read: () => Promise<GitChangesResponse>, force = false): Promise<void> {
    const key = workspaceChangesKey(target);
    const entry = this.entry(target);
    if (entry.pending) return entry.pending;
    if (!force && entry.checkedAt !== null && this.now() - entry.checkedAt < FRESH_MS) return Promise.resolve();
    const version = ++entry.version;
    const current = () => this.entries.get(key) === entry && entry.version === version;
    const pending: Promise<void> = Promise.resolve().then(read).then((inventory) => {
      if (!current()) return;
      entry.changed = inventory.files.length > 0;
      entry.root = inventory.root;
      entry.checkedAt = this.now();
      this.notify();
    }).catch(() => {
      if (!current()) return;
      entry.changed = null;
      entry.checkedAt = this.now();
      this.notify();
    }).finally(() => { if (entry.pending === pending) entry.pending = null; });
    entry.pending = pending;
    return pending;
  }
  /** Publish only an ordinary working-tree inventory, never a historical comparison. */
  publish(target: WorkspaceChangesTarget, inventory: GitChangesResponse): void {
    const own = this.entry(target);
    const owner = paneStorageId(target.machineId, target.paneId);
    for (const entry of this.entries.values()) {
      if (paneStorageId(entry.target.machineId, entry.target.paneId) !== owner) continue;
      if (entry !== own && entry.root !== inventory.root) continue;
      entry.version++;
      entry.changed = inventory.files.length > 0;
      entry.root = inventory.root;
      entry.checkedAt = this.now();
    }
    this.notify();
  }
}
export const workspaceChanges = new WorkspaceChangesStore();
