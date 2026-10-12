import type { InlineNode, MarkdownBlock } from "./markdown.ts";
import { readFilePreviewText } from "./filePreviewText.ts";

/** How the viewer shows a text file: chosen in its header, Preview unless the user asked for the source. */
export type TextViewMode = "preview" | "code";

/**
 * How much of a text file the viewer loads, in bytes: the start of a longer file shows, and Raw
 * opens it whole. It bounds what the Preview parses and the code view highlights too: the chat's
 * parser is built for a message, not a megabyte, and a Preview draws every block of a file at
 * once. Plans and specs agents write are far below it (the largest seen, 79 KB).
 */
export const TEXT_LOAD_LIMIT = 256 * 1024;

/** The request headers for a text file's first `TEXT_LOAD_LIMIT` bytes: a range, whatever the file's size. */
export const TEXT_START_HEADERS: Readonly<Record<string, string>> = { range: `bytes=0-${TEXT_LOAD_LIMIT - 1}` };

/** A text file as the viewer loaded it: its start when it is longer than the limit. */
export interface LoadedText {
  text: string;
  /** the file goes on past `text` */
  truncated: boolean;
  /** the bytes asked for: what "the first 256 KB" says */
  limit: number;
  /** the file's size when its text was sent (`answeredFileSize`), null when the answer did not say */
  size: number | null;
}

/**
 * The text of a file the viewer asked the first `limit` bytes of. The part is cut at a byte
 * count, so its end is a broken line, or a broken UTF-8 character (decoded as U+FFFD): it is cut
 * back to the last whole line. A single huge line (minified JSON) has no whole line to cut back
 * to, so it stays, less a broken character. Whether the file was cut is decided here, once, from
 * the limit the part was loaded with, not from whatever the limit is later. A file of unknown size
 * (null) counts as cut: the part is never taken, and copied, for the whole file.
 */
export function loadedText(body: string, fileSize: number | null, limit: number, truncated = false): LoadedText {
  if (!truncated && fileSize !== null && fileSize <= limit) return { text: body, truncated: false, limit, size: fileSize };
  const newline = body.lastIndexOf("\n");
  const text = newline >= 0 ? body.slice(0, newline + 1) : body.replace(/\uFFFD+$/, "");
  return { text, truncated: true, limit, size: fileSize };
}

/**
 * The first `limit` bytes of a file's body as text. A 206 is that part already; a server that
 * ignores the range answers 200 with the whole file, and is cut here, so the limit holds either
 * way. A cut inside a UTF-8 character decodes to U+FFFD, which `loadedText` drops.
 */
export function decodeStart(bytes: Uint8Array, limit: number): string {
  return new TextDecoder().decode(bytes.subarray(0, limit));
}

/**
 * The size of a file as the answer to the request for its first bytes says it is, read when the
 * body was sent rather than from the stat before it: a file that grew in between is then still
 * known to go on past the part. A 206 names it in its `Content-Range` (`bytes 0-1023/4096`), a
 * server that ignored the range sent the whole file (200), and an empty file answers 416 with
 * `bytes *\/0`. Null when the answer does not say: the part is then not taken for the whole file.
 */
export function answeredFileSize(status: number, contentRange: string | null, received: number): number | null {
  if (status === 200) return received;
  const total = status === 206 ? /^bytes \d+-\d+\/(\d+)$/.exec(contentRange?.trim() ?? "")
    : status === 416 ? /^bytes \*\/(\d+)$/.exec(contentRange?.trim() ?? "")
    : null;
  return total ? Number(total[1]) : null;
}

/** Whether a file in `language` has a rendered Preview besides its source: Markdown does. */
export function hasPreview(language: string | null): boolean {
  return language === "markdown";
}

/**
 * How many elements a Preview may draw. Its parse runs in a worker, but drawing is on the page: in
 * Chromium a list of 65 536 items (about 131 000 elements) held it for 1.6 s, about 12 µs an
 * element, so this many stay well under a second. A file past it opens as its source, "Too long to
 * preview".
 */
export const PREVIEW_ELEMENT_LIMIT = 60_000;

/**
 * The elements a math expression draws: KaTeX lays out a few spans for each character of its source
 * (about 4 in its markup), however short the formula reads.
 */
const MATH_ELEMENTS_PER_CHAR = 5;

/**
 * How many elements inline nodes draw, never fewer than `Markdown.tsx` draws: plain text is a span
 * with a button for each path in it (a path has a `/`, so its slashes bound them), code a `<code>`
 * that may be a path's button, and math its KaTeX.
 */
function inlineElements(nodes: readonly InlineNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "text") count += 1 + node.value.split("/").length - 1;
    else if (node.type === "code") count += 2;
    else if (node.type === "math") count += 1 + node.value.length * MATH_ELEMENTS_PER_CHAR;
    else if (node.type === "image") count += 2 + inlineElements(node.fallback);
    else count += 1 + inlineElements(node.children);
  }
  return count;
}

/**
 * At least how many elements `blocks` draw as a Preview: each block, line, list item (a task's box
 * and its tick too) and table row and cell with its inline elements, a code block as the lines it
 * shows folded (at most 30), and a math block as its KaTeX.
 */
export function previewElements(blocks: readonly MarkdownBlock[]): number {
  // the Preview's own `.markdown` box
  return 1 + blockElements(blocks);
}

function blockElements(blocks: readonly MarkdownBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if (block.type === "heading") count += inlineElements(block.content);
    else if (block.type === "paragraph") for (const line of block.lines) count += 2 + inlineElements(line);
    // Each item draws both its <li> and the stable commentable .markdown-item wrapper.
    else if (block.type === "list") for (const item of block.items) count += 2 + (item.checked === undefined ? 0 : 4) + inlineElements(item.content) + blockElements(item.blocks ?? []);
    else if (block.type === "blockquote") count += blockElements(block.blocks);
    else if (block.type === "table") {
      count += 3;
      for (const row of [block.header, ...block.rows]) { count += 1; for (const cell of row) count += 1 + inlineElements(cell); }
    }
    else if (block.type === "code") count += Math.min(30, block.value.split("\n").length);
    else if (block.type === "math") count += block.value.length * MATH_ELEMENTS_PER_CHAR;
  }
  return count;
}

/**
 * A text file as loaded from the answer to a request with `TEXT_START_HEADERS`: its first
 * `TEXT_LOAD_LIMIT` bytes, cut back to a whole line when the file goes on. An empty file answers
 * 416 (it has no first byte to send) and is loaded as empty. Any other error answer rejects: it
 * carries JSON (the file gone since, a remote PC dropped), never the file's text.
 */
export async function readTextStart(response: Response, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LoadedText> {
  const range = response.headers.get("content-range");
  const empty = response.status === 416 && answeredFileSize(response.status, range, 0) === 0;
  const discard = () => { void response.body?.cancel().catch(() => {}); };
  if (!response.ok && !empty) { discard(); throw new Error(`the file answered ${response.status}`); }
  if (options.signal?.aborted) { discard(); throw new Error("File preview aborted."); }
  // An empty 416 may itself have an error body: never read it as file text.
  if (empty) { discard(); return loadedText("", 0, TEXT_LOAD_LIMIT); }
  let received = 0;
  const reader = response.body?.getReader();
  const body = reader && new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else { received += value.byteLength; controller.enqueue(value); }
    },
    cancel() { void reader.cancel().catch(() => {}); },
  }, { highWaterMark: 0 });
  // Read as an untrusted whole-body stream: missing/unknown range totals stay supported,
  // and even an underreported total must not suppress the reader's bounded lookahead.
  // The helper owns byte/UTF-8 limits, cancellation and the stalled-body deadline.
  try {
    const part = await readFilePreviewText(new Response(body ?? null), TEXT_LOAD_LIMIT, options);
    let size = response.status === 200 && part.truncated ? null : answeredFileSize(response.status, range, received);
    if (size !== null && size < received) size = null;
    return loadedText(part.text, size, TEXT_LOAD_LIMIT, part.truncated || (size !== null && received < size));
  } finally { reader?.releaseLock(); }
}
