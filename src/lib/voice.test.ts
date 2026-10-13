import { afterEach, describe, expect, it } from "bun:test";
import { HOLD_MS, barScales, classifyRelease, resolveVoiceProvider, createVoiceEngine, insertAtCaret, invalidateDictation, levelFromRms, micErrorReason, pickRecorderMime, smoothLevel, subscribeDictationInvalidation, type VoiceEngineDependencies, type VoiceError, type VoiceText, type VoiceInputOptions } from "./voice.ts";
import { DEFAULT_DICTATION_CONFIG, DICTATION_MAX_BYTES } from "./voiceTransport.ts";
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class Stream {
  stopped = false;
  track = { onended: null as (() => void) | null, stop: () => { this.stopped = true; } };
  getTracks() { return [this.track]; }
}
class Recorder {
  state = "inactive"; mimeType = "audio/mp4";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onstart: (() => void) | null = null;
  delayed = false;
  delayedStart = false;
  start() { this.state = "recording"; if (!this.delayedStart) this.onstart?.(); }
  stop() { this.state = "inactive"; if (!this.delayed) this.flush(); }
  flush() { this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
}
function harness(lock?: VoiceEngineDependencies["lock"]) {
  const permissions: Array<(stream: MediaStream) => void> = [];
  const uploads: Array<{ resolve(text: string): void; signal: AbortSignal; config: unknown; blob: Blob }> = [];
  const timers = new Map<number, { callback(): void; ms: number }>();
  let timerId = 0, now = 0;
  const recorder = new Recorder();
  const texts: VoiceText[] = [], errors: Array<VoiceError | null> = [], states: string[] = [];
  const config = { ...DEFAULT_DICTATION_CONFIG, activated: true };
  const previews: string[] = [];
  const deps: VoiceEngineDependencies = {
    permission: () => new Promise((resolve) => permissions.push(resolve)),
    recorder: () => recorder as unknown as MediaRecorder,
    mime: () => ({ mimeType: "audio/mp4", extension: "m4a" }),
    transcribe: (config, blob, signal) => new Promise((resolve) => uploads.push({ resolve, signal, config, blob })),
    now: () => now, lock,
    timer: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (id) => { timers.delete(id as unknown as number); },
  };
  const options: VoiceInputOptions = { enabled: true, config, onText: (text) => texts.push(text) };
  const voice = createVoiceEngine({ options: () => options, available: () => true, setState: (state) => states.push(state), setError: (error) => errors.push(error), setElapsed: () => {}, setSilent: () => {}, setPreview: (text) => previews.push(text) }, deps);
  const grant = async () => { const stream = new Stream(); permissions.at(-1)!(stream as unknown as MediaStream); await drain(); return stream; };
  return { voice, grant, recorder, permissions, uploads, texts, errors, states, timers, config, previews, options, deps, advance: (ms: number) => { now += ms; } };
}
afterEach(invalidateDictation);
describe("upstream hold and tap behaviour", () => {
  it("keeps a quick tap recording and finishes on the next press", async () => {
    const a = harness(); a.voice.press(); await a.grant();
    a.advance(HOLD_MS - 1); a.voice.release();
    expect(a.states.at(-1)).toBe("recording"); expect(a.uploads).toHaveLength(0);
    a.voice.press(); a.voice.release(); await drain();
    expect(a.uploads).toHaveLength(1); expect(a.states.at(-1)).toBe("transcribing");
  });
  it("a held release stops tracks and uploads exactly once", async () => {
    const a = harness(); a.voice.press(); const stream = await a.grant();
    a.advance(HOLD_MS); a.voice.release(); a.voice.release(); await drain();
    expect(stream.stopped).toBe(true); expect(a.uploads).toHaveLength(1);
  });
  it("a held release before permission cannot record or upload late audio", async () => {
    const a = harness(); a.voice.press(); a.advance(HOLD_MS); a.voice.release();
    expect(a.states.at(-1)).toBe("idle"); expect((await a.grant()).stopped).toBe(true);
    expect(a.recorder.state).toBe("inactive"); expect(a.uploads).toHaveLength(0);
  });
  it("explicit Finish is independent of press duration and Cancel discards", async () => {
    const a = harness(); a.voice.press(); await a.grant(); a.voice.finish(); await drain();
    expect(a.uploads).toHaveLength(1); a.voice.cancel(); a.uploads[0]!.resolve("discarded"); await drain();
    expect(a.texts).toEqual([]); expect(classifyRelease(299)).toBe("keep"); expect(classifyRelease(300)).toBe("finish");
  });
});
describe("automatic provider selection", () => {
  it("preserves browser recognition without an OpenAI key", () => {
    expect(resolveVoiceProvider("auto", false, true, true)).toBe("browser");
    expect(resolveVoiceProvider("auto", true, true, true)).toBe("openai");
    expect(resolveVoiceProvider("auto", true, false, true)).toBe("browser");
    expect(resolveVoiceProvider("auto", false, true, false)).toBe("openai");
  });
  it("never substitutes an explicitly selected provider", () => {
    for (const provider of ["openai", "speaches", "browser"] as const) {
      for (const configured of [false, true]) expect(resolveVoiceProvider(provider, configured, false, true)).toBe(provider);
    }
  });
  it("does not start unresolved Automatic selection", () => {
    const a = harness(); a.options.provider = "auto"; a.voice.press();
    expect(a.permissions).toHaveLength(0); expect(a.uploads).toHaveLength(0); expect(a.errors.at(-1)).toBe("not_configured");
  });
});
describe("dictation coordinator", () => {
  it("reserves before permission and disposes a late permission without recording", async () => {
    const a = harness(), b = harness(); a.voice.press(); b.voice.press();
    expect(b.errors.at(-1)).toBe("busy"); expect(b.permissions).toHaveLength(0);
    a.voice.cancel(); expect((await a.grant()).stopped).toBe(true);
    expect(a.recorder.state).toBe("inactive"); expect(a.uploads).toHaveLength(0);
  });
  it("stops tracks at finish, keeps ownership through upload and snapshots configuration", async () => {
    const a = harness(), b = harness(); a.voice.press(); const stream = await a.grant();
    a.config.model = "changed"; a.voice.finish(); await drain();
    expect(stream.stopped).toBe(true); expect(a.uploads[0]!.blob.type).toBe("audio/mp4");
    expect(a.uploads[0]!.config).toEqual({ ...DEFAULT_DICTATION_CONFIG, activated: true });
    b.voice.press(); expect(b.errors.at(-1)).toBe("busy");
    a.uploads[0]!.resolve("hello"); await drain();
    expect(a.texts[0]).toMatchObject({ text: "hello", phase: "raw" }); expect(a.timers.size).toBe(0);
  });
  it("starts as soon as permission resolves and uploads the first audio chunk", async () => {
    const a = harness(); a.voice.press();
    expect(a.states.at(-1)).toBe("starting");
    await a.grant();
    expect(a.recorder.state).toBe("recording");
    expect(a.states.at(-1)).toBe("recording");
    a.recorder.ondataavailable?.({ data: new Blob(["first words"]) });
    a.voice.finish(); await drain();
    expect(await a.uploads[0]!.blob.text()).toBe("first wordsaudio");
  });
  it("waits for recorder readiness before announcing recording or starting its timer", async () => {
    const a = harness(); a.recorder.delayedStart = true;
    a.voice.press(); await a.grant();
    expect(a.states.at(-1)).toBe("starting");
    expect([...a.timers.values()].some((timer) => timer.ms === 250 || timer.ms === 120_000)).toBe(false);
    a.recorder.onstart?.();
    expect(a.states.at(-1)).toBe("recording");
    expect([...a.timers.values()].some((timer) => timer.ms === 120_000)).toBe(true);
  });
  it("cancels a starting recorder without letting a late start announce recording", async () => {
    const a = harness(); a.recorder.delayedStart = true;
    a.voice.press(); const stream = await a.grant();
    const lateStart = a.recorder.onstart;
    a.voice.cancel(); lateStart?.();
    expect(stream.stopped).toBe(true); expect(a.states.at(-1)).toBe("idle");
    expect(a.states).not.toContain("recording"); expect(a.uploads).toHaveLength(0);
  });
  it("bounds recorder startup after microphone permission was granted", async () => {
    const a = harness(); a.recorder.delayedStart = true;
    a.voice.press(); const stream = await a.grant();
    [...a.timers.values()].find((timer) => timer.ms === 30_000)!.callback();
    expect(a.errors.at(-1)).toBe("timeout"); expect(stream.stopped).toBe(true);
    expect(a.states).not.toContain("recording");
  });
  it("global invalidation aborts uploads and notifies synchronously; late results stay discarded", async () => {
    const a = harness(); a.voice.press(); await a.grant(); a.voice.finish(); await drain();
    let notified = false; const unsubscribe = subscribeDictationInvalidation(() => { notified = true; });
    invalidateDictation(); expect(notified).toBe(true); expect(a.uploads[0]!.signal.aborted).toBe(true);
    a.uploads[0]!.resolve("stale"); await drain(); expect(a.texts).toEqual([]); unsubscribe();
  });
  it("hidden cancels rather than uploading and stale recorder callbacks cannot report errors", async () => {
    const a = harness(); a.voice.press(); const stream = await a.grant();
    const lateError = a.recorder.onerror; a.voice.onHidden(); lateError?.();
    expect(stream.stopped).toBe(true); expect(a.errors.at(-1)).toBeNull(); expect(a.uploads).toHaveLength(0);
  });
  it("cancellation before delayed stop releases audio and never uploads", async () => {
    const a = harness(); a.recorder.delayed = true; a.voice.press(); const stream = await a.grant();
    a.voice.finish(); expect(stream.stopped).toBe(true); a.voice.cancel(); a.recorder.flush(); await drain();
    expect(a.uploads).toHaveLength(0); expect(a.timers.size).toBe(0);
  });
  it("enforces incremental byte limits before making a blob or uploading", async () => {
    const a = harness(); a.voice.press(); const stream = await a.grant();
    a.recorder.ondataavailable?.({ data: new Blob([new Uint8Array(DICTATION_MAX_BYTES)]) });
    a.recorder.ondataavailable?.({ data: new Blob(["x"]) });
    expect(a.errors.at(-1)).toBe("too_large"); expect(stream.stopped).toBe(true); expect(a.uploads).toHaveLength(0);
  });
  it("permission timeout and late cross-tab lock acquisition never start a cancelled take", async () => {
    let callback: ((acquired: boolean) => Promise<void>) | undefined;
    const a = harness(async (cb) => { callback = cb; }); a.voice.press();
    a.timers.values().next().value!.callback(); expect(a.errors.at(-1)).toBe("timeout");
    await callback!(true); expect(a.permissions).toHaveLength(0);
  });
  it("denied Web Lock reports busy without requesting permission", async () => {
    const a = harness(async (callback) => callback(false)); a.voice.press(); await drain();
    expect(a.errors.at(-1)).toBe("busy"); expect(a.permissions).toHaveLength(0);
  });
  it("120 second capture limit finishes once and removes permission timeout", async () => {
    const a = harness(); a.voice.press(); await a.grant();
    expect([...a.timers.values()].some((timer) => timer.ms === 30_000)).toBe(false);
    [...a.timers.values()].find((timer) => timer.ms === 120_000)!.callback(); await drain();
    expect(a.uploads).toHaveLength(1); a.voice.release(); expect(a.uploads).toHaveLength(1);
  });
  it("closes only its own stream when a cancelled microphone request answers after a newer one", async () => {
    const a = harness(); a.voice.press(); a.voice.cancel(); a.voice.press();
    expect(a.permissions).toHaveLength(2);
    const current = await a.grant();
    const stale = new Stream(); a.permissions[0]!(stale as unknown as MediaStream); await drain();
    expect(stale.stopped).toBe(true); expect(current.stopped).toBe(false);
    expect(a.recorder.state).toBe("recording");
  });
  it("starts no new take while its earlier one is still being transcribed", async () => {
    const a = harness(); a.voice.press(); await a.grant(); a.voice.finish(); await drain();
    a.voice.press(); expect(a.states.at(-1)).toBe("transcribing");
    expect(a.permissions).toHaveLength(1); expect(a.uploads).toHaveLength(1);
    a.uploads[0]!.resolve("create the file"); await drain();
    expect(a.texts.map((result) => result.text)).toEqual(["create the file"]);
    a.voice.press(); expect(a.permissions).toHaveLength(2);
  });
});
describe("explicit providers", () => {
  it("lifecycle cancellation clears an old provider failure even after the take was disposed", async () => {
    const a = harness(); a.options.provider = "openai";
    a.deps.openai = async () => { throw new Error("failed"); };
    a.voice.press(); await a.grant(); a.voice.finish(); await drain();
    expect(a.errors.at(-1)).toBe("network");
    a.options.provider = "browser"; a.voice.cancel();
    expect(a.errors.at(-1)).toBeNull(); expect(a.states.at(-1)).toBe("idle");
    a.voice.cancel(); expect(a.errors.at(-1)).toBeNull();
  });
  it("snapshots OpenAI settings at press and never uploads to Speaches", async () => {
    const a = harness();
    a.options.provider = "openai";
    a.options.language = "ko-KR"; a.options.polish = true; a.options.mode = "terminal"; a.options.keywords = ["git"];
    let captured: unknown;
    a.deps.openai = async (options) => { captured = { language: options.language, polish: options.polish, mode: options.mode, keywords: options.keywords }; return "git status"; };
    a.voice.press(); await a.grant();
    a.options.provider = "speaches"; a.options.language = "ja"; a.options.polish = false; a.options.mode = "chat"; a.options.keywords.push("changed");
    a.voice.finish(); await drain();
    expect(captured).toEqual({ language: "ko-KR", polish: true, mode: "terminal", keywords: ["git"] });
    expect(a.uploads).toHaveLength(0); expect(a.texts.map((text) => text.text)).toEqual(["git status"]);
  });
  it("OpenAI failure has no fallback; cancellation suppresses late results", async () => {
    const a = harness(); a.options.provider = "openai";
    a.deps.openai = async () => { throw new Error("failed"); };
    a.voice.press(); await a.grant(); a.voice.finish(); await drain();
    expect(a.uploads).toHaveLength(0); expect(a.texts).toHaveLength(0);
    let resolve!: (text: string) => void;
    a.deps.openai = () => new Promise((done) => { resolve = done; });
    a.voice.press(); await a.grant(); a.voice.finish(); await drain(); a.voice.cancel(); resolve("late"); await drain();
    expect(a.texts).toHaveLength(0);
  });
  it("browser keeps ownership through stop, uses its language snapshot, and suppresses late callbacks", async () => {
    const a = harness(), b = harness(); a.options.provider = "browser"; a.options.language = "fr-FR";
    const speech = { lang: "", continuous: false, interimResults: false, onaudiostart: null, onresult: null, onerror: null, onend: null, start() {}, stop() {}, abort() {} } as import("./voiceProviders.ts").SpeechRecognitionLike;
    a.deps.speech = () => speech;
    a.voice.press(); expect(speech.lang).toBe("fr-FR"); expect(a.permissions).toHaveLength(0);
    speech.onaudiostart?.();
    speech.onresult?.({ results: { length: 1, 0: { isFinal: true, 0: { transcript: "bonjour" } } } });
    a.voice.finish(); b.voice.press(); expect(b.errors.at(-1)).toBe("busy");
    const lateResult = speech.onresult, lateEnd = speech.onend, lateError = speech.onerror;
    a.voice.cancel(); lateResult?.({ results: { length: 0 } }); lateEnd?.(); lateError?.({ error: "network" });
    expect(a.texts).toHaveLength(0); expect(a.errors.at(-1)).toBeNull(); expect(a.uploads).toHaveLength(0); expect(a.timers.size).toBe(0);
    a.voice.press(); speech.onaudiostart?.();
    speech.onresult?.({ results: { length: 3, 0: { isFinal: true, 0: { transcript: "bonjour" } }, 1: { isFinal: true, 0: { transcript: "le monde" } }, 2: { isFinal: false, 0: { transcript: "interim" } } } });
    expect(a.previews.at(-1)).toBe("bonjour le monde interim");
    speech.onend?.();
    expect(a.texts.map((text) => text.text)).toEqual(["bonjour le monde"]);
  });
});
describe("caret, format and meter helpers", () => {
  it("preserves surrounding text and ignores empty speech", () => {
    expect(insertAtCaret("open old file", 5, 8, "new")).toEqual({ value: "open new file", start: 5, end: 8 });
    expect(insertAtCaret("abc", 1, 2, " ").value).toBe("abc");
    expect(insertAtCaret("run", 3, 3, "tests").value).toBe("run tests");
  });
  it("selects Safari mp4 without pretending an unsupported format works", () => {
    expect(pickRecorderMime((mime) => mime === "audio/mp4")?.extension).toBe("m4a");
    expect(pickRecorderMime(() => false)).toBeNull();
  });
  it("reuses the upstream seven-bar level envelope", () => {
    for (const level of [0, 0.1, 1, 20, -1, NaN]) for (const time of [0, 137, 900, 4321]) {
      const bars = barScales(level, time);
      expect(bars).toHaveLength(7);
      for (const value of bars) { expect(value).toBeGreaterThanOrEqual(0.12); expect(value).toBeLessThanOrEqual(1); }
      expect(bars[3]!).toBeGreaterThanOrEqual(bars[0]!);
      expect(bars[3]!).toBeGreaterThanOrEqual(bars[6]!);
    }
    expect(barScales(0.8, 500)[3]!).toBeGreaterThan(barScales(0.1, 500)[3]!);
  });
  it("uses faster attack than decay", () => {
    expect(levelFromRms(0)).toBe(0); expect(levelFromRms(1)).toBe(1);
    expect(smoothLevel(0, 1, 30)).toBeGreaterThan(1 - smoothLevel(1, 0, 30));
  });
  it("maps microphone permission and missing-device errors", () => {
    expect(micErrorReason("NotAllowedError")).toBe("permission");
    expect(micErrorReason("SecurityError")).toBe("permission");
    expect(micErrorReason("NotFoundError")).toBe("no_mic");
  });
});

describe("insertAtCaret", () => {
  it("inserts into an empty box without a space", () => {
    expect(insertAtCaret("", 0, 0, "hello")).toEqual({ value: "hello", start: 0, end: 5 });
  });
  it("separates from a preceding word", () => {
    expect(insertAtCaret("run", 3, 3, "the tests")).toEqual({ value: "run the tests", start: 4, end: 13 });
  });
  it("adds nothing after a space or a newline", () => {
    expect(insertAtCaret("run ", 4, 4, "tests")).toEqual({ value: "run tests", start: 4, end: 9 });
    expect(insertAtCaret("line\n", 5, 5, "next")).toEqual({ value: "line\nnext", start: 5, end: 9 });
  });
  it("replaces a selection mid-text", () => {
    expect(insertAtCaret("open old file", 5, 8, "src/app.ts")).toEqual({ value: "open src/app.ts file", start: 5, end: 15 });
    expect(insertAtCaret("abcdef", 2, 4, "X")).toEqual({ value: "ab X ef", start: 3, end: 4 });
  });
  it("trims the dictation and leaves the box alone when it is empty", () => {
    expect(insertAtCaret("a", 1, 1, "  b  ")).toEqual({ value: "a b", start: 2, end: 3 });
    expect(insertAtCaret("abc", 1, 2, "   ")).toEqual({ value: "abc", start: 1, end: 2 });
  });
});
describe("smoothLevel", () => {
  it("attacks faster than it releases", () => {
    const rise = smoothLevel(0, 1, 30);
    const fall = 1 - smoothLevel(1, 0, 30);
    expect(rise).toBeGreaterThan(fall);
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(1);
  });
  it("holds still with no time passed and converges over time", () => {
    expect(smoothLevel(0.4, 1, 0)).toBe(0.4);
    expect(smoothLevel(0, 1, 1000)).toBeCloseTo(1, 3);
    expect(smoothLevel(1, 0, 5000)).toBeCloseTo(0, 3);
  });
});
describe("levelFromRms", () => {
  it("maps silence to 0, speech into the range, loud to 1", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(Number.NaN)).toBe(0);
    expect(levelFromRms(0.01)).toBeCloseTo(0.4, 5);
    expect(levelFromRms(1)).toBe(1);
  });
});
