---
id: triage
display_name: Triage
---

# Triage

Your job is to classify each deduplicated finding before severity is assigned.

Use this dedupe handoff:

Deduped findings:
{{artifact_path:dedupe-findings}}/deduped-findings.json

Finding lifecycle ledger:
{{artifact_path:dedupe-findings}}/finding-lifecycle-ledger.json

For each deduplicated finding, run a consensus investigation inside this review
step:

- Perform {{triage_panel_size}} independent investigation passes, each using the
  maximum available reasoning level.
- Use sub-agents when they are available and useful for keeping those passes
  independent. The topology gives this review node an extended timeout so the
  independent passes can finish.
- Each pass must independently inspect the finding, generated test, relevant
  target code, public specifications, and any upstream evidence.
- Each pass must choose exactly one classification:
  - `true-positive`: credible production issue.
  - `false-positive`: invalid issue with no useful follow-up.
  - `undetermined`: needs more human review before classification.
  - `incomplete-spec`: public specification or policy is missing, ambiguous, or
    contradicted.
  - `harness-defect`: the generated test or harness violates required
    preconditions or models the protocol incorrectly.
  - `repair-candidate`: a local generated test, prompt output, or campaign
    artifact should be repaired before re-running.
  - `spec-gated`: behavior may be valid or invalid depending on an explicit
    product/spec decision.
  - `defensive-hardening`: not a production bug, but a guard, assertion, or
    documentation hardening would reduce risk.
- If at least {{triage_quorum}} of {{triage_panel_size}} passes agree, use that
  classification.
- If no classification reaches {{triage_quorum}}-of-{{triage_panel_size}}
  agreement, classify the finding as `undetermined`.

When rerunning generated tests, focused proofs, temporary public wrappers, or
any other Foundry command during triage, run `forge --version` as a separate
Bash call first. If `forge` is available in `PATH`, run focused tests with
direct `forge` commands while preserving the original command's environment
variables, flags, match selectors, and test-root semantics. Do not add inline
environment assignment prefixes to generated tests, project-native tests,
temporary public wrappers, or focused proof reruns; commands should start with
`forge` so backend allowlists match them. Do not use command substitution, shell
conditionals, absolute binary paths, or host-global searches to resolve Foundry.
If `forge` is unavailable in `PATH`, record validation as blocked by tool
availability and do not treat
`forge: command not found` as a reproducer result or classification signal.

Some findings arrive without a rerunnable generated test or PoC: a producer may
declare a schema-defined empty generated-tests bundle, or none at all, and
carry its execution evidence inline in the finding. For those findings, the
missing reproducer is neither blocked validation nor demotion evidence by
itself. Each pass must evaluate the recorded evidence — executed commands,
observed and expected values, source fragments, affected paths — against the
target source and public specifications, may author a minimal focused
reproduction in this workspace when practical, and must classify from that
evidence. When the inline evidence is insufficient to decide, classify the
finding `undetermined` and state exactly what reproduction evidence is missing
rather than defaulting to `false-positive`.

## Helper reachability audit

During each pass, check whether the failing proof depends on directly calling
an internal helper, library function, generated wrapper, or test-only adapter
instead of a production public/external entrypoint. For those findings, triage
must audit public reachability before treating the result as production
evidence:

- If a public/external entrypoint trace or generated public wrapper PoC reaches
  the same helper behavior under production-like preconditions, the finding may
  remain `true-positive`. Add the matching reachability entry from the authority below.
- If the proof reaches the behavior only through a helper and public entrypoints enforce stricter bounds,
  classify it as `harness-defect`, `defensive-hardening`, or `false-positive`
  according to the evidence. Set `status` to `false-positive` only when you
  classify the finding as `false-positive`; for the other two classifications
  leave `status` exactly as the deduped finding carried it. Record why
  production reachability is absent either way.
- If direct public reachability is unclear, classify it as `undetermined` and
  add the authority-listed reachability entry for a required public wrapper plus the exact public wrapper or
  entrypoint evidence needed before severity can treat it as production
  exploitable.

Authoritative reachability tokens:

{{finding_reachability_vocabulary}}

Authoritative report-bound note keys: {{finding_note_key_vocabulary}}

## External dependency scope audit

During each pass, check whether the finding depends on an external dependency,
callback, oracle, token, hook, adapter, bridge, router, vault, pool, or
third-party protocol behaving incorrectly. Require a source-backed in-scope rationale
before treating that dependency behavior as production evidence.

- If the finding depends only on `trusted-boundary-failure`, such as making a trusted oracle lie or a trusted third-party protocol malfunction, classify it
  as `false-positive` unless public docs, interfaces, tests, specs, or comments
  explicitly say the protocol promises to tolerate that behavior. Add the
  dependency-scope entry from the authoritative note-key list with value `ambiguous-or-out-of-scope`.
- If the proof relies on `undocumented-external-misbehavior`, an explicitly
  unsupported token breaking ERC-20 semantics, or an out-of-scope callback
  acting maliciously, classify it as `false-positive`, `incomplete-spec`, or
  `spec-gated` according to the available evidence. Do not promote it to
  `true-positive`.
- If the finding tests project-owned validation, wrapper, adapter,
  authorization, bounds, staleness, sanitization, rollback, or error-handling
  logic and cites explicit public evidence that the protocol promises that
  guard, it may remain eligible for `true-positive`. Add the dependency-scope
  entry from the authoritative note-key list with value `source-backed-in-scope` and cite the source-backed
  in-scope rationale.
- If the dependency scope is ambiguous, preserve the useful scope note or
  harness note, but classify the production claim as `incomplete-spec`,
  `spec-gated`, `defensive-hardening`, or `false-positive`, not
  `true-positive`.

## Required batch rollback audit

During each pass, check whether the finding involves a structured batch,
multicall, packed action list, or opcode/action array with required-success
semantics. When public docs, interfaces, ABIs, or tests enumerate a finite
opcode/action set and describe required batch success, rollback, or
all-or-nothing semantics, unknown required opcodes/actions should fail. If a
required unknown opcode/action is accepted and earlier required mutations remain
externally visible, the oracle is production-backed unless public docs
explicitly define unknown required actions as no-ops or skippable.

- Do not downgrade the finding only because docs omit a sentence saying every
  unknown required action must revert; the finite opcode/action set plus
  required rollback semantics is enough source support.
- Require evidence that the proof checks rollback of the earlier required
  mutation, including no live order or externally visible state delta through
  public getters, balances, queues, events, nonces, or equivalent state.
- If either the finite opcode/action set or required rollback semantics is
  missing or ambiguous, preserve the repro but classify the production claim as
  `incomplete-spec`, `spec-gated`, or `undetermined` according to the evidence.

For an arithmetic mismatch reachable only through a helper that bypasses public entrypoint bounds,
use `harness-defect`, append the matching non-public reachability entry from the
authority above, and bind the same concrete explanation through one
classification-reason entry and one demotion-reason entry from the authoritative
note-key list. For a mismatch reached through a production-like public
entrypoint, use `true-positive`, append the matching production-entrypoint
reachability entry from the authority above, preserve the direct helper proof,
state the public exploitability, and bind one classification-reason entry from
the authoritative note-key list.
These are semantic examples, not alternate JSON shapes.

Do not remove findings during triage. Preserve the upstream finding fields and
add or update `triage_classification` with the consensus value. Triage owns only
`triage_classification`, `notes`, and `status`; every other field must come
through unchanged as a parsed JSON value, and record count, record order, and
each `id` must match the deduped array position for position.
`notes` is append-only: copy every upstream note verbatim and in its original
order, then append your new notes at the end. Never edit, re-word, re-punctuate,
merge, re-order, de-duplicate, or drop an inherited note; whitespace and
punctuation changes count as edits. Keep the notes you append concise, and use
them to summarize the votes, decisive evidence, and recommended next action.
Every triaged finding must include exactly one machine-readable reason entry
using one of the two authoritative reason keys in the note-key list.
The first note carrying either key is the one that binds downstream, so never
emit a second reason note. For every classification other than `true-positive`,
also include exactly one entry using the authoritative demotion key;
for `true-positive`, emit no demotion entry at all.
When a finding is classified as `false-positive`, set `status` to
`false-positive`. For every other classification, copy `status` from the deduped
finding unchanged; triage may set `status` only to `false-positive`, and only
for a `false-positive` classification. The finding schema lists the other status
values because other stages own them, not because triage may write them.
In particular, preserve `property_ids` unchanged for every property-derived
finding.

For stateful invariant records, preserve any upstream typed stateful-failure
classification entry from the authoritative note-key list exactly. Coverage-only
success is not evidence that the record should be removed. Treat
`production-bug`, `harness-defect`, `incomplete-spec`, `false-positive`, and
`blocked-unreproduced` as distinct upstream outcomes that must remain visible in
`triaged-findings.json`; triage may add consensus notes, but it must not erase
the original classification, reproducer, blocker, or repair evidence.

Save triaged findings to {{output_stage_findings_path}} using the exact pinned
`{{schema_path}}/triaged-findings.schema.json`; it alone defines the JSON
version, fields, types, enums, required members, and empty forms. Apply exactly
one consensus classification from the values above to every input finding.

Also save {{artifact_path}}/finding-lifecycle-ledger.json by copying the input
ledger using the exact pinned
`{{schema_path}}/finding-lifecycle-ledger.schema.json` and updating the matching
`dedupe_key` record for every triaged finding:
set `triage_classification` to the same value the triaged finding carries, set
`triage_reason` to exactly the assigned value of the finding's first
authoritative reason entry, character for character with no re-casing,
re-punctuation, trimming, or rewording, set `demotion_reason` the same way from
that finding's authoritative demotion entry for
every classification other than `true-positive`, omit `demotion_reason`
entirely for `true-positive`, and append a `triaged` stage whose
`artifact_path` is the portable declared output-relative path
`{{output_stage_findings_relative_path}}`. Do not match lifecycle records by title
when `dedupe_key` is available.

Preserve the input record order and every existing field and stage byte-for-byte
in parsed JSON value terms. Add only `triage_classification`, `triage_reason`,
the required `demotion_reason`, and one final `triaged` stage whose
`artifact_path` is the portable declared output-relative path
`{{output_stage_findings_relative_path}}` and whose `finding_id` is unchanged. Do not
author severity, final disposition, or
comparison fields in this stage.

After both final writes, run every exact `ultrafuzz json validate` command
rendered for them in the central output contract. Correct any exit-1 artifact
yourself and rerun its command after any later edit.
