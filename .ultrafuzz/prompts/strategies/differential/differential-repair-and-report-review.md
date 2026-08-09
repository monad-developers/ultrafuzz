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

Never weaken, remove, skip, or over-bound credible production-bug red tests. Do not repair reds classified as production bug, spec mismatch, or unknown. If repair changes observed failures, regenerate the semantic-red registry shape in the repair summary and preserve the old failure packet history.

Repair a harness or reference defect only when every fresh triage attempt
independently agrees it is a harness or reference defect. If the attempts
disagree, or any attempt classifies the red as production bug, spec mismatch, or
unknown, preserve the red and report the disagreement.

Run a final gap review before reporting. Include green suites, missing lane artifacts, no-assigned-lane attempts, lanes without focused commands, focused commands that ran zero tests, and audited ready lanes without a corresponding `lane-result.json`. Emit missing-lane or incomplete-campaign work orders when artifacts are absent.

Write {{artifact_path}}/repair-summary.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-repair-summary.v1",
  "repairs_attempted": [],
  "repaired_failures": [],
  "preserved_production_or_unknown_reds": [],
  "commands": [],
  "semantic_red_registry_regenerated": false,
  "notes": []
}
```

Write {{artifact_path}}/gap-review.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-gap-review.v1",
  "ready_lanes": [],
  "lane_results_seen": [],
  "missing_lane_work_orders": [],
  "incomplete_campaign_work_orders": [],
  "green_suite_evidence": [],
  "report_blockers": []
}
```

Write {{artifact_path}}/differential-report-review.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-report-review.v1",
  "campaign_status": "complete | incomplete | blocked_by_preserved_reds",
  "production_bug_reds": [],
  "harness_or_reference_repairs": [],
  "missing_or_deferred_lanes": [],
  "report_rows_ready": [],
  "notes": []
}
```

Also write the standard findings output to `{{output_findings_path}}`. If
`production_bug_reds` is non-empty, mirror each credible production-bug red as a
normal finding so downstream dedupe, triage, and final reporting consume it. Use
an empty JSON array only when no production-bug reds are confirmed.

Also write `{{artifact_path}}/generated-tests.json` using the standard
generated-test manifest contract. Include repaired or preserved replay tests
that should be aggregated downstream, and use an empty `generated_tests` array
when this node produced no generated or repaired test files.
