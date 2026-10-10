import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { configAllowed, DEFAULT_DICTATION_CONFIG, discoverDictationModels, transcribeDictation, validDictationModel } from "./voiceTransport.ts";
import type { DictationConfigResponse } from "../../shared/dictation.ts";
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const config = { ...DEFAULT_DICTATION_CONFIG, activated: true };
const policy: DictationConfigResponse = { version: 2, enabled: true, generation: "test-generation", default_model: config.model, modes: ["recording", "live"], max_seconds: 120, max_bytes: 10 * 1024 * 1024 };
const calls: Array<{ url: string; init: RequestInit }> = [];
let reply = () => Response.json({ models: [config.model] });
beforeAll(() => { globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); calls.push({ url, init: init ?? {} });
  return url === "/api/dictation/config" ? Response.json(policy) : reply();
}) as typeof fetch; });
describe("same-origin dictation transport", () => {
  it("requires new consent, model syntax and advertised mode", async () => {
    expect(configAllowed(DEFAULT_DICTATION_CONFIG, policy)).toBe(false);
    expect(configAllowed(config, policy)).toBe(true);
    expect(configAllowed({ ...config, mode: "live" }, { ...policy, modes: ["recording"] })).toBe(false);
    for (const model of ["", " model", "../model", "a?b", "a\nb", "https://host", "x".repeat(513)]) expect(validDictationModel(model)).toBe(false);
    const count = calls.length;
    await expect(discoverDictationModels(DEFAULT_DICTATION_CONFIG, new AbortController().signal)).rejects.toMatchObject({ code: "not_configured" });
    expect(calls.length).toBe(count);
  });
  it("discovers installed models with credentials and no speech URL", async () => {
    expect(await discoverDictationModels(config, new AbortController().signal)).toEqual([config.model]);
    expect(calls.at(-1)).toMatchObject({ url: "/api/dictation/models", init: { method: "GET", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" } });
  });
  it("posts bounded recording with generation, model and actual MIME only", async () => {
    reply = () => Response.json({ text: " hello " });
    expect(await transcribeDictation(config, new Blob(["audio"], { type: "audio/mp4" }), new AbortController().signal)).toBe("hello");
    const { url, init } = calls.at(-1)!;
    expect(url).toBe("/api/dictation/transcribe");
    expect(init).toMatchObject({ credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(["file", "model", "generation"]);
    expect(form.get("generation")).toBe(policy.generation);
    expect((form.get("file") as File).name).toBe("dictation.m4a");
  });
  it("bounds bodies and propagates only structured sanitized errors", async () => {
    for (const [response, code] of [[Response.json({ text: " " }), "no_speech"], [Response.json({ text: 42 }), "format"], [new Response("x".repeat(262145)), "format"], [Response.json({ error: { code: "missing_model", message: "private" } }, { status: 404 }), "missing_model"], [Response.json({ error: { code: "secret" } }, { status: 500 }), "provider"]] as const) {
      reply = () => response;
      await expect(transcribeDictation(config, new Blob(["audio"], { type: "audio/webm" }), new AbortController().signal)).rejects.toMatchObject({ code });
    }
  });
  it("cancels an outstanding body reader even when fetch does not propagate abort", async () => {
    let cancelled = false;
    reply = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController();
    const request = transcribeDictation(config, new Blob(["audio"], { type: "audio/webm" }), controller.signal);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("does not send aborted requests or refresh the page policy", async () => {
    const controller = new AbortController(); controller.abort(); const count = calls.length;
    await expect(discoverDictationModels(config, controller.signal)).rejects.toThrow(); expect(calls.length).toBe(count);
    expect(calls.filter((call) => call.url === "/api/dictation/config")).toHaveLength(1);
    expect(configAllowed(config, { ...policy, enabled: false })).toBe(false);
    expect(calls.every((call) => call.url.startsWith("/api/dictation/"))).toBe(true);
  });
});
