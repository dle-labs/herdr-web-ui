import { useEffect, useMemo, useRef } from "react";
import { blockComments, useBlockComments } from "../lib/blockComments.ts";
import { placeFileComment, type FileComment, type FileView, type LineRange } from "../lib/fileComments.ts";

/** Canonical file coordinates, scoped to the pane and machine that opened it. */
export interface FileCommentScope {
  owner: string;
  path: string;
  label: string;
  view: FileView;
  lines: readonly string[];
  /** Only complete loaded lines may receive comments. */
  loaded: number;
  truncated: boolean;
}
export interface PlacedFileComment { comment: FileComment; lines: LineRange }
export interface FileComments {
  shown: PlacedFileComment[];
  outdated: FileComment[];
  all: FileComment[];
}

/** Preserve saved source and legacy preview notes, relocating only unambiguous whole-file matches. */
export function useFileComments(scope: FileCommentScope | null): FileComments {
  const stored = useBlockComments(scope?.owner ?? "");
  const owner = scope?.owner;
  const path = scope?.path;
  const lines = scope?.lines;
  const loaded = scope?.loaded ?? 0;
  const truncated = scope?.truncated ?? false;
  const all = useMemo(() => path === undefined ? [] : stored.filter((c): c is FileComment => c.kind === "file" && c.diff === undefined && c.path === path), [stored, path]);
  const placed = useMemo(() => all.map((comment) => ({ comment, lines: lines === undefined ? null : placeFileComment(comment, lines, loaded, truncated) })), [all, lines, loaded, truncated]);
  const moved = useRef(new Set<string>());
  useEffect(() => {
    if (owner === undefined) return;
    for (const { comment, lines: now } of placed) {
      if (now === null || (now[0] === comment.lines[0] && now[1] === comment.lines[1])) continue;
      const key = `${owner}:${comment.id}:${now[0]}-${now[1]}`;
      if (moved.current.has(key)) continue;
      moved.current.add(key);
      blockComments.moveFile(owner, comment.id, now);
    }
  }, [owner, placed]);
  return useMemo(() => ({
    shown: placed.filter((p): p is PlacedFileComment => p.lines !== null),
    outdated: placed.filter((p) => p.lines === null).map((p) => p.comment),
    all,
  }), [placed, all]);
}
