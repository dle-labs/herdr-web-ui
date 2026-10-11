import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitChangesResponse, GitFileDiffResponse } from "../shared/protocol.ts";
import { workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";

describe("Git changes HTTP contract", () => {
  it("resolves only the requested test pane, authenticates, validates and serves local aliases", async () => {
    const temp = mkdtempSync(join(tmpdir(), "herdr-git-diff-contract-"));
    const repo = join(temp, "repo");
    const init = Bun.spawnSync(["git", "init", "-q", repo]);
    expect(init.exitCode).toBe(0);
    writeFileSync(join(repo, "new.txt"), "fixture\n");
    const workspace = await workspaceCreate({ cwd: repo, label: "herdr-web-ui-test-git-diff" });
    const app = createServer({ port: 0, stateDir: join(temp, "state"), token: "git-contract-token" });
    const origin = `http://localhost:${app.port}`;
    const headers = { authorization: "Bearer git-contract-token" };
    const query = new URLSearchParams({ pane_id: workspace.root_pane.pane_id, mode: "all" });
    try {
      expect((await fetch(`${origin}/api/workspace/changes?${query}`)).status).toBe(401);
      for (const [suffix, code] of [["", "missing_pane_id"], ["?pane_id=x&mode=bad", "invalid_mode"]]) {
        const response = await fetch(`${origin}/api/workspace/changes${suffix}`, { headers });
        expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code } });
      }
      expect((await fetch(`${origin}/api/workspace/changes?${query}`, { method: "POST", headers })).status).toBe(400);
      const changes = await fetch(`${origin}/api/workspace/changes?${query}`, { headers });
      expect(changes.status).toBe(200); expect(changes.headers.get("cache-control")).toBe("no-store");
      const inventory = await changes.json() as GitChangesResponse;
      expect(inventory.files).toEqual([{ path: "new.txt", status: "untracked" }]);
      const alias = await fetch(`${origin}/api/machines/local/workspace/changes?${query}`, { headers });
      expect(alias.status).toBe(200); expect(await alias.json()).toEqual(inventory);
      const response = await fetch(`${origin}/api/workspace/diff?${query}&path=new.txt`, { headers });
      expect(response.status).toBe(200);
      const diff = await response.json() as GitFileDiffResponse;
      expect(diff.revision).toBe(inventory.revision); expect(diff.old_file).toBeNull();
      expect(diff.new_file).toEqual({ name: "new.txt", contents: "fixture\n" });
      expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("fixture\n");
      const missing = await fetch(`${origin}/api/workspace/diff?${query}&path=not-changed`, { headers });
      expect(missing.status).toBe(404); expect(await missing.json()).toMatchObject({ error: { code: "git_path_not_changed" } });
      const absent = await fetch(`${origin}/api/workspace/changes?pane_id=unknown-git-pane&mode=all`, { headers });
      expect(absent.status).toBe(404); expect(await absent.json()).toMatchObject({ error: { code: "pane_not_found" } });
    } finally {
      app.stop();
      await workspaceClose(workspace.workspace.workspace_id);
      rmSync(temp, { recursive: true, force: true });
    }
  }, 20_000);
});
