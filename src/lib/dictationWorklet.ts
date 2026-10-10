import { DictationResampler } from "./dictationPcm.ts";
import { DICTATION_SAMPLE_RATE, DICTATION_MAX_SECONDS } from "../../shared/dictation.ts";
// AudioWorklet globals are not part of TypeScript's Window library.
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
class DictationProcessor extends AudioWorkletProcessor {
  private resampler = new DictationResampler(sampleRate);
  private frame = new Int16Array(3200);
  private length = 0;
  private credits = 8;
  private samples = 0;
  private stopped = false;
  private failed = false;
  private capped = false;
  private drained = false;
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === "credit") this.credits = Math.min(8, this.credits + 1);
      if (event.data.type === "drain" && !this.drained && !this.failed) {
        this.drained = true;
        this.stopped = true;
        if (!this.capped) this.append(this.resampler.flush());
        if (this.length) this.emit();
        if (!this.failed) this.port.postMessage({ type: "drained", samples: this.samples });
      }
    };
  }
  private emit(): void {
    if (!this.credits) { this.failed = this.stopped = true; this.port.postMessage({ type: "overflow" }); return; }
    this.credits--;
    const data = this.frame.slice(0, this.length); this.samples += data.length; this.length = 0;
    this.port.postMessage({ type: "audio", data }, [data.buffer]);
    // Enforce the cap where samples are produced, not 120 seconds after the
    // first frame reached the main thread. Finish can still drain this exact take.
    if (this.samples === DICTATION_SAMPLE_RATE * DICTATION_MAX_SECONDS) {
      this.capped = this.stopped = true;
      this.port.postMessage({ type: "limit" });
    }
  }
  private append(samples: Int16Array): void {
    for (const sample of samples) {
      this.frame[this.length++] = sample;
      if (this.length === 3200) { this.emit(); if (this.failed || this.capped) return; }
    }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return true;
    const channels = inputs[0];
    if (channels?.length) {
      const mono = new Float32Array(channels[0]!.length);
      for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / channels.length;
      this.append(this.resampler.push(mono));
    }
    return true;
  }
}
registerProcessor("herdr-dictation", DictationProcessor);
