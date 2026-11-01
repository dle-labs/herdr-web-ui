import { expect, it } from "bun:test";
import type { GitChangesResponse } from "../../shared/protocol.ts";
import { changedMarkdownPreviewPath, changedWorkspacePath, workspacePreviewPath } from "./workspaceBrowser.ts";

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
it("previews untracked, staged-added and modified Markdown when browsing, but not when reviewing changes", () => {
  const markdown: GitChangesResponse = { ...inventory, files: [
    { path: "docs/new.md", status: "untracked" },
    { path: "docs/added.MD", status: "added" },
    { path: "docs/edited.markdown", status: "modified" },
  ] };
  for (const file of markdown.files) {
    const absolute = `/repo/${file.path}`;
    expect(changedMarkdownPreviewPath(markdown, file.path)).toBe(absolute);
    expect(workspacePreviewPath(markdown, absolute, "browse")).toBe(absolute);
    expect(workspacePreviewPath(markdown, absolute, "changes")).toBeNull();
  }
});

it("keeps deleted, binary and non-Markdown changes in Diff, while unchanged files still preview", () => {
  const markdown: GitChangesResponse = { ...inventory, files: [
    ...inventory.files,
    { path: "docs/deleted.md", status: "deleted" },
    { path: "docs/binary.md", status: "modified", binary: true },
  ] };
  for (const path of ["docs/deleted.md", "docs/binary.md", "src/modified.ts", "missing.md"]) {
    expect(changedMarkdownPreviewPath(markdown, path)).toBeNull();
  }
  for (const path of ["docs/deleted.md", "docs/binary.md", "src/modified.ts"]) {
    expect(workspacePreviewPath(markdown, `/repo/${path}`, "browse")).toBeNull();
  }
  for (const intent of ["browse", "changes"] as const) {
    expect(workspacePreviewPath(markdown, "/repo/unchanged.md", intent)).toBe("/repo/unchanged.md");
  }
});

it("does not substitute a rename's new Markdown contents for an old-path link", () => {
  const markdown: GitChangesResponse = { ...inventory, files: [{ path: "new.md", old_path: "old.md", status: "renamed" }] };
  expect(workspacePreviewPath(markdown, "/repo/new.md", "browse")).toBe("/repo/new.md");
  expect(workspacePreviewPath(markdown, "/repo/old.md", "browse")).toBeNull();
  expect(changedMarkdownPreviewPath(markdown, "new.md")).toBe("/repo/new.md");
});

it("keeps changed media playable when browsing, with changes and deleted paths still opening diffs", () => {
  for (const path of ["clip.webm", "photo.PNG", "voice.mp3", "manual.pdf"]) {
    const media: GitChangesResponse = { ...inventory, files: [{ path, status: "untracked", binary: true }] };
    expect(workspacePreviewPath(media, `/repo/${path}`, "browse")).toBe(`/repo/${path}`);
    expect(workspacePreviewPath(media, `/repo/${path}`, "changes")).toBeNull();
    media.files[0]!.status = "deleted";
    expect(workspacePreviewPath(media, `/repo/${path}`, "browse")).toBeNull();
    media.files[0] = { path, old_path: "old.webm", status: "renamed", binary: true };
    expect(workspacePreviewPath(media, "/repo/old.webm", "browse")).toBeNull();
  }
});

it("preserves explicit file-link previews for current source, while deleted and old rename links show diffs", () => {
  expect(workspacePreviewPath(inventory, "/repo/src/modified.ts", "preview")).toBe("/repo/src/modified.ts");
  expect(workspacePreviewPath(inventory, "/repo/src/new.ts", "preview")).toBe("/repo/src/new.ts");
  expect(workspacePreviewPath(inventory, "/repo/src/old.ts", "preview")).toBeNull();
  expect(workspacePreviewPath(inventory, "/repo/src/deleted.ts", "preview")).toBeNull();
  expect(workspacePreviewPath(inventory, "/repo/src/modified.ts", "browse")).toBeNull();
});

it("previews Windows Markdown paths without mixing repository prefixes", () => {
  const markdown: GitChangesResponse = { ...inventory, root: "C:\\repo", files: [{ path: "docs/new.md", status: "untracked" }] };
  expect(workspacePreviewPath(markdown, "C:\\repo\\docs\\new.md", "browse")?.replace(/\\/g, "/")).toBe("C:/repo/docs/new.md");
  expect(workspacePreviewPath(markdown, "C:\\repo\\docs\\new.md", "changes")).toBeNull();
  expect(changedWorkspacePath(markdown, "C:\\repo-other\\docs\\new.md")).toBeNull();
});

it("matches Windows paths without confusing directory prefixes", () => {
  const windows = { ...inventory, root: "C:\\repo" };
  expect(changedWorkspacePath(windows, "C:\\repo\\src\\old.ts")).toBe("src/new.ts");
  expect(changedWorkspacePath(windows, "C:\\repo-other\\src\\old.ts")).toBeNull();
});
