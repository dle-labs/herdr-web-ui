import { afterAll, beforeAll, expect, it } from "bun:test";
interface Processor {
  port: { onmessage: (event: { data: unknown }) => void; messages: Array<{ type: string; data?: Int16Array; samples?: number }> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
let ProcessorClass: new () => Processor;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeAll(async () => {
  for (const name of ["AudioWorkletProcessor", "sampleRate", "registerProcessor"]) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.assign(globalThis, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { onmessage: null, messages: [] as unknown[], postMessage(value: unknown) { this.messages.push(value); } };
    },
    registerProcessor: (_name: string, processor: new () => Processor) => { ProcessorClass = processor; },
  });
  await import("./dictationWorklet.ts");
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});
it("mutes every output and drains the exact final non-frame-aligned sample count", () => {
  const processor = new ProcessorClass(), output = new Float32Array(128).fill(1);
  for (let i = 0; i < 100; i++) processor.process([[new Float32Array(128).fill(0.5)]], [[output]]);
  expect(output.every((value) => value === 0)).toBe(true);
  processor.port.onmessage({ data: { type: "drain" } });
  const audio = processor.port.messages.filter((message) => message.type === "audio");
  expect(audio.map((message) => message.data!.length)).toEqual([3200, 1067]);
  expect(processor.port.messages.at(-1)).toEqual({ type: "drained", samples: 4267 });
  const count = processor.port.messages.length;
  processor.process([[new Float32Array(128)]], [[output]]);
  processor.port.onmessage({ data: { type: "drain" } }); expect(processor.port.messages).toHaveLength(count);
});
it("credits bound MessagePort output and stalled ingestion fails without unbounded buffering", () => {
  const processor = new ProcessorClass();
  for (let i = 0; i < 800; i++) processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
  expect(processor.port.messages.filter((message) => message.type === "audio")).toHaveLength(8);
  expect(processor.port.messages.filter((message) => message.type === "overflow")).toHaveLength(1);
});
it("caps production at exactly 120 seconds and still drains normally", () => {
  const processor = new ProcessorClass();
  const input = new Float32Array(9601).fill(0.2), output = new Float32Array(128);
  for (let i = 0; i < 610; i++) {
    processor.process([[input]], [[output]]);
    processor.port.onmessage({ data: { type: "credit" } });
  }
  const audio = processor.port.messages.filter((message) => message.type === "audio");
  expect(audio).toHaveLength(600);
  expect(audio.reduce((sum, message) => sum + message.data!.length, 0)).toBe(120 * 16000);
  expect(processor.port.messages.filter((message) => message.type === "limit")).toHaveLength(1);
  expect(processor.port.messages.some((message) => message.type === "overflow")).toBe(false);
  processor.port.onmessage({ data: { type: "drain" } });
  expect(processor.port.messages.at(-1)).toEqual({ type: "drained", samples: 120 * 16000 });
});
it("returned credit permits bounded continued capture", () => {
  const processor = new ProcessorClass();
  for (let i = 0; i < 750; i++) {
    const before = processor.port.messages.length;
    processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
    if (processor.port.messages.length > before) processor.port.onmessage({ data: { type: "credit" } });
  }
  expect(processor.port.messages.filter((message) => message.type === "audio")).toHaveLength(10);
  expect(processor.port.messages.some((message) => message.type === "overflow")).toBe(false);
});
