/** Browser-safe dictation constants and wire types. No herdr or environment dependency. */
export const DICTATION_VERSION = 2;
export const DICTATION_MAX_SECONDS = 120;
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
export const DICTATION_DEFAULT_MODEL = "distil-whisper/distil-large-v3.5-ct2";
export type DictationMode = "recording";
/** GET /api/dictation/config → DictationConfigResponse (no-store).
 * PUT /api/dictation/config { base_url?: string, api_key?: string | null } → DictationConfigResponse.
 * An empty URL disables dictation; otherwise a complete administrator-selected HTTP(S) API base URL; no /v1 is added.
 * Hosts, paths and DNS addresses are unrestricted; administrators must choose trusted destinations.
 * HTTP sends audio and API keys in plaintext. URL userinfo is rejected to keep credentials private.
 * PUT requires same-origin and x-herdr-dictation: 1. URL edits additionally require
 * owner access (server token, direct local access or verified Tailscale owner),
 * otherwise 403 config_locked; paired devices/open LAN access cannot choose a URL.
 * Environment/explicit server
 * URL overrides lock URL edits; API key overrides lock key edits and destination
 * changes (409 config_locked). Moving a saved key requires a new key or null to
 * clear it. Secrets are never returned. Changes cancel ongoing dictation.
 * GET /api/dictation/models → DictationModelsResponse; POST /api/dictation/transcribe
 * accepts multipart file, model, generation, optional language → DictationTranscriptionResponse.
 * A stale generation is rejected with 409 config_changed; audio must not be retried automatically.
 * Language is a lowercase ISO 639 code or auto (backend detection); absent means en.
 * All routes require authentication, same-origin and write permission.
 */
export interface DictationConfigResponse {
  /** Absent on older bridges. */
  language_selection?: boolean;
  api_key_configured?: boolean;
  api_key_source?: "env" | "file" | null;
  /** Absent on older bridges; normalized destination, or empty when disabled. */
  base_url?: string;
  /** Explicit server options also report env; absent on older bridges. */
  source?: "env" | "file" | null;
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
export type DictationErrorCode = "config_locked" | "config_changed" | "not_configured" | "network" | "provider" | "missing_model" | "timeout" | "format" | "too_large" | "no_speech" | "busy";
