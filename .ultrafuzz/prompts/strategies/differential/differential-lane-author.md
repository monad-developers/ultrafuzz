---
id: differential-lane-author
display_name: Differential Lane Author
---

# Differential Lane Author

You are one fresh-context lane author attempt. Your attempt index is `{{attempt_index}}`.

Read the audited lanes and select exactly one `ready_lanes` entry whose
`attempt_index` and `auditor_attempt_index` both equal `{{attempt_index}}`:

{{artifact_handoff:reference-and-lane-auditor}}

If more than one audited lane entry matches this attempt after reading all
auditor artifacts, write
`{{artifact_path}}/lane-result.json` with status `no_assigned_lane`, include the
ambiguous source artifact paths in `notes`, write `{{output_findings_path}}` as
an empty JSON array, and stop.

Read the base Foundry setup before lane analysis:

{{artifact_path:base-test-setup}}/setup/base-test-setup.md

If no lane payload exists for this attempt index, write
`{{artifact_path}}/lane-result.json` with status `no_assigned_lane`, write
`{{output_findings_path}}` as an empty JSON array, and stop.

For the selected lane, compare the production behavior and reference
expectation using public evidence:

- return values;
- balances;
- public views;
- public metadata;
- externally visible state;
- public revert behavior when the public source defines it.

Stay inside the current workspace and the explicit artifact paths above when
locating evidence.

Write {{artifact_path}}/lane-result.json with this JSON shape:

```json
{
  "schema_version": "1.0",
  "lane_id": "stable-kebab-case",
  "attempt_index": {{attempt_index}},
  "auditor_attempt_index": {{attempt_index}},
  "source_auditor_artifact": "",
  "source_plan_artifact": "",
  "source_harness_artifact": "",
  "assigned_lane_payload": {},
  "status": "no_mismatch_observed | semantic_mismatch | no_assigned_lane",
  "red_preservation_audit": {
    "result": "no_semantic_mismatch_observed | semantic_mismatch | not_applicable",
    "assertion_predicate": ""
  },
  "red_candidates": [
    {
      "red_candidate_id": "diff-<lane-id>-001",
      "failure_signature": "",
      "assertion": "",
      "observed": "",
      "expected": "",
      "public_oracle_basis": [],
      "classification": "untriaged"
    }
  ],
  "public_evidence_paths": [],
  "notes": []
}
```

Write `{{output_findings_path}}` as an empty JSON array unless this lane
produced a confirmed production-bug mismatch that should already be consumable
by downstream dedupe.
