import type { DictationConfigResponse } from "../shared/protocol.ts";

export interface DictationPolicy {
  readonly enabled: boolean;
  readonly allowed_origins: readonly string[];
}

/** Fail startup closed, before any server or collector is started. Never echo configuration. */
export function dictationPolicy(origins?: readonly string[], env = process.env["HERDR_WEB_DICTATION_ORIGINS"]): DictationPolicy {
  let input: unknown = origins;
  const invalid = () => new Error("Invalid dictation origins: expected a JSON array of exact HTTPS origins");
  if (input === undefined) {
    if (env === undefined) input = [];
    else {
      try { input = JSON.parse(env); } catch { throw invalid(); }
    }
  }
  if (!Array.isArray(input)) throw invalid();
  const normalized = new Set<string>();
  for (const entry of input) {
    // Check the raw syntax too: URL silently strips whitespace, backslashes, empty ?/#,
    // and dot paths. None belongs in an administrator's exact-origin allowlist.
    if (typeof entry !== "string" || !/^https:\/\/[^\s/\\?#@*]+\/?$/i.test(entry)) throw invalid();
    let url: URL;
    try { url = new URL(entry); } catch { throw invalid(); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalid();
    // URL accepts characters such as ';' and percent-encoded '*' in a hostname;
    // they are not safe exact CSP host sources. IPv6 has already been parsed by URL.
    if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)) throw invalid();
    normalized.add(url.origin);
  }
  const allowed_origins = Object.freeze([...normalized]);
  return Object.freeze({ enabled: allowed_origins.length > 0, allowed_origins });
}

export function dictationConfig(policy: DictationPolicy): DictationConfigResponse {
  return { enabled: policy.enabled, allowed_origins: [...policy.allowed_origins] };
}
