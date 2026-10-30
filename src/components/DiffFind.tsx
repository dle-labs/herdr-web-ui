import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { DIFF_FIND_MAX_QUERY, diffFindLines, findInDiff, stepMatch, type DiffFindMatch } from "../lib/repoDiffFind.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver } from "../lib/useFocusTrap.ts";
import { markRow, textRange, revealColumns } from "../lib/diffFindPaint.ts";
import "./FindBar.css";
import "./RepoDiffViewer.css";

/** A loaded patch owns its query; Files chooses exactly one keyboard/highlight owner. */
export function useDiffFind(patch: string | null, active: boolean, keyboardActive: boolean, surface: RefObject<HTMLDivElement | null>, activate: () => void) {
  const t = useT();
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<number | null>(null);
  const [request, setRequest] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const node = useRef<HTMLElement | null>(null);
  const painted = useRef<Highlight | null>(null);
  const lines = useMemo(() => diffFindLines(patch), [patch]);
  const matches = useMemo(() => findInDiff(lines, query), [lines, query]);
  const match: DiffFindMatch | null = finding && active && index !== null ? matches[index] ?? null : null;
  const current = useRef(match); current.current = match;
  const owned = useRef(active); owned.current = active;
  const clear = useCallback(() => {
    for (const row of node.current?.shadowRoot?.querySelectorAll("[data-find-active]") ?? []) row.removeAttribute("data-find-active");
    if (typeof CSS !== "undefined" && "highlights" in CSS && CSS.highlights.get("repo-diff-find") === painted.current) CSS.highlights.delete("repo-diff-find");
    painted.current = null;
  }, []);
  const paint = useCallback(() => {
    clear();
    const shadow = node.current?.shadowRoot;
    const value = current.current;
    if (!owned.current || !shadow || !value) return;
    const row = markRow(shadow, value);
    row?.setAttribute("data-find-active", "");
    if (row && typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined") {
      const range = textRange(row, value.start, value.end);
      if (range) { painted.current = new Highlight(range); CSS.highlights.set("repo-diff-find", painted.current); }
    }
  }, [clear]);
  const reveal = useRef(false);
  const onPostRender = useCallback((host: HTMLElement) => {
    node.current = host;
    paint();
    if (reveal.current && current.current && host.shadowRoot) {
      const row = markRow(host.shadowRoot, current.current);
      if (row) {
        reveal.current = false;
        row.scrollIntoView({ block: "center", inline: "nearest" });
        revealColumns(row, current.current);
      }
    }
  }, [paint]);
  useEffect(() => { setQuery(""); setIndex(null); }, [patch]);
  useLayoutEffect(() => { reveal.current = true; if (node.current) onPostRender(node.current); }, [match, onPostRender]);
  useEffect(() => clear, [clear]);
  const close = useCallback(() => {
    setFinding(false);
    (opener.current?.isConnected ? opener.current : button.current)?.focus();
    opener.current = null;
  }, []);
  useEffect(() => {
    if (!finding || !active || !keyboardActive) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest(".comment-popover, .commit-picker, .workspace-file-search")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [finding, active, keyboardActive, close, surface]);
  useLayoutEffect(() => { if (request) { input.current?.focus(); input.current?.select(); } }, [request]);
  const open = () => {
    if (patch === null) return;
    if (!finding || !active) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : button.current;
    activate(); setFinding(true); setRequest(value => value + 1);
  };
  const step = (direction: 1 | -1) => setIndex(value => stepMatch(value, matches.length, direction));
  const place = match === null ? "" : t(match.kind === "context" ? "Unchanged line {line}" : match.kind === "addition" ? "Added line {line}" : "Removed line {line}", { line: match.line.toLocaleString() });
  const count = query === "" ? "" : match ? t("{current} of {total}", { current: index! + 1, total: matches.length }) : matches.length === 0 ? t("No matches") : "";
  return {
    match, onPostRender,
    button: <button ref={button} type="button" className="icon-button diff-find-button" aria-label={t("Find in diff")} title={patch === null ? t("There is no loaded patch to search.") : t("Find in diff")} aria-pressed={finding && active} disabled={patch === null} onPointerDown={event => event.stopPropagation()} onClick={open}><Search aria-hidden="true" /></button>,
    bar: finding && active ? <form className="find-bar repo-diff-find" role="search" aria-label={t("Find in diff")} onSubmit={event => { event.preventDefault(); step(1); }}>
      <div className="find-bar-controls">
        <label className="find-bar-query"><Search size={16} aria-hidden="true" /><span className="repo-diff-find-label">{t("Find in diff")}</span>
          <input ref={input} className="input" type="search" value={query} maxLength={DIFF_FIND_MAX_QUERY} spellCheck={false} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
          }} />
        </label>
        <span className="find-bar-count" role="status">{count}{match && <span className="repo-diff-find-place">{place}</span>}</span>
        <button className="icon-button" type="button" aria-label={t("Previous match")} title={t("Previous match")} disabled={!matches.length} onClick={() => step(-1)}><ArrowUp size={16} aria-hidden="true" /></button>
        <button className="icon-button" type="button" aria-label={t("Next match")} title={t("Next match")} disabled={!matches.length} onClick={() => step(1)}><ArrowDown size={16} aria-hidden="true" /></button>
        <button className="icon-button" type="button" aria-label={t("Close search")} title={t("Close search")} onClick={close}><X size={16} aria-hidden="true" /></button>
      </div>
      <p className="find-bar-hint">{t("Searches this loaded patch, including context. Content outside the patch is not searched.")}</p>
    </form> : null,
  };
}
