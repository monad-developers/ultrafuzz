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

Flatten every lane result in declared handoff order: first all semantic reds in
their lane-row order, then all compile/harness defects in their lane-row order.
Copy each failure packet and its `stable_failure_hash` exactly. Do not omit,
invent, reorder, summarize, recompute, normalize, or convert an upstream value.
Treat compile errors and authored-test failures as harness defects for routing,
not production bugs.

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

Write {{artifact_path}}/semantic-red-registry.json. Read the exact pinned
schema at `{{schema_path}}/semantic-red-registry.schema.json`; it alone defines
the JSON version, fields, types, enums, required members, and empty forms. Copy
the lane's semantic-red and compile/harness packets without changing any JSON
value. Keep semantic reds before compile/harness defects and preserve the order
within each group. These are source-preservation semantics beyond JSON Schema.

Each pass must contain every registry hash exactly once and in exact registry
order (semantic reds followed by defects). `triage-a.json` must carry
`"pass": "a"`; `triage-b.json` must carry `"pass": "b"`. A semantic red may
not be relabeled `compile_harness_defect`; every compile/harness defect must use
that classification. Set `repair_allowed: true` only for `harness_bug` or
`reference_bug`.

Write {{artifact_path}}/triage-a.json.
Write {{artifact_path}}/triage-b.json. Read the exact pinned schema at
`{{schema_path}}/differential-red-triage.schema.json`; it alone defines the
JSON version, fields, types, enums, required members, and empty forms. Pass A
must identify itself as `a` and pass B as `b`; each must classify every exact
registry hash once in registry order and retain the public evidence used for
its rationale.

If both passes in this attempt agree that a failure is a harness or reference
defect, mark it repairable for this attempt only. Downstream repair must require
agreement across every fresh `differential-red-triage` attempt before treating
a failure as an owned harness/reference defect. Production bugs, spec
mismatches, and unknowns must remain preserved and unweakened.

After all three final writes, run every exact `ultrafuzz json validate` command
rendered for them in the central output contract. Fix the authored JSON
yourself; do not use fallback spellings, conversion, or repair, and do not
return or exit until all commands pass.
