# Antigravity Chat

Chat reads the active Agy conversation's `transcript_full.jsonl`. User messages,
assistant text and expandable tool activity use the existing Chat view. Terminal
remains available for native commands and approvals. Reading Chat makes no model call.

The reader follows the presence lock held by the pane's Agy process, including after
`/new` and `/resume`. It does not choose a session by directory, timestamp or startup
arguments, and needs no hook or status-line configuration.

The ledger is replayed in order: repeated or backwards step indices replace the
corresponding suffix. A read-only query of the conversation database's step indices
also honors a saved rewind before replacement ledger records arrive. The reader does
not decode database payloads. Changed history invalidates older-page cursors and
expanded output references; ordinary appends preserve them.

Planner calls and exported tool results have no shared native call ID in the tested
format, so results appear as independent tool-output rows. Hidden context and reasoning
are omitted. Image rendering and child-session expansion are outside this first scope.
The known `<USER_REQUEST>` wrapper is removed only when followed by the native
metadata suffix; standalone literal wrapper text is preserved. Error-only records
without text are not rendered. Only completed (`DONE`) exported steps are rendered; an unfinished last row waits,
and an unfinished historical row does not hide later completed turns.

Linux process/lock discovery and native lifecycle behavior were tested with Agy 1.3.3.
macOS uses `lsof` for the same held-file evidence but has not been tested natively.
Its `ps` process-birth check has one-second resolution; same-second PID reuse is not distinguished.
Windows currently falls back to Terminal because this adapter has no native handle
lookup. A remote machine runs the reader on that machine, beside its agent store.

Missing or ambiguous identity and unreadable stores use the existing terminal fallback.
An identified idle session with an empty database can show empty Chat before the ledger
exists. Until the ledger exists, discovery uses the monitor’s two-second retry; catalog
change notifications start after resolution. A new process without a conversation lock
still uses Terminal. A cold scan reads
up to 32 MiB per poll and resumes on the next poll; individual records are limited to
16 MiB and active history to 100,000 steps. Malformed complete step records use Terminal;
an incomplete final line waits for its newline. Rebuilding an evicted transcript index
invalidates its old cursors rather than reusing forgotten history state.

The database and export are written separately. The reader checks active indices around
each read and remembers observed removals, but does not claim an atomic database/export
snapshot or detect a rewind-and-regrow completed entirely before its first observation.
Eviction or rebuilding of the bounded index also forgets observed removals: if the database
has already regained an index but its replacement ledger row has not arrived, old ledger
text can briefly reappear. A new history ID invalidates old cursors but does not remove
that cross-file lag window. No persistent retirement state or database payload decoding
is used.

Validation covers fictional parser/paging fixtures, the conversation and whole-output
HTTP endpoints on an isolated Herdr server, and replay of an owned native conversation
through the production reader after saved rewind and restart. Native manual checks also
covered `/new`, `/resume`, repeated rewind, graceful restart and one crash while working.
These are bounded checks, not a guarantee about every Agy version or crash timing.
