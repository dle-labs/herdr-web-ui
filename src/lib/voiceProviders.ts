import { VOICE_FORM, VOICE_KEYWORDS_MAX, VOICE_KEYWORD_MAX_CHARS, VOICE_MAX_AUDIO_BYTES, type VoiceEvent, type VoiceMode } from "../../shared/voice.ts";
import { DictationTransportError, recorderExtension } from "./voiceTransport.ts";

export interface OpenAIVoiceOptions { language: string; polish: boolean; mode: VoiceMode; keywords: string[] }
export function voiceKeywords(words: readonly string[]): string[] {
  return [...new Set(words.map((word) => word.trim()).filter((word) => word && word.length <= VOICE_KEYWORD_MAX_CHARS))].slice(0, VOICE_KEYWORDS_MAX);
}
/** Auto follows the manually chosen UI language, or the browser's first valid locale. */
export function dictationLocale(setting: string, uiSetting: string, uiLanguage: string, browserLanguages: readonly string[]): string {
  const locales: Record<string, string> = { en: "en-US", ko: "ko-KR", ja: "ja-JP", zh: "zh-CN" };
  const valid = (tag: string) => /^[a-z]{2}(?:-[a-z0-9]{2,8})*$/i.test(tag);
  if (setting !== "auto" && valid(setting)) return setting;
  const browser = browserLanguages[0]?.trim();
  return uiSetting === "system" && browser && valid(browser) ? browser : locales[uiLanguage] ?? "en-US";
}
export function transcribeLanguage(locale: string, fallback = "en"): string {
  const primary = locale.split("-")[0]!.toLowerCase();
  return /^[a-z]{2}$/.test(primary) ? primary : /^[a-z]{2}$/.test(fallback) ? fallback : "en";
}
export function voiceErrorFromCode(code: unknown): "not_configured" | "too_large" | "provider_auth" | "provider" {
  return code === "voice_not_configured" ? "not_configured" : code === "audio_too_large" ? "too_large" : code === "provider_auth" ? "provider_auth" : "provider";
}
export class OpenAIVoiceError extends Error {
  constructor(readonly code: ReturnType<typeof voiceErrorFromCode>) { super(code); }
}
/** Bounded NDJSON; cancellation also closes a reader waiting on a response chunk. */
export async function* readVoiceEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<VoiceEvent> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", bytes = 0, finished = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (!finished) {
      const part = await reader.read(); signal?.throwIfAborted();
      finished = part.done; bytes += part.value?.byteLength ?? 0;
      if (bytes > 256 * 1024) throw new DictationTransportError("format");
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      const lines = buffer.split("\n"); buffer = part.done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: unknown;
        try { event = JSON.parse(line); } catch { throw new DictationTransportError("format"); }
        if (!event || typeof event !== "object") throw new DictationTransportError("format");
        const item = event as Record<string, unknown>;
        if (!( ["delta", "done", "polished"].includes(String(item.type)) && typeof item.text === "string") && !(item.type === "error" && typeof item.code === "string" && typeof item.message === "string")) throw new DictationTransportError("format");
        yield event as VoiceEvent;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function transcribeOpenAI(options: OpenAIVoiceOptions, blob: Blob, signal: AbortSignal, preview?: (text: string) => void): Promise<string> {
  if (blob.size > VOICE_MAX_AUDIO_BYTES) throw new DictationTransportError("too_large");
  const extension = recorderExtension(blob.type);
  if (!extension) throw new DictationTransportError("format");
  const form = new FormData();
  form.append(VOICE_FORM.audio, blob, `voice.${extension}`);
  form.append(VOICE_FORM.language, transcribeLanguage(options.language));
  form.append(VOICE_FORM.mode, options.mode);
  form.append(VOICE_FORM.polish, options.polish ? "1" : "0");
  form.append(VOICE_FORM.keywords, JSON.stringify(voiceKeywords(options.keywords)));
  const response = await fetch("/api/voice/transcribe", { method: "POST", body: form, credentials: "same-origin", signal });
  signal.throwIfAborted();
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
    throw new OpenAIVoiceError(voiceErrorFromCode(body?.error?.code));
  }
  if (!response.body) throw new DictationTransportError("format");
  let raw: string | null = null, polished: string | null = null, partial = "";
  for await (const event of readVoiceEvents(response.body, signal)) {
    if (event.type === "error") throw new OpenAIVoiceError(voiceErrorFromCode(event.code));
    if (event.type === "delta") {
      if (raw !== null) throw new DictationTransportError("format");
      partial += event.text; preview?.(partial.trim());
    } else if (event.type === "done") {
      if (raw !== null) throw new DictationTransportError("format");
      raw = event.text.trim();
    } else {
      if (raw === null || polished !== null) throw new DictationTransportError("format");
      polished = event.text.trim();
    }
  }
  signal.throwIfAborted();
  // The server deliberately closes after done when optional polish fails.
  if (raw === null || (polished !== null && raw === "")) throw new DictationTransportError("format");
  const text = options.polish && polished ? polished : raw;
  if (!text) throw new DictationTransportError("no_speech");
  return text;
}
export interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onaudiostart: (() => void) | null;
  onresult: ((event: { results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } | undefined } | undefined } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
export function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const speech = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition ?? null;
}
export function speechErrorReason(error: string): "permission" | "no_mic" | "network" | "provider" | null {
  return error === "no-speech" || error === "aborted" ? null : error === "not-allowed" || error === "service-not-allowed" ? "permission" : error === "audio-capture" ? "no_mic" : error === "network" ? "network" : "provider";
}
