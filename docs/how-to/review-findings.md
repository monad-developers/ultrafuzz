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
producer-authored `id`, `title`, canonical `status`, `severity_guess`, lowercase
`confidence`, and `summary`. Status is one of `candidate`, `needs-review`,
`duplicate`, `false-positive`, `confirmed`, `fixed`, or `wont-fix`. Evidence
uses the exact array/string-or-closed-object shape in the current schema.

Do not expect the runtime to fill a missing ID, accept an old version alias,
turn scalars into arrays, normalize confidence or severity, strip path suffixes,
or rebuild a missing file from review-stage dependencies. Producer bytes are
immutable after the agent returns; malformed output is a terminal attempt
failure.

Review-stage artifacts may include:

```text
artifacts/dedupe-findings/deduped-findings.json
artifacts/dedupe-findings/strategy-detections.json
artifacts/triage/triaged-findings.json
artifacts/severity-classification/severity-classified-findings.json
artifacts/aggregate-test-files/aggregation.json
artifacts/final-report/report.md
artifacts/final-report/report.json
```

Use them to understand how raw strategy output became deduplicated candidates,
triage classifications, severity guesses, generated-test selections, and final
report entries.

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
