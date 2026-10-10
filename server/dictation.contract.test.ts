import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import type { DictationConfigResponse, DictationServerMessage } from "../shared/dictation.ts";

const authorization = "Bearer dictation-contract";
const headers = { authorization };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dictation contract deadline")), 3000); })]); }
  finally { clearTimeout(timer!); }
}
function fixture(transport: typeof fetch = (async () => Response.json({ text: "hello" })) as unknown as typeof fetch) {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-dictation-contract-"));
  const store = new DeviceStore(stateDir);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  const app = createServer({ port: 0, stateDir, token: "dictation-contract", tailscaleOwner: null, machines: false, dictationBaseUrl: "https://speech.example/v1", dictationFetch: transport });
  const base = `http://127.0.0.1:${app.port}`;
  return { app, base, drive, watch, close() { app.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}
async function config(base: string) { return await (await fetch(`${base}/api/dictation/config`, { headers })).json() as DictationConfigResponse; }
function recording(generation: string, size = 10) {
  const form = new FormData(); form.set("file", new Blob([new Uint8Array(size)], { type: "audio/webm" }), "recording.webm"); form.set("model", "installed/model"); form.set("generation", generation); return form;
}
async function socket(base: string, credential: Record<string, string> = headers) {
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const ws = new RuntimeSocket(`${base.replace("http:", "ws:")}/api/dictation/ws`, { headers: { origin: base, ...credential } });
  const messages: DictationServerMessage[] = [];
  let waiting: ((event: DictationServerMessage) => void) | undefined;
  const all: DictationServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data)) as DictationServerMessage; all.push(value);
    if (waiting) { const next = waiting; waiting = undefined; next(value); } else messages.push(value);
  });
  await deadline(new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("socket refused")), { once: true }); }));
  return { ws, all, next: () => deadline(messages.length ? Promise.resolve(messages.shift()!) : new Promise<DictationServerMessage>((resolve) => { waiting = resolve; })) };
}
function audio(seq = 0, offset = 0) { const frame = new Uint8Array(10); const view = new DataView(frame.buffer); view.setUint32(0, seq, true); view.setUint32(4, offset, true); view.setInt16(8, 1000, true); return frame; }

describe("dictation relay HTTP and dedicated WS", () => {
  it("reuses authentication, same-origin and write permission on every route including upgrade", async () => {
    const f = fixture();
    try {
      for (const [path, method] of [["config", "GET"], ["models", "GET"], ["transcribe", "POST"], ["ws", "GET"]]) {
        const url = `${f.base}/api/dictation/${path}`;
        expect((await fetch(url, { method })).status).toBe(401);
        expect((await fetch(url, { method, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
        expect((await fetch(url, { method, headers: { cookie: `herdr_web_device=${f.watch.token}`, origin: f.base } })).status).toBe(403);
      }
      expect((await config(f.base)).enabled).toBe(true);
    } finally { f.close(); }
  });
  it("bounds multipart, rejects stale configuration and relays fixed paths without forwarding credentials", async () => {
    const calls: string[] = [];
    const f = fixture((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url)); expect(init?.headers).toBeUndefined(); expect(init?.redirect).toBe("error");
      return String(url).includes("/models?") ? Response.json({ data: [{ id: "installed/model" }] }) : Response.json({ text: "recognized" });
    }) as typeof fetch);
    try {
      expect(await (await fetch(`${f.base}/api/dictation/models`, { headers })).json()).toEqual({ models: ["installed/model"] });
      const settings = await config(f.base);
      const post = (body: FormData) => fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body });
      expect(await (await post(recording(settings.generation))).json()).toEqual({ text: "recognized" });
      expect((await post(recording("stale"))).status).toBe(409);
      expect((await post(recording(settings.generation, 10 * 1024 * 1024 + 1))).status).toBe(413);
      expect(calls).toEqual(["https://speech.example/v1/models?task=automatic-speech-recognition", "https://speech.example/v1/audio/transcriptions"]);
    } finally { f.close(); }
  });
  it("opens dictation without terminal snapshot/attach and emits ready, ack, final, finished in order", async () => {
    const f = fixture(); let client: Awaited<ReturnType<typeof socket>> | undefined;
    try {
      const settings = await config(f.base); client = await socket(f.base);
      client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation }));
      expect((await client.next()).type).toBe("ready");
      client.ws.send(audio()); expect(await client.next()).toEqual({ type: "ack", frames: 1, samples: 1 });
      client.ws.send(JSON.stringify({ type: "finish", frames: 1, samples: 1 }));
      expect(await client.next()).toEqual({ type: "segment_final", segment_id: 0, text: "hello" });
      expect(await client.next()).toEqual({ type: "finished", text: "hello" });
      expect(client.all.map((event) => event.type)).toEqual(["ready", "ack", "segment_final", "finished"]);
    } finally { client?.ws.close(); f.close(); }
  });
  it("cancels during Finish, aborts fetch and discards late results", async () => {
    const entered = deferred<AbortSignal>(); const response = deferred<Response>();
    const f = fixture((async (_url: unknown, init?: RequestInit) => { entered.resolve(init!.signal!); return response.promise; }) as unknown as typeof fetch);
    let client: Awaited<ReturnType<typeof socket>> | undefined;
    try {
      client = await socket(f.base); const settings = await config(f.base);
      client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation })); await client.next();
      client.ws.send(audio()); await client.next(); client.ws.send(JSON.stringify({ type: "finish", frames: 1, samples: 1 }));
      const signal = await deadline(entered.promise); client.ws.send(JSON.stringify({ type: "cancel" }));
      expect(await client.next()).toEqual({ type: "cancelled" }); expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "late private text" }));
      expect(client.all.some((event) => event.type === "finished")).toBe(false);
    } finally { response.resolve(Response.json({ text: "" })); client?.ws.close(); f.close(); }
  });
  it("revokes both socket and completed-upload inference using existing device lifecycle", async () => {
    const entered = deferred<AbortSignal>(); const response = deferred<Response>();
    const f = fixture((async (_url: unknown, init?: RequestInit) => { entered.resolve(init!.signal!); return response.promise; }) as unknown as typeof fetch);
    let client: Awaited<ReturnType<typeof socket>> | undefined;
    try {
      const cookie = `herdr_web_device=${f.drive.token}`; const settings = await config(f.base);
      client = await socket(f.base, { cookie });
      client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation })); await client.next();
      const closed = new Promise<number>((resolve) => client!.ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers: { cookie }, body: recording(settings.generation) });
      const signal = await deadline(entered.promise);
      const devices = await (await fetch(`${f.base}/api/devices`, { headers })).json() as { devices: { id: string; label: string }[] };
      const id = devices.devices.find((device) => device.label === "Drive")!.id;
      expect((await fetch(`${f.base}/api/devices/${id}`, { method: "DELETE", headers: { ...headers, "x-herdr-machine": "1", origin: f.base } })).status).toBe(204);
      expect(await deadline(closed)).toBe(1008); expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "revoked text" }));
      expect((await deadline(pending)).status).not.toBe(200);
    } finally { response.resolve(Response.json({ text: "" })); client?.ws.close(); f.close(); }
  });
});
