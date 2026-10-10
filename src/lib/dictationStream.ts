import { DICTATION_FINISH_MS, DICTATION_FRAME_SAMPLES, DICTATION_SAMPLE_RATE, type DictationServerMessage } from "../../shared/dictation.ts";
import { DictationTransportError, isDictationErrorCode, permittedDictationPolicy, type DictationConfig } from "./voiceTransport.ts";
import { pcmFrame } from "./dictationPcm.ts";

export interface LiveDictation {
  start(config: DictationConfig, stream: MediaStream, signal: AbortSignal, partial: (text: string) => void, failed?: (error: unknown) => void, reachedLimit?: () => void): Promise<void>;
  finish(): Promise<string>;
  cancel(): void;
}
export interface DictationStreamDependencies {
  context(): AudioContext;
  load(context: AudioContext): Promise<void>;
  node(context: AudioContext): AudioWorkletNode;
  socket(): WebSocket;
  policy: typeof permittedDictationPolicy;
}
const browserDependencies: DictationStreamDependencies = {
  context: () => new AudioContext(),
  load: async (context) => { const { default: url } = await import("./dictationWorklet.ts?worker&url"); await context.audioWorklet.addModule(url); },
  node: (context) => new AudioWorkletNode(context, "herdr-dictation"),
  socket: () => { const url = new URL("/api/dictation/ws", window.location.href); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return new WebSocket(url); },
  policy: permittedDictationPolicy,
};
export class DictationPreview {
  private finals = new Map<number, string>();
  private previews = new Map<number, { revision: number; text: string }>();
  accept(event: Extract<DictationServerMessage, { type: "preview" | "segment_final" }>): string {
    if (!Number.isInteger(event.segment_id) || event.segment_id < 0 || event.segment_id > 1000 || typeof event.text !== "string" || event.text.length > 100_000) throw new DictationTransportError("format");
    if (event.type === "segment_final") {
      if (!this.finals.has(event.segment_id)) this.finals.set(event.segment_id, event.text.trim());
      this.previews.delete(event.segment_id);
    } else if (!this.finals.has(event.segment_id)) {
      if (!Number.isInteger(event.revision) || event.revision < 0) throw new DictationTransportError("format");
      if (event.revision > (this.previews.get(event.segment_id)?.revision ?? -1)) this.previews.set(event.segment_id, { revision: event.revision, text: event.text.trim() });
    }
    const text = new Map(this.finals);
    for (const [id, preview] of this.previews) text.set(id, preview.text);
    const assembled = [...text].sort(([a], [b]) => a - b).map(([, value]) => value).filter(Boolean).join(" ");
    if (assembled.length > 100_000) throw new DictationTransportError("too_large");
    return assembled;
  }
}
/** Called synchronously by the press gesture, before lock, permission or server awaits. */
export function prepareLiveDictation(deps: DictationStreamDependencies = browserDependencies): LiveDictation {
  const context = deps.context();
  const prepared = Promise.all([context.resume(), deps.load(context)]);
  // Startup can be cancelled before start() reaches this promise.
  void prepared.catch(() => undefined);
  let socket: WebSocket | null = null, node: AudioWorkletNode | null = null, source: MediaStreamAudioSourceNode | null = null;
  let ended = false, ready = false, finishing = false, sentFinish = false;
  let frames = 0, samples = 0, ackFrames = 0, ackSamples = 0;
  let resolveReady: (() => void) | undefined, rejectReady: ((error: unknown) => void) | undefined;
  let resolveResult: ((text: string) => void) | undefined, rejectResult: ((error: unknown) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  let onFailure: ((error: unknown) => void) | undefined;
  let rejectStartup!: (error: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectStartup = reject; });
  void cancelled.catch(() => undefined);
  const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  void result.catch(() => undefined);
  function cleanup(): void {
    if (timer) clearTimeout(timer);
    removeAbort?.(); removeAbort = undefined;
    source?.disconnect(); source = null;
    if (node) { node.onprocessorerror = null; node.port.onmessage = null; node.port.onmessageerror = null; node.port.close(); node.disconnect(); node = null; }
    void context.close().catch(() => undefined);
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); socket = null; }
  }
  function fail(error: unknown): void {
    if (ended) return;
    ended = true; rejectStartup(error); rejectReady?.(error); rejectResult?.(error); cleanup(); onFailure?.(error);
  }
  const cancel = () => fail(new DOMException("Aborted", "AbortError"));
  return {
    cancel,
    async start(config, stream, signal, partial, failed, reachedLimit) {
      if (ended) throw new DOMException("Aborted", "AbortError");
      onFailure = failed;
      const abort = () => cancel(); signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
      try {
        signal.throwIfAborted();
        const policy = await Promise.race([deps.policy(config, signal), cancelled]);
        await Promise.race([prepared, cancelled]);
        signal.throwIfAborted();
        if (ended) throw new DOMException("Aborted", "AbortError");
        const preview = new DictationPreview();
        const waitReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        socket = deps.socket();
        timer = setTimeout(() => fail(new DictationTransportError("timeout")), 30_000);
        socket.onopen = () => {
          if (!ended) socket!.send(JSON.stringify({ type: "start", version: 2, model: config.model, generation: policy.generation }));
        };
        socket.onerror = socket.onclose = () => fail(new DictationTransportError("network"));
        socket.onmessage = (event) => {
          if (ended) return;
          try {
            if (typeof event.data !== "string" || event.data.length > 256 * 1024) throw new DictationTransportError("format");
            const message = JSON.parse(event.data) as DictationServerMessage;
            if (message.type === "error") throw new DictationTransportError(isDictationErrorCode(message.error?.code) ? message.error.code : "provider");
            if (message.type === "cancelled") { cancel(); return; }
            if (message.type === "ready") {
              if (ready || message.sample_rate !== DICTATION_SAMPLE_RATE || message.max_seconds !== policy.max_seconds || message.max_bytes !== policy.max_bytes) throw new DictationTransportError("format");
              ready = true; clearTimeout(timer); timer = undefined; resolveReady!(); return;
            }
            if (!ready) throw new DictationTransportError("format");
            if (message.type === "ack") {
              if (!Number.isInteger(message.frames) || !Number.isInteger(message.samples) || message.frames < ackFrames || message.frames > frames || message.samples < ackSamples || message.samples > samples || message.samples !== Math.min(message.frames * DICTATION_FRAME_SAMPLES, samples)) throw new DictationTransportError("format");
              // A port credit is returned only when the server ingested its frame:
              // produced + queued + unacknowledged audio share one bounded window.
              for (let i = ackFrames; i < message.frames; i++) node?.port.postMessage({ type: "credit" });
              ackFrames = message.frames; ackSamples = message.samples; return;
            }
            if (message.type === "preview" || message.type === "segment_final") { partial(preview.accept(message)); return; }
            if (message.type === "finished") {
              if (!sentFinish || typeof message.text !== "string" || message.text.length > 100_000) throw new DictationTransportError("format");
              const text = message.text.trim();
              if (!text) throw new DictationTransportError("no_speech");
              ended = true; resolveResult!(text); cleanup(); return;
            }
            throw new DictationTransportError("format");
          } catch (error) { fail(error instanceof DictationTransportError ? error : new DictationTransportError("format")); }
        };
        await waitReady;
        signal.throwIfAborted();
        if (ended) throw new DOMException("Aborted", "AbortError");
        node = deps.node(context);
        let resolveCapture!: () => void;
        const captureReady = new Promise<void>((resolve) => { resolveCapture = resolve; });
        node.onprocessorerror = node.port.onmessageerror = () => fail(new DictationTransportError("format"));
        node.port.onmessage = (event) => {
          if (ended) return;
          try {
            if (event.data.type === "overflow") throw new DictationTransportError("too_large");
            if (event.data.type === "audio") {
              const data = event.data.data as Int16Array;
              if (!(data instanceof Int16Array) || data.length < 1 || data.length > DICTATION_FRAME_SAMPLES || sentFinish || (!finishing && data.length !== DICTATION_FRAME_SAMPLES)) throw new DictationTransportError("format");
              // Eight ACK-coupled port credits bound the entire pipeline to ~2 s.
              if (socket!.bufferedAmount > 64_000 || samples + data.length - ackSamples > 32_000 || samples + data.length > policy.max_seconds * DICTATION_SAMPLE_RATE || (samples + data.length) * 2 > policy.max_bytes) throw new DictationTransportError("too_large");
              socket!.send(pcmFrame(frames++, samples, data)); samples += data.length;
              resolveCapture();
            } else if (event.data.type === "limit") {
              if (samples !== policy.max_seconds * DICTATION_SAMPLE_RATE) throw new DictationTransportError("format");
              if (!finishing) reachedLimit?.();
            } else if (event.data.type === "drained") {
              if (!finishing || sentFinish || event.data.samples !== samples) throw new DictationTransportError("format");
              source?.disconnect(); source = null;
              node!.disconnect(); node!.port.close(); node = null;
              void context.close().catch(() => undefined);
              sentFinish = true;
              socket!.send(JSON.stringify({ type: "finish", frames, samples }));
            } else throw new DictationTransportError("format");
          } catch (error) { fail(error instanceof DictationTransportError ? error : new DictationTransportError("network")); }
        };
        source = context.createMediaStreamSource(stream); source.connect(node); node.connect(context.destination);
        // Permission and a ready server are not proof the worklet is capturing.
        await Promise.race([captureReady, cancelled]);
      } catch (error) { fail(error); throw error; }
    },
    finish() {
      if (!ended && !finishing) {
        finishing = true;
        timer = setTimeout(() => fail(new DictationTransportError("timeout")), DICTATION_FINISH_MS);
        // Caller stops tracks first. The port barrier runs after already-produced render blocks.
        if (!node || !ready) cancel(); else node.port.postMessage({ type: "drain" });
      }
      return result;
    },
  };
}
