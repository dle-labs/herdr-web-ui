import { describe, expect, test } from "bun:test";
import type { GitChangesResponse } from "../../shared/protocol.ts";
import { WorkspaceChangesStore, type WorkspaceChangesTarget } from "./workspaceChanges.ts";

const target: WorkspaceChangesTarget = { machineId: "local", paneId: "pane", cwd: "/repo" };
const inventory = (changed: boolean, root = "/repo"): GitChangesResponse => ({ root, revision: "snapshot", files: changed ? [{ path: "file.ts", status: "modified" }] : [] });

describe("workspace changes indicator", () => {
  test("deduplicates menu/shortcut reads and uses a bounded event-read cache", async () => {
    let now = 0, reads = 0;
    const store = new WorkspaceChangesStore(() => now);
    const read = async () => { reads++; return inventory(true); };
    expect(store.get(target)).toBeNull();
    const first = store.load(target, read);
    expect(store.load(target, read, true)).toBe(first);
    await first;
    expect(store.get(target)).toBe(true);
    await store.load(target, read);
    expect(reads).toBe(1);
    now = 30_000;
    await store.load(target, read);
    expect(reads).toBe(2);
    await store.load(target, async () => inventory(false), true);
    expect(store.get(target)).toBe(false);
  });
  test("machine, pane and cwd ownership stay independent", async () => {
    const store = new WorkspaceChangesStore();
    await store.load(target, async () => inventory(true));
    for (const other of [{ ...target, machineId: "remote" }, { ...target, paneId: "other" }, { ...target, cwd: "/other" }]) {
      expect(store.get(other)).toBeNull();
      await store.load(other, async () => inventory(false, "/other"));
      expect(store.get(target)).toBe(true);
      expect(store.get(other)).toBe(false);
    }
  });
  test("ordinary browser inventories update both controls, superseding older requests", async () => {
    const store = new WorkspaceChangesStore();
    let resolve!: (value: GitChangesResponse) => void;
    const pending = store.load(target, () => new Promise((done) => { resolve = done; }));
    await Promise.resolve();
    store.publish(target, inventory(true));
    resolve(inventory(false));
    await pending;
    expect(store.get(target)).toBe(true);
    store.publish(target, inventory(false));
    expect(store.get(target)).toBe(false);
  });
  test("publishes to the same pane/repository but not another machine or repository", async () => {
    const store = new WorkspaceChangesStore();
    const child = { ...target, cwd: "/repo/src" };
    const other = { ...target, cwd: "/other" };
    const remote = { ...target, machineId: "remote" };
    await store.load(child, async () => inventory(false));
    await store.load(other, async () => inventory(false, "/other"));
    await store.load(remote, async () => inventory(false));
    store.publish(target, inventory(true));
    expect(store.get(child)).toBe(true);
    expect(store.get(other)).toBe(false);
    expect(store.get(remote)).toBe(false);
  });
  test("failed reads stay unknown, are backoff-cached, and can recover on an explicit refresh", async () => {
    const store = new WorkspaceChangesStore(() => 0);
    let reads = 0;
    const fail = async (): Promise<GitChangesResponse> => { reads++; throw new Error("not a repository"); };
    await store.load(target, fail);
    expect(store.get(target)).toBeNull();
    await store.load(target, fail);
    expect(reads).toBe(1);
    await store.load(target, async () => inventory(true), true);
    expect(store.get(target)).toBe(true);
  });
});
