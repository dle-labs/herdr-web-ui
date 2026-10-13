import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { configAllowed, DEFAULT_DICTATION_CONFIG, discoverDictationModels, loadDictationPolicy, saveDictationBackend, transcribeDictation, validDictationModel } from "./voiceTransport.ts";
import type { DictationConfigResponse } from "../../shared/dictation.ts";
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const config = { ...DEFAULT_DICTATION_CONFIG, activated: true };
const policy: DictationConfigResponse = { version: 2, enabled: true, generation: "test-generation", default_model: config.model, modes: ["recording"], max_seconds: 120, max_bytes: 10 * 1024 * 1024 };
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
    expect(configAllowed({ ...config, language: "ja" }, policy)).toBe(false);
    expect(configAllowed({ ...config, language: "ja" }, { ...policy, language_selection: true })).toBe(true);
    expect(configAllowed({ ...config, language: "auto" }, { ...policy, language_selection: true })).toBe(true);
    expect(configAllowed({ ...config, language: "en-US" }, { ...policy, language_selection: true })).toBe(false);
    expect(configAllowed(config, { ...policy, modes: [] })).toBe(false);
    expect(configAllowed({ ...config, mode: "live" } as unknown as typeof config, policy)).toBe(false);
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
  it("refreshes cached policy after an explicit successful backend save", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: events, configurable: true });
    let changed = 0;
    events.addEventListener("herdr-dictation-policy-changed", () => changed++);
    const next = { ...policy, generation: "saved-generation", base_url: "https://speech.example/v1", source: "file" as const, language_selection: true };
    const previous = globalThis.fetch;
    let saved = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/dictation/config");
      if (init?.method === "PUT") {
        expect(init.headers).toMatchObject({ "x-herdr-dictation": "1" });
        expect(JSON.parse(init.body as string)).toEqual({ base_url: next.base_url });
        if (!saved) return Response.json({ error: { code: "format" } }, { status: 400 });
      }
      return Response.json(next);
    }) as typeof fetch;
    try {
      await expect(saveDictationBackend({ base_url: next.base_url }, new AbortController().signal)).rejects.toMatchObject({ code: "format" });
      expect((await loadDictationPolicy())?.generation).toBe(policy.generation);
      expect(changed).toBe(0);
      saved = true;
      expect(await saveDictationBackend({ base_url: next.base_url }, new AbortController().signal)).toEqual(next);
      expect((await loadDictationPolicy())?.generation).toBe(next.generation);
      expect(changed).toBe(1);
      for (const language of ["ja", "auto"]) {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(String(input)).toBe("/api/dictation/transcribe");
          expect((init?.body as FormData).get("language")).toBe(language);
          return Response.json({ text: "transcript" });
        }) as typeof fetch;
        await transcribeDictation({ ...config, language }, new Blob(["audio"], { type: "audio/webm" }), new AbortController().signal);
      }
    } finally {
      globalThis.fetch = previous;
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  it("refreshes stale generations without retrying audio and does not cache failed policy loads", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { value: events, configurable: true });
    const previous = globalThis.fetch;
    let changed = 0, uploads = 0, reads = 0;
    events.addEventListener("herdr-dictation-policy-changed", () => changed++);
    const next = { ...policy, generation: "another-device-generation" };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/dictation/transcribe") {
        uploads++;
        expect((init?.body as FormData).get("generation")).toBe("saved-generation");
        return Response.json({ error: { code: "config_changed", message: "private" } }, { status: 409 });
      }
      expect(String(input)).toBe("/api/dictation/config");
      reads++;
      if (reads === 1) throw new Error("offline");
      if (reads === 2) return Response.json({ version: 1 });
      return Response.json(next);
    }) as typeof fetch;
    try {
      await expect(transcribeDictation(config, new Blob(["audio"], { type: "audio/webm" }), new AbortController().signal)).rejects.toMatchObject({ code: "config_changed", message: "config_changed" });
      expect(changed).toBe(1);
      expect(uploads).toBe(1);
      expect(reads).toBe(0);
      const first = loadDictationPolicy();
      expect(loadDictationPolicy()).toBe(first);
      expect(await first).toBeNull();
      expect(await loadDictationPolicy()).toBeNull();
      expect(await loadDictationPolicy()).toEqual(next);
      expect(await loadDictationPolicy()).toEqual(next);
      expect(reads).toBe(3);
      expect(uploads).toBe(1);
    } finally {
      globalThis.fetch = previous;
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
