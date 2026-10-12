# Recorded Pi delegation visibility

## Scope and ownership

Implement a bounded WebUI integration against pi-subagents 0.20.0. The bridge
reads Pi's existing session transcript; Pi owns extension execution.

Remote bridges need the matching fork backend before recorded delegation support
can serve remote panes; selecting a remote PC does not install it implicitly.

## Recorded subagent/workflow evidence

- Normalize only supported extension tool details and persisted custom records.
  Bound strings, arrays, nesting and numeric fields; retain generic text fallbacks.
- Carry typed optional metadata through conversation parsing and pagination, keeping
  active-branch selection and cache invalidation intact.
- Show compact summaries outside ordinary folded tool work, with expandable original
  output. Deduplicate repeated evidence without merging distinct runs or resumptions.
- Label evidence as last recorded. A launch is not proof of current activity; the end
  of a parent turn is not proof that a child finished. Unknown fields remain unknown.
- Do not change sidebar task counts, background-wait semantics or notifications from
  incomplete transcript evidence.

## Not part of this implementation

Full live FleetView/workflow progress needs an explicit extension-side telemetry
contract: session/run identity, freshness, expiry, restart reconciliation and remote
routing. The existing workflow journal is not that contract. Do not scan arbitrary
output paths or automatically invoke `get_subagent_result`: consuming a result can
suppress the extension's completion notification.

## Verification gates

1. Fictional, isolated renderer/transcript fixtures cover supported and unsupported
   records and identify the installed package version they model.
2. Conversation and normalizer tests cover malformed details, grouped notifications,
   missing records, branch selection, pagination and cold/warm reads without private
   transcript data.
3. Production-client browser checks exercise phone/desktop cards, folded work,
   reloads, accessibility and existing machine/connection ownership.
4. Run fast checks, targeted contracts/browser checks and isolated full checks. Record
   failures with their baseline evidence; do not describe a partially passing lane as
   green.
