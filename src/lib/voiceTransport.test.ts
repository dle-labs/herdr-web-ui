import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { configAllowed, DEFAULT_DICTATION_CONFIG, discoverDictationModels, normalizeDictationBase, transcribeDictation } from "./voiceTransport.ts";
const originalFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = originalFetch; });
const config = { ...DEFAULT_DICTATION_CONFIG, activated: true };
const policy = { enabled: true, allowed_origins: ["https://stt.intra.dle.dev"] };
const calls: Array<{ url: string; init: RequestInit }> = [];
let reply = () => Response.json({ data: [{ id: config.model }] });
beforeAll(() => { globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); calls.push({ url, init: init ?? {} });
  return url === "/api/dictation/config" ? Response.json(policy) : reply();
}) as typeof fetch; });
describe("dictation transport", () => {
  it("normalizes HTTPS bases, never duplicates /v1, and rejects unsafe URLs", () => {
    expect(normalizeDictationBase("https://example.com/")).toBe("https://example.com/v1");
    expect(normalizeDictationBase("https://example.com/api/v1///")).toBe("https://example.com/api/v1");
    for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com?", "https://example.com#", "https://", "https://example.com\\evil", "https://exa mple.com"]) expect(normalizeDictationBase(url)).toBeNull();
  });
  it("fails closed before activation and for origins outside policy", async () => {
    expect(configAllowed(DEFAULT_DICTATION_CONFIG, policy)).toBe(false);
    expect(configAllowed({ ...config, baseUrl: "https://elsewhere.test" }, policy)).toBe(false);
    const count = calls.length;
    await expect(discoverDictationModels(DEFAULT_DICTATION_CONFIG, new AbortController().signal)).rejects.toMatchObject({ code: "not_configured" });
    expect(calls.length).toBe(count);
  });
  it("reads only installed models and applies privacy defaults to GET", async () => {
    expect(await discoverDictationModels(config, new AbortController().signal)).toEqual([config.model]);
    const request = calls.at(-1)!;
    expect(request.url).toBe(`${config.baseUrl}/models`);
    expect(request.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(request.init.headers).toBeUndefined(); expect(request.init.body).toBeUndefined();
  });
  it("posts English multipart using actual MIME and no legacy fields/auth/retries", async () => {
    reply = () => Response.json({ text: " hello " });
    expect(await transcribeDictation(config, new Blob(["audio"], { type: "audio/mp4" }), new AbortController().signal)).toBe("hello");
    const { url, init } = calls.at(-1)!;
    expect(url).toBe(`${config.baseUrl}/audio/transcriptions`);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(["file", "model", "language", "response_format"]);
    expect(form.get("language")).toBe("en"); expect(form.get("model")).toBe(config.model); expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).name).toBe("dictation.m4a"); expect((form.get("file") as File).type).toBe("audio/mp4");
  });
  it("bounds response bodies, validates text and rejects empty speech and missing models", async () => {
    for (const [response, code] of [[Response.json({ text: " " }), "no_speech"], [Response.json({ text: 42 }), "format"], [new Response("x".repeat(262145)), "format"], [new Response("{}", { status: 404 }), "missing_model"]] as const) {
      reply = () => response;
      await expect(transcribeDictation(config, new Blob(["audio"], { type: "audio/webm" }), new AbortController().signal)).rejects.toMatchObject({ code });
    }
  });
  it("aborted requests and disabled policy cannot contact private origins", async () => {
    const controller = new AbortController(); controller.abort(); const count = calls.length;
    await expect(discoverDictationModels(config, controller.signal)).rejects.toThrow(); expect(calls.length).toBe(count);
    expect(configAllowed(config, { enabled: false, allowed_origins: policy.allowed_origins })).toBe(false);
  });
});
