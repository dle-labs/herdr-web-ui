# File review comparison video

Records the current client against isolated fictional demo data, then composes a
60-second desktop/mobile comparison. No live herdr session is used.

Requirements: Bun, installed project dependencies, Chrome (`CHROME_PATH` overrides
`/usr/bin/google-chrome`), FFmpeg, and ffprobe. Run from the repository root:

```sh
bun scripts/file-diff-showcase/capture.ts desktop
bun scripts/file-diff-showcase/capture.ts mobile
bun scripts/file-diff-showcase/render.ts --check
bun scripts/file-diff-showcase/render.ts --stills
bun scripts/file-diff-showcase/render.ts
```

`capture.ts desktop --probe` (or `mobile --probe`) captures the opening browser and
file-search result without replacing a complete take. Captures use fresh client
builds, independent browser storage, and ephemeral loopback servers. Mobile uses
Chromium touch emulation; it does not validate Safari or physical-device keyboards.

Raw frames, pointer/touch cues, milestone timestamps and verification results go
to `_film/file-diff-showcase/takes/`. The final MP4, poster, timing report and
manifest go to `_film/file-diff-showcase/output/`. All media is gitignored.

The render preserves both panels throughout. It aligns chapter starts and results,
slows short interactions for legibility, and holds early results. It does not
accelerate actions or hide the mobile navigation required to reach them. Inspect
the stills and the full video before sharing; workflow assertions do not establish
visual quality. Uploading to GitHub is a separate manual action.
