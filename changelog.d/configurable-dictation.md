### Added
- Self-hosted dictation accepts a complete HTTP(S) API base URL, including internal servers,
  custom paths and SSH local forwards. Supply /v1 explicitly when required; it is no longer appended.
- Dictate reply/file comments, then explicitly add the comment and quote to the message draft
  for review before sending. ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)
- Configure Speaches URL, optional key, language and model in Settings → Dictation, and undo the
  last inserted take. ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)

### Changed
- Dictation defaults to Auto: configured/supported OpenAI, otherwise supported browser recognition.
  Explicit choices and active takes never fall back. Hold/tap controls and the compact seven-bar
  pill remain in chat and terminal input lines.
  ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)
- Speaches transcribes completed recordings through WebUI. Finish, review, then Send remains the
  default; opt-in finish-and-send applies only to explicit Send during recording.
  ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)

### Fixed
- Dictation settings explain environment overrides and variables to change/unset before restarting
  WebUI, including overrides appearing after page load. Other save failures retain safe messages.
- Finishing chat dictation with Enter focuses the draft so a second Enter can send after transcription;
  pointer dictation and focus changes while waiting remain untouched.
- Preserve multipart Content-Type when relaying recorded audio through Bun, preventing backends
  from rejecting valid uploads as missing form fields.
- Keep the mobile microphone visible when Speaches is explicitly selected, including setup
  explanations; Microphone Off still hides it.
  ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)
- Dictation settings stay readable on narrow screens, direct terminal typing adds no input box, and
  Terminal Find retains its state with line input.
  ([#936](https://github.com/devswha/herdr-web-ui/pull/936) by @polaroidkidd)
