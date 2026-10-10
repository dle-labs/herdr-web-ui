/** Dictation controls insert drafts; an explicit caller-owned Send may continue after the draft commits. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Mic, Square, Undo2, X } from "lucide-react";
import "./VoiceInput.css";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings, wantsVoiceInput } from "../lib/settings.ts";
import { isMacPlatform, isVoiceShortcut } from "../lib/shortcuts.ts";
import { insertAtCaret, subscribeDictationInvalidation, useVoiceInput, type VoiceInput, type VoiceText } from "../lib/voice.ts";
import { createDictationDraft, type DictationSnapshot } from "../lib/dictationDraft.ts";
import { createDictationUndo } from "../lib/dictationUndo.ts";
import { VOICE_MAX_SECONDS } from "../../shared/voice.ts";

function errorNote(t: Translate, error: string): string | null {
  switch (error) {
    case "disabled": return null;
    case "insecure": return t("Voice input needs HTTPS");
    case "permission": return t("Microphone permission was denied");
    case "no_mic": return t("No microphone found");
    case "not_configured": return t("Apply a model and mode in Settings > Dictation");
    case "server_not_configured": return t("Configure HERDR_WEB_DICTATION_BASE_URL on the WebUI backend, restart it, then reload the app.");
    case "policy": return t("Dictation configuration changed. Reload the app and check Settings > Dictation.");
    case "busy": return t("Another input or tab is using dictation");
    case "timeout": return t("The speech server took too long to respond");
    case "missing_model": return t("The selected speech model is not installed");
    case "too_large": return t("Recording is too long");
    case "no_speech": return t("No speech was heard");
    case "format": return t("The recording or speech response format is not supported");
    case "unsupported": return t("This browser cannot record audio");
    default: return t("Transcription failed. Check the WebUI backend and its speech service connection.");
  }
}

type SurfaceKind = "chat" | "terminal" | "comment";
interface VoiceTarget {
  mode: SurfaceKind;
  box: RefObject<HTMLTextAreaElement | null>;
  surface: () => Element | null;
  available: () => boolean;
  active: () => boolean;
  cancel: () => void;
  press: () => void;
}
const targets = new Set<VoiceTarget>();

/** A modal's focused controls own shortcuts; never reach the composer behind Settings. */
function eligibleTargets(eventTarget: EventTarget | null): VoiceTarget[] {
  const element = eventTarget instanceof Element ? eventTarget : document.activeElement;
  const modal = element?.closest("[aria-modal='true'], dialog[open]");
  return [...targets].filter((target) => {
    const box = target.box.current;
    // The composer replaces its textarea while recording; its visible surface still owns Escape.
    const visible = box && (box.getClientRects().length > 0 || (target.active() && (target.surface()?.getClientRects().length ?? 0) > 0));
    return Boolean(visible) && (!modal || modal.contains(box));
  });
}

/** Shared with comment Escape handling, so window-listener registration order cannot dismiss a recording. */
export function consumeDictationEscape(event: KeyboardEvent, within?: Element | null): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  const target = eligibleTargets(event.target).find((candidate) => candidate.active()
    && (!within || within.contains(candidate.box.current)));
  if (!target) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  target.cancel();
  return true;
}

function onKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || consumeDictationEscape(event)) return;
  if (!isVoiceShortcut(event, isMacPlatform())) return;
  const candidates = eligibleTargets(event.target);
  const focused = event.target instanceof Node ? event.target : document.activeElement;
  // Choose ownership before availability: a disabled/recovering comment must not fall through to chat.
  const target = candidates.find((candidate) => candidate.surface()?.contains(focused))
    ?? candidates.find((candidate) => candidate.mode === "comment")
    ?? candidates.find((candidate) => candidate.mode === "chat") ?? candidates[0];
  if (!target) return;
  // Even when unavailable, this shortcut must not become a native Space-click on Insert/Discard.
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat && target.available()) target.press();
}
function registerTarget(target: VoiceTarget): () => void {
  if (targets.size === 0) window.addEventListener("keydown", onKey, true);
  targets.add(target);
  return () => {
    targets.delete(target);
    if (targets.size === 0) window.removeEventListener("keydown", onKey, true);
  };
}

export interface DictationOptions {
  mode: SurfaceKind;
  /** Machine-scoped pane plus opening/target identity; never a mutable global target. */
  owner: string;
  connected: boolean;
  box: RefObject<HTMLTextAreaElement | null>;
  surface?: RefObject<HTMLElement | null>;
  read: () => string;
  /** Update the visible draft only, without raising the soft keyboard. */
  write: (value: string, caret: number) => void;
  maxLength?: number;
  onNote: (note: string | null) => void;
}
export interface Dictation {
  shown: boolean;
  connected: boolean;
  unavailableNote: string | null;
  statusId: string;
  voice: VoiceInput;
  cancel: () => void;
  press: () => void;
  /** Finish this take, then continue only after safe insertion and a committed idle draft. */
  finishAndSubmit: (submit: () => void) => void;
  recovery: string | null;
  insertRecovery: () => void;
  canUndo: boolean;
  undo: () => void;
}

export function useDictation(options: DictationOptions): Dictation {
  const t = useT();
  const statusId = useId();
  const { settings } = useSettings();
  const latest = useRef(options);
  latest.current = options;
  const tracker = useRef(createDictationDraft());
  const history = useRef(createDictationUndo());
  const [canUndo, setCanUndo] = useState(false);
  const take = useRef<{ snapshot: DictationSnapshot; config: string } | null>(null);
  const submitIntent = useRef<{ take: NonNullable<typeof take.current>; submit: () => void; value?: string; caret?: number } | null>(null);
  const composing = useRef(false);
  const insertedCaret = useRef<{ owner: string; value: string; caret: number } | null>(null);
  const recoveryRef = useRef<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const configKey = JSON.stringify(settings.dictation);
  const liveConfig = useRef(configKey);
  liveConfig.current = configKey;
  const wanted = wantsVoiceInput(settings.voiceInput, options.mode);
  const enabled = useRef(wanted);
  enabled.current = wanted;
  const clear = useCallback((): void => {
    submitIntent.current = null;
    tracker.current.cancel();
    take.current = null;
    recoveryRef.current = null;
    setRecovery(null);
  }, []);
  const sync = useCallback((): void => {
    const { box, read } = latest.current;
    const value = read();
    history.current.observe(value);
    setCanUndo(history.current.available());
    // DOM selection is valid only for the revision the DOM is displaying.
    const element = box.current;
    tracker.current.observe(value, element?.value === value
      ? { start: element.selectionStart, end: element.selectionEnd } : null);
  }, []);
  const insert = useCallback((text: string, selection: { start: number; end: number }): boolean => {
    const { read, write, maxLength, onNote } = latest.current;
    const before = read();
    if (!text.trim()) { clear(); return true; }
    const next = insertAtCaret(before, selection.start, selection.end, text);
    if (next.value.length > (maxLength ?? Infinity)) {
      onNote(t("The dictation does not fit in the box"));
      return false;
    }
    const from = Math.max(0, Math.min(selection.start, selection.end, before.length));
    const to = Math.min(before.length, Math.max(selection.start, selection.end, from));
    history.current.record(before, next.value, from, to);
    setCanUndo(history.current.available());
    insertedCaret.current = { owner: latest.current.owner, value: next.value, caret: next.end };
    write(next.value, next.end);
    onNote(null);
    clear();
    return true;
  }, [clear, t]);
  const onText = useCallback((result: VoiceText): void => {
    const captured = take.current;
    const current = latest.current;
    if (!captured || !enabled.current || !current.connected || captured.config !== liveConfig.current
      || !tracker.current.current(captured.snapshot, current.owner)) return;
    sync();
    const intent = submitIntent.current;
    submitIntent.current = null;
    if (!composing.current && tracker.current.unchanged(captured.snapshot)
      && insert(result.text, captured.snapshot.selection)) {
      // insert clears the capture lifecycle, not this explicitly requested continuation.
      if (result.text.trim() && intent?.take === captured) {
        submitIntent.current = { ...intent, value: latest.current.read(), caret: insertedCaret.current?.caret };
      }
      return;
    }
    recoveryRef.current = result.text;
    setRecovery(result.text);
  }, [insert, sync]);
  const voice = useVoiceInput({ enabled: wanted, config: settings.dictation, onText });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const cancel = useCallback((): void => { clear(); voiceRef.current.cancel(); }, [clear]);
  // Keep the entry point discoverable on every layout, even before setup or on HTTP.
  const shown = wanted;
  const undo = useCallback((): void => {
    if (voiceRef.current.state !== "idle" || recoveryRef.current !== null || composing.current) return;
    const current = latest.current;
    const result = history.current.undo(current.read());
    setCanUndo(history.current.available());
    if (!result) return;
    tracker.current.changed();
    insertedCaret.current = { owner: current.owner, value: result.value, caret: result.caret };
    current.write(result.value, result.caret);
    current.onNote(null);
  }, []);

  // The setter's synchronous invalidation clears even idle, IME-held recovery before a settings commit.
  useEffect(() => subscribeDictationInvalidation(clear), [clear]);
  useLayoutEffect(() => {
    history.current.clear(latest.current.read());
    setCanUndo(false);
    cancel();
    return cancel;
  }, [options.owner, options.connected, wanted, configKey, cancel]);
  const lastValue = useRef(options.read());
  useLayoutEffect(() => {
    const value = latest.current.read();
    history.current.observe(value);
    setCanUndo(history.current.available());
    if (lastValue.current !== value) {
      if (submitIntent.current?.value !== value) submitIntent.current = null;
      tracker.current.observe(value, null);
      if (value === "") cancel();
      lastValue.current = value;
    }
  });
  // Restore in the text commit, not an animation frame that could overwrite the user's next selection.
  useLayoutEffect(() => {
    const pending = insertedCaret.current;
    insertedCaret.current = null;
    const element = options.box.current;
    if (pending && pending.owner === options.owner && element?.value === pending.value) {
      element.setSelectionRange(pending.caret, pending.caret);
      tracker.current.observe(pending.value, { start: pending.caret, end: pending.caret });
      if (pending.caret === element.value.length) element.scrollTop = element.scrollHeight;
    }
  });
  useEffect(() => {
    const element = options.box.current;
    if (!element) return;
    const selection = (): void => {
      tracker.current.observe(element.value, { start: element.selectionStart, end: element.selectionEnd });
      const intent = submitIntent.current;
      if (intent && (intent.value === undefined ? !tracker.current.unchanged(intent.take.snapshot)
        : element.value !== intent.value || element.selectionStart !== intent.caret || element.selectionEnd !== intent.caret)) {
        submitIntent.current = null;
      }
    };
    const input = (): void => {
      // Count edits even if undo returns to the text captured at take start.
      submitIntent.current = null;
      tracker.current.changed();
      // Do not set React state in the native input listener: a render here can restore a
      // controlled textarea's old value before its delegated onChange reads the edit.
      history.current.observe(element.value);
      selection();
      if (element.value === "") cancel();
    };
    const start = (): void => { submitIntent.current = null; composing.current = true; tracker.current.changed(); };
    const end = (): void => { composing.current = false; };
    element.addEventListener("input", input);
    element.addEventListener("select", selection);
    element.addEventListener("keyup", selection);
    element.addEventListener("pointerup", selection);
    element.addEventListener("compositionstart", start);
    element.addEventListener("compositionend", end);
    return () => {
      element.removeEventListener("input", input);
      element.removeEventListener("select", selection);
      element.removeEventListener("keyup", selection);
      element.removeEventListener("pointerup", selection);
      element.removeEventListener("compositionstart", start);
      element.removeEventListener("compositionend", end);
    };
  }, [options.box, cancel]);
  useEffect(() => {
    if (voice.state === "starting") latest.current.onNote(null);
    else if (voice.error) latest.current.onNote(errorNote(t, voice.error === "not_configured" ? "server_not_configured" : voice.error));
  }, [voice.error, voice.state, t]);
  useEffect(() => {
    const hidden = (): void => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("offline", cancel);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("offline", cancel);
    };
  }, [cancel]);

  const press = useCallback((): void => {
    const engine = voiceRef.current;
    if (!latest.current.connected || !engine.available || recoveryRef.current !== null) return;
    if (engine.state === "idle") {
      sync();
      const snapshot = tracker.current.begin(latest.current.owner);
      if (!snapshot) return;
      take.current = { snapshot, config: liveConfig.current };
    }
    engine.press();
  }, [sync]);
  const finishAndSubmit = useCallback((submit: () => void): void => {
    const captured = take.current;
    if (submitIntent.current || voiceRef.current.state !== "recording" || !captured
      || !latest.current.connected || !enabled.current || composing.current
      || recoveryRef.current !== null || captured.config !== liveConfig.current) return;
    sync();
    if (!tracker.current.current(captured.snapshot, latest.current.owner) || !tracker.current.unchanged(captured.snapshot)) {
      voiceRef.current.press(); // Finish as a recoverable draft, never submit an edited take.
      return;
    }
    submitIntent.current = { take: captured, submit };
    voiceRef.current.press();
  }, [sync]);
  useEffect(() => {
    const intent = submitIntent.current;
    if (!intent || voice.state !== "idle") return;
    submitIntent.current = null; // Claim before calling out: no retry or duplicate, including reentrant renders.
    const current = latest.current;
    if (intent.value === undefined || voice.error || composing.current || !current.connected || !enabled.current
      || intent.take.snapshot.owner !== current.owner || intent.take.config !== liveConfig.current
      || document.hidden || current.read() !== intent.value || current.box.current?.value !== intent.value
      || current.box.current.selectionStart !== intent.caret || current.box.current.selectionEnd !== intent.caret) return;
    intent.submit();
  });
  const insertRecovery = useCallback((): void => {
    const captured = take.current;
    const text = recoveryRef.current;
    if (text === null || !captured || !latest.current.connected || !enabled.current
      || captured.config !== liveConfig.current || !tracker.current.current(captured.snapshot, latest.current.owner)) return;
    // Recheck the draft revision without deriving a cursor from whichever button is focused.
    tracker.current.observe(latest.current.read(), null);
    const cursor = tracker.current.cursor();
    if (composing.current || cursor === null) {
      latest.current.onNote(t("Place the cursor in the draft before inserting dictation"));
      return;
    }
    insert(text, cursor);
  }, [insert]);
  useEffect(() => {
    if (!shown) return;
    return registerTarget({
      mode: options.mode, box: options.box,
      surface: () => latest.current.surface?.current ?? latest.current.box.current?.closest(".comment-popover, .composer, .terminal-input") ?? null,
      available: () => voiceRef.current.available && latest.current.connected && recoveryRef.current === null,
      active: () => voiceRef.current.state !== "idle" || recoveryRef.current !== null,
      cancel, press,
    });
  }, [shown, options.mode, options.box, cancel, press]);
  const unavailableNote = !options.connected ? t("Not sent: the terminal is disconnected.")
    : voice.unavailableReason ? errorNote(t, voice.unavailableReason) : null;
  return { shown, connected: options.connected, unavailableNote, statusId, voice: { ...voice, cancel }, cancel, press, finishAndSubmit, recovery, insertRecovery, canUndo, undo };
}

/** Tap-to-toggle also works with Enter/Space. Pointer presses never force the keyboard open. */
export function MicButton({ dictation, className = "" }: { dictation: Dictation; className?: string }) {
  const t = useT();
  const { voice, connected, press, recovery } = dictation;
  const pointerClick = useRef(false);
  const recording = voice.state === "recording";
  const starting = voice.state === "starting";
  const reason = !connected ? t("Not sent: the terminal is disconnected.")
    : voice.unavailableReason ? errorNote(t, voice.unavailableReason) : null;
  const label = starting ? t("Cancel dictation") : recording ? t("Finish dictation") : t("Start dictation");
  return <span className={`voice-mic-wrap ${className}`} data-state={voice.state}>
    <span className="voice-mic-ring" ref={voice.bindRing} aria-hidden="true" />
    <button type="button" className="voice-mic" aria-label={label} aria-pressed={recording} title={reason ?? label}
      aria-describedby={reason ? dictation.statusId : undefined}
      disabled={!voice.available || !connected || voice.state === "transcribing" || recovery !== null}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        pointerClick.current = true;
        press();
      }}
      onPointerCancel={() => { pointerClick.current = false; }}
      onClick={(event) => {
        if (pointerClick.current && event.detail !== 0) { pointerClick.current = false; return; }
        pointerClick.current = false;
        press();
      }}>
      {starting ? <X aria-hidden="true" /> : recording ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
    </button>
    {dictation.canUndo && <button type="button" className="voice-pill-button" aria-label={t("Undo last dictation")} title={t("Undo last dictation")}
      disabled={voice.state !== "idle" || recovery !== null || !connected}
      onPointerDown={(event) => event.preventDefault()} onClick={dictation.undo}><Undo2 aria-hidden="true" /></button>}
  </span>;
}

/** In-flow status works in narrow comment popovers and sheets as well as the composer. */
export function VoiceRecordingPill({ dictation, align, barCount = 7 }: { dictation: Dictation; align: "start" | "end"; barCount?: number }) {
  const t = useT();
  const { voice, recovery, unavailableNote, statusId } = dictation;
  const open = voice.state !== "idle" || recovery !== null || unavailableNote !== null;
  const seconds = Math.floor(voice.elapsedMs / 1000);
  const label = recovery !== null ? t("Draft changed. Review the dictation before inserting.")
    : voice.state === "transcribing" ? t("Transcribing…")
    : voice.state === "starting" ? t("Starting microphone…") : unavailableNote ?? (voice.silent ? t("No microphone input") : t("Recording"));
  return <><div className={`voice-pill${open ? " is-open" : ""}`} data-state={voice.state} data-align={align} hidden={!open}>
    {voice.state === "recording" && recovery === null && unavailableNote === null && <>
      <span className="voice-bars" ref={voice.bindBars} aria-hidden="true">{Array.from({ length: barCount }, (_, i) => <span key={i} data-voice-bar="" />)}</span>
      <span className="voice-meter" aria-hidden="true"><span ref={voice.bindMeter} /></span>
    </>}
    <span id={statusId} className="voice-pill-label" role="status" aria-live="polite">{open ? label : ""}</span>
    {recovery !== null ? <>
      <p className="voice-recovery-text">{recovery}</p>
      <button type="button" className="btn" onPointerDown={(event) => event.preventDefault()} onClick={dictation.insertRecovery}>{t("Insert at cursor")}</button>
      <button type="button" className="btn btn-ghost" onClick={dictation.cancel}>{t("Discard")}</button>
    </> : unavailableNote !== null ? null : <>
      {voice.state === "recording" && <span className="voice-timer" aria-hidden="true">{Math.min(seconds, VOICE_MAX_SECONDS)}s</span>}
      <button type="button" className="voice-pill-button" aria-label={t("Cancel dictation")} title={t("Cancel dictation")}
        onPointerDown={(event) => event.preventDefault()} onClick={dictation.cancel}><X aria-hidden="true" /></button>
    </>}
  </div>
    {voice.preview && recovery === null && (voice.state === "recording" || voice.state === "transcribing") && <p className="voice-preview" role="region" aria-label={t("Dictation preview")} aria-live="off">{voice.preview}</p>}
  </>;
}
