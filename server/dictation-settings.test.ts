import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

it("validates bounded partial dictation updates and forwards only the saved key", async () => {
  const oldBase = process.env.HERDR_WEB_DICTATION_BASE_URL;
  const oldKey = process.env.HERDR_WEB_DICTATION_API_KEY;
  delete process.env.HERDR_WEB_DICTATION_BASE_URL;
  delete process.env.HERDR_WEB_DICTATION_API_KEY;
  const stateDir = mkdtempSync(join(tmpdir(), "dictation-key-routes-"));
  const calls: RequestInit[] = [];
  const app = createServer({ port: 0, stateDir, token: "browser-key", machines: false, tailscaleOwner: null,
    dictationFetch: (async (url: unknown, init?: RequestInit) => {
      calls.push(init!);
      return String(url).includes("/models?") ? Response.json({ data: [{ id: "model" }] }) : Response.json({ text: "hello" });
    }) as typeof fetch });
  const base = `http://127.0.0.1:${app.port}`;
  const headers = { authorization: "Bearer browser-key", origin: base, "x-herdr-dictation": "1" };
  const put = (value: unknown) => fetch(`${base}/api/dictation/config`, { method: "PUT", headers, body: JSON.stringify(value) });
  try {
    for (const value of [null, [], {}, { api_key: "" }, { api_key: 1 }, { api_key: "bad\r\nkey" }, { base_url: null }, { api_key: "secret", extra: true }]) {
      const response = await put(value);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("secret");
    }
    expect((await put({ api_key: "x".repeat(5000) })).status).toBe(413);
    expect((await put({ base_url: "https://speech.example" })).status).toBe(200);
    await fetch(`${base}/api/dictation/models`, { headers });
    expect(calls[0]!.headers).toBeUndefined();
    const response = await put({ api_key: "upstream-secret" });
    expect(response.status).toBe(200);
    const settings = await response.json() as { generation: string; api_key_configured: boolean; api_key_source: string };
    expect(settings).toMatchObject({ api_key_configured: true, api_key_source: "file" });
    expect(JSON.stringify(settings)).not.toContain("upstream-secret");
    expect(readFileSync(join(stateDir, "dictation.json"), "utf8")).toContain("upstream-secret");
    expect((await put({ base_url: "https://other.example" })).status).toBe(409);
    await fetch(`${base}/api/dictation/models`, { headers: { ...headers, cookie: "private-browser-cookie" } });
    const form = new FormData();
    form.set("file", new Blob(["audio"], { type: "audio/webm" }), "recording.webm");
    form.set("model", "model"); form.set("generation", settings.generation);
    expect((await fetch(`${base}/api/dictation/transcribe`, { method: "POST", headers, body: form })).status).toBe(200);
    expect(calls.length).toBe(3);
    for (const call of calls.slice(1)) expect([...new Headers(call.headers).entries()]).toEqual([["authorization", "Bearer upstream-secret"]]);
    expect((await put({ api_key: null })).status).toBe(200);
    expect(readFileSync(join(stateDir, "dictation.json"), "utf8")).not.toContain("upstream-secret");
    expect((await put({ base_url: "https://other.example" })).status).toBe(200);
    await fetch(`${base}/api/dictation/models`, { headers });
    expect(calls.at(-1)!.headers).toBeUndefined();
  } finally {
    app.stop(); rmSync(stateDir, { recursive: true, force: true });
    if (oldBase === undefined) delete process.env.HERDR_WEB_DICTATION_BASE_URL; else process.env.HERDR_WEB_DICTATION_BASE_URL = oldBase;
    if (oldKey === undefined) delete process.env.HERDR_WEB_DICTATION_API_KEY; else process.env.HERDR_WEB_DICTATION_API_KEY = oldKey;
  }
}, 10_000);

it("allows direct local owners but not forwarded open-access clients to choose destinations", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dictation-owner-routes-"));
  const app = createServer({ port: 0, stateDir, token: "", machines: false, tailscaleOwner: null });
  const base = `http://127.0.0.1:${app.port}`;
  const headers = { origin: base, "x-herdr-dictation": "1" };
  const body = JSON.stringify({ base_url: "https://speech.example" });
  try {
    const refused = await fetch(`${base}/api/dictation/config`, { method: "PUT", headers: { ...headers, "x-forwarded-for": "192.0.2.1" }, body });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "config_locked" } });
    expect((await fetch(`${base}/api/dictation/config`, { method: "PUT", headers, body })).status).toBe(200);
  } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
