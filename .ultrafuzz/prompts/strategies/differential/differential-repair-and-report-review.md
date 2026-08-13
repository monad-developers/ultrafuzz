---
id: differential-repair-and-report-review
display_name: Differential Repair And Report Review
---

# Differential Repair And Report Review

Repair only consensus harness or reference defects from the looped triage outputs:

Semantic red registries:
{{artifact_handoff:differential-red-triage}}

Triage A artifacts:
{{artifact_path:differential-red-triage}}/triage-a.json

Triage B artifacts:
{{artifact_path:differential-red-triage}}/triage-b.json

Lane results:
{{artifact_handoff:differential-lane-author}}

Audited lanes:
{{artifact_handoff:reference-and-lane-auditor}}

This workspace should include direct replay of `base-test-setup` fixtures and
`differential-lane-author` generated lane tests. Use those replayed files for
final focused-command reruns. If a focused command matches zero tests, first
check whether the expected lane file exists in this workspace before marking
the campaign incomplete.

The `differential-red-triage` logical node is expected to provide
`{{strategy_loop_count}}` fresh attempt artifact directories. If fewer than
`{{strategy_loop_count}}` independent triage attempt directories are present, do
not repair; mark the campaign incomplete in `gap-review.json` and
`differential-report-review.json`.

Never weaken, remove, skip, or over-bound credible production-bug red tests. Do
not repair reds classified as production bug, spec mismatch, or unknown. Never
regenerate, rewrite, normalize, or convert the upstream semantic-red registry;
keep `semantic_red_registry_regenerated: false` and record only the repair result
against the preserved stable hash.

Repair a harness or reference defect only when every fresh triage attempt
independently agrees it is a harness or reference defect. If the attempts
disagree, or any attempt classifies the red as production bug, spec mismatch, or
unknown, preserve the red and report the disagreement.

Run a final gap review before reporting. Include green suites, missing lane artifacts, no-assigned-lane attempts, lanes without focused commands, focused commands that ran zero tests, and audited ready lanes without a corresponding `lane-result.json`. Emit missing-lane or incomplete-campaign work orders when artifacts are absent.

Preserve declared artifact order throughout. Reconcile each registry hash with
both exact triage siblings from every attempt. Repair only a semantic red for
which every A/B classification is the same `harness_bug` or the same
`reference_bug`; disagreement is preserved as `unknown`. Do not infer an
omitted row, search for a same-named file, or use a fallback/version conversion.

Write {{artifact_path}}/repair-summary.json using the exact pinned
`{{schema_path}}/differential-repair-summary.schema.json`. Record attempted
repairs and their results against preserved stable failure hashes, keep
production/spec/unknown reds in the preserved set, and leave the registry
regeneration flag false.

Write {{artifact_path}}/gap-review.json using the exact pinned
`{{schema_path}}/differential-gap-review.schema.json`. Reconcile every audited
ready lane with the exact lane result having the same lane, attempt, auditor,
and source-artifact coordinates. Record missing results, no-assigned-lane
attempts, zero-match commands, absent triage attempts, green-suite evidence,
and report blockers without inventing or converting a lane identity.

Write {{artifact_path}}/differential-report-review.json using the exact pinned
`{{schema_path}}/differential-report-review.schema.json`. Derive campaign
status from that reconciliation, preserve credible production reds, report
only consensus harness/reference repairs as repaired, carry missing or deferred
lane coordinates unchanged, and make report-ready rows join their exact stable
failure hashes.

Those pinned schemas alone define each JSON version, fields, types, enums,
required members, and empty forms. The preservation, consensus, ordering, and
cross-artifact joins above remain contextual requirements beyond JSON Schema.

Also write the standard findings output to `{{output_findings_path}}`. If
`production_bug_reds` is non-empty, mirror each credible production-bug red as a
normal finding so downstream dedupe, triage, and final reporting consume it. Use
the exact stable failure hash as the finding `id`; do not invent an alias. Use
the schema-defined empty findings form only when no production-bug reds are
confirmed.

Also write `{{artifact_path}}/generated-tests.json` using its exact pinned
schema from the central output contract. Classify repaired or preserved replay
tests as runnable and each imported helper, mock, fixture, script, or data
dependency as non-runnable support. Use the schema-defined empty bundle when
this node produced no generated or repaired test files.

After every final write, run every exact `ultrafuzz json validate` command
rendered in the central output contract. Fix the authored JSON yourself;
validation must not repair or convert it, and do not return or exit until every
command passes.
