---
id: differential-red-triage
display_name: Differential Red Triage
---

# Differential Red Triage

You are one fresh read-only triage attempt. The topology runs this logical node
as `{{strategy_loop_count}}` independent fresh attempts. Your attempt index is
`{{attempt_index}}`. Do not repair anything.

Rebuild the registry and classifications from lane artifacts yourself. Do not
read sibling `differential-red-triage` attempt artifacts, do not inherit another
triage attempt's conclusions, and do not treat one attempt as consensus.

Build the semantic red registry from current lane validation output:

{{artifact_handoff:differential-lane-author}}

For every semantic red, record the test, command, assertion, observed value, expected value, public oracle basis, and a stable failure hash. Treat compile errors and authored-test failures as harness defects for routing, not production bugs.

Within this fresh attempt, classify each semantic red twice:

- `triage-a` should reason from the public evidence and failure packet only.
- `triage-b` should repeat the classification from a fresh minimal summary, without inheriting `triage-a` conclusions.

Allowed classifications are:

- `harness_bug`
- `reference_bug`
- `production_bug`
- `spec_mismatch`
- `unknown`
- `compile_harness_defect`

Write {{artifact_path}}/semantic-red-registry.json with this JSON shape:

```json
{
  "schema_version": "1.0",
  "semantic_reds": [
    {
      "stable_failure_hash": "",
      "lane_id": "",
      "test_path": "",
      "failing_test_name": "",
      "focused_command": "",
      "assertion": "",
      "observed": "",
      "expected": "",
      "public_oracle_basis": [],
      "pre_repair_file_hash": ""
    }
  ],
  "compile_or_harness_defects": []
}
```

Write {{artifact_path}}/triage-a.json and {{artifact_path}}/triage-b.json with this JSON shape:

```json
{
  "schema_version": "1.0",
  "pass": "a",
  "classifications": [
    {
      "stable_failure_hash": "",
      "classification": "harness_bug | reference_bug | production_bug | spec_mismatch | unknown | compile_harness_defect",
      "rationale": "",
      "public_evidence_paths": [],
      "repair_allowed": false
    }
  ]
}
```

If both passes in this attempt agree that a failure is a harness or reference
defect, mark it repairable for this attempt only. Downstream repair must require
agreement across every fresh `differential-red-triage` attempt before treating
a failure as an owned harness/reference defect. Production bugs, spec
mismatches, and unknowns must remain preserved and unweakened.
