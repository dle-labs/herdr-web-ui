### Added
- Choose Auto, OpenAI, browser recognition or a self-hosted Speaches backend in Settings →
  Dictation. Configure the complete HTTP(S) API base URL, optional API key, language and model;
  administrators choose trusted destinations, including local and private servers. Include `/v1`
  explicitly when required. Environment overrides remain supported and explain how to change
  their values and restart WebUI.
- Dictate reply and file comments, then explicitly add the comment and quote to the message
  draft for review before sending. Undo the last inserted take or recover text after a draft changes.

### Changed
- Speaches transcribes a completed recording through WebUI. Finish, review, then Send remains
  the default; optional finish-and-send applies only to an explicit Send during recording.
  Explicit providers and active takes never fall back after an error. Browser connections remain
  same-origin, destination changes require owner access, and audio uploads retain multipart headers.

### Fixed
- Finishing chat dictation with Enter focuses the message draft so a second Enter can send it
  after transcription. Pointer dictation and focus changes made while waiting remain untouched.
- Keep the mobile chat microphone visible when Speaches is explicitly selected, including setup
  explanations; Microphone Off still hides it. Dictation settings fit narrow screens, direct
  terminal typing keeps no extra input box, and Terminal Find retains its state with line input.
