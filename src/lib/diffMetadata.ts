import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { GitDiffMode, GitFileDiffResponse } from "../../shared/protocol.ts";

/** Consume Git's bounded patch, never run a second (potentially quadratic) diff.
 * Hydration restores coordinates outside the patch's context windows. */
export function diffMetadata(file: GitFileDiffResponse, mode: GitDiffMode): FileDiffMetadata | null {
  if (file.binary) return null;
  const cacheKey = JSON.stringify([file.root, mode, file.revision, file.old_path, file.path]);
  const parsed = parsePatchFiles(file.patch, cacheKey, true).flatMap((patch) => patch.files);
  if (parsed.length > 1) throw new Error("Expected a single file patch");
  const metadata: FileDiffMetadata = parsed[0] ?? {
    name: file.path, type: "change", isPartial: true, hunks: [],
    additionLines: [], deletionLines: [], splitLineCount: 0, unifiedLineCount: 0, cacheKey,
  };
  // hydratePartialDiff accepts only two-sided changes or pure renames. Treat
  // missing sides as empty while hydrating, then restore their actual type.
  const type = file.old_file === null ? "new" : file.new_file === null ? "deleted"
    : file.old_path !== undefined && file.old_path !== file.path
      ? file.old_file.contents === file.new_file.contents ? "rename-pure" : "rename-changed" : metadata.type;
  metadata.type = "change";
  hydratePartialDiff("merge", metadata, {
    oldFile: file.old_file ?? { name: file.old_path ?? file.path, contents: "" },
    newFile: file.new_file ?? { name: file.path, contents: "" },
  });
  metadata.type = type;
  metadata.name = file.path;
  metadata.prevName = file.old_path;
  // Empty/untracked, pure rename and mode-only patches have no hunks. Give
  // the renderer an explicit full-file region, preserving unchanged lines.
  if (metadata.hunks.length === 0) {
    const additions = metadata.additionLines.length;
    const deletions = metadata.deletionLines.length;
    const unchanged = file.old_file?.contents === file.new_file?.contents;
    const split = Math.max(additions, deletions);
    const unified = unchanged ? additions : additions + deletions;
    if (split > 0) metadata.hunks.push({
      collapsedBefore: 0, additionStart: additions ? 1 : 0, deletionStart: deletions ? 1 : 0,
      additionCount: additions, deletionCount: deletions, additionLines: unchanged ? 0 : additions,
      deletionLines: unchanged ? 0 : deletions, additionLineIndex: 0, deletionLineIndex: 0,
      splitLineStart: 0, unifiedLineStart: 0, splitLineCount: split, unifiedLineCount: unified,
      noEOFCRAdditions: !!file.new_file?.contents && !file.new_file.contents.endsWith("\n"),
      noEOFCRDeletions: !!file.old_file?.contents && !file.old_file.contents.endsWith("\n"),
      hunkContent: [unchanged
        ? { type: "context", lines: additions, additionLineIndex: 0, deletionLineIndex: 0 }
        : { type: "change", additions, deletions, additionLineIndex: 0, deletionLineIndex: 0 }],
    });
    metadata.splitLineCount = split;
    metadata.unifiedLineCount = unified;
  }
  return metadata;
}
