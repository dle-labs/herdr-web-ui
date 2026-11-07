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

## Performance

Consolidation removes the duplicate highlighting stack; it is not a demonstrated
speed improvement. Tokenizer cost varies by input and engine, so even short chat
blocks stay off the main thread. Bundle size and end-to-end browser/mobile
performance require separate measurements.
