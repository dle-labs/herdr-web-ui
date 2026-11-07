// Highlights code off the page (src/lib/highlightOffThread.ts): a quadratic input stalls this
// worker, which is ended past its budget, never the tab.
import type { Runs } from "./highlight.ts";
import { highlightRuns } from "./pierreHighlight.ts";
import { serveOffThread } from "./offThread.ts";

serveOffThread<{ source: string; language: string }, Runs>(async ({ source, language }) => {
  const runs = await highlightRuns(source, language);
  return { result: runs, transfer: [runs.lengths.buffer, runs.roles.buffer] };
});
