import { DictationTransportError, type DictationPolicy } from "./voiceTransport.ts";

export type DictationSettingsError = "generic" | "environment" | "base-url" | "api-key";

/** The response proves the lock; metadata only narrows the advice, never diagnoses a lock. */
export function dictationSettingsError(error: unknown, policy: DictationPolicy | null): DictationSettingsError {
  if (!(error instanceof DictationTransportError) || error.code !== "config_locked" || !error.environmentLock) return "generic";
  if (error.environmentLock === "api-key") return "api-key";
  const url = policy?.source === "env", key = policy?.api_key_source === "env";
  if (url && !key) return "base-url";
  if (key && !url) return "api-key";
  // Both overrides, or stale/absent metadata: do not guess which variable blocked the save.
  return "environment";
}
