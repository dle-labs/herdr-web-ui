### Added
- Browse files and all current Git changes in one modal viewer with a compact file tree,
  file-type icons, dimmed Git-ignored folders and continuous diffs. File links open in this
  same browser. Unified/Split controls share the Settings layout preference. Add inline old/new
  line-range comments, with dictation, to the next chat message.
- Use Pierre's Shiki highlighting engine across diffs, files and chat, with shared palette
  colors and bounded background highlighting for file/chat code.

### Changed
- Filename search and Compare with share the Files modal header. Both open floating,
  scrollable five-row pickers without moving the document; keyboard navigation stays in the list.
- Selecting text offers a Comment quick action instead of immediately focusing an editor,
  preserving native copying on desktop and mobile.

### Fixed
- Comment fields measure wrapping outside the reading layout and change height only as needed.
  Editors stay clear of their source, reserving space when no floating position fits.
- Opening a diff comment keeps its source line, collapsed context and viewport in place.
  Explicit comment links reveal their saved target, including renamed paths and unavailable diffs.
- Unsaved diff comments have a Discard action. Deleting a saved comment also removes another
  tab's update on that target without touching other sides or revisions.
- Changed files mark every ancestor folder, including collapsed folders, with an accessible
  indicator. Browse files buttons show a dot for current working changes, not historical diffs;
  Settings can hide the composer shortcut without removing the header menu entry.
- File browsers retain their opening pane and unsaved comments through pane selection and
  refused Back navigation. Closing a file keeps its browser open; unsaved comments protect both.
- Git inventories skip unsupported embedded repositories without hiding other changes, and
  cached deletions keep a consistent deleted side even when the file remains on disk.
- Browse files opens beside the microphone or attachment button without selecting a diff.
  Search filenames and compare all files or one context-menu-selected file with a previous commit.
- New, staged and modified Markdown files open as rendered previews when browsed. Preview/Diff
  switching preserves comments; explicit comparisons and comment links retain their diff intent.
- Comment editors no longer stop at 2,000 characters; the combined message retains its send limit.
  Selection quotes keep list and task markers, and sent comments stay outside their quoted text.
