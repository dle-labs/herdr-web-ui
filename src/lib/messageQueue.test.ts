import { expect, it } from "bun:test";
import { blockTarget, composeWithComments, replyPart, selectionTarget, type BlockComment } from "./blockComments.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { heldAgentOnly, heldMessageText, MessageQueueStore } from "./messageQueue.ts";
import { parseMarkdown } from "./markdown.ts";
import { fileAnchor, type FileComment } from "./fileComments.ts";

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, storage, queue: new MessageQueueStore(() => storage) };
}

it("persists multiple independent items, including identical text, and individual edits", () => {
  const { queue, storage, data } = fixture();
  queue.add("local:a", "same"); queue.add("local:a", "same");
  const [first, second] = queue.read("local:a");
  expect(first!.id).not.toBe(second!.id);
  queue.edit("local:a", second!.id, "edited");
  expect(new MessageQueueStore(() => storage).read("local:a").map(m => m.text)).toEqual(["same", "edited"]);
  queue.remove("local:a", first!.id);
  expect(queue.read("local:a").map(m => m.text)).toEqual(["edited"]);
  queue.remove("local:a", second!.id);
  expect(data.has("herdr-web-ui:queue:local:a")).toBe(false);
});

it("an old acknowledgement removes only its captured item and owner", () => {
  const { queue } = fixture();
  queue.add("local:a", "in flight");
  const sent = queue.read("local:a")[0]!;
  queue.add("local:a", "newly queued"); queue.add("remote:a", "other PC"); queue.add("local:b", "other pane");
  queue.remove("local:a", sent.id);
  expect(queue.read("local:a").map(m => m.text)).toEqual(["newly queued"]);
  expect(queue.read("remote:a")[0]!.text).toBe("other PC");
  expect(queue.read("local:b")[0]!.text).toBe("other pane");
});

it("migrates the previous plain-text queue without losing JSON-like messages", () => {
  for (const text of ["legacy", '{"message":"legacy"}']) {
    const { queue, data, storage } = fixture();
    data.set("herdr-web-ui:queue:a", text);
    expect(queue.read("a")[0]!.text).toBe(text);
    queue.add("a", "next");
    expect(new MessageQueueStore(() => storage).read("a").map(m => m.text)).toEqual([text, "next"]);
  }
});

it("keeps messages in memory when storage is unavailable", () => {
  const queue = new MessageQueueStore(() => { throw new Error("denied"); });
  queue.add("a", "first"); queue.add("a", "second");
  expect(queue.read("a").map(m => m.text)).toEqual(["first", "second"]);
});

it("shares pending sends and notifies a remounted view on acknowledgement", () => {
  const { queue } = fixture();
  queue.add("a", "first");
  const sent = queue.read("a")[0]!;
  expect(queue.beginSend("a", sent.id)).toBe(true);
  expect(queue.beginSend("a", sent.id)).toBe(false);
  let notices = 0;
  const unsubscribe = queue.subscribe(() => { notices++; });
  queue.add("a", "second");
  queue.remove("a", sent.id);
  queue.endSend("a", sent.id);
  expect(queue.isSending(sent.id)).toBe(false);
  expect(queue.read("a").map(m => m.text)).toEqual(["second"]);
  expect(notices).toBe(3);
  unsubscribe();
  queue.add("a", "third");
  expect(notices).toBe(3);
});

it("reads another tab's latest additions before edits or late acknowledgements", () => {
  const { queue, storage } = fixture();
  const other = new MessageQueueStore(() => storage);
  queue.add("a", "first");
  const first = other.read("a")[0]!;
  queue.add("a", "second");
  other.add("a", "third");
  queue.remove("a", first.id);
  other.refresh("a");
  expect(other.read("a").map(m => m.text)).toEqual(["second", "third"]);
});

it("reports failed persistence without throwing away the in-memory queue", () => {
  const queue = new MessageQueueStore(() => { throw new Error("quota"); });
  queue.add("a", "keep me");
  expect(queue.isUnsaved("a")).toBe(true);
  queue.refresh("a");
  expect(queue.read("a")[0]!.text).toBe("keep me");
});

it("keeps a stored agent-only flag through edits and a reload, and reads nothing else as one", () => {
  const { queue, data, storage } = fixture();
  data.set("herdr-web-ui:queue:a", JSON.stringify({ version: 1, messages: [{ id: "l", text: "> quoted\ncomment", agentOnly: true }] }));
  queue.add("a", "plain");
  queue.edit("a", "l", "> quoted\nedited");
  expect(new MessageQueueStore(() => storage).read("a").map((m) => [m.text, m.agentOnly === true])).toEqual([["> quoted\nedited", true], ["plain", false]]);
  // a hand-edited flag that is not exactly true reads as a plain message
  data.set("herdr-web-ui:queue:b", JSON.stringify({ version: 1, messages: [{ id: "x", text: "t", agentOnly: "yes" }] }));
  expect(new MessageQueueStore(() => storage).read("b")).toEqual([{ id: "x", text: "t" }]);
});

const target = blockTarget(replyPart("o", "2026-10-03T10:12:00Z", 0, 0), [0], parseMarkdown("Quoted")[0]!);
const c1: BlockComment = { id: "c1", comment: "note", anchor: target.anchor, block: target.block, order: [target.turnTime!, ...target.position] };

it("keeps the comments of a held message apart from its text, with no agentOnly key", () => {
  const { queue, storage } = fixture();
  queue.add("a", "hi", { comments: [c1] });
  queue.add("a", "plain", { comments: [] });
  const [held, plain] = new MessageQueueStore(() => storage).read("a");
  expect(held).toEqual({ id: held!.id, text: "hi", comments: [c1] });
  expect("agentOnly" in held!).toBe(false);
  expect("comments" in plain!).toBe(false);
  expect(heldAgentOnly(held!)).toBe(true);
  expect(heldAgentOnly(plain!)).toBe(false);
});

it("stores blank text as empty only when comments go with it", () => {
  const { queue, storage } = fixture();
  queue.add("a", "  \n ", { comments: [c1] });
  queue.add("a", "  \n ");
  queue.add("a", " hi ", { comments: [c1] });
  const [blank, plain, typed] = new MessageQueueStore(() => storage).read("a");
  expect(blank!.text).toBe("");
  expect(plain!.text).toBe("  \n ");
  expect(typed!.text).toBe(" hi ");
});

it("drops stored comments that do not read, and a comments value that is no list", () => {
  const { data, storage } = fixture();
  data.set("herdr-web-ui:queue:a", JSON.stringify({ version: 1, messages: [{ id: "x", text: "t", comments: [c1, { id: 1 }] }, { id: "y", text: "u", comments: "x" }] }));
  expect(new MessageQueueStore(() => storage).read("a")).toEqual([{ id: "x", text: "t", comments: [c1] }, { id: "y", text: "u" }]);
});

it("loads a legacy composed message unchanged and still treats it as agent-only", () => {
  const { data, storage } = fixture();
  data.set("herdr-web-ui:queue:a", JSON.stringify({ version: 1, messages: [{ id: "a", text: "> q\nc\n\nhi", agentOnly: true }] }));
  const [held] = new MessageQueueStore(() => storage).read("a");
  expect(held).toEqual({ id: "a", text: "> q\nc\n\nhi", agentOnly: true });
  expect(heldAgentOnly(held!)).toBe(true);
  expect(heldMessageText(held!)).toBe("> q\nc\n\nhi");
});

it("composes a held message from its snapshot, also after its text was emptied", () => {
  const { queue } = fixture();
  queue.add("a", "hi", { comments: [c1] });
  const id = queue.read("a")[0]!.id;
  queue.edit("a", id, "");
  const held = queue.read("a")[0]!;
  expect(held.comments).toEqual([c1]);
  expect(heldMessageText(held)).toBe(composeWithComments([c1], ""));
  expect(heldMessageText(held).trim()).not.toBe("");
});

it("composes a comment of the longest allowed length past the composer limit", () => {
  const { queue } = fixture();
  queue.add("a", "hi", { comments: [{ ...c1, comment: "x".repeat(MAX_COMPOSER_CHARS) }] });
  expect(heldMessageText(queue.read("a")[0]!).length).toBeGreaterThan(MAX_COMPOSER_CHARS);
});

it("reads an empty comments list as no comments at all", () => {
  expect(heldMessageText({ id: "a", text: "hi", comments: [] })).toBe("hi");
  expect(heldAgentOnly({ id: "a", text: "hi", comments: [] })).toBe(false);
});

it("keeps a selection comment through a held snapshot round trip and composes its quote", () => {
  const { queue, storage } = fixture();
  const part = blockTarget(replyPart("o", "2026-10-03T10:12:00Z", 7, 0), [1], parseMarkdown("Alpha beta\ngamma")[0]!);
  const target = selectionTarget(part, "beta\ngamma", 6, 16);
  const selection: BlockComment = { id: "s1", comment: "why", anchor: target.anchor, block: target.block, order: [target.turnTime!, ...target.position], quote: "beta\ngamma", range: [6, 16] };
  queue.add("a", "hi", { comments: [selection, c1] });
  const [held] = new MessageQueueStore(() => storage).read("a");
  expect(held!.comments).toEqual([selection, c1]);
  expect(heldMessageText(held!)).toBe(composeWithComments([selection, c1], "hi"));
  expect(heldMessageText(held!)).toContain("> beta\n> gamma\nwhy");
});

it("drops a held comment whose quote or range is malformed and keeps the rest", () => {
  const { data, storage } = fixture();
  const bad = [{ ...c1, id: "b1", quote: "" }, { ...c1, id: "b2", quote: "q", range: [3, 1] }];
  data.set("herdr-web-ui:queue:a", JSON.stringify({ version: 1, messages: [{ id: "x", text: "t", comments: [...bad, { ...c1, id: "g", quote: "q", range: [0, 1] }] }] }));
  expect(new MessageQueueStore(() => storage).read("a")[0]!.comments!.map((c) => c.id)).toEqual(["g"]);
});

it("keeps file comments with a held message and composes them when sent", () => {
  const { queue, storage } = fixture();
  const lines = { path: "/repo/src/sync.ts", label: "src/sync.ts", view: "code" as const, lines: [8, 8] as [number, number], source: ["if (a < b) {"], quoteLines: ["if (a < b) {"] };
  const file: FileComment = { ...lines, kind: "file", id: "f1", anchor: fileAnchor(lines), created: 1, comment: "Compare with <=." };
  queue.add("a", "hi", { comments: [c1, file] });
  const [held] = new MessageQueueStore(() => storage).read("a");
  expect(held!.comments).toEqual([c1, file]);
  expect(heldAgentOnly(held!)).toBe(true);
  expect(heldMessageText(held!)).toBe("> Quoted\nnote\n\n> src/sync.ts:8\n> if (a < b) {\nCompare with <=.\n\nhi");
});
