import { describe, expect, it } from "bun:test";
import { dictationConfig, dictationPolicy } from "./dictation.ts";
import { cspHeader, serveStatic } from "./static.ts";
import { fileInfo, fileResponse } from "./file-view.ts";

const policyText = (policy = dictationPolicy([])) => Object.values(cspHeader(policy))[0]!;

describe("direct dictation policy", () => {
  it("defaults off and permits an explicit empty override of the environment", () => {
    expect(dictationConfig(dictationPolicy(undefined, "[]"))).toEqual({ enabled: false, allowed_origins: [] });
    expect(dictationPolicy([], 'invalid')).toEqual({ enabled: false, allowed_origins: [] });
  });

  it("normalizes, deduplicates and snapshots exact origins", () => {
    const input = ["HTTPS://STT.EXAMPLE:443/", "https://stt.example", "https://speech.example:8443", "https://[::1]:9443"];
    const policy = dictationPolicy(input);
    input.push("https://later.example");
    expect(policy.allowed_origins).toEqual(["https://stt.example", "https://speech.example:8443", "https://[::1]:9443"]);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowed_origins)).toBe(true);
    dictationConfig(policy).allowed_origins.push("https://later.example");
    expect(policy.allowed_origins.length).toBe(3);
    expect(dictationPolicy(undefined, JSON.stringify(input)).allowed_origins.length).toBe(4);
  });

  for (const entry of ["http://speech.example", "wss://speech.example", "https:", "https://", "https://*.example", "https://%2a.example", "https://speech.example;script-src", "https://speech.example'", "https://speech_example", "https://speech.example/v1", "https://speech.example/.", "https://speech.example//", "https://user:pass@speech.example", "https://@speech.example", "https://speech.example?", "https://speech.example#", "https://speech.example?x=1", "https://speech.example#x", " https://speech.example", "https://speech.example\n", "https://speech.example\\", "https://speech.example; connect-src *", "https://speech.example:bad", "https://speech.example:65536", "https://speech.example/../", "'self'", 42, null]) {
    it(`rejects an invalid origin ${JSON.stringify(entry)}`, () => {
      expect(() => dictationPolicy(undefined, JSON.stringify(["https://valid.example", entry]))).toThrow("Invalid dictation origins");
    });
  }
  for (const env of ["", "not JSON", "null", "{}", '"https://speech.example"', "[null]"]) {
    it(`rejects invalid environment ${JSON.stringify(env)}`, () => expect(() => dictationPolicy(undefined, env)).toThrow("Invalid dictation origins"));
  }

  it("adds only exact HTTPS/WSS connections, preserving every other directive", async () => {
    const policy = dictationPolicy(["https://SPEECH.example:443/", "https://speech.example:8443"]);
    const original = policyText().split("; ");
    const extended = policyText(policy).split("; ");
    expect(extended.filter((entry) => !entry.startsWith("connect-src"))).toEqual(original.filter((entry) => !entry.startsWith("connect-src")));
    expect(extended.find((entry) => entry.startsWith("connect-src"))).toBe("connect-src 'self' https://speech.example wss://speech.example https://speech.example:8443 wss://speech.example:8443");
    const response = await serveStatic("/", policy);
    expect(response.headers.get("content-security-policy") ?? response.headers.get("content-security-policy-report-only")).toBe(policyText(policy));
  });

  it("does not grant file viewer documents direct speech or scripts", () => {
    const response = fileResponse(fileInfo(import.meta.filename)!, false);
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox; default-src 'none'");
    expect(csp).not.toContain("speech.example");
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toContain("script-src");
  });

  it("keeps report-only behavior explicit", () => {
    const previous = process.env.HERDR_WEB_CSP;
    try {
      process.env.HERDR_WEB_CSP = "report-only";
      const headers = cspHeader(dictationPolicy(["https://speech.example"]));
      expect(headers["content-security-policy"]).toBeUndefined();
      expect(headers["content-security-policy-report-only"]).toContain("https://speech.example wss://speech.example");
    } finally {
      if (previous === undefined) delete process.env.HERDR_WEB_CSP;
      else process.env.HERDR_WEB_CSP = previous;
    }
  });
});
