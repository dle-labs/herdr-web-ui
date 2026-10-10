/** Deterministic 16 kHz energy segmenter. Half-open [start,end) ownership; no overlap or
 * text deduplication. Silence outside the <=200 ms pre-roll is intentionally omitted.
 * RMS is not learned VAD: quiet speech/noise and forced cuts can still lose boundary words.
 * At 12 s choose the quietest 10 ms boundary in the trailing 800 ms (not a phoneme cut).
 */
export interface AudioSegment { start: number; end: number; pcm: Int16Array }
const RATE = 16_000;
const WINDOW = 160;
const PRE_ROLL = RATE / 5;
const SILENCE = RATE / 2;
const MAX = RATE * 12;
export class DictationSegmenter {
  private buffer = new Int16Array(MAX + WINDOW);
  private length = 0;
  private start = 0;
  private position = 0;
  private active = false;
  private quiet = 0;
  private windowEnergy = 0;
  private windowSamples = 0;
  private energies: { end: number; rms: number }[] = [];

  get currentStart(): number { return this.start; }
  snapshot(): AudioSegment | null {
    return this.active && this.length ? { start: this.start, end: this.position, pcm: this.buffer.slice(0, this.length) } : null;
  }
  pushPCM(pcm: Int16Array): AudioSegment[] {
    const complete: AudioSegment[] = [];
    for (const sample of pcm) {
      this.buffer[this.length++] = sample;
      this.position++;
      this.windowEnergy += (sample / 32768) ** 2;
      if (++this.windowSamples < WINDOW) continue;
      const rms = Math.sqrt(this.windowEnergy / WINDOW);
      this.windowEnergy = 0; this.windowSamples = 0;
      this.energies.push({ end: this.position, rms });
      if (rms >= (this.active ? 0.008 : 0.012)) { this.active = true; this.quiet = 0; }
      else if (this.active) this.quiet += WINDOW;
      if (this.active && this.quiet >= SILENCE) {
        complete.push(this.cut(this.length)); this.active = false; this.quiet = 0;
      } else if (this.active && this.length >= MAX) {
        const candidates = this.energies.filter((window) => window.end > this.position - 12800 && window.end <= this.position);
        const low = candidates.reduce((best, item) => item.rms < best.rms ? item : best, candidates[candidates.length - 1]!);
        complete.push(this.cut(low.end - this.start));
      } else if (!this.active && this.length > PRE_ROLL) this.discard(this.length - PRE_ROLL);
      this.energies = this.energies.filter((window) => window.end > Math.max(this.start, this.position - 12800));
    }
    return complete;
  }
  finish(): AudioSegment | null {
    // A very short final frame can contain speech without completing an energy window.
    const speech = this.active || (this.windowSamples > 0 && Math.sqrt(this.windowEnergy / this.windowSamples) >= 0.012);
    const final = speech && this.length ? this.cut(this.length) : null;
    this.clear();
    return final;
  }
  clear(): void { this.buffer.fill(0); this.length = 0; this.active = false; this.quiet = 0; this.energies = []; this.windowEnergy = 0; this.windowSamples = 0; this.start = this.position; }
  private discard(count: number): void { this.buffer.copyWithin(0, count, this.length); this.length -= count; this.start += count; }
  private cut(count: number): AudioSegment {
    const result = { start: this.start, end: this.start + count, pcm: this.buffer.slice(0, count) };
    this.discard(count);
    return result;
  }
}
