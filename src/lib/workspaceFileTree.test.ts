import { describe, expect, test } from "bun:test";
import type { DirectoryListing } from "../../shared/protocol.ts";
import { workspaceChildPath, workspaceTreeEntries } from "./workspaceFileTree.ts";

const listing: DirectoryListing = { path: "/repo", parent: "/", home: "/home/user", directories: ["src"], files: [{ name: "README.md", size: 20 }], truncated: false };

describe("workspace tree", () => {
  test("non-Git folders retain all files and directories", () => {
    expect(workspaceTreeEntries(listing, [], "")).toEqual([["src", { directory: true }], ["README.md", { directory: false }]]);
  });
  test("deleted paths provide missing ancestor folders and leaves", () => {
    const files = [{ path: "gone/deep/file.ts", status: "deleted" as const }];
    expect(workspaceTreeEntries(null, files, "")).toEqual([["gone", { directory: true, status: "deleted" }]]);
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
      ["src", { directory: true, ignored: true, status: "deleted" }],
      ["README.md", { directory: false }],
    ]);
  });
  test("ignored status propagates to disk and inventory-only children", () => {
    expect(workspaceTreeEntries(listing, [{ path: "gone/file.ts", status: "deleted" }], "", true)).toEqual([
      ["gone", { directory: true, ignored: true, status: "deleted" }],
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
      "src", { directory: true, status: "deleted" },
    ]);
  });
  test("repository and filesystem roots join once", () => {
    expect(workspaceChildPath("/", "file")).toBe("/file");
    expect(workspaceChildPath("/repo/", "src/file")).toBe("/repo/src/file");
    expect(workspaceChildPath("C:\\repo\\", "file")).toBe("C:\\repo/file");
  });
});
