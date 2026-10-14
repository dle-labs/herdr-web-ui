import type { RepoDiffScope } from "../../shared/protocol.ts";

/** Coordinates are evidence, never sufficient identity by themselves. */
export type ReviewTarget =
  | { kind: "reply"; turn: string; order: number; part: number; block: string; blockStart: number; start: number; end: number; evidence: string }
  | { kind: "source"; path: string; start: number; end: number; evidence: string }
  | { kind: "diff"; repository: string; path: string; scope: RepoDiffScope; base: string | null; fingerprint: string; side: "old" | "new"; start: number; end: number; evidence: string };
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

/** Exact coordinates first, then a unique exact occurrence, but only in a complete source. */
export function sourceAnchor(target: Extract<ReviewTarget, { kind: "source" }>, source: string, complete: boolean): { start: number; end: number } | null {
  const lines = source.split("\n");
  const count = target.end - target.start + 1;
  if (lines.slice(target.start - 1, target.end).join("\n") === target.evidence && target.end <= lines.length) return { start: target.start, end: target.end };
  if (!complete || !target.evidence.trim()) return null;
  // Newline sentinels enforce whole-line matches and keep relocation linear in source size.
  const haystack = `\n${source}\n`, needle = `\n${target.evidence}\n`;
  const at = haystack.indexOf(needle);
  if (at === -1 || haystack.indexOf(needle, at + 1) !== -1) return null;
  let start = 1;
  for (let index = 1; index <= at; index++) if (haystack[index] === "\n") start++;
  return { start, end: start + count - 1 };
}
export function sameDiff(target: Extract<ReviewTarget, { kind: "diff" }>, shown: Omit<Extract<ReviewTarget, { kind: "diff" }>, "start" | "end" | "evidence" | "kind">): boolean {
  return target.repository === shown.repository && target.path === shown.path && target.scope === shown.scope && target.base === shown.base && target.fingerprint === shown.fingerprint && target.side === shown.side;
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
  const comparison = target.scope === "all" ? `${target.base ?? "HEAD / empty tree"} versus working tree` : target.scope === "workspace" ? "index versus working tree" : target.scope === "staged" ? "HEAD / empty tree versus index" : `${target.base ?? ""} versus commit`;
  return `${target.path}, ${target.side} side, lines ${range} (${comparison}; snapshot ${target.fingerprint})`;
}
export function composeReviewMessage(notes: readonly ReviewNote[], text: string, limit: number): string | null {
  const quoted = (value: string): string => value.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
  const blocks = orderedNotes(notes).map((note) => `Review comment: ${reviewReference(note.target)}\n${quoted(note.quote)}\n\n${note.text}`);
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
  if (target.start < 1 || typeof target.path !== "string") return false;
  if (target.kind === "source") return true;
  return target.kind === "diff" && typeof target.repository === "string" && typeof target.fingerprint === "string" && target.fingerprint.length > 0 && (target.side === "old" || target.side === "new") && ["all", "workspace", "staged", "commit"].includes(target.scope) && (target.base === null || typeof target.base === "string");
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
      if (JSON.stringify(next) !== JSON.stringify(this.notes)) { this.notes = next; this.emit(); }
    } catch { this.storageFailed = true; }
  };
  private persist(changed: readonly string[]): void {
    const keys = new Set(this.notes.map((note) => note.key));
    for (const key of this.availability.keys()) if (!keys.has(key)) this.availability.delete(key);
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
  mark(key: string, status: "current" | "outdated" | "unavailable"): void {
    if (this.availability.get(key) === status) return;
    if (status === "unavailable" && !this.notes.some((note) => note.key === key)) { this.availability.delete(key); return; }
    this.availability.set(key, status);
    this.emit();
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
    this.draft = { id: reviewVersionId(), owner: note.owner, key: note.key, target: note.target, quote: note.quote, original: note.text, text: note.text }; this.listOwner = null; this.emit(); return true;
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
