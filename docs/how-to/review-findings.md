# Review Findings

Ultrafuzz findings are evidence for human review, not automatic vulnerability
submissions.

## Open The Agentic Report

```bash
ultrafuzz report <run-id> --project /path/to/target-protocol
ultrafuzz report <run-id> --project /path/to/target-protocol --json
```

The command reads agent-written final-report artifacts, typically:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

## Inspect Findings Arrays

Per-node findings are strict `ultrafuzz/findings@2` arrays in `findings.json`
files:

```text
.ultrafuzz/runs/<run-id>/artifacts/<node-id>/findings.json
```

Each finding requires `schema_version: "ultrafuzz.finding.v2"`, a
producer-authored `id`, `title`, canonical `status`, and `summary`.
`severity_guess` and lowercase `confidence` are optional preliminary metadata.
Status is one of `candidate`, `needs-review`,
`duplicate`, `false-positive`, `confirmed`, `fixed`, or `wont-fix`. Evidence
uses the exact array/string-or-closed-object shape in the current schema. Keep
selectors out of `path`: put a section anchor in `fragment`, use positive
integer `line` and optional `end_line` for one span, or a typed `line_ranges`
array with at least two entries for disjoint spans. Every `end_line` must be no
smaller than its `line`, and `line_ranges` cannot coexist with `line` or
`end_line`. Keep independent explanatory prose in `detail`:

```json
{
  "kind": "source",
  "path": "src/Vault.sol",
  "line_ranges": [
    { "line": 105, "end_line": 107 },
    { "line": 154, "end_line": 185 }
  ],
  "detail": "The two ranges jointly establish the accounting boundary."
}
```

Do not expect the runtime to fill a missing ID, accept an old version alias,
turn scalars into arrays, normalize confidence or severity, strip path suffixes,
or rebuild a missing file from review-stage dependencies. Producer bytes are
immutable after the agent returns; malformed output is a terminal attempt
failure.

Review-stage artifacts may include:

```text
artifacts/dedupe-findings/deduped-findings.json
artifacts/dedupe-findings/strategy-detections.json
artifacts/dedupe-findings/finding-lifecycle-ledger.json
artifacts/triage/triaged-findings.json
artifacts/triage/finding-lifecycle-ledger.json
artifacts/severity-classification/severity-classified-findings.json
artifacts/severity-classification/finding-lifecycle-ledger.json
artifacts/aggregate-test-files/aggregation.json
artifacts/final-report/report.md
artifacts/final-report/report.json
```

Use them to understand how raw strategy output became deduplicated candidates,
triage classifications, severity guesses, generated-test selections, and final
report entries.

`finding-lifecycle-ledger.json` is the provenance record binding each retained
finding to the exact upstream findings it merged. Each of the three review
stages emits its own. It is a required output:
dedupe fails with `dedupe provenance requires finding-lifecycle-ledger.json` if
it is missing, and with `finding lifecycle ledger omitted dependency findings`
if any upstream finding is unaccounted for. Every finding a run produced appears
in it exactly once, so it is the artifact to read when a finding's recorded
`source_nodes` looks wrong.

## Confirm Evidence

For each finding you might act on:

1. Read the source node artifacts and generated tests.
2. Re-run or adapt the test in the target repository.
3. Decide whether the issue is production-reachable, harness-only,
   underspecified, intended behavior, or a useful hardening suggestion.
4. Keep protocol-specific edits separate from the raw generated artifact so the
   review trail stays clear.

Only materialize files after review, and treat copied files as ordinary
unstaged working-tree changes.
