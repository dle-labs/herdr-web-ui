import { describe, expect, it } from "bun:test";
import { createDictationDraft } from "./dictationDraft.ts";

function started(value = "before after") {
  const draft = createDictationDraft();
  draft.observe(value, { start: 7, end: 7 });
  const take = draft.begin("machine/pane/comment-opening")!;
  return { draft, take };
}

describe("dictation draft ownership", () => {
  it("inserts only against the original owner and revision", () => {
    const { draft, take } = started();
    expect(draft.current(take, take.owner)).toBe(true);
    expect(draft.current(take, "another pane")).toBe(false);
    expect(draft.unchanged(take)).toBe(true);
  });
  it("requires recovery after edits, including undo back to the original text", () => {
    const { draft, take } = started();
    draft.observe("changed", { start: 7, end: 7 });
    draft.observe(take.value, take.selection);
    expect(draft.unchanged(take)).toBe(false);
    expect(draft.current(take, take.owner)).toBe(true);
  });
  it("requires recovery after caret-only movement even when the caret moves back", () => {
    const { draft, take } = started();
    draft.observe(take.value, { start: 2, end: 4 });
    draft.observe(take.value, take.selection);
    expect(draft.unchanged(take)).toBe(false);
  });
  it("does not lose the insertion cursor when a footer takes focus", () => {
    const { draft, take } = started();
    draft.observe(take.value, null);
    expect(draft.cursor()).toEqual(take.selection);
    expect(draft.unchanged(take)).toBe(true);
  });
  it("a programmatic draft change invalidates the old cursor until explicitly placed", () => {
    const { draft } = started();
    draft.observe("new draft", null);
    expect(draft.cursor()).toBeNull();
    draft.observe("new draft", { start: 1, end: 1 });
    expect(draft.cursor()).toEqual({ start: 1, end: 1 });
  });
  it("composition changes require recovery even before the input commits", () => {
    const { draft, take } = started();
    draft.changed();
    expect(draft.unchanged(take)).toBe(false);
  });
  it("Send/Save/close/disable permanently invalidate results and IME-held recovery", () => {
    const { draft, take } = started();
    draft.cancel();
    expect(draft.current(take, take.owner)).toBe(false);
    draft.begin(take.owner);
    expect(draft.current(take, take.owner)).toBe(false);
  });
  it("a newer take invalidates its predecessor and impossible selections are not guessed", () => {
    const { draft, take } = started();
    draft.begin(take.owner);
    expect(draft.current(take, take.owner)).toBe(false);
    draft.observe("short", { start: 20, end: 20 });
    expect(draft.cursor()).toBeNull();
    expect(draft.begin(take.owner)).toBeNull();
  });
});
