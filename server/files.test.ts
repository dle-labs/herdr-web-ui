import { afterEach, describe, expect, it } from "bun:test";
import { constants, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";

import { clearFileCache, paneFileSearch, paneFiles } from "./files.ts";
import { Inspection } from "./inspection-worker.ts";

const roots: string[] = [];
afterEach(() => {
  clearFileCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "files-search-"));
  roots.push(root);
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "hidden"), { recursive: true });
  writeFileSync(join(root, "src", "components", "PromptCard.tsx"), "export {};");
  writeFileSync(join(root, "src", "api.ts"), "export {};");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "node_modules", "hidden", "prompt.ts"), "hidden");
  return root;
}

describe("paneFiles", () => {
  it("roots detailed search at the repository and ranks exact basename, basename, path, then subsequence", async () => {
    const root = fixture();
    for (const name of ["api", "apix.ts", "api-folder/place.txt", "a/p/i.md"]) {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), "fixture");
    }
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    const result = await paneFileSearch(join(root, "src"), " API ");
    expect(result.root).toBe(root);
    expect(result.repository).toBeTrue();
    expect(result.files).toEqual(["api", "apix.ts", "src/api.ts", "api-folder/place.txt", "a/p/i.md"]);
    const capped = await paneFileSearch(root, "", 2);
    expect(capped.files).toEqual(["README.md", "a/p/i.md"]);
    expect(capped.incomplete).toEqual(["matches"]);
  });

  it("discloses non-Git depth/entry bounds and skips directory and file symlinks", async () => {
    const root = fixture();
    const deep = join(root, ...Array.from({ length: 7 }, (_, index) => `level${index}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "unseen.txt"), "unseen");
    symlinkSync(join(root, "src"), join(root, "linked-dir"));
    symlinkSync(join(root, "README.md"), join(root, "linked-file"));
    const depth = await paneFileSearch(root);
    expect(depth.incomplete).toContain("depth");
    expect(depth.files.some((path) => path.includes("linked") || path.includes("unseen"))).toBeFalse();
    for (let index = 0; index < 5_001; index += 1) writeFileSync(join(root, `f${index}.txt`), "x");
    clearFileCache();
    const entries = await paneFileSearch(root, "missing");
    expect(entries.incomplete).toContain("entries");
    expect(entries.limits).toMatchObject({ max_entries: 5_000, max_depth: 6, max_results: 100 });
  });

  it("never enumerates bridge cwd for unresolved pane paths and cancels without poisoning another caller", async () => {
    for (const cwd of ["", "relative", join(fixture(), "absent")]) await expect(paneFileSearch(cwd)).rejects.toBeDefined();
    const root = fixture();
    const controller = new AbortController();
    const cancelled = paneFileSearch(root, "", 100, { signal: controller.signal });
    const retained = paneFileSearch(root);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "git_cancelled" });
    expect((await retained).files).toContain("README.md");
    await expect(paneFileSearch(root, "", 100, { signal: controller.signal })).rejects.toMatchObject({ code: "git_cancelled" });
  });
  it("walks a non-git tree, skips heavy directories, and ranks matches", async () => {
    const root = fixture();
    expect(await paneFiles(root, "prompt", 20)).toEqual(["src/components/PromptCard.tsx"]);
    expect(await paneFiles(root, "sat", 20)).toContain("src/api.ts");
    expect(await paneFiles(root, "", 2)).toHaveLength(2);
  });

  it("uses tracked and untracked non-ignored files in a git repository, omitting embedded directories", async () => {
    const root = fixture();
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "README.md\n");
    mkdirSync(join(root, "embedded"));
    expect(Bun.spawnSync(["git", "init", "-q", join(root, "embedded")]).exitCode).toBe(0);
    writeFileSync(join(root, "embedded", "inside.txt"), "not a workspace file");
    expect(Bun.spawnSync(["git", "-C", root, "update-index", "--add", "--cacheinfo", "160000", "1".repeat(40), "absent-submodule"]).exitCode).toBe(0);
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/api.ts");
    expect(files).not.toContain("README.md");
    expect(files.some((path) => path.startsWith("embedded/"))).toBeFalse();
    expect(files).not.toContain("absent-submodule");
  });

  it("keeps tracked identities below replaced directory symlinks without reading their targets", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", root, "add", "src"]).exitCode).toBe(0);
    rmSync(join(root, "src"), { recursive: true });
    const outside = fixture();
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(outside, join(root, "src"));
    const result = await paneFileSearch(root);
    expect(result.incomplete).toEqual([]);
    expect(result.files).toContain("src/api.ts");
    expect(result.files).toContain("src/components/PromptCard.tsx");
    expect(result.files).not.toContain("src/secret.txt");
  });

  it("clamps the result limit to one through one hundred", async () => {
    const root = fixture();
    expect(await paneFiles(root, "", 0)).toHaveLength(3);
    expect(await paneFiles(root, "", 1)).toHaveLength(1);
  });

  it("preserves Unicode and newline filenames returned by git", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    for (const name of ["설계 문서.md", "line\nbreak.txt"]) writeFileSync(join(root, name), "fixture");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("설계 문서.md");
    expect(files).toContain("line\nbreak.txt");
  });

  it("honors git ignores from a nested working directory", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "src/secret.txt\n");
    writeFileSync(join(root, "src", "secret.txt"), "private");
    expect(await paneFiles(join(root, "src"), "", 100)).toEqual(["api.ts", "components/PromptCard.tsx"]);
  });
});

describe("bounded inspection filesystem", () => {
  it("enforces a parent deadline during synchronous worker work, cancellation and reply bounds", async () => {
    const root = fixture();
    const deep = join(root, ...Array(128).fill("d"));
    mkdirSync(deep, { recursive: true });
    const fs = new Inspection(Date.now() + 200);
    const started = performance.now();
    let bridgeResponsive = false;
    setImmediate(() => { bridgeResponsive = true; });
    try {
      await expect(fs.call("states", root, Array(4_000).fill(relative(root, deep)))).rejects.toMatchObject({ code: "git_timeout", status: 504 });
      expect(bridgeResponsive).toBeTrue();
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally { fs.close(); }
    const controller = new AbortController();
    const cancelled = new Inspection(Date.now() + 5_000, controller.signal);
    const read = cancelled.call("canonical", root);
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: "git_cancelled" });
    const capped = new Inspection(Date.now() + 5_000, undefined, { remainingBytes: 1 });
    try { await expect(capped.call("canonical", root)).rejects.toMatchObject({ code: "git_output_limit" }); }
    finally { capped.close(); }
  });

  it.skipIf(!Bun.which("mkfifo"))("opens nonblocking when a regular file is swapped for a FIFO before open", async () => {
    const root = fixture();
    const path = join(root, "swap.txt");
    writeFileSync(path, "before\n");
    const wrapper = join(root, "fifo-worker.ts");
    // The mock lives only in this worker. Swap after the regular-file lstat, before the real open.
    writeFileSync(wrapper, `import fs from "node:fs";
import { mock } from "bun:test";
import { parentPort, workerData } from "node:worker_threads";
const stat = fs.lstatSync, open = fs.openSync;
let swapped = false;
fs.lstatSync = ((...args) => {
  const result = stat(...args);
  if (!swapped && args[0] === workerData.file && !args[1]) {
    swapped = true; fs.rmSync(workerData.file);
    if (Bun.spawnSync(["mkfifo", workerData.file]).exitCode !== 0) throw new Error("fixture FIFO failed");
  }
  return result;
});
fs.openSync = ((...args) => { parentPort.postMessage({ flags: args[1] }); return open(...args); });
mock.module("node:fs", () => fs);
await import(${JSON.stringify(new URL("./inspection-worker.ts", import.meta.url).href)});
`);
    const worker = new Worker(wrapper, { workerData: { inspection: true, deadlineAt: Date.now() + 2_000, file: path } });
    let flags = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<{ content: null; unavailable: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("FIFO inspection blocked")), 2_000);
        worker.on("error", reject);
        worker.on("message", (reply: { flags?: number; text?: string }) => {
          if (reply.flags !== undefined) flags = reply.flags;
          if (reply.text) resolve(JSON.parse(reply.text));
        });
        worker.postMessage({ kind: "disk", args: [root, "swap.txt"] });
      });
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      expect(result).toEqual({ content: null, unavailable: "stale" });
    } finally { clearTimeout(timer); await worker.terminate(); }
  });

  it("runs from the copied-source layout used by remote runtime bundles", async () => {
    const root = fixture();
    const packed = join(root, "runtime");
    for (const directory of ["server", "shared"]) cpSync(join(import.meta.dir, "..", directory), join(packed, directory), { recursive: true, filter: (path) => !path.endsWith(".test.ts") });
    const entry = join(packed, "probe.ts");
    writeFileSync(entry, `import { paneFileSearch } from "./server/files.ts";\nconsole.log(JSON.stringify(await paneFileSearch(${JSON.stringify(join(root, "src"))})));\n`);
    const probe = Bun.spawn([process.execPath, entry], { cwd: packed, stdout: "pipe", stderr: "pipe" });
    expect(await probe.exited).toBe(0);
    const result = JSON.parse(await new Response(probe.stdout).text());
    expect(result.files).toEqual(["api.ts", "components/PromptCard.tsx"]);
    expect(result.incomplete).toEqual([]);
  });
});
