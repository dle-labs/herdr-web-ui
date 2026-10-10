# Backend-coordinated dictation implementation plan

Status: proposed; no implementation or deployment changes authorized by this document.

This plan supersedes the direct browser-to-Speaches architecture in `mobile-dictation-plan.md` for future work. The existing direct implementation remains the deployed baseline until the migration ships. It applies to desktop and mobile, not only phones.

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

The coordinator owns transport, segmentation, scheduling, resource limits and cancellation. Speaches still owns recognition. The browser retains microphone permission/capture, visibility and connection lifecycle, draft ownership, cursor/selection, IME, Undo and all Send/Save decisions. Server recognition must never call a pane input/send API or write a draft on the user's behalf.

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

Before enabling the upstream WSS adapter, identify the deployed image/version and matching source, then use an explicitly approved synthetic speech fixture to verify format, append/commit, pause behavior, finish, empty input, multiple utterances, ordering, errors and disconnect. Confirm absence of response generation and whether interim hypotheses actually exist. Do not upgrade the deployment, install models or change infrastructure automatically. If this gate fails, use the HTTP adapter; report that the WSS adapter is unavailable.

## 3. Problems and trade-offs versus the current architecture

| Change | Benefit | Cost / required mitigation |
| --- | --- | --- |
| Audio passes through WebUI | Phone needs only WebUI connectivity; central protocol adapter | WebUI becomes an audio processor and another failure point. Update privacy wording and require explicit re-Apply when migrating. |
| Browser only contacts its own origin | Removes speech-service CORS and separate phone-to-STT routing | WebUI host must itself reach Speaches over the private network. Browser microphone still requires a secure context. |
| Coordinator receives continuous PCM | Supports previews, predictable segment boundaries and bounded scheduling | More upload bandwidth than compressed recordings; central resampling/VAD adds CPU if not carefully bounded. |
| Central inference scheduling | Can prioritize finals and prevent preview backlogs | Must enforce per-user and global fairness; a slow GPU can still prevent near-live UX. |
| Backend connects to configured service | Central TLS and protocol handling | Creates SSRF/proxy risk if browser-provided URLs are accepted. Destinations must be administrator-controlled. |
| WebUI restart or route failure | One explicit cancellation path | Active takes are lost; no durable audio or reconnect replay. Existing visible draft text remains untouched. |
| More frequent inference | Text appears during speech | Repeated Whisper previews reprocess audio; GPU work can greatly exceed one final upload. Benchmark before selecting cadence. |

A thin coordinator is a better operational fit for the desired UX, **not an automatic latency optimization**. The extra hop may increase latency; the WebUI host's location matters. A relay cannot fix recognition quality, cold model loads, mobile background suspension or an incompatible Realtime implementation.

Raw mono PCM16 at 24 kHz is 48,000 bytes/second, about 5.76 MB for 120 seconds before transport overhead; 16 kHz is 32,000 bytes/second. Use binary browser frames, not base64. Select the browser/coordinator rate independently of any unverified upstream format and use a tested resampler where required. Do not repeatedly base64-encode full utterances unless an upstream protocol requires it.

## 4. Server configuration, settings and migration

### Administrator-owned destination

Extend the existing `createServer(options)` injection seam with immutable dictation configuration. Proposed environment variable: `HERDR_WEB_DICTATION_BASE_URL`, initially `https://stt.intra.dle.dev/v1`. Option/env names and shared types must be finalized before implementation. Keep credentials separate from the non-secret configuration if they ever become necessary; none is required for this deployment.

- URL must be HTTPS, normalized, and free of userinfo, query and fragment. Reject malformed/ambiguous paths.
- Browser messages select an authorized model and mode, never a URL, host, port, arbitrary path or outbound headers.
- Derive fixed discovery/transcription/Realtime paths from the configured base. Reject HTTP redirects and upstream WS redirects rather than following them to a new destination.
- Private destination addresses are intentional here; do not adopt a generic 'block all private IPs' rule that breaks NetBird. Trust only administrator-configured destinations, retain normal TLS verification, and bound DNS/connect/request behavior. Do not expose a generic proxy.
- Apply installed-model restrictions before inference; reject uninstalled/unverified models rather than triggering downloads. Only read the local models API; never call registry/download/load/delete management endpoints. Refresh checks do not warm the model or submit sample audio.
- No global mutable machine target, browser cookies or browser Authorization headers are forwarded upstream. No implicit proxy/cloud fallback or legacy voice credentials.

### Browser settings

Keep microphone Auto/On/Off and explicit Apply. Show the backend-managed service as read-only; retain model selection and explicit, backend-mediated Refresh/Check. Do not offer a browser-editable service URL that the backend will ignore.

Version persisted activation: preserve Off and the selected model where valid, but require one new explicit Apply explaining that audio now travels through WebUI. Do not automatically copy an arbitrary persisted browser endpoint into server configuration. Configuration can be applied without inference; model discovery and eligibility failures must be distinguished from local capture support.

Extend authenticated `GET /api/dictation/config` with a versioned coordinator capability: enabled, supported modes, authorized/default models or model-discovery support, limits and a configuration generation. Avoid exposing unnecessary internal topology. Sessions snapshot this immutable generation; stale clients get an actionable reload/re-Apply error.

Retire `HERDR_WEB_DICTATION_ORIGINS` as a browser speech allowlist after migration. Do not silently translate it into an arbitrary full API URL. Document the new backend URL setting and the restart/reload requirement. Strip speech HTTPS/WSS sources from enforced browser CSP while preserving all unrelated directives and file-viewer security. The microphone path then uses only the app's own origin.

Legacy `/api/voice*` routes and credentials remain compatibility-only and are not reused for the new client. Their removal is a separate task.

## 5. Contract and routing

Use a dedicated, same-origin `/api/dictation/ws` upgrade path, separate from terminal `/ws`. Audio must not share terminal buffers, output acknowledgements, leases or resize handling. Register its route before the generic `/api/*` rejection and ensure the server's shared WebSocket callbacks dispatch by an explicit connection kind. `server/index.ts` currently shares terminal client data/callbacks and broadcasts: segregate dictation sockets from terminal client collections so no terminal role, attach, output, shutdown or revocation loop assumes dictation has terminal fields. Reuse `sameOrigin` and existing access/device resolution, not terminal attach authority.

Proposed logical protocol (define exact discriminated unions in `shared/protocol.ts`):

- Client: `start` (protocol version, opaque take ID, model, mode, audio format, configuration generation), binary audio frames, `finish`, `cancel`.
- Server: `ready` (server session ID and enforced limits), `progress`/credit, `preview` (segment ID, revision, replaceable text), `segment_final` (segment ID and text), `finished` (authoritative ordered transcript), structured `error`, `cancelled` where deliverable.
- Frame metadata: negotiated format, monotonically increasing frame sequence/sample position and bounded payload. Use a small documented binary envelope rather than pairing unrelated JSON metadata and binary messages ambiguously.
- `finish` specifies the last sent sequence/sample count; incomplete/gapped input fails visibly, never silently produces a 'complete' transcript.
- Stable session/segment IDs and monotonic revisions prevent duplication, out-of-order display and stale preview replacement. A finalized segment cannot be overwritten by a preview.
- Duplicate terminal controls are idempotent. Audio before ready, after finish, for another take, or with malformed/oversized metadata is rejected.

Prefer one take per socket initially. Finish/cancel closes that session; a new explicit Start opens a new socket. Never attach a new socket to a detached recording or replay buffered audio on reconnect.

Completed-recording migration can use a bounded same-origin multipart POST instead of this socket; define that route in the shared contract as well. It must obey the same authentication, configured destination, eligibility, cancellation and limits. Do not force compressed recordings into a PCM protocol just to share an endpoint.

### Authentication and authority

Authenticate **before** WS upgrade/body consumption using the application's existing paired-device/token mechanisms. Enforce the appropriate interact permission rather than allowing view-only devices to consume inference resources. Validate the exact browser Origin against the app's permitted origin, including reverse-proxy deployment rules, to prevent cross-site WebSocket hijacking. Never place long-lived bearer credentials in a WS URL. Apply equivalent same-origin/CSRF protections to upload and other resource-consuming HTTP requests.

Bind a session to the authenticated principal and owning socket; a client-supplied take ID is not authorization. Revoke/cancel work when device authorization is revoked. Bound unauthenticated and not-yet-started connections and handshake time.

Dictation is an app-level service provided by the browser-facing WebUI backend. It does not follow a selected remote machine through the SSH bridge. Machine/pane/comment identity stays in the browser's immutable draft owner; switching it cancels the take. All actual pane/workspace operations retain `useMachineApi()` and machine-scoped storage. No herdr RPC, new status subscription, PTY or pane lease is introduced by dictation.

## 6. Coordinator and adapters

Proposed modules (names are implementation suggestions):

- `server/dictation.ts`: immutable service configuration and capability response.
- `server/dictation/coordinator.ts`: session state, accounting, cancellation and ordered events.
- `server/dictation/segments.ts`: pure segmentation, frame validation and bounded utterance buffer.
- `server/dictation/scheduler.ts`: inference admission, final priority and fairness.
- `server/dictation/speaches-http.ts`: installed-model discovery and completed/rolling segment requests.
- `server/dictation/speaches-realtime.ts`: optional, capability-gated upstream WS adapter.
- `src/lib/voiceTransport.ts`: same-origin client only; no speech-service URL construction.
- `src/lib/voice.ts`: shared capture ownership and MediaRecorder/AudioWorklet lifecycle.

Keep adapters behind an injectable transport seam for tests. Do not introduce general workflow engines, persistence, worker services, native ASR dependencies or another daemon.

### Segmented HTTP adapter: recommended first live path

1. Browser continuously sends PCM chunks after ready; backend retains only the current bounded utterance and bounded admitted final work.
2. A lightweight energy detector with hysteresis, pre-roll and a silence interval proposes utterance boundaries. Treat about 500 ms silence as an initial tuning value, not a proven ideal. Test quiet speech, background noise and false boundaries. A learned VAD is optional later and requires an explicit dependency decision; do not download a VAD model automatically.
3. While speech continues, periodically snapshot the current segment into a complete decodable WAV and request transcription. Keep no more than one preview in flight, coalesce newer opportunities, and discard obsolete results by segment epoch.
4. Close/finalize the segment on a pause or bounded maximum duration (initial proposal: 12 seconds). Prefer a low-energy boundary; retain a short tail/pre-roll without accidentally transcribing the same samples twice. Forced-cut accuracy and boundary words need fixture coverage; no naive text-prefix deduplication.
5. Prioritize final requests over new previews. A preview superseded by finalization can be aborted locally, but do not assume upstream GPU computation stops. Avoid overlapping another expensive call unless measured concurrency/resource limits allow it.
6. Only finalized text is authoritative. A preview may revise words and is replaced, not appended. Finish closes the last segment and drains admitted final work with a deadline.

Begin preview cadence around 1–2 seconds only if measured recognition time supports it. Adapt scheduling to actual latency: skip preview opportunities rather than building a queue. There is no guarantee of a one-second preview with the current model/GPU. Realtime and HTTP are explicit adapter choices selected before a take, not automatic mid-take failover or replay.

### Session state and limits

Use explicit states: awaiting start -> preparing -> recording -> finishing -> finished; cancellation/error can end any nonterminal state. Reserve capacity before admitting capture. Release buffers, timers, references and socket ownership on every exit path; shutdown cancels all sessions.

Initial limits to test and tune:

- Existing 120-second take and 10 MiB aggregate browser audio ceiling, enforced on both ends. Include all segments; never reset the take limit on each pause.
- Negotiated PCM frame size (approximately 20–100 ms) plus a hard per-message cap; aggregate bytes, sample duration and message rate are independently checked. Compressed uploads have bounded request bodies and deadlines.
- One active take per authenticated principal initially, plus a small administrator-controlled global session/inference limit (start with one inference slot for this GPU). Existing browser Web Locks remain an optimization, not server authorization.
- A bounded pending-final queue (initial proposal: at most two bounded segments), one replaceable preview opportunity, bounded outbound text/events and a hard total session memory budget.
- Credits/acknowledged ingestion to bound audio backlog, WebSocket `bufferedAmount` safeguards in the browser, read deadlines and idle/heartbeat limits. ACK means ingestion/accounting, not recognized text. Sustained congestion cancels visibly; no silent frame loss, unbounded pause buffers or offline replay.
- Separate handshake, upstream connect, request, finalization and maximum session deadlines, configurable for measured cold starts. Do not hold a global inference slot forever after abort; account for possible orphaned upstream work and limit immediate retry churn.

Don't promise exactly-once remote inference. Guarantee no duplicate user-visible application of a result and no unauthorized replay. A websocket close or HTTP abort cannot guarantee Speaches cancels an already-running decode.

## 7. Browser UX and draft invariants

Keep one microphone family on every existing surface: composer, terminal draft, new/saved reply comments and file comments. No microphone in secret/password prompts.

During a take, display finalized phrases plus a separately styled, replaceable current preview in an owner-scoped in-flow region. Prefer holding the assembled transcript outside the editable draft until Finish initially: this avoids repeatedly mutating text or undo history while recognition revises it. Users still see text while speaking. Finish inserts the authoritative assembled result once only if the captured draft/selection is unchanged; otherwise offer Insert at cursor / Discard.

Explicit Send/Save acts only on visible editable draft text, never silently incorporates unfinished previews. It cancels pending dictation first. Cancel discards that take's uninserted transcript. If a connection fails, do not label a partial preview as final or automatically insert it; any supported recovery of already-finalized phrases must require an explicit owner-scoped action and must not survive invalidation.

Preserve current start/Undo safeguards (`src/lib/dictationUndo.ts` and `VoiceInput.tsx`'s explicit starting state and owner-scoped Undo) as well as revision-safe insertion, caret changes, IME, nested dialog/shortcut ownership, saved-comment editor paths, combined 20,000-character send validation and removal of the old per-comment cap. Audit the current branch rather than assuming the original implementation is still the complete baseline.

Permission resolution after cancellation stops returned tracks. Pagehide/hidden, offline, owning connection loss, owner unmount/change, settings Apply/Off, Send/Save/Delete and explicit Cancel invalidate generation synchronously, stop capture and close the socket. Server disconnect cleanup handles cases where a final cancel message cannot arrive. Nothing automatically restarts on foreground/reconnect.

Stop microphone tracks immediately on Finish while finalization proceeds. No warm microphone. Read-only model checks never request permission. The app must remain usable if a phone cannot sustain live AudioWorklet capture: completed-recording mode is an explicit same-origin alternative, not a direct-to-Speaches fallback.

## 8. Privacy, security and operational requirements

- Audio and transcripts stay in bounded memory: no application persistence, queue storage, session replay, analytics payloads or request-body logs. Verify reverse-proxy buffering/log settings as part of deployment; an in-memory application alone cannot guarantee a proxy never spools an upload to disk.
- Log only bounded operational metadata: phase, duration, byte count, latency and sanitized failure category. Never raw audio/transcript, credentials or unchecked upstream errors. Do not echo internal endpoints unnecessarily.
- Authentication, per-principal quotas, global capacity, frame/schema validation and limits apply independently; NetBird alone is not sufficient protection for an authenticated resource-consuming app endpoint.
- Reject compression/decompression bombs and unbounded error bodies. Avoid per-frame unbounded async task creation. Disable unnecessary WS compression for PCM where appropriate.
- No new secrets sent to browsers, no automatic model downloads, no inference to cloud endpoints, no TTS/polishing. No speech-server container/configuration mutations in implementation tests.
- Browser CSP no longer grants speech-service access. Demo transport intercepts new relative HTTP/WS routes and returns disabled/simulated capabilities even with stale activated settings. Assert zero real speech traffic.

## 9. Phased implementation and acceptance

### Phase A — confirm contracts and establish measurements

Read current subsystem instructions. Record the present source revision and preserve any newer start/Undo fixes. Specify shared protocol, server config, settings migration and limits. Identify deployment network reachability from WebUI host to Speaches. Benchmark explicitly approved synthetic short/long utterances over existing HTTP: cold/warm time, final accuracy at boundaries, preview compute cost and finish latency. Independently document the Realtime gate; do not block HTTP relay work on an unapproved server upgrade.

Deliverable: executable fake-service fixtures, baseline measurements and a documented adapter decision.

### Phase B — replace direct completed-recording transport

Implement backend config, capability/discovery and bounded upload routes. Rewire settings and `voiceTransport.ts`; remove browser speech URL ownership and direct fetches. Migrate activation with an explicit privacy explanation. Remove external speech CSP sources. Update demo, docs, translations and contract tests together.

Acceptance: all currently supported dictation surfaces retain existing behavior through WebUI; a browser network trace shows **zero direct speech-service requests** for capture, discovery or inference. No new UI duplicate controls; no regression to draft safety. This is already a useful, independently shippable migration.

### Phase C — browser streaming and coordinator

Add the dedicated authenticated WS, frame accounting, lifecycle cleanup, injectable adapters and bounded AudioWorklet capture/resampling. Implement segmentation and the serialized HTTP preview/final scheduler. Add preview rendering and one-time Finish insertion under current draft ownership rules. Register browser regressions in CI.

Acceptance: synthetic speech produces useful text before Finish, complete segments are not decoded again at Finish, repeated words are not duplicated, pending work/memory stay bounded under slow service, and cancellation/disconnect never sends or inserts text. Report measured first-preview and Finish latency, not simply 'WebSocket connected'.

### Phase D — optional upstream Realtime adapter

Only after the deployed protocol gate passes. Implement verified audio encoding/event ordering/finish and prove no AI response generation. If it returns only utterance-final results, label its capability accordingly; do not claim RPIV-style interim text. Compare it against HTTP previews on latency, quality, GPU load and interruption behavior before choosing a default. No silent per-take adapter fallback.

### Phase E — deployment and actual phones

Configure the backend service URL and private-network reachability; verify same-origin proxy WS upgrades/idle limits, upload buffering and app HTTPS. Deploy/restart only WebUI with explicit authorization, reload clients and re-Apply settings. Test real Android Chrome and iOS Safari, including keyboard-open comments, permission rejection, lock/background, VPN loss, concurrent clients and server restart. Desktop mobile viewport emulation is not sufficient evidence.

## 10. Test matrix and implementation checklist

- Pure Bun tests: frame sequences, resampling continuity, segmentation/pre-roll/forced cuts, scheduler fairness/final priority, stale previews, limits, teardown and idempotent terminal states.
- Server contracts: authentication before upgrade/upload, origin/role rejection, revoked devices, uninstalled models, fixed destination/no redirects, bounded responses, capacity rejection, mid-request cancellation and WS cleanup. Use `createServer` with temporary state and port zero.
- Fake Speaches services: delayed/failed/out-of-order results, malformed/huge responses, stalled sends, close during Finish, ignored session settings and accidental response events. Assert no fallback/replay and no model-management requests.
- Production browser tests: compiled app and enforced CSP; authenticated same-origin HTTP/WS; no private-origin network calls; draft/caret/IME/Undo, all new/saved comment paths, owner switching, mobile layout, Finish/Cancel, Send/Save during recognition, late permission and rapid Start/Cancel/Start.
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
6. Privacy change, server setup, limitations and measured performance are documented. Real-device evidence is distinguished from emulation.
7. Upstream WSS support is claimed only for the protocol actually validated. If unavailable, the backend HTTP adapter still fulfills the coordinator architecture and live-preview goal within measured hardware limits.
