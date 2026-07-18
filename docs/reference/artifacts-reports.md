# Run Artifacts and Reports

Runs are stored under the resolved `run.output_dir`, which defaults to:

```text
.ultrafuzz/runs/<run-id>/
```

Run IDs and node IDs are path-safe identifiers. Run evidence is intended to be
durable and reviewable.

## Run Root

Each run records:

```text
run.json
source-run.json
config.resolved.toml
config.redactions.json
graph.json
graph.fingerprint
state.json
events.jsonl
plan.json
artifacts/
review/
events.index/
workspaces/
workspaces.json
```

`source-run.json` is present when the run derives from another run. Event query
indexes are JSONL files derived from `events.jsonl`; SQLite events are not part
of the artifact contract.

## Run Metadata

`run.json` records the run schema version, run ID, creation timestamp, mode,
linked workflow IDs, and workflow evidence pointers. Lifecycle commands such as
`resume`, `replay`, and `fork` use this linked workflow evidence.

`config.resolved.toml` stores the resolved config for the run. Secret-looking
values are redacted before persistence, and restore metadata is written to
`config.redactions.json`.

`graph.json` records the planned executable graph, including logical IDs,
concrete IDs, group, prompt path, dependencies, artifact directory, required
artifacts, primary artifact, loop metadata, reference revisions, and model
fan-out provenance.

`plan.json` records the run plan, graph/config fingerprints, topology summary,
rendered prompt paths, and validation posture.

## State

`state.json` has schema version `1.0`.

Run statuses are:

- `pending`
- `running`
- `paused`
- `succeeded`
- `failed`
- `timed-out`
- `canceled`

Node statuses are:

- `pending`
- `ready`
- `runnable`
- `running`
- `succeeded`
- `failed`
- `skipped`
- `timed-out`
- `reused-from-prior-run`
- `invalidated`

Node state can also record logical node ID, artifact directory, required
artifacts, attempt index, loop index, model profile ID, model name, model
index, timestamps, last error, and provenance.

## Node Artifacts

Node and attempt artifacts live under:

```text
artifacts/<attempt-id>/
```

Common files include:

```text
prompt.rendered.md
artifact-manifest.json
findings.json
patch.diff
generated-tests/
generated-tests.json
references/manifest.json
```

Required artifacts are node-specific and declared in `.ultrafuzz/topology.yml`.
Artifact paths are relative to the node artifact directory and must be safe
project-local relative paths.

`artifact-manifest.json` records schema version, run ID, node ID, creation
time, artifact paths, sizes, SHA-256 digests, and provenance such as logical
node, attempt index, loop index, model profile, model name, workflow task, and
source run when available.

## Findings

`findings.json` must be a JSON array.

Each normalized finding must include:

| Field            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `schema_version` | Must be `1.0`.                                                |
| `id`             | Finding ID. Missing IDs are synthesized from node provenance. |
| `title`          | Non-empty title.                                              |
| `status`         | Non-empty lifecycle string.                                   |
| `severity_guess` | Non-empty severity guess.                                     |
| `confidence`     | Non-empty confidence label.                                   |
| `summary`        | Non-empty summary.                                            |

Canonical finding `status` values include:

- `candidate`
- `needs-review`
- `duplicate`
- `false-positive`
- `confirmed`
- `fixed`
- `wont-fix`

Agent-produced lifecycle statuses are also preserved when they are non-empty
strings.

When present, `triage_classification` must be one of:

- `true-positive`
- `false-positive`
- `undetermined`
- `incomplete-spec`
- `harness-defect`
- `repair-candidate`
- `spec-gated`
- `defensive-hardening`

Findings may also preserve source node, strategy, attempt index, model profile,
model name, model index, loop index, affected files, affected functions,
evidence, patch references, notes, dedupe metadata, and family metadata.
`evidence` entries may be non-empty string references or objects. Object
entries may include `kind`, `path`, and additional metadata; `kind` and `path`
must be non-empty strings when present. Relative `path` values must stay inside
safe artifact-relative paths.

## Final Report

Final reporting is agentic. The report command reads agent-written final report
artifacts from:

```text
artifacts/final-report/report.md
artifacts/final-report/report.json
```

If final report artifacts are missing, `ultrafuzz report <run-id>` fails.

When workflow usage data is available, run metadata includes
`accounting.cumulative.tokens_used` and
`accounting.cumulative.estimated_spend`. Final reports should copy the
available cumulative values into the markdown run summary and into
`report.json.run_metadata`. A trailing `+` on `estimated_spend` means the
persisted estimate is partial because some token usage did not have pricing
data.

Accounting schema `2.0` keeps uncached input, cache reads, cache writes,
output, and reasoning as independent components. `inclusive_token_total`
counts every reported component, while `billable_token_total` counts the
components with a positive known rate. Per-component amounts are recorded in
`component_costs_usd` and sum to `estimated_spend_usd` for catalog-priced
events. `usage_complete` and `pricing_complete` are independent: their typed
`*_incomplete_reasons` arrays distinguish missing or estimated usage from a
missing component rate. `partial_pricing` remains the backward-compatible
inverse of pricing completeness.

The final report is a review artifact. It is not an automatic vulnerability
submission, repository mutation, or patch application.

## Materialization

Materialization copies reviewed run outputs into the target project:

```bash
ultrafuzz materialize <run-id> \
  --copy artifacts/final-report/report.md:audit/ultrafuzz-report.md \
  --confirm
```

Materialization requires explicit selections and confirmation unless
`--dry-run` is used. Destinations are project-relative, must be path-safe, must
not target `.git/`, `.ultrafuzz/`, or sensitive paths, and are left as unstaged
working-tree changes.

Patch artifacts may be produced as evidence, but patch application is rejected
until a safe patch applier is implemented.

Materialization writes an audit record to:

```text
.ultrafuzz/materialize-audit.jsonl
```

## Cleanup

`ultrafuzz clean <run-id>` removes selected generated paths relative to
`.ultrafuzz/`. Without `--select`, it selects `runs/<run-id>`.

Cleanup requires confirmation unless `--dry-run` is used. It rejects unsafe
paths, symlink escapes, missing selections, non-directory selections, git paths,
and paths outside generated run, artifact, or workspace roots.

Cleanup writes an audit record to:

```text
.ultrafuzz/clean-audit.jsonl
```

## Eval Run Artifacts

Eval suite runs write local artifacts under:

```text
.ultrafuzz/evals/runs/<eval-run-id>/
```

Each eval run records:

```text
eval.json
matrix.json
runs.jsonl
scores.jsonl
summary.json
summary.md
telemetry/
```

`eval.json` records the resolved suite, `matrix.json` records the planned
target × variant × trial rows, and `runs.jsonl` appends one record per
launched row. `ultrafuzz eval score` writes per-row scores to `scores.jsonl`
and the variant ranking to `summary.json` plus a human-readable `summary.md`
read by `ultrafuzz eval report`.

`telemetry/` holds durable per-row telemetry cursors (byte offset, event dedup
state, uploaded-artifact hashes) for live streaming, plus per-provider publish
cursors under `telemetry/publish/<provider>/`, so a crashed driver or
`ultrafuzz eval publish --resume` can continue delivery without
double-publishing. The underlying Ultrafuzz runs
live inside each target checkout, not under the eval project; eval artifacts
reference them by run ID. Grading and these artifacts never depend on a
reporting provider. See [Eval Suites](evals.md).
