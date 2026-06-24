# Review Findings

Ultrafuzz output is evidence for human review, not an automatic submission.

## Open The Report

```bash
ultrafuzz report <run-id>
ultrafuzz report <run-id> --json
```

Read:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

The Markdown report starts with an issue index, then a fixed preamble and run
summary. Production issue PoCs are rendered inline when available so the report
can be reviewed without chasing local artifact paths.

## Inspect Triage Artifacts

Review stage artifacts include:

```text
artifacts/dedupe-findings/deduped-findings.json
artifacts/dedupe-findings/strategy-detections.json
artifacts/triage/triaged-findings.json
artifacts/severity-classification/severity-classified-findings.json
artifacts/aggregate-test-files/aggregation.json
artifacts/final-report/report.md
artifacts/final-report/report.json
```

Use them when you need to understand how a finding moved from generated lead to
deduped candidate, triage classification, severity, generated test, and final
report entry.

## Confirm Evidence

For each finding you might act on:

1. Read the source strategy report and generated test.
2. Re-run or adapt the generated Foundry test in the target repository.
3. Check whether the issue is production-reachable, harness-only, incomplete,
   intended behavior, or a useful hardening suggestion.
4. Keep protocol-specific edits separate from the raw generated artifact so the
   review trail stays clear.

Ultrafuzz intentionally leaves the final decision to the reviewer.
