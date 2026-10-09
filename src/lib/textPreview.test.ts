import { describe, expect, it } from "bun:test";
import { answeredFileSize, decodeStart, hasPreview, loadedText, readTextStart, TEXT_LOAD_LIMIT, TEXT_START_HEADERS } from "./textPreview.ts";

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
