import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS, type Settings } from "./settings.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;

beforeEach(() => {
  for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const events = new EventTarget();
  let state: unknown = null;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: { get state() { return state; }, replaceState: (next: unknown) => { state = next; }, pushState: (next: unknown) => { state = next; } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  // no Files surface holds a changed comment or edit: leaving it is always allowed here
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null, querySelector: () => null } });
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

async function mount(settings: Partial<Settings>, filePanelAvailable: boolean): Promise<void> {
  function Probe() {
    panels = useFilePanels({ machines: [], settings: { ...DEFAULT_SETTINGS, ...settings }, filePanelAvailable, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { panels.setFilesOpen(true); });
}

it("shows the browser beside the pane, and a file opened from the chat in it, with Files beside the pane", async () => {
  // Given Files beside the pane on a wide window.
  await mount({ filesPanel: true }, true);
  expect(panels.filesDocked).toBe(true);
  expect(panels.browserDocked).toBe(true);

  // When a file opens from the chat, even with Open files in a popup.
  await act(async () => { panels.viewFile("src/app.ts"); });

  // Then the browser that shows it stays beside the pane.
  expect(panels.viewing?.path).toBe("src/app.ts");
  expect(panels.browserDocked).toBe(true);
});

it("docks the browser for a text file with Open files beside the pane, and keeps Files itself a dialog", async () => {
  // Given Open files beside the pane, with Files beside the pane off.
  await mount({ fileOpen: "panel" }, true);
  expect(panels.filesDocked).toBe(false);
  expect(panels.browserDocked).toBe(false);

  // When a text file opens.
  await act(async () => { panels.viewFile("src/app.ts"); });

  // Then the browser opens on it beside the pane.
  expect(panels.browserDocked).toBe(true);
});

it("opens a file in the dialog by default", async () => {
  await mount({}, true);
  await act(async () => { panels.viewFile("src/app.ts"); });
  expect(panels.browserDocked).toBe(false);
});

it("closes Files beside the pane when the window narrows under a web page that covers it", async () => {
  let wide = true;
  const settings = { ...DEFAULT_SETTINGS, filesPanel: true, webLinks: "panel" as const };
  function Probe() {
    panels = useFilePanels({ machines: [], settings, filePanelAvailable: wide, selectedPaneId: "p1", selectedMachineId: "local" });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { panels.setFilesOpen(true); });
  await act(async () => { expect(panels.openWebPage("http://localhost:3000/report", false, "local")).toBe(true); });
  expect(panels.webPage).not.toBeNull();

  // narrower than the dock: the page turns popup, and Files would come back as a dialog under it
  wide = false;
  await act(async () => { renderer!.update(createElement(Probe)); });

  expect(panels.webPage).not.toBeNull();
  expect(panels.filesOpen).toBe(false);
});

it("keeps Files a dialog on a narrow window even when set beside the pane", async () => {
  await mount({ filesPanel: true }, false);
  expect(panels.filesDocked).toBe(false);
  expect(panels.browserDocked).toBe(false);
});
