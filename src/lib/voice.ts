import { prepareLiveDictation, type LiveDictation } from "./dictationStream.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { configAllowed, DICTATION_MAX_BYTES, DictationTransportError, recorderExtension, transcribeDictation, useDictationPolicy, type DictationConfig, type DictationTransportCode } from "./voiceTransport.ts";

export type VoiceState = "idle" | "starting" | "recording" | "transcribing";
export type VoiceError = DictationTransportCode | "insecure" | "permission" | "no_mic" | "busy";
export type VoiceUnavailable = "disabled" | "insecure" | "not_configured" | "unsupported" | "policy";
export interface VoiceText { text: string; take: number; phase: "raw" }
export interface VoiceInputOptions { enabled: boolean; config: DictationConfig; onText(result: VoiceText): void; onPartial?(text: string): void }
export interface VoiceInput {
  available: boolean; unavailableReason: VoiceUnavailable | null; state: VoiceState;
  elapsedMs: number; silent: boolean; error: VoiceError | null; preview: string;
  press(): void; release(): void; finish(): void; cancel(): void;
  bindBars(el: HTMLElement | null): void; bindRing(el: HTMLElement | null): void; bindMeter(el: HTMLElement | null): void;
}
export function pickRecorderMime(supported: (type: string) => boolean): { mimeType: string; extension: string } | null {
  for (const mimeType of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (supported(mimeType)) return { mimeType, extension: recorderExtension(mimeType)! };
  }
  return null;
}
export function micErrorReason(name: string): VoiceError { return name === "NotAllowedError" || name === "SecurityError" ? "permission" : "no_mic"; }
export function smoothLevel(previous: number, target: number, dtMs: number): number {
  return previous + (target - previous) * (1 - Math.exp(-Math.max(0, dtMs) / (target > previous ? 60 : 250)));
}
export function levelFromRms(rms: number): number { return rms > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 50)) : 0; }
export function barScales(level: number, timeMs: number, count = 7): number[] {
  const amount = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const pulse = 0.85 + 0.15 * Math.sin(timeMs / 110);
  return Array.from({ length: count }, (_, index) => {
    // One envelope spans the entire surface, regardless of its bar count.
    const position = count > 1 ? index / (count - 1) : 0.5;
    const weight = 0.45 + 0.55 * Math.sin(position * Math.PI);
    // Silence is stationary: motion must come from captured audio, not an idle pulse.
    const base = 0.12;
    return Math.min(1, base + (1 - base) * amount * weight * pulse);
  });
}
export function insertAtCaret(value: string, selectionStart: number, selectionEnd: number, text: string): { value: string; start: number; end: number } {
  const from = Math.max(0, Math.min(selectionStart, selectionEnd, value.length));
  const to = Math.min(value.length, Math.max(selectionStart, selectionEnd, from));
  const spoken = text.trim();
  if (!spoken) return { value, start: from, end: to };
  const before = value.slice(0, from), after = value.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const start = before.length + lead.length;
  return { value: before + lead + spoken + trail + after, start, end: start + spoken.length };
}

let owner: { cancel(): void } | null = null;
let nextTake = 0;
const invalidationListeners = new Set<() => void>();
export function invalidateDictation(): void {
  owner?.cancel();
  for (const listener of [...invalidationListeners]) listener();
}
export function subscribeDictationInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}
export interface VoiceEngineIO {
  options(): VoiceInputOptions;
  available(): boolean;
  setState(state: VoiceState): void;
  setError(error: VoiceError | null): void;
  setElapsed(ms: number): void;
  setSilent(silent: boolean): void;
  setPreview?(text: string): void;
}
export interface VoiceEngineDependencies {
  prepareLive?(): LiveDictation;
  permission(): Promise<MediaStream>;
  recorder(stream: MediaStream, mime: string): MediaRecorder;
  mime(): { mimeType: string; extension: string } | null;
  transcribe(config: DictationConfig, blob: Blob, signal: AbortSignal): Promise<string>;
  /** Callback holds the lock until its promise resolves; null means another tab owns it. */
  lock?: (callback: (acquired: boolean) => Promise<void>) => Promise<void>;
  now(): number;
  timer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}
function browserDependencies(): VoiceEngineDependencies {
  return {
    prepareLive: prepareLiveDictation,
    permission: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    recorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType }),
    mime: () => typeof MediaRecorder === "undefined" ? null : pickRecorderMime((type) => MediaRecorder.isTypeSupported(type)),
    transcribe: transcribeDictation,
    lock: typeof navigator !== "undefined" && navigator.locks ? async (callback) => { await navigator.locks.request("herdr-dictation", { ifAvailable: true }, (lock) => callback(!!lock)); } : undefined,
    // Invoke Window timers with their native receiver, not the dependency object's `this`.
    now: () => performance.now(), timer: (callback, ms) => setTimeout(callback, ms), clearTimer: (timer) => clearTimeout(timer),
  };
}
interface Take {
  id: number; config: DictationConfig; onText: VoiceInputOptions["onText"];
  controller: AbortController; stream: MediaStream | null; recorder: MediaRecorder | null;
  chunks: Blob[]; bytes: number; timers: Set<ReturnType<typeof setTimeout>>;
  unlock?: () => void; stopMeter?: () => void; live?: LiveDictation; onPartial?: (text: string) => void;
}
/** One tab-wide owner, including unresolved permission and completed-file inference. */
export function createVoiceEngine(io: VoiceEngineIO, deps: VoiceEngineDependencies = browserDependencies()) {
  let take: Take | null = null;
  let phase: VoiceState = "idle";
  let bars: HTMLElement | null = null, ring: HTMLElement | null = null, meter: HTMLElement | null = null;
  const setPhase = (state: VoiceState) => { phase = state; io.setState(state); };
  const valid = (current: Take) => take === current && !current.controller.signal.aborted;
  const stopTracks = (current: Take) => {
    current.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    current.stream = null;
    current.stopMeter?.(); current.stopMeter = undefined;
  };
  function dispose(current: Take): void {
    current.controller.abort();
    current.live?.cancel(); current.live = undefined;
    io.setPreview?.("");
    for (const timer of current.timers) deps.clearTimer(timer);
    current.timers.clear();
    const recorder = current.recorder;
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = recorder.onstart = null;
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* already stopped */ }
    }
    stopTracks(current);
    current.chunks.length = 0; current.recorder = null;
    current.unlock?.();
    if (take === current) take = null;
    if (owner === engine) owner = null;
  }
  function cancel(): void {
    if (take) dispose(take);
    io.setPreview?.(""); setPhase("idle"); io.setSilent(false);
  }
  function fail(current: Take, code: VoiceError): void {
    if (!valid(current)) return;
    dispose(current); io.setError(code); setPhase("idle");
  }
  function schedule(current: Take, callback: () => void, ms: number): void {
    const timer = deps.timer(() => { current.timers.delete(timer); if (valid(current)) callback(); }, ms);
    current.timers.add(timer);
  }
  function startMeter(current: Take): void {
    if (typeof AudioContext === "undefined") return;
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(current.stream!);
      const analyser = context.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let last = deps.now(), loud = last, level = 0;
      const frame = () => {
        if (!valid(current) || phase !== "recording") return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        const now = deps.now();
        level = smoothLevel(level, levelFromRms(rms), now - last); last = now;
        if (rms >= 0.003) loud = now;
        io.setSilent(now - loud >= 3000);
        const barElements = bars?.querySelectorAll<HTMLElement>("[data-voice-bar]");
        if (barElements) {
          const scales = barScales(level, now, barElements.length);
          barElements.forEach((bar, index) => { bar.style.transform = `scaleY(${scales[index]})`; });
        }
        if (ring) ring.style.transform = `scale(${1 + level * 0.35})`;
        if (meter) meter.style.transform = `scaleX(${level})`;
        schedule(current, frame, 50);
      };
      current.stopMeter = () => {
        source.disconnect(); analyser.disconnect(); void context!.close().catch(() => undefined);
        if (ring) ring.style.transform = "scale(1)";
        if (meter) meter.style.transform = "scaleX(0)";
      };
      void context.resume().catch(() => undefined); frame();
    } catch { void context?.close().catch(() => undefined); }
  }
  async function deliver(current: Take): Promise<void> {
    if (!valid(current)) return;
    const type = current.recorder?.mimeType ?? "";
    if (!recorderExtension(type)) { fail(current, "format"); return; }
    const blob = new Blob(current.chunks, { type }); current.chunks.length = 0;
    if (!blob.size) { fail(current, "no_speech"); return; }
    try {
      const text = await deps.transcribe(current.config, blob, current.controller.signal);
      if (!valid(current)) return;
      const result: VoiceText = { text, take: current.id, phase: "raw" };
      dispose(current); setPhase("idle"); current.onText(result);
    } catch (error) {
      if (valid(current)) fail(current, error instanceof DictationTransportError ? error.code : "network");
    }
  }
  function finish(): void {
    const current = take;
    if (!current || phase === "transcribing") return;
    if (phase === "starting") { cancel(); return; }
    setPhase("transcribing");
    for (const timer of current.timers) deps.clearTimer(timer);
    current.timers.clear();
    if (current.live) {
      stopTracks(current);
      schedule(current, () => fail(current, "timeout"), 65_000);
      void current.live.finish().then((text) => {
        if (!valid(current)) return;
        const result: VoiceText = { text, take: current.id, phase: "raw" };
        dispose(current); setPhase("idle"); current.onText(result);
      }).catch((error) => { if (valid(current)) fail(current, error instanceof DictationTransportError ? error.code : "network"); });
      return;
    }
    current.recorder!.onstop = () => { if (valid(current)) void deliver(current); };
    // Tracks close synchronously, not after a delayed recorder stop event.
    stopTracks(current);
    schedule(current, () => fail(current, "timeout"), 65_000);
    try { current.recorder!.stop(); } catch { fail(current, "format"); }
  }
  async function acquire(current: Take, mime: string): Promise<void> {
    try {
      const stream = await deps.permission();
      if (!valid(current)) { stream.getTracks().forEach((track) => track.stop()); return; }
      for (const timer of current.timers) deps.clearTimer(timer);
      current.timers.clear();
      current.stream = stream;
      stream.getTracks().forEach((track) => { track.onended = () => { if (valid(current)) cancel(); }; });
      if (current.live) {
        schedule(current, () => fail(current, "timeout"), 30_000);
        await current.live.start(current.config, stream, current.controller.signal, (text) => {
          if (!valid(current)) return;
          io.setPreview?.(text); current.onPartial?.(text);
        }, (error) => {
          if (!valid(current)) return;
          if (error instanceof DOMException && error.name === "AbortError") cancel();
          else fail(current, error instanceof DictationTransportError ? error.code : "network");
        }, () => { if (valid(current)) finish(); });
        if (!valid(current)) return;
        captureReady(current);
        return;
      }
      let recorder: MediaRecorder;
      try { recorder = deps.recorder(stream, mime); } catch { fail(current, "format"); return; }
      current.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!valid(current)) return;
        current.bytes += event.data.size;
        if (current.bytes > DICTATION_MAX_BYTES) { fail(current, "too_large"); return; }
        if (event.data.size) current.chunks.push(event.data);
      };
      recorder.onerror = () => fail(current, "format");
      // An unexpected recorder termination is cancellation, never permission to upload.
      recorder.onstop = () => { if (valid(current)) cancel(); };
      // Permission is not capture readiness: only the recorder's start event may
      // enable recording indicators, the level meter and the elapsed timer.
      recorder.onstart = () => {
        if (!valid(current) || phase !== "starting") return;
        captureReady(current);
      };
      schedule(current, () => fail(current, "timeout"), 30_000);
      try { recorder.start(250); } catch { fail(current, "format"); }
    } catch (error) { if (valid(current)) fail(current, micErrorReason(error instanceof Error ? error.name : "")); }
  }
  function captureReady(current: Take): void {
    for (const timer of current.timers) deps.clearTimer(timer);
    current.timers.clear();
    setPhase("recording"); startMeter(current);
    const started = deps.now();
    const tick = () => { io.setElapsed(Math.min(120_000, deps.now() - started)); schedule(current, tick, 250); };
    schedule(current, tick, 250); schedule(current, finish, 120_000);
  }
  function press(): void {
    if (phase === "starting" || phase === "recording") { finish(); return; }
    if (phase === "transcribing") return;
    if (!io.available() || !io.options().enabled) return;
    if (owner) { io.setError("busy"); return; }
    const options = io.options();
    const mime = options.config.mode === "live" ? { mimeType: "", extension: "" } : deps.mime();
    if (!mime || (options.config.mode === "live" && !deps.prepareLive)) { io.setError("format"); return; }
    const current: Take = { id: ++nextTake, config: { ...options.config }, onText: options.onText, onPartial: options.onPartial, controller: new AbortController(), stream: null, recorder: null, chunks: [], bytes: 0, timers: new Set() };
    take = current; owner = engine;
    io.setPreview?.(""); io.setError(null); io.setElapsed(0); io.setSilent(false); setPhase("starting");
    if (options.config.mode === "live") {
      try { current.live = deps.prepareLive!(); } catch { fail(current, "format"); return; }
    }
    schedule(current, () => fail(current, "timeout"), 30_000);
    const begin = () => acquire(current, mime.mimeType);
    if (deps.lock) {
      void deps.lock(async (acquired) => {
        if (!valid(current)) return;
        if (!acquired) { fail(current, "busy"); return; }
        const held = new Promise<void>((resolve) => { current.unlock = resolve; });
        void begin();
        await held;
      }).catch(() => { if (valid(current)) fail(current, "busy"); });
    } else void begin();
  }
  const engine = {
    press, release: () => undefined, finish, cancel, onHidden: cancel,
    bindBars: (el: HTMLElement | null) => { bars = el; },
    bindRing: (el: HTMLElement | null) => { ring = el; },
    bindMeter: (el: HTMLElement | null) => { meter = el; },
  };
  return engine;
}
export function useVoiceInput(options: VoiceInputOptions): VoiceInput {
  const policy = useDictationPolicy();
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (options.config.mode === "live" ? typeof AudioWorkletNode !== "undefined" && typeof AudioContext !== "undefined" : typeof MediaRecorder !== "undefined" && !!pickRecorderMime((type) => MediaRecorder.isTypeSupported(type)));
  const unavailableReason: VoiceUnavailable | null = !options.enabled ? "disabled" : !secure ? "insecure" : !supported ? "unsupported" : !options.config.activated ? "not_configured" : !configAllowed(options.config, policy) ? "policy" : null;
  const available = unavailableReason === null;
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [elapsedMs, setElapsed] = useState(0);
  const [silent, setSilent] = useState(false);
  const [preview, setPreview] = useState("");
  const latest = useRef({ options, available }); latest.current = { options, available };
  const [voice] = useState(() => createVoiceEngine({ options: () => latest.current.options, available: () => latest.current.available, setState, setError, setElapsed, setSilent, setPreview }));
  useLayoutEffect(() => () => voice.cancel(), [voice, available, options.config.version, options.config.mode, options.config.model, options.config.activated]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) voice.cancel(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", voice.cancel);
    window.addEventListener("offline", voice.cancel);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", voice.cancel);
      window.removeEventListener("offline", voice.cancel);
      voice.cancel();
    };
  }, [voice]);
  useEffect(() => subscribeDictationInvalidation(voice.cancel), [voice]);
  return { ...voice, available, unavailableReason, state, error, elapsedMs, silent, preview };
}
