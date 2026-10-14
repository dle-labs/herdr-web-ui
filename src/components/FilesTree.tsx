import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { DirectoryListing, RepoDiffFile } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { reviewNotes } from "../lib/reviewNotes.ts";
import { STATUS_MARK, repositoryFilePath, statusWord } from "../lib/repoDiff.ts";
import { FileGlyph } from "./FileGlyph.tsx";

/** Lazy directory endpoint, not a second filesystem inventory. Deleted entries come from the shared comparison. */
export function FilesTree({ root, paneId, changes, selected, reveal, refresh, onOpen }: {
  root: string; paneId: string; changes: readonly RepoDiffFile[]; selected: string | null; reveal: string | null; refresh: number; onOpen: (path: string) => void;
}) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const [listings, setListings] = useState<Map<string, DirectoryListing | "failed">>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const pending = useRef(new Set<string>());
  const generation = useRef(0);
  const read = useCallback((relative: string): void => {
    if (pending.current.has(relative)) return;
    pending.current.add(relative);
    const token = generation.current;
    void fetchDirectories(relative ? repositoryFilePath(root, relative) : root, true, true, paneId).then(
      (listing) => { if (token === generation.current) setListings((current) => new Map(current).set(relative, listing)); },
      () => { if (token === generation.current) setListings((current) => new Map(current).set(relative, "failed")); },
    ).finally(() => { if (token === generation.current) pending.current.delete(relative); });
  }, [root, paneId, fetchDirectories]);
  useEffect(() => {
    generation.current++; pending.current.clear(); setListings(new Map());
    for (const path of expanded) read(path);
    return () => { generation.current++; pending.current.clear(); };
  }, [root, paneId, refresh, read]);
  useEffect(() => {
    if (!reveal) return;
    const parts = reveal.split("/"); parts.pop();
    const paths = [""];
    for (let index = 1; index <= parts.length; index++) paths.push(parts.slice(0, index).join("/"));
    setExpanded((current) => new Set([...current, ...paths]));
    for (const path of paths) if (!listings.has(path)) read(path);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.files-tree [data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [reveal, read]);
  const change = new Map(changes.map((file) => [file.path, file]));
  const children = (relative: string, depth: number): ReactNode => {
    const listing = listings.get(relative);
    const prefix = relative ? `${relative}/` : "";
    const dirs = new Set(typeof listing === "object" ? listing.directories : []);
    const files = new Set(typeof listing === "object" ? listing.files?.map((file) => file.name) : []);
    for (const file of changes) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length), slash = rest.indexOf("/");
      if (slash !== -1) dirs.add(rest.slice(0, slash)); else files.add(rest);
    }
    return <ul>{listing === undefined && <li className="files-tree-note" role="status">{t("Loading…")}</li>}
      {listing === "failed" && <li className="files-tree-note" role="alert">{t("This folder cannot be opened.")}</li>}
      {[...dirs].sort().map((name) => {
        const path = prefix + name, open = expanded.has(path);
        const changed = changes.some((file) => file.path.startsWith(`${path}/`));
        return <li key={`d:${path}`}><button type="button" className="files-tree-row" style={{ "--depth": depth } as CSSProperties} aria-expanded={open} onClick={() => {
          if (!reviewNotes.guard()) return;
          setExpanded((current) => { const next = new Set(current); if (!next.delete(path)) next.add(path); return next; });
          if (!listings.has(path)) read(path);
        }}><span className="files-tree-caret">{open ? <ChevronDown /> : <ChevronRight />}</span><FileGlyph name={name} kind="directory" /><span>{name}</span>{changed && <span className="files-tree-changed" title={t("Changed files")}><GitBranch aria-hidden="true" /><span className="visually-hidden">{t("Changed files")}</span></span>}</button>{open && children(path, depth + 1)}</li>;
      })}
      {[...files].sort().map((name) => { const path = prefix + name, file = change.get(path); return <li key={`f:${path}`}><button type="button" className={`files-tree-row${selected === path ? " is-selected" : ""}`} style={{ "--depth": depth } as CSSProperties} data-path={path} onClick={() => onOpen(path)} title={path}>
        <span className="files-tree-caret" /><FileGlyph name={name} /><span>{name}</span>{file && <span className="files-tree-status" data-status={file.status} title={statusWord(t, file.status)}>{STATUS_MARK[file.status]}<span className="visually-hidden">{statusWord(t, file.status)}</span></span>}
      </button></li>; })}
      {typeof listing === "object" && listing.truncated && <li className="files-tree-note" role="status">{t("This folder listing is incomplete. Find files searches the workspace inventory.")}</li>}
    </ul>;
  };
  return <nav className="files-tree" aria-label={t("Workspace files")}><p className="files-tree-root" title={root}>{root}</p>{children("", 0)}</nav>;
}
