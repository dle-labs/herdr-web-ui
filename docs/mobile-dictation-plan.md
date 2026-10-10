# Mobile dictation implementation plan

Architecture follow-up: [Backend-coordinated dictation implementation plan](dictation-coordinator-plan.md) proposes replacing direct browser-to-Speaches traffic with a thin WebUI backend coordinator. This document records the original direct implementation; the follow-up is a plan, not a deployed change.

Status: milestone 1 implemented after two rounds of independent plan reviews and an implementation review. Automated validation is recorded below; real-device/deployment validation remains outstanding. Milestone 2 is not enabled.
Branch: `feature/mobile-dictation`.

## 1. Goal and established decisions

Replace the existing browser recording feature with one unified, self-hosted English dictation experience. The replacement serves desktop and mobile chat composers, terminal input lines, reply comments and file comments. There must not be a second microphone beside the old one.

- Speech service: `https://stt.intra.dle.dev`; REST API base: `https://stt.intra.dle.dev/v1`.
- Initial model: `distil-whisper/distil-large-v3.5-ct2`.
- Recognition language: English (`en`), independent of interface language.
- Browser talks directly to Speaches through NetBird; herdr does not relay audio.
- NetBird reverse proxy provides TLS. NetBird access controls provide access restriction; no additional API-key flow.
- Target inference host: Ubuntu 22.04, Ryzen 7 5700X, GTX 1070 Ti with 8 GB VRAM, approximately 47 GB RAM. Working Whisper configuration uses CTranslate2 `int8_float32` on CUDA.
- Dictation edits a draft only: never automatic Send, comment Save, terminal Enter or prompt answering.
- Scope excludes TTS, new model benchmarking, Pi/rpiv-voice changes and automatic remote infrastructure/container changes.

Completed-file transcription has been tested successfully. Distil-large-v3.5 is a provisional default based on two recordings, not a universal accuracy winner. Live audio streaming and real phone capture remain unvalidated against the deployed service.

The comment-specific 2,000-character cap has already been removed. Preserve the combined outgoing message's 20,000-character check and warning.

## 2. Review decisions and delivery strategy

Two rounds of independent reviews covered UI/settings and architecture/testing. This revision adopts the following decisions:

1. **Replacement, not coexistence:** replace existing record controls and legacy voice settings. Keep reusable internals, not a parallel legacy user experience.
2. **Legacy backend is compatibility-only:** leave `server/voice.ts`, existing `/api/voice*` routes and their contracts in place for now. The replacement UI must not call them or offer their OpenAI/browser fallback transports. Do not delete existing server credentials automatically.
3. **Endpoint changes are explicit:** settings have editable drafts and an Apply action. Apply atomically changes configuration and synchronously invalidates affected work. Typing into an unsaved settings field does not change an active take.
4. **CSP uses an administrator allowlist:** permit exact configured speech origins, not arbitrary `https:`/`wss:` destinations. Browser URL settings are constrained by that allowlist. Do not disable CSP.
5. **Visibility:** Auto shows dictation after valid activation on browser-supported draft surfaces, including mobile, terminal input and comments. On additionally exposes unavailable controls in a disabled state with an actionable reason. Neither requires successful model discovery or previous inference. Off remains off. No dictation controls appear in password/secret fields.
6. **Capture ownership:** one active dictation session per tab; use Web Locks for same-origin cross-tab exclusion where supported. Do not pretend there is cross-tab exclusion on browsers without that API.
7. **Conflicts preserve user edits:** use a short-lived, owner-scoped recovery result rather than overwriting a changed draft.

Milestones:

- **Milestone 1:** direct record → stop → transcribe → review, including replacement controls, settings, CSP, desktop/mobile and comments.
- **Milestone 2:** live audio transcription using the deployed Speaches Realtime protocol after a mandatory compatibility spike. Both modes use the same controls and lifecycle.

The sequencing does not remove live transcription from the plan. Streaming text after uploading a completed file must not be described as live microphone transcription.

## 3. Pre-implementation baseline and replacement boundaries

Relevant files:

- `src/lib/voice.ts`: capture, MediaRecorder formats, metering, limits, upload, status discovery and browser SpeechRecognition fallback. No live audio upload today.
- `src/components/VoiceInput.tsx`: `useDictation`, `MicButton`, `VoiceRecordingPill`, shortcut registration, IME handling and insertion.
- `src/components/Composer.tsx`, `TerminalInput.tsx`: existing buttons and submission integration.
- `src/lib/settings.ts`, `src/components/SettingsDialog.tsx`: legacy visibility, polishing, OpenAI-key UI and fallback descriptions.
- `src/components/CommentPopover.tsx`, `CommentDraft.tsx`: shared comment field, Save/Delete/dismissal and keyboard handling.
- `useCommentSurface.tsx`, `useCommentPopover.ts`, and the separate `CommentPopover` mounted by `Composer.tsx`: all comment ownership and saved-comment editing paths must be covered.
- `server/static.ts`: production CSP currently enforces `connect-src 'self'`, blocking direct REST and WebSocket connections even with correct CORS.
- `site/demo/transport.ts`: currently passes non-API fetches and nonterminal WebSockets through to the real network. It is not sufficient demo isolation for direct speech.

Retain useful recording/metering/format-selection and pure insertion utilities, but explicitly replace unsafe lifecycle behavior:

- `voice.ts` currently finishes/uploads on page hide and keeps microphone tracks warm for 30 seconds.
- Each hook can acquire its own microphone; Settings can acquire another independently.
- `useVoiceInput` invalidates on engine changes, not every URL/model change.
- Raw transcripts can be inserted at a selection created after recording began.
- `forget()` drops polishing state but can preserve pending raw/IME-held results after Send.
- Voice and comment editors have competing window-capture Escape listeners.

Do not preserve these behaviors merely to minimize code changes. Remove dead fallback/control listeners from the client once the replacement owns the surfaces.

## 4. Settings, activation and model switching

Replace the existing Voice input settings content with one **Dictation** configuration surface, using existing SettingsGroup/SettingsRow primitives.

### 4.1 Fields and activation

- Microphone visibility: Auto / On / Off. Auto shows controls when an applied, activated HTTPS endpoint/model passes local validation and server-origin policy, and the browser supports capture. On additionally shows disabled controls with the missing configuration/capability reason. Both cover mobile, terminal and comments. Off hides/disables controls. Reachability, model-list success and prior inference are not visibility prerequisites; runtime failures are reported on explicit actions.
- HTTPS API base URL, explicitly including `/v1`.
- Model dropdown populated by an explicit Refresh models action, with a manual model-ID entry path.
- Read-only English recognition information.
- Record-then-transcribe mode initially; the same page gains a Live mode only after milestone 2's capability gate.
- Apply / discard edits and an explicit read-only connection/model check.
- Accurate privacy explanation: browser audio goes directly to the configured server, not OpenAI or a browser vendor.

Offer the user's endpoint/model as presets, not as permission to contact them. Require explicit application of the configuration before any private-origin requests. Apply accepts a locally valid URL/manual model ID without requiring discovery or inference. Refresh/Check stay disabled until a configuration is applied and always target that applied endpoint. Disable them while an unapplied URL differs, directing the user to Apply or discard it first. Selecting a discovered model changes the settings draft only; Apply commits it. Settings stay accessible when the microphone preference is Off.

Persist only non-secret configuration via existing per-browser settings machinery. Use this explicit legacy visibility mapping in a tested pure migration helper: `"off" → "off"`, `"on" → "on"`, `"auto" → "auto"`, `true → "on"`, and `false`/missing/invalid values → `"auto"`. The legacy `false → "auto"` behavior is intentional: old false also represented untouched defaults. All migrated configurations remain unactivated until explicitly applied. Remove `voicePolishChat`/`voicePolishTerminal` from active settings and sanitization; ignore stale stored fields. Remove obsolete translations with their UI references. Do not migrate browser/server authentication secrets into client storage.

Backend URL validation must reject credentials, query strings, fragments, malformed addresses and non-HTTPS origins. Normalize paths/trailing slashes without duplicating `/v1`. A backend not in the server allowlist receives an actionable configuration message, not a CSP workaround. Changing the model must not silently download it or choose a substitute.

### 4.2 Model discovery and readiness

Verify the deployed model-list API, normally `GET <base>/models`, and prefer its installed-model list over the remote catalog. The check is bounded, read-only and explicitly initiated. It never invokes POST/DELETE model management or submits hidden sample audio.

Scope discovery and readiness results to the applied endpoint/configuration generation and the individual request generation. Applying another endpoint cancels/discards old listings. Editing an unapplied URL neither changes an in-flight request's destination nor relabels its results as belonging to the proposed URL. A refresh never silently changes the selected model. Manual IDs remain possible when listing is unavailable or incomplete, but are shown as unverified.

Use honest states:

- Configuration saved.
- Service reachable.
- Selected model listed as installed.
- Transcription verified by an actual user-initiated take.

Do not infer loaded state or working GPU inference from model enumeration. Explain that the first transcription may load the selected model. Never promise that a model supports Realtime merely because REST inference succeeds.

## 5. Production CSP and cross-origin integration

Add an administrator-controlled exact-origin allowlist through `createServer(options)` and its environment fallback. Proposed names: `dictationOrigins` / `HERDR_WEB_DICTATION_ORIGINS` (JSON array of HTTPS origins). Empty means direct dictation is unavailable; deployment must explicitly allow `https://stt.intra.dle.dev`.

- Validate entries as origins, not unrestricted CSP fragments. Reject paths, credentials, query strings and fragments.
- Extend `server/static.ts`'s enforced `connect-src` with approved HTTPS origins and their exact WSS equivalents for the live milestone; keep other directives intact.
- Advertise the same sanitized allowlist through a new read-only authenticated endpoint, proposed `GET /api/dictation/config` with `{ enabled, allowed_origins }` in `shared/protocol.ts`.
- Test the endpoint in `server/api.contract.test.ts`, add the demo response, preserve route ordering and use standard HTTP error helpers.
- Prefer deriving headers and capability responses from one immutable normalized server configuration. A changed deployment policy requires a page reload to obtain matching CSP.
- Respect any stricter reverse-proxy CSP; document that multiple policies intersect. Test the actual production-served client, not just Vite.

CSP approval does not replace Speaches CORS configuration. Allow the exact herdr app origin in Speaches, verify proxy forwarding and WSS upgrades, and ensure the herdr page itself uses HTTPS. Never broaden to `connect-src https: wss:` as a shortcut.

## 6. Milestone 1 transport

Extract a small direct transport boundary, e.g. `src/lib/voiceTransport.ts`, while keeping capture and insertion separately testable.

Request:

- `POST <configured API base>/audio/transcriptions`.
- Multipart `file`, `model`, `language=en`, `response_format=json`.
- Omit/disable `stream` for this milestone.
- Preserve actual recorder MIME type and matching filename extension; let the browser generate multipart boundaries.
- `credentials: "omit"`, no Authorization, `redirect: "error"`, `referrerPolicy: "no-referrer"`.

Do not forward legacy `languages[]`, `keywords[]`, polishing fields or browser UI language. Validate a bounded JSON response containing `text: string`, then emit one take-aware raw result. Empty speech gets a no-speech result, not a fabricated success.

Retain 120-second and 10 MiB limits, enforcing the byte budget during chunk collection as well as before upload. Bound request duration, successful/error bodies and retained audio. Abort on cancellation and release blobs after completion. Do not retry or replay audio automatically.

Surface permission, capture-format, service/network, missing-model, inference, timeout, size and empty-result failures. CORS, CSP and VPN failures are often indistinguishable from JavaScript; give diagnostic suggestions without falsely identifying one cause. Aborting fetch cannot guarantee cancellation of already-running server inference.

Apply the same HTTP privacy defaults to every direct speech-service request, including model discovery and connection checks: omit credentials and Authorization, reject redirects, suppress the referrer, and bound response bodies/timeouts. Test these defaults for GETs as well as audio POSTs.

No direct-mode fallback to server OpenAI, browser recognition or cloud polishing. Legacy `/api/voice` status/key readiness must not gate direct mode; only the new non-secret capability policy applies.

## 7. Recording, ownership and draft safety

### 7.1 Capture coordinator

Replace independent hook-owned microphone acquisition with a shared per-tab coordinator covering permission requests, tracks, recorder callbacks, settings microphone tests (if added), timers and the active take through transcription completion.

- Reserve ownership before requesting permission; a second surface gets a clear busy state.
- If permission resolves after cancellation, stop the returned stream immediately without starting capture.
- Remove warm-microphone retention for the new implementation. Stop tracks when capture finishes; clean up the recording AudioContext/worklet, buffers and timers.
- Page hide, target unmount, connection loss, settings disable and cancellation stop capture and invalidate pending work. Page hide must not trigger upload.
- Use a same-origin Web Lock with nonblocking acquisition while a take is active, where available. Without Web Locks, enforce per-tab ownership only and document/test that cross-tab exclusion is unavailable. Do not use localStorage leases as if they were atomic locks.
- Recording never begins as a side effect of changing visibility, opening Settings or loading a model list.

### 7.2 Immutable take context and generations

Every take captures endpoint, model, language, mode, machine/pane identity, input instance, comment opening/target where applicable, draft revision and initial selection.

Applying changed settings, switching owners, explicit Send/Save/Delete, clearing/resetting a draft, cancelling or disabling dictation invalidates the take synchronously. Check the generation after every await and before preview, transcript, error or readiness updates. AbortController alone is insufficient. IME-held results and deferred composition flushes carry the same generation and are cleared on invalidation.

### 7.3 Insertion and recovery

When the original draft and insertion context remain unchanged, insert at the captured caret/selection through the existing draft setter. Never replace a later selection, rewrite intervening user edits or repopulate a draft after Send.

Every non-invalidating draft or insertion-context change since take start goes through recovery, including edits during recording, edits during upload and caret/selection changes without text edits. Retain the result only in memory on the same mounted owner and display **Insert at cursor / Discard**. Insertion requires an explicit action against the current draft. Track the owner textarea's most recent selection separately from DOM focus so clicking or keyboard-focusing the recovery button does not change the target. Validate that saved selection against the current draft revision at activation; if it is unavailable/stale, ask the user to place the cursor rather than guess a replacement range. Do not rewrite an active IME composition. The recovery result expires on owner close/change, Send/Save/Delete, disable or explicit discard; it is not persisted or transferred to another pane. Interrupted recordings are cancelled, not silently recovered through an upload.

Explicit Send submits only visible text and invalidates pending dictation first. Comment Save saves only visible draft text and invalidates first, including keyboard Save. Do not use legacy `forget()` as a substitute for cancellation.

## 8. Replacement controls and comments

Replace Composer and TerminalInput's existing microphone/pill mounts in place with one shared control family, also mounted in comment editors. Existing safe internals can be refactored underneath; there must be no duplicate microphone, legacy provider selector, OpenAI-key form, polishing control or browser-fallback privacy text left in this UI.

Use one primary Start/Finish control plus explicit Cancel, with consistent preparing/recording/transcribing/error states. Tap-to-toggle is primary on mobile; hold-to-talk may remain optional. Never force the keyboard open just to record.

Status/errors must fit the available surface: use in-flow or verified unclipped layouts in narrow popovers and keyboard-open mobile sheets, not an assumed fit of today's absolutely positioned, nonwrapping recording pill. Preserve touch targets, safe areas, accessibility and Send/Save/Delete placement.

Comment coverage includes new and saved comments in both `useCommentSurface` and Composer's separate saved-comment editor. Route text through `CommentDraft`'s setter/`onText`, never directly to comment storage. Carry owner/connection identity explicitly rather than reading global selection. Keep UI surface kind separate from legacy wire `VoiceMode` unless a real contract change is needed.

Centralize keyboard/Escape precedence rather than stacking competing window listeners:

1. A nested active dialog, including Settings, owns its keys.
2. In the active input, Escape cancels a take/recovery state first.
3. Only a subsequent applicable Escape uses normal comment dismissal protection.

This must work with focus on footer controls, not just inside the textarea. `stopPropagation()` does not arbitrate multiple listeners on the same window. The global dictation shortcut chooses the active comment/modal input, never the composer behind it. Preserve unsaved comment text across responsive redraws while invalidating the old take.

## 9. Milestone 2: live transcription compatibility gate

Inspect the deployed Speaches version and matching implementation, not just current upstream. Before implementation, record a standalone protocol probe covering:

- WSS URL, origin validation, session/model selection and protocol version.
- Audio format/sample rate/channel count.
- Append messages, VAD/turn boundaries, provisional versus final events, and explicit commit/finish.
- Errors, cancellation, proxy timeouts and whether model switching is supported per session.

Earlier documentation showed 24 kHz mono PCM16; follow the deployed protocol, not Whisper's internal 16 kHz input or another project's API. If results arrive only at utterance boundaries, present that accurately. A REST-ready model may lack usable Realtime support. Return with concrete limitations before upgrading remote infrastructure or silently changing scope.

After the gate:

- Add an AudioWorklet/resampling capture path if required and a separate Realtime adapter under the same coordinator/controls/settings.
- Bound outgoing buffers and outstanding audio. Stop visibly on sustained backpressure; no silent dropping or offline replay.
- Render committed phrases separately from replaceable partial hypotheses and reconcile revisions without duplication.
- Finish flushes pending frames, commits/finalizes and waits with a deadline; Cancel invalidates all results.
- WebSocket has no fetch-style `credentials: omit` or redirect policy. Do not promise cookie-free handshakes; use a dedicated service origin and validate browser/proxy behavior.
- Keep record-then-transcribe as an explicit mode, not an automatic fallback after partial uploads.

## 10. Tests and acceptance

### Unit and contract tests

Use Bun pure-logic tests for configuration migration, URL/path normalization, model selection/discovery generations, CSP origin normalization, request/response validation and lifecycle state machines. Extend `voice.test.ts`, `settings.test.ts`, comment tests and new transport/coordinator tests as appropriate.

Required negative cases:

- No legacy voice-status/key dependency and no vendor fallback.
- No private-origin request before Apply; afterward, only explicit Refresh/Check or recording initiates speech requests. Applied URL A → draft URL B disables discovery until Apply/discard and never redirects an in-flight A request to B.
- No model downloads/loads from read-only settings checks.
- Endpoint/model Apply during permission acquisition, capture and response delivery.
- Permission resolving late, delayed recorder stop, late error after cancellation, incremental byte overflow.
- IME completion after disable/Send, draft clear/reset, new selection after recording, stale model listings.
- Send during transcription and every comment Save/Delete/close path.
- Concurrent capture ownership, nested-dialog Escape and modal shortcut precedence.
- No automatic upload on hidden/offline state, no replay on reconnect.

New `/api/dictation/config` gets a shared contract, authenticated endpoint tests, standard error handling and `createServer` injection tests. Read the server/shared instructions before implementation.

### Production-served browser tests

Use a local cross-origin fake speech service, enforcing production CSP headers and fake microphone audio. A permissive Vite-only test is insufficient. Verify both allowed and blocked destinations and actual CORS handling.

Cover desktop/mobile composer, terminal input, reply/file comments and saved-comment editing. Assert exactly one replacement record control per applicable surface, no old key/polishing UI, unchanged surrounding text, explicit Save/Send, recovery for recording-time edits and caret-only changes, long comments, and no clipping with the keyboard open. Exercise keyboard-only Start/Finish/Cancel/Insert/Discard and preserve status live regions and alert roles for failures. Verify that focusing a recovery action keeps the owner textarea's insertion selection.

Extend existing `scripts/ui-regression.ts`, `block-comments-regression.ts`, and `file-viewer-comments-regression.ts`, or register new scripts in `scripts/ci-browser.sh`. Build first and use isolated test/demo sessions only.

### Demo isolation

Direct dictation must be unavailable or simulated in the public demo regardless of persisted settings. Add an explicit demo capability/transport guard; do not rely only on intercepting relative `/api` calls. Update `site/demo/transport.ts` for the new capability route and direct fetch/WebSocket paths. Tests must assert zero real private-origin requests, including model refresh and stale previously enabled preferences.

### Manual validation

With explicitly authorized requests to the real service:

- Verify herdr origin HTTPS, effective production CSP, NetBird proxy/CORS and WSS behavior.
- Test actual Android Chrome and iOS Safari where available; report untested platforms honestly.
- Validate MP4/AAC and WebM/Opus, permission denial, background/lock/unlock, VPN loss, pending transcription while saving comments, and cross-tab behavior.
- Record image/version, model, compute type and TTL with timings. Keep private recordings/transcripts outside Git and logs.

Run targeted tests, typecheck, build and repository fast checks, then the isolated browser lane. Document unavailable checks; do not test against the user's live herdr session.

## 11. Documentation, rollout and completion

Update `docs/guide.md`, privacy wording, changelog and Korean/Japanese/Chinese dictionaries. Explain settings Apply, model discovery versus inference readiness, mobile interruption behavior, conflict recovery, NetBird direct access and the administrator CSP allowlist. Follow CSS tokens and lucide icon rules.

Milestone 1 is complete when a configured phone can record directly to Speaches and insert English text into every supported draft, including comments, through exactly one replacement control family, without OpenAI keys, cloud fallback, automatic Save/Send, lost edits or cross-target insertion.

Milestone 2 is complete when the deployed protocol is verified and live results/finalization work through those same controls with bounded buffering and tested interruption behavior.

Compatibility-only server voice routes and their credentials remain untouched unless a separately approved removal task follows. No automatic speech-container upgrade, extra model download or remote infrastructure mutation is part of this UI implementation. The sole required deployment change for direct access is the explicit herdr-side CSP allowlist plus any already-needed speech-service CORS/proxy configuration.

## 12. Implementation and validation record

Milestone 1 now uses `voiceTransport.ts` for direct REST/policy/discovery, `voice.ts` for capture ownership and bounded recording, and `dictationDraft.ts`/`VoiceInput.tsx` for revision-safe insertion and recovery. All comment mount paths explicitly carry owner/connection identity. The legacy client transport/key/polishing UI has been removed; the server compatibility routes remain unchanged.

Validation performed:

- Fast checks: workflow syntax, generated types, typecheck, production build, and 2,491 passing unit tests (seven platform-dependent skips).
- `server/api.contract.test.ts`: 99 passing tests on an isolated herdr, including authenticated policy and CSP.
- Complete registered browser lane: 22 successful steps, including the new production-served direct-dictation test, Settings/demo isolation and existing comment/file/terminal regressions.
- Direct-dictation browser coverage uses a disposable local HTTPS service, actual browser CORS/CSP enforcement and fake-device MediaRecorder audio. Desktop and mobile-sized viewports cover draft/caret conflicts, keyboard recovery, IME, nested dialogs, cross-tab Web Locks, Send/Save/close cancellation, direct multipart privacy, comments, terminal drafts and pagehide/offline interruption. This does not constitute testing on Android or iOS hardware.
- Browser testing caught and fixed unbound Window timers and an animation-frame caret restoration race; late chunks from cancelled test recorders are now excluded from the next take's audio-ready check. Existing synthetic capability and comment-format fixtures were updated rather than weakening their assertions.

Read-only checks of the deployed service confirmed `/v1/models` is the local-model API, with an ASR task filter, and the selected `distil-whisper/distil-large-v3.5-ct2` is installed. `/openapi.json` reports only generic FastAPI `0.1.0` metadata and advertises a `/v1/realtime` WebRTC POST; this does **not** establish the deployed Speaches image/version or its WebSocket event protocol. No audio was uploaded during these metadata checks and no remote models, containers or infrastructure were changed.

Remaining rollout gates: set the administrator origin allowlist, restart/reload, validate the actual app-origin CORS/NetBird path and Android/iOS capture. Milestone 2 still requires the matching deployed implementation/version plus the standalone Realtime audio/finalization probe described above; it must not be presented as implemented streaming.
