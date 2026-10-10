import { describe, expect, it } from "bun:test";
import { createDictationUndo } from "./dictationUndo.ts";
import { insertAtCaret } from "./voice.ts";

function insert(history: ReturnType<typeof createDictationUndo>, before: string, start: number, end: number, speech: string) {
  const next = insertAtCaret(before, start, end, speech);
  history.record(before, next.value, start, end);
  return next.value;
}
describe("dictation segment undo", () => {
  it("removes one entire take and its spacing, newest first", () => {
    const history = createDictationUndo();
    const first = insert(history, "typed", 5, 5, "first segment");
    const second = insert(history, first, first.length, first.length, "second segment");
    expect(history.undo(second)?.value).toBe(first);
    expect(history.undo(first)).toEqual({ value: "typed", caret: 5 });
    expect(history.available()).toBe(false);
  });
  it("restores a replaced selection and leaves surrounding text alone", () => {
    const history = createDictationUndo();
    const next = insert(history, "open old file", 5, 8, "new name");
    expect(history.undo(next)).toEqual({ value: "open old file", caret: 8 });
  });
  it("preserves edits before and after an inserted segment", () => {
    const history = createDictationUndo();
    const next = insert(history, "prefix suffix", 7, 7, "spoken");
    history.observe("typed " + next);
    expect(history.undo("typed " + next + " tail")?.value).toBe("typed prefix suffix tail");
  });
  it("tracks takes inserted earlier in the draft and undoes in take order", () => {
    const history = createDictationUndo();
    const first = insert(history, "", 0, 0, "first");
    const second = insert(history, first, 0, 0, "second");
    expect(history.undo(second)?.value).toBe(first);
    expect(history.undo(first)?.value).toBe("");
  });
  it("uses exact insertion ranges even when successive takes repeat the same words", () => {
    const history = createDictationUndo();
    const first = insert(history, "", 0, 0, "same");
    const second = insert(history, first, 0, 0, "same");
    expect(history.undo(second)?.value).toBe(first);
    expect(history.undo(first)?.value).toBe("");
  });
  it("never deletes user changes inside a segment", () => {
    const history = createDictationUndo();
    insert(history, "typed", 5, 5, "spoken");
    expect(history.undo("typed edited")).toBeNull();
  });
  it("clears history across draft ownership changes or submission", () => {
    const history = createDictationUndo();
    insert(history, "", 0, 0, "spoken");
    history.clear("different draft");
    expect(history.undo("different draft")).toBeNull();
  });
});
