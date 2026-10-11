import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DICTATION_DEFAULT_MODEL, DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_VERSION, type DictationConfigResponse, type DictationErrorCode } from "../shared/dictation.ts";
import { jsonResponse } from "./http.ts";

export interface DictationPolicy { readonly enabled: boolean; readonly baseUrl: string; readonly apiKey?: string; readonly generation: string }
export interface DictationSettingsUpdate { base_url?: string; api_key?: string | null }

function validApiKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value);
}
export function parseDictationSettingsUpdate(value: unknown): DictationSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DictationError("format", "Expected base_url and/or api_key settings");
  const keys = Object.keys(value);
  const update = value as DictationSettingsUpdate;
  if (!keys.length || keys.some((key) => !["base_url", "api_key"].includes(key))
    || ("base_url" in update && typeof update.base_url !== "string")
    || ("api_key" in update && update.api_key !== null && !validApiKey(update.api_key))) throw new DictationError("format", "Expected base_url and/or a nonempty api_key (null to clear)");
  return update;
}

/** Immutable destination snapshot. Old ORIGINS configuration is deliberately ignored. */
export function dictationPolicy(baseUrl = process.env["HERDR_WEB_DICTATION_BASE_URL"] ?? "", apiKey?: string): DictationPolicy {
  if (apiKey !== undefined && !validApiKey(apiKey)) throw new Error("Invalid dictation API key");
  let normalized = "";
  if (baseUrl !== "") {
    const invalid = () => new Error("Invalid dictation base URL: expected an HTTPS origin with optional /v1");
    if (!/^https:\/\/[^\s/\\?#@*]+(?:\/v1\/?|\/)?$/i.test(baseUrl)) throw invalid();
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)) throw invalid();
    normalized = `${url.origin}/v1`;
  }
  return Object.freeze({ enabled: !!normalized, baseUrl: normalized, ...(apiKey ? { apiKey } : {}),
    generation: createHash("sha256").update(JSON.stringify([DICTATION_VERSION, normalized, DICTATION_DEFAULT_MODEL, DICTATION_MAX_SECONDS, DICTATION_MAX_BYTES, "recording", "live", apiKey ?? null])).digest("hex").slice(0, 24) });
}
export function dictationConfig(policy: DictationPolicy): DictationConfigResponse {
  return { version: DICTATION_VERSION, enabled: policy.enabled, generation: policy.generation, language_selection: true,
    default_model: DICTATION_DEFAULT_MODEL, modes: policy.enabled ? ["recording", "live"] : [], max_seconds: DICTATION_MAX_SECONDS, max_bytes: DICTATION_MAX_BYTES };
}
export class DictationSettings {
  readonly locked: boolean;
  policy: DictationPolicy;
  source: "env" | "file" | null;
  private readonly path: string;
  private readonly apiKeyLocked: boolean;
  private fileBaseUrl = "";
  private fileApiKey?: string;
  private readonly envApiKey?: string;
  apiKeySource: "env" | "file" | null = null;
  constructor(private readonly stateDir: string, baseUrl?: string, env = process.env) {
    this.path = join(stateDir, "dictation.json");
    const override = baseUrl ?? env["HERDR_WEB_DICTATION_BASE_URL"];
    this.locked = override !== undefined;
    this.apiKeyLocked = env["HERDR_WEB_DICTATION_API_KEY"] !== undefined;
    this.envApiKey = env["HERDR_WEB_DICTATION_API_KEY"] || undefined;
    let loaded = false;
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (value && typeof value === "object" && "base_url" in value && typeof value.base_url === "string") {
        const saved = dictationPolicy(value.base_url);
        if ("api_key" in value && !validApiKey(value.api_key)) throw new Error("Invalid saved dictation settings");
        this.fileBaseUrl = saved.baseUrl;
        this.fileApiKey = "api_key" in value ? value.api_key as string : undefined;
        loaded = true;
      }
    } catch { /* Invalid or unreadable state is disabled; never echo its contents. */ }
    const destination = dictationPolicy(override ?? this.fileBaseUrl).baseUrl;
    // A URL override must never carry a saved credential to a different destination.
    const savedKey = destination === this.fileBaseUrl ? this.fileApiKey : undefined;
    const key = this.apiKeyLocked ? this.envApiKey : savedKey;
    this.policy = dictationPolicy(destination, key);
    this.apiKeySource = this.apiKeyLocked ? "env" : key ? "file" : null;
    this.source = this.locked ? "env" : loaded ? "file" : null;
  }
  config(): DictationConfigResponse {
    return { ...dictationConfig(this.policy), base_url: this.policy.baseUrl, source: this.source,
      api_key_configured: !!this.policy.apiKey, api_key_source: this.apiKeySource };
  }
  save(value: string | DictationSettingsUpdate): DictationPolicy {
    const update = parseDictationSettingsUpdate(typeof value === "string" ? { base_url: value } : value);
    if ((this.locked && "base_url" in update) || (this.apiKeyLocked && "api_key" in update)) throw new DictationError("config_locked", "Dictation configuration is set by the environment", 409);
    let destination: string;
    try { destination = dictationPolicy(update.base_url ?? this.policy.baseUrl).baseUrl; }
    catch { throw new DictationError("format", "Expected an HTTPS origin with optional /v1"); }
    if (destination !== this.policy.baseUrl) {
      if (this.apiKeyLocked) throw new DictationError("config_locked", "Dictation destination is locked by the environment API key", 409);
      if (this.fileApiKey && !("api_key" in update)) throw new DictationError("config_locked", "Changing the dictation destination requires a new API key or null to clear it", 409);
    }
    const fileKey = "api_key" in update ? update.api_key ?? undefined : this.fileApiKey;
    const key = this.apiKeyLocked ? this.envApiKey : fileKey;
    const policy = dictationPolicy(destination, key);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ base_url: policy.baseUrl, ...(fileKey ? { api_key: fileKey } : {}) })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
    this.policy = policy;
    this.fileBaseUrl = destination;
    this.fileApiKey = fileKey;
    this.source = this.locked ? "env" : "file";
    this.apiKeySource = this.apiKeyLocked ? "env" : key ? "file" : null;
    return policy;
  }
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

/** Missing means English for legacy clients; auto omits the upstream language hint. */
export function dictationLanguage(value: unknown): string {
  if (value === undefined) return "en";
  if (typeof value !== "string" || (value !== "auto" && !/^[a-z]{2,3}$/.test(value))) throw new DictationError("format", "Choose a valid recognition language");
  return value;
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
