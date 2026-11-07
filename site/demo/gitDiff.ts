import type { GitChangedFile, GitChangesResponse, GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";

export const DEMO_COMMITS = [
  { id: "a".repeat(40), subject: "Add a friendly greeting", author: "Alex Demo", date: "2026-01-02T12:00:00Z" },
  { id: "b".repeat(40), subject: "Initialize the demo project", author: "Sam Example", date: "2026-01-01T12:00:00Z" },
];

/** Fictional read-only repository snapshots, shared by the demo and browser checks. */
const greetingOld = 'export function greeting(name: string) {\n  return `Hi, ${name}`;\n}\n';
const greetingNew = 'export function greeting(name: string) {\n  return `Hello, ${name}!`;\n}\n';
const added = 'export const version = "demo";\n';
export function demoGitChanges(root: string, mode: GitDiffMode, baseCommit?: string): GitChangesResponse {
  const files: GitChangedFile[] = [{ path: "src/greeting.ts", status: baseCommit === DEMO_COMMITS[1]!.id ? "added" : "modified" }];
  if (mode !== "staged") files.push({ path: "src/new.ts", status: "untracked" });
  return { root, revision: `demo-git-${mode}-${baseCommit ?? "1"}`, ...(baseCommit ? { base_commit: baseCommit } : {}), files };
}
export function demoGitDiff(root: string, mode: GitDiffMode, path: string, baseCommit?: string): GitFileDiffResponse | null {
  const changes = demoGitChanges(root, mode, baseCommit);
  if (!changes.files.some((file) => file.path === path)) return null;
  const newFile = path === "src/new.ts";
  if (!newFile && baseCommit === DEMO_COMMITS[1]!.id) return {
    root, revision: changes.revision, base_commit: baseCommit, path, binary: false,
    old_file: null, new_file: { name: path, contents: greetingNew },
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,3 @@\n${greetingNew.trimEnd().split("\n").map((line) => `+${line}\n`).join("")}`,
  };
  return {
    root, revision: changes.revision, ...(baseCommit ? { base_commit: baseCommit } : {}), path, binary: false,
    old_file: newFile ? null : { name: path, contents: greetingOld },
    new_file: { name: path, contents: newFile ? added : greetingNew },
    patch: newFile ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${added}` :
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n export function greeting(name: string) {\n-  return \`Hi, \${name}\`;\n+  return \`Hello, \${name}!\`;\n }\n`,
  };
}
