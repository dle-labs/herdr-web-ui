import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import "./CommandPalette.css";
import "./WorkspaceFileSearch.css";

export interface WorkspaceFileSearchProps {
  paneId: string;
  onSelect: (absolute: string) => void;
  onClose: () => void;
  refreshToken: number;
  keyboardActive: boolean;
}

/** Filename search in a palette above Files, never an inline field in its header. */
export function WorkspaceFileSearch({ paneId, onSelect, onClose, refreshToken, keyboardActive }: WorkspaceFileSearchProps) {
  const t = useT();
  const api = useMachineApi();
  const input = useRef<HTMLInputElement>(null);
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: input, shouldRestore: () => keyboardActive });
  useSheetSwipe(surface, keyboardActive ? onClose : null);
  usePhoneSheetBack(onClose, keyboardActive);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{
    api: typeof api; paneId: string; query: string; refreshToken: number;
    root: string; files: string[]; truncated: boolean; error: boolean;
  } | null>(null);
  const current = result?.api === api && result.paneId === paneId && result.query === query && result.refreshToken === refreshToken ? result : null;
  const files = current?.files ?? [];

  // Escape belongs to the palette even before its input receives focus.
  useLayoutEffect(() => {
    if (!keyboardActive) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || nativeModalOver(surface.current)) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [keyboardActive, onClose]);

  useEffect(() => {
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
  }, [api, paneId, query, refreshToken]);

  useEffect(() => {
    const container = list.current;
    const option = container?.children[active];
    if (!container || !(option instanceof HTMLElement)) return;
    // Reveal within the palette's list only, never scroll its dialog ancestors.
    const bounds = container.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) container.scrollTop += row.bottom - bounds.bottom;
  }, [active, files]);

  const choose = (file: string) => {
    if (!current || !keyboardActive) return;
    const separator = current.root.includes("\\") && !current.root.includes("/") ? "\\" : "/";
    const absolute = current.root.replace(/[\\/]+$/, "") + separator + file.replace(/^[\\/]+/, "");
    onSelect(absolute);
  };

  return <div className="modal-scrim palette-scrim workspace-file-search-scrim" onMouseDown={(event) => {
    if (!keyboardActive || event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  }}>
    <section ref={surface} className="menu command-palette workspace-file-search" role="dialog" aria-modal="true" aria-label={t("Find files…")} tabIndex={-1}>
      <div className="palette-search">
        <input ref={input} className="input" type="text" role="combobox"
          aria-label={t("Find files…")} placeholder={t("Find files…")} autoComplete="off" spellCheck={false}
          aria-autocomplete="list" aria-expanded={true} aria-controls={id}
          aria-activedescendant={files[active] !== undefined ? `${id}-${active}` : undefined}
          value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (!keyboardActive || event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); event.stopPropagation();
              if (files.length) setActive((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + files.length) % files.length);
            } else if (event.key === "Enter") {
              event.preventDefault(); event.stopPropagation();
              if (files[active] !== undefined) choose(files[active]);
            }
          }} />
        <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <ul ref={list} id={id} role="listbox" aria-label={t("Find files…")} className="workspace-file-search-list">
        {files.map((file, index) => <li key={file} id={`${id}-${index}`} role="option" aria-selected={active === index}
          className="workspace-file-search-option" onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => setActive(index)} onClick={() => choose(file)} title={file}><span>{file}</span></li>)}
      </ul>
      {!current && <p className="workspace-file-search-status" role="status">{t("Loading…")}</p>}
      {current?.error && <p className="workspace-file-search-error" role="alert">{t("Could not load files")}</p>}
      {current && !current.error && !files.length && <p className="workspace-file-search-status" role="status">{t("No matches")}</p>}
      {current?.truncated && <p className="workspace-file-search-status" role="status">{t("More results available. Refine your search.")}</p>}
    </section>
  </div>;
}
