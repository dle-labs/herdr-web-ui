// Parses a Markdown file for Preview off the page: slow input stalls only this worker,
// which is ended past its budget. Blocks retain source lines for viewer comments.
// Refuse a Preview that would draw too much on the page (PREVIEW_ELEMENT_LIMIT).
import { parseMarkdownWithLines, type MarkdownBlock } from "./markdown.ts";
import { serveOffThread } from "./offThread.ts";
import { PREVIEW_ELEMENT_LIMIT, previewElements } from "./textPreview.ts";

serveOffThread<string, MarkdownBlock[] | null>((text) => {
  const blocks = parseMarkdownWithLines(text);
  return { result: previewElements(blocks) > PREVIEW_ELEMENT_LIMIT ? null : blocks };
});
