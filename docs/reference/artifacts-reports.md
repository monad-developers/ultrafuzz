# Run Artifacts and Reports

Runs are stored under:

```text
.ultrafuzz/runs/<run-id>/
```

## Run Root

Each run records:

```text
run.json
config.resolved.toml
graph.json
graph.fingerprint
state.json
events.jsonl
events.sqlite
artifacts/
```

## Node Artifacts

Node artifacts live under:

```text
artifacts/<node-id>/
```

Common files include:

```text
prompt.rendered.md
stdout.log
stderr.log
transcript.json
findings.json
metadata.json
generated-tests/
generated-tests.json
workspace-changes.json
artifact-manifest.json
```

Required artifacts are node-specific and declared by topology.

## Review Artifacts

Important default review artifacts:

```text
artifacts/dedupe-findings/deduped-findings.json
artifacts/dedupe-findings/strategy-detections.json
artifacts/triage/triaged-findings.json
artifacts/severity-classification/severity-classified-findings.json
artifacts/severity-classification/strategy-detections.json
artifacts/aggregate-test-files/aggregation.json
artifacts/final-report/report.md
artifacts/final-report/report.json
```

## Final Report

```bash
ultrafuzz report <run-id>
ultrafuzz report <run-id> --json
```

The Markdown report includes:

- Issue index first.
- Fixed preamble.
- `## Run summary`.
- Run ID and source run ID when present.
- Continuation mode and reused node list.
- Elapsed time rounded to whole minutes.
- Models used, including reasoning effort when available.
- Token usage and estimated spend.
- Configured strategy loops.
- Inline production issue PoCs when available.

The report is a review artifact, not an automatic vulnerability submission.
