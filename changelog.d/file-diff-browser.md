### Added
- Browse files and working-tree Git changes in one modal viewer with a compact file tree,
  file-type icons, dimmed Git-ignored folders and continuous diffs. File links use this browser;
  inline old/new line-range comments join the next chat message. Unified/Split controls share
  the File viewer Settings preference and sit beside Refresh when diffs exist.
- Use Pierre's Shiki engine across diffs, files and chat, with shared palette colors and bounded
  background highlighting for file/chat code.

### Changed
- Filename search and Compare with… share the Files header, with wider horizontal control spacing
  and no redundant magnifying-glass icon or body toolbar. Search and commit results float above
  content in five-row scrollable lists instead of pushing the file view down.
- Selecting text offers a Comment action instead of immediately focusing an editor, preserving
  native copying on desktop and mobile.

### Fixed
- The Browse files shortcut and header menu icon show a small dot for working-tree changes.
  Settings → File viewer can hide the composer shortcut without removing the menu entry; the
  choice stays on this device.
- Browse files opens beside the microphone or attachment button, without selecting a diff.
  Filename search is keyboard-friendly; compare all files or one selected file to a previous commit.
- Comment fields measure wrapping outside the source/diff layout and update height only when
  needed, avoiding expensive per-character height resets while retaining growth and shrinking.
- Opening a diff comment preserves the source line and viewport instead of expanding unrelated
  context and scrolling. Explicit comment links still reveal their saved target.
- Unsaved diff comments have Discard in unified and split views. Deleting a saved comment removes
  concurrent updates on the same target without touching other sides or revisions.
- Changed files mark every ancestor folder, including collapsed folders, with an accessible indicator.
- Browsers retain their opening pane and unsaved comments through pane selection and refused Back
  navigation. Comment links open once, including renamed paths and unavailable-diff fallbacks.
- Git inventories skip unsupported embedded repositories without hiding other changes; cached
  deletions retain a consistent deleted side even when the file remains on disk.
- Comment editors remain clear of their source text. A desktop editor reserves space below the
  reading area when no floating position fits, preserving its draft, focus and caret.
- Closing an embedded file returns to navigation without closing the browser. Unsaved comments
  block both embedded and outer Close actions.
- New, staged and modified Markdown files open rendered previews when browsed or followed from
  links. Preview/Diff switching preserves comments; explicit changes/comment links open the diff,
  and unavailable previews explain their source fallback.
- Comment editors no longer stop at 2,000 characters; the combined message still obeys the send limit.
- Chat selection comments retain list bullets, numbering and task checkbox markers in their quotes.
- Sent chat/file comments stay outside quoted text in terminal Markdown renderers.
