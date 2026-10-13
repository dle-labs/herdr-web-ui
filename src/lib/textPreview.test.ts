import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadKatex, ParsedMarkdown } from "../components/Markdown.tsx";
import { OpenFileContext } from "./filePaths.ts";
import { SettingsProvider } from "./settings.ts";
import { parseMarkdown } from "./markdown.ts";
import { TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { answeredFileSize, decodeStart, hasPreview, loadedText, PREVIEW_CHUNK_ELEMENTS, PREVIEW_ELEMENT_LIMIT, previewChunks, previewElements, readTextStart, TEXT_LOAD_LIMIT, TEXT_START_HEADERS } from "./textPreview.ts";

describe("loadedText", () => {
  it("cuts the incomplete last line of a file longer than the limit only", () => {
    expect(loadedText("a\nb\nhal", 100, 8)).toEqual({ text: "a\nb\n", truncated: true, limit: 8, size: 100 });
    expect(loadedText("a\nb\nhal", 8, 8)).toEqual({ text: "a\nb\nhal", truncated: false, limit: 8, size: 8 });
    // one huge line (minified JSON): nothing to cut back to, so it stays
    expect(loadedText("{\"a\":1,\"b\"", 100, 10).text).toBe("{\"a\":1,\"b\"");
    // the cut may land inside a UTF-8 sequence, which decodes to U+FFFD: drop only that
    expect(loadedText("{\"a\":\"ä\uFFFD", 100, 10).text).toBe("{\"a\":\"ä");
    expect(loadedText("", 100, 10)).toEqual({ text: "", truncated: true, limit: 10, size: 100 });
  });

  it("keeps a file of exactly the limit whole", () => {
    expect(loadedText("abc", 3, 3).truncated).toBe(false);
  });

  it("takes a file of unknown size for one cut short, so its part is never copied as the whole", () => {
    expect(loadedText("abc", null, 10)).toEqual({ text: "abc", truncated: true, limit: 10, size: null });
  });
});

describe("answeredFileSize", () => {
  it("reads the size a 206 sends with its part, not the size the stat saw before", () => {
    // the stat said 900 bytes; the file has grown to 4096 by the time its first 1024 are sent
    expect(answeredFileSize(206, "bytes 0-1023/4096", 1024)).toBe(4096);
    expect(loadedText("a\n", answeredFileSize(206, "bytes 0-1023/4096", 1024), 1024).truncated).toBe(true);
    expect(answeredFileSize(206, "bytes 0-11/12", 12)).toBe(12);
  });

  it("takes a 200 for the whole file, whatever its length", () => {
    expect(answeredFileSize(200, null, 5000)).toBe(5000);
  });

  it("reads an empty file from the 416 that answers a range of it", () => {
    expect(answeredFileSize(416, "bytes */0", 0)).toBe(0);
  });

  it("does not know the size when the answer does not say it", () => {
    expect(answeredFileSize(206, null, 1024)).toBeNull();
    expect(answeredFileSize(206, "bytes 0-1023/*", 1024)).toBeNull();
    expect(answeredFileSize(206, "garbage", 1024)).toBeNull();
    expect(answeredFileSize(416, null, 0)).toBeNull();
    expect(answeredFileSize(502, null, 40)).toBeNull();
  });
});

describe("decodeStart", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  it("cuts a whole file sent in place of its first part to the limit", () => {
    expect(decodeStart(bytes("a\nb\nc\n"), 4)).toBe("a\nb\n");
    expect(decodeStart(bytes("short"), 100)).toBe("short");
  });
  it("leaves a broken last character for loadedText to drop", () => {
    // "ä" is two bytes: a cut after the first leaves U+FFFD
    const text = decodeStart(bytes("xä"), 2);
    expect(text).toBe("x\uFFFD");
    expect(loadedText(text, 3, 2).text).toBe("x");
  });
});

describe("readTextStart", () => {
  const answer = (body: string, status: number, range?: string) => new Response(status === 416 ? null : body, { status, headers: range === undefined ? {} : { "content-range": range } });

  it("asks for the first quarter megabyte, whatever the file's size", () => {
    expect(TEXT_LOAD_LIMIT).toBe(256 * 1024);
    expect(TEXT_START_HEADERS).toEqual({ range: `bytes=0-${256 * 1024 - 1}` });
  });

  it("takes a part that is the whole file as the whole file", async () => {
    expect(await readTextStart(answer("one\ntwo", 206, "bytes 0-6/7"))).toEqual({ text: "one\ntwo", truncated: false, limit: TEXT_LOAD_LIMIT, size: 7 });
  });

  it("cuts a part of a longer file back to its last whole line", async () => {
    const part = `${"a".repeat(TEXT_LOAD_LIMIT - 4)}\nbcd`;
    const loaded = await readTextStart(answer(part, 206, `bytes 0-${TEXT_LOAD_LIMIT - 1}/${TEXT_LOAD_LIMIT * 2}`));
    expect(loaded.truncated).toBe(true);
    expect(loaded.size).toBe(TEXT_LOAD_LIMIT * 2);
    expect(loaded.text).toBe(`${"a".repeat(TEXT_LOAD_LIMIT - 4)}\n`);
  });

  it("cuts a whole file a server sent despite the range to the limit", async () => {
    const loaded = await readTextStart(answer("x\n".repeat(TEXT_LOAD_LIMIT), 200));
    expect(loaded.truncated).toBe(true);
    expect(loaded.text.length).toBe(TEXT_LOAD_LIMIT);
  });

  it("cancels an ignoring-range stream without waiting for its end or cancellation", async () => {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("x\n".repeat(TEXT_LOAD_LIMIT))); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }));
    const loaded = await readTextStart(response);
    expect(loaded).toEqual({ text: "x\n".repeat(TEXT_LOAD_LIMIT / 2), truncated: true, limit: TEXT_LOAD_LIMIT, size: null });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("propagates abort and the stalled-body deadline through the bounded reader", async () => {
    let cancelled = 0;
    const response = () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
    await expect(readTextStart(response(), { timeoutMs: 10 })).rejects.toThrow("timed out");
    const abort = new AbortController();
    const pending = readTextStart(response(), { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(cancelled).toBe(2);
  });

  it("does not trust an underreported range total, even at an exact chunk boundary", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("a\n".repeat(TEXT_LOAD_LIMIT / 2 - 1) + "bc"));
      controller.enqueue(new TextEncoder().encode("more"));
      controller.close();
    } }), { status: 206, headers: { "content-range": `bytes 0-${TEXT_LOAD_LIMIT - 1}/${TEXT_LOAD_LIMIT}` } });
    expect(await readTextStart(response)).toEqual({ text: "a\n".repeat(TEXT_LOAD_LIMIT / 2 - 1), truncated: true, limit: TEXT_LOAD_LIMIT, size: null });
  });

  it("keeps unknown-size ranges partial and removes an incomplete UTF-8 cutoff", async () => {
    const loaded = await readTextStart(answer("x".repeat(TEXT_LOAD_LIMIT - 1) + "ä", 206, `bytes 0-${TEXT_LOAD_LIMIT}/*`));
    expect(loaded).toEqual({ text: "x".repeat(TEXT_LOAD_LIMIT - 1), truncated: true, limit: TEXT_LOAD_LIMIT, size: null });
    expect(await readTextStart(answer("one\npartial", 206))).toEqual({ text: "one\n", truncated: true, limit: TEXT_LOAD_LIMIT, size: null });
  });

  it("marks a prematurely ended range partial even when its total fits the budget", async () => {
    expect(await readTextStart(answer("one\ntwo", 206, "bytes 0-9/10"))).toEqual({ text: "one\n", truncated: true, limit: TEXT_LOAD_LIMIT, size: 10 });
  });

  it("discards an empty-416 error body without reading it", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 416, headers: { "content-range": "bytes */0" } });
    expect(await readTextStart(response)).toEqual({ text: "", truncated: false, limit: TEXT_LOAD_LIMIT, size: 0 });
    expect(cancelled).toBe(true);
  });

  it("bounds and cancels a range-ignoring body without awaiting its cancellation", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(TEXT_LOAD_LIMIT + 100))); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const loaded = await readTextStart(new Response(stream));
    expect(loaded.text.length).toBe(TEXT_LOAD_LIMIT);
    expect(loaded.truncated).toBe(true);
    expect(loaded.size).toBeNull();
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("keeps an exactly-budget 200 whole after checking the stream ends", async () => {
    const text = "a".repeat(TEXT_LOAD_LIMIT - 1) + "b";
    expect(await readTextStart(answer(text, 200))).toEqual({ text, truncated: false, limit: TEXT_LOAD_LIMIT, size: TEXT_LOAD_LIMIT });
  });

  it("decodes UTF-8 across stream chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([120, 195]));
        controller.enqueue(new Uint8Array([164]));
        controller.close();
      },
    });
    expect(await readTextStart(new Response(stream))).toEqual({ text: "xä", truncated: false, limit: TEXT_LOAD_LIMIT, size: 3 });
  });

  for (const lookahead of [false, true]) {
    it(`aborts a stalled ${lookahead ? "exact-budget lookahead" : "body read"} without awaiting cancellation`, async () => {
      const abort = new AbortController();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { if (lookahead) controller.enqueue(new Uint8Array(TEXT_LOAD_LIMIT)); },
        // Abort when the reader asks for the stalled chunk, with no timing-based sleep.
        pull() { abort.abort(); return new Promise<void>(() => {}); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      }, { highWaterMark: 0 });
      await expect(readTextStart(new Response(stream), { signal: abort.signal })).rejects.toThrow("File preview aborted.");
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    });
  }

  it("discards an already-aborted response before reading it", async () => {
    const abort = new AbortController();
    abort.abort();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(readTextStart(new Response(stream), { signal: abort.signal })).rejects.toThrow("File preview aborted.");
    expect(cancelled).toBe(true);
  });

  it("rejects already-aborted empty responses too", async () => {
    const abort = new AbortController();
    abort.abort();
    for (const response of [new Response(null), new Response(null, { status: 416, headers: { "content-range": "bytes */0" } })]) {
      await expect(readTextStart(response, { signal: abort.signal })).rejects.toThrow("File preview aborted.");
    }
  });

  it("cancels an error body rather than displaying it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(readTextStart(new Response(stream, { status: 404 }))).rejects.toThrow("the file answered 404");
    expect(cancelled).toBe(true);
  });

  it("loads an empty file, which has no first byte to send", async () => {
    expect(await readTextStart(answer("", 416, "bytes */0"))).toEqual({ text: "", truncated: false, limit: TEXT_LOAD_LIMIT, size: 0 });
  });

  it("never takes an error answer for the file's text", async () => {
    await expect(readTextStart(answer('{"error":{"code":"not_found"}}', 404))).rejects.toThrow("the file answered 404");
    await expect(readTextStart(answer("", 416, "bytes */99"))).rejects.toThrow("the file answered 416");
  });
});

describe("hasPreview", () => {
  it("gives only Markdown a Preview", () => {
    expect(hasPreview("markdown")).toBe(true);
    expect(hasPreview("typescript")).toBe(false);
    expect(hasPreview(null)).toBe(false);
  });
});

describe("previewChunks", () => {
  it("splits a long Preview into whole blocks under the chunk size, in order and complete", () => {
    const blocks = parseMarkdown("# Notes\n\nA paragraph of ordinary notes, with *emphasis* and a [link](./notes.txt).\n\n".repeat(4_000), 0, true);
    const chunks = previewChunks(blocks);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.flat()).toEqual(blocks);
    for (const chunk of chunks) expect(previewElements(chunk) - 1).toBeLessThanOrEqual(PREVIEW_CHUNK_ELEMENTS);
  });

  it("keeps a short Preview, an empty one and an oversized block each whole", () => {
    const short = parseMarkdown("# Title\n\nsome text", 0, true);
    expect(previewChunks(short)).toEqual([short]);
    expect(previewChunks([])).toEqual([]);
    const big = parseMarkdown("- a\n".repeat(3_000), 0, true);
    expect(previewChunks([...big, ...short])).toEqual([big, short]);
  });
});

describe("previewElements", () => {
  // what the Preview draws, counted on its markup: the estimate the worker refuses a file by must
  // never be below it, or a file under the limit could still hold the page
  const drawn = (source: string): { estimate: number; actual: number } => {
    const blocks = parseMarkdown(source, 0, true);
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, {
      value: () => {}, children: createElement(ParsedMarkdown, { blocks }),
    }) }));
    return { estimate: previewElements(blocks), actual: (html.match(/<[A-Za-z][^>]*>/g) ?? []).length };
  };

  it("never counts fewer elements than the Preview draws", async () => {
    await loadKatex();
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      for (const source of [
        "# Title", "one **two**\nthree", "- a\n- b\n  - c", "> - a",
        "- [x] done\n".repeat(300), "- [ ] open\n".repeat(300), "- a\n".repeat(300),
        "a/a.c ".repeat(500), "`src/a.ts` and `x` ".repeat(200), "\\(x_i + y\\) ".repeat(100),
        "\\[" + "a+".repeat(300) + "a\\]",
        "| a | b |\n| --- | --- |\n" + "| c/d | `e` |\n".repeat(100),
        "A paragraph with *em*, **strong**, [link](https://x.y/z) and ./docs/a.md.\n".repeat(100),
        '<p align="center"><img src="a.png" width="80"></p>\n\n' + "![alt](b/c.png) text\n\n".repeat(50),
      ]) {
        const { estimate, actual } = drawn(source);
        expect({ source: source.slice(0, 40), short: estimate < actual }).toEqual({ source: source.slice(0, 40), short: false });
      }
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("puts a file of the load limit's short list items past what a Preview draws", () => {
    expect(previewElements(parseMarkdown("- a\n".repeat(TEXT_PREVIEW_BYTES / 4)))).toBeGreaterThan(PREVIEW_ELEMENT_LIMIT);
    // a long real document of the same size stays well under it: this repository's changelog
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8").slice(0, TEXT_PREVIEW_BYTES);
    expect(previewElements(parseMarkdown(changelog, 0, true))).toBeLessThan(PREVIEW_ELEMENT_LIMIT * 0.75);
  });
});
