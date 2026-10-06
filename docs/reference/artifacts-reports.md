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
prompt-history/
trusted-cli.json
trusted-bin/
artifacts/
review/
workspaces/
workspaces.json
```

`source-run.json` is present when the run derives from another run.
`events.jsonl` is the only event journal: event queries filter it, and SQLite
events are not part of the artifact contract. An append checks the new event
against the final event and any trailing events with the same timestamp;
`replayEvents` and `queryEvents` validate the whole journal. Event timestamps
never decrease: if the host clock is behind the final event, a new event is
stamped 1 ms after it, so event times can run ahead of the wall clock until the
clock catches up. The journal has no record-count limit; its 64 MiB byte limit
still applies. Runs created before this change may also have an `events.index/`
directory. Nothing reads it, and report bundles still copy it.

Each append to `events.jsonl`, `usage.jsonl`, `attempts.jsonl`, or the
`.ultrafuzz/` materialize, clean, and dashboard audit journals holds
`<journal>.lock`, created next to the journal, from reading the journal to
writing the new records. Commands that append to the same journal at the same
time, such as `ultrafuzz status --watch` syncing while `ultrafuzz cancel` runs,
therefore append one at a time instead of overwriting each other's records.
Readers do not take the lock, and report bundles do not include it. A live
append holds the lock for milliseconds. The next append takes over at once a
lock whose process on the same host has exited, and any other lock left behind
once it is 10 seconds old: an empty one, as a power loss can leave, or one
recorded on another host, such as an earlier sandbox or container on the same
volume. An append that cannot take the lock within 30 seconds fails without
writing and names the lock and the process holding it; remove the lock by hand
only after that process is gone.

`usage.jsonl` is an append-only ledger of normalized workflow usage events.
Each entry's immutable identity is the exact Smithers pair
`(workflow_run_id, source_event_sequence)`; `control_generation`, node,
iteration, and attempt remain validated evidence dimensions rather than
surrogate identities. Replaying the same continuation is idempotent. The
ledger stores closed normalized counters, not raw execution records. Usage
events are cumulative snapshots within a workflow attempt: accounting and
`stats` select the highest source-event sequence for each
`(workflow_run_id, node_id, iteration, attempt)` coordinate while retaining
every sequence as immutable audit evidence. When one attempt makes additional
model calls for output correction, their counters and fully known per-call
costs are added to that cumulative snapshot; a terminal result replaces the
same call's progress snapshot instead of being counted twice. Optional cache
and reasoning breakdowns are omitted when any included call lacks that detail.
The Smithers compatibility layer commits each accepted snapshot and its exact
`TokenUsageReported` event in one database transaction before publishing the
event to live listeners and the stream log, so a controller crash cannot leave
the usage row ahead of its recoverable ledger event. Smithers 0.35.0's
`_smithers_run_usage` table cannot encode unknown optional-component
completeness: when a cumulative event omits cache or reasoning detail, that
query-optimized row retains the prior known subtotal as a monotonic lower
bound. The event and `usage.jsonl` ledger, not that subtotal, are authoritative
for optional-component completeness.

`ultrafuzz stats <run-id>` joins this ledger with `attempts.jsonl`, `state.json`,
`graph.json`, and `run.json` to derive per-node timing and usage on demand. The
current v3 portable report-bundle ZIP includes all five files plus the bound
`graph.fingerprint`, so
`ultrafuzz stats --bundle <report-bundle.zip>` can perform the same query
offline. Present evidence is parsed with the same strict current readers as a
local run. Local mode accepts one coherent evidence snapshot only after two
matching complete reads and anchors it immediately after the accepted second
read. Only a genuinely absent optional ledger can be unavailable. Missing
usage makes both usage statistics and cumulative accounting unavailable because
the ledger can no longer authenticate the metadata rollup. Statistics are not
persisted as a separate `stats.json` artifact.

The v3 bundle proves internal agreement among its workflow identifiers and
control generation, but it omits `workflow-run-link-journal.json` and sealed
workflow control files. An offline consumer therefore cannot independently
authenticate the historical workflow-link chain; the bundle manifest is a
snapshot inventory rather than a standalone workflow-origin attestation.

## Run Metadata

`run.json` records the run schema version, run ID, creation timestamp, mode,
linked workflow IDs, and workflow evidence pointers, and, once workflows ran,
usage accounting and the agent attempts that recorded no usage (see
[Run accounting and estimated spend](#run-accounting-and-estimated-spend)).
Strict inspection,
`replay`, and `fork` use the complete linked-workflow evidence. Ordinary
`resume` needs only the safe run root, persisted workflow path, and Smithers run
identity; newer projections and authorization journals do not gate native
continuation.

`config.resolved.toml` stores the resolved config for the run. Secret-looking
values are redacted before persistence, and restore metadata is written to
`config.redactions.json`.

`graph.json` records the planned executable graph, including logical IDs,
concrete IDs, group, prompt path, dependencies, artifact directory, contracted
outputs, primary output marker, loop metadata, reference revisions, and model
fan-out provenance. Every JSON output also records its schema filename,
fragment-free schema ID, schema SHA-256, schema-bundle SHA-256, and validator
build identity. Partial bindings are invalid.

For a dynamic topology, `graph.json` and the runtime task projection are
atomically republished as groups expand. Generated graph entries retain the
human `id`, their template group, source node/attempt and digest, expansion key
and item digest, path-safe `storage_id`, and expansion-manifest path.

`dynamic-expansions/<group-id>.json` is the immutable expansion decision. It
records canonical ordered items, generated IDs, source and template digests,
and the run-wide limit. Recovery validates and reuses it; incompatible or
tampered manifests fail rather than causing replanning or duplicate attempts.
Its template digest is the compiled launch digest of the group's template, also
for children rendered after the run's template copy was edited.

Each attempt's prompt is its `artifacts/<attempt-id>/prompt.rendered.md`, and
every engine hands the agent that file: launch, `resume` (with or without
`--refresh-controller`, `--retry-failed` or `--reset-node`), `replay` and
`fork`. A static prompt is rendered at plan time. A prompt that waits on a
dynamic group, a generated child's or a later node's such as the final report,
is rendered from the run's template copy under `dynamic-prompt-templates/` when
the group expands, and only while its file is missing. No prompt file is
compared with a recorded digest or sealed, and an edited file is what the
task's next attempt receives, except that `resume` renders the files of
unfinished tasks again from the project's current prompts, unless
`run.refresh_prompts_on_resume = false`, and keeps every file it replaces under
`prompt-history/` (see
[Change A Prompt Of A Running Campaign](../how-to/restart-continue.md#change-a-prompt-of-a-running-campaign)).
A runtime prompt that cannot be rendered, or a prompt file that is missing,
unreadable or not a regular file, fails only its task, at the
`assert-task-inputs` preparation step, with the cause.

`plan.json` records the run plan, graph/config fingerprints, topology summary,
the launch render of each static prompt (its path and digest) and the path of
its launch copy, and validation posture. The launch copies live under
`prompt-snapshots/`. Before `resume`, `replay` or `fork` starts an engine, it
restores a missing static prompt from its copy, as it is; it never replaces a
prompt file that exists. That recovery concerns runtime-owned task input only;
it never reconstructs an agent-owned output. `prompt_digest` in `run.json` and
`plan.json`, like the final report's `run_metadata.prompt_digest`, is the
digest of the prompt catalog the run launched with. Neither editing a run's
prompt files nor a `resume` that applies the project's current prompts changes
it, an expansion manifest's `template.prompt_sha256` or `plan.json`'s
`rendered_prompts[].rendered_prompt_digest`: `prompt-history/*/refresh.json` is
the only record of such a refresh.

`trusted-cli.json` binds the run-owned launcher in `trusted-bin/` to the exact
CLI entrypoint bytes, validator build, and artifact schema-bundle digest. The
entrypoint and its complete package dependency graph live in a run-owned
content-addressed directory under `trusted-cli-closures/`; the launcher verifies
the manifest, files, and dependency links before dispatch, clears ambient Node
loader/search injection, confines ESM and CommonJS module resolution to the
closure, and precedes target-controlled directories on the producer's `PATH`.
Before a schema-backed task's model work, Ultrafuzz uses it to validate a real
known-valid fixture and checks the returned schema ID, schema digest, and bundle
digest against the run's planned schema bundle; the returned validator build is
provenance. A missing, changed, or stale launcher or closure remains a setup
failure for new schema-backed model work, but its historical identity is not
continuation authorization. A current-controller continuation selects the
current launcher and validator packages when they validate with the run's
planned schema bundle, retaining the old closure as provenance, and otherwise
keeps the run's launcher.
Modal images provide the equivalent root-owned, read-only
`/usr/local/bin/ultrafuzz` entrypoint and preflight.

## State

`state.json` has schema version `ultrafuzz.run-state.v5` and schema ID
`urn:ultrafuzz:schema:artifacts:run-state:5`. Older run-state versions are
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

Synchronization records a node as `timed-out` from Smithers' typed deadline
codes (`TASK_TIMEOUT`, `TASK_HEARTBEAT_TIMEOUT`, `PROCESS_TIMEOUT`,
`PROCESS_IDLE_TIMEOUT`) and heartbeat-timeout events, not from error text: a
failure whose message mentions a timeout, or a deadline reported only as text,
is `failed`.

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

Each new attempt also records its selected Smithers chain index, model-profile
ID, agent reference, optional model/reasoning values, and
primary-or-fallback role when Smithers' durable attempt metadata identifies a
rung of the sealed task chain; selection is never inferred from the retry number
or token model. Failed primaries therefore remain visible even when a later
fallback produces the accepted output. An attempt that fails before Smithers
selects a rung ran no model and is not recorded, unless a reset supersedes it
first (see below).

Each attempt is identified by its terminal Smithers event and is recorded once:
later synchronization never re-derives or rewrites it, even when the node's
status changes afterwards. Finished, failed, timed-out, and cancelled attempts
are recorded; a cancellation has outcome and category `canceled` and the
Smithers cancellation reason as its message. A terminal event with no started
attempt in the same Smithers activation, or stamped before that attempt
started, is skipped. An attempt that was still running when its controller
stopped, for example because the controller was killed, has no terminal event:
when the run resumes, Smithers marks it cancelled without emitting one. Like a
failure, it is recorded unless it stopped before Smithers selected a rung: as
`canceled`, with the message `abandoned: the controller stopped during this
attempt, and the resumed run cancelled it`, and it counts toward the node's
`retry_count`. Its terminal is the next event of the same task, normally the
replacement attempt's start, because one resume can abandon several attempts;
it is not recorded before the task has such an event. A finished attempt whose
node then fails, for example
because the verifier or artifact gates reject its output, is recorded as failed
with category `invalid-output` for findings validation and
`artifact-validation` otherwise.
`resume --retry-failed` and `--reset-node` restart Smithers' attempt numbering,
after which Smithers' attempt row describes only the replacement. A failed,
timed-out, or cancelled attempt that such a reset superseded before any
synchronization recorded it is therefore recorded from its events without the
agent block. That includes a pre-agent failure, which then counts toward the
node's `retry_count` although no model ran. A superseded finished attempt that
was not recorded before the reset is not recorded, because the node's output
manifest now belongs to the replacement.

Attempt summaries and retry counts are derived from this ledger. Replaying a
known transition does not append it again, so resume, replay, checkpoint
continuation, and controller takeover preserve prior lifecycle history. Reused
work points to its source attempt and is reported separately from executed work.
The ledger stores typed failure categories but never raw diagnostics, inputs,
outputs, or configuration. Ledger bookkeeping does not block synchronization:
when Smithers attempt detail is unavailable or an append fails, synchronization
reports a warning, still reconciles node and run status, and retries on the next
pass. Synchronization reads each Smithers event stream with
`smithers events --limit 100000`, the CLI maximum, which returns the oldest
events first; a stream that returns exactly that many events is reported as
`WORKFLOW_EVENTS_TRUNCATED`, because any later attempts or usage cannot be read.

For terminal report producers, `report.json#run_metadata.agent_execution`
contains the full planned attempt chain, the attempts that failed before the
successful generation, and the actual producing profile/model. Before each
producer attempt starts its agent, the workflow records the chain rung it
selected in `smithers/final-report-selections/<attempt-id>.json` under the run
directory, outside the agent's worktree and artifact roots. The workflow
verifier compares the report field with controller memory or, after a
controller restart, with that record before accepting the report, so downstream
evals can detect mixed-model runs without trusting the task-local copy the
agent was given. `failed_attempts` is inexact in two cases: it omits attempts
that ran before `resume --refresh-controller` replaced an earlier release's
workflow, and after a reset that reuses attempt numbers it can list an attempt
from before the reset. The record is host evidence, not a sandbox boundary: an
agent running unsandboxed as the same user could edit it, as it could edit the
Smithers database, and so could a Codex agent in its `workspace-write` sandbox
when the project lives under `/tmp` or `$TMPDIR`, which that sandbox leaves
writable.

The runtime does not serialize `agent_execution` or
`property_implementation_coverage` into the model prompt. Immediately before a
terminal-report attempt it writes both values to the bounded, task-local
`.ultrafuzz/authorities/<attempt-id>.final-report-prompt.json` document and the
prompt contains only that workspace-relative pointer and copy instructions.
The controller strictly parses the file, compares it with the derived values,
applies the pre-agent evidence byte limit, and verifies the same immutable bytes
immediately before and after every model call. Retries replace the document from
authenticated dependency snapshots with the newly observed retry-chain
projection before generation.

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

The `stateful-invariant-campaign` node in the packaged `exhaustive` and
`invariant-only` topologies runs one final recon-fuzzer backend and writes
backend-neutral `campaign-plan.json`, `campaign-summary.json`, and
`campaign-report.md` artifacts plus `recon-fuzzer-results.json`. The plan
records the resolved vCPU count, worker count, wall-clock budget, deadline, and
finalization reserve. The configured invariant fuzzer timeout is the backend's
full execution budget. The long Recon command passes that exact value to
`--timeout`, uses an explicit nonbinding test limit instead of Recon's default
50,000-call cap, and has a host supervisor send `SIGINT` only when the complete
fuzzing interval has elapsed. A bounded process-shutdown grace follows that
cutoff, and the artifact-finalization reserve follows the shutdown grace; neither
is subtracted from the configured fuzzer timeout. The backend record keeps its
command, configured timeout, version, timestamps, typed termination reason,
terminal status, distinct artifact paths, failures, reproducers, and available
coverage metadata. The summary classifies the result as `complete`, `partial`,
or `blocked` without discarding usable evidence, and runtime validation rejects
a full-timeout claim whose command or elapsed timestamps disagree with the
resolved configuration. Workflow compilation also rejects an invariant campaign
whose effective node timeout cannot contain the smoke timeout, complete fuzzer
timeout, host shutdown grace, and artifact-finalization reserve.

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

The producer's rendered prompt includes safely quoted schema and contract
validation commands per JSON output. The first validates the pinned schema; the
second applies the registered schema plus document-local semantic gates.
Generated-test producers receive a third command that checks companion files
and the sealed run and logical-producer identities through the same contextual
gate used by the host. The producer runs every displayed command after the
final write and corrects an exit-`1` draft before returning. Once the agent
session returns, declared artifact bytes are immutable. Host validation,
contextual gates, synchronization, reporting, dashboards, and bundles may
reject the bytes or copy them exactly, but may not normalize, convert, repair,
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
| `severity_guess` | Optional preliminary `High`, `Medium`, or `Low`. |
| `confidence`     | Optional lowercase `high`, `medium`, or `low`.   |
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
`recon-fuzzer-results.json` uses `ultrafuzz.property-campaign.v3`. It is a
closed execution record that names the authenticated plan, implementation
handoff, findings, and campaign-summary artifacts; preserves backend identity,
command/config, worker count, timing, deadline, exit/failure evidence, and
declared paths; types available or unavailable coverage; and contains exactly
one result row for every implemented property. Every observed failure carries
its raw evidence plus either a deterministic reproducer or a typed reproduction
blocker. Failure records caused by implemented catalog properties carry
non-empty `property_ids`; non-property failures use an empty array.
Two path bases apply: recorded path fields (the plan's and result's `paths.*`,
`evidence_files[].path`, coverage `source_ref`, property-result
`evidence_refs`, and failure reproducer references) are relative to the node's
artifact directory (for example `backends/recon-fuzzer/run.log`), while
reference fields (`campaign_plan_ref`, `implemented_properties_ref`,
`findings_ref`, `campaign_summary_ref`, and the summary's own references) carry
the bare declared output path (for example `campaign-plan.json`) with no
directory prefix.
The required `evidence_files` array is a closed, bounded manifest of exact file
references rather than a recursive backend-directory inventory. It lists the
log when the backend started, raw results when the document claims usable or
reported results, and every coverage, property-result, raw-reproducer, and
deterministic-reproducer file exactly once with byte length and SHA-256. The
reference set itself supplies each entry's role. Verification snapshots each
regular non-symlink, non-hard-linked file once and reuses those bytes for digest
checks, publication, and the verification marker.
Property-derived `findings.json` entries carry the same property IDs and use a
representative raw failure's ID. Historical v1/v2 records are rejected without
conversion or compatibility fallback.

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

Topologies that do not declare the property-implementation track use the
required typed value `{ "status": "not-planned", "reason":
"property-implementation-track-not-declared" }`. This value describes the
current topology; it is not a historical fallback. The Markdown projection
renders the same two fields, and omission or the former `"unavailable"` string
is schema-invalid.

When the property-implementation track was planned but its result is omitted
after failure, the report agent copies the runtime-supplied value
`{ "status": "unavailable", "reason": "property-implementation-not-completed" }`.
This records a coverage gap without claiming the track was absent. It does not
permit a failed producer's artifacts to become report inputs.

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
campaign result record independently; require its plan/backend/command/path and
implemented-property joins; reconcile property results, failures, findings,
reproducers, and summary accounting; judge unexplained findings against the
union of every campaign record in the node; reject dangling final-report IDs;
and require final joins to match the validated sources, implementation/test
paths, and complete set of originating fuzzer backends. Final `report.json`
stores the joined chain in `property_provenance`, using `fuzzer_backend` for one
backend or `fuzzer_backends` for several, and `report.md` renders it under
**Property provenance**. Missing or inconsistent current provenance fails the
report gate; the host does not synthesize it from older handoffs.

## Final Report

Final report content is always agent-written. The final-report agent writes
`report.md` and `report.json` in its workspace, under
`workspaces/<attempt>/artifacts/<attempt>/`. Output that passes verification is
published as:

```text
artifacts/final-report/report.md
artifacts/final-report/report.json
```

`report.json` must satisfy `ultrafuzz/report@3` with the exact
`ultrafuzz.report.v3` version literal. After a run stops, the runtime can format
that report, attach whole-run completion information, and restate the run
summary's elapsed time and accounting without changing the agent's files.
Verified publications use:

```text
review/runtime-report/<authority-digest>/report.json
review/runtime-report/<authority-digest>/report.md
review/runtime-report/<authority-digest>/terminal.json
review/runtime-report/current.json
```

Each report row carries a source finding: the severity-classified finding, or
the deduplicated finding in bounded classification mode. Changed or omitted
explanatory text (`summary`, `description`, `proof_of_concept`,
`recommendation`, `recommended_next_action`, and the impact, likelihood, and
severity rationales) produces a verification warning and does not fail the
report. Verification keeps every other carried field exact: identity,
location, provenance, evidence, and classification fields, `notes`, and the
prose nested in `evidence`, `deduplication`, `family_variants`, and
`related_findings`. The exceptions are fields the report owns: the ID and title
of production issues and, in bounded classification mode, the triage
classification, lifecycle enrichment, and severity assessment of production
issues. A `recommendation` is carried, never added: a report row that has a
`recommendation` its source finding lacks fails verification in both strict
and bounded classification mode. A production issue renders its
`recommendation` as `### Remediation`, so on a `report.json.issues` row a
changed or omitted `recommendation` fails verification too, while on a
`non_production_outcomes` row, which never renders it, it is a warning like
the other narrative fields.

New runs use `run.completion_policy = "best-effort"` by default. The stock
property-lens, goal, strategy, and specialist groups continue after ordinary
task failures. Independent work can finish; work that needs a missing required
result is skipped. Nodes that combine another group's results, such as the
property fan-in and review, use the successful results that pass the existing
input checks. User-authored topologies retain
their declared failure policies. The configured attempts and time limits remain
in effect; reporting does not restart analysis or add recovery attempts.

`ultrafuzz run --require-complete` selects strict completion. Incomplete work
makes the run unsuccessful, while eligible reporting still proceeds. The policy
is saved at launch. It is separate from verification of the report.

A successful report agent produces a PARTIAL report when planned coverage is
incomplete. If every strategy fails, review can still report missing coverage
when its execution prerequisites and time limits permit it. If the report
agent cannot start, fails, or exhausts its allowed attempts, the run ends with
**report unavailable** and preserves the saved task results; a report rejected
at verification is the exception described below. The runtime does
not synthesize a replacement report from raw findings. `ultrafuzz report`
returns a clear error when no current report-agent output is available.

`ultrafuzz report <run-id>` prefers the current verified report. Local report
verification is optional: when supporting records cannot be fully verified,
a readable, schema-valid report from the current successful report-agent attempt
can be formatted as an unchecked PARTIAL report under
`review/unverified-report/<digest>/report.json` and `report.md`. When the report
agent finished but its output was rejected at verification (the artifact
verifier failed, or the controller rejected the verified publication, for
example because it changed), the runtime formats the agent's own
`workspaces/<attempt>/artifacts/<attempt>/report.json` the same way and never
reads the copy under `artifacts/`. That file must be readable and schema-valid
and must pass the artifact secret gate; the reason codes then include
`record-invalid`. The unchecked report does not say why verification rejected
it; the report node's `last_error`, shown by `ultrafuzz inspect <run-id> --json`,
does. These files preserve the agent-written content; they are not fallback
analysis reports.

The command's JSON result includes `source` (`verified-agent-report`,
`verified-runtime-report`, or `unverified-runtime-report`), `verification`
(`verified` or `not-checked`), `terminal`, and the `completion` outcome when
available. Completion describes coverage; verification describes checks of the
supporting records. Unknown counts remain unknown, rather than becoming zero.
Unchecked reports are always PARTIAL because complete coverage was not verified.

Unchecked `report.json` documents carry `verification.status: "not-checked"`,
bounded reason codes, and `observed_completion` with nullable counts and an
outcome of `partial`. The runtime does not turn other task findings into new
report issues. These presentation fields grant no execution or scoring authority.

Use `ultrafuzz report <run-id> --require-verified` to require report verification.
The dashboard uses the same default and displays the verification label. A
PARTIAL report can coexist with a failed run. `ultrafuzz status`, including
`--watch --json`, exposes execution completion and current report availability;
it does not start report agents. A terminal run without a report stops the
watcher with a clear unavailable reason. Paused runs remain distinct from ended
runs. Repeated polls read a saved publication summary rather than rebuilding
report content.

An explicit retry can replace a failed attempt. A new terminal publication must
match the current execution and successful report attempt; an older report must
not appear as the current result of a resumed run. A run whose workflow engine
run ended failed is reported failed, and verified publication rejects a
succeeded outcome for it.

### Run summary

The `## Run summary` section of `report.md` lists exactly `Run ID`,
`Repository`, `Commit`, `Elapsed time`, `Models used`, `Tokens used`,
`Estimated spend`, and `Audit profile`, in that order, each value as inline
code. The report task receives these values as a host-generated projection
when it starts. The agent copies the complete projection into
`report.json.run_metadata`, adding only `agent_execution`, and verification
requires the copy to equal the projection exactly.

`Commit` renders the required `run_metadata.target_commit`: the run's source
revision, the 40-character lowercase hex commit recorded at launch as
`run.json` `source_revision`, which every task worktree is created from, or
JSON `null` when the run recorded none. A `null` commit renders as:

```markdown
- Commit: `none` (no Git commit was recorded for the evaluated target)
```

Because task worktrees are created from that commit, it names the tree the
campaign evaluated: uncommitted changes in the launch checkout were not
evaluated. Run lineage stays in structured records. A Modal holdout row shows
the synthetic holdout commit it evaluated. The public projection keeps
`target_commit` unredacted, and terminal and unchecked presentations never
restate it.

`report.md` does not render `source_run_id`, `source_run_ids`,
`partial_pricing`, `attempts_without_usage`, `unpriced_attempts`, or
`artifact_validation_warnings`; `report.json.run_metadata` keeps them all. The
last three only decide whether the spend ends in `+`. See
[Partial Agent Artifacts](../schemas.md#partial-agent-artifacts) for where
artifact validation warnings are shown, and
[Run accounting and estimated spend](#run-accounting-and-estimated-spend) for
`Models used`, `Tokens used`, and `Estimated spend`.

### Issue sections and remediation

Each production issue renders its description, `### Severity`,
`### Proof of Concept`, `#### Family variants` when the finding has them, and
then `### Remediation` as its last section. Remediation shows the issue's
`recommendation`. A producer sets that field only when its cited evidence
establishes the fix, dedupe keeps the root finding's value, and later stages
copy it unchanged. The report stage never adds one (see above). When
`recommendation` is absent, blank, or `unavailable`, the renderer writes this
fixed sentence instead, without changing `report.json`:

```text
No remediation was recorded for this finding, and Ultrafuzz does not infer one. Confirm the root cause in the description and Proof of Concept before designing a fix.
```

Finding prose (issue titles and index labels, descriptions, impact and
likelihood rationales, Proof of Concept steps, family variants, and
Remediation) is collapsed to one line and rendered as text, except that a
single- or double-backtick span renders as inline code, so `` `totalAssets` ``
reads as code. A span whose content contains `<` or `>`, a run of three or more
backticks, and an unmatched backtick are escaped, as are emphasis, link, image,
heading, quote, and HTML syntax. List, table, setext, and link-definition syntax
is escaped where the prose starts a Markdown block (a description, a Proof of
Concept step, or Remediation), not inside a title or rationale. In a table cell
(the issue index, Property provenance, and non-production outcomes), a span
whose content contains `\|` is also rendered as escaped text, since a GFM cell
cannot keep that pipe inside inline code. Issue index links use
GitHub-compatible anchors of the visible heading text.

### Whole-run completion contract

The optional `report.json.completion` object describes whole-run completeness,
separately from the invariant-specific `campaign_outcome`. The runtime derives
the census from a stopped run's authenticated task and output evidence.
Completion remains optional on agent-authored reports; their producers cannot
assert whole-run completion on their own authority.

A completion object uses `ultrafuzz.report-completion.v1` and binds `run_id` to
`run_metadata.run_id`. Its `counts` object contains `planned`, `succeeded`,
`failed`, `timed_out`, `skipped`, `cancelled`, and `unverified`. The six outcome
counts must sum exactly to `planned`; `outcome` is `complete` only when every
planned node succeeded, otherwise `partial`.

`incomplete_nodes` records up to 256 unique node identities with their outcome
and a closed failure category. `incomplete_nodes_omitted` accounts exactly for
any identities beyond that limit; omitted identities never reduce the counts.
The contract does not accept control-plane or integrity failures as ordinary
task failures.

Counts cover each concrete sealed task slot once, including the reporting task.
Retries and logical/model aggregates do not add planned work. An unexpanded
dynamic group contributes one incomplete scope of unknown size; its future
tasks are not guessed. Only current verified outputs count as successful.

Canonical rendering of a partial census starts with
`# Ultrafuzz report — PARTIAL`, puts a prominent incompleteness warning before
findings, and shows the counts and incomplete scope. An empty partial report
explicitly says it is not a clean result. A complete census retains the normal
report title. A report without a runtime census retains its previous rendering;
absence of the field is not evidence of whole-run completeness.

Offline schema validation and `ultrafuzz report render` establish document
consistency and presentation only. Verified runtime report publication also
requires authenticated terminal evidence, the sealed graph and task manifest,
and current verification/finalization authority for successful outputs. The
runtime reader rederives the census and canonical report and requires exact
agreement with the stored publication. Agent verifier paths continue to reject
unauthenticated completion claims, even when publication digests match.

Verified publication can describe ordinary task failures and their coverage
gaps while preserving an agent-written report. Artifact and controller integrity
failures still prevent verified publication. Optional verification may expose an
existing agent-written report with explicit unchecked status; it never creates
missing report content or admits failed task outputs into execution.

This is a new-version contract. The saved completion policy uses resolved-config
v4; migration or resumption of runs from older versions is outside this change.

Portable report bundles first attempt to include the verified runtime
publication and recheck the current verified run snapshot before writing the
archive. Only the current verified runtime generation and its pointer are
included in a full run bundle. Older generations and unchecked report
directories are excluded. Files a full-run bundle finds but cannot package
(over the 64 MiB per-file limit, symlinks, non-regular files, unsafe archive
names, or unreadable files) stay on disk and are listed in the manifest's
`omitted_files` with their path (run-relative, or `engine-logs/<name>` for
engine logs), reason, and size when known.
If full-run verification fails, the default bundle
contains only `report.json`, `report.md`, and `bundle-manifest.json`; the
manifest and command result identify `scope: "report-only"` and the report's
verification status. Arbitrary unchecked run artifacts are not included. Use
`ultrafuzz report bundle <run-id> --require-verified` to require a verified
full-run bundle. A report-only archive provides no run statistics or scoring
authority.

Report publications preserve the identity recorded by the agent. Reading them
does not depend on the source checkout or its current Git origin. Public bundles
still require matching repository identity and a bound verified terminal report.
Unchecked local reports do not create benchmark scoring authority. If no agent
report exists, report bundling also fails clearly.

### Internal authority and public projection

The agent artifacts and the separate runtime publication are private, run-local
reports with distinct authority. Existing strict agent-report verification and
lifecycle APIs retain their immutable agent-report authority. Runtime
formatting does not grant a failed task successful finalization. Public
publication neither mutates those files nor promotes a published copy to run
authority.

Public benchmark publication crosses a separate privacy boundary. It first
validates the internal report, deep-copies its canonical JSON, redacts private
filesystem paths from string values, and validates the sanitized JSON again.
The publisher serializes that object as the public `report.json` and renders the
public `report.md` from the exact same sanitized canonical JSON rather than
copying the internal Markdown. Bundle validation rejects a public report whose
JSON is not that privacy-safe projection or whose Markdown is not its exact
canonical rendering. The published pair therefore remains in JSON/Markdown
parity without changing the trusted internal report authority.

### Coverage evidence

In a verified agent report, planned `report.json.coverage_evidence` is the exact
finalized `ultrafuzz/coverage-evidence@1` handoff. Measured
evidence authenticates its raw `coverage-input.lcov` and `recon-coverage.json`
sibling outputs by path and
SHA-256. Unavailable evidence carries typed blockers and no measurement.

Coverage evidence is JSON-only in reports: `report.md` has no
`## Scoped coverage evidence` section. When `coverage_evidence.status` is
`unavailable`, the Run summary is followed by this fixed notice:

```text
Scoped coverage could not be measured for this run, so how much of the in-scope code the campaign exercised is unknown.
```

In that case a report that is neither partial nor unchecked, and has no issues
and no non-production outcomes, also says in its no-issues sentence that scoped
coverage could not be measured, so the sentence is not read as a clean result.
Partial and unchecked reports keep their fixed empty-findings notice.

When the evidence is measured and any view covers fewer ranges than its total,
the notice is:

```text
Scoped coverage was measured, but the campaign did not exercise every in-scope declaration; uncovered code may contain issues this report does not show.
```

Complete measured coverage, and a report without coverage evidence, render no
notice. The notices carry no numbers; the scores stay in
`report.json.coverage_evidence` and in the coverage producer's
`coverage-report.md`, whose canonical section the coverage prompt specifies:

The coverage producer's Markdown uses exactly one canonical section and
preserves array order; `report.md` does not render it. Apply public-inline
sanitization to code-like fields: redact secrets and private paths, collapse
whitespace, replace backticks with apostrophes, and use `unavailable` when
blank. Apply public-prose sanitization to `<summary>` and `<exclusion_reason>`:
use the same redaction, whitespace, and fallback rules, then escape backslashes
and Markdown code, emphasis, link, image, heading, and strikethrough delimiters
plus HTML angle brackets. Measured evidence uses:

```text
## Scoped coverage evidence

- <scope>: `<covered_ranges>/<total_ranges>`

Excluded from Recon-selected scope:
- None

Zero-coverage components:
- None
```

Repeat the scoped row for every view. Replace `- None` with one row per entry:
``- `<path>` (<kind>): <exclusion_reason>`` for excluded files and
``- `<path>:<start_line>-<end_line>` (<kind>)`` for zero-coverage ranges.

Unavailable evidence uses:

```text
## Scoped coverage evidence

- Status: unavailable

Blockers:
- <category>: <summary>
  - Evidence: `<path>`
```

Repeat blocker and evidence rows in artifact order. Runtime publication compares
this section with the typed handoff and rejects missing, duplicated, reordered,
or contradicting scoped scores, and it warns about coverage scores that name no
exact scope. Raw `covg-eval` output is for iteration only and defines neither
published declaration-completeness view.

A coverage score that names no exact declaration-completeness scope, whether in
`report.md`, the coverage producer's Markdown, or `report.json` text, does not
fail publication, although text that exceeds the 2,048-candidate scan limit
still does. When no coverage producer was planned or admitted,
`report.json.coverage_evidence` or a `report.md` score that names an exact
scope fails the final report with `REPORT_COVERAGE_EVIDENCE_UNPLANNED`. With a
planned producer, missing finalized producer authority fails with
`REPORT_COVERAGE_EVIDENCE_UNAVAILABLE`, and a `report.json.coverage_evidence`
that differs from the handoff fails with `REPORT_COVERAGE_EVIDENCE_MISMATCH`.
A `## Scoped coverage evidence` heading line in `report.md`, including one
inside a comment or a container such as `<details>`, fails the final report
with `REPORT_COVERAGE_EVIDENCE_MARKDOWN_UNEXPECTED` whether or not a producer
was planned. When the planned evidence matches, a visible `report.md` coverage
score that names an exact scope fails with the same code.

Current-run `report.md` contains source-node provenance for each production
issue and does not link to other run files. Detailed threat analysis stays in
the dedicated threat-model artifacts and is not duplicated into the report.
`report.json` preserves the same `source_nodes` arrays. Inline link and image
syntax inside report prose, including prose preserved byte-for-byte from
upstream findings, renders as literal text.

### Run accounting and estimated spend

`Estimated spend` is the run's priced usage in accounting v4,
`accounting.cumulative.estimated_spend_usd`, the same amount that
`ultrafuzz stats`, eval scoring, and Modal accounting read. It is an estimate,
not an invoice. `report.json.run_metadata.estimated_spend` is always a USD
amount matching `^\$(?:0|[1-9][0-9]*)\.[0-9]{2,10}\+?$`: two decimals from one
cent up, such as `$38.72`, and enough decimals below one cent to show the
amount, such as `$0.0008`. Accounting that priced nothing shows `$0.00`. It is
never `unavailable`.

Usage that was not recorded or could not be priced is never estimated. Instead,
a trailing `+` means the amount is probably low: there is probably more. The
spend ends in `+` exactly when at least one of these holds:

- `run_metadata.partial_pricing` is true: the accounting the amount came from
  priced only part of its usage;
- `run_metadata.attempts_without_usage` is present: executed agent attempts
  recorded no usage;
- `run_metadata.unpriced_attempts` is present: recorded usage that no rule
  below could price.

The two counts are present only when they are at least one, and the report
schema rejects a spend whose `+` disagrees with these fields. `report.md` shows
only the amount:

```markdown
- Estimated spend: `$38.72+`
```

When everything recorded was priced and every attempt recorded usage, the line
is ``- Estimated spend: `$38.72` ``. When nothing recorded usage, the usage
lines read:

```markdown
- Models used: `none` (no model usage was recorded)
- Tokens used: `0`
- Estimated spend: `$0.00+`
```

and when no agent attempt ran either, the spend line is just
``- Estimated spend: `$0.00` ``.

The report task's snapshot takes models, tokens, spend, `partial_pricing`, and
`unpriced_attempts` together from the first source that applies:

1. the run's `accounting.cumulative`, which includes its source runs;
2. for a continuation whose own accounting has not been written yet, its source
   run's `accounting.cumulative`;
3. for a run without a source run, the live Smithers usage of its workflow run,
   priced the same way, where `unpriced_attempts` also counts the attempts
   Smithers aggregated without a usage event;
4. otherwise no usage: models `[]`, tokens `0`, and spend `$0.00`.

`attempts_without_usage` comes from the run's own `run.json`, whose count
already includes its source runs. The agent's `report.json` and `report.md`
keep that snapshot. Runtime presentations (the verified terminal publication
and unchecked reports) restate the run summary instead: elapsed time from
`run.json#created_at` to `state.json#finished_at`; models, tokens, spend,
`partial_pricing`, and `unpriced_attempts` together from the current
`accounting.cumulative`; and `attempts_without_usage` from the current
`run.json` on its own. Without accounting, the agent's usage values stay. The
`+` is then set again from the restated fields, so a report-start `+` goes away
when the whole run turned out fully priced. The terminal synchronization runs
before terminal publication, so the restated values include the report task's
own usage.

Accounting v4's own `estimated_spend` label is unchanged for `ultrafuzz stats`
and never reaches the report: it ends in `+` when some accounted usage had no
price, is `unavailable` when none had one, does not consider attempts without
usage, and rounds amounts below one cent to four decimals. Use
`ultrafuzz stats` for the full accounting breakdown.

#### Spend pricing

Accounting v4 prices the latest usage event of each attempt with the first of:

1. the cost the adapter recorded (`recorded_cost_usd`), as is, including a
   recorded `0` from a subscription adapter;
2. the price of the model's catalog route;
3. the versioned fallback table below, for a model the catalog left unpriced,
   whether the catalog was available, unavailable, or disabled.

An event none of them prices counts in `unpriced_event_count`, which the report
records as `unpriced_attempts`, and makes `partial_pricing` true. Accounting
keeps one event per attempt, so the event count is an attempt count. A
component without a rate in an otherwise usable price, such as cache writes for
a model whose price lists no cache-write rate, adds nothing to the amount; the
event still counts as priced, so `unpriced_attempts` does not count it, while
`pricing_incomplete_reasons` records `component-rate-unavailable` and
`partial_pricing` is true, so the spend still ends in `+`.

Catalog routes depend only on the model ID. One leading `openrouter/` is
stripped. An ID that contains `/` or starts with `~` is looked up only in the
`openrouter` catalog provider, as is and then with a leading `~`. An ID starting
with `claude-` uses only `anthropic`; `gpt-`, `chatgpt-`, or `o` and a digit
only `openai`; `deepseek` only `deepseek`; and `kimi` or `moonshot` only
`moonshotai`. Any other ID has no route and stays unpriced. A trailing context
alias, such as `[1m]` in `claude-opus-4-8[1m]`, is stripped for the lookup
only. A catalog entry whose input and output rates are both zero counts as
unpriced unless the ID ends in `:free`. When no model to price has a route, no
catalog is downloaded.

The fallback table `ultrafuzz.fallback-pricing.2026-10-05` copies the
first-party list prices that <https://models.dev/api.json> published on
2026-10-05 for the packaged default models, in USD per million tokens. It is
looked up through the same routes, so it prices `claude-opus-4-8[1m]` or
`openrouter/claude-opus-4-8`, but never a gateway, proxy, or custom ID such as
`azure/gpt-5.5` or `openai/gpt-mini-latest`, which stays unpriced:

| Model             | Provider     | Input | Output | Cache read | Cache write |
| ----------------- | ------------ | ----- | ------ | ---------- | ----------- |
| `claude-opus-4-8` | `anthropic`  | 5     | 25     | 0.5        | 6.25        |
| `deepseek-v4-pro` | `deepseek`   | 0.66  | 1.98   | 0.022      | none        |
| `gpt-5.5`         | `openai`     | 5     | 30     | 0.5        | none        |
| `kimi-k3`         | `moonshotai` | 3     | 15     | 0.3        | none        |

Above 272,000 input tokens, `gpt-5.5` is priced at 10 input, 45 output, and 1
cache read. Accounting stores every rate it priced a model at in
`pricing_catalog.model_prices` and reuses it on later passes, so a model first
priced from the table keeps those rates even after the catalog becomes
reachable, and a later table version never reprices it.

#### Where run.json records the method and completeness

- `accounting.pricing_catalog`: the catalog `source` and `status`,
  `resolved_models` (priced by the catalog), `unresolved_models` (not priced by
  it), `fallback` with the `table` version and the unresolved `models` it
  priced, and the `model_prices` every amount was computed from.
  `ultrafuzz stats`, eval scoring, and Modal reprice from the same
  `model_prices`, so they report the same spend.
- `accounting.cumulative`: `estimated_spend_usd`, `partial_pricing`,
  `priced_event_count`, `unpriced_event_count`, and the typed
  `usage_incomplete_reasons` and `pricing_incomplete_reasons`.
- `attempts_without_usage`, present only when at least one executed agent
  attempt recorded no usage. `attempts` lists this run's attempt occurrences,
  across every workflow run it was bound to, each with `workflow_run_id`,
  `source_event_sequence`, `node_id` (`node:<strategy attempt ID>`),
  `iteration`, `attempt`, and `model_name` when known; `cumulative_count` adds
  the source run's own count. An occurrence is an `attempts.jsonl` entry with
  `reuse.status` `executed` and agent provenance. It has no usage when no usage
  event of its workflow run, Smithers task, iteration, and attempt falls between
  its start and terminal events, so each occurrence that a reset reran is judged
  on its own. Every synchronization recomputes the member from the ledgers, also
  while `usage.jsonl` is empty and accounting is absent. Two cases are judged
  imperfectly. An occurrence that a reset superseded before any synchronization
  recorded it has no agent provenance, so it is never listed even if its model
  ran without reporting usage. Usage that an adapter reports after the
  occurrence's terminal event is priced by accounting, yet the occurrence is
  still listed.

#### Accounting v4

`accounting.segments` publishes one rollup per checkpoint generation, and
`accounting.current` identifies the latest segment. Each segment retains every
source event sequence as audit evidence, but accounting uses only the latest
cumulative usage snapshot for each workflow attempt. `accounting.cumulative`
combines those canonical attempt snapshots with any source-run lineage.
`accounting.checkpoint` records the raw ledger position used by the durable
metadata snapshot. The accounting block is a cache that every synchronization
rebuilds from `usage.jsonl`, and a usage row is recorded once and never
re-derived, so a synchronization interrupted between the usage append and the
`run.json` write is repaired by the next one. A failed accounting pass is
reported as a `WORKFLOW_ACCOUNTING_FAILED` warning and does not block run status.
An invalid usage field in an unrecorded `TokenUsageReported` event fails each
later accounting pass this way, so no further usage is recorded for the run
while node and run status keep reconciling.
Usage and pricing completeness are reported independently
through `usage_complete`/`usage_incomplete_reasons` and
`pricing_complete`/`pricing_incomplete_reasons`.

Accounting schema `ultrafuzz.accounting.v4` treats provider `input_tokens` as
inclusive of fresh input, cache reads, and cache writes, and treats provider
`output_tokens` as inclusive of reasoning tokens. Consequently,
`inclusive_token_total` and `total_tokens` are exactly input plus output;
cache and reasoning counters are diagnostic and pricing breakdowns, not
additional tokens. Contradictory breakdowns are retained but marked incomplete
and are not locally repriced. `billable_token_total` counts components with a
known positive local rate without counting reasoning twice.

For catalog-priced events, `component_costs_usd` sums to the local portion of
`estimated_spend_usd`. When an adapter records an event cost, that value takes
precedence over host-side repricing, is retained in `provided_cost_usd`, and
makes pricing complete for that event even if component rates are unavailable.
The recorded value remains an estimate unless its adapter documents
authoritative billing provenance. Across mixed events, local component costs
plus provided costs sum to `estimated_spend_usd`. `usage_complete` and `pricing_complete`
remain independent: their typed `*_incomplete_reasons` arrays distinguish
missing, estimated, or contradictory usage from missing pricing. In
accounting v4, a trailing `+` on `estimated_spend` and `partial_pricing` mean
that at least one accounted event still lacks a usable cost. The v4 label never
reaches `report.md`; `partial_pricing` reaches it only through the report's own
`+` rule. Accounting v4 uses the catalog routes described above:
for example, a bare Kimi-family ID is priced only from the Moonshot provider
entry and a bare DeepSeek-family ID only from the first-party DeepSeek entry. A
model its route does not price stays listed in
`pricing_catalog.unresolved_models` rather than borrowing a same-named rate
from another provider, and is priced only if the fallback table lists it. A
model that a fetched catalog does not list stays unresolved without another
catalog download; only an unavailable catalog is retried on a later
synchronization, and never for a model already priced from the fallback table.

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
attempt interval. Row timing and cost exist only in the structured `efficiency`
block; the historical `runtime_seconds` and `cost_estimate` aliases are rejected.
Those canonical fields are rendered into `summary.md`, which is read by
`ultrafuzz eval report`.
The row records include graph/config and execution artifact identities when
available. `ultrafuzz eval score` writes per-row scores to `scores.jsonl` and
the variant ranking plus scoring lineage to `summary.json`, including the
effective deterministic or optional-judge mode.

The underlying Ultrafuzz runs live inside each target
checkout, not under the eval project; eval artifacts reference them by run ID.
Grading and these artifacts do not depend on a reporting service.
See [Eval Suites](evals.md).

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
