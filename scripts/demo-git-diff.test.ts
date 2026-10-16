import { describe, expect, test } from "bun:test";
import { demoGitChanges, demoGitDiff } from "../site/demo/gitDiff.ts";

describe("fictional demo Git snapshots", () => {
  test("all and unstaged include untracked files, staged does not", () => {
    for (const mode of ["all", "unstaged", "staged"] as const) {
      const changes = demoGitChanges("/home/demo/project", mode);
      expect(changes.files.length).toBe(mode === "staged" ? 1 : 2);
      for (const file of changes.files) {
        const diff = demoGitDiff(changes.root, mode, file.path)!;
        expect(diff.revision).toBe(changes.revision);
        expect(diff.root).toBe(changes.root);
        expect(diff.binary).toBe(false);
        expect(diff.new_file?.name).toBe(file.path);
      }
    }
  });
  test("added files have a missing old side, not an empty existing file", () => {
    expect(demoGitDiff("/home/demo/project", "all", "src/new.ts")?.old_file).toBeNull();
    expect(demoGitDiff("/home/demo/project", "staged", "src/new.ts")).toBeNull();
    expect(demoGitDiff("/home/demo/project", "all", "../secret")).toBeNull();
  });
  test("modified snapshots retain both versions and matching patch text", () => {
    const diff = demoGitDiff("/home/demo/project", "all", "src/greeting.ts")!;
    expect(diff.old_file?.contents).toContain("Hi,");
    expect(diff.new_file?.contents).toContain("Hello,");
    expect(diff.patch).toContain('-  return `Hi, ${name}`;');
    expect(diff.patch).toContain('+  return `Hello, ${name}!`;');
  });
});
