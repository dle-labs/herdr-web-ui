/** Browser-safe dictation constants and wire types. No herdr or environment dependency. */
export const DICTATION_VERSION = 2;
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MAX_SECONDS = 120;
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export const DICTATION_FRAME_SAMPLES = 3_200; // 200 ms; final frame may be shorter
export const DICTATION_FRAME_HEADER_BYTES = 8;
export const DICTATION_FINISH_MS = 65_000;
export const DICTATION_DEFAULT_MODEL = "distil-whisper/distil-large-v3.5-ct2";
export type DictationMode = "recording" | "live";
export interface DictationConfigResponse {
  version: 2;
  enabled: boolean;
  generation: string;
  default_model: string;
  modes: DictationMode[];
  max_seconds: number;
  max_bytes: number;
}
export interface DictationModelsResponse { models: string[] }
export interface DictationTranscriptionResponse { text: string }
export type DictationErrorCode = "not_configured" | "network" | "provider" | "missing_model" | "timeout" | "format" | "too_large" | "no_speech" | "busy";
/** One take per socket. Binary frames: uint32 LE sequence (starts at 0), uint32 LE
 * sample offset (starts at 0), followed by 1..3200 signed little-endian PCM16 mono samples.
 * `finish.samples` counts all samples produced after the capture drain barrier;
 * `finish.frames` is the number of frames sent, not the final sequence index.
 */
export type DictationClientMessage =
  | { type: "start"; version: 2; model: string; generation: string }
  | { type: "finish"; frames: number; samples: number }
  | { type: "cancel" };
export type DictationServerMessage =
  | { type: "ready"; sample_rate: 16000; max_seconds: number; max_bytes: number }
  | { type: "ack"; frames: number; samples: number }
  | { type: "preview"; segment_id: number; revision: number; text: string }
  | { type: "segment_final"; segment_id: number; text: string }
  | { type: "finished"; text: string }
  | { type: "cancelled" }
  | { type: "error"; error: { code: DictationErrorCode; message: string } };
