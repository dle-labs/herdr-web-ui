import { linesFromRuns, plainLines, type Lines, type Runs } from "./highlight.ts";
import { createOffThreadQueue, type OffThreadJob, type WorkerLike } from "./offThread.ts";

/**
 * Maximum elapsed worker job time, including engine/grammar initialization. Text exceeding the
 * budget stays plain; even short or ordinary input can exceed it on a slow device.
 */
export const HIGHLIGHT_BUDGET_MS = 2_000;

const CACHE_CHARACTERS = 4 * 1024 * 1024;

export class LinesCache {
  private readonly entries = new Map<string, { lines: Lines | null; size: number }>();
  private size = 0;

  constructor(private readonly capacity: number) {}

  get(source: string, language: string): Lines | null | undefined {
    const key = `${language}\u0000${source}`;
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.lines;
  }

  set(source: string, language: string, lines: Lines | null): void {
    if (source.length > this.capacity) return;
    const key = `${language}\u0000${source}`;
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.entries.delete(key);
      this.size -= old.size;
    }
    this.entries.set(key, { lines, size: source.length });
    this.size += source.length;
    for (const [oldest, entry] of this.entries) {
      if (this.size <= this.capacity) break;
      this.entries.delete(oldest);
      this.size -= entry.size;
    }
  }
}

const cache = new LinesCache(CACHE_CHARACTERS);

const queue = createOffThreadQueue<{ source: string; language: string }, Runs>(
  () => new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  HIGHLIGHT_BUDGET_MS,
);

export interface Highlighted {
  lines: Lines;
  tooLong: boolean;
}

export function highlightedFrom(source: string, lines: Lines | null): Highlighted {
  return lines === null ? { lines: plainLines(source), tooLong: true } : { lines, tooLong: false };
}

/**
 * A previously completed worker result, or `null` to ask `highlightOffThread`.
 * Never tokenizes on the calling thread, regardless of source length.
 */
export function highlightKnown(source: string, language: string): Highlighted | null {
  const cached = cache.get(source, language);
  return cached === undefined ? null : highlightedFrom(source, cached);
}

export function highlightOffThread(source: string, language: string): OffThreadJob<Lines> {
  const job = queue({ source, language });
  let dropped = false;
  return {
    cancel: () => {
      if (job.cancel()) dropped = true;
      return dropped;
    },
    promise: job.promise.then((runs) => {
      const lines = runs === null ? null : linesFromRuns(source, runs);
      if (!dropped) cache.set(source, language, lines);
      return lines;
    }),
  };
}
