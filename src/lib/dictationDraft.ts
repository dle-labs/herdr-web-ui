/** Draft ownership is separate from microphone ownership. No delayed result can send or save. */
export interface DraftSelection { start: number; end: number }
export interface DictationSnapshot {
  owner: string;
  value: string;
  revision: number;
  selectionRevision: number;
  selection: DraftSelection;
  generation: number;
}

export function createDictationDraft() {
  let value = "";
  let revision = 0;
  let selectionRevision = 0;
  let selection: DraftSelection | null = null;
  let generation = 0;
  let active: DictationSnapshot | null = null;
  return {
    /** Native input provides a current selection; a programmatic edit must not guess one. */
    observe(next: string, caret: DraftSelection | null): void {
      if (next !== value) { value = next; revision++; selection = null; }
      if (caret !== null && caret.start >= 0 && caret.end >= caret.start && caret.end <= value.length) {
        if (selection?.start !== caret.start || selection.end !== caret.end) selectionRevision++;
        selection = { ...caret };
      }
    },
    changed(): void { revision++; },
    begin(owner: string): DictationSnapshot | null {
      if (selection === null) return null;
      active = { owner, value, revision, selectionRevision, selection: { ...selection }, generation: ++generation };
      return active;
    },
    cancel(): void { generation++; active = null; },
    current(take: DictationSnapshot, owner: string): boolean {
      return active === take && take.generation === generation && take.owner === owner;
    },
    unchanged(take: DictationSnapshot): boolean {
      return take.revision === revision && take.selectionRevision === selectionRevision && take.value === value;
    },
    cursor(): DraftSelection | null { return selection === null ? null : { ...selection }; },
  };
}
