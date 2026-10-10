import { expect, it } from "bun:test";
import { DictationResampler, pcmFrame } from "./dictationPcm.ts";
it("resamples 44.1/48k continuously, independently of render block boundaries", () => {
  for (const rate of [44100, 48000]) {
    const input = Float32Array.from({ length: rate + 17 }, (_, i) => Math.sin(i / 20));
    const whole = new DictationResampler(rate), chunked = new DictationResampler(rate);
    const expected = [...whole.push(input), ...whole.flush()];
    const actual: number[] = [];
    for (let offset = 0; offset < input.length; offset += 128) actual.push(...chunked.push(input.subarray(offset, offset + 128)));
    actual.push(...chunked.flush());
    expect(actual).toEqual(expected); expect(actual.length).toBe(Math.ceil(input.length * 16000 / rate));
    expect(chunked.flush().length).toBe(0);
  }
});
it("clamps PCM and writes an exact little endian frame including short tails", () => {
  const pcm = new DictationResampler(16000).push(Float32Array.of(-2, 2, 0));
  const frame = pcmFrame(7, 22400, pcm), view = new DataView(frame);
  expect(frame.byteLength).toBe(14); expect(view.getUint32(0, true)).toBe(7); expect(view.getUint32(4, true)).toBe(22400);
  expect(view.getInt16(8, true)).toBe(-32768); expect(view.getInt16(10, true)).toBe(32767); expect(view.getInt16(12, true)).toBe(0);
});
