import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import "./CommitPicker.css";

export interface CommitPickerProps {
  paneId: string;
  onSelect: (commit: string | null) => void;
  onClose: () => void;
  label: string;
}

export function CommitPicker({ paneId, onSelect, onClose, label }: CommitPickerProps) {
  const api = useMachineApi();
  const t = useT();
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{
    api: typeof api; paneId: string; query: string;
    data: Awaited<ReturnType<typeof api.fetchGitCommits>> | null; error: boolean;
  } | null>(null);
  const current = result?.api === api && result.paneId === paneId && result.query === query ? result : null;
  const commits = current?.data?.commits ?? [];
  const activeIndex = Math.min(active, commits.length);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setActive(0);
    const timer = window.setTimeout(() => {
      api.fetchGitCommits(paneId, query).then((data) => {
        if (!cancelled) setResult({ api, paneId, query, data, error: false });
      }).catch(() => {
        if (!cancelled) setResult({ api, paneId, query, data: null, error: true });
      });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, paneId, query]);

  useEffect(() => {
    list.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return <section className="commit-picker" aria-labelledby={`${id}-label`} onKeyDown={(event) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  }}>
    <header className="commit-picker-header">
      <span id={`${id}-label`} className="commit-picker-label" title={label}>{label}</span>
      <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <input className="input commit-picker-input" autoFocus role="combobox" type="text"
      aria-label={t("Search commits…")} placeholder={t("Search commits…")} autoComplete="off" spellCheck={false}
      aria-autocomplete="list" aria-expanded={true} aria-controls={id} aria-activedescendant={`${id}-${activeIndex}`}
      value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); event.stopPropagation();
          setActive((value) => (Math.min(value, commits.length) + (event.key === "ArrowDown" ? 1 : -1) + commits.length + 1) % (commits.length + 1));
        } else if (event.key === "Enter") {
          event.preventDefault(); event.stopPropagation();
          const commit = commits[activeIndex - 1];
          if (activeIndex === 0) onSelect(null);
          else if (commit) onSelect(commit.id);
        }
      }} />
    <ul ref={list} id={id} role="listbox" aria-label={t("Search commits…")} className="commit-picker-list">
      <li id={`${id}-0`} role="option" aria-selected={activeIndex === 0} className="commit-picker-option"
        onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(0)} onClick={() => onSelect(null)}>{t("Working changes")}</li>
      {commits.map((commit, index) => <li key={commit.id} id={`${id}-${index + 1}`} role="option"
        aria-selected={activeIndex === index + 1} className="commit-picker-option"
        onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index + 1)} onClick={() => onSelect(commit.id)}>
        <span className="commit-picker-subject">{commit.subject}</span>
        <span className="commit-picker-meta"><code title={commit.id}>{commit.id.slice(0, 10)}</code><span>{commit.author}</span><span>{commit.date}</span></span>
      </li>)}
    </ul>
    {!current && <p role="status" className="commit-picker-status">{t("Loading…")}</p>}
    {current?.error && <p role="alert" className="commit-picker-error">{t("Could not load commits")}</p>}
    {current && !current.error && !commits.length && <p role="status" className="commit-picker-status">{t("No matches")}</p>}
    {current?.data?.truncated && <p role="status" className="commit-picker-status">{t("More results available. Refine your search.")}</p>}
  </section>;
}
