/** Opt-in, local recording replay against the real configured Speaches via WebUI.
 * bun run check run bun scripts/dictation-benchmark.ts --yes --base https://host/v1 --out /private/out recording.mp3 ...
 * Private audio/results must stay outside the checkout. Never used by CI; no microphone or terminals.
 */
import "./test-herdr.ts";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { DICTATION_DEFAULT_MODEL, DICTATION_SAMPLE_RATE, DICTATION_FRAME_SAMPLES } from "../shared/dictation.ts";
import type { DictationConfigResponse, DictationServerMessage } from "../shared/dictation.ts";

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${flag} value`);
  args.splice(at, 2); return value;
};
const base = take("--base"), output = take("--out"), model = take("--model") ?? DICTATION_DEFAULT_MODEL;
const yes = args.indexOf("--yes");
if (yes >= 0) args.splice(yes, 1);
if (yes < 0 || !base || !output || !args.length || args.some((arg) => arg.startsWith("--"))) {
  console.error("Usage: bun run check run bun scripts/dictation-benchmark.ts --yes --base HTTPS_API_BASE --out PRIVATE_DIRECTORY [--model INSTALLED_ID] AUDIO_FILE...");
  process.exit(1);
}
const repo = realpathSync(join(import.meta.dir, ".."));
mkdirSync(resolve(output), { recursive: true, mode: 0o700 });
const out = realpathSync(resolve(output));
if (out === repo || out.startsWith(repo + sep)) throw new Error("Benchmark artifacts must be outside the checkout");
const fixtures = args.map((arg) => realpathSync(resolve(arg)));
const token = crypto.randomUUID();
const stateDir = join(out, `state-${crypto.randomUUID()}`);
const upstreamMetrics: Array<{ audio_seconds: number; elapsed_ms: number }> = [];
const observedFetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const file = init?.body instanceof FormData ? init.body.get("file") : null;
  const started = performance.now();
  try { return await fetch(input, init); }
  finally {
    if (file instanceof Blob) upstreamMetrics.push({ audio_seconds: Math.max(0, file.size - 44) / (DICTATION_SAMPLE_RATE * 2), elapsed_ms: Math.round(performance.now() - started) });
  }
}, { preconnect: fetch.preconnect });
const server = createServer({ hostname: "127.0.0.1", port: 0, token, stateDir, dictationBaseUrl: base, dictationFetch: observedFetch, usage: new UsageService(undefined, []) });
const origin = `http://127.0.0.1:${server.port}`;
const auth = { Authorization: `Bearer ${token}`, Origin: origin };
const results: unknown[] = [];

/** Wait for a measured condition/deadline, not a guessed startup sleep. */
async function until(predicate: () => boolean, deadline: number, label: string): Promise<void> {
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(Math.min(20, Math.max(1, deadline - performance.now())));
  }
}
async function pcmFile(path: string): Promise<Buffer> {
  const child = Bun.spawn(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-ac", "1", "-ar", String(DICTATION_SAMPLE_RATE), "-t", "121", "-f", "s16le", "pipe:1"], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 30_000);
  try {
    const [raw, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
    if (code !== 0) throw new Error("Local fixture conversion failed");
    const bytes = Buffer.from(raw);
    if (!bytes.length || bytes.length > 120 * DICTATION_SAMPLE_RATE * 2) throw new Error("Fixture must be nonempty and at most 120 seconds");
    return bytes;
  } finally { clearTimeout(deadline); }
}
try {
  const configResponse = await fetch(`${origin}/api/dictation/config`, { headers: auth, signal: AbortSignal.timeout(10_000) });
  if (!configResponse.ok) throw new Error(`Config: HTTP ${configResponse.status}`);
  const config = await configResponse.json() as DictationConfigResponse;
  if (!config.enabled || !config.modes.includes("live")) throw new Error("Coordinator live mode is unavailable");
  for (const fixture of fixtures) {
    const pcm = await pcmFile(fixture);
    const requestsBefore = upstreamMetrics.length;
    const totalSamples = pcm.length / 2;
    const events: Array<{ ms: number; event: DictationServerMessage }> = [];
    let ready = false, finished = false, failure: string | null = null, text = "", acked = 0, sentFrames = 0;
    let firstPreview: number | null = null, firstText: number | null = null, finishAt = 0;
    let began = performance.now();
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/dictation/ws`, { headers: auth });
    const closed = Promise.withResolvers<void>();
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", version: 2, model, generation: config.generation }));
    ws.onmessage = ({ data }) => {
      const event = JSON.parse(String(data)) as DictationServerMessage;
      const ms = Math.round(performance.now() - began);
      events.push({ ms, event });
      if (event.type === "ready") ready = true;
      if (event.type === "ack") acked = event.samples;
      if (event.type === "preview" && event.text.trim() && firstPreview === null) firstPreview = ms;
      if ((event.type === "preview" || event.type === "segment_final") && event.text.trim() && firstText === null) firstText = ms;
      if (event.type === "finished") { text = event.text; finished = true; }
      if (event.type === "error") failure = event.error.code;
    };
    ws.onerror = () => { failure = "socket_error"; };
    ws.onclose = () => { if (!finished && !failure) failure = "premature_close"; closed.resolve(); };
    const checkFailure = () => { if (failure) throw new Error(`Replay failed: ${failure}`); };
    try {
      await until(() => ready || failure !== null, performance.now() + 10_000, "ready"); checkFailure();
      began = performance.now();
      for (let offset = 0; offset < totalSamples; offset += DICTATION_FRAME_SAMPLES) {
        const count = Math.min(DICTATION_FRAME_SAMPLES, totalSamples - offset);
        const due = began + (offset + count) / DICTATION_SAMPLE_RATE * 1000;
        await until(() => performance.now() >= due || failure !== null, due + 1000, "paced audio"); checkFailure();
        if (offset - acked > DICTATION_SAMPLE_RATE * 2 || ws.bufferedAmount > DICTATION_SAMPLE_RATE * 4) throw new Error("Replay backpressure limit");
        const frame = Buffer.alloc(8 + count * 2);
        frame.writeUInt32LE(sentFrames++, 0); frame.writeUInt32LE(offset, 4);
        pcm.copy(frame, 8, offset * 2, (offset + count) * 2);
        ws.send(frame);
      }
      finishAt = performance.now();
      ws.send(JSON.stringify({ type: "finish", frames: sentFrames, samples: totalSamples }));
      await until(() => finished || failure !== null, finishAt + 66_000, "finished"); checkFailure();
      const row = { fixture: basename(fixture), duration_seconds: totalSamples / DICTATION_SAMPLE_RATE,
        first_preview_ms: firstPreview, first_text_ms: firstText, finish_latency_ms: Math.round(performance.now() - finishAt),
        preview_count: events.filter((e) => e.event.type === "preview").length,
        final_segments: events.filter((e) => e.event.type === "segment_final").length, frames: sentFrames,
        recognition_requests: upstreamMetrics.length - requestsBefore,
        recognition_audio_seconds: Math.round(upstreamMetrics.slice(requestsBefore).reduce((sum, r) => sum + r.audio_seconds, 0) * 100) / 100,
        text };
      results.push(row);
      writeFileSync(join(out, `${basename(fixture)}.events.json`), JSON.stringify(events, null, 2), { mode: 0o600 });
      writeFileSync(join(out, "replay.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ ...row, text: undefined, characters: text.length }));
    } finally {
      ws.close();
      await Promise.race([closed.promise, Bun.sleep(1000)]);
    }
  }
} finally { await server.stop(); }
