import type { RepoDiffScope } from "../../shared/protocol.ts";

/** Coordinates are evidence, never sufficient identity by themselves. */
export type ReviewTarget =
  | { kind: "reply"; turn: string; order: number; part: number; block: string; blockStart: number; start: number; end: number; evidence: string }
  | { kind: "source"; path: string; start: number; end: number; evidence: string }
  | { kind: "diff"; repository: string; path: string; scope: RepoDiffScope; base: string | null; head?: string | null; fingerprint: string; side: "old" | "new"; start: number; end: number; evidence: string };
export interface ReviewNote {
  /** Stable editor identity; id changes on every saved edit. */
  key: string;
  id: string;
  owner: string;
  created: number;
  target: ReviewTarget;
  quote: string;
  text: string;
}
export interface ReviewDraft { id: string; owner: string; key: string | null; target: ReviewTarget; quote: string; original: string; text: string }
const STORAGE_KEY = "herdr-web-ui:review-notes";
export const REVIEW_TEXT_LIMIT = 8000;
export const REVIEW_CONTEXT_LIMIT = 16384;
export const REVIEW_QUOTE_LIMIT = 2000;
export const reviewVersionId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const draftDirty = (draft: ReviewDraft | null): boolean => draft !== null && draft.text !== draft.original;

type SourceRange = { start: number; end: number };
export const REVIEW_MARKER_LIMIT = 100;
/** One source split/index for all notes, with bounded comparison work. Undefined is unchecked,
 * never evidence of an outdated target. Exact coordinates still win over ambiguous relocation. */
export function sourceAnchorReader(source: string, complete: boolean, work = 8 * 1024 * 1024): (target: Extract<ReviewTarget, { kind: "source" }>) => SourceRange | null | undefined {
  const lines = source.split("\n");
  let positions: Map<string, number[]> | undefined;
  const relocated = new Map<string, SourceRange | null | undefined>();
  return (target) => {
    const needle = target.evidence.split("\n"), count = target.end - target.start + 1;
    if (count !== needle.length || target.start < 1) return null;
    if ((work -= target.evidence.length + 1) < 0) return undefined;
    if (target.end <= lines.length && needle.every((line, index) => lines[target.start - 1 + index] === line)) return { start: target.start, end: target.end };
    if (!complete || !target.evidence.trim()) return null;
    if (relocated.has(target.evidence)) return relocated.get(target.evidence);
    positions ??= new Map();
    if (positions.size === 0) for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const found = positions.get(line);
      if (found) found.push(index); else positions.set(line, [index]);
    }
    let pivot = 0;
    for (let index = 0; index < needle.length; index++) {
      if (!positions.has(needle[index]!)) { relocated.set(target.evidence, null); return null; }
      if (positions.get(needle[index]!)!.length < positions.get(needle[pivot]!)!.length) pivot = index;
    }
    let match: SourceRange | null = null;
    for (const position of positions.get(needle[pivot]!)!) {
      const start = position - pivot;
      if (start < 0 || start + count > lines.length) continue;
      let same = true;
      for (let index = 0; index < count; index++) {
        if ((work -= needle[index]!.length + 1) < 0) { relocated.set(target.evidence, undefined); return undefined; }
        if (lines[start + index] !== needle[index]) { same = false; break; }
      }
      if (same) {
        if (match) { relocated.set(target.evidence, null); return null; }
        match = { start: start + 1, end: start + count };
      }
    }
    relocated.set(target.evidence, match); return match;
  };
}
export function sourceAnchor(target: Extract<ReviewTarget, { kind: "source" }>, source: string, complete: boolean): SourceRange | null {
  return sourceAnchorReader(source, complete)(target) ?? null;
}
export function sameDiff(target: Extract<ReviewTarget, { kind: "diff" }>, shown: Omit<Extract<ReviewTarget, { kind: "diff" }>, "start" | "end" | "evidence" | "kind">): boolean {
  return target.repository === shown.repository && target.path === shown.path && target.scope === shown.scope && target.base === shown.base && (target.head ?? null) === (shown.head ?? null) && target.fingerprint === shown.fingerprint && target.side === shown.side;
}
export function replyAnchor(target: Extract<ReviewTarget, { kind: "reply" }>, turn: string, part: number, text: string): boolean {
  // Selection coordinates live inside this exact source block, checked when records are read.
  return target.turn === turn && target.part === part && text.slice(target.blockStart, target.blockStart + target.evidence.length) === target.evidence;
}
export function orderedNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  const earliest = new Map<string, number>();
  for (const note of notes) if (note.target.kind !== "reply") earliest.set(note.target.path, Math.min(earliest.get(note.target.path) ?? Infinity, note.created));
  return [...notes].sort((a, b) => {
    const x = a.target, y = b.target;
    if (x.kind === "reply" && y.kind === "reply") return x.order - y.order || x.part - y.part || x.start - y.start || a.created - b.created;
    if (x.kind === "reply" || y.kind === "reply") return x.kind === "reply" ? -1 : 1;
    return earliest.get(x.path)! - earliest.get(y.path)! || x.path.localeCompare(y.path) || x.start - y.start || a.created - b.created;
  });
}
export function reviewReference(target: ReviewTarget): string {
  if (target.kind === "reply") return `Agent reply (${target.turn}, part ${target.part + 1})`;
  const range = target.start === target.end ? String(target.start) : `${target.start}–${target.end}`;
  if (target.kind === "source") return `${target.path}, lines ${range}`;
  const comparison = target.scope === "all" ? `${target.base ?? "HEAD / empty tree"} versus working tree` : target.scope === "workspace" ? "index versus working tree" : target.scope === "staged" ? `${target.base ?? "HEAD / empty tree"} versus index` : `${target.base ?? "unknown base"} versus ${target.head ?? "unknown commit"}`;
  return `${target.repository.replace(/[\\/]+$/, "")}/${target.path}, ${target.side} side, lines ${range} (${comparison}; snapshot ${target.fingerprint})`;
}
export function composeReviewMessage(notes: readonly ReviewNote[], text: string, limit: number, status?: (key: string) => "current" | "outdated" | "unavailable"): string | null {
  const quoted = (value: string): string => value.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
  const blocks = orderedNotes(notes).map((note) => {
    const state = status?.(note.key);
    return `Review comment: ${reviewReference(note.target)}${state && state !== "current" ? ` (${state} target; last known location)` : ""}\n${quoted(note.quote)}\n\n${note.text}`;
  });
  if (text.trim()) blocks.push(text);
  const message = blocks.join("\n\n");
  return message.length <= limit ? message : null;
}
/** Slash commands, interactive answers and shells keep notes held. */
export function includeReviewNotes(text: string, agent: string | null, answering: boolean): boolean {
  return agent !== null && !answering && !text.trimStart().startsWith("/");
}
function validNote(value: unknown): value is ReviewNote {
  if (!value || typeof value !== "object") return false;
  const n = value as ReviewNote, target = n.target;
  if (typeof n.key !== "string" || typeof n.id !== "string" || typeof n.owner !== "string" || !Number.isFinite(n.created) || typeof n.text !== "string" || !n.text.trim() || n.text.length > REVIEW_TEXT_LIMIT || typeof n.quote !== "string" || n.quote.length > REVIEW_QUOTE_LIMIT || !target || typeof target.evidence !== "string" || target.evidence.length > REVIEW_CONTEXT_LIMIT || !Number.isInteger(target.start) || !Number.isInteger(target.end) || target.end < target.start) return false;
  if (target.kind === "reply") return typeof target.turn === "string" && typeof target.block === "string" && Number.isFinite(target.order) && Number.isInteger(target.part) && target.part >= 0 && Number.isInteger(target.blockStart) && target.blockStart >= 0 && target.start >= target.blockStart && target.end <= target.blockStart + target.evidence.length;
  if (target.start < 1 || typeof target.path !== "string" || target.end - target.start + 1 !== target.evidence.split("\n").length) return false;
  if (target.kind === "source") return true;
  return target.kind === "diff" && typeof target.repository === "string" && typeof target.fingerprint === "string" && target.fingerprint.length > 0 && (target.side === "old" || target.side === "new") && ["all", "workspace", "staged", "commit"].includes(target.scope) && (target.base === null || typeof target.base === "string") && (target.head === undefined || target.head === null || typeof target.head === "string");
}

/** Refresh-before-write is deliberately not a cross-tab transaction. Failed writes remain in memory. */
export class ReviewNotesStore {
  private notes: ReviewNote[] = [];
  private unsaved = new Map<string, ReviewNote | null>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private cacheSource: ReviewNote[] | null = null;
  private ownerCache = new Map<string, ReviewNote[]>();
  private availability = new Map<string, "current" | "outdated" | "unavailable">();
  private locations = new Map<string, SourceRange>();
  draft: ReviewDraft | null = null;
  listOwner: string | null = null;
  storageFailed = false;
  contextRefused = false;
  confirmDisable = false;
  composing = false;
  private storage: () => Storage | null;
  constructor(storage: () => Storage | null = () => typeof window === "undefined" ? null : window.localStorage) { this.storage = storage; }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = (): number => this.revision;
  private emit(): void { this.revision++; this.listeners.forEach((listener) => listener()); }
  refresh = (): void => {
    try {
      const storage = this.storage();
      if (storage === null) return;
      const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
      if (!Array.isArray(raw)) throw new Error("invalid notes");
      const next = raw.filter(validNote);
      for (const [key, note] of this.unsaved) { const index = next.findIndex((item) => item.key === key); if (index !== -1) next.splice(index, 1); if (note !== null) next.push(note); }
      if (JSON.stringify(next) !== JSON.stringify(this.notes)) { this.notes = next; this.trimAnnotations(); this.emit(); }
    } catch { this.storageFailed = true; }
  };
  private trimAnnotations(): void {
    const keys = new Set(this.notes.map((note) => note.key)), ids = new Set(this.notes.map((note) => note.id));
    for (const key of this.availability.keys()) if (!keys.has(key)) this.availability.delete(key);
    for (const id of this.locations.keys()) if (!ids.has(id)) this.locations.delete(id);
  }
  private persist(changed: readonly string[]): void {
    this.trimAnnotations();
    try {
      const storage = this.storage();
      if (storage === null) throw new Error("storage unavailable");
      storage.setItem(STORAGE_KEY, JSON.stringify(this.notes));
      this.unsaved.clear(); this.storageFailed = false;
    } catch {
      for (const key of changed) this.unsaved.set(key, this.notes.find((note) => note.key === key) ?? null);
      this.storageFailed = true;
    }
    this.emit();
  }
  read(owner?: string): ReviewNote[] {
    if (owner === undefined) return this.notes;
    if (this.cacheSource !== this.notes) { this.cacheSource = this.notes; this.ownerCache.clear(); }
    let notes = this.ownerCache.get(owner);
    if (!notes) { notes = this.notes.filter((note) => note.owner === owner); this.ownerCache.set(owner, notes); }
    return notes;
  }
  status(key: string): "current" | "outdated" | "unavailable" { return this.availability.get(key) ?? "unavailable"; }
  mark(key: string, status: "current" | "outdated" | "unavailable"): void { this.markAll([[key, status]]); }
  markAll(entries: Iterable<readonly [string, "current" | "outdated" | "unavailable"]>): void {
    const keys = new Set(this.notes.map((note) => note.key));
    let changed = false;
    for (const [key, status] of entries) {
      if (status === "unavailable" && !keys.has(key)) { changed = this.availability.delete(key) || changed; continue; }
      if (this.availability.get(key) !== status) { this.availability.set(key, status); changed = true; }
    }
    if (changed) this.emit();
  }
  guard = (): boolean => {
    if (!draftDirty(this.draft) && !this.composing) return true;
    if (typeof window !== "undefined") window.dispatchEvent(new Event("herdr-review-focus"));
    return false;
  };
  begin(owner: string, target: ReviewTarget, quote: string): boolean {
    if (!this.guard()) return false;
    if (target.evidence.length > REVIEW_CONTEXT_LIMIT) { this.contextRefused = true; this.listOwner = owner; this.emit(); return false; }
    this.contextRefused = false;
    this.draft = { id: reviewVersionId(), owner, key: null, target, quote: quote.slice(0, REVIEW_QUOTE_LIMIT), original: "", text: "" }; this.listOwner = null; this.emit(); return true;
  }
  edit(note: ReviewNote): boolean {
    if (!this.guard()) return false;
    this.contextRefused = false;
    this.draft = { id: reviewVersionId(), owner: note.owner, key: note.key, target: this.project(note).target, quote: note.quote, original: note.text, text: note.text }; this.listOwner = null; this.emit(); return true;
  }
  write(text: string): void { if (this.draft === null) return; this.draft = { ...this.draft, text: text.slice(0, REVIEW_TEXT_LIMIT) }; this.emit(); }
  composition(active: boolean): void { this.composing = active; this.emit(); }
  disableConfirmation(open: boolean): void { this.confirmDisable = open; this.emit(); }
  close(discard = false): boolean { if (!discard && !this.guard()) return false; this.draft = null; this.listOwner = null; this.composing = false; this.emit(); return true; }
  list(owner: string): boolean { if (!this.guard()) return false; this.draft = null; this.listOwner = owner; this.refresh(); this.emit(); return true; }
  save(): boolean {
    const draft = this.draft;
    if (this.composing || draft === null || (!draft.key && !draft.text.trim())) return false;
    this.refresh();
    const old = this.notes.find((note) => note.key === draft.key);
    const key = draft.key ?? reviewVersionId();
    this.notes = this.notes.filter((note) => note.key !== key);
    if (draft.text.trim()) this.notes.push({ key, id: reviewVersionId(), owner: draft.owner, created: old?.created ?? Date.now(), target: draft.target, quote: draft.quote, text: draft.text });
    this.draft = null; this.persist([key]); return true;
  }
  /** Verified coordinates belong to this tab's loaded source, never a storage write from a
   * viewer effect: two tabs may legitimately hold different snapshots of the same file. */
  project = (note: ReviewNote): ReviewNote => {
    const anchor = this.locations.get(note.id);
    return anchor && note.target.kind === "source" ? { ...note, target: { ...note.target, ...anchor } } : note;
  };
  reanchor(captured: readonly ReviewNote[], anchors: ReadonlyMap<string, SourceRange | null | undefined>): void {
    this.refresh();
    const versions = new Map(captured.map((note) => [note.key, note.id]));
    let changed = false;
    for (const note of this.notes) {
      const anchor = anchors.get(note.key), previous = this.locations.get(note.id);
      if (!anchor || note.target.kind !== "source" || versions.get(note.key) !== note.id || previous?.start === anchor.start && previous.end === anchor.end) continue;
      this.locations.set(note.id, anchor); changed = true;
    }
    if (changed) this.emit();
  }
  remove(key: string): void { this.refresh(); this.notes = this.notes.filter((note) => note.key !== key); if (this.draft?.key === key) { this.draft = null; this.composing = false; } this.persist([key]); }
  acknowledge(captured: readonly ReviewNote[]): void {
    this.refresh();
    const ids = new Set(captured.map((note) => note.id));
    const removed = this.notes.filter((note) => ids.has(note.id));
    this.notes = this.notes.filter((note) => !ids.has(note.id)); this.persist(removed.map((note) => note.key));
  }
  clear(): void { this.refresh(); const keys = this.notes.map((note) => note.key); this.notes = []; this.draft = null; this.listOwner = null; this.composing = false; this.persist(keys); }
}
export const reviewNotes = new ReviewNotesStore();
if (typeof window !== "undefined") {
  reviewNotes.refresh();
  window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY || event.key === null) reviewNotes.refresh(); });
  window.addEventListener("beforeunload", (event) => { if (draftDirty(reviewNotes.draft) || reviewNotes.storageFailed) event.preventDefault(); });
}
