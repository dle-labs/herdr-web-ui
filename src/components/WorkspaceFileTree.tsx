import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Database, File, FileArchive, FileAudio, FileCode, FileJson, FileText, FileType, FileVideo, Folder, FolderOpen, GitBranch, Image, LockKeyhole, NotebookText, FileSliders, FileTerminal, Type } from "lucide-react";
import { GitCompareArrows } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { fileIconCategory, type FileIconCategory } from "../lib/fileTypeIcon.ts";
import type { DirectoryListing, GitChangedFile } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { workspaceChildPath as join, workspaceTreeEntries } from "../lib/workspaceFileTree.ts";
import "./WorkspaceFileTree.css";
interface Props {
  root: string; paneId: string | null; files: readonly GitChangedFile[];
  selected: string | null; onSelect: (absolutePath: string) => void;
  refreshToken?: number;
  /** Explicit reveal also reopens manually collapsed ancestors and focuses the lazy row. */
  revealToken?: number;
  onCompare?: (relativePath: string) => void;
  onFileMenu?: (anchor: HTMLButtonElement, path: string, point?: { x: number; y: number }) => void;
}

const FILE_ICONS: Record<FileIconCategory, LucideIcon> = {
  code: FileCode, config: FileSliders, json: FileJson, markdown: NotebookText,
  text: FileText, image: Image, audio: FileAudio, video: FileVideo,
  pdf: FileType, archive: FileArchive, shell: FileTerminal, database: Database,
  font: Type, lock: LockKeyhole, git: GitBranch, file: File,
};

/** Directory reads happen only for expanded branches; inventory supplies missing/deleted entries. */
export function WorkspaceFileTree(props: Props) {
  const t = useT();
  const navigation = useRef<HTMLElement>(null);
  const handledReveal = useRef(0);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; path: string; point?: { x: number; y: number } } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [menu]);
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const reveal = () => {
      const row = nav.querySelector<HTMLElement>('[aria-current="true"]');
      if (!row) return;
      const bounds = nav.getBoundingClientRect();
      const item = row.getBoundingClientRect();
      if (bounds.height === 0 || item.height === 0) return;
      if ((props.revealToken ?? 0) !== handledReveal.current) {
        handledReveal.current = props.revealToken ?? 0;
        row.focus({ preventScroll: true });
      }
      if (item.top < bounds.top) nav.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom;
    };
    reveal();
    // Selected ancestors expand asynchronously; reveal when their lazy rows arrive too.
    const observer = new MutationObserver(reveal);
    observer.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    return () => observer.disconnect();
  }, [props.selected, props.revealToken]);
  return <nav ref={navigation} className="workspace-file-tree" aria-label={t("Files")}>
    <Directory key={props.root} {...props} relative="" onFileMenu={props.onCompare ? (anchor, path, point) => setMenu({ anchor, path, point }) : undefined} />
    {menu && props.onCompare && <div ref={menuRef} className="workspace-file-menu" role="menu" aria-label={menu.path}
      style={{ left: Math.max(8, Math.min(menu.point?.x ?? menu.anchor.getBoundingClientRect().left, window.innerWidth - 220)), top: Math.max(8, Math.min(menu.point?.y ?? menu.anchor.getBoundingClientRect().bottom, window.innerHeight - 60)) }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(null); menu.anchor.focus(); } }}>
      <button type="button" role="menuitem" className="btn" onClick={() => { const path = menu.path; setMenu(null); props.onCompare?.(path); }}><GitCompareArrows aria-hidden="true" />{t("Compare with…")}</button>
    </div>}
  </nav>;
}

function Directory({ root, paneId, files, selected, onSelect, onCompare, onFileMenu, refreshToken, revealToken, relative, ignored = false, containsChanges = false }: Props & { relative: string; ignored?: boolean; containsChanges?: boolean }) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const absolute = relative ? join(root, relative) : root;
  const containsSelected = selected?.startsWith(`${absolute.replace(/[\\/]$/, "")}/`) === true;
  const [open, setOpen] = useState(relative === "" || containsSelected);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (containsSelected) setOpen(true); }, [containsSelected, revealToken]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    fetchDirectories(absolute, true, true, paneId).then((next) => {
      if (active) setListing(next);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [absolute, fetchDirectories, paneId, open, attempt, refreshToken]);
  // An empty or home-relative start is resolved by the bridge even outside a Git repository.
  const resolvedRoot = relative === "" ? listing?.path ?? root : root;
  const entries = workspaceTreeEntries(listing, files, relative, ignored);
  const prefix = relative ? `${relative}/` : "";
  return <div className="workspace-tree-branch">
    {relative !== "" && <button type="button" className="workspace-tree-row" data-ignored={ignored || undefined} data-contains-changes={containsChanges || undefined} title={relative} aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{open ? <FolderOpen className="workspace-tree-icon" data-file-type="folder" aria-hidden="true" /> : <Folder className="workspace-tree-icon" data-file-type="folder" aria-hidden="true" />}<span className="workspace-tree-label">{relative.split("/").at(-1)}</span>
      {containsChanges && <small role="img" aria-label={t("Changed files")} title={t("Changed files")}>*</small>}
    </button>}
    {open && <div className={relative ? "workspace-tree-children" : undefined}>
      {listing === null && !failed && <p role="status">{t("Loading…")}</p>}
      {failed && <p role="alert">{t("Folders could not be loaded.")} <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>{t("Retry")}</button></p>}
      {entries.map(([name, entry]) => {
        const path = `${prefix}${name}`;
        const category = fileIconCategory(name);
        const Icon = FILE_ICONS[category];
        return entry.directory ? <Directory key={name} root={resolvedRoot} paneId={paneId} files={files} selected={selected} onSelect={onSelect} onCompare={onCompare} onFileMenu={onFileMenu} refreshToken={refreshToken} revealToken={revealToken} relative={path} ignored={entry.ignored} containsChanges={entry.containsChanges} />
          : <button key={name} type="button" className="workspace-tree-row" data-status={entry.status} data-ignored={entry.ignored || undefined} aria-current={selected === join(resolvedRoot, path) ? "true" : undefined} title={path} onContextMenu={(event) => { if (onFileMenu) { event.preventDefault(); event.stopPropagation(); onFileMenu(event.currentTarget, path, { x: event.clientX, y: event.clientY }); } }} onKeyDown={(event) => { if (onFileMenu && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) { event.preventDefault(); event.stopPropagation(); onFileMenu(event.currentTarget, path); } }} onClick={() => onSelect(join(resolvedRoot, path))}>
            <span className="workspace-tree-caret" aria-hidden="true" /><Icon className="workspace-tree-icon" data-file-type={category} aria-hidden="true" /><span className="workspace-tree-label">{name}</span>{entry.status && <small aria-label={entry.status}>{entry.status === "deleted" ? "D" : entry.status === "added" || entry.status === "untracked" ? "A" : entry.status === "renamed" ? "R" : "M"}</small>}
          </button>;
      })}
      {listing?.truncated && <p role="status">{t("This folder listing is incomplete.")}</p>}
    </div>}
  </div>;
}
