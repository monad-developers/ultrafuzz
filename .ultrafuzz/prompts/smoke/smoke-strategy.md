---
id: smoke-strategy
display_name: Run one smoke bug-finding strategy
---

# Run one smoke bug-finding strategy

You are the `{{strategy}}` lane in a bounded CI security smoke test. Read the
shared source and harness map first:

{{artifact_handoff:smoke-context}}

Inspect only the target checkout and the handoff above. Never read benchmark
ground truth, expected findings, audit answers, sibling target checkouts, or
prior Ultrafuzz runs. Do not install or fetch dependencies and do not edit
production code.

Apply the focus matching `{{strategy}}`:

- `time-warp-sequences`: block/time transitions, accrual, vesting, auctions,
  deadlines, stale snapshots, and sequences whose result depends on elapsed
  time.
- `external-dependency-boundaries`: stale, reverting, zero, extreme, or
  adversarial oracle, strategy, pool, token, gauge, hook, and callback values.
- `externalized-state-accounting`: cached/stored balances, donations, fees,
  rewards, bad debt, utilization, exchange rates, and state that can diverge
  from live balances.
- `lifecycle-view-boundaries`: max/preview/view agreement before, during, and
  after lifecycle transitions, especially empty, paused, removed, nested, and
  terminal states.

Trace a small number of concrete high-signal paths. Confirm every finding with
precise source evidence and, when practical, one focused test in the target's
existing framework. A blocked native runner does not invalidate a concrete
source-backed finding, but the finding must state what was and was not
executed. Do not report generic best practices, intended behavior, or a theory
without a reachable failure mode.

Write at most the strongest few normalized findings to
`{{output_findings_path}}` using the exact pinned
`{{schema_path}}/findings.schema.json`; it alone defines the JSON version,
fields, types, enums, required members, and empty form. Bind every finding's
source node and strategy to `{{strategy}}`, retain affected source paths and
functions plus concrete evidence, and calibrate confidence to the evidence.
Use the schema-defined empty form when no finding is supportable; never
fabricate a CI canary.

Use only the authoritative report-bound note vocabulary:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}

If you create a target-native test, keep it under
`{{strategy_attempt_test_dir}}`, mirror it byte-for-byte beneath
the `generated-tests/` directory under `{{artifact_path}}`, and list that safe artifact-relative path
in `{{artifact_path}}/generated-tests.json`. Otherwise use the empty form
defined by the exact pinned generated-test schema. Read the exact pinned
`{{schema_path}}/generated-tests.schema.json` and run every exact
`ultrafuzz json validate` command rendered in the central output contract.
Correct any exit-1 artifact yourself and rerun its command after any later
edit; run only focused validation, then stop.
