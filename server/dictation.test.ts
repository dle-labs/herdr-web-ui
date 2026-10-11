import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DictationSettings, boundedBody, dictationConfig, dictationPolicy, validateDictationSelection } from "./dictation.ts";
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

describe("persisted dictation settings", () => {
  it("saves, rotates and clears private keys with destination binding and redacted config", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-keys-"));
    try {
      const settings = new DictationSettings(dir, undefined, {});
      settings.save({ base_url: policy.baseUrl, api_key: "private-key" });
      const generation = settings.policy.generation;
      expect(settings.config()).toMatchObject({ api_key_configured: true, api_key_source: "file", language_selection: true });
      expect(JSON.stringify(settings.config())).not.toContain("private-key");
      expect(JSON.parse(readFileSync(join(dir, "dictation.json"), "utf8"))).toEqual({ base_url: policy.baseUrl, api_key: "private-key" });
      expect(new DictationSettings(dir, undefined, {}).policy.apiKey).toBe("private-key");
      expect(() => settings.save({ base_url: "https://other.example" })).toThrow("requires a new API key");
      expect(settings.policy.baseUrl).toBe(policy.baseUrl);
      settings.save({ api_key: "replacement" });
      expect(settings.policy.generation).not.toBe(generation);
      settings.save({ base_url: "https://other.example", api_key: "new-destination-key" });
      expect(settings.policy.apiKey).toBe("new-destination-key");
      settings.save({ base_url: policy.baseUrl, api_key: null });
      expect(settings.config()).toMatchObject({ api_key_configured: false, api_key_source: null });
      expect(readFileSync(join(dir, "dictation.json"), "utf8")).not.toContain("api_key");
      if (process.platform !== "win32") expect(statSync(join(dir, "dictation.json")).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("locks env keys and destinations but permits key edits under a URL-only override", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-keys-"));
    try {
      const initial = new DictationSettings(dir, undefined, {});
      initial.save({ base_url: policy.baseUrl, api_key: "saved-key" });
      const env = new DictationSettings(dir, undefined, { HERDR_WEB_DICTATION_API_KEY: "env-key" });
      expect(env.config()).toMatchObject({ api_key_configured: true, api_key_source: "env" });
      expect(() => env.save({ api_key: null })).toThrow("set by the environment");
      expect(() => env.save({ base_url: "https://other.example", api_key: "replacement" })).toThrow("set by the environment");
      expect(() => env.save({ base_url: "https://other.example" })).toThrow("locked by the environment API key");
      expect(readFileSync(join(dir, "dictation.json"), "utf8")).not.toContain("env-key");
      const emptyEnv = new DictationSettings(dir, undefined, { HERDR_WEB_DICTATION_API_KEY: "" });
      expect(emptyEnv.config()).toMatchObject({ api_key_configured: false, api_key_source: "env" });
      expect(() => emptyEnv.save({ api_key: "replacement" })).toThrow("set by the environment");
      expect(() => emptyEnv.save({ base_url: "https://other.example" })).toThrow("locked by the environment API key");
      const urlOverride = new DictationSettings(dir, "https://other.example", {});
      expect(urlOverride.policy.apiKey).toBeUndefined();
      urlOverride.save({ api_key: "other-key" });
      expect(urlOverride.policy.apiKey).toBe("other-key");
      expect(urlOverride.config().source).toBe("env");
      expect(() => urlOverride.save({ base_url: policy.baseUrl })).toThrow("set by the environment");
      expect(() => urlOverride.save({ api_key: "\r\nsecret" })).toThrow("nonempty api_key");
      expect(() => urlOverride.save({ api_key: "" })).toThrow("nonempty api_key");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("persists normalized private settings, reloads and disables explicitly", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-settings-"));
    try {
      const settings = new DictationSettings(dir, undefined, {});
      expect(settings.config()).toMatchObject({ enabled: false, base_url: "", source: null });
      settings.save("https://speech.example");
      expect(settings.config()).toMatchObject({ base_url: policy.baseUrl, source: "file" });
      const path = join(dir, "dictation.json");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ base_url: policy.baseUrl });
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["dictation.json"]);
      expect(new DictationSettings(dir, undefined, {}).policy).toEqual(policy);
      expect(() => settings.save("https://private@attacker.example")).toThrow("Expected an HTTPS origin");
      expect(new DictationSettings(dir, undefined, {}).policy).toEqual(policy);
      settings.save("");
      expect(new DictationSettings(dir, undefined, {}).config()).toMatchObject({ enabled: false, source: "file" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("locks overrides including empty options and env, and hides corrupt state", () => {
    const dir = mkdtempSync(join(tmpdir(), "dictation-settings-"));
    try {
      for (const contents of ["private invalid JSON", JSON.stringify({ base_url: "https://secret:credential@attacker.example" }), JSON.stringify({ base_url: 1 })]) {
        writeFileSync(join(dir, "dictation.json"), contents);
        const settings = new DictationSettings(dir, undefined, {});
        expect(settings.config()).toMatchObject({ enabled: false, base_url: "", source: null });
        expect(JSON.stringify(settings.config())).not.toContain("secret");
      }
      for (const settings of [new DictationSettings(dir, "", { HERDR_WEB_DICTATION_BASE_URL: policy.baseUrl }), new DictationSettings(dir, undefined, { HERDR_WEB_DICTATION_BASE_URL: "" }), new DictationSettings(dir, policy.baseUrl, {})]) {
        expect(settings.locked).toBe(true);
        expect(settings.config().source).toBe("env");
        expect(() => settings.save("https://new.example")).toThrow("set by the environment");
      }
      expect(new DictationSettings(dir, "", { HERDR_WEB_DICTATION_BASE_URL: policy.baseUrl }).policy.enabled).toBe(false);
      expect(() => new DictationSettings(dir, undefined, { HERDR_WEB_DICTATION_BASE_URL: "http://invalid.example" })).toThrow("Invalid dictation base URL");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("bounded HTTP speech adapter", () => {
  it("uses snapshot Bearer credentials for discovery and inference and sanitizes failures", async () => {
    const authenticated = dictationPolicy(policy.baseUrl, "private-key");
    expect(authenticated.generation).not.toBe(policy.generation);
    expect(JSON.stringify(dictationConfig(authenticated))).not.toContain("private-key");
    const paths: string[] = [];
    const service = createDictationTransport(authenticated, transport(async (url, init) => {
      paths.push(url);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer private-key");
      expect([...new Headers(init.headers).keys()]).toEqual(["authorization"]);
      return url.includes("/models?") ? Response.json({ data: [{ id: "model" }] }) : Response.json({ text: "hello" });
    }));
    expect(await service.models(signal())).toEqual(["model"]);
    expect(await service.transcribe(new Blob(["audio"]), "model", signal())).toBe("hello");
    expect(paths.length).toBe(2);
    for (const status of [401, 403, 500]) {
      const failed = createDictationTransport(authenticated, transport(async () => new Response("private-key", { status })));
      await expect(failed.models(signal())).rejects.toMatchObject({ message: "Speech service rejected the request" });
    }
    const failed = createDictationTransport(authenticated, transport(async () => { throw new Error("private-key"); }));
    await expect(failed.models(signal())).rejects.toMatchObject({ message: "Speech service request failed" });
  });
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
