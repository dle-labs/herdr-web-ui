import { expect, it } from "bun:test";
import type { GitChangesResponse } from "../../shared/protocol.ts";
import { changedWorkspacePath } from "./workspaceBrowser.ts";

const inventory: GitChangesResponse = {
  root: "/repo", revision: "test",
  files: [
    { path: "src/deleted.ts", status: "deleted" },
    { path: "src/new.ts", old_path: "src/old.ts", status: "renamed" },
    { path: "src/modified.ts", status: "modified" },
  ],
};
it("opens changed and deleted files directly in the all-changes document", () => {
  expect(changedWorkspacePath(inventory, "/repo/src/deleted.ts")).toBe("src/deleted.ts");
  expect(changedWorkspacePath(inventory, "/repo/src/modified.ts")).toBe("src/modified.ts");
  expect(changedWorkspacePath(inventory, "/repo/unchanged.ts")).toBeNull();
  expect(changedWorkspacePath(inventory, "/other/src/modified.ts")).toBeNull();
});
it("maps either side of a rename to the same section", () => {
  expect(changedWorkspacePath(inventory, "/repo/src/new.ts")).toBe("src/new.ts");
  expect(changedWorkspacePath(inventory, "/repo/src/old.ts")).toBe("src/new.ts");
});
it("matches Windows paths without confusing directory prefixes", () => {
  const windows = { ...inventory, root: "C:\\repo" };
  expect(changedWorkspacePath(windows, "C:\\repo\\src\\old.ts")).toBe("src/new.ts");
  expect(changedWorkspacePath(windows, "C:\\repo-other\\src\\old.ts")).toBeNull();
});
