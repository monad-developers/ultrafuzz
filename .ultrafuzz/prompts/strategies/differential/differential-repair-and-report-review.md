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

Write {{artifact_path}}/repair-summary.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-repair-summary.v1",
  "repairs_attempted": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "repair_kind": "harness",
      "summary": "Exact harness-only change attempted"
    }
  ],
  "repaired_failures": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "result": "repaired",
      "evidence_paths": ["test/foundry/differential/Lane.t.sol"]
    }
  ],
  "preserved_production_or_unknown_reds": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "classification": "production_bug",
      "reason": "Preserved without weakening the red"
    }
  ],
  "commands": [],
  "semantic_red_registry_regenerated": false,
  "notes": []
}
```

Write {{artifact_path}}/gap-review.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-gap-review.v1",
  "ready_lanes": [
    {
      "lane_id": "stable-kebab-case",
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json"
    }
  ],
  "lane_results_seen": [
    {
      "lane_id": null,
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json",
      "status": "no_assigned_lane"
    }
  ],
  "missing_lane_work_orders": [
    {
      "lane_id": "stable-kebab-case",
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json",
      "summary": "Audited ready lane has no declared result",
      "evidence_paths": []
    }
  ],
  "incomplete_campaign_work_orders": [
    {
      "lane_id": null,
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json",
      "summary": "No lane was assigned to this attempt",
      "evidence_paths": []
    }
  ],
  "green_suite_evidence": [
    {
      "lane_id": "stable-kebab-case",
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json",
      "command": "forge test --match-path test/foundry/differential/Lane.t.sol",
      "matched_test_count": 1
    }
  ],
  "report_blockers": [
    {
      "category": "missing-lane-result",
      "summary": "A required lane result is unavailable",
      "evidence_paths": []
    }
  ]
}
```

Write {{artifact_path}}/differential-report-review.json with this JSON shape:

```json
{
  "schema_version": "ultrafuzz.differential-report-review.v1",
  "campaign_status": "complete | incomplete | blocked_by_preserved_reds",
  "production_bug_reds": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "lane_id": "stable-kebab-case",
      "summary": "Preserved production-bug red",
      "evidence_paths": ["test/foundry/differential/Lane.t.sol"]
    }
  ],
  "harness_or_reference_repairs": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "lane_id": "stable-kebab-case",
      "summary": "Consensus harness repair succeeded",
      "evidence_paths": ["test/foundry/differential/Lane.t.sol"]
    }
  ],
  "missing_or_deferred_lanes": [
    {
      "lane_id": null,
      "attempt_index": 0,
      "auditor_attempt_index": 0,
      "source_auditor_artifact": "artifacts/reference-and-lane-auditor/audited-differential-lanes.json",
      "summary": "No lane was assigned to this attempt",
      "evidence_paths": []
    }
  ],
  "report_rows_ready": [
    {
      "stable_failure_hash": "<64 lowercase hex characters>",
      "lane_id": "stable-kebab-case",
      "summary": "Preserved production-bug red",
      "evidence_paths": ["test/foundry/differential/Lane.t.sol"]
    }
  ],
  "notes": []
}
```

Also write the standard findings output to `{{output_findings_path}}`. If
`production_bug_reds` is non-empty, mirror each credible production-bug red as a
normal finding so downstream dedupe, triage, and final reporting consume it. Use
the exact stable failure hash as the finding `id`; do not invent an alias. Use
an empty JSON array only when no production-bug reds are confirmed.

Also write `{{artifact_path}}/generated-tests.json` using the standard
generated-test manifest contract. Include repaired or preserved replay tests
that should be aggregated downstream in `generated_tests`, and include each
imported non-runnable helper, mock, fixture, script, or data dependency in
`support_files`. Use both arrays empty when this node produced no generated or
repaired test files.

After every final write, run every exact `ultrafuzz json validate` command
printed in the output contract. Fix the authored JSON yourself; validation must
not repair or convert it, and do not return or exit until every command passes.
