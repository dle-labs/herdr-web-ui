import { DICTATION_FINISH_MS, DICTATION_FRAME_SAMPLES, DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_SAMPLE_RATE, type DictationServerMessage } from "../../shared/dictation.ts";
import { DictationError, safeDictationError } from "../dictation.ts";
import { DictationSegmenter, type AudioSegment } from "./segments.ts";
import { pcmWav } from "./speaches-http.ts";

export interface DictationCoordinatorOptions {
  /** Exactly one request at a time. No herdr/server required; suitable for paced replay. */
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  emit: (event: DictationServerMessage) => void;
  finishMs?: number;
}
export class DictationCoordinator {
  frames = 0;
  samples = 0;
  private state: "recording" | "finishing" | "done" = "recording";
  private segmenter = new DictationSegmenter();
  private nextId = 0;
  private revision = 0;
  private lastPreview = 0;
  private finals: { id: number; audio: AudioSegment }[] = [];
  private texts: string[] = [];
  private textBytes = 0;
  private active = false;
  private abort = new AbortController();
  private deadline?: ReturnType<typeof setTimeout>;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
  constructor(private options: DictationCoordinatorOptions) {}
  get terminal(): boolean { return this.state === "done"; }
  get pendingFinals(): number { return this.finals.length; }

  pushPCM(pcm: Int16Array): void {
    if (this.state !== "recording") { if (!this.terminal) this.fail(new DictationError("format", "Audio arrived after Finish")); return; }
    if (!pcm.length || pcm.length > DICTATION_FRAME_SAMPLES) { this.fail(new DictationError("format", "Invalid audio frame size")); return; }
    if ((this.samples + pcm.length) > DICTATION_SAMPLE_RATE * DICTATION_MAX_SECONDS || (this.samples + pcm.length) * 2 > DICTATION_MAX_BYTES) { this.fail(new DictationError("too_large", "Recording limit exceeded")); return; }
    this.frames++; this.samples += pcm.length;
    for (const audio of this.segmenter.pushPCM(pcm)) {
      this.finals.push({ id: this.nextId++, audio }); this.revision = 0;
      this.pump();
      if (this.finals.length > 2) { this.fail(new DictationError("busy", "Speech service cannot keep up; use recording mode")); return; }
    }
    this.options.emit({ type: "ack", frames: this.frames, samples: this.samples });
    this.pump();
  }
  finish(frames = this.frames, samples = this.samples): Promise<void> {
    if (this.state !== "recording") return this.done;
    if (frames !== this.frames || samples !== this.samples) { this.fail(new DictationError("format", "Finish does not match received audio")); return this.done; }
    this.state = "finishing";
    // One absolute deadline includes an already-running preview and every queued final.
    this.deadline = setTimeout(() => this.fail(new DictationError("timeout", "Dictation Finish timed out")), this.options.finishMs ?? DICTATION_FINISH_MS);
    const audio = this.segmenter.finish();
    if (audio) this.finals.push({ id: this.nextId++, audio });
    this.pump();
    if (this.finals.length > 2) this.fail(new DictationError("busy", "Speech service cannot keep up; use recording mode"));
    return this.done;
  }
  cancel(): void {
    if (this.terminal) return;
    this.cleanup();
    this.options.emit({ type: "cancelled" });
  }
  fail(error: unknown): void {
    if (this.terminal) return;
    const safe = safeDictationError(error);
    this.cleanup();
    this.options.emit({ type: "error", error: { code: safe.code, message: safe.message } });
  }
  private cleanup(): void {
    this.state = "done"; clearTimeout(this.deadline); this.abort.abort(); this.segmenter.clear(); this.finals = []; this.texts = []; this.textBytes = 0; this.resolveDone();
  }
  private pump(): void {
    if (this.active || this.terminal) return;
    const final = this.finals.shift();
    if (final) { void this.run(final.audio, final.id, true); return; }
    if (this.state === "finishing") {
      const text = this.texts.filter(Boolean).join(" ");
      if (!text) { this.fail(new DictationError("no_speech", "No speech was recognized")); return; }
      this.cleanup(); this.options.emit({ type: "finished", text }); return;
    }
    // Opportunities coalesce: never snapshot or queue previews while a request runs.
    if (this.samples - this.lastPreview < DICTATION_SAMPLE_RATE * 2) return;
    const current = this.segmenter.snapshot();
    if (!current) return;
    this.lastPreview = this.samples;
    void this.run(current, this.nextId, false);
  }
  private async run(audio: AudioSegment, id: number, final: boolean): Promise<void> {
    this.active = true;
    try {
      const text = (await this.options.transcribe(pcmWav(audio.pcm), this.abort.signal)).trim();
      if (this.terminal) return;
      if (final) {
        this.textBytes += new TextEncoder().encode(text).length + 1;
        if (this.textBytes > 256 * 1024) { this.fail(new DictationError("too_large", "Speech service returned too much text")); return; }
        this.texts.push(text); this.options.emit({ type: "segment_final", segment_id: id, text });
      }
      else if (this.state === "recording" && id === this.nextId && audio.start === this.segmenter.currentStart) this.options.emit({ type: "preview", segment_id: id, revision: ++this.revision, text });
    } catch (error) {
      if (this.terminal) return;
      const safe = safeDictationError(error);
      if (final || !["network", "timeout"].includes(safe.code)) this.fail(safe);
    } finally {
      this.active = false;
      this.pump();
    }
  }
}
