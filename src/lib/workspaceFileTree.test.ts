import { describe, expect, test } from "bun:test";
import type { DirectoryListing, GitChangedFile } from "../../shared/protocol.ts";
import { workspaceChildPath, workspaceTreeEntries } from "./workspaceFileTree.ts";

const listing: DirectoryListing = { path: "/repo", parent: "/", home: "/home/user", directories: ["src"], files: [{ name: "README.md", size: 20 }], truncated: false };

describe("workspace tree", () => {
  test("non-Git folders retain all files and directories", () => {
    expect(workspaceTreeEntries(listing, [], "")).toEqual([["src", { directory: true }], ["README.md", { directory: false }]]);
  });
  test("deleted paths provide missing ancestor folders and leaves", () => {
    const files = [{ path: "gone/deep/file.ts", status: "deleted" as const }];
    expect(workspaceTreeEntries(null, files, "")).toEqual([["gone", { directory: true, containsChanges: true }]]);
    expect(workspaceTreeEntries(null, files, "gone/deep")).toEqual([["file.ts", { directory: false, status: "deleted" }]]);
    expect(workspaceTreeEntries(null, files, "go")).toEqual([]);
  });
  test("changed files merge without duplicating the disk entry", () => {
    expect(workspaceTreeEntries(listing, [{ path: "README.md", status: "modified" }], "")).toEqual([
      ["src", { directory: true }], ["README.md", { directory: false, status: "modified" }],
    ]);
  });
  test("ignored directories stay in the listing and preserve their flag when changes merge", () => {
    const ignoredListing: DirectoryListing = { ...listing, ignored_directories: ["src"] };
    expect(workspaceTreeEntries(ignoredListing, [
      { path: "src/app.ts", status: "modified" },
      { path: "src/gone.ts", status: "deleted" },
    ], "")).toEqual([
      ["src", { directory: true, ignored: true, containsChanges: true }],
      ["README.md", { directory: false }],
    ]);
  });
  test("ignored status propagates to disk and inventory-only children", () => {
    expect(workspaceTreeEntries(listing, [{ path: "gone/file.ts", status: "deleted" }], "", true)).toEqual([
      ["gone", { directory: true, ignored: true, containsChanges: true }],
      ["src", { directory: true, ignored: true }],
      ["README.md", { directory: false, ignored: true }],
    ]);
    expect(workspaceTreeEntries(null, [{ path: "gone/file.ts", status: "deleted" }], "gone", true)).toEqual([
      ["file.ts", { directory: false, ignored: true, status: "deleted" }],
    ]);
  });
  test("optional ignored directory names do not hide or mark unrelated entries", () => {
    expect(workspaceTreeEntries({ ...listing, ignored_directories: ["other"] }, [], "")).toEqual(workspaceTreeEntries(listing, [], ""));
    expect(workspaceTreeEntries({ ...listing, ignored_directories: [] }, [], "")).toEqual(workspaceTreeEntries(listing, [], ""));
  });
  test("Git changes preserve a disk directory even when its path was formerly a file", () => {
    expect(workspaceTreeEntries(listing, [{ path: "src", status: "deleted" }], "")[0]).toEqual([
      "src", { directory: true, containsChanges: true },
    ]);
  });
  test("mixed descendant statuses aggregate independently of inventory order", () => {
    const files: GitChangedFile[] = [
      { path: "src/added.ts", status: "added" },
      { path: "src/deleted.ts", status: "deleted" },
      { path: "src/modified.ts", status: "modified" },
      { path: "src/renamed.ts", status: "renamed" },
      { path: "src/untracked.ts", status: "untracked" },
    ];
    const expected: ReturnType<typeof workspaceTreeEntries> = [
      ["src", { directory: true, containsChanges: true }],
      ["README.md", { directory: false }],
    ];
    for (let offset = 0; offset < files.length; offset++) {
      const rotated = [...files.slice(offset), ...files.slice(0, offset)];
      expect(workspaceTreeEntries(listing, rotated, "")).toEqual(expected);
      expect(workspaceTreeEntries(listing, rotated.reverse(), "")).toEqual(expected);
    }
    expect(workspaceTreeEntries(null, files, "src").map(([, entry]) => entry.status)).toEqual(files.map((file) => file.status));
  });
  test("every deleted ancestor is marked through three lazy inventory-only levels", () => {
    const files: GitChangedFile[] = [{ path: "gone/deep/nested/file.ts", status: "deleted" }];
    for (const [relative, name] of [["", "gone"], ["gone", "deep"], ["gone/deep", "nested"]] as const) {
      expect(workspaceTreeEntries(null, files, relative)).toEqual([
        [name, { directory: true, containsChanges: true }],
      ]);
    }
    expect(workspaceTreeEntries(null, files, "gone/deep/nested")).toEqual([
      ["file.ts", { directory: false, status: "deleted" }],
    ]);
  });
  test("a former file and its new descendants aggregate in either order", () => {
    const files: GitChangedFile[] = [
      { path: "gone", status: "deleted" },
      { path: "gone/nested/file.ts", status: "untracked" },
    ];
    const expected: ReturnType<typeof workspaceTreeEntries> = [["gone", { directory: true, containsChanges: true }]];
    expect(workspaceTreeEntries(null, files, "")).toEqual(expected);
    expect(workspaceTreeEntries(null, [...files].reverse(), "")).toEqual(expected);
  });
  test("repository and filesystem roots join once", () => {
    expect(workspaceChildPath("/", "file")).toBe("/file");
    expect(workspaceChildPath("/repo/", "src/file")).toBe("/repo/src/file");
    expect(workspaceChildPath("C:\\repo\\", "file")).toBe("C:\\repo/file");
  });
});
