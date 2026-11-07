import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectoryListing } from "../shared/protocol.ts";
import { createServer } from "./index.ts";

// Absolute directory requests do not need a pane or mutate herdr workspaces.
describe("Directory browser HTTP contract", () => {
  it("adds ignore metadata only for files=1, preserves entries, and supports non-Git paths and local aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-directories-contract-"));
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-directories-state-"));
    let app: ReturnType<typeof createServer> | undefined;
    try {
      const repo = join(root, "repo");
      const init = Bun.spawn(["git", "init", "-q", repo], { stdout: "ignore", stderr: "ignore" });
      expect(await init.exited).toBe(0);
      for (const name of ["build", "source", ".hidden"]) mkdirSync(join(repo, name));
      writeFileSync(join(repo, ".gitignore"), "build/\n.hidden/\n");
      writeFileSync(join(repo, "file.txt"), "hello");
      app = createServer({ port: 0, stateDir, token: "directories-contract-token" });
      const origin = `http://localhost:${app.port}`;
      const headers = { authorization: "Bearer directories-contract-token" };
      const url = `${origin}/api/workspace/directories?${new URLSearchParams({ path: repo })}`;
      expect((await fetch(url)).status).toBe(401);
      const folders = await (await fetch(url, { headers })).json() as DirectoryListing;
      expect(folders.directories).toEqual(["build", "source"]);
      expect(folders.files).toBeUndefined();
      expect(folders.ignored_directories).toBeUndefined();
      const response = await fetch(`${url}&files=1`, { headers });
      expect(response.status).toBe(200);
      const listing = await response.json() as DirectoryListing;
      expect(listing.directories).toEqual(folders.directories);
      expect(listing.files).toEqual([{ name: "file.txt", size: 5 }]);
      expect(listing.ignored_directories).toEqual(["build"]);
      const hidden = await (await fetch(`${url}&files=1&hidden=1`, { headers })).json() as DirectoryListing;
      expect(hidden.ignored_directories).toEqual([".hidden", "build"]);
      expect(hidden.directories).toContain(".git");
      const alias = url.replace("/api/workspace/", "/api/machines/local/workspace/");
      expect(await (await fetch(`${alias}&files=1`, { headers })).json()).toEqual(listing);
      const plain = join(root, "plain");
      mkdirSync(plain); mkdirSync(join(plain, "folder"));
      const nonGit = await (await fetch(`${origin}/api/workspace/directories?${new URLSearchParams({ path: plain, files: "1" })}`, { headers })).json() as DirectoryListing;
      expect(nonGit.directories).toEqual(["folder"]);
      expect(nonGit.ignored_directories).toEqual([]);
      const invalid = await fetch(`${url}/missing&files=1`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_cwd" } });
    } finally {
      app?.stop();
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
