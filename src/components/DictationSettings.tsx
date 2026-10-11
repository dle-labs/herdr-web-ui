import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale, useT } from "../lib/i18n.ts";
import { DICTATION_LANGUAGES, DICTATION_MODEL_MAX_CHARS, useSettings, type DictationLanguage, type VoiceProvider } from "../lib/settings.ts";
import { fetchVoiceStatus, saveVoiceConfig } from "../lib/api.ts";
import type { VoiceStatus } from "../../shared/voice.ts";
import { invalidateDictation } from "../lib/voice.ts";
import { configAllowed, discoverDictationModels, useDictationPolicy, validDictationModel, type DictationConfig } from "../lib/voiceTransport.ts";
import { Segmented, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./DictationSettings.css";

/** Draft edits never reach the capture engine. Only Apply commits a complete configuration. */
export function DictationSettings() {
  const { settings, update } = useSettings();
  const applied = settings.dictation;
  const policy = useDictationPolicy();
  const t = useT();
  const [mode, setMode] = useState(applied.mode);
  const [model, setModel] = useState(applied.model);
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
    setMode(applied.mode);
    setModel(applied.model);
    setModels(null);
    setBusy(false);
    setError(null);
    return invalidateRequests;
  }, [applied.version, applied.mode, applied.model, applied.activated]);
  const policyKey = JSON.stringify(policy);
  useLayoutEffect(() => {
    setModels(null);
    setBusy(false);
    setError(null);
    return invalidateRequests;
  }, [policyKey, settings.voiceProvider]);

  const validModel = model.length <= DICTATION_MODEL_MAX_CHARS && validDictationModel(model.trim());
  const candidate: DictationConfig = { version: 2, mode, model: model.trim(), activated: true };
  const allowed = policy !== null && configAllowed(candidate, policy);
  const dirty = mode !== applied.mode || model !== applied.model;
  const canRead = applied.activated && policy !== null && configAllowed(applied, policy);
  const apply = () => {
    if (!validModel || !allowed) return;
    invalidateRequests();
    setModels(null);
    setBusy(false);
    setError(null);
    setMode(candidate.mode);
    setModel(candidate.model);
    update({ dictation: candidate });
  };
  const discard = () => {
    invalidateRequests();
    setBusy(false);
    setError(null);
    setMode(applied.mode);
    setModel(applied.model);
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
    <SettingsGroup note={t("Only the selected provider is used. There is no automatic fallback to another provider. Nothing records until you press the microphone.")}>
      <SettingsRow label={t("Microphone button")} description={t("Auto and On show the microphone in chat, terminal and comment drafts on desktop and mobile, with a reason when unavailable. Off hides it.")} wide>
        <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => update({ voiceInput })} options={[{ value: "auto", label: t("Auto") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} />
      </SettingsRow>
      <SettingsRow label={t("Transcription provider")} htmlFor="voice-provider">
        <select id="voice-provider" className="select settings-select" value={settings.voiceProvider} onChange={(event) => update({ voiceProvider: event.target.value as VoiceProvider })}>
          <option value="openai">OpenAI</option>
          <option value="speaches">{t("Self-hosted (Speaches)")}</option>
          <option value="browser">{t("Browser")}</option>
        </select>
      </SettingsRow>
      {settings.voiceProvider !== "speaches" && <SettingsRow label={t("Dictation language")} description={t("Auto listens for the app's language, or for the browser's when the app is not translated into it")} htmlFor="settings-voice-language">
        <DictationLanguageSelect />
      </SettingsRow>}
    </SettingsGroup>
    {settings.voiceProvider === "openai" && <>
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
    {settings.voiceProvider === "browser" && <SettingsGroup>
      <SettingsRow label={t("Speech service")} description={t("Browser speech recognition may send audio to the browser vendor, such as Google or Microsoft. Nothing records until you press the microphone.")}>
        <span className="settings-description">{t("Browser")}</span>
      </SettingsRow>
    </SettingsGroup>}
    {settings.voiceProvider === "speaches" && <SettingsGroup title={t("Speech server")} note={<>{t("Audio passes through the WebUI backend to self-hosted Speaches, not OpenAI or a browser speech vendor. Apply consents to this route. Nothing records until you press the microphone.")} {t("Apply activates this configuration without contacting the speech server. Edits do not change an active recording; Apply cancels it.")}</>}>
      <SettingsRow label={t("Recognition language")}><span className="settings-description">{t("English (en)")}</span></SettingsRow>
      <SettingsRow label={t("Speech service")} description={policy?.enabled === false ? t("Configure HERDR_WEB_DICTATION_BASE_URL on the WebUI backend, restart it, then reload the app.") : undefined} wide>
        <span className="settings-description">{t("Managed by the WebUI backend")}</span>
      </SettingsRow>
      <SettingsRow label={t("Transcription mode")} description={t("The first transcription may load the selected model. Listing a model does not verify inference.")} wide>
        <Segmented label={t("Transcription mode")} value={mode} onChange={setMode} options={[{ value: "recording", label: t("Record then transcribe") }, { value: "live", label: t("Live preview") }]} />
      </SettingsRow>
      <SettingsRow label={t("Model ID")} description={t("Manual IDs are unverified. No models are downloaded or substituted here.")} htmlFor="dictation-model" wide>
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
          <button type="button" className="btn" disabled={!canRead || busy} onClick={() => void check()}>{t("Check")}</button>
        </div>
      </SettingsRow>
      <div className="settings-item dictation-settings-status" role="status">
        {busy ? t("Checking applied speech server…") : models !== null ? models.includes(applied.model) ? t("Service reachable. Applied model listed as installed; inference not verified.") : t("Service reachable. Applied model is not listed; it remains unverified.") : applied.activated ? t("Configuration saved. Transcription is verified only by an actual recording.") : t("Not activated")}
        {models !== null && <span className="dictation-settings-endpoint">{applied.model}</span>}
      </div>
      {error !== null && <p className="settings-item dictation-settings-error" role="alert">{error}</p>}
    </SettingsGroup>}
  </>;
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
    <SettingsRow label={t("OpenAI API key")} description={status ? status.configured ? status.source === "env" ? t("OpenAI key set by HERDR_WEB_OPENAI_API_KEY") : t("OpenAI key saved on this PC") : t("No OpenAI key configured. OpenAI dictation is unavailable.") : undefined} wide>
      {status && status.source !== "env" && <form className="dictation-settings-key" onSubmit={(event) => {
        event.preventDefault();
        const key = input.current?.value.trim() ?? "";
        if (input.current) input.current.value = "";
        if (key) void changeKey(key);
      }}>
        <input ref={input} className="input dictation-settings-input" type="password" aria-label={t("OpenAI API key")} placeholder="sk-..." autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} />
        <div className="dictation-settings-actions">
          <button type="submit" className="btn" disabled={busy}>{t("Save key")}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || !status.configured} onClick={() => { if (input.current) input.current.value = ""; void changeKey(null); }}>{t("Remove key")}</button>
        </div>
      </form>}
    </SettingsRow>
    {error && <p className="settings-item dictation-settings-error" role="alert">{t("Could not read or save the OpenAI key configuration. Check the WebUI backend.")}</p>}
  </SettingsGroup>;
}
