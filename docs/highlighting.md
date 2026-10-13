# Syntax highlighting

Files, diffs and Markdown code blocks use Shiki through `@pierre/diffs`. Pierre
1.5.2 accepts `preferredHighlighter: "shiki-js" | "shiki-wasm"`; its highlighter
contract is Shiki-specific, not a pluggable TanStack tokenizer. We use its default
JavaScript engine. Sharing an engine/library does not share an instance across
worker realms: each worker initializes its own instance.

## Boundaries

- `src/lib/highlight.ts` is pure language policy and source/run conversion. It
  imports no tokenizer or grammar. Existing application names such as `ts`, `js`,
  `shell` and `env` stay stable.
- `src/lib/pierreHighlight.ts` runs only in the highlighting worker. It maps those
  names to Shiki, loads grammars lazily, and emits compact transferable role runs.
  Pierre's resolvers reject browser-worker contexts, so this worker obtains the
  shared Shiki instance without languages/themes and uses Shiki's own loaders
  with the raw application theme. EJS has no bundled Shiki grammar and stays
  plain rather than failing a load.
- `src/lib/pierreTheme.ts` registers `herdr`. Import it before mounting a Pierre
  provider; the pool resolves the theme on the main thread and sends it to its
  workers. Import it only from lazy viewer code or the highlighting worker, not
  from the lightweight language helpers.
- Theme rules emit `var(--syntax-*)`, not resolved colors. The worker maps these
  known strings back to semantic roles, so the application palette can change
  without retokenizing chat blocks.
- Chat highlighting is always asynchronous, even for short input. The existing
  serial queue gives a job two seconds including initialization, terminates a
  stalled worker and recreates it for the next job. It preserves cancellation of
  queued jobs, failure caching, a four-Mi-character source-weighted cache, the
  100-Ki-character chat cap and the 20,000-line DOM cap.
- Pierre's pool initialization timeout is **not** a render timeout. Its cache is
  entry-count-based. Do not infer chat's hard job deadline or memory policy from
  the viewer pool; keep explicit viewer input and line-length limits.

## Measurements, not a speed claim

A local Linux Bun 1.4.2 microbenchmark compared TanStack Highlight 1.0.0 with
Pierre 1.5.2 / Shiki 4.5.0. Each engine ran in a fresh process. Numbers below are
median milliseconds of five warm tokenizations after one warm-up. They exclude
DOM rendering, worker transport, our compact-run conversion, and token-length
cutoffs. They are not browser/mobile or end-to-end viewer measurements.

| Source | TanStack | Shiki JS | Shiki WASM |
| --- | ---: | ---: | ---: |
| 2,048 characters TypeScript | 0.30 | 3.77 | 5.28 |
| 102,400 characters TypeScript | 6.86 | 152.37 | 170.02 |
| 1,048,576 characters TypeScript | 63.52 | 1,513.59 | 1,646.23 |
| 2,048 characters JSON escapes | 5.18 | 0.43 | 0.70 |
| 2,048 YAML dashes | 4.23 | 27.12 | 0.88 |

Fixtures: repeat and slice
`export function greet(name: string): string { return \`hello ${name}\`; } // comment\n`
to the indicated lengths; repeat the two characters double-quote/backslash 1,024
times for JSON; repeat `--` 1,024 times for YAML. Compare TanStack `tokenize` with
Shiki `codeToTokens` using `pierre-dark`, after loading TypeScript, JSON and YAML.

Measured import plus three-language/theme initialization was respectively
2.15 / 58.73 / 72.33 ms. These include differently scoped imports and are not
isolated engine initialization measurements. A 1,000-character viewer
`tokenizeMaxLineLength` excludes the pathological 2,048-character lines above.

Consolidation improves consistency and removes the duplicate highlighting stack;
it is not a demonstrated speed improvement. Shiki JS was quicker than Shiki WASM
on the ordinary code fixture, while WASM handled the pathological YAML fixture much better. This
is why short code no longer has a synchronous main-thread fast path. Bundle-size
and real-browser performance changes must be measured separately.
