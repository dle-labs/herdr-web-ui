import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Columns2, Copy, CopySlash, FileText, FoldVertical, Rows3, TriangleAlert, X } from "lucide-react";

import "./RepoDiffViewer.css";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Skeleton } from "./Skeleton.tsx";

import type { RepoDiffFilePatch } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { pathParts } from "../lib/filePaths.ts";
import { canHighlight, languageForPath } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { comparisonWord, diffColorable, diffErrorMessage, diffStyleFor, repositoryFilePath, statusWord, unavailableMessage, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { useSettings } from "../lib/settings.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { skeletonRows } from "../lib/skeleton.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { reviewNotes, sameDiff, REVIEW_MARKER_LIMIT, type ReviewTarget } from "../lib/reviewNotes.ts";
import { ReviewNotesButton, useReviewNotes } from "./ReviewNotes.tsx";

const RepoDiff = lazy(() => import("./RepoDiff.tsx"));

export interface RepoDiffViewerProps {
  target: RepoDiffTarget;
  onClose: () => void;
  /** opens the file itself (an absolute path on the PC that holds the repository) in the file viewer */
  onOpenFile: (path: string) => void;
  /** a file preview or Settings above it takes Escape */
  keyboardActive?: boolean;
  embedded?: boolean;
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; answer: RepoDiffFilePatch };
const PENDING: Load = { status: "pending" };

/** the text shown as one selected box when the clipboard is out of reach: the patch, or the file's path */
type Shown = { kind: "patch" | "path"; text: string };

/** Copies a text (disabled until there is one); without a clipboard, hands it over to be shown as a selected text box instead. */
function CopyButton({ text, label, doneLabel, icon, onShowText }: { text: string | null; label: string; doneLabel: string; icon: ReactNode; onShowText: (text: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const name = copied ? doneLabel : label;
  const copy = async (): Promise<void> => {
    if (text === null) return;
    if (await copyText(text)) setCopied(true);
    else onShowText(text);
  };
  return <button type="button" className="icon-button repo-diff-action" aria-label={name} title={name} disabled={text === null} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : icon}
  </button>;
}

const DIFF_SKELETON_ROWS = 6;

/** Rows the size of a diff's, a number and a line each, while the patch is read or its viewer loads: the dialog holds its shape. */
function DiffSkeleton({ label }: { label: string }) {
  return <div className="repo-diff-loading" role="status">
    <span className="visually-hidden">{label}</span>
    {skeletonRows(DIFF_SKELETON_ROWS).map((width, index) => <div key={index} className="repo-diff-loading-row" aria-hidden="true">
      <Skeleton className="repo-diff-loading-number" />
      <Skeleton width={width} />
    </div>)}
  </div>;
}

/**
 * One changed file of a repository, compared as the Changes list was: its patch as a window of
 * rows, unified or side by side (Settings → File viewer, one column on a phone), with the context
 * around each change folded to a line or shown whole, the file's status and counts in the header
 * (their places kept while the patch is on its way), the file itself a tap away in the file viewer,
 * and the patch copied as git printed it, or the file's path on its own.
 */
export function RepoDiffViewer({ target, onClose, onOpenFile, keyboardActive = true, embedded = false }: RepoDiffViewerProps) {
  const t = useT();
  const { settings, update, resolvedTheme } = useSettings();
  const { fetchRepoDiffFile } = useMachineApi();
  const surface = useFocusTrap<HTMLElement>(!embedded);
  const narrow = useMediaQuery("(max-width: 768px)");
  const [load, setLoad] = useState<Load>(PENDING);
  const [folded, setFolded] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useSheetSwipe(surface, embedded ? null : onClose);

  const { paneId, directory, scope, base, head, path, oldPath, fingerprint } = target;
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    setLoad(PENDING);
    setShown(null); setRenderFailed(false);
    fetchRepoDiffFile({ paneId, directory, scope, base, head, fingerprint }, path, oldPath, abort.signal).then(
      (answer) => { if (live) setLoad({ status: "ready", answer }); },
      (error: unknown) => { if (live) setLoad({ status: "failed", error }); },
    );
    return () => { live = false; abort.abort(); };
  }, [fetchRepoDiffFile, paneId, directory, scope, base, head, path, oldPath, fingerprint]);

  useEffect(() => {
    if (!keyboardActive || embedded) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, surface, embedded]);

  useLayoutEffect(() => {
    if (shown === null) return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [shown]);

  const answer = load.status === "ready" ? load.answer : null;
  const file = answer?.file ?? null;
  const patch = answer?.patch ?? null;
  const style = diffStyleFor(settings.diffStyle, narrow);
  const wantsColor = canHighlight(languageForPath(path));
  const colored = patch !== null && diffColorable(path, patch);
  const notes = [
    wantsColor && patch !== null && !colored ? t("Too long to highlight") : null,
    narrow && settings.diffStyle === "split" ? t("Split view needs a wider screen; showing one column.") : null,
  ].filter((note): note is string => note !== null);
  const { stem, extension } = pathParts(path);
  const { folder } = pathParts(path);
  const openable = answer !== null && answer.unavailable !== "unsupported" && file !== null && file.status !== "deleted";

  const owner = paneId === null ? null : paneStorageId(target.machineId, paneId);
  const savedNotes = useReviewNotes(owner ?? undefined);
  const diffNotes = useMemo(() => savedNotes.filter((note) => owner !== null && note.owner === owner && note.target.kind === "diff" && note.target.path === path), [savedNotes, owner, path]);
  const sideLines = useMemo(() => ({ old: answer?.old_content?.split("\n"), new: answer?.new_content?.split("\n") }), [answer]);
  const currentNotes = useMemo(() => new Set(diffNotes.filter((note) => {
    const anchor = note.target;
    if (renderFailed || anchor.kind !== "diff" || answer === null || answer.unavailable !== null || !sameDiff(anchor, { repository: answer.repository.root, path, scope, base: answer.base, head: answer.head, fingerprint: answer.fingerprint ?? "", side: anchor.side })) return false;
    const lines = sideLines[anchor.side];
    return lines !== undefined && anchor.end <= lines.length && lines.slice(anchor.start - 1, anchor.end).join("\n") === anchor.evidence;
  }).map((note) => note.key)), [diffNotes, answer, sideLines, path, scope, renderFailed]);
  useEffect(() => {
    reviewNotes.markAll(diffNotes.map((note) => [note.key, answer === null || renderFailed ? "unavailable" : currentNotes.has(note.key) ? "current" : "outdated"] as const));
    return () => reviewNotes.markAll(diffNotes.map((note) => [note.key, "unavailable"] as const));
  }, [diffNotes, answer, currentNotes, renderFailed]);
  const annotatable = !renderFailed && settings.reviewComments && owner !== null && answer !== null && !!fingerprint && answer.fingerprint === fingerprint && answer.unavailable === null && answer.old_content !== undefined && answer.new_content !== undefined;
  const [selection, setSelection] = useState<{ side: "old" | "new"; start: number; end: number } | null>(null);
  useEffect(() => setSelection(null), [path, fingerprint, scope, base, head]);
  const commentLine = useCallback((side: "old" | "new", start: number, end: number): void => {
    if (!annotatable || !answer || owner === null || !fingerprint) return;
    const lines = sideLines[side];
    if (!lines) return;
    const evidence = lines.slice(start - 1, end).join("\n");
    const noteTarget: ReviewTarget = { kind: "diff", repository: answer.repository.root, path, scope, base: answer.base, head: answer.head, fingerprint, side, start, end, evidence };
    if (reviewNotes.begin(owner, noteTarget, evidence)) setSelection({ side, start, end });
  }, [annotatable, answer, sideLines, owner, fingerprint, path, scope]);
  const selectLines = useCallback((side: "old" | "new", start: number, end: number): void => setSelection({ side, start, end }), []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const body = (() => {
    if (shown !== null) return <textarea ref={textRef} className="repo-diff-select-source" readOnly value={shown.text} aria-label={shown.kind === "patch" ? t("Patch") : t("Path")} spellCheck={false} />;
    if (load.status === "pending") return <DiffSkeleton label={t("Opening…")} />;
    if (load.status === "failed") {
      const stale = load.error instanceof ApiError && load.error.status === 404 && load.error.code === "not_found";
      return <p className="repo-diff-note" role="alert">{stale ? t("This file has no changes here any more; the list is out of date.") : diffErrorMessage(t, load.error)}</p>;
    }
    const unavailable = unavailableMessage(t, load.answer);
    if (unavailable !== null || patch === null) return <p className="repo-diff-note">{unavailable ?? t("No lines changed.")}</p>;
    return <RenderBoundary resetKey={patch} onFailure={() => setRenderFailed(true)} fallback={() => <p className="repo-diff-note" role="alert">{t("This change can't be shown.")}</p>}>
      <Suspense fallback={<DiffSkeleton label={t("Opening…")} />}>
        <RepoDiff patch={patch} style={style} folded={folded} wrap={settings.wrapCode} theme={resolvedTheme} colored={colored} onCommentLine={annotatable ? commentLine : undefined} onSelectLines={annotatable ? selectLines : undefined} onClearSelection={clearSelection} selectedLines={selection ? { start: selection.start, end: selection.end, side: selection.side === "old" ? "deletions" : "additions" } : null} />
      </Suspense>
    </RenderBoundary>;
  })();

  const reviewBar = owner !== null && settings.reviewComments ? <div className="file-review-bar">
    {selection && annotatable && <button type="button" className="btn btn-ghost" onMouseDown={(event) => event.preventDefault()} onClick={() => commentLine(selection.side, selection.start, selection.end)}>{t("Comment on selected lines")}</button>}
    {diffNotes.slice(0, REVIEW_MARKER_LIMIT).map((note) => { const current = currentNotes.has(note.key); return <button type="button" className="btn btn-ghost review-marker" key={note.key} onClick={() => { if (reviewNotes.edit(note) && current && note.target.kind === "diff") setSelection({ side: note.target.side, start: note.target.start, end: note.target.end }); }}>{current ? t("Saved comment") : t("Outdated comment")}</button>; })}
    {diffNotes.length > REVIEW_MARKER_LIMIT && <small>{t("Only the first {count} markers are shown. All comments remain in the comments list.", { count: REVIEW_MARKER_LIMIT })}</small>}
    <ReviewNotesButton owner={owner} />
    {!annotatable && answer !== null && answer.unavailable === null && <small>{t("This bridge does not provide a consistent snapshot for diff comments.")}</small>}
  </div> : null;
  const contents = <>
        <header className="modal-header repo-diff-header">
          <div className="repo-diff-title">
            <h2 className="modal-title"><span className="repo-diff-stem">{stem}</span>{extension}</h2>
            <p className="repo-diff-meta" title={oldPath === null ? path : t("Renamed from {path}", { path: oldPath })}>
              {load.status === "pending" && <>
                <Skeleton className="repo-diff-skeleton-status" />
                <Skeleton className="repo-diff-skeleton-counts" />
              </>}
              {file !== null && <span className="repo-diff-status" data-status={file.status}>{statusWord(t, file.status)}</span>}
              {file !== null && file.additions !== null && file.deletions !== null && <span className="repo-diff-counts">
                <span className="repo-diff-added">+{file.additions.toLocaleString()}</span>
                <span className="repo-diff-deleted">−{file.deletions.toLocaleString()}</span>
              </span>}
              {file?.binary === true && <span className="repo-diff-binary">{t("Binary")}</span>}
              {notes.length > 0 && <span className="repo-diff-notice" title={notes.join("\n")}>
                <TriangleAlert aria-hidden="true" />
                <span>{notes[0]}</span>
                <span className="visually-hidden">{notes.join(". ")}</span>
              </span>}
              <span className="repo-diff-compare">{comparisonWord(t, target)}</span>
              {folder !== "" && <span className="repo-diff-path"><span dir="ltr">{folder}</span></span>}
            </p>
          </div>
          <div className="repo-diff-actions">
            {!embedded && <div className="segmented repo-diff-styles" role="group" aria-label={t("Diff layout")}>
              <button type="button" aria-pressed={style === "unified"} onClick={() => { if (reviewNotes.guard()) update({ diffStyle: "unified" }); }}><Rows3 aria-hidden="true" /><span className="repo-diff-style-word">{t("Unified")}</span></button>
              <button type="button" aria-pressed={style === "split"} disabled={narrow} title={narrow ? t("Split view needs a wider screen") : undefined} onClick={() => { if (reviewNotes.guard()) update({ diffStyle: "split" }); }}><Columns2 aria-hidden="true" /><span className="repo-diff-style-word">{t("Split")}</span></button>
            </div>}
            <div className="repo-diff-group">
              <button type="button" className="icon-button repo-diff-action" aria-pressed={folded} aria-label={t("Fold context")} title={folded ? t("Showing one line around each change") : t("Fold context")} disabled={patch === null} onClick={() => { if (reviewNotes.guard()) setFolded((value) => !value); }}><FoldVertical aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Open file")} title={t("Open working file")} disabled={!openable} onClick={() => answer !== null && onOpenFile(repositoryFilePath(answer.repository.root, path))}><FileText aria-hidden="true" /></button>
              {shown === null && <>
                <CopyButton text={path} label={t("Copy path")} doneLabel={t("Path copied")} icon={<CopySlash aria-hidden="true" />} onShowText={(text) => { if (reviewNotes.close()) setShown({ kind: "path", text }); }} />
                {(load.status === "pending" || patch !== null) && <CopyButton text={patch} label={t("Copy patch")} doneLabel={t("Patch copied")} icon={<Copy aria-hidden="true" />} onShowText={(text) => { if (reviewNotes.close()) setShown({ kind: "patch", text }); }} />}
              </>}
            </div>
          </div>
          {!embedded && <button type="button" className="icon-button repo-diff-action repo-diff-close" aria-label={t("Close diff")} title={t("Close diff")} onClick={onClose}><X aria-hidden="true" /></button>}
        </header>
        {reviewBar}<div className="repo-diff-body">{body}</div>
    </>;
  if (embedded) return <section className="repo-diff-viewer repo-diff-embedded" ref={surface} aria-label={t("Changes to {name}", { name: `${stem}${extension}` })}>{contents}</section>;
  return <div className="modal-scrim repo-diff-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal repo-diff-viewer" role="dialog" aria-modal="true" aria-label={t("Changes to {name}", { name: `${stem}${extension}` })} ref={surface} tabIndex={-1}>{contents}</section></div>;
}
