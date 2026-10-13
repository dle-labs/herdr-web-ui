import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import type { DictationConfigResponse } from "../shared/dictation.ts";

const headers = { authorization: "Bearer dictation-contract" };
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
  expect(store.match(drive.token)).not.toBeNull(); // confirm the first cookie before starting another pairing
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  expect(store.match(watch.token)).not.toBeNull();
  const app = createServer({ port: 0, stateDir, token: "dictation-contract", tailscaleOwner: null, machines: false, dictationBaseUrl: editable ? undefined : "https://speech.example/v1", dictationFetch: transport });
  const base = `http://127.0.0.1:${app.port}`;
  return { app, base, stateDir, drive, watch, close() { app.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}
async function config(base: string) { return await (await fetch(`${base}/api/dictation/config`, { headers })).json() as DictationConfigResponse; }
function recording(generation: string, size = 10) {
  const form = new FormData(); form.set("file", new Blob([new Uint8Array(size)], { type: "audio/webm" }), "recording.webm"); form.set("model", "installed/model"); form.set("generation", generation); return form;
}

describe("recorded dictation HTTP relay", () => {
  it("refuses destination changes from paired drivers but permits owner credentials", async () => {
    const f = fixture(undefined, true);
    try {
      const before = await config(f.base);
      const body = JSON.stringify({ base_url: "https://new.example", api_key: "new-key" });
      const response = await fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { cookie: `herdr_web_device=${f.drive.token}`, origin: f.base, "x-herdr-dictation": "1" }, body });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "config_locked" } });
      expect(await config(f.base)).toEqual(before);
      expect(JSON.parse(readFileSync(join(f.stateDir, "dictation.json"), "utf8"))).toEqual({ base_url: before.base_url });
      expect((await fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { ...headers, origin: f.base, "x-herdr-dictation": "1" }, body })).status).toBe(200);
      expect((await config(f.base)).base_url).toBe("https://new.example");
    } finally { f.close(); }
  });
  it("reuses authentication, same-origin and write permission on every route", async () => {
    const f = fixture();
    try {
      for (const [path, method] of [["config", "GET"], ["config", "PUT"], ["models", "GET"], ["transcribe", "POST"]]) {
        const url = `${f.base}/api/dictation/${path}`;
        expect((await fetch(url, { method })).status).toBe(401);
        expect((await fetch(url, { method, headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
        expect((await fetch(url, { method, headers: { cookie: `herdr_web_device=${f.watch.token}`, origin: f.base } })).status).toBe(403);
      }
      expect(await config(f.base)).toMatchObject({ enabled: true, modes: ["recording"] });
    } finally { f.close(); }
  });
  it("does not advertise or serve the removed WebSocket route, even when disabled", async () => {
    const old = process.env.HERDR_WEB_DICTATION_BASE_URL; delete process.env.HERDR_WEB_DICTATION_BASE_URL;
    const f = fixture(undefined, true);
    try {
      const check = async () => {
        expect((await config(f.base)).modes).not.toContain("live");
        const response = await fetch(`${f.base}/api/dictation/ws`, { headers: { ...headers, origin: f.base, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      };
      await check();
      expect((await fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { ...headers, origin: f.base, "x-herdr-dictation": "1" }, body: JSON.stringify({ base_url: "" }) })).status).toBe(200);
      await check();
    } finally { f.close(); if (old !== undefined) process.env.HERDR_WEB_DICTATION_BASE_URL = old; }
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
      for (const value of ["ftp://speech.example", "https://u:p@private.example", "not a URL", null]) expect((await put(f.base, value)).status).toBe(400);
      expect((await config(f.base)).base_url).toBe("https://speech.example/v1");
      const changed = await put(f.base, "https://new.example"); expect(changed.status).toBe(200);
      expect(changed.headers.get("cache-control")).toBe("no-store");
      const settings = await changed.json() as DictationConfigResponse;
      expect(settings).toMatchObject({ enabled: true, base_url: "https://new.example", source: "file" });
      expect(JSON.parse(readFileSync(join(f.stateDir, "dictation.json"), "utf8"))).toEqual({ base_url: settings.base_url });
      const stale = await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording("stale") }); expect(stale.status).toBe(409);
      expect((await put(f.base, "")).status).toBe(200);
      expect(await config(f.base)).toMatchObject({ enabled: false, base_url: "", source: "file" });
      expect((await fetch(`${f.base}/api/dictation/models`, { headers })).status).toBe(503);
      for (const baseUrl of ["http://localhost:9791/v1", "http://10.0.0.1:8000/custom/api", "https://speech.internal/prefix", "https://speech.example"]) {
        expect((await put(f.base, baseUrl)).status).toBe(200);
        expect(await config(f.base)).toMatchObject({ enabled: true, base_url: baseUrl });
      }
    } finally { f.close(); if (old !== undefined) process.env.HERDR_WEB_DICTATION_BASE_URL = old; }
  });
  it("cancels requests before replacing the destination", async () => {
    const old = process.env.HERDR_WEB_DICTATION_BASE_URL; delete process.env.HERDR_WEB_DICTATION_BASE_URL;
    const entered = deferred<AbortSignal>(); const response = deferred<Response>(); const calls: string[] = [];
    const f = fixture((async (url: unknown, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).startsWith("https://speech.example")) { entered.resolve(init!.signal!); return response.promise; }
      return Response.json({ data: [{ id: "new/model" }] });
    }) as unknown as typeof fetch, true);
    try {
      const settings = await config(f.base);
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording(settings.generation) });
      const signal = await deadline(entered.promise);
      expect((await fetch(`${f.base}/api/dictation/config`, { method: "PUT", headers: { ...headers, origin: f.base, "x-herdr-dictation": "1" }, body: JSON.stringify({ base_url: "https://new.example" }) })).status).toBe(200);
      expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "late private text" }));
      const cancelled = await deadline(pending);
      expect(cancelled.status).toBe(409);
      expect(await cancelled.json()).toMatchObject({ error: { code: "config_changed" } });
      expect(await (await fetch(`${f.base}/api/dictation/models`, { headers })).json()).toEqual({ models: ["new/model"] });
      expect(calls).toEqual(["https://speech.example/v1/audio/transcriptions", "https://new.example/models?task=automatic-speech-recognition"]);
    } finally { response.resolve(Response.json({ text: "" })); f.close(); if (old !== undefined) process.env.HERDR_WEB_DICTATION_BASE_URL = old; }
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
      const stale = await post(recording("stale"));
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "config_changed" } });
      expect((await post(recording(settings.generation, 10 * 1024 * 1024 + 1))).status).toBe(413);
      expect(calls).toEqual(["https://speech.example/v1/models?task=automatic-speech-recognition", "https://speech.example/v1/audio/transcriptions"]);
    } finally { f.close(); }
  });
  it("keeps API keys backend-only and carries language for recorded transcription", async () => {
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
      expect(languages).toEqual(["en", "ja", null]);
      expect((await put({ api_key: null })).status).toBe(200);
      expect(await config(f.base)).toMatchObject({ api_key_configured: false, api_key_source: null });
      expect(readFileSync(join(f.stateDir, "dictation.json"), "utf8")).not.toContain(key);
      expectedAuth = null;
      expect((await fetch(`${f.base}/api/dictation/models`, { headers })).status).toBe(200);
    } finally { f.close(); }
  });
  it("aborts inference when the HTTP client cancels its request", async () => {
    const entered = deferred<AbortSignal>(); const aborted = deferred<void>(); const response = deferred<Response>();
    const f = fixture((async (_url: unknown, init?: RequestInit) => {
      entered.resolve(init!.signal!);
      init!.signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      return response.promise;
    }) as unknown as typeof fetch);
    const controller = new AbortController();
    try {
      const settings = await config(f.base);
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording(settings.generation), signal: controller.signal }).catch(() => null);
      const signal = await deadline(entered.promise);
      controller.abort();
      await deadline(aborted.promise);
      expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "cancelled text" }));
      expect(await deadline(pending)).toBeNull();
    } finally { controller.abort(); response.resolve(Response.json({ text: "" })); f.close(); }
  });
  it("aborts in-flight inference when the server stops", async () => {
    const entered = deferred<AbortSignal>(); const response = deferred<Response>();
    const f = fixture((async (_url: unknown, init?: RequestInit) => { entered.resolve(init!.signal!); return response.promise; }) as unknown as typeof fetch);
    try {
      const settings = await config(f.base);
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers, body: recording(settings.generation) }).catch(() => null);
      const signal = await deadline(entered.promise);
      f.app.stop();
      expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "stopped text" }));
      expect((await deadline(pending))?.status).not.toBe(200);
    } finally { response.resolve(Response.json({ text: "" })); f.close(); }
  });
  it("revokes completed-upload inference using existing device lifecycle", async () => {
    const entered = deferred<AbortSignal>(); const response = deferred<Response>();
    const f = fixture((async (_url: unknown, init?: RequestInit) => {
      entered.resolve(init!.signal!);
      await response.promise;
      throw new Error("Provider transport failed");
    }) as unknown as typeof fetch);
    try {
      const cookie = `herdr_web_device=${f.drive.token}`; const settings = await config(f.base);
      expect((await fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers: { cookie }, body: recording(settings.generation) })).status).toBe(403);
      const pending = fetch(`${f.base}/api/dictation/transcribe`, { method: "POST", headers: { cookie, origin: f.base }, body: recording(settings.generation) });
      const signal = await deadline(entered.promise);
      const devices = await (await fetch(`${f.base}/api/devices`, { headers })).json() as { devices: { id: string; label: string }[] };
      const id = devices.devices.find((device) => device.label === "Drive")!.id;
      expect((await fetch(`${f.base}/api/devices/${id}`, { method: "DELETE", headers: { ...headers, "x-herdr-machine": "1", origin: f.base } })).status).toBe(204);
      expect(signal.aborted).toBe(true);
      response.resolve(Response.json({ text: "revoked text" }));
      const failed = await deadline(pending);
      expect(failed.status).toBe(502);
      expect(await failed.json()).toMatchObject({ error: { code: "network" } });
    } finally { response.resolve(Response.json({ text: "" })); f.close(); }
  });
});
