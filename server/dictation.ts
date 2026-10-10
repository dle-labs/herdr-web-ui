import { createHash } from "node:crypto";
import { DICTATION_DEFAULT_MODEL, DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_VERSION, type DictationConfigResponse, type DictationErrorCode } from "../shared/dictation.ts";
import { jsonResponse } from "./http.ts";

export interface DictationPolicy { readonly enabled: boolean; readonly baseUrl: string; readonly generation: string }

/** Administrator-owned, immutable destination. Old ORIGINS configuration is deliberately ignored. */
export function dictationPolicy(baseUrl = process.env["HERDR_WEB_DICTATION_BASE_URL"] ?? ""): DictationPolicy {
  let normalized = "";
  if (baseUrl !== "") {
    const invalid = () => new Error("Invalid dictation base URL: expected an HTTPS origin with optional /v1");
    if (!/^https:\/\/[^\s/\\?#@*]+(?:\/v1\/?|\/)?$/i.test(baseUrl)) throw invalid();
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)) throw invalid();
    normalized = `${url.origin}/v1`;
  }
  return Object.freeze({ enabled: !!normalized, baseUrl: normalized,
    generation: createHash("sha256").update(JSON.stringify([DICTATION_VERSION, normalized, DICTATION_DEFAULT_MODEL, DICTATION_MAX_SECONDS, DICTATION_MAX_BYTES, "recording", "live"])).digest("hex").slice(0, 24) });
}
export function dictationConfig(policy: DictationPolicy): DictationConfigResponse {
  return { version: DICTATION_VERSION, enabled: policy.enabled, generation: policy.generation,
    default_model: DICTATION_DEFAULT_MODEL, modes: policy.enabled ? ["recording", "live"] : [], max_seconds: DICTATION_MAX_SECONDS, max_bytes: DICTATION_MAX_BYTES };
}
export class DictationError extends Error {
  constructor(public code: DictationErrorCode, message: string, public status = 400) { super(message); }
}
export function safeDictationError(error: unknown): DictationError {
  return error instanceof DictationError ? error : new DictationError("network", "Speech service request failed", 502);
}
export function dictationErrorResponse(error: unknown): Response {
  const safe = safeDictationError(error);
  return jsonResponse({ error: { code: safe.code, message: safe.message } }, safe.status);
}
export function validateDictationSelection(policy: DictationPolicy, model: unknown, generation: unknown): asserts model is string {
  if (!policy.enabled) throw new DictationError("not_configured", "Dictation is not configured", 503);
  if (generation !== policy.generation) throw new DictationError("format", "Dictation configuration changed; reload and Apply settings", 409);
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/.test(model) || model.split("/").includes("..")) throw new DictationError("format", "Choose a valid speech model");
}

/** Read before parsing; Content-Length alone is neither required nor trusted. */
export async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DictationError("too_large", "Dictation data is too large", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
