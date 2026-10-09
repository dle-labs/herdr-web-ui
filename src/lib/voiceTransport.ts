import { useEffect, useState } from "react";
import type { DictationConfigResponse } from "../../shared/protocol.ts";

export type DictationConfig = { baseUrl: string; model: string; activated: boolean };
export type DictationPolicy = DictationConfigResponse;
export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  baseUrl: "https://stt.intra.dle.dev/v1", model: "distil-whisper/distil-large-v3.5-ct2", activated: false,
};
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export type DictationTransportCode = "not_configured" | "network" | "provider" | "missing_model" | "timeout" | "format" | "too_large" | "no_speech";
export class DictationTransportError extends Error {
  constructor(readonly code: DictationTransportCode) { super(code); }
}
export function normalizeDictationBase(value: string): string | null {
  try {
    const raw = value.trim();
    if (!/^https:\/\//i.test(raw) || /[\\\s]/.test(raw) || raw.includes("?") || raw.includes("#")) return null;
    const url = new URL(raw);
    if (raw.slice(raw.indexOf("://") + 3).split("/")[0]?.includes("@")) return null;
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    let path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/v1")) path += "/v1";
    url.pathname = path;
    return url.href;
  } catch { return null; }
}
export function configAllowed(config: DictationConfig, policy: DictationPolicy | null): boolean {
  const base = normalizeDictationBase(config.baseUrl);
  return !!(config.activated && base && config.model.trim() && config.model.length <= 512 && policy?.enabled && policy.allowed_origins.includes(new URL(base).origin));
}

/** Bound the entire request, including streamed bodies. Never retain service error text. */
async function jsonRequest(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(url, { ...init, credentials: url === "/api/dictation/config" ? "same-origin" : "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!response.body) throw new DictationTransportError("format");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    while (true) {
      const part = await reader.read();
      controller.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) throw new DictationTransportError("format");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    if (!response.ok) throw new DictationTransportError(response.status === 404 ? "missing_model" : response.status === 413 ? "too_large" : "provider");
    try { return JSON.parse(text); } catch { throw new DictationTransportError("format"); }
  } catch (error) {
    if (timedOut) throw new DictationTransportError("timeout");
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof DictationTransportError) throw error;
    throw new DictationTransportError("network");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    void reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

// Page-lifetime immutable policy matches the page's CSP. Failed reads may be tried on a new mount.
let policyRequest: Promise<DictationPolicy | null> | null = null;
export function loadDictationPolicy(): Promise<DictationPolicy | null> {
  if (!policyRequest) {
    const request = jsonRequest("/api/dictation/config", { method: "GET", cache: "no-store" }, new AbortController().signal, 10_000)
      .then((body): DictationPolicy | null => {
        if (!body || typeof body !== "object") return null;
        const data = body as DictationPolicy;
        if (typeof data.enabled !== "boolean" || !Array.isArray(data.allowed_origins) || !data.allowed_origins.every((origin) => typeof origin === "string" && normalizeDictationBase(origin) === `${origin}/v1` && new URL(origin).origin === origin)) return null;
        return { enabled: data.enabled, allowed_origins: [...data.allowed_origins] };
      }).catch(() => null);
    policyRequest = request;
    void request.then((policy) => { if (!policy && policyRequest === request) policyRequest = null; });
  }
  return policyRequest;
}
export function useDictationPolicy(): DictationPolicy | null {
  const [policy, setPolicy] = useState<DictationPolicy | null>(null);
  useEffect(() => {
    let live = true;
    void loadDictationPolicy().then((value) => { if (live) setPolicy(value); });
    return () => { live = false; };
  }, []);
  return policy;
}
async function permittedBase(config: DictationConfig, signal: AbortSignal): Promise<string> {
  if (!config.activated) throw new DictationTransportError("not_configured");
  const policy = await loadDictationPolicy();
  signal.throwIfAborted();
  if (!configAllowed(config, policy)) throw new DictationTransportError("not_configured");
  return normalizeDictationBase(config.baseUrl)!;
}
export async function discoverDictationModels(config: DictationConfig, signal: AbortSignal): Promise<string[]> {
  const base = await permittedBase(config, signal);
  const body = await jsonRequest(`${base}/models`, { method: "GET" }, signal, 15_000);
  signal.throwIfAborted();
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length > 2000 || !data.every((entry) => entry && typeof entry.id === "string" && entry.id.length <= 512)) throw new DictationTransportError("format");
  return [...new Set(data.map((entry: { id: string }) => entry.id))];
}
export function recorderExtension(mime: string): string | null {
  const type = mime.split(";")[0]?.trim().toLowerCase();
  return type === "audio/webm" ? "webm" : type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : null;
}
export async function transcribeDictation(config: DictationConfig, blob: Blob, signal: AbortSignal): Promise<string> {
  const base = await permittedBase(config, signal);
  if (blob.size > DICTATION_MAX_BYTES) throw new DictationTransportError("too_large");
  if (!blob.size) throw new DictationTransportError("no_speech");
  const extension = recorderExtension(blob.type);
  if (!extension) throw new DictationTransportError("format");
  const form = new FormData();
  form.append("file", blob, `dictation.${extension}`);
  form.append("model", config.model);
  form.append("language", "en");
  form.append("response_format", "json");
  const body = await jsonRequest(`${base}/audio/transcriptions`, { method: "POST", body: form }, signal);
  signal.throwIfAborted();
  if (!body || typeof (body as { text?: unknown }).text !== "string") throw new DictationTransportError("format");
  const text = (body as { text: string }).text.trim();
  if (!text) throw new DictationTransportError("no_speech");
  return text;
}
