import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDiffError, gitChanges, gitFileDiff } from "./git-diff.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
function repository(commit = true): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-git-diff-unit-"));
  owned.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "file.txt"), "base\n");
  if (commit) { git(root, "add", "."); git(root, "commit", "-qm", "fixture"); }
  return root;
}
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
async function fault(run: Promise<unknown>, code: string): Promise<void> {
  try { await run; throw new Error("Expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(GitDiffError); expect((error as GitDiffError).code).toBe(code); }
}

describe("read-only Git changes", () => {
  it("compares all HEAD→working, unstaged index→working and staged HEAD→index", async () => {
    const root = repository();
    writeFileSync(join(root, "file.txt"), "index\n"); git(root, "add", ".");
    writeFileSync(join(root, "file.txt"), "working\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const index = readFileSync(join(root, ".git", "index"));
    const head = git(root, "rev-parse", "HEAD");
    for (const [mode, oldText, newText] of [["all", "base\n", "working\n"], ["unstaged", "index\n", "working\n"], ["staged", "base\n", "index\n"]] as const) {
      const listing = await gitChanges(root, mode);
      expect(listing.root).toBe(root);
      expect(listing.files).toContainEqual({ path: "file.txt", status: "modified" });
      expect(listing.files.some((file) => file.status === "untracked")).toBe(mode !== "staged");
      const diff = await gitFileDiff(root, mode, "file.txt");
      expect(diff.revision).toBe(listing.revision);
      expect(diff.old_file).toEqual({ name: "file.txt", contents: oldText });
      expect(diff.new_file).toEqual({ name: "file.txt", contents: newText });
      expect(diff.patch).toContain(`-${oldText}`); expect(diff.patch).toContain(`+${newText}`);
    }
    expect(readFileSync(join(root, ".git", "index"))).toEqual(index);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
  it("supports unborn HEAD and accurate absent sides", async () => {
    const root = repository(false);
    expect((await gitFileDiff(root, "all", "file.txt")).old_file).toBeNull();
    git(root, "add", ".");
    const staged = await gitFileDiff(root, "staged", "file.txt");
    expect(staged.old_file).toBeNull(); expect(staged.new_file?.contents).toBe("base\n");
    expect((await gitChanges(root, "unstaged")).files).toEqual([]);
    unlinkSync(join(root, "file.txt"));
    const deleted = await gitFileDiff(root, "unstaged", "file.txt");
    expect(deleted.old_file?.contents).toBe("base\n"); expect(deleted.new_file).toBeNull();
  });
  it("uses NUL metadata and literal paths for spaces, tabs, newlines and pathspec magic", async () => {
    const root = repository();
    for (const path of ["space name", "tab\tname", "line\nname", ":(glob)*", "-option"]) {
      writeFileSync(join(root, path), "one\n"); git(root, "add", "--", `./${path}`);
    }
    git(root, "commit", "-qm", "names");
    for (const path of ["space name", "tab\tname", "line\nname", ":(glob)*", "-option"]) {
      writeFileSync(join(root, path), "two\n");
      expect((await gitFileDiff(root, "all", path)).new_file?.contents).toBe("two\n");
    }
  });
  it("preserves rename identities and deletions", async () => {
    const root = repository();
    renameSync(join(root, "file.txt"), join(root, "renamed.txt")); git(root, "add", "-A");
    expect((await gitChanges(root, "all")).files).toEqual([{ path: "renamed.txt", old_path: "file.txt", status: "renamed" }]);
    const diff = await gitFileDiff(root, "staged", "renamed.txt");
    expect(diff.old_file?.name).toBe("file.txt"); expect(diff.new_file?.name).toBe("renamed.txt");
    unlinkSync(join(root, "renamed.txt"));
    const deleted = await gitFileDiff(root, "all", "file.txt");
    expect(deleted.new_file).toBeNull(); expect(deleted.old_file?.contents).toBe("base\n");
  });
  it("represents untracked empty files, no final newline and binary presence", async () => {
    const root = repository();
    writeFileSync(join(root, "empty"), "");
    writeFileSync(join(root, "no-newline"), "hello");
    writeFileSync(join(root, "binary"), Buffer.from([0, 255]));
    expect((await gitFileDiff(root, "all", "empty")).new_file).toEqual({ name: "empty", contents: "" });
    expect((await gitFileDiff(root, "all", "no-newline")).patch).toContain("\\ No newline at end of file");
    const binary = await gitFileDiff(root, "all", "binary");
    expect(binary.binary).toBe(true); expect(binary.old_file).toBeNull(); expect(binary.new_file).toEqual({ name: "binary", contents: "" });
  });
  it("rejects arbitrary paths, traversal, not-repositories and oversized content", async () => {
    const root = repository();
    await fault(gitFileDiff(root, "all", "../secret"), "invalid_path");
    await fault(gitFileDiff(root, "all", "/etc/passwd"), "invalid_path");
    await fault(gitFileDiff(root, "all", "file.txt"), "git_path_not_changed");
    await fault(gitChanges(join(root, ".git"), "all"), "not_git_repository");
    writeFileSync(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await fault(gitFileDiff(root, "all", "large"), "git_too_large");
  });
  it("reads file symlinks as link text and refuses directory symlink escapes", async () => {
    if (process.platform === "win32") return;
    const root = repository();
    symlinkSync("/etc/passwd", join(root, "link"));
    const diff = await gitFileDiff(root, "all", "link");
    expect(diff.new_file?.contents).toBe("/etc/passwd"); expect(diff.patch).not.toContain("root:");
    mkdirSync(join(root, "dir")); writeFileSync(join(root, "dir", "nested"), "test\n"); git(root, "add", "."); git(root, "commit", "-qm", "nested");
    rmSync(join(root, "dir"), { recursive: true }); symlinkSync("/etc", join(root, "dir"));
    await fault(gitChanges(root, "all"), "git_unsafe_path");
  });
  it("marks unmerged files explicitly in every mode and refuses misleading two-side diffs", async () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD:file.txt").trim();
    const input = `100644 ${base} 1\tfile.txt\n100644 ${base} 2\tfile.txt\n100644 ${base} 3\tfile.txt\n`;
    const proc = Bun.spawnSync(["git", "update-index", "--index-info"], { cwd: root, stdin: Buffer.from(input) });
    expect(proc.exitCode).toBe(0);
    writeFileSync(join(root, "file.txt"), "<<<<<<< ours\nconflict\n=======\nother\n>>>>>>> theirs\n");
    for (const mode of ["all", "staged", "unstaged"] as const) {
      expect((await gitChanges(root, mode)).files).toEqual([{ path: "file.txt", status: "conflicted" }]);
      await fault(gitFileDiff(root, mode, "file.txt"), "git_conflict");
    }
  });
  it("fingerprints working edits without changing the staged fingerprint", async () => {
    const root = repository();
    writeFileSync(join(root, "file.txt"), "index\n"); git(root, "add", ".");
    const staged = await gitChanges(root, "staged"); const all = await gitChanges(root, "all");
    writeFileSync(join(root, "file.txt"), "different\n");
    expect((await gitChanges(root, "all")).revision).not.toBe(all.revision);
    expect((await gitChanges(root, "staged")).revision).toBe(staged.revision);
  });
  it("honors Git binary attributes without treating their patch as text", async () => {
    const root = repository();
    writeFileSync(join(root, ".gitattributes"), "file.txt -diff\n");
    writeFileSync(join(root, "file.txt"), "changed text\n");
    const diff = await gitFileDiff(root, "all", "file.txt");
    expect(diff.binary).toBe(true); expect(diff.patch).toContain("Binary files");
    expect(diff.old_file?.contents).toBe(""); expect(diff.new_file?.contents).toBe("");
  });
  it("allowlists both remote GET paths without widening unrelated routes", () => {
    expect(MACHINE_PROXY_PATH.test("workspace/changes")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("workspace/diff")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("workspace/stage")).toBe(false);
  });
});
