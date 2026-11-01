import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommits, workspaceFiles } from "./workspace-search.ts";
import { DEMO_COMMITS, demoGitChanges, demoGitDiff } from "../site/demo/gitDiff.ts";

const owned: string[] = [];
afterEach(() => { for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-workspace-search-")); owned.push(root); return root;
}
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fictional Author", "-c", "user.email=author@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
it("lists repository-relative tracked and untracked files from a nested cwd, with fuzzy matching and literal queries", async () => {
  const root = directory(); git(root, "init", "-q"); mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(root, "src", "greeting.ts"), "hello"); git(root, "add", ".");
  writeFileSync(join(root, "new.txt"), "new"); writeFileSync(join(root, "ignored.txt"), "secret");
  const listing = await workspaceFiles(join(root, "src"));
  expect(listing.root).toBe(root); expect(listing.truncated).toBe(false);
  expect(listing.files).toEqual([".gitignore", "new.txt", "src/greeting.ts"]);
  expect((await workspaceFiles(root, "sgt")).files).toEqual(["src/greeting.ts"]);
  expect((await workspaceFiles(root, "--output=x; echo unsafe")).files).toEqual([]);
  for (let i = 0; i < 105; i++) writeFileSync(join(root, `extra-${i}.txt`), "");
  expect((await workspaceFiles(root)).files).toHaveLength(100);
  expect((await workspaceFiles(root)).truncated).toBe(true);
  expect((await workspaceFiles(root, "greeting")).truncated).toBe(false);
});
it("walks nonrepositories without following symlinks or dependency/Git folders and reports depth truncation", async () => {
  const root = directory(); const outside = directory();
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(root, "safe.txt"), "safe");
  for (const name of [".git", "node_modules"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "hidden.txt"), ""); }
  if (process.platform !== "win32") { symlinkSync(outside, join(root, "link")); symlinkSync(join(outside, "secret.txt"), join(root, "file-link")); }
  expect(await workspaceFiles(root)).toEqual({ root, files: ["safe.txt"], truncated: false });
  mkdirSync(join(root, ...Array(14).fill("deep")), { recursive: true });
  expect((await workspaceFiles(root, "not-found")).truncated).toBe(true);
});
it("searches only reachable HEAD history, safely filters subject/hash, and handles unborn repositories", async () => {
  const root = directory(); git(root, "init", "-q");
  expect(await gitCommits(root)).toEqual({ commits: [], truncated: false });
  git(root, "commit", "--allow-empty", "-qm", "First fictional subject");
  const first = git(root, "rev-parse", "HEAD");
  git(root, "commit", "--allow-empty", "-qm", "Second subject");
  const second = git(root, "rev-parse", "HEAD");
  const listing = await gitCommits(root);
  expect(listing.truncated).toBe(false); expect(listing.commits.map((c) => c.id)).toEqual([second, first]);
  expect(listing.commits[0]?.author).toBe("Fictional Author"); expect(Date.parse(listing.commits[0]!.date)).not.toBeNaN();
  expect((await gitCommits(root, "fictional")).commits.map((c) => c.id)).toEqual([first]);
  expect((await gitCommits(root, first.slice(0, 9))).commits.map((c) => c.id)).toEqual([first]);
  expect((await gitCommits(root, "--all; touch bad")).commits).toEqual([]);
  expect((await gitCommits(root, first)).commits.map((c) => c.id)).toEqual([first]);
  expect((await gitCommits(root, first.slice(0, 9).toUpperCase())).commits.map((c) => c.id)).toEqual([first]);
  expect((await gitCommits(root, "HEAD~1")).commits).toEqual([]);
  expect((await gitCommits(root, ".*")).commits).toEqual([]);
  expect((await gitCommits(root, git(root, "rev-parse", "HEAD^{tree}"))).commits).toEqual([]);
  git(root, "reset", "--hard", first);
  expect((await gitCommits(root)).commits.map((c) => c.id)).toEqual([first]);
  expect(await gitCommits(root, second)).toEqual({ commits: [], truncated: false });
  expect(await gitCommits(root, second.slice(0, 9))).toEqual({ commits: [], truncated: false });
});
it("searches matching subjects beyond 500 commits and caps matching results, not inspected history", async () => {
  const root = directory(); git(root, "init", "-q"); git(root, "commit", "--allow-empty", "-qm", "Ancient searchable subject [literal.*]");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const first = git(root, "rev-parse", "HEAD");
  let parent = first;
  for (let i = 0; i < 501; i++) parent = git(root, "commit-tree", tree, "-p", parent, "-m", `item ${i}`);
  git(root, "update-ref", "HEAD", parent);
  const listing = await gitCommits(root);
  expect(listing.commits).toHaveLength(100); expect(listing.truncated).toBe(true);
  expect(await gitCommits(root, "unmatched")).toEqual({ commits: [], truncated: false });
  const old = await gitCommits(root, "ANCIENT SEARCHABLE");
  expect(old.commits.map((commit) => commit.id)).toEqual([first]); expect(old.truncated).toBe(false);
  expect((await gitCommits(root, "[literal.*]")).commits.map((commit) => commit.id)).toEqual([first]);
  expect((await gitCommits(root, first.slice(0, 9))).commits.map((commit) => commit.id)).toEqual([first]);
  const many = await gitCommits(root, "item");
  expect(many.commits).toHaveLength(100); expect(many.truncated).toBe(true);
  const refined = await gitCommits(root, "item 10");
  // item 10 and item 100..109 are all found, despite being deep in history.
  expect(refined.commits).toHaveLength(11); expect(refined.truncated).toBe(false);
});
it("treats option-like text as a literal message filter and rejects NUL before spawning Git", async () => {
  const root = directory(); git(root, "init", "-q");
  git(root, "commit", "--allow-empty", "-qm", "literal --all; touch bad [a-z]+", "-m", "Body-only searchable text");
  expect((await gitCommits(root, "--all; touch bad")).commits).toHaveLength(1);
  expect((await gitCommits(root, "[a-z]+")).commits).toHaveLength(1);
  expect((await gitCommits(root, "BODY-ONLY SEARCHABLE")).commits).toHaveLength(1);
  await expect(gitCommits(root, "bad\0query")).rejects.toMatchObject({ code: "invalid_query" });
});
it("caps commit output bytes without returning a partial commit record", async () => {
  const root = directory(); git(root, "init", "-q"); git(root, "commit", "--allow-empty", "-qm", "start");
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const created = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit-tree", tree], { stdin: Buffer.from("x".repeat(9 * 1024 * 1024)) });
  expect(created.exitCode).toBe(0);
  git(root, "update-ref", "HEAD", created.stdout.toString().trim());
  expect(await gitCommits(root)).toEqual({ commits: [], truncated: true });
});
it("demo choices produce distinct meaningful selected-base snapshots", () => {
  const base = DEMO_COMMITS[1]!.id;
  const changes = demoGitChanges("/fictional", "all", base);
  const diff = demoGitDiff("/fictional", "all", "src/greeting.ts", base)!;
  expect(changes.base_commit).toBe(base); expect(diff.revision).toBe(changes.revision);
  expect(changes.files[0]?.status).toBe("added"); expect(diff.old_file).toBeNull();
  expect(diff.patch).toContain("--- /dev/null");
  expect(demoGitDiff("/fictional", "all", "src/greeting.ts", DEMO_COMMITS[0]!.id)?.old_file).not.toBeNull();
});
