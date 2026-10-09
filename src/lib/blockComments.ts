import { createContext, useSyncExternalStore } from "react";
import { isSlashCommand, MAX_COMPOSER_CHARS, SELECTION_QUOTE_MAX } from "./compose.ts";
import { fileAnchor, fileCommentAt, fileQuote, isFileComment, sortFileComments, type FileComment, type FileTarget, type LineRange } from "./fileComments.ts";
import { isCommentPoint, type CommentPoint } from "./commentPins.ts";
import type { InlineNode, ListBlock, MarkdownBlock } from "./markdown.ts";

/**
 * Comments on single blocks of an agent's final reply. This module owns what a comment is: how a
 * block is anchored, where it sits in reading order, which form of it is kept, and how the
 * comments travel in the next message. The chat and the composer only consume it.
 */

/** Where a rendered reply part sits: made by `replyPart`, read only by this module. */
export interface ReplyPart {
  /** `paneStorageId(machineId, paneId)`: comments belong to one pane */
  owner: string;
  /** the turn's timestamp, or its index in the transcript when it has none */
  turnKey: string;
  /** index of the final-answer part within the turn */
  part: number;
  /** the turn's time in ms; null when it has none, or none that reads as a time */
  turnTime: number | null;
}

/**
 * The reply part `part` of the turn at `index` with timestamp `ts`. A turn without a timestamp
 * (a transcript entry without a time) is anchored by its index, which
 * can later name another block: `save` keeps the earlier comment apart instead of overwriting it.
 */
export function replyPart(owner: string, ts: string | null, index: number, part: number): ReplyPart {
  const time = ts === null ? Number.NaN : Date.parse(ts);
  return { owner, turnKey: ts ?? String(index), part, turnTime: Number.isFinite(time) ? time : null };
}

/** A block that can carry a comment. */
export interface CommentTarget {
  /**
   * `${turnKey}:${part}:${path}`, e.g. "2026-10-03T10:12:00Z:0:3.1". A stored comment whose block
   * was replaced under it carries `${anchor}~${id}` instead (see `save`).
   */
  anchor: string;
  /** the turn's time in ms, or null: a comment then takes the time it was written */
  turnTime: number | null;
  /** the reply part, then the path to the block in it */
  position: number[];
  /** the block as kept with the comment; a list item is a one-item list without nested blocks */
  block: MarkdownBlock;
  /**
   * Set for a comment on a selection (see `selectionTarget`): the selected text, normalised, and
   * its offsets in the plain text of the part the selection starts in. `end` is clamped to that
   * part's text when the selection runs on into later parts; `until` is then where it ends.
   */
  quote?: { text: string; start: number; end: number; until?: SelectionEnd };
  /**
   * Where the comment was made: a block clicked, or a selection a mouse dragged, where the pointer was, as fractions of
   * its text's box. Its pin's tip goes there; without one, after the end of its text. Not part of what names the
   * comment: the same block clicked elsewhere opens the same comment, its point unchanged.
   */
  point?: CommentPoint;
}

/**
 * The last part a selection over several parts of one reply reaches: its anchor and its block as
 * kept (as `CommentTarget.block`), and the offset in its plain text where the selection ends. The
 * parts between the first and this one are covered whole.
 */
export interface SelectionEnd {
  anchor: string;
  block: MarkdownBlock;
  end: number;
}

export interface BlockComment {
  /** absent on entries stored before file comments existed: those are reply comments too */
  kind?: "reply";
  id: string;
  anchor: string;
  /**
   * Reading order, compared element by element, shorter first on a tie: the turn's time (or when
   * the comment was written, one unit for both), then `position`. The order comments are sent in.
   */
  order: number[];
  block: MarkdownBlock;
  comment: string;
  /** a selection comment: the quoted text (`CommentTarget.quote.text`); a comment without it quotes its block */
  quote?: string;
  /** a selection comment: `[start, end]` of the selection in its part's plain text */
  range?: [number, number];
  /** a selection comment over several parts: the part it ends in (`CommentTarget.quote.until`) */
  until?: SelectionEnd;
  /** where its pin points (`CommentTarget.point`); absent: after the end of its text */
  point?: CommentPoint;
}

/** What a pane keeps and sends: a comment on a block of an agent's reply, or on lines of a file. */
export type PaneComment = BlockComment | FileComment;

/** A reply comment (a stored entry without `kind` is one). */
export function isReplyComment(comment: PaneComment): comment is BlockComment {
  return comment.kind !== "file";
}

/** Most characters a quoted block takes in the outgoing message, the trailing "…" included. */
export const QUOTE_MAX = 80;

/**
 * The target for a rendered block. `path` locates it inside the reply part (list items add their
 * index). With `item` given, `block` is a list and the target is that one item.
 */
export function blockTarget(reply: ReplyPart, path: number[], block: MarkdownBlock, item?: number): CommentTarget {
  return {
    anchor: partAnchor(reply, path),
    turnTime: reply.turnTime,
    position: [reply.part, ...path],
    block: item === undefined ? block : itemBlock(block as ListBlock, item),
  };
}

/** The anchor of the part at `path` in `reply`: `${turnKey}:${part}:${path}`, the path dotted. */
export function partAnchor(reply: ReplyPart, path: readonly number[]): string {
  return `${reply.turnKey}:${reply.part}:${path.join(".")}`;
}

/** A reply's commentable parts by anchor, each with its target and its place in document order. */
export type PartLookup = ReadonlyMap<string, { target: CommentTarget; index: number }>;

/**
 * The commentable parts of the reply part `reply` that renders `blocks`, in document order, as
 * Markdown.tsx renders them: every block but a rule and a list, every list item (its own words,
 * then its nested blocks), and nothing inside a blockquote, which is one part.
 */
export function replyParts(reply: ReplyPart, blocks: readonly MarkdownBlock[]): PartLookup {
  const parts = new Map<string, { target: CommentTarget; index: number }>();
  const add = (target: CommentTarget): void => { parts.set(target.anchor, { target, index: parts.size }); };
  const walk = (list: readonly MarkdownBlock[], path: readonly number[]): void => {
    list.forEach((block, index) => {
      const at = [...path, index];
      if (block.type === "list") {
        block.items.forEach((item, n) => {
          add(blockTarget(reply, [...at, n], block, n));
          if (item.blocks !== undefined) walk(item.blocks, [...at, n]);
        });
      } else if (block.type !== "hr") add(blockTarget(reply, at, block));
    });
  };
  walk(blocks, []);
  return parts;
}

// Defined in compose.ts so fileComments.ts can share it without importing this module (no cycle).
export { SELECTION_QUOTE_MAX };

/** `text` as quoted: trimmed, runs of spaces and tabs collapsed, line breaks kept, cut by code points at `SELECTION_QUOTE_MAX`. */
function normalizeSelection(text: string): string {
  const normal = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  const chars = Array.from(normal);
  return chars.length <= SELECTION_QUOTE_MAX ? normal : `${chars.slice(0, SELECTION_QUOTE_MAX - 1).join("")}…`;
}

/**
 * The target for the selection `start`–`end` of `text` in `part` (the target of the part's block).
 * `start` and `end` are offsets in the part's plain text, `end` clamped to it when the selection
 * runs on. Each selection is its own anchor, and reading order inside the part follows `start`.
 * The position gets `-1, start`: a list item's nested blocks add child indexes (0, 1, …) after the
 * item's path, so `-1` puts the item's own selections before them whatever `start` is, and a
 * comment on the whole part (shorter) stays first.
 *
 * A selection that runs on over later parts of the reply, up to `end` in the text of the part
 * `until` names, is still one comment, placed by where it starts: `text` is all of it, `end` the
 * first part's text end, and its anchor `${part}@${start}-${path of the last part}:${end there}`.
 */
export function selectionTarget(part: CommentTarget, text: string, start: number, end: number, until?: { target: CommentTarget; end: number }): CommentTarget {
  const last: SelectionEnd | null = until === undefined || until.target.anchor === part.anchor ? null : { anchor: until.target.anchor, block: until.target.block, end: until.end };
  return {
    anchor: last === null ? `${part.anchor}@${start}-${end}` : `${part.anchor}@${start}-${last.anchor.slice(last.anchor.lastIndexOf(":") + 1)}:${last.end}`,
    turnTime: part.turnTime,
    position: [...part.position, -1, start],
    block: part.block,
    quote: { text: normalizeSelection(text), start, end, ...(last === null ? {} : { until: last }) },
  };
}

/** The target a stored comment was written on, to edit it again where its block is not rendered. */
export function commentTarget(comment: BlockComment): CommentTarget {
  const [turnTime, ...position] = comment.order;
  const target: CommentTarget = { anchor: comment.anchor, turnTime: turnTime ?? null, position, block: comment.block };
  if (comment.quote !== undefined && comment.range !== undefined) {
    target.quote = { text: comment.quote, start: comment.range[0], end: comment.range[1], ...(comment.until === undefined ? {} : { until: comment.until }) };
  }
  if (comment.point !== undefined) target.point = comment.point;
  return target;
}

/** Item `index` of `list` as a one-item list: it keeps its number, not its nested blocks (they have their own targets). */
function itemBlock(list: ListBlock, index: number): ListBlock {
  // a task item keeps its box, so the editor's quote shows it
  const { content, checked } = list.items[index]!;
  const item = checked === undefined ? { content } : { content, checked };
  return list.ordered
    ? { type: "list", ordered: true, start: (list.start ?? 1) + index, items: [item] }
    : { type: "list", ordered: false, items: [item] };
}

/** The text of inline nodes with their markup dropped: a link or emphasis reads as its words. */
function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => "value" in node ? node.value : inlineText(node.children)).join("");
}

/** The plain text of a block, without markup: what is quoted, and what tells two blocks apart. */
export function blockContent(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph": return block.lines.map(inlineText).join("\n");
    case "heading": return inlineText(block.content);
    case "list": return block.items.map((item) => inlineText(item.content)).join("\n");
    case "blockquote": return block.blocks.map(blockContent).filter((text) => text !== "").join("\n");
    case "code":
    case "math": return block.value;
    case "table": return [block.header, ...block.rows].map((row) => row.map(inlineText).join(" | ")).join("\n");
    case "hr": return "";
  }
}

/** One line of at most `max` characters, cut by code points so an emoji is never halved. */
export function quoteFor(content: string, max = QUOTE_MAX): string {
  const line = content.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

/** Compares two `BlockComment.order` values element by element; on a tie the shorter one comes first. */
function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** A copy of `comments` in reading order. */
function sortComments(comments: readonly BlockComment[]): BlockComment[] {
  return [...comments].sort((a, b) => compareOrder(a.order, b.order));
}

/** A copy of `comments` in the order they are listed and sent in: reply comments in reading order, then file comments (`sortFileComments`). */
function sortPaneComments(comments: readonly PaneComment[]): PaneComment[] {
  return [...sortComments(comments.filter(isReplyComment)), ...sortFileComments(comments.filter((c): c is FileComment => !isReplyComment(c)))];
}

/** The anchor of the part a comment starts in; null for one moved off its anchor by a replaced part (`~id`). */
function firstAnchor(comment: BlockComment): string | null {
  // a block comment's anchor is its part's; a moved one's (`${anchor}~${id}`) names no part
  if (comment.range === undefined) return comment.anchor;
  const at = comment.anchor.lastIndexOf("@");
  return at < 0 || comment.anchor.includes("~", at) ? null : comment.anchor.slice(0, at);
}

type RenderedPart = { target: CommentTarget; index: number };

/**
 * The rendered parts a comment covers: the one it starts in, written on the part as it is now, and
 * the one it ends in. That is its `until` part when that is rendered after the first with the block
 * it was written on, else the first part again (the reply got shorter or changed there). Null when
 * its first part is not rendered as it was written.
 */
function coverage(comment: BlockComment, parts: PartLookup): { first: RenderedPart; last: RenderedPart } | null {
  const anchor = firstAnchor(comment);
  const first = anchor === null ? undefined : parts.get(anchor);
  if (first === undefined || !belongsTo(comment, first.target)) return null;
  const { until } = comment;
  const last = until === undefined ? undefined : parts.get(until.anchor);
  const reached = last !== undefined && last.index > first.index && blockContent(last.target.block) === blockContent(until!.block);
  return { first, last: reached ? last : first };
}

/**
 * The text of a part one comment covers: offsets in the part's plain text, `end` null for the
 * part's end. A comment on the whole part covers all of it.
 */
export interface PartSegment {
  comment: BlockComment;
  start: number;
  end: number | null;
}

/**
 * Every comment that touches the rendered `part` of the reply `parts`, with the text it covers
 * there, in reading order: a comment on the part all of it, a selection inside the part its range,
 * and one over several parts its start to the part's end in the first, the parts between whole,
 * and up to its end in the last. Where its last part is not rendered as written, it is clamped to
 * its first part (see `coverage`).
 */
export function partSegments(comments: readonly PaneComment[], part: CommentTarget, parts: PartLookup): PartSegment[] {
  const at = parts.get(part.anchor);
  if (at === undefined) return [];
  const segments: PartSegment[] = [];
  for (const comment of sortComments(comments.filter(isReplyComment))) {
    const covered = coverage(comment, parts);
    if (covered === null || at.index < covered.first.index || at.index > covered.last.index) continue;
    const spans = covered.last !== covered.first;
    const start = at === covered.first ? comment.range?.[0] ?? 0 : 0;
    const end = at === covered.last && spans ? comment.until!.end : at === covered.first && !spans ? comment.range?.[1] ?? null : null;
    segments.push({ comment, start, end });
  }
  return segments;
}

/** One line of at most `max` characters for a quote shown in the interface (see `quoteFor`). */
export function quoteExcerpt(text: string, max = 32): string {
  return quoteFor(text, max);
}

/**
 * Where the text range `start`–`end` of a part lies in its text nodes, whose lengths are given in
 * order: node indexes and offsets for a DOM range. A boundary between nodes belongs to the node
 * holding the selected character (the next one for `start`, the earlier for `end`), so empty nodes
 * are skipped. Null when the range is not inside the text.
 */
export function textRange(lengths: readonly number[], start: number, end: number): { startNode: number; startOffset: number; endNode: number; endOffset: number } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || lengths.length === 0) return null;
  if (end > lengths.reduce((sum, length) => sum + length, 0)) return null;
  // the node holding the character after `at` (as a start) or before it (as an end)
  const locate = (at: number, asEnd: boolean) => {
    let from = 0;
    for (let node = 0; node < lengths.length; node++) {
      const to = from + lengths[node]!;
      if (asEnd ? at > from && at <= to : at >= from && at < to) return { node, offset: at - from };
      from = to;
    }
    return null;
  };
  const first = locate(start, false);
  const last = locate(end, true);
  if (start === end) {
    const at = first ?? last ?? { node: 0, offset: 0 };
    return { startNode: at.node, startOffset: at.offset, endNode: at.node, endOffset: at.offset };
  }
  if (!first || !last) return null;
  return { startNode: first.node, startOffset: first.offset, endNode: last.node, endOffset: last.offset };
}

/** The quote a comment sends: a file comment's lines (`fileQuote`), else its selection, every line prefixed (a blank line inside is a bare ">"), or its block cut to one line. */
function quoteText(comment: PaneComment): string {
  if (!isReplyComment(comment)) return fileQuote(comment);
  if (comment.quote === undefined) return `> ${quoteFor(blockContent(comment.block))}`;
  return comment.quote.split("\n").map((line) => line.trim() === "" ? ">" : `> ${line}`).join("\n");
}

/** The message for `comments` and `text`: each comment quotes its selection, block or lines, replies first in reading order, then file comments, and the typed text, unless blank, comes last. */
export function composeWithComments(comments: readonly PaneComment[], text: string): string {
  const entries = sortPaneComments(comments).map((c) => `${quoteText(c)}\n${c.comment.trim()}`);
  if (text.trim() !== "") entries.push(text);
  return entries.join("\n\n");
}

/**
 * Whether `text` has a line quoted as `composeWithComments` quotes: one starting with ">". A copy of
 * a queued message keeps only its text, so this is what tells that it may carry comments, and must
 * reach an agent only (never a shell, which would take the "> " for a redirect).
 */
export function hasQuotedLine(text: string): boolean {
  return /^>/m.test(text);
}

/** Why comments stay in the composer instead of going with a message. */
export type CommentsHeldBy = "no-agent" | "answer" | "command";

/**
 * What the composer sends for `text` with these comments: each comment quotes its block, in
 * reading order, and the typed text follows. The comments wait for a later message when:
 * - no agent runs in the pane (`agent: false`): the text is typed into whatever does, a shell
 *   perhaps, which would run each line, take the quote's "> " for a redirect that empties a
 *   file, and expand `$(…)` in the quoted reply;
 * - it answers a question the agent has open (`answering`), read as an option or a reply;
 * - it is a slash command, which the agent would not read as one with comments in front.
 * With comments turned off the store lists none (`BlockCommentStore.setEnabled`), so there are none to send or hold.
 */
export function outgoingMessage(comments: readonly PaneComment[], text: string, { answering = false, agent = true }: { answering?: boolean; agent?: boolean } = {}): {
  message: string;
  /** the comments `message` carries, in the order they are composed in */
  sent: readonly PaneComment[];
  /** their ids: the comments leave the composer once the send is acknowledged */
  sentIds: string[];
  /** why comments that exist stay out of `message`; null when they go, or there are none */
  commentsHeld: CommentsHeldBy | null;
  tooLong: boolean;
  sendable: boolean;
} {
  const held: CommentsHeldBy | null = !agent ? "no-agent" : answering ? "answer" : isSlashCommand(text) ? "command" : null;
  const sent = held !== null ? [] : sortPaneComments(comments);
  const message = composeWithComments(sent, text);
  const tooLong = message.length > MAX_COMPOSER_CHARS;
  return { message, sent, sentIds: sent.map((c) => c.id), commentsHeld: comments.length > 0 ? held : null, tooLong, sendable: message.trim() !== "" && !tooLong };
}

// every block type markdown.ts knows: a new one fails to compile here rather than its comments
// vanishing on load
const BLOCK_TYPES: Record<string, true> = { math: true, heading: true, paragraph: true, list: true, blockquote: true, code: true, table: true, hr: true } satisfies Record<MarkdownBlock["type"], true>;

/** Has a known block `type`; whether the rest reads is `isBlockComment`'s question. */
export function isMarkdownBlock(value: unknown): value is MarkdownBlock {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(BLOCK_TYPES, type);
}

export const BLOCK_COMMENTS_PREFIX = "herdr-web-ui:block-comments:";
type CommentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
/** A fresh comment id; a time-and-random fallback where `crypto.randomUUID` is missing (an insecure origin). */
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * An entry from storage that renders and quotes without throwing: hand-edited or older data is dropped. A `point` that
 * is not one (`isCommentPoint`) is removed from the entry, which is kept: its pin goes after the end of its text.
 */
export function isBlockComment(value: unknown): value is BlockComment {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<BlockComment>;
  if ("point" in entry && !isCommentPoint(entry.point)) delete entry.point;
  if (typeof entry.id !== "string" || typeof entry.anchor !== "string" || typeof entry.comment !== "string") return false;
  if (!Array.isArray(entry.order) || !entry.order.every(Number.isFinite) || !isMarkdownBlock(entry.block)) return false;
  // a selection comment has both a quote and a range, a block comment neither
  if ((entry.quote === undefined) !== (entry.range === undefined)) return false;
  if (entry.quote !== undefined && (typeof entry.quote !== "string" || entry.quote === "")) return false;
  const range: unknown = entry.range;
  if (range !== undefined) {
    const pair: unknown[] | null = Array.isArray(range) && range.length === 2 ? range : null;
    if (pair === null || !pair.every(Number.isInteger) || (pair[0] as number) < 0 || (pair[0] as number) > (pair[1] as number)) return false;
  }
  // a selection over several parts also names the part it ends in
  const until: unknown = entry.until;
  if (until !== undefined) {
    if (entry.quote === undefined || typeof until !== "object" || until === null) return false;
    const end = until as Partial<SelectionEnd>;
    if (typeof end.anchor !== "string" || end.anchor === "" || !isMarkdownBlock(end.block) || !Number.isInteger(end.end) || end.end! < 0) return false;
  }
  try { return typeof blockContent(entry.block) === "string" && (entry.until === undefined || typeof blockContent(entry.until.block) === "string"); } catch { return false; }
}

/** A stored entry of either kind that reads without throwing; an entry without `kind` is a reply comment. */
export function isPaneComment(value: unknown): value is PaneComment {
  if (typeof value !== "object" || value === null) return false;
  const { kind } = value as { kind?: unknown };
  if (kind === "file") return isFileComment(value);
  return (kind === undefined || kind === "reply") && isBlockComment(value);
}

/** The empty list of a pane's comments. */
const NONE: readonly never[] = [];

/**
 * Comments per pane (`owner`), kept in localStorage like the held-message queue. Snapshots keep
 * their identity until their own data changes, so `useSyncExternalStore` readers re-render only
 * for the comments they show.
 *
 * The store owns the Comments setting's effect on what is read (`setEnabled`): while it is off, every pane has no
 * comments to show, walk or send (`list`, `get`, `useBlockComments`, `usePartTouched`), whatever is stored. Settings do
 * not follow another tab, which may still have comments on and store new ones after this one turned them off: those
 * stay stored, untouched, and `countAll` and `clearAll` still see them.
 */
export class BlockCommentStore {
  private lists = new Map<string, readonly PaneComment[]>();
  private enabled = true;
  /** the raw value last read or written, so `refresh` notices only real changes */
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private storage: () => CommentStorage = () => window.localStorage, private now: () => number = Date.now) {}

  /** For `useSyncExternalStore`: `listener` runs on every change to any pane's comments. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** True when the last write for `owner` failed: its comments live only in memory and are lost on reload. */
  isUnsaved(owner: string): boolean { return this.unsaved.has(owner); }

  /**
   * Applies the Comments setting (on by default): off, `list` and `get` find none; storage and the write paths are
   * unaffected. A change tells subscribers once.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.notify();
  }

  /**
   * The pane's comments in sending order (`sortPaneComments`); none while comments are turned off (`setEnabled`).
   * Entries that do not read as comments, and a second comment on an anchor, are dropped.
   */
  list(owner: string): readonly PaneComment[] {
    return this.enabled ? this.stored(owner) : NONE;
  }

  /** The pane's stored comments in sending order, whatever the setting: read from storage on first use and cached after. */
  private stored(owner: string): readonly PaneComment[] {
    const cached = this.lists.get(owner);
    if (cached) return cached;
    let raw: string | null = null;
    try { raw = this.storage().getItem(BLOCK_COMMENTS_PREFIX + owner); } catch { /* private mode */ }
    let comments: PaneComment[] = [];
    try {
      const data = JSON.parse(raw ?? "null");
      if (data?.version === 1 && Array.isArray(data.comments)) {
        const anchors = new Set<string>();
        comments = data.comments.filter((entry: unknown): entry is PaneComment => {
          if (!isPaneComment(entry) || anchors.has(entry.anchor)) return false;
          anchors.add(entry.anchor);
          return true;
        });
      }
    } catch { /* unreadable: start empty */ }
    const sorted = sortPaneComments(comments);
    this.saved.set(owner, raw);
    this.lists.set(owner, sorted);
    return sorted;
  }

  /** The comment on this very block (and end part): none when its anchor holds one on a block that was replaced. */
  get(owner: string, target: CommentTarget): BlockComment | undefined {
    const comment = this.list(owner).find((c): c is BlockComment => isReplyComment(c) && c.anchor === target.anchor);
    return comment !== undefined && isWrittenOn(comment, target) ? comment : undefined;
  }

  /**
   * One comment per anchor; a blank comment removes it. A changed text gets a new id: a send on
   * its way carries the old text, and its acknowledgement must not take the edit with it. A
   * comment on another block that used to sit at this anchor (or, over several parts, that ended
   * on another block) is kept, moved off the anchor.
   */
  save(owner: string, target: CommentTarget, comment: string): void {
    // a selection with nothing to quote is no selection: not even a blank save changes a comment
    if (target.quote && target.quote.text.trim() === "") return;
    this.refresh(owner);
    const text = comment.trim();
    let comments = this.stored(owner);
    let existing = comments.find((c): c is BlockComment => isReplyComment(c) && c.anchor === target.anchor);
    if (existing && !isWrittenOn(existing, target)) {
      const stale = existing;
      comments = comments.map((c) => c === stale ? { ...c, anchor: `${c.anchor}~${c.id}` } : c);
      existing = undefined;
    }
    if (text === "") {
      if (existing) this.write(owner, comments.filter((c) => c !== existing));
      else if (comments !== this.stored(owner)) this.write(owner, comments);
      return;
    }
    if (existing?.comment === text) return;
    // an edit keeps its place: a turn without a time placed it by when it was first written. And its pin's point, or
    // having none: the block clicked again elsewhere is the same comment
    const point = existing === undefined ? target.point : existing.point;
    const next = commentOn({ ...target, point }, newId(), existing?.order ?? [target.turnTime ?? this.now(), ...target.position], text);
    this.write(owner, existing ? comments.map((c) => c === existing ? next : c) : [...comments, next]);
  }

  /**
   * One file comment per place; a blank comment removes it. The comment written on `target` is
   * found by `fileCommentAt`: an edit by its stored anchor, a new comment by the place it is on now,
   * since a move may have left a comment's anchor on other lines. A new comment whose place reads as
   * an anchor another comment kept that way takes `~id` after it, as the chat's moved comments do:
   * stored anchors stay unique. A changed text gets a new id, for the reason `save` gives. A new
   * comment is stamped with the time it is written, an edit keeps it: it decides which file's
   * comments are sent first. Returns the id of the comment now kept there, null when there is none.
   */
  saveFile(owner: string, target: FileTarget, comment: string): string | null {
    this.refresh(owner);
    const text = comment.trim();
    const comments = this.stored(owner);
    const existing = fileCommentAt(comments.filter((c): c is FileComment => !isReplyComment(c)), target);
    if (text === "") {
      if (existing) this.write(owner, comments.filter((c) => c !== existing));
      return null;
    }
    if (existing?.comment === text) return existing.id;
    const id = newId();
    const wanted = existing?.anchor ?? target.anchor ?? fileAnchor(target);
    const anchor = existing === undefined && comments.some((c) => c.anchor === wanted) ? `${wanted}~${id}` : wanted;
    // an edit keeps its pin's point, or having none, as `save` does
    const { point: _point, ...rest } = target;
    const point = existing === undefined ? target.point : existing.point;
    const next: FileComment = { ...rest, kind: "file", id, anchor, created: existing?.created ?? this.now(), comment: text, ...(point === undefined ? {} : { point }) };
    this.write(owner, existing ? comments.map((c) => c === existing ? next : c) : [...comments, next]);
    return next.id;
  }

  /**
   * Moves a file comment to `lines`, where its text was found again. It keeps its old anchor when
   * another comment already holds the new one. An unknown id, or the lines it already has, is no change.
   */
  moveFile(owner: string, id: string, lines: LineRange): void {
    this.refresh(owner);
    const comments = this.stored(owner);
    const moved = comments.find((c): c is FileComment => !isReplyComment(c) && c.id === id);
    if (moved === undefined || (moved.lines[0] === lines[0] && moved.lines[1] === lines[1])) return;
    const anchor = fileAnchor({ ...moved, lines });
    const taken = comments.some((c) => c.id !== id && c.anchor === anchor);
    const next: FileComment = { ...moved, lines, anchor: taken ? moved.anchor : anchor };
    this.write(owner, comments.map((c) => c === moved ? next : c));
  }

  /** Removes the comments with these ids, as a send acknowledges them; an id already gone is no change. */
  remove(owner: string, ids: readonly string[]): void {
    this.refresh(owner);
    const comments = this.stored(owner);
    const kept = comments.filter((c) => !ids.includes(c.id));
    if (kept.length !== comments.length) this.write(owner, kept);
  }

  /** How many comments are stored over every pane, also on panes only another tab wrote and ones that failed to save. */
  countAll(): number {
    let count = 0;
    for (const owner of this.owners()) {
      this.refresh(owner);
      count += this.stored(owner).length;
    }
    return count;
  }

  /** Deletes every pane's comments, stored and cached, and tells subscribers once. A storage that throws still loses the cached ones. */
  clearAll(): void {
    try {
      const storage = this.storage();
      for (const key of this.storedKeys(storage)) storage.removeItem(key);
    } catch { /* private mode */ }
    this.lists.clear();
    this.saved.clear();
    this.unsaved.clear();
    this.notify();
  }

  /** Every pane with comments in storage, plus the ones whose last write failed. */
  private owners(): Set<string> {
    const owners = new Set(this.unsaved);
    try {
      for (const key of this.storedKeys(this.storage())) owners.add(key.slice(BLOCK_COMMENTS_PREFIX.length));
    } catch { /* private mode */ }
    return owners;
  }

  /** The comments keys in `storage`, collected first so removing them does not shift the index. */
  private storedKeys(storage: CommentStorage): string[] {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(BLOCK_COMMENTS_PREFIX)) keys.push(key);
    }
    return keys;
  }

  /** Re-read storage another tab may have written; notify only when it changed. */
  refresh(owner: string): void {
    if (this.unsaved.has(owner) || !this.lists.has(owner)) return;
    try {
      const raw = this.storage().getItem(BLOCK_COMMENTS_PREFIX + owner);
      if (raw === this.saved.get(owner)) return;
    } catch { return; }
    this.lists.delete(owner);
    this.stored(owner);
    this.notify();
  }

  /** Caches and stores `owner`'s comments, the key removed with the last one; a failed write marks them unsaved. */
  private write(owner: string, comments: readonly PaneComment[]): void {
    this.lists.set(owner, sortPaneComments(comments));
    try {
      const key = BLOCK_COMMENTS_PREFIX + owner;
      const raw = comments.length ? JSON.stringify({ version: 1, comments }) : null;
      if (raw === null) this.storage().removeItem(key);
      else this.storage().setItem(key, raw);
      this.saved.set(owner, raw);
      this.unsaved.delete(owner);
    } catch { this.unsaved.add(owner); }
    this.notify();
  }

  /** Tells every subscriber that some pane's comments changed. */
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The comment `text` written on `target`, as the store keeps it. */
function commentOn(target: CommentTarget, id: string, order: number[], text: string): BlockComment {
  const { quote } = target;
  const selection = quote ? { quote: quote.text, range: [quote.start, quote.end] as [number, number], ...(quote.until ? { until: quote.until } : {}) } : {};
  return { id, anchor: target.anchor, order, block: target.block, comment: text, ...selection, ...(target.point === undefined ? {} : { point: target.point }) };
}

/**
 * The comment `target` will hold once one is written, without an id or a text: what covers the
 * selection or the block clicked while its comment is being written (`partSegments` gives its text part by part).
 */
export function draftComment(target: CommentTarget): BlockComment {
  return commentOn(target, "", [target.turnTime ?? 0, ...target.position], "");
}

/** True when the stored comment belongs to this rendered block (the one it starts in): the reply may have changed under its anchor. */
function belongsTo(comment: BlockComment, target: CommentTarget): boolean {
  return blockContent(comment.block) === blockContent(target.block);
}

/**
 * True when the stored comment is the one `target` names, for the store's one comment per anchor:
 * written on the same first block and, for a selection over several parts, ending on the same block
 * too (both over several parts, or neither). Anything else is a comment on a reply that changed.
 */
function isWrittenOn(comment: BlockComment, target: CommentTarget): boolean {
  if (!belongsTo(comment, target)) return false;
  const end = target.quote?.until;
  if (comment.until === undefined || end === undefined) return comment.until === end;
  return blockContent(comment.until.block) === blockContent(end.block);
}

export const blockComments = new BlockCommentStore();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(BLOCK_COMMENTS_PREFIX)) blockComments.refresh(event.key.slice(BLOCK_COMMENTS_PREFIX.length));
  });
}

const noSubscription = () => () => {};

/**
 * The pane's comments in sending order, re-rendering when they change; none while comments are turned off
 * (`BlockCommentStore.setEnabled`). The server snapshot is empty: a reply rendered to a string (tests) shows no comments.
 */
export function useBlockComments(owner: string): readonly PaneComment[] {
  return useSyncExternalStore(blockComments.subscribe, () => blockComments.list(owner), () => NONE);
}

/**
 * Whether a comment of `owner` covers some of the rendered part `target` of the reply `parts` (`partSegments`):
 * its own, or one over several parts that reaches it. A boolean, so a part re-renders only when that answer
 * changes. No target: false, nothing to read and no subscription; comments turned off: false (`setEnabled`).
 */
export function usePartTouched(owner: string, target: CommentTarget | null, parts: PartLookup | null): boolean {
  const watched = target !== null && parts !== null;
  const read = (): boolean => watched && target !== null && parts !== null && partSegments(blockComments.list(owner), target, parts).length > 0;
  return useSyncExternalStore(watched ? blockComments.subscribe : noSubscription, read, () => false);
}

/** The reply part a `Markdown` renders; only a final answer that is not live provides one. */
export const BlockCommentContext = createContext<ReplyPart | null>(null);
