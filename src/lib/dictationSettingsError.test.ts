import { afterEach, describe, expect, it } from "bun:test";
import { dictationSettingsError } from "./dictationSettingsError.ts";
import { DEFAULT_DICTATION_CONFIG, DictationTransportError, saveDictationBackend, type DictationPolicy } from "./voiceTransport.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const policy: DictationPolicy = { version: 2, enabled: true, generation: "test", default_model: DEFAULT_DICTATION_CONFIG.model, modes: ["recording"], max_seconds: 120, max_bytes: 1000, source: "file", api_key_source: "file" };
const environmentMessage = "Dictation configuration is set by the environment";
async function saveFailure(code: string, message: unknown, status = 409): Promise<unknown> {
  let requests = 0;
  globalThis.fetch = (async (url, init) => {
    requests++;
    expect(url).toBe("/api/dictation/config");
    expect(init?.method).toBe("PUT");
    return Response.json({ error: { code, message } }, { status });
  }) as typeof fetch;
  let failure: unknown;
  try { await saveDictationBackend({ base_url: "https://fixture.example/v1" }, new AbortController().signal); }
  catch (error) { failure = error; }
  expect(requests).toBe(1); // No reload, retry or speech request after a rejected save.
  expect(failure).toBeInstanceOf(DictationTransportError);
  expect((failure as Error).message).toBe(code === "unknown" ? "provider" : code);
  return failure;
}

describe("dictation backend save advice", () => {
  it("preserves environment lock evidence through the real transport even with stale or absent policy", async () => {
    const error = await saveFailure("config_locked", environmentMessage);
    expect(error).toMatchObject({ code: "config_locked", environmentLock: "configuration" });
    expect(dictationSettingsError(error, null)).toBe("environment");
    expect(dictationSettingsError(error, policy)).toBe("environment");
    expect(dictationSettingsError(error, { ...policy, source: "env" })).toBe("base-url");
    expect(dictationSettingsError(error, { ...policy, api_key_source: "env" })).toBe("api-key");
    expect(dictationSettingsError(error, { ...policy, source: "env", api_key_source: "env" })).toBe("environment");
  });
  it("uses the exact environment API-key lock response over stale metadata", async () => {
    const error = await saveFailure("config_locked", "Dictation destination is locked by the environment API key");
    expect(dictationSettingsError(error, null)).toBe("api-key");
    expect(dictationSettingsError(error, { ...policy, source: "env" })).toBe("api-key");
  });
  it("never labels saved-key, owner or unknown errors as environment locks, even with env metadata", async () => {
    for (const [code, message, status] of [
      ["config_locked", "Changing the dictation destination requires a new API key or null to clear it", 409],
      ["config_locked", "Only the owner can configure dictation", 403],
      ["config_locked", environmentMessage, 403],
      ["provider", environmentMessage, 409],
      ["unknown", environmentMessage, 409],
      ["config_locked", "secret-provider-value", 409],
      ["config_locked", { secret: "secret-provider-value" }, 409],
    ] as const) {
      const error = await saveFailure(code, message, status);
      expect(dictationSettingsError(error, { ...policy, source: "env", api_key_source: "env" })).toBe("generic");
      expect(JSON.stringify(error)).not.toContain("secret-provider-value");
      expect((error as DictationTransportError).environmentLock).toBeNull();
    }
    for (const error of [null, new Error(environmentMessage), { code: "config_locked", message: environmentMessage }, new DictationTransportError("network")]) {
      expect(dictationSettingsError(error, policy)).toBe("generic");
    }
  });
});
