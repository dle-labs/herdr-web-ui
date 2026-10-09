/**
 * The file and lines a comment on a file is on, as a comment's popover, card and editor name them.
 */
import "./FileReference.css";

import type { LineRange } from "../lib/fileComments.ts";
import { pathParts } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";

/** The lines of a file a comment is on. */
export interface FileReference {
  path: string;
  lines: LineRange;
}

/**
 * The file and lines a comment is on, "plan.md · Lines 42–44": the file's name with the full path
 * as its title, and a long name cut inside its stem so its type stays in view (as the file
 * viewer's title, `.file-viewer-stem`).
 */
export function FileReferenceLabel({ reference }: { reference: FileReference }): JSX.Element {
  const t = useT();
  const { stem, extension } = pathParts(reference.path);
  const [first, last] = reference.lines;
  const lines = first === last ? t("Line {line}", { line: first }) : t("Lines {first}–{last}", { first, last });
  return (
    <span className="comment-file-reference" title={reference.path}>
      <span className="comment-file-stem">{stem}</span>
      {/* the extension and the lines never give way */}
      <span className="comment-file-rest">{extension} · {lines}</span>
    </span>
  );
}
