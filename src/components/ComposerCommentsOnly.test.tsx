import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { blockComments, blockTarget, replyPart } from "../lib/blockComments.ts";
import { parseMarkdown } from "../../shared/markdown.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "comments-only-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const local = new Map<string, string>();
  const localStorage = { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => { local.set(key, value); }, removeItem: (key: string) => { local.delete(key); }, key: (n: number) => [...local.keys()][n] ?? null, get length() { return local.size; } };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout, localStorage },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  blockComments.remove(pane, blockComments.list(pane).map((c) => c.id));
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

it("sends reply comments with nothing typed in the box", async () => {
  const calls: unknown[][] = [];
  const props: ComposerProps = { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (...args) => { calls.push(args); return true; }, onAbort() {}, onUploadImage: async () => "" };
  const reply = replyPart(pane, "2026-10-03T10:12:00Z", 0, 0);
  await act(async () => { renderer = create(<Composer {...props} />); });
  await act(async () => {
    blockComments.save(pane, blockTarget(reply, [0], parseMarkdown("First answer")[0]!), "Explain this");
    blockComments.save(pane, blockTarget(reply, [1], parseMarkdown("Second answer")[0]!), "And this");
  });
  const send = renderer!.root.findByProps({ "aria-label": "Send message · Comments to send: 2" });
  expect(send.props.disabled).toBe(false);
  await act(async () => { send.props.onClick(); });
  expect(calls).toHaveLength(1);
  const [text, options] = calls[0] as [string, { comments: readonly { comment: string }[]; agentOnly: boolean }];
  expect(text).toBe("");
  expect(options.comments.map((c) => c.comment)).toEqual(["Explain this", "And this"]);
  expect(blockComments.list(pane)).toEqual([]);
});
