/** Stateful area-average downsampler. Fractional phase and accumulator survive render blocks. */
export class DictationResampler {
  private remaining: number;
  private sum = 0;
  private weight = 0;
  readonly ratio: number;
  constructor(inputRate: number) {
    if (!Number.isFinite(inputRate) || inputRate < 16000) throw new Error("sample rate");
    this.ratio = inputRate / 16000; this.remaining = this.ratio;
  }
  push(input: Float32Array): Int16Array {
    const output: number[] = [];
    for (const value of input) {
      let available = 1;
      while (available > 1e-9) {
        const used = Math.min(available, this.remaining);
        this.sum += (Number.isFinite(value) ? value : 0) * used;
        this.weight += used; this.remaining -= used; available -= used;
        if (this.remaining < 1e-9) {
          output.push(this.quantize(this.sum / this.weight));
          this.sum = this.weight = 0; this.remaining = this.ratio;
        }
      }
    }
    return Int16Array.from(output);
  }
  flush(): Int16Array {
    const result = this.weight ? Int16Array.of(this.quantize(this.sum / this.weight)) : new Int16Array();
    this.sum = this.weight = 0; this.remaining = this.ratio;
    return result;
  }
  private quantize(value: number): number { return Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)); }
}
export function pcmFrame(sequence: number, offset: number, samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + samples.length * 2), view = new DataView(buffer);
  view.setUint32(0, sequence, true); view.setUint32(4, offset, true);
  samples.forEach((sample, index) => view.setInt16(8 + index * 2, sample, true));
  return buffer;
}
