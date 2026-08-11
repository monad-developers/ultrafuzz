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
dynamic-expansions/
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
fan-out provenance.

For a dynamic topology, `graph.json` and the runtime task projection are
atomically republished as groups expand. Generated graph entries retain the
human `id`, their template group, source node/attempt and digest, expansion key
and item digest, path-safe `storage_id`, and expansion-manifest path.

`dynamic-expansions/<group-id>.json` is the immutable expansion decision. It
records canonical ordered items, generated IDs, source and template digests,
and the run-wide limit. Recovery validates and reuses it; incompatible or
tampered manifests fail rather than causing replanning or duplicate attempts.

`plan.json` records the run plan, graph/config fingerprints, topology summary,
rendered prompt paths and digests, immutable prompt snapshot paths, and
validation posture. Exact rendered prompt snapshots live under
`prompt-snapshots/`; lifecycle recovery uses those snapshots to restore missing
task input without consulting mutable prompt sources or current configuration.

## State

`state.json` has schema version `1.1`.

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

For generated nodes, `producer_node_id` is the human runtime node ID while
`storage_id` is the safe state/artifact identity. Reports and findings should
display the producer ID; storage IDs are retained for exact operational lookup.

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

Threat-model-driven runs add these durable artifacts:

```text
artifacts/threat-model/THREAT_MODEL.md
artifacts/threat-model/threat-model.json
artifacts/goal-plan/goal-plan.json
artifacts/goal-plan/vulnerability-db-manifest.json
artifacts/goal-plan/vulnerability-db/selected/**/*.md
vulnerability-db/catalog.json
```

`threat-model.json` is canonical; Ultrafuzz renders `THREAT_MODEL.md`
deterministically before the node manifest is sealed. Evidence paths are
bounded canonical repository-relative POSIX paths, and publication verifies
that each one is a regular file inside the threat-model task's exact workspace;
URLs, absolute and Windows paths, backslashes, control characters, and
dot/traversal segments are rejected. Optional line and symbol metadata does not
bind the artifact to file bytes.
The same path schema applies to applicability evidence copied into
`goal-plan.json`. The plan records one goal per modeled threat, one per
applicable database class, and the fixed
roaming goal. Its `threat_model_sha256` binds the exact upstream JSON bytes,
and its catalog class IDs and applicability decisions cover the planner catalog
exactly once. Only selected vulnerability-class source records are snapshotted.
Their exact paths, byte sizes, and SHA-256 digests must agree across the plan, database snapshot
manifest, artifact manifest, and bundled bytes.

The plan also writes down what it expects the runtime to build.
`expected_child_count`, `threat_count`, `applicable_class_count`, and
`max_dynamic_nodes` are recorded deterministically after the planner agent
returns, from the plan it wrote plus the run's resolved
`run.max_dynamic_nodes`; the agent must not write them itself. `goal_lanes`
names every threat goal, every class goal, and the fixed roaming goal, each with
the node IDs it owns. `expected_child_count` is `threat_count +
applicable_class_count`: the roaming goal is a static topology node, so it is a
named lane but never a dynamic child. A plan whose recorded numbers disagree
with its own goals, or that expects more children than `max_dynamic_nodes`
permits, is rejected by the `ultrafuzz/goal-plan@1` contract.

Three of those numbers are aliases, not new arithmetic: `threat_count`,
`applicable_class_count`, and `expected_child_count` are by construction equal to
the pre-existing `counts.threats`, `counts.applicable_classes`, and
`counts.dynamic_goals`. Both blocks are checked against one function, so the
cardinality rule is computed once and the two cannot drift. `max_dynamic_nodes`
and `goal_lanes` are the genuinely new fields; readers may use either name for
the counts.

A goal lane is **one goal**: `lane_id` is a threat ID, a class ID, or the fixed
roaming node ID, so a run has `threats + classes + 1` lanes. The alternative —
one lane per dynamic group, giving three lanes per run — reports the cost of a
whole group and cannot say which goal was expensive or which one failed, so
per-goal is what is recorded. Group totals remain derivable by summing lanes of
one `kind`; the reverse is not.

Evaluation reads these numbers and compares them against the run rather than
recomputing them, so a planner that under-expands is caught by a component that
did not derive the expectation. Dynamic child nodes record
`provenance.source_node_id` in `state.json`, naming the node whose output
produced them. Per-lane tokens and cost are joined from `usage.jsonl` on its
`node_id`, the identity `state.json` keys a node under. That field is optional:
ledgers written before it existed carry none, and an entry without it is
unjoinable, which the record reports as `cost_evidence` /`lane_cost_evidence` of
`unavailable` with a reason. A lane that genuinely spent nothing reports zero
with complete evidence, so it is never confused with a join that did not land.

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
directory and must be safe project-local relative paths.

`artifact-manifest.json` records schema version, run ID, node ID, creation
time, artifact paths, sizes, SHA-256 digests, output contract IDs and digests,
and provenance such as logical node, attempt index, loop index, model profile,
model name, workflow task, and source run when available. It also records the
exact prerequisite manifest digests consumed by the attempt so reuse can reject
causally stale descendants.

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
`producer_node_id` is the runtime-controlled node that serialized the current
record. `source_nodes` is the stable union of discovery nodes that found or
corroborated the root cause; `source_node_id` remains its first-entry
compatibility alias. Dynamic source IDs remain human-readable (for example,
`dynamic:threat:liquidation:overdue`) even though filesystem storage uses a
separate safe alias. Review stages preserve and union discovery sources rather
than replacing them with the review node.
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
`ultrafuzz.properties.v1`:

```json
{
  "schema_version": "ultrafuzz.properties.v1",
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
v1 contract.

`implemented-properties.json` uses schema version
`ultrafuzz.implemented-properties.v1`; current invariant nodes publish it
through the `ultrafuzz/implemented-properties@2` contract. Every record has a canonical
`property_id`, a status (`implemented`, `pending`, `deferred`, or `blocked`),
and `implementation_paths` and `test_paths` arrays. The invariant campaign's
`recon-fuzzer-results.json` uses `ultrafuzz.property-campaign.v1`; failure
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
deferring benchmark-relevant coverage. Historical artifacts may omit
`selection` and remain readable.

The final report mirrors this handoff in
`property_implementation_coverage`, preserving the threshold, inclusive
priorities, selected IDs, ordered implemented/blocked/pending/deferred ID
arrays, and the reference expectation property/ID arrays for analysis. A
current report must include this object in `report.json` and render
`## Property implementation coverage` in `report.md`; runtime checks compare
both representations with the implementation handoff. Reports produced before
this field existed (and without current selection metadata) use `"unavailable"`.

### Campaign outcome

An invariant campaign that never fuzzed and one that fuzzed and found nothing
both leave an empty findings array, and the agent-authored report cannot tell
them apart. Report generation therefore takes the outcome from the campaign's
own `campaign-summary.json` and mirrors it in `report.json` as
`campaign_outcome`:

```json
"campaign_outcome": {
  "outcome": "blocked",
  "reason": "recon executable unavailable; the long single-backend campaign was not started"
}
```

When the outcome is anything other than a completed one, `report.md` renders a
`## Campaign status` section naming the outcome and its reason. Outcomes that
mean no fuzzing happened — `blocked`, `not-started`, `skipped`, `unavailable` —
say the campaign did not run, and the findings sentence becomes "No issues were
reported, but the invariant campaign did not run, so this is not a result." An
outcome such as `partial` did produce results, so it says the campaign did not
complete and warns that absence of a finding does not mean the property held.

A campaign that ran to completion and found nothing still reads as
`No issues reported.`, and runs with no campaign are unchanged. When no
authoritative summary is available the field is dropped rather than published
from the agent-authored report, so a status shown here is always one the
campaign itself recorded.

Runtime artifact gates reject unknown canonical IDs and campaign references to
properties that were not recorded with `implemented` status. They validate each
campaign result record independently, judge unexplained findings against the
union of every campaign record in the node, reject raw campaign/finding
reference mismatches and dangling final-report IDs, and require final joins to
match the validated sources, implementation/test paths, and complete set of
originating fuzzer backends. Final `report.json` stores the joined chain in
`property_provenance`, using `fuzzer_backend` for one backend or
`fuzzer_backends` for several, and `report.md` renders it under **Property
provenance**. Historical artifacts without the v1 handoffs render provenance as
`unavailable` rather than failing report generation.

## Final Report

Final reporting is agentic. The report command reads agent-written final report
artifacts from:

```text
artifacts/final-report/report.md
artifacts/final-report/report.json
```

If final report artifacts are missing, `ultrafuzz report <run-id>` fails.

Current-run `report.md` contains concise links to `THREAT_MODEL.md`,
`threat-model.json`, and `goal-plan.json`, plus source-node provenance for each
production issue. Detailed threat analysis stays in the dedicated threat-model
artifacts and is not duplicated into the report. `report.json` preserves the
same `source_nodes` arrays.

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
remains the backward-compatible inverse of pricing completeness. An event's
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
JSON use only opaque row labels and disclosure-safe lifecycle, count, timing,
and node-control fields. The table bounds active/waiting node IDs to three with
a `+N` suffix; JSON retains every node ID, typed wait reason and next action,
and the lifecycle of the currently bound linked workflow.

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
attempt interval. The legacy `runtime_seconds` and `cost_estimate` row fields
remain aliases of the structured wall-time and cost values for compatibility.
The same fields are rendered from that structure into `summary.md`, which is
read by `ultrafuzz eval report`.
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
