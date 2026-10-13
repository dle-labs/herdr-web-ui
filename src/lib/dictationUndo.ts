/** Track inserted takes, not whole-draft snapshots: undo must preserve unrelated edits. */
export function createDictationUndo() {
  let value = "";
  let segments: Array<{ start: number; end: number; replaced: string }> = [];
  function edit(start: number, end: number, delta: number): void {
    segments = segments.filter((segment) => {
      if (end <= segment.start) { segment.start += delta; segment.end += delta; return true; }
      if (start >= segment.end) return true;
      // An edited segment is no longer safe to remove as a unit.
      return false;
    });
  }
  function observe(next: string): void {
    if (next === value) return;
    let start = 0;
    while (start < value.length && start < next.length && value[start] === next[start]) start++;
    let end = value.length, nextEnd = next.length;
    while (end > start && nextEnd > start && value[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    edit(start, end, nextEnd - end);
    value = next;
  }
  return {
    observe,
    clear(next = ""): void { value = next; segments = []; },
    available(): boolean { return segments.length > 0; },
    record(before: string, next: string, from: number, to: number): void {
      observe(before);
      const replaced = before.slice(from, to);
      edit(from, to, next.length - before.length);
      value = next;
      segments.push({ start: from, end: from + next.length - before.length + to - from, replaced });
    },
    undo(next: string): { value: string; caret: number } | null {
      observe(next);
      const segment = segments.pop();
      if (!segment) return null;
      const result = value.slice(0, segment.start) + segment.replaced + value.slice(segment.end);
      edit(segment.start, segment.end, result.length - value.length);
      value = result;
      return { value: result, caret: segment.start + segment.replaced.length };
    },
  };
}
