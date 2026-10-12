import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { OpenFileContext } from "../lib/filePaths.ts";
import { resolveFromDocument } from "../lib/fileReader.ts";
import type { Lines } from "../lib/highlight.ts";
import type { MarkdownBlock } from "../lib/markdown.ts";
import { useSettings, type MarkdownWidth } from "../lib/settings.ts";
import { CodeLines } from "./HighlightedCode.tsx";
import { ParsedMarkdown } from "./Markdown.tsx";

/** The stored width is a setting's value, not a class name. */
const MARKDOWN_CLASS: Record<MarkdownWidth, string> = {
  readable: "file-viewer-markdown file-viewer-markdown-readable",
  full: "file-viewer-markdown",
};

export interface TextFileViewProps {
  path: string;
  /** Preview blocks parsed in a worker with source lines; null shows the code. */
  blocks: MarkdownBlock[] | null;
  lines: Lines;
  onOpen: (path: string) => void;
  /** Code pre for Copy's selection fallback. */
  sourceRef: RefObject<HTMLPreElement>;
  /** Preview root for comment selection measurements. */
  previewRef: RefObject<HTMLDivElement>;
}

/** Markdown rendered with source anchors, or code with line numbers. */
export function TextFileView({ path, blocks, lines, onOpen, sourceRef, previewRef }: TextFileViewProps) {
  const { settings } = useSettings();
  // Polls supply a new onOpen: keep the context stable while its file is unchanged.
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => { onOpenRef.current = onOpen; });
  const openLink = useCallback((href: string) => onOpenRef.current(resolveFromDocument(path, href)), [path]);
  return <div className="file-viewer-content">
    {blocks !== null
      ? <OpenFileContext.Provider value={openLink}><ParsedMarkdown ref={previewRef} className={MARKDOWN_CLASS[settings.markdownWidth]} blocks={blocks} /></OpenFileContext.Provider>
      : <CodeLines ref={sourceRef} className="file-viewer-text" lines={lines} open={null} lineNumbers wrap={settings.wrapCode} firstLine={1} />}
  </div>;
}
