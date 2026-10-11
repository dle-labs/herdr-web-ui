# Pi extension visibility

## Scope and ownership

Implement two bounded WebUI integrations against RPIV ask-user-question 2.12.0 and
pi-subagents 0.20.0. The bridge remains a reader of herdr's screen and Pi's existing
session transcript; herdr owns input, and Pi owns extension execution.

The user approved implementation on the rebased `main` checkout. No publication,
deployment, installed-package modification or remote-bundle change is authorized by
this work. After the screen-only pass established that RPIV does not expose verified
live bindings/tab ownership, the user additionally approved implementing an opt-in
RPIV-side bridge contract. Its patch/helper is tested on a disposable package copy;
installation into actual Pi sessions still needs separate approval. Remote bridges need the matching fork backend before these adapters can
serve remote panes; selecting a remote PC does not install this change implicitly.

## RPIV questionnaire adapter

- Recognize RPIV separately from Pi's native dialogs using corroborating visible
  structure, not a footer keyword or a pending transcript tool call alone.
- Use the existing machine-scoped prompt endpoint and asking IDs. Answers navigate
  with herdr keys/text; they never become chat submissions or numeric terminal picks.
- Model multi-select toggles separately from confirmation. RPIV's Enter on an option
  toggles; Next confirms. Moving into custom input must not press Enter before text.
- Bound and verify intermediate state transitions. A changed asking, unknown cursor,
  lost connection or uncertain input outcome ends the operation without retry.
- The opt-in adapter must identify its live process, session and question, publish
  bounded state and actual effective bindings, expire stale state, and close cleanly.
  The backend must still corroborate terminal ownership and verify each transition.
  An unpatched package keeps a visible terminal-only card, never assumed default keys.
- Expose only states whose input semantics are known. Hidden/collapsed content,
  unsupported bindings, ambiguous clipping, notes and review modes must not inherit
  unsafe generic Enter actions. Add richer actions only with fixtures and route tests.
- Preserve the original terminal as the fallback and do not queue ordinary chat into
  an identifiable but unsupported questionnaire.

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
   states and identify the installed package versions they model.
2. Pure parser/normalizer tests and prompt route tests cover cursor movement, checked
   state, custom input, stale IDs, concurrent terminal edits and interrupted delivery.
3. Conversation tests cover malformed details, grouped notifications, missing records,
   branch selection, pagination and cold/warm reads without private transcript data.
4. Production-client browser checks exercise phone/desktop cards, folded work,
   reloads, accessibility and existing machine/connection ownership.
5. Run fast checks, targeted contracts/browser checks and isolated full checks. Record
   failures with their baseline evidence; do not describe a partially passing lane as
   green.

## Baseline

Before implementation, the rebased checkout still fails the existing
`prompt-dock-demo-regression.ts` 800×600 transcript-height assertion: 4.90625 px versus
48 px required. Its preceding desktop/phone placement and basic answer checks pass.
This is pre-existing evidence, not a reason to relax new questionnaire safety tests.
