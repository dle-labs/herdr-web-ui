# Backend-coordinated dictation implementation plan

Status: implemented and replay-tested on `next`; deployment authorized separately. Actual mobile capture and battery assessment remain with the user.

This implementation supersedes the direct browser-to-Speaches architecture in `mobile-dictation-plan.md`. Existing installations require the backend URL configuration and refreshed client consent when upgrading. It applies to desktop and mobile, not only phones.

## 1. Goal and recommendation

Route capture through a thin coordinator in the **WebUI backend**, never through the herdr terminal daemon:

```text
Browser microphone / AudioWorklet
  -> same-origin authenticated WebSocket
  -> WebUI dictation coordinator
  -> configured Speaches HTTPS or WSS adapter
  -> ordered preview/final events
  -> browser-owned draft insertion or recovery
```

Remove browser requests to Speaches entirely, including model discovery, connection checks, completed-recording uploads and Realtime connections. Do not retain a hidden direct fallback.

The **WebUI backend** owns the utterance buffer, pause detection, segmentation, preview/final request sequencing and cancellation. The phone sends small audio chunks over the same-origin WebSocket, with only a short transmission buffer; it does not detect utterance boundaries or run recognition. Speaches still owns recognition. The browser retains microphone permission/capture, visibility and connection lifecycle, draft ownership, cursor/selection, IME, Undo and all Send/Save decisions. Server recognition must never call a pane input/send API or write a draft on the user's behalf.

### Agreed deployment scope

- This is a single-user dictation flow, not a multi-user inference service. No new identity system, per-user quotas, admission-control framework, global GPU semaphore or fairness scheduler.
- Reuse existing WebUI authentication and route protections; do not redesign authentication for this feature.
- Keep the existing **Speaches Docker container** at `https://stt.intra.dle.dev/v1` and the installed `distil-whisper/distil-large-v3.5-ct2` model as the default. No replacement recognition backend, model-eligibility subsystem, container upgrade or model download is part of this work.
- Keep only practical per-take safeguards: bounded audio buffers, existing recording limits, request timeouts, cancellation and no overlapping preview/final requests within a recording. These prevent a stalled connection or slow recognition from accumulating work; they are not multi-user resource management.

Recommended delivery: first move the working completed-recording flow behind the backend, then add live capture with a segmented HTTP adapter. Add the Speaches Realtime adapter only after its deployed protocol passes a separate compatibility gate. A browser WebSocket does **not** require an upstream Speaches WebSocket.

## 2. Established evidence and unresolved gate

RPIV uses local offline Whisper recognition, rolling re-recognition of the current utterance and pause-based finalization. It is not a persistent streaming decoder. To reproduce its UX, merely replacing HTTP with WebSockets is insufficient: users must receive useful hypotheses while speaking and have little work remaining after Finish.

Probes against the currently deployed service established:

- `/v1/realtime` accepts a WSS connection and emits `session.created`.
- `session.update` accepts the selected `distil-whisper/distil-large-v3.5-ct2` transcription model and English.
- `intent=transcription` did not select transcription-only behavior in the observed session.
- A requested `turn_detection.create_response: false` was not reflected in the acknowledgement; it remained true. Requested threshold/silence changes were also not reflected.
- `turn_detection: null` and explicit input-format/prefix-padding configuration were rejected.
- No audio was uploaded by these probes. Successful audio ingestion, actual sample format, transcription-only execution, finalization, cancellation and partial events have **not** been established. Current upstream documentation is not proof of deployed behavior.

Do not send real audio into this Realtime path until response generation is demonstrably disabled. Hiding generated response events in our UI is not sufficient: remote inference or external model calls could already have occurred.

Before enabling the upstream WSS adapter, identify the deployed image/version and matching source, then use an approved recording fixture to verify format, append/commit, pause behavior, finish, empty input, multiple utterances, ordering, errors and disconnect. Confirm absence of response generation and whether interim hypotheses actually exist. Do not upgrade the deployment, install models or change infrastructure automatically. If this gate fails, use the HTTP adapter; report that the WSS adapter is unavailable.

## 3. Problems and trade-offs versus the current architecture

| Change | Benefit | Cost / required mitigation |
| --- | --- | --- |
| Audio passes through WebUI | Phone needs only WebUI connectivity; central protocol adapter | WebUI becomes an audio processor and another failure point. Update privacy wording and require explicit re-Apply when migrating. |
| Browser only contacts its own origin | Removes speech-service CORS and separate phone-to-STT routing | WebUI host must itself reach Speaches over the private network. Browser microphone still requires a secure context. |
| Coordinator receives continuous PCM | Supports previews, predictable segment boundaries and bounded scheduling | More upload bandwidth than compressed recordings; central resampling/VAD adds CPU if not carefully bounded. |
| Per-recording request sequencing | Can prioritize finals and skip redundant previews | A slow GPU can still prevent near-live UX; no multi-user or global scheduler is needed for this deployment. |
| Backend connects to configured service | Central TLS and protocol handling | Creates SSRF/proxy risk if browser-provided URLs are accepted. Destinations must be administrator-controlled. |
| WebUI restart or route failure | One explicit cancellation path | Active takes are lost; no durable audio or reconnect replay. Existing visible draft text remains untouched. |
| More frequent inference | Text appears during speech | Repeated Whisper previews reprocess audio; GPU work can greatly exceed one final upload. Benchmark before selecting cadence. |

A thin coordinator is a better operational fit for the desired UX, **not an automatic latency optimization**. The extra hop may increase latency; the WebUI host's location matters. A relay cannot fix recognition quality, cold model loads, mobile background suspension or an incompatible Realtime implementation.

Raw mono PCM16 at 24 kHz is 48,000 bytes/second, about 5.76 MB for 120 seconds before transport overhead; 16 kHz is 32,000 bytes/second. Use binary browser frames, not base64. Select the browser/coordinator rate independently of any unverified upstream format and use a tested resampler where required. Do not repeatedly base64-encode full utterances unless an upstream protocol requires it.

Server-side segmentation removes that processing from the phone, but microphone capture, audio conversion and continuous transmission still consume battery. Start with approximately 100–250 ms transmission batches and throttle preview rendering; tune against replay-test latency. Battery measurement is excluded from implementation testing and will be assessed by the user. Do not promise better battery life than the existing compressed record-then-upload mode.

## 4. Server configuration, settings and migration

### Administrator-owned destination

Extend the existing `createServer(options)` injection seam with immutable dictation configuration. Environment variable: `HERDR_WEB_DICTATION_BASE_URL`; set `https://stt.intra.dle.dev/v1` explicitly for this deployment. Unset or empty means disabled. The `dictationBaseUrl` option overrides the environment. Keep credentials separate from the non-secret configuration if they ever become necessary; none is required for this deployment.

- URL must be HTTPS, normalized, and free of userinfo, query and fragment. Reject malformed/ambiguous paths.
- Browser messages select a model and mode under the existing settings flow, never a URL, host, port, arbitrary path or outbound headers. Keep the current installed v3.5 model as the default.
- Derive fixed discovery/transcription/Realtime paths from the configured base. Reject HTTP redirects and upstream WS redirects rather than following them to a new destination.
- Private destination addresses are intentional here; do not adopt a generic 'block all private IPs' rule that breaks NetBird. Trust only administrator-configured destinations, retain normal TLS verification, and bound DNS/connect/request behavior. Do not expose a generic proxy.
- Keep optional, explicit model discovery through Speaches' local ASR model list (`GET /v1/models?task=automatic-speech-recognition`). Do not add per-request inventory checks or an eligibility/cache subsystem. The deployment already has the selected model installed; surface Speaches' missing-model/inference errors without substitution. The coordinator never requests model downloads or registry/load/delete management operations. Refresh checks do not warm the model or submit sample audio. Loading existing weights into GPU memory remains Speaches' responsibility.
- No global mutable machine target, browser cookies or browser Authorization headers are forwarded upstream. No implicit proxy/cloud fallback or legacy voice credentials.

### Browser settings

Keep microphone Auto/On/Off and explicit Apply. Show the backend-managed service as read-only; retain model selection and explicit, backend-mediated Refresh/Check. Do not offer a browser-editable service URL that the backend will ignore.

Version persisted activation: preserve Off and the selected model where valid, but require one new explicit Apply explaining that audio now travels through WebUI. Do not automatically copy an arbitrary persisted browser endpoint into server configuration. Configuration can be applied without successful discovery or inference; model discovery and inference failures must be distinguished from local capture support.

Extend authenticated `GET /api/dictation/config` with a versioned coordinator capability: enabled, supported modes, default model and model-discovery support, per-take limits and a configuration generation. Avoid exposing unnecessary internal topology. Sessions snapshot this immutable generation; stale clients get an actionable reload/re-Apply error.

Retire `HERDR_WEB_DICTATION_ORIGINS` as a browser speech allowlist after migration. Do not silently translate it into an arbitrary full API URL. Document the new backend URL setting and the restart/reload requirement. Strip speech HTTPS/WSS sources from enforced browser CSP while preserving all unrelated directives and file-viewer security. The microphone path then uses only the app's own origin.

Legacy `/api/voice*` routes and credentials remain compatibility-only and are not reused for the new client. Their removal is a separate task.

## 5. Contract and routing

Use a dedicated, same-origin `/api/dictation/ws` upgrade path, separate from terminal `/ws`. Audio must not share terminal buffers, output acknowledgements, leases or resize handling. Register its route before the generic `/api/*` rejection and ensure the server's shared WebSocket callbacks dispatch by an explicit connection kind. `server/index.ts` currently shares terminal client data/callbacks and broadcasts: segregate dictation sockets from terminal client collections so no terminal role, attach, output, shutdown or revocation loop assumes dictation has terminal fields. Reuse `sameOrigin` and existing access/device resolution, not terminal attach authority.

The version-2 protocol is defined in browser-safe `shared/dictation.ts` and re-exported through `shared/protocol.ts`. Live audio is mono PCM16 little-endian at 16 kHz; the browser statefully downmixes/resamples its actual AudioContext rate. Binary frames contain an 8-byte header (uint32 LE sequence, starting at zero; uint32 LE absolute sample offset), then 1–3,200 samples (at most 200 ms). Finish specifies total frame and sample counts, not the last frame index. Backend WAV snapshots use the same rate without a second resampling pass.

Logical protocol:

- Client: `start` (version 2, model, configuration generation), binary audio frames, `finish` (frame/sample totals), `cancel`. One socket identifies one take; this endpoint always uses the agreed live PCM format.
- Server: `ready` (sample rate and enforced limits), `ack` (cumulative ingested frames/samples), `preview` (segment ID, revision, replaceable text), `segment_final` (segment ID and text), `finished` (authoritative ordered transcript), structured `error`, `cancelled` where deliverable.
- Frame metadata: negotiated format, monotonically increasing frame sequence/sample position and bounded payload. Use a small documented binary envelope rather than pairing unrelated JSON metadata and binary messages ambiguously.
- `finish` specifies the last produced sequence/sample count after the capture drain barrier described below; incomplete/gapped input fails visibly, never silently produces a 'complete' transcript.
- Stable session/segment IDs and monotonic revisions prevent duplication, out-of-order display and stale preview replacement. A finalized segment cannot be overwritten by a preview.
- Duplicate terminal controls are idempotent. Audio before ready, after finish, for another take, or with malformed/oversized metadata is rejected.

Prefer one take per socket initially. Finish/cancel closes that session; a new explicit Start opens a new socket. Never attach a new socket to a detached recording or replay buffered audio on reconnect.

Completed-recording migration can use a bounded same-origin multipart POST instead of this socket; define that route in the shared contract as well. It must reuse existing WebUI authentication and the same configured destination, per-take cancellation and bounded upload handling. Do not force compressed recordings into a PCM protocol just to share an endpoint.

### Reuse existing WebUI authentication

Integrate the new HTTP and WS routes with the application's existing authentication, permissions, same-origin checks and device-revocation lifecycle. This is wiring into the existing protections, not a new authentication design, role system or quota identity model. Same-origin fetches must send existing session credentials; remove the current transport special case that only includes credentials for `/api/dictation/config`. Do not introduce new API keys or put long-lived credentials into a WS URL.

Bind each take to its owning connection, cancel it when that connection closes or loses authorization, and discard late results. A take ID correlates messages; it does not replace the existing authentication.

Dictation is an app-level service provided by the browser-facing WebUI backend. It does not follow a selected remote machine through the SSH bridge. Machine/pane/comment identity stays in the browser's immutable draft owner; switching it cancels the take. All actual pane/workspace operations retain `useMachineApi()` and machine-scoped storage. No herdr RPC, new status subscription, PTY or pane lease is introduced by dictation.

## 6. Coordinator and adapters

Proposed modules (names are implementation suggestions):

- `server/dictation.ts`: immutable service configuration and capability response.
- `server/dictation/coordinator.ts`: session state, accounting, cancellation and ordered events.
- `server/dictation/segments.ts`: pure segmentation, frame validation and bounded utterance buffer.
- Per-take request sequencing inside `coordinator.ts` (or a small pure helper if useful): one recognition request at a time, finals before new previews, and skipped/coalesced preview opportunities. No separate global scheduler.
- `server/dictation/speaches-http.ts`: installed-model discovery and completed/rolling segment requests.
- `server/dictation/speaches-realtime.ts`: optional, capability-gated upstream WS adapter.
- `src/lib/voiceTransport.ts`: same-origin client only; no speech-service URL construction.
- `src/lib/voice.ts`: shared capture ownership and MediaRecorder/AudioWorklet lifecycle.

Keep adapters behind an injectable transport seam for tests. Do not introduce general workflow engines, persistence, worker services, native ASR dependencies or another daemon.

### Segmented HTTP adapter: recommended first live path

1. Browser continuously sends PCM chunks after ready; the WebUI backend owns the current bounded utterance buffer and a small pending-final queue. All pause detection and segmentation happen here, not on the phone.
2. A lightweight energy detector with hysteresis, pre-roll and a silence interval proposes utterance boundaries. Treat about 500 ms silence as an initial tuning value, not a proven ideal. Test quiet speech, background noise and false boundaries. A learned VAD is optional later and requires an explicit dependency decision; do not download a VAD model automatically.
3. While speech continues, periodically snapshot the current segment into a complete decodable WAV and request transcription. Keep no more than one preview in flight, coalesce newer opportunities, and discard obsolete results by segment epoch.
4. Close/finalize on 500 ms of silence or a 12-second segment cap. Segments own nonoverlapping half-open sample ranges. Keep up to 200 ms of previously unassigned silence as pre-roll. At the cap, choose the lowest-energy 10 ms boundary in the trailing 800 ms, retaining only the unassigned tail for the next segment. There is no overlapping speech or text-prefix deduplication. This energy heuristic is not phoneme-aware and may change boundary-word recognition; fixture tests and replay comparisons cover that limitation.
5. Keep at most one recognition request outstanding for this take, whether preview or final. If a preview is superseded, ignore its result but normally let the request settle before starting the next final; aborting it does not prove GPU decoding stopped. Finals have priority over new previews. Cancel aborts the local request and invalidates its result; there is no global orphan-work tracker or cross-user scheduler.
6. Only finalized text is authoritative. A preview may revise words and is replaced, not appended. Empty segment finals retire previews without failing the take; an entirely empty finished transcript reports no speech. Join trimmed nonempty finals with one space. A failed/expired transient preview can be skipped; a failed final must fail visibly rather than fabricate completion. Finish closes the last segment and drains pending final work under one absolute 65-second deadline, including any existing preview and capture drain; never restart that budget per request.

Begin preview cadence around 1–2 seconds only if measured recognition time supports it. Adapt scheduling to actual latency: skip preview opportunities rather than building a queue. There is no guarantee of a one-second preview with the current model/GPU. Realtime and HTTP are explicit adapter choices selected before a take, not automatic mid-take failover or replay.

### Session state and limits

Use explicit states: awaiting start -> preparing -> recording -> finishing -> finished; cancellation/error can end any nonterminal state. Release buffers, timers, references and socket ownership on every exit path; shutdown cancels active takes. No inference admission or multi-user capacity service is needed.

Practical per-take safeguards to retain:

- Preserve the existing 120-second browser recording limit and 10 MiB aggregate audio ceiling. Count all segments, not each separately. The backend can enforce PCM duration from sample counts and bound incoming bytes. For compressed completed recordings, byte limits do not prove decoded duration; keep the browser duration limit and Speaches decoding behavior, without adding a server media-decoder subsystem or claiming a decoded-duration guarantee.
- Negotiate audio format and a bounded binary message size. Start with approximately 100–250 ms transmission batches, independently of internal worklet processing blocks. Compressed uploads have bounded bodies and deadlines.
- Preserve shared browser capture ownership and existing Web Locks. The supported workload is one user recording at a time; no per-principal quotas, global inference slots or cross-installation coordination.
- Keep a small pending-final queue (initial proposal: at most two bounded segments), at most one replaceable preview opportunity and bounded outbound events. If recognition cannot keep up, stop visibly rather than accumulating unlimited audio.
- Bound both the AudioWorklet MessagePort backlog and WebSocket transmission backlog. Use simple ingestion acknowledgements if needed; ACK does not mean recognized text. Sustained congestion cancels visibly, without silent frame loss or reconnect replay.
- Bound startup, upstream requests and Finish waiting, allowing for measured cold starts. Align existing browser finalization timers, Bun and proxy timeouts. Cancel/disconnect releases local resources and drops late results; do not promise cancellation of an already-running Speaches decode.

Don't promise exactly-once remote inference. Guarantee no duplicate user-visible application of a result and no unauthorized replay. A websocket close or HTTP abort cannot guarantee Speaches cancels an already-running decode.

## 7. Browser UX and draft invariants

Keep one microphone family on every existing surface: composer, terminal draft, new/saved reply comments and file comments. No microphone in secret/password prompts.

During a take, display finalized phrases plus a separately styled, replaceable current preview in an owner-scoped in-flow region. Prefer holding the assembled transcript outside the editable draft until Finish initially: this avoids repeatedly mutating text or undo history while recognition revises it. Users still see text while speaking. Finish inserts the authoritative assembled result once only if the captured draft/selection is unchanged; otherwise offer Insert at cursor / Discard.

Explicit Send/Save acts only on visible editable draft text, never silently incorporates unfinished previews. It cancels pending dictation first. Cancel discards that take's uninserted transcript. If a connection fails, do not label a partial preview as final or automatically insert it; any supported recovery of already-finalized phrases must require an explicit owner-scoped action and must not survive invalidation.

Preserve current start/Undo safeguards (`src/lib/dictationUndo.ts` and `VoiceInput.tsx`'s explicit starting state and owner-scoped Undo) as well as revision-safe insertion, caret changes, IME, nested dialog/shortcut ownership, saved-comment editor paths, combined 20,000-character send validation and removal of the old per-comment cap. Audit the current branch rather than assuming the original implementation is still the complete baseline.

Permission resolution after cancellation stops returned tracks. Pagehide/hidden, offline, owning connection loss, owner unmount/change, settings Apply/Off, Send/Save/Delete and explicit Cancel invalidate generation synchronously, stop capture and close the socket. Server disconnect cleanup handles cases where a final cancel message cannot arrive. Nothing automatically restarts on foreground/reconnect.

On Finish, stop accepting new microphone input and stop tracks promptly, then drain audio already produced into the bounded worklet/resampler pipeline before sending Finish. Establish a last-produced-sample acknowledgement so the final partial frame is not lost; close/dispose the audio pipeline after this bounded drain. Cancel can interrupt every drain step and discards pending output. No warm microphone. Create/resume the AudioContext during the user gesture where required by mobile browsers, rather than assuming it can first resume after asynchronous server readiness. Bound any startup buffer and cancel pending startup when hidden.

Read-only model checks never request permission. The app must remain usable if a phone cannot sustain live AudioWorklet capture: completed-recording mode is an explicit same-origin alternative, not a direct-to-Speaches fallback.

## 8. Privacy, security and operational requirements

- Coordinator audio and transient recognition results stay in bounded memory: no coordinator persistence, queue storage, session replay, analytics payloads or request-body logs. Text explicitly inserted into a draft follows the existing draft/comment storage behavior. Verify reverse-proxy buffering/log settings as part of deployment; an in-memory application alone cannot guarantee a proxy never spools an upload to disk.
- Log only bounded operational metadata: phase, duration, byte count, latency and sanitized failure category. Never raw audio/transcript, credentials or unchecked upstream errors. Do not echo internal endpoints unnecessarily.
- Reuse existing WebUI authentication and route protections. Validate message shape and size as part of protocol correctness; do not add per-user quotas or global capacity management.
- Bound upstream response/error bodies and avoid unbounded async task creation per frame. No local compressed-audio decoding dependency is introduced. Disable unnecessary WS compression for PCM where appropriate.
- No new secrets sent to browsers, no automatic model downloads, no inference to cloud endpoints, no TTS/polishing. No speech-server container/configuration mutations in implementation tests.
- Browser CSP no longer grants speech-service access. Demo transport intercepts new relative HTTP/WS routes and returns disabled/simulated capabilities even with stale activated settings. Assert zero real speech traffic.

## 9. Phased implementation and acceptance

### Phase A — confirm contracts and establish measurements

Read current subsystem instructions. Record the present source revision and preserve any newer start/Undo fixes. Specify shared protocol, server config, settings migration and limits. Identify deployment network reachability from WebUI host to Speaches. Use the user-provided `/home/dle/Downloads/audio.mp3` and `/home/dle/Downloads/audio2.mp3` as local speech fixtures. Compare complete-file HTTP transcription with the same recordings replayed in real-time-paced chunks through the coordinator: first-request versus warm-request timing, boundary omissions/duplication, preview compute cost and Finish latency. Do not label the first request cold unless unloaded state is established; do not force model unloads or container restarts. Keep originals unchanged and all recordings, converted audio and transcript artifacts outside Git. These private files are optional local benchmark inputs, not required CI fixtures; deterministic fake-service tests remain self-contained. Independently document the Realtime gate; do not block HTTP relay work on an unapproved server upgrade.

Deliverable: executable fake-service fixtures, baseline measurements and a documented adapter decision.

### Phase B — replace direct completed-recording transport

Implement backend config, capability/discovery and bounded upload routes with cancellation/disconnect cleanup from the outset. Rewire settings and `voiceTransport.ts` to use existing same-origin credentials; remove browser speech URL ownership and direct fetches. Migrate activation with an explicit privacy explanation. Remove external speech CSP sources. Update demo, docs, translations and contract tests together.

Acceptance: all currently supported dictation surfaces retain existing behavior through WebUI; a browser network trace of the refreshed application shows **zero direct speech-service requests** for capture, discovery or inference. No new UI duplicate controls; no regression to draft safety. This is already a useful, independently shippable migration.

### Phase C — browser streaming and coordinator

Add the dedicated authenticated WS, frame accounting, lifecycle cleanup, injectable adapters and bounded AudioWorklet capture/resampling. Implement backend-owned buffering/segmentation and single-take HTTP preview/final sequencing. Add preview rendering and one-time Finish insertion under current draft ownership rules. Register browser regressions in CI.

Acceptance: paced replay of the supplied recordings produces useful text before Finish, complete segments are not decoded again at Finish, repeated words are not duplicated, pending work/memory stay bounded under slow service, and cancellation/disconnect never sends or inserts text. Report measured first-useful-preview, preview age and Finish latency, not simply 'WebSocket connected'. Agree on numerical UX targets from Phase A measurements before enabling Live by default. If the existing model/GPU cannot meet them, ship the completed-recording relay without declaring the live-preview goal complete.

### Phase D — optional upstream Realtime adapter

Only after the deployed protocol gate passes. Implement verified audio encoding/event ordering/finish and prove no AI response generation. If it returns only utterance-final results, label its capability accordingly; do not claim RPIV-style interim text. Compare it against HTTP previews on latency, quality, GPU load and interruption behavior before choosing a default. No silent per-take adapter fallback.

### Phase E — deployment and user handoff

Configure the backend service URL and private-network reachability; keep the current Speaches container/model unchanged. Verify same-origin proxy WS upgrades/idle limits, upload buffering and app HTTPS. Deploy/restart only WebUI with explicit authorization, close/reload old tabs and installed-PWA instances, and re-Apply settings. New CSP cannot revoke direct access already granted to an old open page, so distinguish the refreshed bundle's zero-direct-traffic guarantee from deployment-wide cutover. After setup, the user will test actual mobile microphone capture and assess battery behavior. Both are excluded from agent-run testing and are not implementation-completion gates. Keep automated browser capture/lifecycle and mobile-layout regressions, but do not present desktop emulation or recorded-audio replay as real-device capture validation.

## 10. Test matrix and implementation checklist

- Pure Bun tests: frame sequences, resampling continuity, segmentation/pre-roll/forced cuts, single-take sequencing/final priority, skipped previews, bounded queues, teardown and idempotent terminal states.
- Server contracts: reuse existing authentication/origin/device lifecycle protections, same-origin request credentials, fixed destination/no redirects, Speaches model/inference errors, bounded uploads/responses, cancellation after upload completion and WS cleanup. Use `createServer` with temporary state and port zero. No quota/fairness/admission-control test framework.
- Fake Speaches services: delayed/failed/out-of-order results, malformed/huge responses, stalled sends, close during Finish, ignored session settings and accidental response events. Assert no fallback/replay and no model-management requests.
- Production browser tests: compiled app and enforced CSP; authenticated same-origin HTTP/WS; no private-origin network calls from refreshed clients; old activated settings and cached-shell cutover; draft/caret/IME/Undo, all new/saved comment paths, owner switching, mobile layout, Finish/Cancel, Send/Save during recognition, late permission and rapid Start/Cancel/Start. Cover suspended AudioContext, delayed worklet output, Finish immediately after Start and a non-frame-aligned final sample. Use a trusted test CA for backend HTTPS fixtures or injected transport in unit tests; never weaken production TLS verification.
- Demo: disabled policy and interception of every new path; stale settings cannot escape to real speech infrastructure.
- Isolation: all herdr/UI fixtures use test/demo sessions, never the user's live terminals. No screenshots or transcripts from user workspaces.
- Run targeted unit/contract tests, typecheck/build, `bun run check fast`, then isolated integration/browser lanes. Re-run affected Undo/start tests on the actual implementation baseline. Verify no task-related leftovers.
- Update `shared/protocol.ts`, `server/api.contract.test.ts`, demo transport, CI lane registrations/counts, settings dictionaries in ko/ja/zh, guide/privacy/install configuration, CHANGELOG and design wording where UI changes warrant it. Keep generated herdr API types untouched.

## 11. Definition of done

1. No production client code connects to Speaches, including settings discovery/checks.
2. Backend relay supports today's completed-recording UX without draft-safety regressions.
3. Live mode shows useful, correctly ordered hypotheses before Finish and bounds both memory and inference backlog under adverse conditions.
4. Drafts, Undo, caret/selection and IME remain browser-owned; no auto Send/Save or terminal input.
5. Every cancellation/disconnection releases local resources and prevents stale result insertion; no audio persistence/replay.
6. Privacy change, server setup, limitations and recording-replay performance are documented. Actual mobile capture testing and battery assessment are handed to the user after setup, not required of agent-run testing; replay/emulation is not reported as real-device evidence.
7. Upstream WSS support is claimed only for the protocol actually validated. If unavailable, the backend HTTP adapter still fulfills the coordinator architecture and live-preview goal within measured hardware limits.

## 12. Implementation and replay record

Implemented configuration/HTTP relay, same-origin WS transport, backend PCM segmentation and serial preview/final scheduling, browser AudioWorklet capture/resampling, settings consent migration and transient preview display. Speaches Docker/model are unchanged. The upstream Realtime adapter remains intentionally unimplemented; all recognition uses the existing HTTP endpoint. Completed-recording mode remains the default and Live preview is explicitly selected.

The production-served browser regression exercises both modes through an authenticated WebUI and a disposable HTTPS speech fixture with a trusted CA (no certificate bypass). It checks same-origin CSP, zero browser-to-speech requests, no forwarded browser credentials, actual AudioWorklet output, draft/Undo and cancellation on desktop/mobile-sized layouts. Review found and fixed the live duration-limit offset: the worklet now stops at exactly 120 seconds of produced samples and triggers normal Finish instead of cancelling at overflow. A stalled response reader is also explicitly cancelled when a request aborts.

Validation: 2,516 unit tests passed (seven platform skips), typecheck/build passed, and 104 API/dictation contract tests passed. Production dictation browser coverage passed on desktop and mobile-sized layouts. Browser scripts were exercised in batches after fixing stale fixture selectors and Bun-only fixture worklet resolution; the phone-comment case passed on retry. The broader prompt-dock script still fails its 800×600 transcript-height assertion (18.5 px versus 48 px minimum). The identical failure reproduces from an untouched archive of the pre-coordinator commit, `4bd3a97`; it is not counted as a passing browser lane.

Local replay results using the user's approved files (audio/transcripts remain outside Git):

| Fixture | Decoded PCM duration | First preview | Finish latency | Recognition requests | Cumulative recognition audio |
| --- | ---: | ---: | ---: | ---: | ---: |
| `audio.mp3` | 27.27 s | 4.99 s | 1.25 s | 17 | 74.93 s (2.75×) |
| `audio2.mp3` | 41.72 s | 2.56 s | 0.60 s | 25 | 148.92 s (3.57×) |

Replay uses decoded sample counts, not the MP3 container's duration estimate (31.55/49.45 s). Whole-file HTTP baselines were 6.38/0.85 s for the first file and 1.45/1.51 s for the second; the first request's model residency was not verified. These are a small local sample, not general latency guarantees. Segmented results differed from whole-file results by 5 and 6 normalized word edits respectively; the baseline is not a human-verified transcript, so these numbers measure disagreement, not word error rate against ground truth. Keep record-then-transcribe available when whole-utterance context matters.

To repeat privately after building/installing test dependencies:

```sh
bun run check run bun scripts/dictation-benchmark.ts --yes \
  --base https://stt.intra.dle.dev/v1 --out /path/outside-the-checkout \
  /path/to/audio.mp3 /path/to/audio2.mp3
```

This opt-in benchmark runs an isolated test WebUI, converts recordings locally with ffmpeg, sends paced PCM to its dictation WS and records private events/results outside the checkout. It does not request microphone access, attach user terminals, install models or modify Speaches. It is not a CI dependency. Mobile capture and battery assessment remain the user's post-setup responsibility.
