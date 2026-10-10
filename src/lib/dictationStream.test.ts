import { expect, it } from "bun:test";
import { DictationPreview, prepareLiveDictation } from "./dictationStream.ts";
import { DEFAULT_DICTATION_CONFIG } from "./voiceTransport.ts";
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  const sent: Array<string | ArrayBuffer> = [], partial: string[] = [], commands: unknown[] = [], failures: unknown[] = [];
  let closes = 0, resumed = 0, connected = 0;
  const socket = { bufferedAmount: 0, onopen: null as null | (() => void), onmessage: null as null | ((event: { data: string }) => void), onerror: null, onclose: null as null | (() => void), send: (value: string | ArrayBuffer) => sent.push(value), close: () => { closes++; } };
  const port = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: (value: unknown) => commands.push(value), close() {} };
  const context = { resume: async () => { resumed++; }, close: async () => { closes++; }, destination: {}, createMediaStreamSource: () => ({ connect: () => { connected++; }, disconnect() {} }) };
  const node = { port, connect() {}, disconnect() {} };
  const live = prepareLiveDictation({ context: () => context as unknown as AudioContext, load: async () => {}, node: () => node as unknown as AudioWorkletNode, socket: () => socket as unknown as WebSocket, policy: async () => ({ version: 2, enabled: true, generation: "g", default_model: "m", modes: ["live"], max_seconds: 120, max_bytes: 10485760 }) });
  const controller = new AbortController();
  const message = (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) });
  const start = () => live.start({ ...DEFAULT_DICTATION_CONFIG, mode: "live", activated: true }, {} as MediaStream, controller.signal, (text) => partial.push(text), (error) => failures.push(error));
  const open = async () => {
    let started = false;
    const starting = start().then(() => { started = true; });
    await tick(); socket.onopen!(); message({ type: "ready", sample_rate: 16000, max_seconds: 120, max_bytes: 10485760 });
    await tick(); expect(started).toBe(false);
    port.onmessage!({ data: { type: "audio", data: new Int16Array(3200) } });
    await starting;
  };
  return { live, socket, port, sent, partial, commands, failures, controller, message, start, open, stats: () => ({ closes, resumed, connected }) };
}
it("assembles ordered finals and replaceable revisioned previews", () => {
  const text = new DictationPreview();
  expect(text.accept({ type: "preview", segment_id: 1, revision: 2, text: "world" })).toBe("world");
  expect(text.accept({ type: "segment_final", segment_id: 0, text: "hello" })).toBe("hello world");
  expect(text.accept({ type: "preview", segment_id: 1, revision: 1, text: "stale" })).toBe("hello world");
  expect(text.accept({ type: "segment_final", segment_id: 1, text: "earth" })).toBe("hello earth");
  expect(text.accept({ type: "preview", segment_id: 1, revision: 9, text: "stale" })).toBe("hello earth");
});
it("prepares in gesture, waits ready, and finishes only after counted short-frame drain", async () => {
  const h = harness(); expect(h.stats().resumed).toBe(1); expect(h.stats().connected).toBe(0);
  await h.open(); expect(h.stats().connected).toBe(1);
  expect(JSON.parse(h.sent[0] as string)).toEqual({ type: "start", version: 2, model: DEFAULT_DICTATION_CONFIG.model, generation: "g" });
  h.message({ type: "ack", frames: 1, samples: 3200 });
  const result = h.live.finish(); expect(h.commands.at(-1)).toEqual({ type: "drain" });
  expect(h.sent).toHaveLength(2);
  h.port.onmessage!({ data: { type: "audio", data: new Int16Array(17) } });
  h.port.onmessage!({ data: { type: "drained", samples: 3217 } });
  expect(JSON.parse(h.sent.at(-1) as string)).toEqual({ type: "finish", frames: 2, samples: 3217 });
  h.message({ type: "finished", text: "final only" }); expect(await result).toBe("final only"); expect(h.stats().closes).toBeGreaterThan(0);
});
it("cancels congestion instead of retaining audio or retrying", async () => {
  const h = harness(); await h.open();
  for (let i = 0; i < 10; i++) h.port.onmessage?.({ data: { type: "audio", data: new Int16Array(3200) } });
  expect(h.sent).toHaveLength(11); expect(h.failures[0]).toMatchObject({ code: "too_large" });
  await expect(h.live.finish()).rejects.toMatchObject({ code: "too_large" });
});
it("abort discards late results, drain mismatch fails, and close is never a final result", async () => {
  const a = harness(); await a.open(); const late = a.socket.onmessage!; const result = a.live.finish(); a.controller.abort();
  late({ data: JSON.stringify({ type: "finished", text: "stale" }) }); await expect(result).rejects.toThrow(); expect(a.partial).toEqual([]);
  const b = harness(); await b.open(); const bad = b.live.finish(); b.port.onmessage!({ data: { type: "drained", samples: 1 } }); await expect(bad).rejects.toMatchObject({ code: "format" });
  const c = harness(); await c.open(); c.socket.onclose!(); await expect(c.live.finish()).rejects.toMatchObject({ code: "network" });
});
