import { afterEach, describe, expect, it } from "bun:test";
import { barScales, createVoiceEngine, insertAtCaret, invalidateDictation, levelFromRms, pickRecorderMime, smoothLevel, subscribeDictationInvalidation, type VoiceEngineDependencies, type VoiceError, type VoiceText } from "./voice.ts";
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
  delayed = false;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; if (!this.delayed) this.flush(); }
  flush() { this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
}
function harness(lock?: VoiceEngineDependencies["lock"]) {
  const permissions: Array<(stream: MediaStream) => void> = [];
  const uploads: Array<{ resolve(text: string): void; signal: AbortSignal; config: unknown; blob: Blob }> = [];
  const timers = new Map<number, { callback(): void; ms: number }>();
  let timerId = 0;
  const recorder = new Recorder();
  const texts: VoiceText[] = [], errors: Array<VoiceError | null> = [], states: string[] = [];
  const config = { ...DEFAULT_DICTATION_CONFIG, activated: true };
  const deps: VoiceEngineDependencies = {
    permission: () => new Promise((resolve) => permissions.push(resolve)),
    recorder: () => recorder as unknown as MediaRecorder,
    mime: () => ({ mimeType: "audio/mp4", extension: "m4a" }),
    transcribe: (config, blob, signal) => new Promise((resolve) => uploads.push({ resolve, signal, config, blob })),
    now: () => 0, lock,
    timer: (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (id) => { timers.delete(id as unknown as number); },
  };
  const voice = createVoiceEngine({ options: () => ({ enabled: true, config, onText: (text) => texts.push(text) }), available: () => true, setState: (state) => states.push(state), setError: (error) => errors.push(error), setElapsed: () => {}, setSilent: () => {} }, deps);
  const grant = async () => { const stream = new Stream(); permissions.at(-1)!(stream as unknown as MediaStream); await drain(); return stream; };
  return { voice, grant, recorder, permissions, uploads, texts, errors, states, timers, config };
}
afterEach(invalidateDictation);
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
  it("bounds bars and uses faster attack than decay", () => {
    expect(levelFromRms(0)).toBe(0); expect(levelFromRms(1)).toBe(1);
    expect(smoothLevel(0, 1, 30)).toBeGreaterThan(1 - smoothLevel(1, 0, 30));
    for (const value of barScales(20, 123)) { expect(value).toBeGreaterThanOrEqual(0.12); expect(value).toBeLessThanOrEqual(1); }
  });
});
