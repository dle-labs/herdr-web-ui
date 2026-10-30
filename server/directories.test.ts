import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectory, ignoredDirectories, listDirectories, MAX_DIRECTORY_ENTRIES } from "./directories.ts";

describe("listDirectories", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-dirs-")); roots.push(root); return root; };

  it("lists folders only, sorted naturally, with links to folders and without hidden ones", () => {
    const root = temp();
    for (const name of ["web", "api10", "api2", ".git", "Docs"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "README.md"), "");
    symlinkSync(join(root, "web"), join(root, "web-link"));
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    const listing = listDirectories(root)!;
    expect(listing.directories).toEqual(["api2", "api10", "Docs", "web", "web-link"]);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(tmpdir());
    expect(listing.truncated).toBe(false);
    expect(listDirectories(root, true)!.directories).toContain(".git");
  });

  const git = async (root: string, ...args: string[]) => {
    const proc = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
  };

  it("uses Git's nested rules, negations, excludes and tracked exceptions without filtering the listing", async () => {
    const root = temp();
    await git(root, "init", "-q");
    const names = ["build", "keep", "tracked", "local-excluded", "global-excluded", "nested", "space dir", "-dash"];
    for (const name of names) mkdirSync(join(root, name));
    writeFileSync(join(root, "tracked", "file"), "tracked");
    await git(root, "add", "tracked/file");
    writeFileSync(join(root, ".gitignore"), "build/\nkeep/\n!keep/\ntracked/\nspace dir/\n-dash/\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "local-excluded/\n");
    const excludes = join(root, "exclude-rules");
    writeFileSync(excludes, "global-excluded/\n");
    await git(root, "config", "core.excludesFile", excludes);
    mkdirSync(join(root, "nested", "build"));
    mkdirSync(join(root, "nested", "keep"));
    mkdirSync(join(root, "nested", "own"));
    writeFileSync(join(root, "nested", ".gitignore"), "!build/\nown/\n");
    const hidden = listDirectories(root, true, true)!;
    expect(hidden.directories).toContain(".git");
    expect(await ignoredDirectories(hidden.path, hidden.directories)).toContain("build");
    const listing = listDirectories(root, false, true)!;
    expect(listing.directories).toHaveLength(names.length);
    expect(await ignoredDirectories(listing.path, listing.directories)).toEqual(listing.directories.filter((name) => ["build", "local-excluded", "global-excluded", "space dir", "-dash"].includes(name)));
    const nested = listDirectories(join(root, "nested"), false, true)!;
    expect(await ignoredDirectories(nested.path, nested.directories)).toEqual(["own"]);
    mkdirSync(join(root, "build", "child"));
    expect(await ignoredDirectories(join(root, "build"), ["child"])).toEqual(["child"]);
  });

  it("returns empty metadata outside Git, with no folders, and when Git is unavailable", async () => {
    const root = temp();
    mkdirSync(join(root, "build"));
    expect(await ignoredDirectories(root, ["build"])).toEqual([]);
    expect(await ignoredDirectories(root, [])).toEqual([]);
    const previous = process.env.PATH;
    try {
      process.env.PATH = root;
      expect(await ignoredDirectories(root, ["build"])).toEqual([]);
      expect(listDirectories(root, false, true)!.directories).toEqual(["build"]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it.skipIf(process.platform === "win32")("bounds subprocess time and output without blocking the event loop", async () => {
    const root = temp();
    const executable = join(root, "git");
    const previous = process.env.PATH;
    try {
      process.env.PATH = root;
      writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
      chmodSync(executable, 0o755);
      const start = Date.now();
      let responsive = false;
      const timer = setTimeout(() => { responsive = true; }, 10);
      expect(await ignoredDirectories(root, ["folder"])).toEqual([]);
      clearTimeout(timer);
      expect(responsive).toBe(true);
      expect(Date.now() - start).toBeLessThan(3500);
      writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write("x".repeat(2 * 1024 * 1024));\n`);
      expect(await ignoredDirectories(root, ["folder"])).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it.skipIf(process.platform === "win32")("handles NUL-framed unusual names and directory symlinks", async () => {
    const root = temp();
    await git(root, "init", "-q");
    mkdirSync(join(root, "line\nbreak"));
    mkdirSync(join(root, "real"));
    symlinkSync("real", join(root, "link"));
    writeFileSync(join(root, ".gitignore"), "line*\nlink\n");
    expect(await ignoredDirectories(root, ["line\nbreak", "link", "real"])).toEqual(["line\nbreak", "link"]);
  });

  it("reads ~ and an empty path as home, and has no parent at the root", () => {
    expect(listDirectories("")!.path).toBe(homedir());
    expect(listDirectories("~")!.path).toBe(homedir());
    expect(listDirectories("/")!.parent).toBeNull();
  });

  it("answers null for a file or a missing path, and stops at the cap", () => {
    const root = temp();
    writeFileSync(join(root, "file"), "");
    expect(listDirectories(join(root, "file"))).toBeNull();
    expect(listDirectories(join(root, "nope"))).toBeNull();
    for (let n = 0; n <= MAX_DIRECTORY_ENTRIES; n++) mkdirSync(join(root, `d${n}`));
    const listing = listDirectories(root)!;
    expect(listing.directories).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(listing.truncated).toBe(true);
  });
});

describe("createDirectory", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-mkdir-")); roots.push(root); return root; };

  it("makes one folder inside the one shown and answers its path, the name trimmed", () => {
    const root = temp();
    expect(createDirectory(root, "  new-one ")).toEqual({ path: join(root, "new-one") });
    expect(statSync(join(root, "new-one")).isDirectory()).toBe(true);
  });

  it("refuses a name that is not one path segment, and makes nothing", () => {
    const root = temp();
    mkdirSync(join(root, "a"));
    for (const name of ["", "  ", ".", "..", "a/b", "../escape", "a\\b", "a\0b", "x".repeat(256)]) {
      expect(createDirectory(root, name)).toEqual({ error: "invalid_name" });
    }
    expect(readdirSync(root)).toEqual(["a"]);
    expect(readdirSync(join(root, "a"))).toEqual([]);
  });

  it("never overwrites, and needs a folder to make it in", () => {
    const root = temp();
    mkdirSync(join(root, "taken"));
    writeFileSync(join(root, "file"), "");
    expect(createDirectory(root, "taken")).toEqual({ error: "folder_exists" });
    expect(createDirectory(root, "file")).toEqual({ error: "folder_exists" });
    expect(createDirectory(join(root, "file"), "x")).toEqual({ error: "invalid_cwd" });
    expect(createDirectory(join(root, "missing"), "x")).toEqual({ error: "invalid_cwd" });
  });
});
