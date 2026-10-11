import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function fixture(transport: typeof fetch = (async () => Response.json({ text: "hello" })) as unknown as typeof fetch, editable = false) {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-dictation-contract-"));
  if (editable) writeFileSync(join(stateDir, "dictation.json"), JSON.stringify({ base_url: "https://speech.example/v1" }), { mode: 0o600 });
  const store = new DeviceStore(stateDir);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  const app = createServer({ port: 0, stateDir, token: "dictation-contract", tailscaleOwner: null, machines: false, dictationBaseUrl: editable ? undefined : "https://speech.example/v1", dictationFetch: transport });
  const base = `http://127.0.0.1:${app.port}`;
  return { app, base, stateDir, drive, watch, close() { app.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
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
      for (const [path, method] of [["config", "GET"], ["config", "PUT"], ["models", "GET"], ["transcribe", "POST"], ["ws", "GET"]]) {
        const url = `${f.base}/api/dictation/${path}`;
        expect((await fetch(url, { method })).status).toBe(401);
        expect((await fetch(url, { method, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
        expect((await fetch(url, { method, headers: { cookie: `herdr_web_device=${f.watch.token}`, origin: f.base } })).status).toBe(403);
      }
      expect((await config(f.base)).enabled).toBe(true);
    } finally { f.close(); }
  });
  it("guards edits, locks explicit overrides, persists changes and preserves valid settings on bad input", async () => {
    const put = (base: string, baseUrl: unknown, custom = { ...headers, origin: base, "x-herdr-dictation": "1" }) => fetch(`${base}/api/dictation/config`, { method: "PUT", headers: custom, body: JSON.stringify({ base_url: baseUrl }) });
    const locked = fixture();
    try {
      expect((await config(locked.base)).source).toBe("env");
      const response = await put(locked.base, ""); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "config_locked" } });
    } finally { locked.close(); }
    const old = process.env.HERDR_WEB_DICTATION_BASE_URL; delete process.env.HERDR_WEB_DICTATION_BASE_URL;
    const f = fixture(undefined, true);
    try {
      expect((await config(f.base)).source).toBe("file");
      expect((await put(f.base, "", { ...headers, origin: f.base, "x-herdr-dictation": "0" })).status).toBe(403);
      for (const value of ["http://insecure.example", "https://u:p@private.example", "https://speech.example/path", null]) expect((await put(f.base, value)).status).toBe(400);
      expect((await config(f.base)).base_url).toBe("https://speech.example/v1");
      const changed = await put(f.base, "https://new.example"); expect(changed.status).toBe(200);
      expect(changed.headers.get("cache-control")).toBe("no-store");
      const settings = await changed.json() as DictationConfigResponse;
      expect(settings).toMatchObject({ enabled: true, base_url: "https://new.example/v1", source: "file" });
      expect(JSON.parse(readFileSync(join(f.stateDir, "dictation.json"), "utf8"))).toEqual({ base_url: settings.base_url });
      const stale = await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording("stale") }); expect(stale.status).toBe(409);
      expect((await put(f.base, "")).status).toBe(200);
      expect(await config(f.base)).toMatchObject({ enabled: false, base_url: "", source: "file" });
      expect((await fetch(`${f.base}/api/dictation/models`, { headers })).status).toBe(503);
      expect((await put(f.base, "https://speech.example")).status).toBe(200);
      expect((await config(f.base)).enabled).toBe(true);
    } finally { f.close(); if (old !== undefined) process.env.HERDR_WEB_DICTATION_BASE_URL = old; }
  });
  it("cancels requests and closes sockets before replacing the destination", async () => {
    const old = process.env.HERDR_WEB_DICTATION_BASE_URL; delete process.env.HERDR_WEB_DICTATION_BASE_URL;
    const entered = deferred<AbortSignal>(); const response = deferred<Response>(); const calls: string[] = [];
    const f = fixture((async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).startsWith("https://speech.example")) { entered.resolve(init!.signal!); return response.promise; }
      return Response.json({ data: [{ id: "new/model" }] });
    }) as unknown as typeof fetch, true);
    let client: Awaited<ReturnType<typeof socket>> | undefined;
    try {
      client = await socket(f.base); const settings = await config(f.base);
      client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation })); await client.next();
      const closed = new Promise<number>((resolve) => client!.ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording(settings.generation) });
      const signal = await deadline(entered.promise);
      expect((await fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { ...headers, origin: f.base, "x-herdr-dictation": "1" }, body: JSON.stringify({ base_url: "https://new.example" }) })).status).toBe(200);
      expect(signal.aborted).toBe(true); expect(await deadline(closed)).toBe(1012);
      response.resolve(Response.json({ text: "late private text" })); expect((await deadline(pending)).status).not.toBe(200);
      expect(await (await fetch(`${f.base}/api/dictation/models`, { headers })).json()).toEqual({ models: ["new/model"] });
      expect(calls).toEqual(["https://speech.example/v1/audio/transcriptions", "https://new.example/v1/models?task=automatic-speech-recognition"]);
    } finally { response.resolve(Response.json({ text: "" })); client?.ws.close(); f.close(); if (old !== undefined) process.env.HERDR_WEB_DICTATION_BASE_URL = old; }
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
  it("keeps API keys backend-only and carries language for recorded and live transcription", async () => {
    const key = "contract-speech-key";
    let expectedAuth: string | null = `Bearer ${key}`;
    const languages: Array<string | null> = [];
    const f = fixture((async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(expectedAuth);
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      if (String(url).includes("/models?")) return Response.json({ data: [] });
      languages.push((init!.body as FormData).get("language") as string | null);
      return Response.json({ text: "recognized" });
    }) as typeof fetch);
    const put = (body: unknown) => fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { ...headers, origin: f.base, "x-herdr-dictation": "1" }, body: JSON.stringify(body) });
    let client: Awaited<ReturnType<typeof socket>> | undefined;
    try {
      const before = await config(f.base);
      expect((await put({ api_key: key })).status).toBe(200);
      const settings = await config(f.base);
      expect(settings).toMatchObject({ api_key_configured: true, api_key_source: "file", language_selection: true });
      expect(JSON.stringify(settings)).not.toContain(key);
      expect(settings.generation).not.toBe(before.generation);
      expect((await fetch(`${f.base}/api/dictation/models`, { headers })).status).toBe(200);
      for (const language of [undefined, "ja", "auto"]) {
        const body = recording(settings.generation);
        if (language) body.set("language", language);
        expect((await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body })).status).toBe(200);
      }
      for (const language of ["", "en-US", "EN", "en\n"]) {
        const body = recording(settings.generation); body.set("language", language);
        expect((await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body })).status).toBe(400);
      }
      const duplicate = recording(settings.generation); duplicate.append("language", "ja"); duplicate.append("language", "ko");
      expect((await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: duplicate })).status).toBe(400);
      for (const language of ["ko", "auto"]) {
        client = await socket(f.base);
        client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation, language }));
        expect((await client.next()).type).toBe("ready");
        client.ws.send(audio()); await client.next();
        client.ws.send(JSON.stringify({ type: "finish", frames: 1, samples: 1 }));
        expect((await client.next()).type).toBe("segment_final");
        expect((await client.next()).type).toBe("finished");
        client.ws.close();
      }
      expect(languages).toEqual(["en", "ja", null, "ko", null]);
      client = await socket(f.base);
      client.ws.send(JSON.stringify({ type: "start", version: 2, model: "model", generation: settings.generation, language: "en-US" }));
      expect(await client.next()).toMatchObject({ type: "error", error: { code: "format" } });
      expect((await put({ api_key: null })).status).toBe(200);
      expect(await config(f.base)).toMatchObject({ api_key_configured: false, api_key_source: null });
      expect(readFileSync(join(f.stateDir, "dictation.json"), "utf8")).not.toContain(key);
      expectedAuth = null;
      expect((await fetch(`${f.base}/api/dictation/models`, { headers })).status).toBe(200);
    } finally { client?.ws.close(); f.close(); }
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
      expect((await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers: { cookie }, body: recording(settings.generation) })).status).toBe(403);
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers: { cookie, origin: f.base }, body: recording(settings.generation) });
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
