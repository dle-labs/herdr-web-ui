import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { walkFiles } from "./files.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
type Incomplete = "entries" | "depth" | "deadline" | "traversal";
type Side = { content: string | null; unavailable: "binary" | "unsupported" | "stale" | "too_large" | null; mode?: string; digest?: string };
type Operations = {
  canonical: { args: [string]; result: string };
  metadata: { args: [string]; result: string };
  states: { args: [string, string[]]; result: string[][] };
  disk: { args: [string, string]; result: Side };
  walk: { args: [string]; result: { root: string; files: string[]; repository: false; incomplete: Incomplete[] } };
  copies: { args: [string, string, string?, string?]; result: string };
};

/** Only repository inspection uses this worker: a blocked filesystem must not stall terminal IO.
 * Git stays in the bridge's existing cancellable runner, so terminating a worker cannot orphan Git.
 * Remote bundles copy server/ verbatim, including this self-contained worker entry point. */
export class Inspection {
  private worker: Worker | null = null;
  private pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
  private error: Error | null = null;
  private timer: ReturnType<typeof setTimeout>;
  private temporary = new Set<string>();
  private cancel = () => this.fail("git_cancelled", "file inspection was cancelled", 499);
  constructor(private deadlineAt: number, private signal?: AbortSignal, private budget = { remainingBytes: MAX_BYTES }) {
    this.timer = setTimeout(() => this.fail("git_timeout", "file inspection did not answer in time", 504), Math.max(0, deadlineAt - Date.now()));
    signal?.addEventListener("abort", this.cancel, { once: true });
    if (signal?.aborted) this.cancel();
  }
  async call<K extends keyof Operations>(kind: K, ...args: Operations[K]["args"]): Promise<Operations[K]["result"]> {
    if (this.signal?.aborted) this.cancel();
    if (Date.now() >= this.deadlineAt) this.fail("git_timeout", "file inspection did not answer in time", 504);
    if (this.error) throw this.error;
    if (this.pending) throw new Error("file inspection operations must be serialized");
    if (!this.worker) {
      this.worker = new Worker(new URL("./inspection-worker.ts", import.meta.url), { workerData: { inspection: true, deadlineAt: this.deadlineAt } });
      this.worker.on("message", (reply: { text?: string; failure?: { code: string; message: string; status: number }; overflow?: boolean }) => {
        if (Date.now() >= this.deadlineAt) { this.fail("git_timeout", "file inspection did not answer in time", 504); return; }
        if (this.signal?.aborted) { this.cancel(); return; }
        if (reply.overflow) { this.fail("git_output_limit", "file inspection exceeded its output budget", 413); return; }
        if (reply.failure) { this.fail(reply.failure.code, reply.failure.message, reply.failure.status); return; }
        const text = reply.text ?? "";
        this.budget.remainingBytes -= Buffer.byteLength(text);
        if (this.budget.remainingBytes < 0 || Buffer.byteLength(text) > MAX_BYTES) { this.fail("git_output_limit", "file inspection exceeded its output budget", 413); return; }
        const pending = this.pending; this.pending = null;
        pending?.resolve(JSON.parse(text));
      });
      this.worker.on("error", () => this.fail("inspection_failed", "that path could not be inspected safely", 409));
      this.worker.on("exit", () => { if (this.pending) this.fail("inspection_failed", "file inspection stopped before answering", 503); });
    }
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_BYTES) throw Object.assign(new Error("file inspection exceeded its input budget"), { code: "git_output_limit", status: 413 });
    const temporary = kind === "copies" ? join(tmpdir(), `herdr-inspection-${randomUUID()}`) : undefined;
    if (temporary) this.temporary.add(temporary);
    return await new Promise<Operations[K]["result"]>((resolve, reject) => {
      this.pending = { resolve: resolve as (value: unknown) => void, reject };
      this.worker!.postMessage({ kind, args, temporary });
    });
  }
  private fail(code: string, message: string, status: number): void {
    this.error ??= Object.assign(new Error(message), { code, status });
    const pending = this.pending; this.pending = null;
    pending?.reject(this.error);
    this.close();
  }
  close(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.cancel);
    const worker = this.worker; this.worker = null;
    const temporary = [...this.temporary];
    this.temporary.clear();
    // A late worker write must finish before cleanup, but neither termination nor an unavailable
    // temp filesystem may hold the response or the bridge event loop open.
    void Promise.resolve(worker?.terminate()).catch(() => undefined).then(async () => {
      await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
    });
  }
}

function metadata(path: string): string {
  try { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch { return "absent"; }
}
function workingPath(root: string, path: string): string {
  let directory = root;
  for (const segment of path.split("/").slice(0, -1)) {
    directory = join(directory, segment);
    try { if (!lstatSync(directory).isDirectory()) throw new Error("unsupported parent"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return join(root, path);
}
function textSide(bytes: Buffer, mode: string): Side {
  const evidence = { mode, digest: createHash("sha256").update(bytes).digest("hex") };
  if (bytes.includes(0)) return { content: null, unavailable: "binary", ...evidence };
  try { return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), unavailable: null, ...evidence }; }
  catch { return { content: null, unavailable: "binary", ...evidence }; }
}
function diskSide(root: string, path: string): Side {
  let fd: number | null = null;
  try {
    const absolute = workingPath(root, path);
    const before = metadata(absolute);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const bytes = readlinkSync(absolute, { encoding: "buffer" });
      if (before !== metadata(absolute)) return { content: null, unavailable: "stale" };
      return bytes.length > MAX_CONTENT_BYTES ? { content: null, unavailable: "too_large" } : textSide(bytes, "120000");
    }
    if (!stat.isFile()) return { content: null, unavailable: "unsupported" };
    if (stat.size > MAX_CONTENT_BYTES) return { content: null, unavailable: "too_large" };
    // O_NONBLOCK prevents a regular-file -> FIFO replacement from blocking before fstat.
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return { content: null, unavailable: "stale" };
    const canonical = realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : absolute);
    const rel = relative(root, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { content: null, unavailable: "unsupported" };
    const buffer = Buffer.alloc(MAX_CONTENT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) { const read = readSync(fd, buffer, size, buffer.length - size, size); if (!read) break; size += read; }
    if (size > MAX_CONTENT_BYTES) return { content: null, unavailable: "too_large" };
    workingPath(root, path);
    if (before !== metadata(absolute)) return { content: null, unavailable: "stale" };
    return textSide(buffer.subarray(0, size), stat.mode & 0o111 ? "100755" : "100644");
  } catch (error) { return { content: null, unavailable: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unsupported" }; }
  finally { if (fd !== null) closeSync(fd); }
}
if (!isMainThread && workerData?.inspection === true) {
  parentPort!.on("message", ({ kind, args, temporary }: { kind: keyof Operations; args: unknown[]; temporary?: string }) => {
    try {
      let result: unknown;
      switch (kind) {
        case "canonical": {
          try {
            result = realpathSync(args[0] as string);
            if (!lstatSync(result as string).isDirectory()) throw new Error("not a directory");
          } catch { throw Object.assign(new Error("directory must be an existing directory on this PC"), { code: "invalid_cwd", status: 400 }); }
          break;
        }
        case "metadata": result = metadata(args[0] as string); break;
        case "disk": result = diskSide(args[0] as string, args[1] as string); break;
        case "walk": result = walkFiles(args[0] as string, workerData.deadlineAt); break;
        case "states": {
          let size = 2;
          result = (args[1] as string[]).map((path) => {
            const states: string[] = [];
            let absolute = args[0] as string;
            for (const segment of path.split("/")) {
              absolute = join(absolute, segment);
              const state = metadata(absolute);
              size += state.length + 4;
              if (size > MAX_BYTES) throw Object.assign(new Error("inspection output exceeded its bound"), { code: "inspection_output_limit" });
              states.push(state);
              try { if (!lstatSync(absolute).isDirectory()) break; } catch { break; }
            }
            return states;
          }); break;
        }
        case "copies": {
          mkdirSync(temporary!, { mode: 0o700 });
          for (const [index, name] of ["old", "new"].entries()) {
            if (args[index + 2] === "120000") symlinkSync(args[index] as string, join(temporary!, name));
            else writeFileSync(join(temporary!, name), args[index] as string, { mode: args[index + 2] === "100755" ? 0o755 : 0o644 });
          }
          result = temporary; break;
        }
      }
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > MAX_BYTES) { parentPort!.postMessage({ overflow: true }); return; }
      parentPort!.postMessage({ text });
    } catch (error) {
      if ((error as { code?: string }).code === "inspection_output_limit") { parentPort!.postMessage({ overflow: true }); return; }
      const invalid = (error as { code?: string }).code === "invalid_cwd";
      parentPort!.postMessage({ failure: { code: invalid ? "invalid_cwd" : "inspection_failed", message: invalid ? "directory must be an existing directory on this PC" : "that path could not be inspected safely", status: invalid ? 400 : 409 } });
    }
  });
}
