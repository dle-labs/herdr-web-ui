import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Database, File, FileArchive, FileAudio, FileCode, FileJson, FileText, FileType, FileVideo, Folder, FolderOpen, GitBranch, Image, LockKeyhole, NotebookText, FileSliders, FileTerminal, Type } from "lucide-react";
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
  useEffect(() => {
    const nav = navigation.current;
    if (!nav) return;
    const reveal = () => {
      const row = nav.querySelector<HTMLElement>('[aria-current="true"]');
      if (!row) return;
      const bounds = nav.getBoundingClientRect();
      const item = row.getBoundingClientRect();
      if (item.top < bounds.top) nav.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom;
    };
    reveal();
    // Selected ancestors expand asynchronously; reveal when their lazy rows arrive too.
    const observer = new MutationObserver(reveal);
    observer.observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    return () => observer.disconnect();
  }, [props.selected]);
  return <nav ref={navigation} className="workspace-file-tree" aria-label={t("Files")}>
    <Directory key={props.root} {...props} relative="" />
  </nav>;
}

function Directory({ root, paneId, files, selected, onSelect, refreshToken, relative, ignored = false }: Props & { relative: string; ignored?: boolean }) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const absolute = relative ? join(root, relative) : root;
  const containsSelected = selected?.startsWith(`${absolute.replace(/[\\/]$/, "")}/`) === true;
  const [open, setOpen] = useState(relative === "" || containsSelected);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (containsSelected) setOpen(true); }, [containsSelected]);
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
    {relative !== "" && <button type="button" className="workspace-tree-row" data-ignored={ignored || undefined} title={relative} aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{open ? <FolderOpen className="workspace-tree-icon" data-file-type="folder" aria-hidden="true" /> : <Folder className="workspace-tree-icon" data-file-type="folder" aria-hidden="true" />}<span className="workspace-tree-label">{relative.split("/").at(-1)}</span>
    </button>}
    {open && <div className={relative ? "workspace-tree-children" : undefined}>
      {listing === null && !failed && <p role="status">{t("Loading…")}</p>}
      {failed && <p role="alert">{t("Folders could not be loaded.")} <button className="btn" type="button" onClick={() => setAttempt((n) => n + 1)}>{t("Retry")}</button></p>}
      {entries.map(([name, entry]) => {
        const path = `${prefix}${name}`;
        const category = fileIconCategory(name);
        const Icon = FILE_ICONS[category];
        return entry.directory ? <Directory key={name} root={resolvedRoot} paneId={paneId} files={files} selected={selected} onSelect={onSelect} refreshToken={refreshToken} relative={path} ignored={entry.ignored} />
          : <button key={name} type="button" className="workspace-tree-row" data-status={entry.status} data-ignored={entry.ignored || undefined} aria-current={selected === join(resolvedRoot, path) ? "true" : undefined} title={path} onClick={() => onSelect(join(resolvedRoot, path))}>
            <span className="workspace-tree-caret" aria-hidden="true" /><Icon className="workspace-tree-icon" data-file-type={category} aria-hidden="true" /><span className="workspace-tree-label">{name}</span>{entry.status && <small aria-label={entry.status}>{entry.status === "deleted" ? "D" : entry.status === "added" || entry.status === "untracked" ? "A" : entry.status === "renamed" ? "R" : "M"}</small>}
          </button>;
      })}
      {listing?.truncated && <p role="status">{t("This folder listing is incomplete.")}</p>}
    </div>}
  </div>;
}
