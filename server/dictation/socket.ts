import { DICTATION_FRAME_HEADER_BYTES, DICTATION_FRAME_SAMPLES, DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, DICTATION_VERSION, type DictationServerMessage } from "../../shared/dictation.ts";
import { DictationError, safeDictationError, validateDictationSelection, type DictationPolicy } from "../dictation.ts";
import { DictationCoordinator } from "./coordinator.ts";
import type { createDictationTransport } from "./speaches-http.ts";

/** Dedicated socket state: no terminal client sets, attach, snapshot, pane or RPC access. */
export class DictationSocket {
  private coordinator?: DictationCoordinator;
  private ended = false;
  private timer: ReturnType<typeof setTimeout>;
  constructor(private policy: DictationPolicy, private transport: ReturnType<typeof createDictationTransport>, private emit: (event: DictationServerMessage) => void) {
    this.timer = setTimeout(() => this.fail(new DictationError("timeout", "Dictation start timed out")), 10_000);
  }
  message(raw: string | Buffer): void {
    if (this.ended) return;
    try {
      if (typeof raw !== "string") {
        if (!this.coordinator || this.coordinator.terminal) throw new DictationError("format", "Audio requires an active take");
        if (raw.length <= DICTATION_FRAME_HEADER_BYTES || raw.length > DICTATION_FRAME_HEADER_BYTES + DICTATION_FRAME_SAMPLES * 2 || raw.length % 2 !== 0) throw new DictationError("format", "Invalid audio frame");
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (view.getUint32(0, true) !== this.coordinator.frames || view.getUint32(4, true) !== this.coordinator.samples) throw new DictationError("format", "Audio sequence or sample offset does not match");
        const pcm = new Int16Array((raw.length - DICTATION_FRAME_HEADER_BYTES) / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(DICTATION_FRAME_HEADER_BYTES + i * 2, true);
        this.coordinator.pushPCM(pcm);
        return;
      }
      if (raw.length > 2048) throw new DictationError("format", "Dictation control is too large");
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw); } catch { throw new DictationError("format", "Invalid dictation control"); }
      if (!message || typeof message !== "object") throw new DictationError("format", "Invalid dictation control");
      if (message.type === "cancel") { this.close(); return; }
      if (message.type === "start") {
        if (this.coordinator || message.version !== DICTATION_VERSION) throw new DictationError("format", "Invalid dictation start version or state");
        validateDictationSelection(this.policy, message.model, message.generation);
        const model = message.model;
        clearTimeout(this.timer);
        this.coordinator = new DictationCoordinator({ transcribe: (wav, signal) => this.transport.transcribe(wav, model, signal), emit: (event) => {
          if (["finished", "cancelled", "error"].includes(event.type)) this.ended = true;
          this.emit(event);
        } });
        this.emit({ type: "ready", sample_rate: 16000, max_seconds: DICTATION_MAX_SECONDS, max_bytes: DICTATION_MAX_BYTES });
      } else if (message.type === "finish" && this.coordinator && Number.isSafeInteger(message.frames) && Number.isSafeInteger(message.samples)) {
        void this.coordinator.finish(message.frames as number, message.samples as number);
      } else throw new DictationError("format", "Invalid dictation control or state");
    } catch (error) { this.fail(error); }
  }
  close(): void {
    clearTimeout(this.timer);
    if (this.ended) return;
    if (this.coordinator) this.coordinator.cancel();
    else { this.ended = true; this.emit({ type: "cancelled" }); }
  }
  private fail(error: unknown): void {
    clearTimeout(this.timer);
    if (this.ended) return;
    if (this.coordinator) this.coordinator.fail(error);
    else { this.ended = true; const safe = safeDictationError(error); this.emit({ type: "error", error: { code: safe.code, message: safe.message } }); }
  }
}
