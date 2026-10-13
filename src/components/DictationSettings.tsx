import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../lib/i18n.ts";
import { DICTATION_LANGUAGES, DICTATION_MODEL_MAX_CHARS, useSettings, type DictationLanguage, type VoiceProvider } from "../lib/settings.ts";
import { fetchVoiceStatus, saveVoiceConfig } from "../lib/api.ts";
import type { VoiceStatus } from "../../shared/voice.ts";
import { dictationSettingsError, type DictationSettingsError } from "../lib/dictationSettingsError.ts";
import { invalidateDictation } from "../lib/voice.ts";
import { configAllowed, discoverDictationModels, saveDictationBackend, useDictationPolicy, validDictationModel, type DictationConfig, type DictationPolicy } from "../lib/voiceTransport.ts";
import { Segmented, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./DictationSettings.css";

/** Draft edits never reach the capture engine. Only Apply commits a complete configuration. */
export function DictationSettings() {
  const { settings, update } = useSettings();
  const applied = settings.dictation;
  const policy = useDictationPolicy();
  const t = useT();
  const [model, setModel] = useState(applied.model);
  const [language, setLanguage] = useState(applied.language ?? "en");
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const invalidateRequests = () => {
    request.current.generation++;
    request.current.controller?.abort();
    request.current.controller = null;
  };
  // Cleanup runs before another committed configuration can present old results, and on unmount.
  useLayoutEffect(() => {
    setModel(applied.model);
    setLanguage(applied.language ?? "en");
    setModels(null);
    setBusy(false);
    setError(null);
    return invalidateRequests;
  }, [applied.version, applied.mode, applied.model, applied.activated, applied.language]);
  const policyKey = JSON.stringify(policy);
  useLayoutEffect(() => {
    setModels(null);
    setBusy(false);
    setError(null);
    return invalidateRequests;
  }, [policyKey, settings.voiceProvider]);

  const validModel = model.length <= DICTATION_MODEL_MAX_CHARS && validDictationModel(model.trim());
  const candidate: DictationConfig = { version: 2, mode: "recording", model: model.trim(), activated: true, ...(language !== "en" ? { language } : {}) };
  const allowed = policy !== null && configAllowed(candidate, policy);
  const dirty = model !== applied.model || language !== (applied.language ?? "en");
  const canRead = applied.activated && policy !== null && configAllowed(applied, policy);
  const apply = () => {
    if (!validModel || !allowed) return;
    invalidateRequests();
    setModels(null);
    setBusy(false);
    setError(null);
    setModel(candidate.model);
    update({ dictation: candidate });
  };
  const discard = () => {
    invalidateRequests();
    setBusy(false);
    setError(null);
    setModel(applied.model);
    setLanguage(applied.language ?? "en");
  };
  const check = async () => {
    if (!canRead) return;
    invalidateRequests();
    const generation = request.current.generation;
    const controller = new AbortController();
    request.current.controller = controller;
    setBusy(true);
    setError(null);
    setModels(null);
    try {
      const listed = await discoverDictationModels({ ...applied }, controller.signal);
      if (generation !== request.current.generation || controller.signal.aborted) return;
      setModels(listed);
    } catch {
      if (generation !== request.current.generation || controller.signal.aborted) return;
      setError(t("Could not list models. Check the WebUI backend and its speech service connection."));
    } finally {
      if (generation === request.current.generation && !controller.signal.aborted) {
        request.current.controller = null;
        setBusy(false);
      }
    }
  };

  return <>
    <SettingsGroup note={t("Auto uses OpenAI when a key is configured and recording is supported; otherwise it uses browser speech recognition. The provider is fixed when recording starts, with no fallback after an error. Nothing records until you press the microphone.")}>
      <SettingsRow label={t("Microphone button")} description={`${t("Auto shows available microphones in desktop chat. On also shows them on phones and in the terminal, with a reason when unavailable. Off hides them.")} ${t("Selecting Speaches keeps the chat microphone visible on phones too, with a setup reason when unavailable.")}`} wide>
        <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => update({ voiceInput })} options={[{ value: "auto", label: t("Auto") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} />
      </SettingsRow>
      <SettingsRow label={t("Transcription provider")} htmlFor="voice-provider">
        <select id="voice-provider" className="select settings-select" value={settings.voiceProvider} onChange={(event) => update({ voiceProvider: event.target.value as VoiceProvider })}>
          <option value="auto">{t("Auto")}</option>
          <option value="openai">OpenAI</option>
          <option value="speaches">{t("Self-hosted (Speaches)")}</option>
          <option value="browser">{t("Browser")}</option>
        </select>
      </SettingsRow>
      {settings.voiceProvider !== "speaches" && <SettingsRow label={t("Dictation language")} description={t("Auto listens for the app's language, or for the browser's when the app is not translated into it")} htmlFor="settings-voice-language">
        <DictationLanguageSelect />
      </SettingsRow>}
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow label={t("Finish and send")} description={t("Off by default: finish dictation, review the draft, then send. When enabled, pressing Send during recording finishes and sends after transcription. Enter during recording only finishes, regardless of this setting.")}>
        <Toggle label={t("Finish and send")} checked={settings.voiceFinishAndSend} onChange={(voiceFinishAndSend) => update({ voiceFinishAndSend })} />
      </SettingsRow>
    </SettingsGroup>
    {(settings.voiceProvider === "auto" || settings.voiceProvider === "openai") && <>
      <SettingsGroup title={t("Tidy dictated text")} section="tidy-dictation">
        <SettingsRow label={t("In chat")} description={t("Drops fillers and fixes spacing; code and paths stay as spoken")}>
          <Toggle label={t("Tidy dictated text in chat")} checked={settings.voicePolishChat} onChange={(voicePolishChat) => update({ voicePolishChat })} />
        </SettingsRow>
        <SettingsRow label={t("In the terminal")} description={t("Off keeps a command exactly as transcribed")}>
          <Toggle label={t("Tidy dictated text in the terminal")} checked={settings.voicePolishTerminal} onChange={(voicePolishTerminal) => update({ voicePolishTerminal })} />
        </SettingsRow>
      </SettingsGroup>
      <OpenAiKeySettings />
    </>}
    {(settings.voiceProvider === "auto" || settings.voiceProvider === "browser") && <SettingsGroup>
      <SettingsRow label={t("Speech service")} description={t("Browser speech recognition may send audio to the browser vendor, such as Google or Microsoft. Nothing records until you press the microphone.")}>
        <span className="settings-description">{t("Browser")}</span>
      </SettingsRow>
    </SettingsGroup>}
    {settings.voiceProvider === "speaches" && <><SpeachesBackendSettings policy={policy} /><SettingsGroup title={t("Speech server")} note={<>{t("Recordings pass through the WebUI backend to self-hosted Speaches after you finish, not OpenAI or a browser speech vendor. Apply consents to this route. Nothing records until you press the microphone.")} {t("Apply activates this configuration without contacting the speech server. Edits do not change an active recording; Apply cancels it.")}</>}>
      <SettingsRow label={t("Recognition language")} htmlFor="dictation-recognition-language" description={t("Supported languages depend on the selected model. Auto lets the speech backend detect the language.")}>
        <SttLanguageSelect value={language} onChange={setLanguage} disabled={policy?.language_selection !== true} />
      </SettingsRow>
      <SettingsRow label={t("Speech service")} description={policy?.enabled === false ? t("Save a speech server URL above, then Apply your dictation configuration.") : undefined} wide>
        <span className="settings-description">{t("Managed by the WebUI backend")}</span>
      </SettingsRow>
      <SettingsRow label={t("Model ID")} description={t("The first transcription may load the selected model. Listing a model does not verify inference.")} htmlFor="dictation-model" wide>
        <input id="dictation-model" className="input dictation-settings-input" value={model} maxLength={DICTATION_MODEL_MAX_CHARS} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" onChange={(event) => setModel(event.target.value)} />
      </SettingsRow>
      {models !== null && <SettingsRow label={t("Installed models")} description={t("Listed by the backend-managed speech service. Selection stays a draft until Apply.")} htmlFor="dictation-model-list" wide>
        <select id="dictation-model-list" className="select dictation-settings-input" value={models.includes(model) ? model : ""} onChange={(event) => { if (event.target.value) setModel(event.target.value); }}>
          <option value="">{t("Choose a listed model")}</option>
          {models.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </SettingsRow>}
      <SettingsRow label={t("Configuration")} description={!validModel ? t("Enter a non-empty model ID without control characters.") : !allowed ? t("Dictation is unavailable. Check the WebUI backend configuration and reload the app.") : undefined} wide>
        <div className="dictation-settings-actions">
          <button type="button" className="btn btn-primary" disabled={!validModel || !allowed || (!dirty && applied.activated)} onClick={apply}>{t("Apply")}</button>
          <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={discard}>{t("Discard edits")}</button>
        </div>
      </SettingsRow>
      <SettingsRow label={t("Connection and model check")} description={!applied.activated ? t("Apply a configuration before contacting the speech server.") : t("Read-only requests go through WebUI using the applied model, never an unsaved draft. No microphone or sample audio is used.")} wide>
        <div className="dictation-settings-actions">
          <button type="button" className="btn" disabled={!canRead || busy} onClick={() => void check()}>{t("Refresh models")}</button>
        </div>
      </SettingsRow>
      <div className="settings-item dictation-settings-status" role="status">
        {busy ? t("Checking applied speech server…") : models !== null ? models.includes(applied.model) ? t("Service reachable. Applied model listed as installed; inference not verified.") : t("Service reachable. Applied model is not listed; it remains unverified.") : applied.activated ? t("Configuration saved. Transcription is verified only by an actual recording.") : t("Not activated")}
        {models !== null && <span className="dictation-settings-endpoint">{applied.model}</span>}
      </div>
      {error !== null && <p className="settings-item dictation-settings-error" role="alert">{error}</p>}
    </SettingsGroup></>}
  </>;
}

function SpeachesBackendSettings({ policy }: { policy: DictationPolicy | null }) {
  const t = useT();
  const { settings, update } = useSettings();
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DictationSettingsError | null>(null);
  const environmentAdvice = (kind: DictationSettingsError) => kind === "base-url"
    ? t("HERDR_WEB_DICTATION_BASE_URL overrides the speech server URL. Change or unset it on the WebUI host, then restart WebUI.")
    : kind === "api-key"
      ? t("HERDR_WEB_DICTATION_API_KEY overrides the speech API key and locks the server URL. Change or unset it on the WebUI host, then restart WebUI.")
      : t("The environment overrides dictation settings. Change or unset HERDR_WEB_DICTATION_BASE_URL and/or HERDR_WEB_DICTATION_API_KEY on the WebUI host, then restart WebUI.");
  const controller = useRef<AbortController | null>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setBaseUrl(policy?.base_url ?? ""); }, [policy?.base_url]);
  useEffect(() => {
    const clear = () => { if (keyInput.current) keyInput.current.value = ""; };
    const hidden = () => { if (document.hidden) clear(); };
    window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", hidden);
    return () => { controller.current?.abort(); clear(); window.removeEventListener("pagehide", clear); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  const supported = policy?.base_url !== undefined;
  const keySupported = policy?.api_key_configured !== undefined;
  const keyLocked = policy?.api_key_source === "env";
  const locked = policy?.source === "env" || keyLocked;
  const takeKey = () => {
    const key = keyInput.current?.value.trim() ?? "";
    if (keyInput.current) keyInput.current.value = "";
    return key;
  };
  const save = async (change: { base_url?: string; api_key?: string | null }) => {
    if (busy || !supported) return;
    const request = new AbortController();
    controller.current = request;
    invalidateDictation();
    update({ dictation: { ...settings.dictation, activated: false } });
    setBusy(true);
    setError(null);
    try {
      const saved = await saveDictationBackend(change, request.signal);
      if (!request.signal.aborted) setBaseUrl(saved.base_url ?? "");
    } catch (error) { if (!request.signal.aborted) setError(dictationSettingsError(error, policy)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  return <SettingsGroup title={t("WebUI backend")} note={t("Saved on this PC for all connected browsers. Saving cancels dictation; Apply again to consent to the new route. Saving does not contact Speaches.")}>
    <SettingsRow label={t("Speech server URL")} htmlFor="dictation-base-url" description={locked ? environmentAdvice(policy?.source === "env" ? keyLocked ? "environment" : "base-url" : "api-key") : t("Full HTTP(S) API base URL, including any path such as /v1. Choose a trusted server; HTTP sends audio and API keys in plaintext. Leave empty to disable.")} stacked>
      <input id="dictation-base-url" type="url" className="input dictation-settings-key-input" value={baseUrl} placeholder="https://speaches.example.com/v1" disabled={!supported || locked || busy} maxLength={2000} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" onChange={(event) => setBaseUrl(event.target.value)} />
    </SettingsRow>
    {!locked && <SettingsRow label={t("Configuration")} description={!supported ? t("Update the WebUI backend to configure Speaches here.") : undefined} wide>
      <button type="button" className="btn" disabled={!supported || busy || baseUrl.trim() === policy?.base_url} onClick={() => { const key = takeKey(); void save({ base_url: baseUrl.trim(), ...(key ? { api_key: key } : {}) }); }}>{t("Save speech server")}</button>
    </SettingsRow>}
    <SettingsRow label={t("API key")} htmlFor="dictation-api-key" description={keyLocked ? environmentAdvice("api-key") : policy?.api_key_configured ? t("API key saved on this PC. To change the URL, re-enter its key or remove the saved key first.") : t("Optional. Stored only on the WebUI backend and never returned to the browser.")} stacked>
      {keySupported && !keyLocked && <form className="dictation-settings-key" onSubmit={(event) => {
        event.preventDefault();
        const key = takeKey();
        if (key) void save({ api_key: key, ...(!locked && baseUrl.trim() !== policy?.base_url ? { base_url: baseUrl.trim() } : {}) });
      }}>
        <input id="dictation-api-key" ref={keyInput} className="input dictation-settings-key-input" type="password" disabled={busy} autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" maxLength={2000} />
        <div className="dictation-settings-actions">
          <button type="submit" className="btn" disabled={busy}>{t("Save key")}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || !policy?.api_key_configured} onClick={() => { takeKey(); void save({ api_key: null }); }}>{t("Remove key")}</button>
        </div>
      </form>}
    </SettingsRow>
    {error && <p className="settings-item dictation-settings-error" role="alert">{error === "generic" ? t("Could not save the speech backend configuration. Check the URL, key settings and WebUI backend.") : environmentAdvice(error)}</p>}
  </SettingsGroup>;
}

function SttLanguageSelect({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }) {
  const t = useT();
  const locale = useLocale();
  const choices = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([locale], { type: "language" }); } catch { /* use language codes */ }
    // Whisper-compatible APIs use the Norwegian macro-language code, not nb-NO.
    return [...new Set(DICTATION_LANGUAGES.map((tag) => tag === "nb-NO" ? "no" : tag.split("-")[0]!))]
      .map((tag) => ({ tag, name: names?.of(tag) ?? tag })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);
  return <select id="dictation-recognition-language" className="select settings-select" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="auto">{t("Auto")}</option>
    {choices.map(({ tag, name }) => <option key={tag} value={tag}>{tag === "en" ? t("English (en)") : `${name} (${tag})`}</option>)}
  </select>;
}

function DictationLanguageSelect() {
  const { settings, update } = useSettings();
  const t = useT();
  const locale = useLocale();
  const choices = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try { names = new Intl.DisplayNames([locale], { type: "language" }); } catch { /* display tags when unavailable */ }
    return DICTATION_LANGUAGES.map((tag) => ({ tag, name: names?.of(tag) ?? tag })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);
  return <select id="settings-voice-language" className="select settings-select" value={settings.voiceLanguage} onChange={(event) => update({ voiceLanguage: event.target.value as DictationLanguage })}>
    <option value="auto">{t("Auto")}</option>
    {choices.map(({ tag, name }) => <option key={tag} value={tag}>{name}</option>)}
  </select>;
}

/** Only status enters React state. A typed secret stays in the DOM until one explicit save. */
function OpenAiKeySettings() {
  const t = useT();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void fetchVoiceStatus(controller.signal).then((value) => { if (!controller.signal.aborted) setStatus(value); }, () => { if (!controller.signal.aborted) setError(true); });
    const clear = () => { if (input.current) input.current.value = ""; };
    const onHidden = () => { if (document.hidden) clear(); };
    window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      live.current = false;
      controller.abort();
      clear();
      window.removeEventListener("pagehide", clear);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);
  const changeKey = async (api_key: string | null) => {
    if (busy || !status || status.source === "env") return;
    invalidateDictation();
    setBusy(true);
    setError(false);
    try {
      const saved = await saveVoiceConfig({ api_key });
      // Refresh every mounted microphone's server-key status, even if this page has closed.
      window.dispatchEvent(new Event("herdr-voice-status-changed"));
      if (live.current) setStatus(saved);
    } catch {
      // Never expose a server/provider error that might contain the submitted secret.
      if (live.current) setError(true);
    } finally {
      if (live.current) setBusy(false);
    }
  };
  return <SettingsGroup title={t("OpenAI API key")} section="openai-key" note={t("Audio is sent to OpenAI with your key. Nothing is recorded until you press the mic.")}>
    <SettingsRow label={t("OpenAI API key")} description={status ? status.configured ? status.source === "env" ? t("OpenAI key set by HERDR_WEB_OPENAI_API_KEY") : t("OpenAI key saved on this PC") : t("No OpenAI key configured. OpenAI dictation is unavailable.") : undefined} stacked>
      {status && status.source !== "env" && <form className="dictation-settings-key" onSubmit={(event) => {
        event.preventDefault();
        const key = input.current?.value.trim() ?? "";
        if (input.current) input.current.value = "";
        if (key) void changeKey(key);
      }}>
        <input ref={input} className="input dictation-settings-key-input" type="password" aria-label={t("OpenAI API key")} placeholder="sk-..." autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} />
        <div className="dictation-settings-actions">
          <button type="submit" className="btn" disabled={busy}>{t("Save key")}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || !status.configured} onClick={() => { if (input.current) input.current.value = ""; void changeKey(null); }}>{t("Remove key")}</button>
        </div>
      </form>}
    </SettingsRow>
    {error && <p className="settings-item dictation-settings-error" role="alert">{t("Could not read or save the OpenAI key configuration. Check the WebUI backend.")}</p>}
  </SettingsGroup>;
}
