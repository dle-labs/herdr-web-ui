import { useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChevronDown, Circle, FileText, Lock } from "lucide-react";
import { prepareFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitChangedFile } from "../../shared/protocol.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";

function symbol(id: string, svg: string): string {
  return svg.replace(/<svg[^>]*>/, `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`).replace("</svg>", "</symbol>");
}
const icons = {
  set: "none" as const,
  spriteSheet: `<svg>${symbol("changes-file", renderToStaticMarkup(<FileText />))}${symbol("changes-chevron", renderToStaticMarkup(<ChevronDown />))}${symbol("changes-dot", renderToStaticMarkup(<Circle />))}${symbol("changes-lock", renderToStaticMarkup(<Lock />))}</svg>`,
  remap: { "file-tree-icon-file": "changes-file", "file-tree-icon-chevron": "changes-chevron", "file-tree-icon-dot": "changes-dot", "file-tree-icon-lock": "changes-lock" },
};

/** Only Git's bounded changed-path inventory is prepared here, never a filesystem crawl. */
export function ChangesTree({ files, selected, onSelect }: { files: GitChangedFile[]; selected: string | null; onSelect: (path: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const syncing = useRef(false);
  const { settings } = useSettings();
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const filesRef = useRef(files);
  filesRef.current = files;
  const preparedInput = useMemo(() => prepareFileTreeInput(files.map((file) => file.path)), [files]);
  const { model } = useFileTree({
    preparedInput, initialExpansion: "open", search: false, fileTreeSearchMode: "hide-non-matches",
    density: settings.density === "compact" ? "compact" : "default", icons,
    renaming: false, dragAndDrop: false,
    onSelectionChange(paths) {
      if (syncing.current) return;
      const path = [...paths].reverse().find((path) => filesRef.current.some((file) => file.path === path));
      if (path !== undefined) selectRef.current(path);
    },
  });
  useEffect(() => {
    model.resetPaths({ preparedInput });
    model.setGitStatus(files.map((file) => ({ path: file.path, status: file.status === "conflicted" ? "modified" : file.status })));
  }, [model, preparedInput, files]);
  useEffect(() => {
    syncing.current = true;
    for (const path of model.getSelectedPaths()) if (path !== selected) model.getItem(path)?.deselect();
    if (selected !== null) {
      model.getItem(selected)?.select();
      model.scrollToPath(selected, { focus: false, offset: "nearest" });
    }
    syncing.current = false;
  }, [model, selected, preparedInput]);
  return <div className="changes-tree-panel">
    <input type="search" className="input changes-search" aria-label={t("Filter changed files")} placeholder={t("Filter changed files")}
      value={query} onChange={(event) => { setQuery(event.target.value); model.setSearch(event.target.value); }}
      onKeyDown={(event) => { if (event.key === "Escape" && query && !event.nativeEvent.isComposing) { event.stopPropagation(); setQuery(""); model.setSearch(null); } }} />
    <FileTree model={model} className="changes-tree" aria-label={t("Changed files")}
      onClick={(event) => {
        // Selection changes alone omit activation of an already-selected row (notably on phones).
        if (!event.nativeEvent.composedPath().some((node) => node instanceof Element && node.getAttribute("role") === "treeitem")) return;
        const item = model.getFocusedItem();
        if (item && !item.isDirectory()) selectRef.current(item.getPath());
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        const item = model.getFocusedItem();
        if (item && !item.isDirectory()) selectRef.current(item.getPath());
      }} style={{
    "--trees-theme-sidebar-bg": "var(--bg-panel)", "--trees-theme-sidebar-fg": "var(--text)",
    "--trees-theme-list-active-selection-bg": "var(--bg-hover)", "--trees-theme-list-active-selection-fg": "var(--text-strong)",
    "--trees-theme-focus-ring": "var(--accent)", "--trees-theme-list-hover-bg": "var(--bg-hover)",
    "--trees-theme-git-added-fg": "var(--status-done)", "--trees-theme-git-deleted-fg": "var(--status-blocked)",
    "--trees-theme-git-modified-fg": "var(--status-working)",
  } as React.CSSProperties} />
  </div>;
}
