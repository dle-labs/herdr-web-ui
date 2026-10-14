import { describe, expect, it } from "bun:test";
import { composeReviewMessage, draftDirty, includeReviewNotes, orderedNotes, replyAnchor, ReviewNotesStore, reviewReference, sameDiff, sourceAnchor, sourceAnchorReader, REVIEW_CONTEXT_LIMIT, type ReviewNote, type ReviewTarget } from "./reviewNotes.ts";

function storage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null, key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, setItem: (key, value) => { data.set(key, value); } };
}
const source: ReviewTarget = { kind: "source", path: "src/a.ts", start: 2, end: 3, evidence: "original\nlines" };
function note(id: string, target: ReviewTarget = source, created = 1): ReviewNote { return { key: id, id, owner: "pane", created, target, quote: "quoted\n> context", text: id }; }

describe("one-send review notes", () => {
  it("keeps exact coordinates, relocates only unique full-source lines, never truncated or ambiguous context", () => {
    if (source.kind !== "source") throw new Error("source target");
    expect(sourceAnchor(source, "head\noriginal\nlines\nend", true)).toEqual({ start: 2, end: 3 });
    expect(sourceAnchor(source, "original\nlines\nend", true)).toEqual({ start: 1, end: 2 });
    expect(sourceAnchor(source, "original\nlines\nend", false)).toBeNull();
    expect(sourceAnchor(source, "original\nlines\noriginal\nlines", true)).toBeNull();
    expect(sourceAnchor(source, "not original\nlines", true)).toBeNull();
    expect(sourceAnchor(source, "head\noriginal\nlines\nend", false)).toEqual({ start: 2, end: 3 });
    expect(sourceAnchor(source, "head\noriginal\nlines\noriginal\nlines", true)).toEqual({ start: 2, end: 3 });
    expect(sourceAnchorReader("head\noriginal\nlines", true, 1)(source)).toBeUndefined();
  });
  it("requires reply evidence and exact diff snapshot and side", () => {
    const reply: ReviewTarget = { kind: "reply", turn: "index:2", order: 2, part: 1, block: "part:1", blockStart: 0, start: 0, end: 3, evidence: "yes indeed" };
    expect(replyAnchor(reply, "index:2", 1, "yes indeed")).toBe(true);
    expect(replyAnchor(reply, "index:2", 1, "new reply")).toBe(false);
    expect(replyAnchor(reply, "index:2", 1, "yes but a replaced block")).toBe(false);
    const diff: Extract<ReviewTarget, { kind: "diff" }> = { kind: "diff", repository: "/repo", path: "a", scope: "all", base: "full", fingerprint: "snapshot", side: "old", start: 1, end: 1, evidence: "old" };
    expect(sameDiff(diff, diff)).toBe(true);
    for (const patch of [{ side: "new" as const }, { fingerprint: "changed" }, { base: "other" }, { head: "other" }, { scope: "staged" as const }, { repository: "/other" }, { path: "b" }]) expect(sameDiff(diff, { ...diff, ...patch })).toBe(false);
  });
  it("identifies both immutable commits and the repository in outgoing references", () => {
    const target: ReviewTarget = { kind: "diff", repository: "/repo", path: "src/a.ts", scope: "commit", base: "a".repeat(40), head: "b".repeat(40), fingerprint: "snapshot", side: "new", start: 1, end: 2, evidence: "lines" };
    expect(reviewReference(target)).toContain(`/repo/src/a.ts, new side, lines 1–2 (${target.base} versus ${target.head};`);
    expect(sameDiff(target, { ...target, head: "c".repeat(40) })).toBe(false);
    expect(sameDiff({ ...target, head: undefined }, target)).toBe(false);
  });
  it("orders replies before file groups, then lines, appends prose and quotes safely", () => {
    const reply = (order: number): ReviewTarget => ({ kind: "reply", turn: String(order), order, part: 0, block: "0", blockStart: 0, start: 0, end: 1, evidence: "x" });
    const notes = [note("later-line", { ...source, start: 9, end: 9 }, 1), note("other-file", { ...source, path: "b" }, 3), note("earlier-line", source, 4), note("reply2", reply(2)), note("reply1", reply(1))];
    expect(orderedNotes(notes).map((entry) => entry.id)).toEqual(["reply1", "reply2", "earlier-line", "later-line", "other-file"]);
    const text = composeReviewMessage([notes[0]!], "my message", 10000)!;
    expect(text).toContain("> quoted\n> > context"); expect(text.endsWith("my message")).toBe(true);
    expect(composeReviewMessage(notes, "prose", 8)).toBeNull();
    expect(composeReviewMessage(notes, "", 10000)).not.toBeNull();
    for (const [text, agent, answering] of [["/compact", "pi", false], [" /new", "pi", false], ["answer", "pi", true], ["shell", null, false]] as const) expect(includeReviewNotes(text, agent, answering)).toBe(false);
    expect(includeReviewNotes("", "pi", false)).toBe(true);
  });
  it("a saved blank edit is dirty and deletes, a new blank cannot save; navigation never replaces dirty text", () => {
    const local = storage(), store = new ReviewNotesStore(() => local);
    store.begin("pane", source, "quote"); expect(store.save()).toBe(false);
    store.composition(true); expect(store.guard()).toBe(false); expect(store.save()).toBe(false);
    expect(store.begin("other", source, "other")).toBe(false); store.composition(false);
    store.write("draft"); expect(draftDirty(store.draft)).toBe(true); expect(store.begin("other", source, "other")).toBe(false); expect(store.guard()).toBe(false);
    store.save(); const saved = store.read("pane")[0]!;
    store.edit(saved); expect(draftDirty(store.draft)).toBe(false);
    store.write(""); expect(draftDirty(store.draft)).toBe(true); expect(store.close()).toBe(false);
    expect(store.save()).toBe(true); expect(store.read()).toEqual([]);
  });
  it("refreshes before mutation and old acknowledgments cannot remove another tab's edit", () => {
    const local = storage(), first = new ReviewNotesStore(() => local), second = new ReviewNotesStore(() => local);
    first.begin("pane", source, "quote"); first.write("first"); first.save(); const captured = first.read();
    second.refresh(); second.edit(second.read()[0]!); second.write("second tab"); second.save();
    first.acknowledge(captured); expect(first.read()[0]!.text).toBe("second tab"); expect(first.read()[0]!.id).not.toBe(captured[0]!.id);
    first.begin("other pane", source, "context"); first.write("other note"); first.save(); second.refresh(); expect(second.read()).toHaveLength(2);
    second.clear(); expect(second.read()).toEqual([]); first.refresh(); expect(first.read()).toEqual([]);
  });
  it("keeps verified relocated references without overwriting a later text version", () => {
    const local = storage(), store = new ReviewNotesStore(() => local), other = new ReviewNotesStore(() => local);
    store.begin("pane", source, "quote"); store.write("review"); store.save();
    const captured = store.read(), saved = captured[0]!;
    const locate = sourceAnchorReader("new\nhead\noriginal\nlines\nend", true);
    const anchor = source.kind === "source" ? locate(source) : null;
    store.reanchor(captured, new Map([[saved.key, anchor]]));
    expect(reviewReference(store.read()[0]!.target)).toContain("lines 3–4");
    expect(composeReviewMessage(store.read(), "", 10000)).toContain("lines 3–4");
    expect(store.read()[0]!.id).toBe(saved.id);
    other.refresh(); other.edit(other.read()[0]!); other.write("later text"); other.save();
    store.reanchor(captured, new Map([[saved.key, { start: 8, end: 9 }]]));
    store.acknowledge(captured);
    expect(store.read()[0]!.text).toBe("later text");
    expect(store.read()[0]!.target.start).toBe(3);
    expect(composeReviewMessage(store.read(), "", 10000, () => "outdated")).toContain("outdated target; last known location");
  });
  it("captures exact versions across late edits and preserves unmatched notes", () => {
    const local = storage(), store = new ReviewNotesStore(() => local);
    store.begin("pane", source, "quote"); store.write("sent"); store.save(); const captured = store.read();
    store.edit(captured[0]!); store.write("late"); store.save(); store.acknowledge(captured);
    expect(store.read()[0]!.text).toBe("late");
    store.acknowledge(store.read()); expect(store.read()).toEqual([]);
  });
  it("retains memory-held notes with an unsaved warning and refuses oversized exact context", () => {
    const store = new ReviewNotesStore(() => { throw new Error("blocked"); });
    store.begin("pane", source, "quote"); store.write("memory"); store.save(); store.refresh();
    expect(store.storageFailed).toBe(true); expect(store.read()[0]!.text).toBe("memory");
    expect(store.begin("pane", { ...source, evidence: "x".repeat(REVIEW_CONTEXT_LIMIT + 1) }, "large")).toBe(false);
  });
});
