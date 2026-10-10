import { DICTATION_MAX_BYTES } from "../../shared/dictation.ts";
import { boundedBody, DictationError, validateDictationSelection, type DictationPolicy } from "../dictation.ts";

const RESPONSE_BYTES = 256 * 1024;
const MIME_TYPES = new Set(["audio/webm", "video/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/flac"]);
export const MULTIPART_BYTES = DICTATION_MAX_BYTES + 64 * 1024;

export function createDictationTransport(policy: DictationPolicy, transport: typeof fetch = fetch) {
  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    if (!policy.enabled) throw new DictationError("not_configured", "Dictation is not configured", 503);
    const timeout = AbortSignal.timeout(60_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await transport(`${policy.baseUrl}${path}`, { ...init, redirect: "error", signal: combined });
      // Fixtures may not implement redirect:error; never consume or follow a redirect.
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel(); throw new DictationError("provider", "Speech service redirects are not supported", 502); }
      if (!response.ok) {
        void response.body?.cancel();
        throw new DictationError(response.status === 404 ? "missing_model" : "provider", response.status === 404 ? "Speech model or endpoint is unavailable" : "Speech service rejected the request", 502);
      }
      const bytes = await boundedBody(response.body, RESPONSE_BYTES, combined);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DictationError("provider", "Speech service returned an invalid response", 502); }
      return value;
    } catch (error) {
      if (timeout.aborted) throw new DictationError("timeout", "Speech service timed out", 504);
      if (error instanceof DictationError) throw error;
      throw new DictationError("network", "Speech service request failed", 502);
    }
  }
  return {
    async models(signal: AbortSignal): Promise<string[]> {
      const value = await request("/models?task=automatic-speech-recognition", { method: "GET" }, signal) as { data?: unknown } | null;
      if (!value || !Array.isArray(value.data) || value.data.length > 2000) throw new DictationError("provider", "Speech service returned an invalid model list", 502);
      return value.data.flatMap((entry: unknown) => {
        const id = (entry as { id?: unknown } | null)?.id;
        return typeof id === "string" && id.length <= 512 ? [id] : [];
      });
    },
    async transcribe(file: Blob, model: string, signal: AbortSignal): Promise<string> {
      const form = new FormData();
      form.set("file", file, file instanceof File ? file.name : "segment.wav");
      form.set("model", model);
      form.set("language", "en");
      form.set("response_format", "json");
      const value = await request("/audio/transcriptions", { method: "POST", body: form }, signal) as { text?: unknown } | null;
      if (!value || typeof value.text !== "string") throw new DictationError("provider", "Speech service returned an invalid transcript", 502);
      return value.text.trim();
    },
  };
}

export async function readRecording(request: Request, policy: DictationPolicy, signal: AbortSignal): Promise<{ file: File; model: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new DictationError("format", "Expected a multipart audio recording");
  const bytes = await boundedBody(request.body, MULTIPART_BYTES, signal);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "content-type": type } }).formData(); }
  catch { throw new DictationError("format", "Invalid multipart recording"); }
  if ([...form.keys()].some((key) => !["file", "model", "generation"].includes(key)) || ["file", "model", "generation"].some((key) => form.getAll(key).length !== 1)) throw new DictationError("format", "Invalid recording fields");
  const file = form.get("file");
  const model = form.get("model");
  validateDictationSelection(policy, model, form.get("generation"));
  if (!(file instanceof File) || !file.size) throw new DictationError("format", "Missing audio recording");
  if (file.size > DICTATION_MAX_BYTES) throw new DictationError("too_large", "Recording exceeds 10 MiB", 413);
  if (!MIME_TYPES.has(file.type.split(";")[0]!.toLowerCase())) throw new DictationError("format", "Unsupported audio format", 415);
  // Bun may infer video/webm from the multipart filename even when the browser sent
  // audio/webm. Preserve the container bytes but normalize this known recorder alias
  // so re-serializing the part does not turn an audio recording into a video upload.
  const audio = file.type.split(";")[0]!.toLowerCase() === "video/webm"
    ? new File([file], file.name, { type: "audio/webm" }) : file;
  // Compressed duration remains the capture client's responsibility; no decoder is loaded here.
  return { file: audio, model };
}

export function pcmWav(samples: Int16Array): Blob {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return new Blob([bytes], { type: "audio/wav" });
}
