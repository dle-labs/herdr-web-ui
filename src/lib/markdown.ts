import { memoizeLast } from "./memoizeLast.ts";
import { fileUriPath } from "./terminalFileLinks.ts";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "math"; value: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  /** a link to a local file (`[report](/repo/out/REPORT.md)`): its label opens the path */
  | { type: "file"; path: string; children: InlineNode[] };

/**
 * The lines of the source a block or list item came from, 1-based and inclusive, as an editor numbers
 * them. Only `parseMarkdownWithLines` sets them: the chat's blocks are stored and compared as they are.
 */
export type SourceLines = [first: number, last: number];

export interface ListItem {
  content: InlineNode[];
  /** the item's own text, from its line to its last continuation line; its nested blocks have their own */
  source?: SourceLines;
  /** a task list item (`- [x] done`, `- [ ] open`): whether its box is checked */
  checked?: boolean;
  /** what is indented under the item's text, in order: a nested list, a table */
  blocks?: MarkdownBlock[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  /** an ordered list's first number: a list split by a code block goes on from where it was */
  start?: number;
  items: ListItem[];
  source?: SourceLines;
}

export type MarkdownBlock =
  | { type: "math"; value: string; source?: SourceLines }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[]; source?: SourceLines }
  /** `lineNumbers` has one file line per entry of `lines` */
  | { type: "paragraph"; lines: InlineNode[][]; source?: SourceLines; lineNumbers?: number[] }
  | ListBlock
  | { type: "blockquote"; blocks: MarkdownBlock[]; source?: SourceLines }
  /** `source` starts at the opening fence: body line `i` (0-based) is `source[0] + 1 + i` */
  | { type: "code"; language: string; value: string; source?: SourceLines }
  /** `rowLines` is the header row's line, then each row's; the delimiter row has none */
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][]; source?: SourceLines; rowLines?: number[] }
  | { type: "hr"; source?: SourceLines };

export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

/**
 * An address written without its scheme, as people and agents do: `www.example.com/x`,
 * `docs.example.com/guide`, `localhost:7317/`. A host needs a letters-only top level and,
 * past `www.`, a path to count: `README.md:3` is a file and its line, `notes.v2/x` a folder.
 * localhost and an IPv4 address are local servers, plain http, where a port is enough.
 */
export function webLikeHref(target: string): string | null {
  const value = target.trim();
  if (/^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}:\d+|\d{1,3}(?:\.\d{1,3}){3}(?=\/))(?:\/\S*)?$/i.test(value)) return `http://${value}`;
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(\/\S*)?$/i.exec(value);
  if (match === null) return null;
  const [, host, path] = match;
  return /^www\./i.test(host!) || path !== undefined ? `https://${value}` : null;
}

/**
 * The file a link names, when its target is a path rather than an address: agents link
 * files they wrote (`[report](/repo/out/REPORT.md)`, `[x](src/x.ts#L12)`, `[x](x.ts:12)`).
 * A line anchor (`#L12`, `:12`) is dropped; the viewer opens the file. A line after a bare
 * word is a scheme's (`tel:123`), not a file's.
 */
export function markdownFileTarget(href: string): string | null {
  const value = href.trim();
  if (/^file:\/\/\//i.test(value)) return fileUriPath(value);
  if (value === "" || value.startsWith("#")) return null;
  const withoutAnchor = value.replace(/#.*$/, "");
  const path = withoutAnchor.replace(/(?::\d+){1,2}$/, "");
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || (path !== withoutAnchor && !/[./]/.test(path))) return null;
  return path;
}

/** A bare URL without the punctuation that closes the sentence around it (GFM's autolink rule). */
export function trimUrl(url: string): string {
  let end = url.length;
  // counted once: an opening one is never cut, a closing one only from the end
  let opened = 0;
  let closed = 0;
  for (let index = 0; index < end; index += 1) {
    if (url[index] === "(") opened += 1;
    else if (url[index] === ")") closed += 1;
  }
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
    // a closing parenthesis stays only while it closes one opened inside the URL
    if (last === ")" && closed > opened) { end -= 1; closed -= 1; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Emphasis nests by one call each: past this many levels, what is inside is read as plain text. */
const MAX_INLINE_DEPTH = 16;

/**
 * The marks in a line, left to right, as one search of the line for the pattern found them. That
 * search looks from every `[`, `\(` and `_` to the end of the line for what closes it, so a long
 * line of them that never close took a minute. Here the pattern is tried only where a mark can
 * start, and where a closer may be far away, only if one is there: each closer is looked for
 * once, for every opener before it.
 */
export function* inlineMarks(source: string): Generator<RegExpExecArray> {
  // Underscores inside identifiers are literal: MAC_QA_CHAT_OK must survive
  // rendering exactly as it appears in the terminal and native transcript.
  // a bare or <angle> http(s) URL is a link too; it stops at the first non-ASCII character,
  // so `…/pull/36에서` links the address and leaves the Korean after it as text
  const marker = /(`[^`\n]+`|\\\(.+?\\\)|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/yu;
  // its last part alone, for a `__` that nothing closes as bold: one `_` may still close it
  const emphasis = /(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu;
  // what any part of `marker` starts with
  const opener = /[`[<*_~]|\\\(|file:\/\/\/|https?:\/\/|www\./g;
  /** Where `pattern` is next found from `from` on. Asked with a `from` that only rises, so a place found serves every `from` before it. */
  const next = (pattern: RegExp): ((from: number) => number) => {
    let found = -1;
    return (from) => {
      if (found < from) {
        pattern.lastIndex = from;
        found = pattern.exec(source)?.index ?? Infinity;
      }
      return found;
    };
  };
  const lineEnd = next(/\n/g);
  // `.` stops at these, and a formula is `.+?`
  const mathBreak = next(/[\n\r\u2028\u2029]/g);
  const mathClose = next(/\\\)/g);
  const labelEnd = next(/[\]\n]/g);
  const targetEnd = next(/[\s)]/g);
  const emphasisClose = next(/(?<=\S)_(?![\p{L}\p{N}\p{M}_])/gu);
  const strongClose = next(/(?<=\S)__(?![\p{L}\p{N}\p{M}_])/gu);
  let from = 0;
  for (;;) {
    opener.lastIndex = from;
    const start = opener.exec(source)?.index;
    if (start === undefined) return;
    from = start + 1;
    let pattern: RegExp | null = marker;
    const char = source[start];
    if (char === "\\") {
      if (!(mathClose(start + 3) < mathBreak(start + 2))) pattern = null;
    } else if (char === "[") {
      const label = labelEnd(start + 1);
      const target = label + 2;
      if (!(label > start + 1 && source[label] === "]" && source[label + 1] === "(")) pattern = null;
      else {
        const end = targetEnd(target);
        if (!(end > target && source[end] === ")")) pattern = null;
      }
    } else if (char === "_") {
      const end = lineEnd(start + 1);
      // a `__` that closes also closes as a `_`, so `marker` has no long search left to fail
      if (!(source[start + 1] === "_" && strongClose(start + 3) < end)) pattern = emphasisClose(start + 2) < end ? emphasis : null;
    }
    if (pattern === null) continue;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (match === null) continue;
    from = start + match[0].length;
    yield match;
  }
}

/** Dependency-free inline markdown scanner. Unknown or malformed markup remains text. */
export function parseInline(source: string, links = true, depth = 0): InlineNode[] {
  if (depth > MAX_INLINE_DEPTH) return source === "" ? [] : [{ type: "text", value: source }];
  const nodes: InlineNode[] = [];
  let offset = 0;
  for (const match of inlineMarks(source)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: source.slice(offset, index) });
    let token = match[0];
    // like an http address it stops at the first non-ASCII character (`file:///tmp/a.md에서`); a
    // name with other letters in it is percent-encoded in a URI
    if (token.startsWith("file:///")) {
      token = trimUrl(token);
      const path = fileUriPath(token);
      nodes.push(links && path !== null ? { type: "file", path, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("<")) {
      const url = token.slice(1, -1);
      nodes.push(links ? { type: "link", href: url, children: [{ type: "text", value: url }] } : { type: "text", value: token });
    } else if (/^(?:https?:|www\.)/i.test(token)) {
      // what ends a sentence is not part of the address: "see https://x.dev/a)." links x.dev/a
      token = trimUrl(token);
      const href = /^www\./i.test(token) ? `https://${token}` : token;
      nodes.push(links ? { type: "link", href, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("\\(")) {
      nodes.push({ type: "math", value: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const target = token.slice(split + 2, -1);
      // a label holds no `]`, so no link nests in one: only emphasis counts toward the depth
      const href = safeMarkdownHref(target) ?? webLikeHref(target);
      const file = href === null ? markdownFileTarget(target) : null;
      nodes.push(href !== null ? { type: "link", href, children: parseInline(label, false, depth) }
        : file !== null ? { type: "file", path: file, children: parseInline(label, false, depth) }
        : { type: "text", value: label });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2), links, depth + 1) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1), links, depth + 1) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

// `s`: the text may hold a line separator (U+2028) that `.` would stop at, and the pattern then
// tries every split of the spaces before it; with it the line is an item, as it reads
const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/s;
/**
 * The line under a table's header: two or more cells of dashes (`---`, `:---:`), with or without
 * the outer pipes. Read cell by cell: one pattern for the whole line tries every way to share
 * a run of spaces between its parts, and a long blank line takes seconds.
 */
export function isTableSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const columns = row.split("|");
  return columns.length >= 2 && columns.every((column) => /^:?-{3,}:?$/.test(column.trim()));
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}
/**
 * A block's `source` from its `lines` indexes. `firstLine` is the file line of `lines[0]`, or null
 * when nothing is recorded: the field is then absent, not undefined, so `parseMarkdown`'s blocks stay
 * exactly what they were.
 */
function span(firstLine: number | null, from: number, to = from): { source?: SourceLines } {
  return firstLine === null ? {} : { source: [firstLine + from, firstLine + to] };
}
function startsTable(lines: string[], index: number): boolean {
  return lineAt(lines, index).includes("|") && isTableSeparator(lineAt(lines, index + 1));
}
/** A table in a list item (`within` > 0) ends at a line outside the item or at the next item. */
function parseTable(lines: string[], start: number, firstLine: number | null, within = 0): { block: MarkdownBlock; next: number } {
  const header = cells(lineAt(lines, start)).map((cell) => parseInline(cell));
  let index = start + 2;
  const rows: InlineNode[][][] = [];
  const rowLines = firstLine === null ? null : [firstLine + start];
  const inItem = (line: string): boolean => within === 0 || ((/^\s*/.exec(line)?.[0].length ?? 0) >= within && !listLine.test(line));
  while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "" && inItem(lineAt(lines, index))) {
    rows.push(cells(lineAt(lines, index)).map((cell) => parseInline(cell)));
    rowLines?.push(firstLine! + index);
    index += 1;
  }
  return { block: { type: "table", header, rows, ...span(firstLine, start, index - 1), ...(rowLines === null ? {} : { rowLines }) }, next: index };
}

/** Whether a line opens a block of its own (math, fence, heading, quote, rule, list, table), so it ends a paragraph. */
function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*\\\[/.test(line) || /^\s{0,3}```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*>/.test(line) || /^(?:\s*[-*_]){3,}\s*$/.test(line) || listLine.test(line)
    || startsTable(lines, index);
}

/** An item's text, with a GitHub task box (`[x]`, `[X]`, `[ ]`) read off its start. */
function listItem(text: string): ListItem {
  const task = /^\[([ xX])\](?:\s+(.*))?$/.exec(text);
  if (task === null) return { content: parseInline(text) };
  return { content: parseInline(task[2] ?? ""), checked: task[1] !== " " };
}

function parseList(lines: string[], start: number, firstLine: number | null): { block: ListBlock; next: number } {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const number = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  const block: ListBlock = { type: "list", ordered, ...(ordered && number !== 1 ? { start: number } : {}), items: [] };
  const listStart = start;
  let index = start;
  while (index < lines.length) {
    // between items: blank lines (a loose list, as agents often write one) and an item's own
    // indented lines, which read on as its text, or make a table in it; anything else ends
    // the list, and so does an indented fence, which shows as its own block
    if (block.items.length > 0 && !listLine.test(lineAt(lines, index))) {
      let ahead = index;
      while (ahead < lines.length && lineAt(lines, ahead).trim() === "") ahead += 1;
      const line = lineAt(lines, ahead);
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const sibling = listLine.exec(line);
      if (sibling !== null && (sibling[1] ?? "").length === baseIndent && /\d/.test(sibling[2] ?? "") === ordered) { index = ahead; continue; }
      // a list indented under the last item after a blank line (or after its table) nests in it
      if (sibling !== null && (sibling[1] ?? "").length >= baseIndent + 2) { index = ahead; continue; }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && startsTable(lines, ahead)) {
        const item = block.items.at(-1)!;
        const table = parseTable(lines, ahead, firstLine, baseIndent + 2);
        (item.blocks ??= []).push(table.block);
        index = table.next;
        continue;
      }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && !/^\s*```/.test(line)) {
        const item = block.items.at(-1)!;
        const last = item.blocks?.at(-1);
        if (last === undefined) {
          // added to, not copied: an item of thousands of lines copies itself at every one
          item.content.push({ type: "text", value: " " });
          for (const node of parseInline(line.trim())) item.content.push(node);
          if (item.source !== undefined) item.source[1] = firstLine! + ahead;
        } else {
          // after a table or nested list the item's text goes on below it; a quote or rule
          // there ends the list and shows as its own block, as it did before tables nested
          if (startsBlock(lines, ahead)) break;
          if (last.type === "paragraph" && ahead === index) {
            last.lines.push(parseInline(line.trim()));
            if (last.source !== undefined) {
              last.source[1] = firstLine! + ahead;
              last.lineNumbers?.push(firstLine! + ahead);
            }
          } else {
            item.blocks!.push({ type: "paragraph", lines: [parseInline(line.trim())], ...span(firstLine, ahead), ...(firstLine === null ? {} : { lineNumbers: [firstLine + ahead] }) });
          }
        }
        index = ahead + 1;
        continue;
      }
      break;
    }
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index, firstLine);
      (parent.blocks ??= []).push(nested.block);
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/.test(match[2] ?? "") !== ordered) break;
    block.items.push({ ...listItem(match[3] ?? ""), ...span(firstLine, index) });
    index += 1;
  }
  if (firstLine !== null) {
    // the loop may stop past blank lines it stepped over looking for a sibling
    let end = index - 1;
    while (end > listStart && lineAt(lines, end).trim() === "") end -= 1;
    block.source = [firstLine + listStart, firstLine + end];
  }
  return { block, next: index };
}

/** KaTeX reads a formula one call per group: nested deeper than this, it is shown as its source. */
const MAX_MATH_DEPTH = 100;

/**
 * Whether a formula's braces nest deeper than anyone writes them. KaTeX takes over a second on
 * thousands of nested fractions before it gives up, with the page waiting on it.
 */
export function mathNestsTooDeep(value: string): boolean {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") index += 1;
    else if (char === "{") { depth += 1; if (depth > MAX_MATH_DEPTH) return true; }
    else if (char === "}" && depth > 0) depth -= 1;
  }
  return false;
}

/** Code blocks longer than this open folded to their first FOLDED_CODE_LINES lines. */
export const FOLD_CODE_AFTER_LINES = 30;
export const FOLDED_CODE_LINES = 20;

/** The folded head of a long code block and its full line count; null when it shows whole. */
export function foldCode(value: string): { head: string; lines: number } | null {
  const lines = value.split("\n");
  if (lines.length <= FOLD_CODE_AFTER_LINES) return null;
  return { head: lines.slice(0, FOLDED_CODE_LINES).join("\n"), lines: lines.length };
}

/** Quotes nest by one call each: past this many levels, what is left is read as plain lines. */
const MAX_QUOTE_DEPTH = 32;

/**
 * Markdown source as blocks, uncached; `parseMarkdown` is the entry, and a quote's contents recurse here.
 * `firstLine` is the 1-based file line of the source's first line, or null to record no source lines.
 */
function parseBlocks(source: string, depth: number, firstLine: number | null): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  // no formula opened before this line closes: the search that found so is not made again
  let unclosedMath = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    // a fence may be indented (inside a list item, as agents write them): its lines lose that indent
    const fence = /^( {0,3})```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      const indent = fence[1] ?? "";
      const body: string[] = [];
      const fenceLine = index;
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lineAt(lines, index))) {
        const bodyLine = lineAt(lines, index++);
        body.push(bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart());
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[2] ?? "", value: body.join("\n"), ...span(firstLine, fenceLine, index - 1) });
      continue;
    }

    const display = index < unclosedMath ? null : /^\s*\\\[(.*)$/.exec(line);
    if (display !== null) {
      const body: string[] = [];
      let next = index;
      const mathLine = index;
      let part = display[1] ?? "";
      let complete = false;
      while (true) {
        const close = part.indexOf("\\]");
        if (close !== -1 && part.slice(close + 2).trim() === "") {
          body.push(part.slice(0, close));
          blocks.push({ type: "math", value: body.join("\n").trim(), ...span(firstLine, mathLine, next) });
          index = next + 1;
          complete = true;
          break;
        }
        body.push(part);
        next += 1;
        if (next >= lines.length || /^\s{0,3}```/.test(lineAt(lines, next))) break;
        part = lineAt(lines, next);
      }
      // An incomplete formula stays prose; later headings and fences still parse normally.
      if (complete) continue;
      // every `\[` up to where the search ended (the end, or a fence) would search the same lines
      unclosedMath = next;
    }

    const heading = /^(#{1,6})\s+(.+)$/s.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6, content: parseInline(heading[2] ?? ""), ...span(firstLine, index) });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr", ...span(firstLine, index) });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      const quoteLine = index;
      while (index < lines.length && /^\s*>/.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/, ""));
      // each quoted line is one line of the file, so the contents count on from the quote's first
      const quoteFirst = firstLine === null ? null : firstLine + quoteLine;
      // a line of thousands of ">" (text nobody wrote by hand) would otherwise overflow the stack
      const inner: MarkdownBlock[] = depth < MAX_QUOTE_DEPTH ? parseBlocks(quoted.join("\n"), depth + 1, quoteFirst)
        : [{
          type: "paragraph",
          lines: quoted.map((quotedLine) => parseInline(quotedLine)),
          ...span(quoteFirst, 0, quoted.length - 1),
          ...(quoteFirst === null ? {} : { lineNumbers: quoted.map((_, offset) => quoteFirst + offset) }),
        }];
      blocks.push({ type: "blockquote", blocks: inner, ...span(firstLine, quoteLine, index - 1) });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index, firstLine);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index, firstLine);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: InlineNode[][] = [];
    const paragraphLine = index;
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      lines: paragraph,
      ...span(firstLine, paragraphLine, index - 1),
      ...(firstLine === null ? {} : { lineNumbers: paragraph.map((_, offset) => firstLine + paragraphLine + offset) }),
    });
  }
  return blocks;
}

/**
 * Markdown source as blocks. The last call is remembered (`memoizeLast`): a file viewer's Preview,
 * toggled to the source and back, mounts anew and would parse a long document again.
 */
export const parseMarkdown = memoizeLast((source: string): MarkdownBlock[] => parseBlocks(source, 0, null));

/**
 * The same blocks with their `source` lines, for a viewer that anchors comments to the file's lines.
 * Its own `memoizeLast`: the chat's calls to `parseMarkdown` never evict a file's parse, nor the reverse.
 */
export const parseMarkdownWithLines = memoizeLast((source: string): MarkdownBlock[] => parseBlocks(source, 0, 1));

/**
 * The spans of the blocks a file comment can be written on, in document order, as `Markdown.tsx` draws them: a
 * heading, paragraph, code, table or math block, a whole blockquote (nothing inside it), each list
 * item's own text and then its nested blocks. A rule and a list itself are none. Needs the blocks
 * of `parseMarkdownWithLines`.
 */
export function previewHosts(blocks: readonly MarkdownBlock[]): SourceLines[] {
  const hosts: SourceLines[] = [];
  const collect = (list: readonly MarkdownBlock[]): void => {
    for (const block of list) {
      if (block.type === "list") {
        for (const item of block.items) {
          if (item.source !== undefined) hosts.push(item.source);
          if (item.blocks !== undefined) collect(item.blocks);
        }
      } else if (block.type !== "hr" && block.source !== undefined) {
        hosts.push(block.source);
      }
    }
  };
  collect(blocks);
  return hosts;
}
