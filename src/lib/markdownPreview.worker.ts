// Parses a Markdown file for the viewer's Preview off the page (src/lib/markdownPreview.ts): an
// input the parser handles slowly stalls this worker, which is ended past its budget, never the tab.
// The blocks carry their source lines, which the viewer's comments anchor to.
import { parseMarkdownWithLines, type MarkdownBlock } from "./markdown.ts";
import { serveOffThread } from "./offThread.ts";

serveOffThread<string, MarkdownBlock[]>((text) => ({ result: parseMarkdownWithLines(text) }));
