import { describe, expect, it } from "bun:test";
import type { DictationServerMessage } from "../../shared/dictation.ts";
import { DictationError, dictationPolicy } from "../dictation.ts";
import { DictationCoordinator } from "./coordinator.ts";
import { DictationSegmenter } from "./segments.ts";
import { DictationSocket } from "./socket.ts";
import { pcmWav, createDictationTransport } from "./speaches-http.ts";
const frame = (value = 1000, count = 3200) => new Int16Array(count).fill(value);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settled() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function harness(finishMs?: number) {
  const events: DictationServerMessage[] = [];
  const calls: { wav: Blob; signal: AbortSignal; response: ReturnType<typeof deferred<string>> }[] = [];
  const take = new DictationCoordinator({ emit: (event) => events.push(event), finishMs, transcribe: (wav, signal) => {
    const response = deferred<string>(); calls.push({ wav, signal, response }); return response.promise;
  } });
  return { take, events, calls };
}
function utterance(take: DictationCoordinator) { take.pushPCM(frame()); for (let i = 0; i < 3; i++) take.pushPCM(frame(0)); }

describe("PCM segmentation", () => {
  it("omits long idle silence, retains <=200ms pre-roll, closes on 500ms silence", () => {
    const segments = new DictationSegmenter();
    for (let i = 0; i < 10; i++) expect(segments.pushPCM(frame(0))).toEqual([]);
    segments.pushPCM(frame());
    expect(segments.pushPCM(frame(0))).toEqual([]);
    expect(segments.pushPCM(frame(0))).toEqual([]);
    const complete = segments.pushPCM(frame(0));
    expect(complete.length).toBe(1);
    expect(complete[0]!.start).toBeGreaterThanOrEqual(32000 - 3200);
    expect(complete[0]!.end).toBe(32000 + 3200 + 8000);
    expect(segments.finish()).toBeNull();
  });
  it("forced cuts own exact nonoverlapping half-open sample ranges", () => {
    const segments = new DictationSegmenter();
    const completed = [];
    for (let i = 0; i < 130; i++) completed.push(...segments.pushPCM(frame(2000)));
    const final = segments.finish(); if (final) completed.push(final);
    expect(completed.length).toBeGreaterThan(2);
    expect(completed[0]!.start).toBe(0);
    let end = 0;
    for (const segment of completed) {
      expect(segment.start).toBe(end); expect(segment.pcm.length).toBe(segment.end - segment.start);
      expect(segment.pcm.length).toBeLessThanOrEqual(192000); end = segment.end;
    }
    expect(end).toBe(130 * 3200);
  });
  it("chooses low energy in the last 800ms without duplicating its retained tail", () => {
    const segments = new DictationSegmenter();
    for (let i = 0; i < 56; i++) segments.pushPCM(frame(2000));
    segments.pushPCM(frame(500));
    segments.pushPCM(frame(2000)); segments.pushPCM(frame(2000));
    const first = segments.pushPCM(frame(2000))[0]!;
    expect(first.end).toBeGreaterThanOrEqual(56 * 3200); expect(first.end).toBeLessThan(57 * 3200 + 1);
    const last = segments.finish()!; expect(last.start).toBe(first.end); expect(last.end).toBe(60 * 3200);
  });
  it("includes partial final windows and writes correct PCM16 WAV", async () => {
    const segmenter = new DictationSegmenter(); segmenter.pushPCM(frame(1234, 57));
    const pcm = segmenter.finish()!.pcm;
    const view = new DataView(await pcmWav(pcm).arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16000); expect(view.getUint32(40, true)).toBe(114); expect(view.getInt16(44, true)).toBe(1234);
  });
});

describe("single-take coordinator", () => {
  it("previews current text, drops stale running previews, prioritizes ordered finals without text dedupe", async () => {
    const { take, calls, events } = harness();
    for (let i = 0; i < 10; i++) take.pushPCM(frame());
    expect(calls.length).toBe(1);
    calls[0]!.response.resolve("live hypothesis"); await settled();
    expect(events).toContainEqual({ type: "preview", segment_id: 0, revision: 1, text: "live hypothesis" });
    for (let i = 0; i < 10; i++) take.pushPCM(frame());
    expect(calls.length).toBe(2);
    for (let i = 0; i < 3; i++) take.pushPCM(frame(0));
    utterance(take);
    expect(calls.length).toBe(2); expect(take.pendingFinals).toBe(2);
    calls[1]!.response.resolve("stale hypothesis"); await settled();
    expect(events.some((event) => event.type === "preview" && event.text === "stale hypothesis")).toBe(false);
    expect(calls.length).toBe(3);
    const done = take.finish();
    calls[2]!.response.resolve("very very"); await settled();
    expect(calls.length).toBe(4);
    calls[3]!.response.resolve("very good"); await done;
    expect(events.filter((event) => event.type === "segment_final")).toEqual([{ type: "segment_final", segment_id: 0, text: "very very" }, { type: "segment_final", segment_id: 1, text: "very good" }]);
    expect(events.at(-1)).toEqual({ type: "finished", text: "very very very good" });
  });
  it("bounds finals to two waiting plus active; slow inference fails visibly", () => {
    const { take, calls, events } = harness();
    for (let i = 0; i < 4; i++) utterance(take);
    expect(calls.length).toBe(1); expect(take.terminal).toBe(true); expect(take.pendingFinals).toBe(0);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "busy" } });
  });
  it("cancel aborts local work, clears buffers and discards late success idempotently", async () => {
    const { take, calls, events } = harness(); utterance(take);
    take.cancel(); take.cancel(); void take.finish();
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.response.resolve("must not escape"); await settled();
    expect(events.filter((event) => event.type === "cancelled")).toHaveLength(1);
    expect(events.some((event) => event.type === "finished" || event.type === "segment_final")).toBe(false);
  });
  it("uses one Finish deadline even while a preview is already running", async () => {
    const { take, calls, events } = harness(5);
    for (let i = 0; i < 10; i++) take.pushPCM(frame());
    await take.finish();
    expect(calls).toHaveLength(1); expect(calls[0]!.signal.aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "timeout" } });
  });
  it("skips network preview failure but fails systemic previews and every failed final", async () => {
    for (const code of ["network", "provider"] as const) {
      const { take, calls, events } = harness();
      for (let i = 0; i < 10; i++) take.pushPCM(frame());
      calls[0]!.response.reject(new DictationError(code, "safe failure")); await settled();
      expect(take.terminal).toBe(code === "provider");
      if (code === "network") {
        const done = take.finish(); calls[1]!.response.reject(new DictationError("network", "safe failure")); await done;
        expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "network" } });
      }
    }
  });
  it("empty finals are allowed but an entirely empty take reports no_speech", async () => {
    const { take, calls, events } = harness(); utterance(take);
    const done = take.finish(); calls[0]!.response.resolve(""); await done;
    expect(events).toContainEqual({ type: "segment_final", segment_id: 0, text: "" });
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "no_speech" } });
  });
  it("validates Finish accounting, enforces aggregate 120s and rejects oversized frames", () => {
    const first = harness(); first.take.pushPCM(frame(0)); void first.take.finish(1, 2);
    expect(first.events.at(-1)).toMatchObject({ type: "error", error: { code: "format" } });
    const second = harness();
    for (let i = 0; i < 600; i++) second.take.pushPCM(frame(0));
    expect(second.take.terminal).toBe(false); second.take.pushPCM(frame(0, 1));
    expect(second.events.at(-1)).toMatchObject({ type: "error", error: { code: "too_large" } });
    const third = harness(); third.take.pushPCM(frame(1000, 3201)); expect(third.take.terminal).toBe(true);
  });
});

describe("dedicated socket protocol", () => {
  function socket() {
    const policy = dictationPolicy("https://speech.example/v1"); const events: DictationServerMessage[] = [];
    const service = createDictationTransport(policy, (async () => Response.json({ text: "hello" })) as unknown as typeof fetch);
    const ws = new DictationSocket(policy, service, (event) => events.push(event));
    return { ws, policy, events };
  }
  it("validates version/generation before ready", () => {
    for (const input of [{ type: "start", version: 1 }, { type: "start", version: 2, generation: "old", model: "model" }]) {
      const { ws, events } = socket(); ws.message(JSON.stringify(input)); expect(events[0]!.type).toBe("error"); ws.close();
    }
  });
  it("rejects audio before ready and gapped sequence or sample offsets", () => {
    const before = socket(); before.ws.message(Buffer.alloc(10)); expect(before.events[0]!.type).toBe("error");
    for (const field of [0, 4]) {
      const { ws, policy, events } = socket(); ws.message(JSON.stringify({ type: "start", version: 2, model: "model", generation: policy.generation }));
      const frame = Buffer.alloc(10); frame.writeUInt32LE(1, field); ws.message(frame);
      expect(events.map((event) => event.type)).toEqual(["ready", "error"]);
    }
  });
  it("acknowledges every binary frame and finishes partial samples in order", async () => {
    const { ws, policy, events } = socket(); ws.message(JSON.stringify({ type: "start", version: 2, model: "model", generation: policy.generation }));
    const bytes = Buffer.alloc(10); bytes.writeInt16LE(1000, 8); ws.message(bytes);
    expect(events.at(-1)).toEqual({ type: "ack", frames: 1, samples: 1 });
    ws.message(JSON.stringify({ type: "finish", frames: 1, samples: 1 }));
    // bounded microtask drain; mocked fetch/body parsing has no timer or real I/O.
    for (let i = 0; i < 100 && events.at(-1)?.type !== "finished"; i++) await Promise.resolve();
    expect(events.at(-1)).toEqual({ type: "finished", text: "hello" }); ws.close();
  });
});
