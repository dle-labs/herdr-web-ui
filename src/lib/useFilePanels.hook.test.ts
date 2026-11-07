import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/protocol.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

const machines = [{ id: "local", snapshot: { panes: [
  { pane_id: "p1", cwd: "/one", foreground_cwd: "/one/project" },
  { pane_id: "p2", cwd: "/two" },
] } }, { id: "remote", snapshot: { panes: [{ pane_id: "p1", cwd: "/remote" }] } }] as unknown as Machine[];
let renderer: ReactTestRenderer | undefined;
let hook: ReturnType<typeof useFilePanels>;
let dirty = false;
let mutation: (() => void) | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
function Probe({ machine = "local", pane = "p1" }: { machine?: string; pane?: string | null }) {
  hook = useFilePanels({ machines, settings: DEFAULT_SETTINGS, filePanelAvailable: true, selectedMachineId: machine, selectedPaneId: pane });
  return null;
}
beforeEach(() => {
  dirty = false; mutation = undefined;
  for (const key of ["window", "document", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  const history = { state: {}, replaceState(state: object) { this.state = state; }, pushState(state: object) { this.state = state; } };
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { history, location: { href: "http://fixture/" }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) } });
  const field = { scrollIntoView() {}, focus() {}, closest() { return null; } };
  const surface = { querySelector: () => dirty ? field : null, ownerDocument: { querySelector: () => null } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => surface } });
  Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {}
    disconnect() { mutation = undefined; }
  } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});
async function open() {
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => hook.openFilesFor("p1", "local", "browse"));
}
it("follows the selected pane's folder and remote PC while Files stays open", async () => {
  await open();
  expect(hook.filesTarget?.start).toBe("/one/project");
  await act(async () => renderer!.update(createElement(Probe, { pane: "p2" })));
  expect(hook.filesOpen).toBe(true);
  expect(hook.filesTarget).toEqual({ machineId: "local", paneId: "p2", start: "/two" });
  await act(async () => renderer!.update(createElement(Probe, { machine: "remote", pane: "p1" })));
  expect(hook.filesTarget).toEqual({ machineId: "remote", paneId: "p1", start: "/remote" });
});
it("keeps an unsaved editor until it is saved or discarded, then follows the latest selection", async () => {
  await open(); dirty = true;
  await act(async () => renderer!.update(createElement(Probe, { pane: "p2" })));
  expect(hook.filesTarget?.paneId).toBe("p1");
  await act(async () => renderer!.update(createElement(Probe, { machine: "remote", pane: "p1" })));
  dirty = false;
  await act(async () => mutation?.());
  expect(hook.filesTarget).toEqual({ machineId: "remote", paneId: "p1", start: "/remote" });
});
it("keeps an explicit file preview owned by its opening pane", async () => {
  await open();
  await act(async () => hook.viewFile("/one/project/readme.md"));
  await act(async () => renderer!.update(createElement(Probe, { pane: "p2" })));
  expect(hook.viewing).toMatchObject({ paneId: "p1", machineId: "local", path: "/one/project/readme.md" });
});
it("keeps a diff-comment preview owned by its pane, even when opened from another selection", async () => {
  await open();
  await act(async () => renderer!.update(createElement(Probe, { pane: "p2" })));
  const comment = { id: "comment-p1", diff: { repository: "/one/project" } } as Parameters<typeof hook.viewFileComment>[2];
  await act(async () => hook.viewFileComment("p1", "local", comment));
  expect(hook.diffCommentView?.comment.id).toBe("comment-p1");
  expect(hook.filesTarget?.paneId).toBe("p1");
  await act(async () => renderer!.update(createElement(Probe, { machine: "remote", pane: "p1" })));
  expect(hook.diffCommentView?.comment.id).toBe("comment-p1");
  expect(hook.filesTarget?.machineId).toBe("local");
});
