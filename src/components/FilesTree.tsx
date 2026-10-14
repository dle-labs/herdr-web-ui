import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { DirectoryListing, RepoDiffFile } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { reviewNotes } from "../lib/reviewNotes.ts";
import { STATUS_MARK, repositoryFilePath, statusWord } from "../lib/repoDiff.ts";
import { FileGlyph } from "./FileGlyph.tsx";

const MAX_OPEN_DIRECTORIES = 24;
const MAX_VISIBLE_ROWS = 2000;
const within = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);

/** Lazy directory endpoint, not a second inventory. Closed branches release their listings. */
export function FilesTree({ root, paneId, changes, selected, reveal, refresh, onOpen }: {
  root: string; paneId: string; changes: readonly RepoDiffFile[]; selected: string | null; reveal: string | null; refresh: number; onOpen: (path: string) => void;
}) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const surface = useRef<HTMLElement>(null);
  const [listings, setListings] = useState<Map<string, DirectoryListing | "failed">>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [limited, setLimited] = useState(false);
  const pending = useRef(new Map<string, object>());
  const owner = useRef<unknown>(null);
  const revealedOwner = useRef<unknown>(null);
  const read = useCallback((relative: string): void => {
    if (pending.current.has(relative)) return;
    const token = {};
    pending.current.set(relative, token);
    const accept = (listing: DirectoryListing | "failed"): void => {
      if (pending.current.get(relative) === token) setListings((current) => new Map(current).set(relative, listing));
    };
    void fetchDirectories(relative ? repositoryFilePath(root, relative) : root, true, true, paneId)
      .then(accept, () => accept("failed"))
      .finally(() => { if (pending.current.get(relative) === token) pending.current.delete(relative); });
  }, [root, paneId, fetchDirectories]);
  useEffect(() => {
    const paths = owner.current === read ? expanded : new Set([""]);
    owner.current = read;
    pending.current.clear(); setListings(new Map()); setExpanded(paths); setLimited(false);
    for (const path of paths) read(path);
    return () => { pending.current.clear(); };
  }, [root, paneId, refresh, read]);
  useEffect(() => {
    const sameOwner = revealedOwner.current === read;
    revealedOwner.current = read;
    if (!reveal) return;
    const parts = reveal.split("/"); parts.pop();
    const paths = new Set([""]);
    for (let index = 1; index <= parts.length && paths.size < MAX_OPEN_DIRECTORIES; index++) paths.add(parts.slice(0, index).join("/"));
    // Keep independent expansions until the bound is reached; only then prefer the revealed chain.
    const combined = new Set([...(sameOwner ? expanded : []), ...paths]);
    const next = combined.size <= MAX_OPEN_DIRECTORIES ? combined : paths;
    for (const path of pending.current.keys()) if (!next.has(path)) pending.current.delete(path);
    setExpanded(next); setLimited(parts.length + 1 > MAX_OPEN_DIRECTORIES);
    setListings((current) => new Map([...current].filter(([path]) => next.has(path))));
    for (const path of paths) if (!sameOwner || !listings.has(path)) read(path);
  }, [reveal, read, refresh]);
  useEffect(() => {
    if (reveal) surface.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [reveal, listings, expanded]);
  const change = new Map(changes.map((file) => [file.path, file]));
  let rows = 0;
  let rowsLimited = false;
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
        if (rows >= MAX_VISIBLE_ROWS) { rowsLimited = true; return null; } rows++;
        const path = prefix + name, open = expanded.has(path);
        const changed = changes.some((file) => file.path.startsWith(`${path}/`));
        return <li key={`d:${path}`}><button type="button" className="files-tree-row" style={{ "--depth": depth } as CSSProperties} aria-expanded={open} onClick={() => {
          if (!reviewNotes.guard()) return;
          if (!open && expanded.size >= MAX_OPEN_DIRECTORIES) { setLimited(true); return; }
          setLimited(false);
          if (open) {
            for (const key of pending.current.keys()) if (within(key, path)) pending.current.delete(key);
            setExpanded((current) => new Set([...current].filter((key) => !within(key, path))));
            setListings((current) => new Map([...current].filter(([key]) => !within(key, path))));
          } else { setExpanded((current) => new Set([...current, path])); read(path); }
        }}><span className="files-tree-caret">{open ? <ChevronDown /> : <ChevronRight />}</span><FileGlyph name={name} kind="directory" /><span>{name}</span>{changed && <span className="files-tree-changed" title={t("Changed files")}><GitBranch aria-hidden="true" /><span className="visually-hidden">{t("Changed files")}</span></span>}</button>{open && children(path, depth + 1)}</li>;
      })}
      {[...files].sort().map((name) => {
        if (rows >= MAX_VISIBLE_ROWS) { rowsLimited = true; return null; } rows++;
        const path = prefix + name, file = change.get(path);
        return <li key={`f:${path}`}><button type="button" className={`files-tree-row${selected === path ? " is-selected" : ""}`} style={{ "--depth": depth } as CSSProperties} data-path={path} onClick={() => onOpen(path)} title={path}>
          <span className="files-tree-caret" /><FileGlyph name={name} /><span>{name}</span>{file && <span className="files-tree-status" data-status={file.status} title={statusWord(t, file.status)}>{STATUS_MARK[file.status]}<span className="visually-hidden">{statusWord(t, file.status)}</span></span>}
        </button></li>;
      })}
      {typeof listing === "object" && listing.truncated && <li className="files-tree-note" role="status">{t("This folder listing is incomplete. Find files searches the workspace inventory.")}</li>}
    </ul>;
  };
  const tree = children("", 0);
  return <nav ref={surface} className="files-tree" aria-label={t("Workspace files")}><p className="files-tree-root" title={root}>{root}</p>{tree}{(limited || rowsLimited) && <p className="files-tree-note" role="status">{t("Collapse folders to show more. Find files also searches unopened folders.")}</p>}</nav>;
}
