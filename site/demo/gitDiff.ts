import type { GitChangedFile, GitChangesResponse, GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";

/** Fictional read-only repository snapshots, shared by the demo and browser checks. */
const greetingOld = 'export function greeting(name: string) {\n  return `Hi, ${name}`;\n}\n';
const greetingNew = 'export function greeting(name: string) {\n  return `Hello, ${name}!`;\n}\n';
const added = 'export const version = "demo";\n';
export function demoGitChanges(root: string, mode: GitDiffMode): GitChangesResponse {
  const files: GitChangedFile[] = [{ path: "src/greeting.ts", status: "modified" }];
  if (mode !== "staged") files.push({ path: "src/new.ts", status: "untracked" });
  return { root, revision: `demo-git-${mode}-1`, files };
}
export function demoGitDiff(root: string, mode: GitDiffMode, path: string): GitFileDiffResponse | null {
  if (!demoGitChanges(root, mode).files.some((file) => file.path === path)) return null;
  const newFile = path === "src/new.ts";
  return {
    root, revision: `demo-git-${mode}-1`, path, binary: false,
    old_file: newFile ? null : { name: path, contents: greetingOld },
    new_file: { name: path, contents: newFile ? added : greetingNew },
    patch: newFile ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${added}` :
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n export function greeting(name: string) {\n-  return \`Hi, \${name}\`;\n+  return \`Hello, \${name}!\`;\n }\n`,
  };
}
