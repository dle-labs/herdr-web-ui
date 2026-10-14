import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";

import type { ApiError, RepoDiffFileList, RepoDiffFilePatch } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { REPO_DIFF_CONTEXT_LINES, REPO_DIFF_MAX_FILES, REPO_DIFF_MAX_LIST_BYTES, REPO_DIFF_MAX_PATCH_BYTES, repoDiffCommits, repoDiffFile, repoDiffFiles } from "./repo-diff.ts";

/**
 * Real git repositories in a temp folder: the routes are only as right as what git prints, so a
 * stand-in git would prove nothing here. The developer's own git configuration is kept out, for
 * the fixtures and for the code under test alike.
 */
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-diff-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}

const query = (values: Record<string, string> = {}) => new URLSearchParams(values);
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");
/** What Pierre makes of a patch: the parser the diff view uses, told to throw on anything malformed. */
const parsed = (patch: string | null) => parsePatchFiles(patch ?? "", undefined, true).flatMap((entry) => entry.files);

const UNICODE = "dir with space/ünï 文件.txt";

describe("workspace and staged changes", () => {
  let root: string;
  beforeAll(() => {
    root = repository("changes");
    mkdirSync(join(root, "dir with space"));
    writeFileSync(join(root, "keep.txt"), "a\nb\nc\n");
    writeFileSync(join(root, "gone.txt"), "going\n");
    writeFileSync(join(root, "moved-from.txt"), lines(12));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(root, UNICODE), "eins\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    // staged: a rename with an edit, and a new file
    git(root, "mv", "moved-from.txt", "moved-to.txt");
    writeFileSync(join(root, "moved-to.txt"), lines(12).replace("line 3\n", "line three\n"));
    writeFileSync(join(root, "staged-new.txt"), "fresh\n");
    git(root, "add", "moved-to.txt", "staged-new.txt");
    // unstaged
    writeFileSync(join(root, "keep.txt"), "a\nB\nc\nd\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([9, 0, 9, 0]));
    writeFileSync(join(root, UNICODE), "zwei\n");
    writeFileSync(join(root, "new file.txt"), "one\ntwo\n");
    writeFileSync(join(root, "blob.bin"), new Uint8Array([1, 0, 2, 0]));
  });

  it("lists unstaged and untracked files with status, counts and the repository they are in", async () => {
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: "main", head: git(root, "rev-parse", "HEAD").trim(), detached: false, unborn: false });
    expect(list).toMatchObject({ scope: "workspace", base: null, head: null, total: 6, truncated: false, limits: { max_files: REPO_DIFF_MAX_FILES, max_list_bytes: REPO_DIFF_MAX_LIST_BYTES } });
    expect(list.files).toEqual([
      { path: "blob.bin", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: UNICODE, old_path: null, status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "gone.txt", old_path: null, status: "deleted", additions: 0, deletions: 1, binary: false },
      { path: "keep.txt", old_path: null, status: "modified", additions: 2, deletions: 1, binary: false },
      { path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: "pic.bin", old_path: null, status: "modified", additions: null, deletions: null, binary: true },
    ]);
  });

  it("answers the same list from a folder below the repository's top", async () => {
    const list = await repoDiffFiles(join(root, "dir with space"), query());
    expect(list.repository.root).toBe(root);
    expect(list.files.map((file) => file.path)).toContain("keep.txt");
  });

  it("lists staged files apart, a rename with where it came from", async () => {
    const list = await repoDiffFiles(root, query({ scope: "staged" }));
    expect(list.files).toEqual([
      { path: "moved-to.txt", old_path: "moved-from.txt", status: "renamed", additions: 1, deletions: 1, binary: false },
      { path: "staged-new.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("gives each text file one whole patch Pierre parses: edit, deletion, untracked, addition, rename", async () => {
    const edit = await repoDiffFile(root, query({ path: "keep.txt" }));
    expect(edit).toMatchObject({ unavailable: null, truncated: false, file: { path: "keep.txt", status: "modified", additions: 2, deletions: 1 }, limits: { max_patch_bytes: REPO_DIFF_MAX_PATCH_BYTES, context_lines: REPO_DIFF_CONTEXT_LINES } });
    expect(edit.patch).toStartWith("diff --git a/keep.txt b/keep.txt\n");
    expect(parsed(edit.patch).map((file) => [file.name, file.type, file.hunks.length])).toEqual([["keep.txt", "change", 1]]);

    const deleted = await repoDiffFile(root, query({ path: "gone.txt" }));
    expect(parsed(deleted.patch).map((file) => [file.name, file.type])).toEqual([["gone.txt", "deleted"]]);

    const untracked = await repoDiffFile(root, query({ path: "new file.txt" }));
    expect(untracked.file).toEqual({ path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: false });
    expect(parsed(untracked.patch).map((file) => [file.name, file.type, file.additionLines])).toEqual([["new file.txt", "new", ["one\n", "two\n"]]]);

    const added = await repoDiffFile(root, query({ scope: "staged", path: "staged-new.txt" }));
    expect(parsed(added.patch).map((file) => [file.name, file.type])).toEqual([["staged-new.txt", "new"]]);

    const renamed = await repoDiffFile(root, query({ scope: "staged", path: "moved-to.txt", old_path: "moved-from.txt" }));
    expect(renamed.file).toMatchObject({ status: "renamed", old_path: "moved-from.txt" });
    expect(parsed(renamed.patch).map((file) => [file.name, file.prevName, file.type])).toEqual([["moved-to.txt", "moved-from.txt", "rename-changed"]]);
  });

  it("keeps a path with spaces and non-ASCII letters as it is, in the list and in the patch", async () => {
    const answer = await repoDiffFile(root, query({ path: UNICODE }));
    expect(answer.file.path).toBe(UNICODE);
    expect(answer.patch).toStartWith(`diff --git a/${UNICODE} b/${UNICODE}\n`);
    expect(parsed(answer.patch).map((file) => [file.name, file.deletionLines, file.additionLines])).toEqual([[UNICODE, ["eins\n"], ["zwei\n"]]]);
  });

  it("says a binary file is binary instead of sending a patch, tracked or not", async () => {
    for (const path of ["pic.bin", "blob.bin"]) {
      const answer = await repoDiffFile(root, query({ path }));
      expect(answer).toMatchObject({ patch: null, unavailable: "binary", truncated: false, file: { path, binary: true } });
    }
  });

  it("refuses a path that is not one inside the repository, and one where nothing changed", async () => {
    for (const path of ["", "../outside.txt", "/etc/hosts", "a//b", "dir/../keep.txt", "./keep.txt", "keep.txt\0", "C:/outside.txt", "dir\\outside.txt"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    }
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: "../x" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    // pathspec magic and globs are read as plain names
    for (const path of ["staged-new.txt", "*.txt", ":(glob)**", ":/keep.txt"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("refuses an unknown scope, and revisions outside the commit scope", async () => {
    await expect(repoDiffFiles(root, query({ scope: "everything" }))).rejects.toMatchObject({ code: "invalid_scope", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "staged", base: "HEAD" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
  });

  it("refuses an unrelated old path instead of returning another file's patch first", async () => {
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: UNICODE }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
  });

  it("refuses stale rename metadata after the original path is reused", async () => {
    const root = repository("reused-rename-path");
    writeFileSync(join(root, "old.txt"), lines(12));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    git(root, "mv", "old.txt", "new.txt");
    writeFileSync(join(root, "old.txt"), "replacement\n");
    git(root, "add", ".");
    await expect(repoDiffFile(root, query({ scope: "staged", path: "new.txt", old_path: "old.txt" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    const answer = await repoDiffFile(root, query({ scope: "staged", path: "new.txt" }));
    expect(parsed(answer.patch).map((file) => file.name)).toEqual(["new.txt"]);
  });
});

describe("all changes and exact selected sides", () => {
  it("distinguishes HEAD/working, HEAD/index and index/working, with missing sides null", async () => {
    const root = repository("exact-sides");
    writeFileSync(join(root, "a.txt"), "head\n");
    writeFileSync(join(root, "gone.txt"), "old\n");
    writeFileSync(join(root, "bom.txt"), "\ufeffone\r\nlast");
    git(root, "add", "."); git(root, "commit", "-q", "-m", "base");
    writeFileSync(join(root, "bom.txt"), "\ufefftwo\r\nlast\n");
    writeFileSync(join(root, "a.txt"), "index\n");
    git(root, "add", "a.txt"); git(root, "rm", "gone.txt");
    writeFileSync(join(root, "a.txt"), "working\n");
    writeFileSync(join(root, "gone.txt"), "disk is not the index\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    for (const [scope, old_content, new_content] of [["all", "head\n", "working\n"], ["staged", "head\n", "index\n"], ["workspace", "index\n", "working\n"]]) {
      const list = await repoDiffFiles(root, query({ scope: scope! }));
      expect(list.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(await repoDiffFile(root, query({ scope: scope!, path: "a.txt", fingerprint: list.fingerprint! }))).toMatchObject({ old_content, new_content, fingerprint: list.fingerprint });
      expect(list.files.some((file) => file.path === "new.txt")).toBe(scope !== "staged");
    }
    expect(await repoDiffFile(root, query({ scope: "staged", path: "gone.txt" }))).toMatchObject({ old_content: "old\n", new_content: null, file: { status: "deleted" } });
    expect(await repoDiffFile(root, query({ scope: "all", path: "bom.txt" }))).toMatchObject({ old_content: "\ufeffone\r\nlast", new_content: "\ufefftwo\r\nlast\n", unavailable: null });
    const all = await repoDiffFiles(root, query({ scope: "all" }));
    writeFileSync(join(root, "a.txt"), "changed since listing\n");
    await expect(repoDiffFile(root, query({ scope: "all", path: "a.txt", fingerprint: all.fingerprint! }))).rejects.toMatchObject({ code: "stale_comparison" });
    expect((await repoDiffFiles(root, query({ scope: "all", path: "a.txt" }))).files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("compares a reachable immutable historical base to disk, and an unborn repository to the empty tree", async () => {
    const root = repository("historical-working");
    writeFileSync(join(root, "a.txt"), "first\n"); git(root, "add", "."); git(root, "commit", "-q", "-m", "first");
    const base = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "second\n"); git(root, "commit", "-q", "-am", "second");
    writeFileSync(join(root, "a.txt"), "working\n");
    expect(await repoDiffFile(root, query({ scope: "all", base, path: "a.txt" }))).toMatchObject({ base, old_content: "first\n", new_content: "working\n" });
    await expect(repoDiffFiles(root, query({ scope: "all", base: "HEAD~1" }))).rejects.toMatchObject({ code: "invalid_revision" });
    const empty = repository("all-unborn");
    writeFileSync(join(empty, "staged.txt"), "index\n"); git(empty, "add", ".");
    writeFileSync(join(empty, "new.txt"), "new\n");
    expect((await repoDiffFiles(empty, query({ scope: "all" }))).files.map((file) => [file.path, file.status])).toEqual([["new.txt", "untracked"], ["staged.txt", "added"]]);
    expect(await repoDiffFile(empty, query({ scope: "all", path: "staged.txt" }))).toMatchObject({ old_content: null, new_content: "index\n" });
    writeFileSync(join(empty, "empty.txt"), "");
    expect(await repoDiffFile(empty, query({ scope: "all", path: "empty.txt" }))).toMatchObject({ old_content: null, new_content: "", unavailable: null });
  });

  it("refuses directory symlink traversal, submodules and oversized selected text without partial contents", async () => {
    const root = repository("unsupported-sides");
    const outside = join(scratch, "outside"); mkdirSync(outside);
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a.txt"), "old\n");
    writeFileSync(join(root, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    writeFileSync(join(root, ".gitattributes"), "forced.txt diff\n");
    writeFileSync(join(root, "forced.txt"), "was text\n");
    git(root, "add", "."); git(root, "commit", "-q", "-m", "first");
    rmSync(join(root, "dir"), { recursive: true });
    writeFileSync(join(outside, "a.txt"), "secret\n");
    symlinkSync(outside, join(root, "dir"));
    writeFileSync(join(root, "large.txt"), "small\n");
    git(root, "update-index", "--add", "--cacheinfo", "160000", git(root, "rev-parse", "HEAD").trim(), "module");
    writeFileSync(join(root, "invalid-utf8.txt"), new Uint8Array([255]));
    writeFileSync(join(root, "forced.txt"), new Uint8Array([0, 1, 2]));
    expect((await repoDiffFiles(root, query({ scope: "all" }))).files.find((file) => file.path === "forced.txt")?.binary).toBeFalse();
    for (const [scope, path, unavailable] of [["all", "dir/a.txt", "unsupported"], ["staged", "module", "unsupported"], ["all", "large.txt", "too_large"], ["all", "invalid-utf8.txt", "binary"], ["all", "forced.txt", "binary"]]) {
      expect(await repoDiffFile(root, query({ scope: scope!, path: path! }))).toMatchObject({ unavailable, patch: null, old_content: null, new_content: null });
    }
  });

  it("detects a write during side reads rather than mixing old content with a later patch", async () => {
    const root = repository("mid-read");
    writeFileSync(join(root, "a.txt"), "old\n"); git(root, "add", "."); git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "initial\n");
    const wrapper = join(root, "git-fixture");
    writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *"cat-file blob"*) printf 'replacement\\n' > '${join(root, "a.txt")}' ;; esac\nexec git "$@"\n`);
    chmodSync(wrapper, 0o755);
    const result = await repoDiffFile(root, query({ scope: "all", path: "a.txt" }), { git: wrapper });
    expect(result).toMatchObject({ unavailable: "stale", patch: null, old_content: null, new_content: null });
    // Metadata alone cannot prove an atomic snapshot: also refuse hunks from a replaced/restored path.
    writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *" -U3 "*) printf 'diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-old\\n+not the selected content\\n'; exit 0 ;; esac\nexec git "$@"\n`);
    expect(await repoDiffFile(root, query({ scope: "all", path: "a.txt" }), { git: wrapper })).toMatchObject({ unavailable: "stale", patch: null, old_content: null, new_content: null });
  });
});

describe("history search", () => {
  it("searches literal case-insensitive whole messages, resolves reachable IDs, and discloses bounds", async () => {
    const root = repository("history-search");
    writeFileSync(join(root, "a.txt"), "first\n"); git(root, "add", "."); git(root, "commit", "-q", "-m", "First [literal]", "-m", "Body NEEDLE ünicode");
    const first = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "second\n"); git(root, "commit", "-q", "-am", "Second wildcard .* is literal");
    for (const q of ["needle", "ÜNICODE", "[LITERAL]", first.slice(0, 8), first]) {
      const result = await repoDiffCommits(root, query({ q }));
      expect(result.commits.map((entry) => entry.id)).toEqual([first]);
      expect(result.commits[0]).toMatchObject({ subject: "First [literal]", author: "Fixture" });
      expect(result.commits[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect((await repoDiffCommits(root, query({ q: ".*" }))).commits.map((entry) => entry.subject)).toEqual(["Second wildcard .* is literal"]);
    expect((await repoDiffCommits(root, query({ q: "Fixture" }))).commits).toEqual([]);
    expect((await repoDiffCommits(root, query({ q: "--all" }))).commits).toEqual([]);
    const unreachable = git(root, "commit-tree", "HEAD^{tree}", "-m", "unreachable message").trim();
    expect((await repoDiffCommits(root, query({ q: unreachable.slice(0, 8) }))).commits).toEqual([]);
    await expect(repoDiffFiles(root, query({ scope: "all", base: unreachable }))).rejects.toMatchObject({ code: "revision_not_found" });
    expect(await repoDiffCommits(root, query(), { maxListBytes: 80 })).toMatchObject({ truncated: true, commits: [] });
    for (let index = 0; index < 99; index += 1) git(root, "commit", "-q", "--allow-empty", "-m", `bounded ${index}`);
    const bounded = await repoDiffCommits(root, query());
    expect(bounded.commits).toHaveLength(100);
    expect(bounded.truncated).toBeTrue();
    const unborn = repository("history-unborn");
    expect(await repoDiffCommits(unborn, query())).toMatchObject({ head: null, commits: [], truncated: false });
  });
});

describe("comparing two commits", () => {
  let root: string;
  let first: string;
  let second: string;
  beforeAll(() => {
    root = repository("commits");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    first = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second");
    second = git(root, "rev-parse", "HEAD").trim();
    git(root, "tag", "v1", first);
    // uncommitted work is no part of a comparison between commits
    writeFileSync(join(root, "a.txt"), "dirty\n");
  });

  it("lists and patches what differs between the two, named as full hashes", async () => {
    const comparisons: Record<string, string>[] = [{ base: "HEAD~1" }, { base: "v1", head: "main" }, { base: first, head: second }];
    for (const revisions of comparisons) {
      const list = await repoDiffFiles(root, query({ scope: "commit", ...revisions }));
      expect(list).toMatchObject({ scope: "commit", base: first, head: second, total: 2, truncated: false });
      expect(list.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([["a.txt", "modified", 1, 0], ["b.txt", "added", 1, 0]]);
    }
    const answer = await repoDiffFile(root, query({ scope: "commit", base: first, head: second, path: "a.txt" }));
    expect(answer).toMatchObject({ base: first, head: second, unavailable: null });
    expect(parsed(answer.patch).map((file) => [file.name, file.additionLines.includes("two\n"), file.additionLines.includes("dirty\n")])).toEqual([["a.txt", true, false]]);
    expect((await repoDiffFiles(root, query({ scope: "commit", base: second, head: second }))).files).toEqual([]);
  });

  it("refuses a revision that is an option, a range or malformed, and one that names no commit", async () => {
    const marker = join(scratch, "option-ran");
    for (const base of [`--output=${marker}`, "-p", "HEAD..main", "HEAD:a.txt", "HEAD main", "", "x".repeat(201)]) {
      await expect(repoDiffFiles(root, query({ scope: "commit", base }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    }
    expect(existsSync(marker)).toBeFalse();
    await expect(repoDiffFiles(root, query({ scope: "commit" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "no-such-branch" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFile(root, query({ scope: "commit", base: first, head: "deadbeef", path: "a.txt" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
  });
});

describe("repositories in an unusual state", () => {
  it("reads a repository with no commit yet: nothing, then untracked, then staged", async () => {
    const root = repository("unborn");
    const empty = await repoDiffFiles(root, query());
    expect(empty.repository).toEqual({ root, branch: "main", head: null, detached: false, unborn: true });
    expect(empty).toMatchObject({ files: [], total: 0, truncated: false });
    writeFileSync(join(root, "first.txt"), "hello\n");
    expect((await repoDiffFiles(root, query())).files.map((file) => [file.path, file.status])).toEqual([["first.txt", "untracked"]]);
    git(root, "add", "first.txt");
    expect((await repoDiffFiles(root, query({ scope: "staged" }))).files).toEqual([{ path: "first.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }]);
    const staged = await repoDiffFile(root, query({ scope: "staged", path: "first.txt" }));
    expect(parsed(staged.patch).map((file) => [file.name, file.type])).toEqual([["first.txt", "new"]]);
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "HEAD" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
  });

  it("reads a detached HEAD and a clean tree", async () => {
    const root = repository("detached");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "--detach");
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: null, head, detached: true, unborn: false });
    expect(list).toMatchObject({ files: [], total: 0, truncated: false });
  });

  it("says a folder outside any repository is not one, and that a conflicted file has no unified patch", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    await expect(repoDiffFiles(plain, query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFile(plain, query({ path: "a.txt" }))).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFiles(join(scratch, "missing"), query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });

    const root = repository("conflict");
    writeFileSync(join(root, "c.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "side");
    writeFileSync(join(root, "c.txt"), "side\n");
    git(root, "commit", "-q", "-a", "-m", "side");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "c.txt"), "main\n");
    git(root, "commit", "-q", "-a", "-m", "main");
    expect(Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, "merge", "side"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(1);
    expect((await repoDiffFiles(root, query())).files).toEqual([{ path: "c.txt", old_path: null, status: "unmerged", additions: null, deletions: null, binary: null }]);
    for (const scope of ["workspace", "all", "staged"]) {
      expect((await repoDiffFiles(root, query({ scope }))).files.find((file) => file.path === "c.txt")?.status).toBe("unmerged");
      expect(await repoDiffFile(root, query({ scope, path: "c.txt" }))).toMatchObject({ patch: null, unavailable: "unmerged", truncated: false });
    }
  });
});

describe("bounds", () => {
  let root: string;
  const names = Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
  beforeAll(() => {
    root = repository("bounds");
    writeFileSync(join(root, "big.txt"), lines(400));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "big.txt"), lines(400, "changed"));
    for (const name of names) writeFileSync(join(root, name), "x\n");
  });

  it("cuts a list at the file cap and says how many there were", async () => {
    const list = await repoDiffFiles(root, query(), { maxFiles: 5 });
    expect(list).toMatchObject({ total: 31, truncated: true, limits: { max_files: 5 } });
    expect(list.files.map((file) => file.path)).toEqual(["big.txt", ...names.slice(0, 4)]);
  });

  it("cuts a list at the byte cap on a whole name, with the total unknown", async () => {
    const list = await repoDiffFiles(root, query(), { maxListBytes: 64 });
    expect(list).toMatchObject({ total: null, truncated: true, limits: { max_list_bytes: 64 } });
    expect(list.fingerprint).toBeUndefined();
    await expect(repoDiffFile(root, query({ path: "big.txt" }), { maxListBytes: 64 })).rejects.toMatchObject({ code: "incomplete_comparison", status: 413 });
    expect(list.files.length).toBeGreaterThan(0);
    expect(list.files.length).toBeLessThan(31);
    for (const file of list.files) expect(["big.txt", ...names]).toContain(file.path);
  });

  it("sends no part of a patch past the cap, for a tracked and an untracked file", async () => {
    const whole = await repoDiffFile(root, query({ path: "big.txt" }));
    expect(parsed(whole.patch).map((file) => [file.name, file.additionLines.length])).toEqual([["big.txt", 400]]);
    const capped = await repoDiffFile(root, query({ path: "big.txt" }), { maxPatchBytes: 512 });
    expect(capped).toMatchObject({ patch: null, unavailable: "too_large", truncated: true, file: { path: "big.txt", additions: 400, deletions: 400 }, limits: { max_patch_bytes: 512 } });
    writeFileSync(join(root, "f00.txt"), lines(200));
    expect(await repoDiffFile(root, query({ path: "f00.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
    // the file fits and its patch (headers, a `+` per line) does not
    writeFileSync(join(root, "f01.txt"), "y\n".repeat(250));
    expect(await repoDiffFile(root, query({ path: "f01.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
  });

  it("does not follow an untracked link out of the repository", async () => {
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "do not read\n");
    symlinkSync(secret, join(root, "link.txt"));
    const link = await repoDiffFile(root, query({ path: "link.txt" }));
    expect(link).toMatchObject({ old_content: null, new_content: secret, unavailable: null, truncated: false });
    expect(link.patch).toContain("new file mode 120000");
    expect(link.patch).not.toContain("do not read");
  });

  it("stops a git that does not answer by its deadline, and says when there is no git", async () => {
    const hung = join(scratch, "hung-git");
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hung, 0o755);
    await expect(repoDiffFiles(root, query(), { git: hung, deadlineMs: 50 })).rejects.toMatchObject({ code: "git_timeout", status: 504 });
    await expect(repoDiffFiles(root, query(), { git: join(scratch, "no-git-here") })).rejects.toMatchObject({ code: "git_unavailable", status: 503 });
  });

  it("bounds aggregate output and honours cancellation before launching Git", async () => {
    await expect(repoDiffFiles(root, query(), { maxInspectionBytes: 1 })).rejects.toMatchObject({ code: "git_output_limit", status: 413 });
    const controller = new AbortController(); controller.abort();
    for (const inspect of [repoDiffFiles, repoDiffCommits]) await expect(inspect(root, query(), { signal: controller.signal })).rejects.toMatchObject({ code: "git_cancelled" });
    const hung = join(scratch, "cancel-git");
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n"); chmodSync(hung, 0o755);
    const pending = new AbortController();
    const read = repoDiffCommits(root, query(), { git: hung, signal: pending.signal });
    pending.abort();
    await expect(read).rejects.toMatchObject({ code: "git_cancelled" });
  });

  it("runs none of the programs a repository's configuration names", async () => {
    const hooked = repository("hooked");
    const marker = join(scratch, "program-ran");
    const program = join(scratch, "program.sh");
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
    chmodSync(program, 0o755);
    writeFileSync(join(hooked, ".gitattributes"), "*.txt diff=marker\n");
    writeFileSync(join(hooked, "a.txt"), "one\n");
    git(hooked, "add", ".");
    git(hooked, "commit", "-q", "-m", "first");
    writeFileSync(join(hooked, "a.txt"), "two\n");
    writeFileSync(join(hooked, "b.txt"), "new\n");
    git(hooked, "config", "diff.external", program);
    git(hooked, "config", "diff.marker.textconv", program);
    git(hooked, "config", "core.fsmonitor", program);
    rmSync(marker, { force: true });
    expect((await repoDiffFiles(hooked, query())).files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    const injected = { GIT_DIR: join(scratch, "wrong-repository"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: program };
    const saved = Object.fromEntries(Object.keys(injected).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, injected);
      for (const path of ["a.txt", "b.txt"]) expect((await repoDiffFile(hooked, query({ path }))).patch).toStartWith(`diff --git a/${path} b/${path}\n`);
      expect((await repoDiffCommits(hooked, query())).commits).toHaveLength(1);
      expect(existsSync(marker)).toBeFalse();
    } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  });
});

describe("GET /api/workspace/diff/*", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-repo-diff-state-"));
  const owner = { authorization: "Bearer test-repo-diff" };
  beforeAll(() => {
    root = repository("http");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "two\n");
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    // a first pairing is a device only once its cookie came back: that return is what saves it
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `herdr_web_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-repo-diff", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  const files = (search: string, headers: Record<string, string> = owner, method = "GET") => fetch(`${base}/api/workspace/diff/files?${search}`, { method, headers });
  const directory = () => `directory=${encodeURIComponent(root)}`;

  it("answers a named folder's list and one file's patch, never cached", async () => {
    const listed = await files(directory());
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    const list = await listed.json() as RepoDiffFileList;
    expect(list.repository.root).toBe(root);
    expect(list.files).toEqual([{ path: "a.txt", old_path: null, status: "modified", additions: 1, deletions: 1, binary: false }]);
    const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=a.txt`, { headers: owner });
    expect(response.status).toBe(200);
    const answer = await response.json() as RepoDiffFilePatch;
    expect(parsed(answer.patch).map((file) => [file.name, file.type])).toEqual([["a.txt", "change"]]);
  });

  it("refuses bad input in the error envelope", async () => {
    const cases: [string, number, string][] = [
      ["", 400, "missing_directory"],
      ["directory=relative%2Ffolder", 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(join(scratch, "nowhere"))}`, 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(scratch)}`, 409, "not_a_repository"],
      [`${directory()}&scope=unknown`, 400, "invalid_scope"],
      [`${directory()}&scope=commit&base=--output%3D%2Ftmp%2Fx`, 400, "invalid_revision"],
      [`${directory()}&scope=commit&base=nope`, 404, "revision_not_found"],
    ];
    for (const [search, status, code] of cases) {
      const response = await files(search);
      expect([search, response.status]).toEqual([search, status]);
      const body = await response.json() as ApiError;
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
    for (const [path, status, code] of [["..%2Fx", 400, "invalid_path"], ["", 400, "invalid_path"], ["absent.txt", 404, "not_found"]] as const) {
      const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=${path}`, { headers: owner });
      expect(response.status).toBe(status);
      expect((await response.json() as ApiError).error.code).toBe(code);
    }
    const posted = await files(directory(), { ...owner, "x-herdr-machine": "1" }, "POST");
    expect(posted.status).toBe(400);
    expect((await posted.json() as ApiError).error.code).toBe("method_not_allowed");
  });

  it("is closed to a stranger, to another site's page and to a device that can only watch", async () => {
    expect((await files(directory(), {})).status).toBe(401);
    const crossSite = await files(directory(), { ...owner, "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json() as ApiError).error.code).toBe("cross_site");
    expect((await fetch(`${base}/api/session`, { headers: { cookie: watchCookie } })).status).not.toBe(401);
    for (const path of ["workspace/diff/files", "workspace/diff/file", "machines/pc1/workspace/diff/files", "machines/pc1/workspace/diff/file", "machines/local/workspace/diff/file"]) {
      const response = await fetch(`${base}/api/${path}?${directory()}&path=a.txt`, { headers: { cookie: watchCookie } });
      expect([path, response.status]).toEqual([path, 403]);
      expect((await response.json() as ApiError).error.code).toBe("read_only");
    }
  });
});
