import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ChevronLeft, ChevronRight, MessageSquarePlus, Trash2, X } from "lucide-react";
import { paneStorageId } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { draftDirty, orderedNotes, replyAnchor, reviewNotes, reviewReference, REVIEW_TEXT_LIMIT, type ReviewDraft, type ReviewTarget } from "../lib/reviewNotes.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";
import "./ReviewNotes.css";

export function useReviewNotes(owner?: string) {
  useSyncExternalStore(reviewNotes.subscribe, reviewNotes.snapshot);
  return reviewNotes.read(owner);
}
/** Entry point also exposes unavailable notes: leaving a document never filters the send set. */
export function ReviewNotesButton({ owner, held = false, className = "" }: { owner: string; held?: boolean; className?: string }) {
  const t = useT();
  const { settings } = useSettings();
  const notes = useReviewNotes(owner);
  if ((!settings.reviewComments || notes.length === 0) && !reviewNotes.storageFailed) return null;
  return <div className={`composer-review-notes ${className}`}>
    {settings.reviewComments && notes.length > 0 && <button type="button" className="btn btn-ghost" onClick={() => reviewNotes.list(owner)}><MessageSquarePlus aria-hidden="true" />{t(held ? "{count} comments held" : "{count} comments included", { count: notes.length })}</button>}
    {reviewNotes.storageFailed && <p className="review-note-warning" role="alert">{t("Comments could not be saved on this device. Keep this page open.")}</p>}
  </div>;
}

/** A draft's session owns dictation; switching targets unmounts it, resizing never does. */
function ReviewDraftEditor({ draft, box, cancel }: { draft: ReviewDraft; box: RefObject<HTMLTextAreaElement | null>; cancel: RefObject<(() => boolean) | null> }) {
  const t = useT();
  const { settings } = useSettings();
  const phone = useMediaQuery("(max-width: 768px)");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const dictation = useDictation({ mode: "chat", active: true, connected: true, phone, polish: settings.voicePolishChat, box,
    read: () => reviewNotes.draft?.id === draft.id ? reviewNotes.draft.text : "", maxLength: REVIEW_TEXT_LIMIT,
    write: (text, caret) => { if (reviewNotes.draft?.id !== draft.id) return; reviewNotes.write(text); requestAnimationFrame(() => { if (reviewNotes.draft?.id === draft.id && box.current?.value === text) box.current.setSelectionRange(caret, caret); }); }, onNote: setVoiceNote });
  const stop = () => { const active = dictation.voice.state !== "idle"; dictation.forget(); dictation.voice.cancel(); return active; };
  const latestStop = useRef(stop); latestStop.current = stop; cancel.current = stop;
  useEffect(() => () => { latestStop.current(); if (cancel.current === latestStop.current) cancel.current = null; }, [cancel]);
  return <>
    <textarea ref={box} className="input review-note-text" aria-label={t("Comment")} value={draft.text} maxLength={REVIEW_TEXT_LIMIT} rows={5} onChange={(event) => reviewNotes.write(event.target.value)} onCompositionStart={() => reviewNotes.composition(true)} onCompositionEnd={() => reviewNotes.composition(false)} autoFocus />
    {voiceNote && <p role="status">{voiceNote}</p>}
    <VoiceRecordingPill dictation={dictation} align="start" />
    {(draftDirty(draft) || reviewNotes.composing) && <p className="review-note-warning" role="status">{t("Save or discard this comment before navigating or sending.")}</p>}
    <footer className="review-note-actions">
      {dictation.shown && <MicButton dictation={dictation} />}
      <button className="btn btn-ghost" type="button" onClick={() => { cancel.current?.(); reviewNotes.close(true); }}>{t("Discard")}</button>
      {draft.key && <button type="button" className="icon-button" aria-label={t("Delete comment")} onClick={() => { cancel.current?.(); reviewNotes.remove(draft.key!); }}><Trash2 aria-hidden="true" /></button>}
      <button className="btn btn-primary" type="button" disabled={reviewNotes.composing || (!draft.key && !draft.text.trim())} onClick={() => { cancel.current?.(); reviewNotes.save(); }}>{t("Save")}</button>
    </footer>
  </>;
}

/** One stable editor across renderer updates and resizing; source keeps its own scroll root. */
export function ReviewNotes() {
  const t = useT();
  const { settings, update } = useSettings();
  useReviewNotes();
  const draft = reviewNotes.draft;
  const owner = draft?.owner ?? reviewNotes.listOwner;
  const open = owner !== null;
  const box = useRef<HTMLTextAreaElement>(null);
  const surface = useFocusTrap<HTMLElement>(open, { initialFocus: box });
  const phone = useMediaQuery("(max-width: 768px)");
  const cancelVoice = useRef<(() => boolean) | null>(null);
  useEffect(() => {
    // The device-wide confirmed action also reaches other tabs' memory-only drafts.
    if (!settings.reviewComments) { cancelVoice.current?.(); reviewNotes.clear(); }
  }, [settings.reviewComments]);
  const [dockWidth, setDockWidth] = useState(360);
  useLayoutEffect(() => {
    if (!open || phone || draft?.target.kind !== "reply") { setDockWidth(360); return; }
    // The existing owned pane wrapper supplies layout, never a virtualized reply DOM anchor.
    const pane = document.querySelector<HTMLElement>(`.terminal-stack[data-pane-owner="${CSS.escape(draft.owner)}"]`);
    if (!pane) return;
    const measure = (): void => {
      if (!pane.isConnected) return;
      const rect = pane.getBoundingClientRect();
      setDockWidth(Math.min(360, Math.max(180, rect.width / 2)));
      const edge = surface.current?.getBoundingClientRect().left ?? window.innerWidth;
      const reserve = Math.max(0, rect.right - edge + 8);
      pane.toggleAttribute("data-review-docked", reserve > 0);
      pane.style.setProperty("--review-reserve", `${reserve}px`);
    };
    const observer = new ResizeObserver(measure); observer.observe(pane); if (surface.current) observer.observe(surface.current); measure();
    return () => { observer.disconnect(); pane.removeAttribute("data-review-docked"); pane.style.removeProperty("--review-reserve"); };
  }, [open, phone, draft?.owner, draft?.target.kind, surface]);
  const close = (): boolean => reviewNotes.close();
  usePhoneSheetBack(close, open);
  useEffect(() => {
    const focus = (): void => { box.current?.focus({ preventScroll: true }); box.current?.scrollIntoView({ block: "nearest" }); };
    window.addEventListener("herdr-review-focus", focus);
    return () => window.removeEventListener("herdr-review-focus", focus);
  }, []);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || reviewNotes.composing || document.querySelector(".confirm-dialog")) return;
      event.stopImmediatePropagation(); event.preventDefault();
      if (!cancelVoice.current?.()) reviewNotes.close();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  const confirmation = reviewNotes.confirmDisable ? <ConfirmDialog title={t("Turn off review comments?")} body={t("Delete saved comments across every pane on this device and discard the comment draft. Already accepted pending messages keep their text and are not cancelled.")} confirmLabel={t("Turn off and delete")} onClose={() => reviewNotes.disableConfirmation(false)} onConfirm={async () => { reviewNotes.clear(); update({ reviewComments: false }); reviewNotes.disableConfirmation(false); }} /> : null;
  if (!open) return confirmation;
  const deviceList = owner === "*";
  const notes = orderedNotes(reviewNotes.read(deviceList ? undefined : owner));
  const at = draft?.key ? notes.findIndex((note) => note.key === draft.key) : -1;
  return <><aside ref={surface} className={`review-editor${phone ? " review-editor-sheet" : ""}`} style={phone ? undefined : { width: dockWidth }} data-target-kind={draft?.target.kind} role="dialog" aria-modal="true" aria-label={t("Review comments")} tabIndex={-1}>
    <header className="modal-header"><h2 className="modal-title">{t("Review comments")}</h2><button type="button" className="icon-button" aria-label={t("Close comments")} onClick={close}><X aria-hidden="true" /></button></header>
    <p className="review-note-hint">{deviceList ? t("Comments stay with their original machine and pane. This list does not change what a pane sends.") : t("Saved locally. All comments for this pane accompany the next ordinary agent message; unavailable targets are included too.")}</p>
    {reviewNotes.contextRefused && <p className="review-note-warning" role="alert">{t("This selection is too large to anchor safely. Select fewer lines.")}</p>}
    {reviewNotes.storageFailed && <p className="review-note-warning" role="alert">{t("Comments could not be saved on this device. Keep this page open.")}</p>}
    {draft !== null ? <>
      <p className="review-reference">{draft.owner} · {reviewReference(draft.target)}</p>
      <blockquote className="review-quote">{draft.quote}</blockquote>
      <ReviewDraftEditor key={draft.id} draft={draft} box={box} cancel={cancelVoice} />
      {at !== -1 && notes.length > 1 && <div className="review-note-navigation"><button className="btn btn-ghost" type="button" onClick={() => reviewNotes.edit(notes[(at + notes.length - 1) % notes.length]!)}><ChevronLeft aria-hidden="true" />{t("Previous comment")}</button><button className="btn btn-ghost" type="button" onClick={() => reviewNotes.edit(notes[(at + 1) % notes.length]!)}>{t("Next comment")}<ChevronRight aria-hidden="true" /></button></div>}
    </> : <ul className="review-note-list">{notes.map((note) => <li key={note.key}>
      <button type="button" className="btn btn-ghost review-note-open" onClick={() => reviewNotes.edit(note)}><strong>{deviceList ? `${note.owner} · ` : ""}{reviewReference(note.target)}</strong><span>{note.text}</span><small>{reviewNotes.status(note.key) === "current" ? t("Saved comment") : t(reviewNotes.status(note.key) === "outdated" ? "Outdated comment" : "Unavailable comment")}</small></button>
      <button type="button" className="icon-button" aria-label={t("Delete comment")} onClick={() => reviewNotes.remove(note.key)}><Trash2 aria-hidden="true" /></button>
    </li>)}</ul>}
    <button type="button" className="btn btn-ghost review-disable" onClick={() => reviewNotes.disableConfirmation(true)}>{t("Turn off review comments?")}</button>
  </aside>{confirmation}</>;
}

/** Settled reply parts only. Quoted selection maps only when it occurs exactly once in source. */
export function ReplyComment({ paneId, turn, order, part, text, children }: { paneId: string; turn: string; order: number; part: number; text: string; children?: ReactNode }) {
  const t = useT();
  const machine = useMachineId();
  const { settings } = useSettings();
  const owner = paneStorageId(machine, paneId);
  const block = useRef<HTMLDivElement>(null);
  const savedNotes = useReviewNotes(owner);
  const candidates = useMemo(() => savedNotes.filter((note) => note.target.kind === "reply" && note.target.turn === turn && note.target.part === part), [savedNotes, turn, part]);
  const notes = candidates.filter((note) => note.target.kind === "reply" && replyAnchor(note.target, turn, part, text));
  useEffect(() => {
    for (const note of candidates) reviewNotes.mark(note.key, note.target.kind === "reply" && replyAnchor(note.target, turn, part, text) ? "current" : "outdated");
    return () => { for (const note of candidates) reviewNotes.mark(note.key, "unavailable"); };
  }, [candidates, text]);
  const comment = (): void => {
    const selection = window.getSelection();
    const selected = selection?.anchorNode && block.current?.contains(selection.anchorNode) && selection.focusNode && block.current.contains(selection.focusNode) ? selection.toString() : "";
    const position = selected ? text.indexOf(selected) : 0;
    const honest = selected && position !== -1 && text.indexOf(selected, position + 1) === -1;
    // No DOM-to-Markdown guess: retain the complete source block around an honest selection,
    // or the complete source part. Replaced blocks cannot match on coordinates/selected words alone.
    const start = honest ? position : 0, end = honest ? position + selected.length : text.length;
    const boundary = honest ? text.lastIndexOf("\n\n", start - 1) : -1;
    const blockStart = boundary === -1 ? 0 : boundary + 2;
    const after = honest ? text.indexOf("\n\n", end) : -1;
    const evidence = text.slice(blockStart, after === -1 ? text.length : after);
    const target: ReviewTarget = { kind: "reply", turn, order, part, block: `part:${part}/source:${blockStart}`, blockStart, start, end, evidence };
    reviewNotes.begin(owner, target, honest ? selected : evidence);
  };
  return <div ref={block} className={settings.reviewComments ? "reply-review-part" : undefined} onClick={settings.reviewComments ? (event) => { if (event.target !== event.currentTarget || window.getSelection()?.toString()) return; comment(); } : undefined}>{children}{settings.reviewComments && <span className="reply-review-controls"><button type="button" className="btn btn-ghost chat-meta-btn" onMouseDown={(event) => event.preventDefault()} onClick={comment}><MessageSquarePlus aria-hidden="true" />{t("Comment")}</button>{notes.map((note) => <button className="btn btn-ghost review-marker" type="button" key={note.key} onClick={() => reviewNotes.edit(note)} title={note.text}>{t("Saved comment")}</button>)}</span>}</div>;
}
