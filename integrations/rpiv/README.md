# Opt-in RPIV bridge (experimental)

This is a reviewable patch for **@juicesharp/rpiv-ask-user-question 2.12.0**, not a replacement package or an automatic installer. The WebUI alone does not patch Pi. Unpatched, unsupported or unverified questionnaires remain terminal-only.

## DLE Labs fork

The adapter is also packaged in [dle-labs/rpiv-mono](https://github.com/dle-labs/rpiv-mono) as `@dle-labs/rpiv`; see its [installation and rollback instructions](https://github.com/dle-labs/rpiv-mono/blob/main/FORK.md). Installing that repository loads only the patched questionnaire, not the rest of the RPIV suite or RPIV Voice. Replace the upstream questionnaire package declaration rather than enabling both. Existing Pi sessions still need a reload or restart after active tool calls finish.

## Manual installation, with separate approval

1. Stop the Pi sessions you intend to change. Keep the original package intact. Obtain a separate copy of exactly version 2.12.0 and check its package.json and license.
2. Review `rpiv-2.12.0.patch` and the standalone helper [`server/rpiv-runtime.ts`](../../server/rpiv-runtime.ts). Before patching, run `sha256sum -c /absolute/path/to/upstream.sha256` from the copy's root; stop if any pinned input differs. In that copy only, run `patch --dry-run -p1 < /absolute/path/to/rpiv-2.12.0.patch`, then apply the same command without `--dry-run`.
3. Copy `server/rpiv-runtime.ts` from this checkout to `herdr-bridge.ts` at that copy's root. Install its normal dependencies using the upstream instructions. No WebUI script installs or loads this code.
4. Explicitly configure Pi to load that reviewed local package **instead of** the unpatched npm package (never both). Restart Pi, or use `/reload` only after all tool calls have ended. These steps change your Pi configuration and require your own approval.
5. Run a fictional questionnaire in a disposable session first. The matching fork WebUI backend must run on the owning machine; selecting a remote PC does not install it there.
6. To remove, stop affected sessions, restore the original package configuration, and restart. The private `.herdr-rpiv` directory alongside session files may be removed while no patched questionnaires run.

## Contract and limitations

Linux only initially, verified against Pi 1.1.0's extension/keybinding APIs. Candidate sequences are Up, Down, Enter, Space and Ctrl+U, admitted only when the live router proves the required action; a configured default is not proof. The fixed companion path is `<canonical session parent>/.herdr-rpiv/<sha256(canonical session path)>.json`. Directory mode is 0700, atomic temp/rename file mode 0600, at most 64 KB. No transcript entries or arbitrary output-path discovery. Changed controller/render states publish synchronously; the publisher heartbeat is 400 ms. `session_shutdown` and execute's `finally` both close idempotently; readers expire after 1500 ms and bind PID, Linux boot ID/start ticks, pane-owned canonical session, random request nonce, and tool call. Process death, replacement, closure, lost ownership or unknown state cannot authorize an answer.

`QuestionnaireSession.bridgeSnapshot()` projects canonical state and probes the **actual `routeKey` with the actual live keybinding manager** for each candidate key. The footer is never key evidence. Backend navigation uses existing herdr key/text calls, verifies the live snapshot plus RPIV screen before each step, and waits for each expected transition. Unknown delivery is not retried. Single choices, checkbox changes and one-line custom answers are supported; notes, review/final multi-question submission, hidden/unfocused/collapsed UIs, external editors, ambiguous clipping, unsupported bindings and platforms remain terminal-only. Native terminal interaction can still race a key after its final read; do not answer simultaneously from multiple clients.

Snapshots contain questionnaire and custom draft text: treat them as private session data. Closed snapshots overwrite their view with null. Abrupt crashes may leave the last private file; process identity and expiry invalidate it. At most one file per session is retained; no rendering journal grows.

## Disposable verification

With a patched disposable copy and its normal dependencies resolvable, run:

```
bun integrations/rpiv/verify-copy.ts /absolute/path/to/disposable/rpiv-copy
HERDR_TEST_MODE=unit bun test ./server/rpiv-bridge.test.ts ./server/rpiv-questionnaire.test.ts ./server/prompt.test.ts --test-name-pattern RPIV
```

`verify-copy.ts` refuses a package path under `node_modules`. It imports the actual patched controller, router and reducer plus Pi's real keybinding manager; only rendering/editor cells are fictional adapters. It exercises single, multi, custom and live key remapping, plus advancing a two-question form to its terminal-only review without submitting, without starting Pi or invoking an extension factory. The browser regression uses fictional demo transport, not a live extension. No claim of full live terminal end-to-end coverage is made by those tests.

## Attribution

The patch changes upstream MIT-licensed source; the helper is original integration code under MIT. Upstream: https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question (2.12.0).

MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
