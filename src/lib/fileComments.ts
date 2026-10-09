import { isCommentPoint, type CommentPoint } from "./commentPins.ts";
import { SELECTION_QUOTE_MAX } from "./compose.ts";
import type { SourceLines } from "./markdown.ts";

/**
 * Comments on lines of a file in the file viewer. This module owns what such a comment is: how it
 * is anchored, how it finds its lines again after the file changed, how it reads as a quote in
 * the next message, and in which order the comments travel. Pure, no DOM and no React; the store
 * and the viewer only consume it.
 */

export type FileView = "code" | "preview";
/** 1-based, inclusive */
export type LineRange = SourceLines;

/** where a selection starts and ends: an index into `quoteLines`, a UTF-16 offset in that line */
export interface FileSelection {
  text: string;
  start: [index: number, column: number];
  end: [index: number, column: number];
}

export interface FileTarget {
  /** absolute, as the viewer resolved it (`FileInfo.path`) */
  path: string;
  /** how the quote names it (`pathLabel`) */
  label: string;
  view: FileView;
  lines: LineRange;
  /** the raw file lines `lines` at save time: what `placeFileComment` looks for again */
  source: string[];
  /** what is quoted, one entry per line element: raw lines (code) or rendered text (preview) */
  quoteLines: string[];
  /** absent: a whole-line comment */
  selection?: FileSelection;
  /**
   * Where the comment was made: a line clicked, or a selection a mouse dragged, where the pointer was, as fractions of
   * its text's box (`CommentPoint`). Its pin's tip goes there; without one, after the end of its text. Not part of its
   * anchor (`fileAnchor`, `fileCommentAt`): the same line clicked elsewhere opens the same comment, its point unchanged.
   */
  point?: CommentPoint;
  /**
   * Set when the target is a stored comment's, for an edit: the store keeps it under this anchor,
   * which a move may have left on other lines (`moveFile`), so it is never recomputed from `lines`.
   */
  anchor?: string;
}

export interface FileComment extends FileTarget {
  kind: "file";
  id: string;
  anchor: string;
  created: number;
  comment: string;
}

/** Most characters one quoted line keeps, the "…" of a cut included. */
export const QUOTE_LINE_MAX = 200;
/** Most lines one quote keeps. */
export const QUOTE_LINES_MAX = 20;

/** The lines of a file as the viewer numbers them: CRLF, CR and LF all end a line, and a last line without newline counts. */
export function fileLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Names the lines (and selection) a comment is on; the same target always gives the same anchor. */
export function fileAnchor(target: FileTarget): string {
  const { selection: s } = target;
  const at = s === undefined ? "" : `@${s.start[0]}.${s.start[1]}-${s.end[0]}.${s.end[1]}`;
  return `file:${target.path}:${target.view}:${target.lines[0]}-${target.lines[1]}${at}`;
}

/**
 * The comment among `comments` that `target` is written on: for an edit (`target.anchor`), the one
 * stored under that anchor; for a new comment, the one placed now on the target's place: stored on
 * it (path, view, lines, selection) with its lines still reading as the file's lines there
 * (`source`), which is where `placeFileComment` keeps it. Never one whose stored anchor merely
 * reads as the target's place: a move may have left that anchor on other lines (`moveFile`). Never
 * an outdated one stored there: the viewer does not show it there, so a new comment must not open
 * with its text nor take its place.
 */
export function fileCommentAt<C extends FileComment>(comments: readonly C[], target: FileTarget): C | undefined {
  if (target.anchor !== undefined) return comments.find((c) => c.anchor === target.anchor);
  const place = fileAnchor(target);
  return comments.find((c) => fileAnchor(c) === place && sameAt(c.source, target.source, 0) && c.source.length === target.source.length);
}

/** `path` relative to `folder` when it lies inside it (either separator), else the path itself. */
export function pathLabel(path: string, folder: string | null): string {
  if (folder === null) return path;
  const base = folder.replace(/[\\/]+$/, "");
  if (base === "" || !path.startsWith(base)) return path;
  const sep = path[base.length];
  if (sep !== "/" && sep !== "\\") return path;
  return path.slice(base.length + 1) || path;
}

/** How a range reads in a quote header: `8` or `42-44`. */
export function linesText(lines: LineRange): string {
  return lines[0] === lines[1] ? String(lines[0]) : `${lines[0]}-${lines[1]}`;
}

function sameAt(source: readonly string[], lines: readonly string[], at: number): boolean {
  return source.every((line, i) => lines[at + i] === line);
}

/**
 * Where a comment's lines are in `lines` now: where they were when they still read the same,
 * else the one other place they occur, else null (outdated). `loaded` is how many leading lines
 * are complete; nothing past it is trusted, so a comment reaching past it is outdated too. In a
 * `truncated` file (cut at the load limit) a comment is never moved: a second copy of its lines
 * may lie past the cut, so "the one other place" cannot be told, and the spec says never to guess.
 */
export function placeFileComment(comment: Pick<FileTarget, "lines" | "source">, lines: readonly string[], loaded: number, truncated = false): LineRange | null {
  const { source } = comment;
  const count = source.length;
  if (count === 0 || comment.lines[1] > loaded) return null;
  const was = comment.lines[0] - 1;
  if (sameAt(source, lines, was)) return comment.lines;
  if (truncated) return null;
  let found = -1;
  for (let at = 0; at + count <= loaded; at++) {
    if (at === was || !sameAt(source, lines, at)) continue;
    if (found >= 0) return null;
    found = at;
  }
  return found < 0 ? null : [found + 1, found + count];
}

/** The code points of `line`, and a UTF-16 offset in it as an index among them. */
function pointAt(line: string, offset: number): number {
  return Array.from(line.slice(0, offset)).length;
}

/** `line` as quoted: whole when it fits, else cut to `QUOTE_LINE_MAX` by code points around `[from, to)` (the selected part), each cut marked with "…". */
function quoteLine(line: string, selected: [from: number, to: number] | null): string {
  const chars = Array.from(line);
  const size = chars.length;
  if (size <= QUOTE_LINE_MAX) return line;
  const room = QUOTE_LINE_MAX - 2;
  let start = 0;
  let end = QUOTE_LINE_MAX - 1;
  if (selected !== null) {
    const [from, to] = selected;
    start = from;
    if (to - from <= room) {
      // centre the selection in a window that has room for a mark at each end
      start = Math.max(0, Math.min(from - Math.floor((room - (to - from)) / 2), size - room));
      end = start + room;
      if (start === 0) end = QUOTE_LINE_MAX - 1;
      else if (end >= size) {
        end = size;
        start = Math.max(0, size - (QUOTE_LINE_MAX - 1));
      }
    } else end = start + (start > 0 ? room : QUOTE_LINE_MAX - 1);
  }
  return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("")}${end < size ? "…" : ""}`;
}

/**
 * The comment's lines as a quote: a header naming the file and range, then the lines behind `> `,
 * a blank one as a bare `>`. Limits: `QUOTE_LINE_MAX` per line (a selected line is cut around
 * the selection, any other at its start), `QUOTE_LINES_MAX` lines and `SELECTION_QUOTE_MAX`
 * characters after the header; the lines dropped are counted in a last `> … (+N lines)`.
 */
export function fileQuote(comment: Pick<FileTarget, "label" | "lines" | "quoteLines" | "selection">): string {
  const { quoteLines, selection } = comment;
  const quoted = quoteLines.map((line, i) => {
    let selected: [number, number] | null = null;
    if (selection !== undefined && i >= selection.start[0] && i <= selection.end[0]) {
      const size = Array.from(line).length;
      const to = i === selection.end[0] ? Math.min(pointAt(line, selection.end[1]), size) : size;
      selected = [Math.min(i === selection.start[0] ? pointAt(line, selection.start[1]) : 0, to), to];
    }
    const text = quoteLine(line, selected);
    return text === "" ? ">" : `> ${text}`;
  });
  const body = (kept: number): string => {
    const dropped = quoteLines.length - kept;
    return [...quoted.slice(0, kept), ...(dropped > 0 ? [`> … (+${dropped} lines)`] : [])].join("\n");
  };
  let kept = Math.min(quoted.length, QUOTE_LINES_MAX);
  while (kept > 0 && Array.from(body(kept)).length > SELECTION_QUOTE_MAX) kept--;
  return `> ${comment.label}:${linesText(comment.lines)}\n${body(kept)}`.replace(/\n$/, "");
}

function startOf(comment: FileComment): [number, number] {
  return comment.selection?.start ?? [-1, -1];
}

/**
 * The order comments are sent in: files by when their earliest existing comment was made, within
 * a file by first line, then selection start (a whole-line comment first), then creation.
 */
export function sortFileComments(comments: readonly FileComment[]): FileComment[] {
  const first = new Map<string, number>();
  for (const { path, created } of comments) first.set(path, Math.min(first.get(path) ?? created, created));
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) return first.get(a.path)! - first.get(b.path)! || (a.path < b.path ? -1 : 1);
    const [sa, sb] = [startOf(a), startOf(b)];
    return a.lines[0] - b.lines[0] || sa[0] - sb[0] || sa[1] - sb[1] || a.created - b.created;
  });
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function isLineRange(value: unknown): value is LineRange {
  return Array.isArray(value) && value.length === 2 && isCount(value[0]) && isCount(value[1]) && value[0] >= 1 && value[1] >= value[0];
}

function isSelectionEnd(value: unknown, lines: number): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isCount(value[0]) && isCount(value[1]) && value[0] >= 0 && value[0] < lines && value[1] >= 0;
}

function isSelection(value: unknown, lines: number): value is FileSelection {
  if (typeof value !== "object" || value === null) return false;
  const { text, start, end } = value as Record<string, unknown>;
  if (typeof text !== "string" || !isSelectionEnd(start, lines) || !isSelectionEnd(end, lines)) return false;
  return start[0] < end[0] || (start[0] === end[0] && start[1] <= end[1]);
}

/**
 * Whether a stored value is a file comment this module can place and quote (storage may hold anything). A `point` that
 * is not one (`isCommentPoint`) is removed from the entry, which is kept: its pin goes after the end of its text.
 */
export function isFileComment(value: unknown): value is FileComment {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (c.kind !== "file" || c.view !== "code" && c.view !== "preview") return false;
  if ("point" in c && !isCommentPoint(c.point)) delete c.point;
  if (typeof c.id !== "string" || typeof c.anchor !== "string" || typeof c.path !== "string" || typeof c.label !== "string" || typeof c.comment !== "string") return false;
  if (typeof c.created !== "number" || !Number.isFinite(c.created)) return false;
  if (!isLineRange(c.lines) || !isStrings(c.source) || !isStrings(c.quoteLines)) return false;
  if (c.source.length !== c.lines[1] - c.lines[0] + 1) return false;
  return c.selection === undefined || isSelection(c.selection, c.quoteLines.length);
}
