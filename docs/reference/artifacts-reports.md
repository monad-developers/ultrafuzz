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
usage.jsonl
attempts.jsonl
plan.json
prompt-snapshots/
trusted-cli.json
trusted-bin/
artifacts/
review/
events.index/
workspaces/
workspaces.json
```

`source-run.json` is present when the run derives from another run. Event query
indexes are JSONL files derived from `events.jsonl`; SQLite events are not part
of the artifact contract.

`usage.jsonl` is an append-only ledger of normalized workflow usage events.
Each entry has stable event, attempt, and checkpoint-generation identifiers.
Replaying the same continuation is idempotent, while events from later
checkpoint generations remain distinct. The ledger stores normalized counters
and typed usage-completeness reasons, not raw execution records.

## Run Metadata

`run.json` records the run schema version, run ID, creation timestamp, mode,
linked workflow IDs, and workflow evidence pointers. Lifecycle commands such as
`resume`, `replay`, and `fork` use this linked workflow evidence.

`config.resolved.toml` stores the resolved config for the run. Secret-looking
values are redacted before persistence, and restore metadata is written to
`config.redactions.json`.

`graph.json` records the planned executable graph, including logical IDs,
concrete IDs, group, prompt path, dependencies, artifact directory, contracted
outputs, primary output marker, loop metadata, reference revisions, and model
fan-out provenance. Every JSON output also records its schema filename,
fragment-free schema ID, schema SHA-256, schema-bundle SHA-256, and validator
build identity. Partial bindings are invalid.

`plan.json` records the run plan, graph/config fingerprints, topology summary,
rendered prompt paths and digests, immutable prompt snapshot paths, and
validation posture. Exact rendered prompt snapshots live under
`prompt-snapshots/`; lifecycle recovery uses those snapshots to restore missing
task input without consulting mutable prompt sources or current configuration.
That recovery concerns runtime-owned control input only; it never reconstructs
an agent-owned output.

`trusted-cli.json` binds the run-owned launcher in `trusted-bin/` to the exact
CLI entrypoint bytes, validator build, and artifact schema-bundle digest. The
launcher precedes target-controlled directories on the producer's `PATH`.
Before model work, Ultrafuzz uses it to validate a real known-valid fixture and
checks the returned schema ID, schema digest, bundle digest, and build identity.
A missing, changed, or stale launcher is a setup failure; it is not recreated
silently when an existing run resumes. Modal images provide the equivalent
root-owned, read-only `/usr/local/bin/ultrafuzz` entrypoint and preflight.

## State

`state.json` has schema version `ultrafuzz.run-state.v4` and schema ID
`urn:ultrafuzz:schema:artifacts:run-state:4`. Older run-state versions are
unsupported by the current runtime and fail explicitly rather than entering a
compatibility reader.

The v4 provenance contract is closed. Run-level provenance records the full
sealed workflow binding. Each node provenance object is exactly one of an
execution record, a pinned-reference record, or a dependency-block record.
Execution records use `output_contracts` and complete Smithers agent/verifier
identities; the former `required_artifacts` spelling and partial/generic
provenance objects are invalid.

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

Every nonterminal node records `wait_since`, a typed `wait_reason`, and a typed
`next_eligible_action`. Wait reasons distinguish ready work, capacity and
dependency waits, retry backoff, external gates, controller loss, and active
execution.

Run state records the absolute `workflow_deadline_at`, `last_transition_at`, a
renewable `controller_lease` with its configured `duration_ms`, and a concurrency snapshot. Concurrency evidence
includes requested and peak effective concurrency, ready-queue depth, active
work, and cumulative queued, active, and idle durations. These fields contain
lifecycle metadata only; raw runner logs and host identifiers are not copied
into product artifacts.

Node state can also record logical node ID, artifact directory, contracted
outputs, attempt index, loop index, model profile ID, model name, model index,
timestamps, last error, and provenance.

## Attempt Ledger

`attempts.jsonl` is the append-only source of truth for completed node attempts.
Each immutable entry gives the executor retry a stable ID and links it to its
strategy attempt, checkpoint generation, workflow execution, controller
invocation, and previous retry. Entries record lifecycle timestamps, a typed
outcome, executed-versus-reused status, and SHA-256 digests for input and output
manifests.

Attempt summaries and retry counts are derived from this ledger. Replaying a
known transition does not append it again, so resume, replay, checkpoint
continuation, and controller takeover preserve prior lifecycle history. Reused
work points to its source attempt and is reported separately from executed work.
The ledger stores typed failure categories but never raw diagnostics, inputs,
outputs, or configuration.

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

The default `stateful-invariant-campaign` runs one final recon-fuzzer backend
and writes backend-neutral `campaign-plan.json`, `campaign-summary.json`, and
`campaign-report.md` artifacts plus `recon-fuzzer-results.json`. The plan
records the resolved vCPU count, worker count, wall-clock budget, deadline, and
finalization reserve. The backend record keeps its command, version, timestamps,
terminal status, distinct artifact paths, failures, reproducers, and available
coverage metadata. The summary classifies the result as `complete`, `partial`,
or `blocked` without discarding usable evidence.

Required outputs are node-specific and declared with versioned contracts in
`.ultrafuzz/topology.yml`. Output paths are relative to the node artifact
directory and must be safe project-local relative paths. Each agent-authored
JSON output has one current named contract and complete whole-document schema;
generic JSON object/array contracts and historical contract aliases are not
available.

`artifact-manifest.json` is runtime-owned and uses the exact schema version
`ultrafuzz.artifact-manifest.v3`. It records run and producer identity, creation
time, artifact paths, sizes, SHA-256 digests, output contract IDs and digests,
and provenance such as logical node, attempt index, loop index, model profile,
model name, workflow task, and source run when available. Every JSON output
entry carries the complete `schema_file`, `schema_id`, `schema_sha256`,
`schema_bundle_sha256`, and `validator_build` binding; non-JSON entries omit
those fields. Optional provenance metadata is a closed union: either the exact
pinned-reference materialization record (including its optional revision and
operator-supplied expectation source) or the exact Smithers task concrete-node
identity. Generic or mixed metadata objects are invalid. The manifest also
records the exact prerequisite manifest digests consumed by the attempt so
reuse can reject causally stale descendants. The host strictly validates this
v3 manifest before writing, reading, reuse, or publication. It rejects every
earlier manifest version without upgrading or converting it.

The producer's rendered prompt includes one safely quoted `ultrafuzz json
validate --schema ... --file ...` command per JSON output. The producer runs it
after the final write and corrects an exit-`1` draft before returning. Once the
agent session returns, declared artifact bytes are immutable. Host validation,
semantic gates, synchronization, reporting, dashboards, and bundles may reject
the bytes or copy them exactly, but may not normalize, convert, repair,
synthesize, reseal, or substitute another file or final-response payload. A
missing or invalid required output is a terminal post-agent failure, not a
model retry or compatibility fallback.

## Findings

`findings.json` must be a JSON array. The array itself has no envelope version;
the `ultrafuzz/findings@2` contract, schema ID, bound digests, and required
version on each finding identify the document.

Each finding must include:

| Field            | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `schema_version` | Exact literal `ultrafuzz.finding.v2`.            |
| `id`             | Required non-empty producer-authored finding ID. |
| `title`          | Required non-empty title.                        |
| `status`         | One current canonical lifecycle value.           |
| `severity_guess` | Preliminary `High`, `Medium`, or `Low` estimate. |
| `confidence`     | Lowercase `high`, `medium`, or `low`.            |
| `summary`        | Required non-empty summary.                      |

Canonical finding `status` values include:

- `candidate`
- `needs-review`
- `duplicate`
- `false-positive`
- `confirmed`
- `fixed`
- `wont-fix`

Other status strings and old schema-version spellings are invalid. IDs,
provenance, lists, confidence, severity, and evidence are never synthesized or
normalized after production. Unknown fields are rejected at closed object
boundaries.

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
safe artifact-relative paths and must not embed anchors or line selectors. Use
positive integer `line` and optional `end_line` for one source span. Use
`line_ranges` for disjoint spans; it contains at least two objects with a
required positive integer `line` and an optional non-descending `end_line`.
Never use a one-entry `line_ranges`, or combine `line_ranges` with scalar
`line` or `end_line` fields.
Explanatory `detail` remains independent and is not replaced by structural
selectors.

## Property Provenance

The property specification fan-in writes both `properties.md` and a validated
`properties.json` catalog. The structured catalog uses schema version
`ultrafuzz.properties.v2`:

```json
{
  "schema_version": "ultrafuzz.properties.v2",
  "properties": [
    {
      "id": "property-1",
      "description": "Accounted value remains conserved",
      "category": "accounting",
      "priority": "high",
      "reference_expectations": ["scfuzzbench:aave-v4:hub-total-borrowed"],
      "sources": [
        {
          "source_node_id": "property-specification-certora",
          "source_property_id": "certora-1"
        },
        {
          "source_node_id": "property-specification-crytic",
          "source_property_id": "crytic-3"
        }
      ]
    }
  ]
}
```

`source_node_id` is the source lens's logical topology node ID, while
`source_property_id` is the prefixed ID from that lens's table. Deduplication
keeps one canonical property and all distinct contributing source pairs.
`reference_expectations` preserves stable IDs for named benchmark or other
external expectations represented by the property. Fan-in must carry every
such ID from the source lens JSON into the canonical JSON and Markdown.
Canonical IDs are stable through one run; cross-run matching is not part of the
v2 contract.

`implemented-properties.json` uses schema version
`ultrafuzz.implemented-properties.v3` and the
`ultrafuzz/implemented-properties@3` contract. Every record has a canonical
`property_id`, a status (`implemented`, `pending`, `deferred`, or `blocked`),
and `implementation_paths` and `test_paths` arrays. The invariant campaign's
`recon-fuzzer-results.json` uses `ultrafuzz.property-campaign.v2`; failure
records caused by implemented catalog properties carry `property_ids`.
Property-derived `findings.json` entries carry the same optional
`property_ids` and use the raw failure's ID. Setup or harness findings that do
not originate from a catalog property omit the field.

Current invariant implementation runs also emit a `selection` object with the
configured `priority_threshold`, its inclusive `priorities`, and the complete
ordered `property_ids` selected from the canonical catalog. Every selected
property has one implementation record. A selected property that is not
implemented carries a typed `blocker` object with `code`, `summary`, and
`next_action`; this preserves an actionable reason instead of silently
deferring benchmark-relevant coverage. `selection` is required in the current
contract; artifacts that omit it are rejected.

The final report mirrors this handoff in
`property_implementation_coverage`, preserving the threshold, inclusive
priorities, selected IDs, ordered implemented/blocked/pending/deferred ID
arrays, and the reference expectation property/ID arrays for analysis. A
current report must include this object in `report.json` and render
`## Property implementation coverage` in `report.md`; runtime checks compare
both representations with the implementation handoff. Missing current
selection metadata is a contract failure, not an `"unavailable"` compatibility
case.

Runtime artifact gates reject unknown canonical IDs and campaign references to
properties that were not recorded with `implemented` status. They validate each
campaign result record independently, judge unexplained findings against the
union of every campaign record in the node, reject raw campaign/finding
reference mismatches and dangling final-report IDs, and require final joins to
match the validated sources, implementation/test paths, and complete set of
originating fuzzer backends. Final `report.json` stores the joined chain in
`property_provenance`, using `fuzzer_backend` for one backend or
`fuzzer_backends` for several, and `report.md` renders it under **Property
provenance**. Missing or inconsistent current provenance fails the report gate;
the host does not synthesize it from older handoffs.

## Final Report

Final reporting is agentic. The report command reads agent-written final report
artifacts from:

```text
artifacts/final-report/report.md
artifacts/final-report/report.json
```

If final report artifacts are missing, `ultrafuzz report <run-id>` fails.
`report.json` must satisfy `ultrafuzz/report@2` with the exact
`ultrafuzz.report.v2` version literal. Reporting reads the agent-authored bytes;
it does not reconstruct, reorder, normalize, or rewrite them.

When workflow usage data is available, run metadata includes
`accounting.cumulative.tokens_used` and
`accounting.cumulative.estimated_spend`. Final reports should copy the
available cumulative values into the markdown run summary and into
`report.json.run_metadata`. A trailing `+` on `estimated_spend` means the
persisted estimate is partial because some token usage did not have pricing
data.

`accounting.segments` publishes one rollup per checkpoint generation, and
`accounting.current` identifies the latest segment. `accounting.cumulative`
is derived from every unique ledger entry, including prior generations and any
source-run lineage. `accounting.checkpoint` records the ledger position used by
the durable metadata snapshot. Usage and pricing completeness are reported
independently through `usage_complete`/`usage_incomplete_reasons` and
`pricing_complete`/`pricing_incomplete_reasons`.

Accounting schema `2.0` keeps uncached input, cache reads, cache writes,
output, and reasoning as independent components. `inclusive_token_total`
counts every reported component, while `billable_token_total` counts the
components with a positive known rate. Per-component amounts are recorded in
`component_costs_usd` and sum to `estimated_spend_usd` for catalog-priced
events. `usage_complete` and `pricing_complete` are independent: their typed
`*_incomplete_reasons` arrays distinguish missing or estimated usage from a
missing component rate. Usage completeness is derived from reported component
evidence regardless of whether catalog pricing is available. `partial_pricing`
is the inverse of pricing completeness. An event's
reported total is tracked separately in `provided_cost_usd`; it does not fill
missing component rates or make component pricing complete. Kimi-family models
are priced from the pinned Moonshot provider entry, while DeepSeek-family
models are priced from the pinned first-party DeepSeek entry. Either family
stays listed in `pricing_catalog.unresolved_models` when its first-party entry
is absent rather than borrowing a same-named rate from another provider.

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

`eval.json` records the resolved suite plus candidate and benchmark lineage,
`matrix.json` records the planned
target × variant × trial rows, and `runs.jsonl` appends launcher and observed
workflow lifecycle snapshots for each row. Launcher completion is recorded
separately from durable workflow completion; a detached row remains
nonterminal until its referenced run's `state.json` reaches a terminal state.
`ultrafuzz eval status <eval-run-id>` joins these artifacts read-only to show
every matrix row's durable node completion and ETA. Its table and versioned
JSON use only opaque row labels and disclosure-safe lifecycle, count, and
timing fields.

`ultrafuzz eval score` joins the latest record with the referenced run's
durable `state.json` and cumulative `run.json` accounting. Each row in
`summary.json` contains the authoritative launcher/workflow lifecycle and a
typed `efficiency` block with wall, active, and wait seconds, total tokens,
cost in USD, and independent runtime/usage/cost completeness. Unavailable
values are `null` with a stable reason; partial pricing is labeled separately
from complete cost. Usage and cost remain unavailable until the durable workflow
is terminal. Active time is the union of node execution intervals, so parallel
nodes are not double-counted; wait time is wall time minus that union. Runs with
retries remain typed as unavailable when the durable state does not retain every
attempt interval. Row timing and cost exist only in the structured `efficiency`
block; the historical `runtime_seconds` and `cost_estimate` aliases are rejected.
Those canonical fields are rendered into `summary.md`, which is read by
`ultrafuzz eval report`.
The row records include graph/config and execution artifact identities when
available. `ultrafuzz eval score` writes per-row scores to `scores.jsonl` and
the variant ranking plus scoring lineage to `summary.json`, including the
effective deterministic or optional-judge mode.

`telemetry/` holds durable per-row telemetry cursors (byte offset, event dedup
state, uploaded-artifact hashes) for live streaming, plus per-provider publish
cursors under `telemetry/publish/<provider>/`, so a crashed driver or
`ultrafuzz eval publish --resume` can continue delivery without
double-publishing. The underlying Ultrafuzz runs
live inside each target checkout, not under the eval project; eval artifacts
reference them by run ID. Grading and these artifacts never depend on a
reporting provider. See [Eval Suites](evals.md).

## Analysis Bundles

`ultrafuzz eval bundle <eval-run-id> --output <directory>` writes an offline,
privacy-safe analysis bundle with this fixed layout:

```text
analysis-bundle.json
omissions.json
data/
  terminal-status.json
  evaluation-metrics.json
  accounting-summary.json
  attempt-history.json
```

Unavailable data files are absent and have a typed entry in
`omissions.json`. The versioned bundle manifest lists only bundle-relative
paths with byte sizes and SHA-256 checksums. The data files contain aggregate
or sanitized derived fields only; source reports, findings, diagnostics,
configuration, raw execution output, and execution-local identifiers are
never copied. Bundle validation checks the schemas, strict file allowlist,
referential integrity, checksums, and privacy policy before publication.
