import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import "./WorkspaceFileSearch.css";

export interface WorkspaceFileSearchProps {
  paneId: string;
  onSelect: (absolute: string) => void;
  refreshToken: number;
  disabled?: boolean;
  onReveal?: () => void;
}

export function WorkspaceFileSearch({ paneId, onSelect, refreshToken, disabled = false, onReveal }: WorkspaceFileSearchProps) {
  const t = useT();
  const api = useMachineApi();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{
    api: typeof api; paneId: string; query: string; refreshToken: number;
    root: string; files: string[]; truncated: boolean; error: boolean;
  } | null>(null);
  const visible = focused && open && !disabled;
  const current = result?.api === api && result.paneId === paneId && result.query === query && result.refreshToken === refreshToken ? result : null;
  const files = current?.files ?? [];

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setResult(null);
    setActive(0);
    const timer = window.setTimeout(() => {
      api.fetchWorkspaceFiles(paneId, query).then((data) => {
        if (!cancelled) setResult({ ...data, api, paneId, query, refreshToken, error: false });
      }).catch(() => {
        if (!cancelled) setResult({ api, paneId, query, refreshToken, root: "", files: [], truncated: false, error: true });
      });
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, paneId, query, refreshToken, visible]);

  // Bind to this Files surface only; a terminal elsewhere never loses Mod+P.
  useEffect(() => {
    const dialog = input.current?.closest(".files-dialog[role='dialog']");
    if (!dialog || disabled) return;
    const onKey = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.defaultPrevented || key.isComposing || key.altKey || key.shiftKey || !(key.metaKey || key.ctrlKey) || key.key.toLowerCase() !== "p") return;
      if (!(key.target instanceof Node) || !dialog.contains(key.target)) return;
      key.preventDefault();
      key.stopPropagation();
      onReveal?.();
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); setOpen(true); });
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [disabled, onReveal]);

  useEffect(() => {
    const container = list.current;
    const option = container?.children[active];
    if (!container || !(option instanceof HTMLElement)) return;
    // Reveal within the floating list only, never scroll its dialog ancestors.
    const bounds = container.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
  }, [active, visible, files]);

  const choose = (file: string) => {
    if (!current || disabled) return;
    const separator = current.root.includes("\\") && !current.root.includes("/") ? "\\" : "/";
    const absolute = current.root.replace(/[\\/]+$/, "") + separator + file.replace(/^[\\/]+/, "");
    setOpen(false);
    onSelect(absolute);
  };

  return <div className="workspace-file-search">
    <div className="workspace-file-search-field">
      <Search aria-hidden="true" />
      <input ref={input} className="input workspace-file-search-input" type="text" role="combobox"
        aria-label={t("Find files…")} placeholder={t("Find files…")} autoComplete="off" spellCheck={false}
        aria-autocomplete="list" aria-expanded={visible} aria-controls={visible ? id : undefined}
        aria-activedescendant={visible && files[active] !== undefined ? `${id}-${active}` : undefined}
        disabled={disabled} value={query}
        onFocus={() => { setFocused(true); setOpen(true); }}
        onBlur={() => { setFocused(false); setOpen(false); }}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); setQuery(""); setOpen(false); setResult(null);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation(); setOpen(true);
            if (files.length) setActive((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + files.length) % files.length);
          } else if (event.key === "Enter" && visible) {
            event.preventDefault(); event.stopPropagation();
            if (files[active] !== undefined) choose(files[active]);
          }
        }} />
    </div>
    {visible && <div className="workspace-file-search-results">
      <ul ref={list} id={id} role="listbox" aria-label={t("Find files…")} className="workspace-file-search-list">
        {files.map((file, index) => <li key={file} id={`${id}-${index}`} role="option" aria-selected={active === index}
          className="workspace-file-search-option" onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActive(index)} onClick={() => choose(file)} title={file}><span>{file}</span></li>)}
      </ul>
      {!current && <p className="workspace-file-search-status" role="status">{t("Loading…")}</p>}
      {current?.error && <p className="workspace-file-search-error" role="alert">{t("Could not load files")}</p>}
      {current && !current.error && !files.length && <p className="workspace-file-search-status" role="status">{t("No matches")}</p>}
      {current?.truncated && <p className="workspace-file-search-status" role="status">{t("More results available. Refine your search.")}</p>}
    </div>}
  </div>;
}
