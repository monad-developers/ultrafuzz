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

Per-node findings are normalized arrays in `findings.json` files:

```text
.ultrafuzz/runs/<run-id>/artifacts/<node-id>/findings.json
```

Each finding should include fields such as `schema_version`, `id`, `title`,
`status`, `severity_guess`, `confidence`, and `summary`. Status values include
`candidate`, `needs-review`, `duplicate`, `false-positive`, `confirmed`,
`fixed`, and `wont-fix`; agent-produced lifecycle statuses may also appear.
Evidence may be recorded as non-empty string references or as metadata objects
with optional `kind` and `path` fields.

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
