/** Reply/file annotations stay drafts: adding one never sends terminal input. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, MessageSquare, X } from "lucide-react";
import "./Composer.css";
import "./CommentDraft.css";
import { paneStorageId } from "../../shared/machines.ts";
import { appendCommentToDraft, type CommentReference } from "../lib/commentDraft.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { MAX_COMPOSER_CHARS } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { consumeDictationEscape, MicButton, useDictation, VoiceRecordingPill } from "./VoiceInput.tsx";

/** Observe the owning connection; this editor neither connects nor attaches a pane. */
export function useCommentConnection(paneId: string | null): boolean {
  const sessions = useMachineSessions();
  const machineId = useMachineId();
  const owner = paneId === null ? null : paneStorageId(machineId, paneId);
  const [state, setState] = useState<{ owner: string | null; connected: boolean }>({ owner: null, connected: false });
  useEffect(() => {
    if (!sessions || paneId === null) { setState({ owner, connected: false }); return; }
    const session = sessions.get(machineId);
    let interact = true;
    const update = (connected: boolean) => setState((previous) => previous.owner === owner && previous.connected === connected ? previous : { owner, connected });
    const refresh = () => update(interact && session.socket.canInput(paneId));
    const off = session.on((message) => {
      if (message.type === "role-ack") interact = message.mode === "interact";
      refresh();
    });
    const disconnect = session.onDisconnect(() => update(false));
    refresh();
    return () => { off(); disconnect(); };
  }, [sessions, machineId, paneId, owner]);
  return state.owner === owner && state.connected;
}

interface CommentActionProps {
  paneId: string;
  reference: CommentReference;
  connected: boolean;
  active?: boolean;
  captureReference?: () => CommentReference;
  /** A durable host may own the editor when this trigger lives in a virtualized row. */
  onOpen?: (reference: CommentReference, trigger: HTMLButtonElement) => void;
}

/** Snapshot the reference on opening, so a live reply/file never retargets a recording. */
export function CommentAction({ paneId, reference, connected, active = true, captureReference, onOpen }: CommentActionProps) {
  const t = useT();
  const machineId = useMachineId();
  const [opened, setOpened] = useState<CommentReference | null>(null);
  const [added, setAdded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = reference.kind === "reply" ? t("Comment on reply") : t("Comment on file");
  const close = () => { setOpened(null); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpened(null); setAdded(false); }, [paneId, machineId, reference.kind, reference.kind === "file" ? reference.path : ""]);
  return <div className="comment-entry">
    <button ref={trigger} type="button" className="btn btn-ghost comment-trigger" aria-label={label} aria-expanded={onOpen ? undefined : opened !== null}
      disabled={!active} onPointerDown={(event) => { if (captureReference && event.button === 0) event.preventDefault(); }} onClick={(event) => {
        setAdded(false);
        const snapshot = { ...(captureReference?.() ?? reference) };
        if (onOpen) onOpen(snapshot, event.currentTarget);
        else setOpened(snapshot);
      }}><MessageSquare aria-hidden="true" />{label}</button>
    {added && <p className="comment-draft-note" role="status">{t("Comment added to the message draft. Review it before sending.")}</p>}
    {!onOpen && opened && <CommentDraft key={`${machineId}:${paneId}`} paneId={paneId} reference={opened} connected={connected} active={active}
      onClose={close} onAdded={() => { setAdded(true); close(); }} />}
  </div>;
}

interface CommentDraftProps extends Omit<CommentActionProps, "captureReference" | "onOpen"> {
  onClose: () => void;
  onAdded: () => void;
}

export function CommentDraft({ paneId, reference, connected, active = true, onClose, onAdded }: CommentDraftProps) {
  const t = useT();
  const machineId = useMachineId();
  const opening = useId();
  const phone = useMediaQuery("(max-width: 640px), (pointer: coarse)");
  const field = useRef<HTMLTextAreaElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const valueRef = useRef("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const write = (text: string) => { valueRef.current = text; setValue(text); };
  const dictation = useDictation({ mode: "comment", phone, active, owner: `${paneStorageId(machineId, paneId)}:comment:${opening}`,
    connected, box: field, surface, read: () => valueRef.current, write, maxLength: MAX_COMPOSER_CHARS, onNote: setNote });
  useLayoutEffect(() => { field.current?.focus({ preventScroll: true }); }, []);
  const add = () => {
    if (!active || dictation.voice.state !== "idle" || dictation.recovery !== null) return;
    const key = `herdr-web-ui:composer-draft:${paneStorageId(machineId, paneId)}`;
    composerDrafts.refresh(key);
    const next = appendCommentToDraft(composerDrafts.read(key).text, reference, valueRef.current);
    if (next === null) { setNote(t("This comment does not fit in the message draft.")); return; }
    composerDrafts.set(key, next);
    dictation.cancel();
    onAdded();
  };
  return <div className="comment-draft" ref={surface} role="group" aria-label={t("Comment draft")}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (consumeDictationEscape(event.nativeEvent, surface.current)) return;
        event.preventDefault(); event.stopPropagation(); dictation.cancel(); onClose();
      }
    }}>
    <blockquote className="comment-draft-reference">{reference.kind === "file" && <p>{reference.path}</p>}{reference.text}</blockquote>
    <div className="comment-draft-input"><div className="composer-surface">
      <textarea ref={field} className="composer-text" rows={3} maxLength={MAX_COMPOSER_CHARS} aria-label={t("Comment draft")}
        value={value} onChange={(event) => { write(event.currentTarget.value); setNote(null); }} />
      <div className="composer-controls composer-controls-left">
        {dictation.shown && <MicButton dictation={dictation} />}
        <button type="button" className="icon-button" aria-label={t("Cancel")} title={t("Cancel")}
          onClick={() => { dictation.cancel(); onClose(); }}><X aria-hidden="true" /></button>
      </div>
      <div className="composer-controls composer-controls-right">
        <button type="button" className="composer-action composer-send" aria-label={t("Add to message")} title={t("Add to message")}
          disabled={!active || !value.trim() || dictation.voice.state !== "idle" || dictation.recovery !== null} onClick={add}><Check aria-hidden="true" /></button>
      </div>
    </div>
    {dictation.shown && <VoiceRecordingPill dictation={dictation} align="start" />}</div>
    {note && <p className="comment-draft-note" role="alert">{note}</p>}
  </div>;
}
