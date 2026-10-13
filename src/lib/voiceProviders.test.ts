import { afterEach, expect, it } from "bun:test";
import { dictationLocale, readVoiceEvents, transcribeLanguage, transcribeOpenAI, voiceKeywords } from "./voiceProviders.ts";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const stream = (...parts: string[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
it("parses NDJSON across chunks, blank lines, CRLF and unterminated final lines", async () => {
  const events = [];
  for await (const event of readVoiceEvents(stream('{"type":"delta","te', 'xt":"hi"}\r\n\n', '{"type":"done","text":"hello"}'))) events.push(event);
  expect(events).toEqual([{ type: "delta", text: "hi" }, { type: "done", text: "hello" }]);
});
it("rejects malformed events and cancels an early reader", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"done","text":42}\n')); }, cancel() { cancelled = true; } });
  await expect((async () => { for await (const _event of readVoiceEvents(body)) {} })()).rejects.toThrow();
  expect(cancelled).toBe(true);
});
it("sends language, mode, polish and filtered keywords; inserts only final polished text", async () => {
  let form!: FormData;
  globalThis.fetch = (async (url, init) => {
    expect(url).toBe("/api/voice/transcribe"); form = init!.body as FormData;
    return new Response(stream('{"type":"delta","text":"raw"}\n{"type":"done","text":"raw"}\n{"type":"polished","text":"tidied"}\n'));
  }) as typeof fetch;
  const previews: string[] = [];
  expect(await transcribeOpenAI({ language: "ko-KR", mode: "terminal", polish: true, keywords: [" git ", "git", "x".repeat(81)] }, new Blob(["a"], { type: "audio/mp4" }), new AbortController().signal, (text) => previews.push(text))).toBe("tidied");
  expect(form.get("language")).toBe("ko"); expect(form.get("polish")).toBe("1"); expect(form.get("mode")).toBe("terminal"); expect(form.get("keywords")).toBe('["git"]'); expect(previews).toEqual(["raw"]);
});
it("accepts upstream optional-polish failure raw fallback, but never incomplete/error streams", async () => {
  const options = { language: "en", mode: "chat" as const, polish: true, keywords: [] }, blob = new Blob(["a"], { type: "audio/webm" });
  globalThis.fetch = (async () => new Response(stream('{"type":"done","text":"raw"}\n'))) as unknown as typeof fetch;
  expect(await transcribeOpenAI(options, blob, new AbortController().signal)).toBe("raw");
  for (const body of ['{"type":"delta","text":"partial"}\n', '{"type":"done","text":"raw"}\n{"type":"error","code":"provider_auth","message":"no"}\n']) {
    globalThis.fetch = (async () => new Response(stream(body))) as unknown as typeof fetch;
    await expect(transcribeOpenAI(options, blob, new AbortController().signal)).rejects.toThrow();
  }
});
it("aborts a stalled NDJSON reader without delivering text", async () => {
  const controller = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = (async () => { for await (const _event of readVoiceEvents(body, controller.signal)) {} })();
  controller.abort(); await expect(pending).rejects.toThrow(); expect(cancelled).toBe(true);
});
it("resolves browser languages safely and bounds keywords", () => {
  expect(dictationLocale("auto", "system", "en", ["fr-CA"])).toBe("fr-CA");
  expect(dictationLocale("auto", "ko", "ko", ["fr-CA"])).toBe("ko-KR");
  expect(dictationLocale("auto", "system", "en", ["garbage<script>"])).toBe("en-US");
  expect(transcribeLanguage("ja-JP")).toBe("ja"); expect(transcribeLanguage("bad")).toBe("en");
  expect(voiceKeywords(Array.from({ length: 60 }, (_, i) => String(i)))).toHaveLength(50);
});
