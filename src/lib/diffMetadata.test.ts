import { describe, expect, test } from "bun:test";
import type { GitFileDiffResponse } from "../../shared/protocol.ts";
import { diffMetadata } from "./diffMetadata.ts";

function file(old: string | null, next: string | null, patch = ""): GitFileDiffResponse {
  return { root: "/repo", revision: "snapshot", path: "f.txt", binary: false, patch,
    old_file: old === null ? null : { name: "f.txt", contents: old },
    new_file: next === null ? null : { name: "f.txt", contents: next } };
}
const header = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n";

describe("Git patch metadata without diff recomputation", () => {
  test("hydrates full sides and hunk coordinates, including collapsed prefix/suffix", () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}\n`);
    const after = [...before]; after[49] = "changed\n";
    const result = diffMetadata(file(before.join(""), after.join(""), header + "@@ -50 +50 @@\n-line 50\n+changed\n"), "all")!;
    expect(result.isPartial).toBe(false);
    expect(result.deletionLines).toEqual(before);
    expect(result.additionLines).toEqual(after);
    expect(result.hunks[0]?.additionLineIndex).toBe(49);
    expect(result.hunks[0]?.collapsedBefore).toBe(49);
    expect(result.hunks[0]?.hunkContent[0]?.additionLineIndex).toBe(49);
    expect(result.splitLineCount).toBe(100);
  });
  test("preserves mode-only and pure rename metadata with visible context", () => {
    const mode = diffMetadata(file("same\n", "same\n", "diff --git a/f.txt b/f.txt\nold mode 100644\nnew mode 100755\n"), "staged")!;
    expect(mode.prevMode).toBe("100644"); expect(mode.mode).toBe("100755");
    expect(mode.hunks[0]?.hunkContent[0]?.type).toBe("context");
    const input = file("same\n", "same\n", "diff --git a/old.txt b/f.txt\nsimilarity index 100%\nrename from old.txt\nrename to f.txt\n");
    input.old_path = "old.txt";
    const rename = diffMetadata(input, "all")!;
    expect(rename.type).toBe("rename-pure"); expect(rename.prevName).toBe("old.txt");
    expect(rename.deletionLines).toEqual(["same\n"]);
    expect(rename.hunks[0]?.hunkContent[0]?.type).toBe("context");
  });
  test("changed rename retains side names and exact CRLF contents", () => {
    const input = file("before\r\n", "after\r\n", "diff --git a/old.txt b/f.txt\nsimilarity index 50%\nrename from old.txt\nrename to f.txt\n--- a/old.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-before\r\n+after\r\n");
    input.old_path = "old.txt";
    const result = diffMetadata(input, "unstaged")!;
    expect(result.type).toBe("rename-changed"); expect(result.prevName).toBe("old.txt");
    expect(result.name).toBe("f.txt");
    expect(result.deletionLines).toEqual(["before\r\n"]);
    expect(result.additionLines).toEqual(["after\r\n"]);
  });
  test("empty patch supports unchanged, new, deleted and empty files", () => {
    expect(diffMetadata(file("same", "same"), "all")?.hunks[0]?.hunkContent[0]?.type).toBe("context");
    expect(diffMetadata(file(null, "new\n"), "all")?.type).toBe("new");
    expect(diffMetadata(file("old", null), "all")?.type).toBe("deleted");
    expect(diffMetadata(file("", ""), "all")?.hunks).toEqual([]);
    expect(diffMetadata(file(null, ""), "all")?.additionLines).toEqual([]);
  });
  test("new/deleted patches hydrate missing sides and preserve no-final-newline", () => {
    const added = diffMetadata(file(null, "new", "diff --git a/f.txt b/f.txt\nnew file mode 100644\n--- /dev/null\n+++ b/f.txt\n@@ -0,0 +1 @@\n+new\n\\ No newline at end of file\n"), "all")!;
    expect(added.type).toBe("new"); expect(added.deletionLines).toEqual([]);
    expect(added.additionLines).toEqual(["new"]); expect(added.hunks[0]?.noEOFCRAdditions).toBe(true);
    const deleted = diffMetadata(file("old\n", null, "diff --git a/f.txt b/f.txt\ndeleted file mode 100644\n--- a/f.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n"), "all")!;
    expect(deleted.type).toBe("deleted"); expect(deleted.additionLines).toEqual([]);
    expect(deleted.deletionLines).toEqual(["old\n"]);
  });
  test("large unrelated sides use supplied patch rather than quadratic matching", () => {
    const size = 20000;
    const before = Array.from({ length: size }, (_, i) => `old-${i}\n`);
    const after = Array.from({ length: size }, (_, i) => `new-${i}\n`);
    const patch = header + `@@ -1,${size} +1,${size} @@\n` + before.map((line) => `-${line}`).join("") + after.map((line) => `+${line}`).join("");
    const result = diffMetadata(file(before.join(""), after.join(""), patch), "all")!;
    expect(result.deletionLines.length).toBe(size); expect(result.additionLines.length).toBe(size);
    expect(result.hunks[0]?.additionLines).toBe(size);
    expect(result.splitLineCount).toBe(size); expect(result.unifiedLineCount).toBe(size * 2);
  }, 2000);
});
