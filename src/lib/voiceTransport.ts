import { useEffect, useState } from "react";
import { DICTATION_DEFAULT_MODEL, type DictationConfigResponse, type DictationErrorCode } from "../../shared/dictation.ts";

export type DictationConfig = { version: 2; model: string; activated: boolean; mode: "recording" | "live" };
export type DictationPolicy = DictationConfigResponse;
export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  version: 2, model: DICTATION_DEFAULT_MODEL, activated: false, mode: "recording",
};
export { DICTATION_MAX_BYTES } from "../../shared/dictation.ts";
import { DICTATION_MAX_BYTES } from "../../shared/dictation.ts";
export type DictationTransportCode = DictationErrorCode;
export class DictationTransportError extends Error {
  constructor(readonly code: DictationTransportCode) { super(code); }
}
export function validDictationModel(model: unknown): model is string {
  return typeof model === "string" && model.length > 0 && model.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model) && !model.split("/").includes("..");
}
export function configAllowed(config: DictationConfig, policy: DictationPolicy | null): boolean {
  return !!(config.version === 2 && config.activated && validDictationModel(config.model) && policy?.version === 2 && policy.enabled && policy.modes.includes(config.mode));
}

/** Bound the entire request, including streamed bodies. Never retain service error text. */
async function jsonRequest(url: string, init: RequestInit, signal: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
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
    if (!response.ok) {
      let code: unknown;
      try { code = JSON.parse(text)?.error?.code; } catch { /* sanitized below */ }
      throw new DictationTransportError(isDictationErrorCode(code) ? code : "provider");
    }
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

// Page-lifetime policy. Failure requires an explicit page reload, never an audio retry.
let policyRequest: Promise<DictationPolicy | null> | null = null;
export function loadDictationPolicy(): Promise<DictationPolicy | null> {
  if (!policyRequest) {
    const request = jsonRequest("/api/dictation/config", { method: "GET", cache: "no-store" }, new AbortController().signal, 10_000)
      .then((body): DictationPolicy | null => {
        if (!body || typeof body !== "object") return null;
        const data = body as DictationPolicy;
        if (data.version !== 2 || typeof data.enabled !== "boolean" || typeof data.generation !== "string" || !data.generation || data.generation.length > 512 || !validDictationModel(data.default_model) || !Array.isArray(data.modes) || !data.modes.every((mode) => mode === "recording" || mode === "live") || !Number.isFinite(data.max_seconds) || data.max_seconds <= 0 || data.max_seconds > 120 || !Number.isFinite(data.max_bytes) || data.max_bytes <= 0 || data.max_bytes > DICTATION_MAX_BYTES) return null;
        return { ...data, modes: [...data.modes] };
      }).catch(() => null);
    policyRequest = request;
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
export async function permittedDictationPolicy(config: DictationConfig, signal: AbortSignal): Promise<DictationPolicy> {
  if (!config.activated) throw new DictationTransportError("not_configured");
  const policy = await loadDictationPolicy();
  signal.throwIfAborted();
  if (!configAllowed(config, policy)) throw new DictationTransportError("not_configured");
  return policy!;
}
export async function discoverDictationModels(config: DictationConfig, signal: AbortSignal): Promise<string[]> {
  await permittedDictationPolicy(config, signal);
  const body = await jsonRequest("/api/dictation/models", { method: "GET" }, signal, 15_000);
  signal.throwIfAborted();
  const data = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(data) || data.length > 2000 || !data.every(validDictationModel)) throw new DictationTransportError("format");
  return [...new Set(data as string[])];
}
export function recorderExtension(mime: string): string | null {
  const type = mime.split(";")[0]?.trim().toLowerCase();
  return type === "audio/webm" ? "webm" : type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : null;
}
export async function transcribeDictation(config: DictationConfig, blob: Blob, signal: AbortSignal): Promise<string> {
  const policy = await permittedDictationPolicy(config, signal);
  if (blob.size > DICTATION_MAX_BYTES) throw new DictationTransportError("too_large");
  if (!blob.size) throw new DictationTransportError("no_speech");
  const extension = recorderExtension(blob.type);
  if (!extension) throw new DictationTransportError("format");
  const form = new FormData();
  form.append("file", blob, `dictation.${extension}`);
  form.append("model", config.model);
  form.append("generation", policy.generation);
  const body = await jsonRequest("/api/dictation/transcribe", { method: "POST", body: form }, signal);
  signal.throwIfAborted();
  if (!body || typeof (body as { text?: unknown }).text !== "string") throw new DictationTransportError("format");
  const text = (body as { text: string }).text.trim();
  if (!text) throw new DictationTransportError("no_speech");
  return text;
}

export function isDictationErrorCode(code: unknown): code is DictationTransportCode {
  return typeof code === "string" && ["not_configured", "network", "provider", "missing_model", "timeout", "format", "too_large", "no_speech", "busy"].includes(code);
}
