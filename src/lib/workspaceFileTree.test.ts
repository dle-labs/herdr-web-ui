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
  test("repository and filesystem roots join once", () => {
    expect(workspaceChildPath("/", "file")).toBe("/file");
    expect(workspaceChildPath("/repo/", "src/file")).toBe("/repo/src/file");
    expect(workspaceChildPath("C:\\repo\\", "file")).toBe("C:\\repo/file");
  });
});
