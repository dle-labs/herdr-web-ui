import { describe, expect, it } from "bun:test";
import { boundedBody, dictationConfig, dictationPolicy, validateDictationSelection } from "./dictation.ts";
import { cspHeader, serveStatic } from "./static.ts";
import { fileInfo, fileResponse } from "./file-view.ts";
import { createDictationTransport, readRecording } from "./dictation/speaches-http.ts";

const policy = dictationPolicy("https://speech.example/v1");
const signal = () => new AbortController().signal;
const transport = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const recording = (modify?: (form: FormData) => void) => {
  const form = new FormData();
  form.set("file", new Blob(["audio"], { type: "audio/webm" }), "recording.webm");
  form.set("model", "installed/model"); form.set("generation", policy.generation); modify?.(form);
  return new Request("https://app.example/api/dictation/transcribe", { method: "POST", body: form });
};

describe("backend dictation policy", () => {
  it("matches client model syntax through 512 characters without inventory checks", () => {
    for (const model of ["a".repeat(512), "owner/model..name", "owner/model"])
      expect(() => validateDictationSelection(policy, model, policy.generation)).not.toThrow();
    for (const model of ["a".repeat(513), "owner/../model", "owner/..", "", "/model", "owner/model name"])
      expect(() => validateDictationSelection(policy, model, policy.generation)).toThrow("Choose a valid speech model");
  });
  it("normalizes HTTPS /v1 and snapshots immutable generation without exposing topology", () => {
    expect(dictationPolicy("HTTPS://SPEECH.EXAMPLE:443/")).toEqual(policy);
    expect(dictationPolicy("https://speech.example/v1/")).toEqual(policy);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(dictationConfig(policy)).toMatchObject({ version: 2, enabled: true, modes: ["recording", "live"], max_seconds: 120, max_bytes: 10485760 });
    expect(JSON.stringify(dictationConfig(policy))).not.toContain("speech.example");
    expect(dictationPolicy("").enabled).toBe(false);
    expect(dictationPolicy("").generation).not.toBe(policy.generation);
  });
  for (const value of ["http://speech.example", "wss://speech.example", "https://speech.example/other", "https://speech.example/v1/../v1", "https://speech.example//v1", "https://speech.example?", "https://speech.example#", "https://u:p@speech.example", " https://speech.example", "https://speech.example\\", "https://*.example", "https://%2a.example", "https://speech.example:65536"]) {
    it(`refuses ${value}`, () => expect(() => dictationPolicy(value)).toThrow("Invalid dictation base URL"));
  }
  it("ignores retired origins and supports explicit disabled env override", () => {
    const old = process.env.HERDR_WEB_DICTATION_ORIGINS;
    const base = process.env.HERDR_WEB_DICTATION_BASE_URL;
    try {
      process.env.HERDR_WEB_DICTATION_ORIGINS = "invalid";
      process.env.HERDR_WEB_DICTATION_BASE_URL = "https://speech.example";
      expect(dictationPolicy()).toEqual(policy);
      expect(dictationPolicy("").enabled).toBe(false);
    } finally {
      if (old === undefined) delete process.env.HERDR_WEB_DICTATION_ORIGINS; else process.env.HERDR_WEB_DICTATION_ORIGINS = old;
      if (base === undefined) delete process.env.HERDR_WEB_DICTATION_BASE_URL; else process.env.HERDR_WEB_DICTATION_BASE_URL = base;
    }
  });
  it("keeps CSP same-origin and file-viewer policy unchanged", async () => {
    const csp = Object.values(cspHeader())[0]!;
    expect(csp).toContain("connect-src 'self';"); expect(csp).not.toContain("speech.example");
    const response = await serveStatic("/");
    expect(response.headers.get("content-security-policy") ?? response.headers.get("content-security-policy-report-only")).toBe(csp);
    const file = fileResponse(fileInfo(import.meta.filename)!, false);
    expect(file.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
    expect(file.headers.get("content-security-policy")).not.toContain("connect-src");
  });
});

describe("bounded HTTP speech adapter", () => {
  it("uses only fixed discovery/inference paths, English, JSON, no client headers or inventory gate", async () => {
    const calls: string[] = [];
    const service = createDictationTransport(policy, transport(async (url, init) => {
      calls.push(url); expect(init.redirect).toBe("error"); expect(init.headers).toBeUndefined();
      if (url.endsWith("/models?task=automatic-speech-recognition")) return Response.json({ data: [{ id: "installed/model" }] });
      expect(init.body).toBeInstanceOf(FormData);
      const wire = await new Response(init.body).text();
      expect(wire).toContain("Content-Type: audio/webm");
      expect(wire).not.toContain("Content-Type: video/webm");
      const form = init.body as FormData;
      expect(form.get("language")).toBe("en"); expect(form.get("response_format")).toBe("json"); expect(form.get("model")).toBe("installed/model");
      return Response.json({ text: " hello " });
    }));
    expect(await service.models(signal())).toEqual(["installed/model"]);
    const parsed = await readRecording(recording(), policy, signal());
    expect(await service.transcribe(parsed.file, parsed.model, signal())).toBe("hello");
    expect(calls).toEqual(["https://speech.example/v1/models?task=automatic-speech-recognition", "https://speech.example/v1/audio/transcriptions"]);
  });
  it("rejects stale selection, duplicate fields, arbitrary destinations and unsupported MIME", async () => {
    for (const modify of [(f: FormData) => f.set("generation", "stale"), (f: FormData) => f.append("model", "duplicate"), (f: FormData) => f.set("url", "https://attacker.example"), (f: FormData) => f.set("file", new Blob(["audio"], { type: "text/plain" }), "text.txt")]) {
      await expect(readRecording(recording(modify), policy, signal())).rejects.toMatchObject({ code: "format" });
    }
  });
  it("bounds streaming bodies without trusting Content-Length", async () => {
    await expect(boundedBody(new Blob([new Uint8Array(100)]).stream(), 10)).rejects.toMatchObject({ code: "too_large" });
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const result = boundedBody(body, 10, abort.signal); abort.abort();
    await expect(result).rejects.toBeDefined();
  });
  it("refuses redirect, missing model, malformed and excessive responses without echoing provider details", async () => {
    for (const response of [new Response("private credential", { status: 302, headers: { location: "https://attacker.example" } }), new Response("private credential", { status: 404 }), new Response("not json"), Response.json({ text: 1 }), new Response("x".repeat(300000))]) {
      const service = createDictationTransport(policy, transport(async () => response));
      try { await service.transcribe(new Blob(["audio"]), "model", signal()); throw new Error("unexpected success"); }
      catch (error) { expect(String(error)).not.toContain("private credential"); expect(String(error)).not.toContain("unexpected success"); }
    }
  });
});
