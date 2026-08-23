---
id: differential-repair-and-report-review
display_name: Differential Repair And Report Review
---

# Differential Repair And Report Review

Use only the authoritative report-bound note vocabulary:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}

Repair only consensus harness or reference defects from the looped triage outputs:

Sealed JSON authority for every declared semantic-red registry:
{{ancestor_contract_artifact_authority:ultrafuzz/semantic-red-registry@1}}

Sealed JSON authority for every declared A/B triage artifact:
{{ancestor_contract_artifact_authority:ultrafuzz/differential-red-triage@1}}

Sealed JSON authority for every declared lane result:
{{ancestor_contract_artifact_authority:ultrafuzz/differential-lane-result@1}}

Sealed JSON authority for every declared audited-lanes artifact:
{{ancestor_contract_artifact_authority:ultrafuzz/audited-differential-lanes@1}}

Read those manifest definitions instead of expecting expanded path or source
arrays in this prompt. Use each selected absolute path only for reading. Derive
report coordinates from the run-relative paths in each selector's required
`localeCompare` order.

This workspace should include direct replay of `base-test-setup` fixtures and
`differential-lane-author` generated lane tests. Use those replayed files for
final focused-command reruns. If a focused command matches zero tests, first
check whether the expected lane file exists in this workspace before marking
the campaign incomplete.

Trust only the exact declared semantic-red registry and A/B triage artifacts
selected from the sealed manifest. Group them by the exact producer task and
`artifact_dir`; require that producer's one registry plus its declared `pass: a`
and `pass: b` siblings. The authenticated producer `attempt_id` establishes
freshness and independence. Do not probe for, count, or require nested attempt
directories, and do not create a report blocker merely because the declared
artifacts are top-level files in their producer directory.

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
attempts, zero-match commands, green-suite evidence, and genuine report
blockers without inventing or converting a lane identity.

Apply these exact derived projections in declared input order:

- `ready_lanes` is every audited `ready_lanes` row projected to its unchanged
  `lane_id`, `attempt_index`, `auditor_attempt_index`, and declaring auditor's
  run-relative artifact path as `source_auditor_artifact`.
- `lane_results_seen` is every declared lane-result artifact, including each
  nullable `no_assigned_lane` row, projected to those four coordinates plus its
  unchanged `status`.
- `missing_lane_work_orders` contains exactly the projected ready lanes for
  which no declared result has all four matching coordinates, in ready-lane
  order. Copy the four coordinates unchanged.
- `incomplete_campaign_work_orders` contains exactly the projected lane-result
  rows whose status is `compile_or_harness_defect` or `no_assigned_lane`, in
  lane-result order. Copy the four coordinates unchanged, including a null lane
  ID when supplied.
- `green_suite_evidence` contains exactly the green lane-result rows, in
  lane-result order, with their unchanged four coordinates, focused command,
  and positive matched-test count.

For each derived work order, use its schema-defined `summary` and
`evidence_paths` only for genuine evidence-backed explanation of that exact
row; do not add or omit a work order to carry notes. Put only genuine
campaign-level blockers in the schema-defined `report_blockers` channel.

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
