# CLI Commands

The CLI binary is `ultrafuzz`.

Every command accepts `--project <path>`. Commands that support automation
accept `--json` and emit the `ultrafuzz.cli.result.v2` envelope.

## Commands

| Command                                 | Purpose                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ultrafuzz init`                        | Create root config plus `.ultrafuzz/**` product surfaces and workflow plumbing.                                |
| `ultrafuzz validate`                    | Validate config, topology, prompts, path guards, agent references, and trust posture without launching agents. |
| `ultrafuzz json validate`               | Validate one JSON document against a strict local Draft 2020-12 schema without mutation.                       |
| `ultrafuzz artifact validate`           | Validate a declared artifact's registered schema and document-local semantic gates.                            |
| `ultrafuzz run`                         | Validate, render prompts, build run evidence, compile a workflow, and launch a linked workflow run.            |
| `ultrafuzz config audit-profiles`       | List shipped audit profiles, intended uses, and selected topologies.                                           |
| `ultrafuzz config audit-profile <name>` | Show one profile's effective project topology and settings.                                                    |
| `ultrafuzz topology list`               | List packaged topology assets, logical node counts, and digests.                                               |
| `ultrafuzz topology show <name>`        | Show metadata and YAML for one packaged topology.                                                              |
| `ultrafuzz topology copy <name> <path>` | Safely copy a packaged topology into the project.                                                              |
| `ultrafuzz references status`           | Report whether pinned references are present in the local digest-checked cache.                                |
| `ultrafuzz references sync`             | Explicitly fetch pinned references into the local cache.                                                       |
| `ultrafuzz references update`           | Rewrite the project reference catalog to newer pinned commits when requested.                                  |
| `ultrafuzz ps`                          | List Ultrafuzz runs and linked workflow status.                                                                |
| `ultrafuzz inspect <run-id>`            | Show product evidence and linked workflow details for a run.                                                   |
| `ultrafuzz status <run-id>`             | Show a concise health verdict, progress, ETA, current-step duration, throughput, and gating nodes.             |
| `ultrafuzz stats <run-id>`              | Derive per-node timing, token usage, cost, retry, outcome, and completeness statistics.                        |
| `ultrafuzz pause <run-id>`              | Gracefully pause an active run after its in-flight tasks finish.                                               |
| `ultrafuzz why <run-id>`                | Diagnose why a run is blocked, paused, quota-parked, waiting, or unable to progress.                           |
| `ultrafuzz timeline <run-id>`           | Show checkpoint frames and fork lineage, including the frame numbers `fork --frame` accepts.                   |
| `ultrafuzz events <run-id>`             | Show linked workflow lifecycle events, with optional streaming.                                                |
| `ultrafuzz node <run-id> <node-id>`     | Show one workflow node's status, attempts, retries, timing, and output metadata.                               |
| `ultrafuzz snapshots <run-id>`          | List durability and workspace checkpoints for recovery and time-travel diagnosis.                              |
| `ultrafuzz cancel <run-id>`             | Cancel an active run; cancellation is terminal, unlike pause.                                                  |
| `ultrafuzz doctor`                      | Report validation, toolchain, and engine posture without changing project or run state.                        |
| `ultrafuzz resume <run-id>`             | Delegate resume for the linked workflow run after product checks.                                              |
| `ultrafuzz replay <run-id>`             | Delegate replay for the linked workflow run after product checks.                                              |
| `ultrafuzz fork <run-id>`               | Delegate fork for the linked workflow run after product checks.                                                |
| `ultrafuzz report <run-id>`             | Locate the agent-written final report artifacts.                                                               |
| `ultrafuzz materialize <run-id>`        | Copy selected reviewed outputs into the target project after confirmation and path checks.                     |
| `ultrafuzz clean <run-id>`              | Remove selected generated `.ultrafuzz/**` paths after confirmation and path checks.                            |
| `ultrafuzz dashboard`                   | Serve the local loopback dashboard and API for product state inspection and editing.                           |
| `ultrafuzz eval plan`                   | Dry-run an eval suite matrix without launching workflows.                                                      |
| `ultrafuzz eval run`                    | Launch Ultrafuzz runs for an eval suite matrix and stream node telemetry.                                      |
| `ultrafuzz eval status <id>`            | Show disclosure-safe node progress and ETA for every row in an eval matrix.                                    |
| `ultrafuzz eval score <id>`             | Score finished eval run reports against external ground truth.                                                 |
| `ultrafuzz eval report <id>`            | Show the scored eval run variant ranking.                                                                      |
| `ultrafuzz eval compare <id>`           | Compare scored eval variants against a baseline variant.                                                       |
| `ultrafuzz eval analyze <type>`         | Generate private offline tables, provenance, score, intersection, and cost reports from a finalized handoff.   |
| `ultrafuzz eval history [id]`           | Validate/render public eval history, or append one complete scored run.                                        |
| `ultrafuzz eval publish <id>`           | Replay a recorded eval run's node telemetry to the configured provider.                                        |

Generated workflow-engine files are implementation plumbing. The stable product
surfaces are root `ultrafuzz.toml`, `.ultrafuzz/**`, reviewed project files,
and the CLI commands above.

## Global Flags

| Flag               | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `--project <path>` | Project root. Defaults to the current working directory.     |
| `--json`           | Emit a schema-versioned JSON envelope instead of human text. |

JSON output has this shape:

```json
{
  "schema_version": "ultrafuzz.cli.result.v2",
  "command": "init",
  "ok": true,
  "diagnostics": [],
  "data": {
    "project_root": "/project",
    "created": [],
    "preserved": [],
    "overwritten": []
  }
}
```

Machine consumers should read `ok`, `diagnostics`, and `data`. The v2 envelope
is intentionally breaking and command-discriminated: every known command has a
closed `data` shape, public diagnostics omit private implementation details,
and unknown invocation failures can emit only `ok: false` with `data: null`.
Only explicit operator workflow input and redacted third-party tool
input/output retain deliberately open nested JSON. Version 1 is not accepted
or converted.

## Init

```bash
ultrafuzz init [--project <path>] [--force] [--json]
```

`init` creates or preserves:

```text
ultrafuzz.toml
.ultrafuzz/topology.yml
.ultrafuzz/prompts/**
.ultrafuzz/references.yml
.ultrafuzz/runs/
.ultrafuzz/workspaces/
.ultrafuzz/cache/
```

Without `--force`, every existing config, topology, prompt, reference catalog,
and project-owned agent adapter file is preserved. The one migration exception
is an exact generated Smithers 0.32 manifest: `init` updates that manifest and
any byte-identical immediately prior stock adapters while preserving customized
and older adapters. Use `--force` to replace existing generated files with the
current templates. `init` emits an actionable diagnostic when a preserved
adapter requires manual review.

## Validate

```bash
ultrafuzz validate [--project <path>] [--audit-profile <name>] \
  [--topology-path <path>] [--json]
```

Validation covers typed TOML config, `.ultrafuzz/topology.yml`, project prompt
copies, safe paths, reference nodes, agent references, and trusted local
execution posture. It does not launch agents.

## JSON Validate

```bash
ultrafuzz json validate \
  --schema <schema.json> \
  --file <artifact.json> \
  [--ref <local-schema.json>] \
  [--max-errors <1-1000>] \
  [--json]
```

This is a single-document validator, separate from project-wide `ultrafuzz
validate`. It uses strict Draft 2020-12 Ajv validation, standard formats, strict
UTF-8 and JSON parsing, duplicate-key rejection, offline local references, and
bounded worker execution. `--ref` may be repeated. No stdin, YAML, JSON5,
remote schema fetching, coercion, defaults, property removal, or repair is
supported.

The exit contract is:

| Exit | Meaning                                                                                               |
| ---: | ----------------------------------------------------------------------------------------------------- |
|    0 | The artifact conforms to the schema.                                                                  |
|    1 | The artifact is unreadable, malformed, has duplicate keys, or violates the schema.                    |
|    2 | Invocation, schema/reference loading, schema compilation, resource limits, or validator setup failed. |

Human-readable failures go to stderr. `--json` emits the standard
`ultrafuzz.cli.result.v2` envelope. Neither success nor failure changes the
schema or artifact bytes.

Checked-in artifact, eval, Modal, and topology schemas are loaded from composed
package-local registries. A registered schema whose filename or bytes differ
from its pinned entry is a setup failure. Successful JSON output reports
whether the schema was registered plus its fragment-free ID, schema SHA-256,
owning package's bundle SHA-256, validator build identity, and the artifact
SHA-256. These identities bind the producer command to the later host check;
they are not a mutable validation receipt.

For schema-backed producer tasks, Ultrafuzz places a run-owned trusted launcher
before target-controlled `PATH` entries and validates a real known-valid fixture
before model work. Modal uses a root-owned, read-only
`/usr/local/bin/ultrafuzz`. Missing, stale, shadowed, or tampered validator
identity is an exit-`2` setup failure, not a reason to use another binary or
edit the supplied schema.

Producer prompts display exact schema and contract validation commands for each
JSON output. The producer must run every command after its final write and
before returning; an exit `1` draft is corrected and rerun in the same session.
Once the session returns, the host checks the same bytes and then applies named
semantic/context gates. It never repairs, converts, normalizes, synthesizes, or
falls back to another artifact, and post-session shape failure is terminal
rather than a model retry.

## Artifact Validate

```bash
ultrafuzz artifact validate <contract-id> <artifact-path> [--json]
```

Use the contract ID and path declared in the rendered Ultrafuzz Output Contract.
The command applies the contract's registered JSON Schema and every
document-local semantic gate, reporting failures without modifying the file.
It does not authenticate workspace inputs or evaluate cross-artifact or run
context. The runtime performs those publication checks after the producer
finishes. Run `ultrafuzz artifact validate --help` for the current positional
arguments.

## Run

```bash
ultrafuzz run \
  [--project <path>] \
  [--run-id <id>] \
  [--input-json <strict-json> | --input-file <json-path>] \
  [--prompt <text>] \
  [--agent <agent-ref>] \
  [--model <model>] \
  [--audit-profile <name>] \
  [--topology-path <path>] \
  [--max-concurrency <n>] \
  [--json]
```

`--input-json` and `--input-file` are mutually exclusive. Inline input is
always strict RFC 8259 JSON and is never retried as a path after a parse error.
Relative file paths resolve from the project root. File input is read from one
bounded, non-symlink regular-file snapshot and is rejected if it changes
during the read. Both forms reject invalid UTF-8,
duplicate keys, malformed JSON, and non-finite numbers. Their application data
is explicitly operator-defined; Ultrafuzz validates that it is JSON but does
not infer, repair, normalize, or convert its domain shape. Model-only overrides
keep the configured agent and reasoning. When `--agent` selects another agent,
backend-specific reasoning is cleared, including when `--model` also pins a
replacement model.
`--max-concurrency` caps workflow task submission concurrency.
`--audit-profile` selects a profile for one command, while `--topology-path`
atomically replaces the project or profile topology for that command.

## Audit Profiles and Packaged Topologies

```bash
ultrafuzz config audit-profiles [--json]
ultrafuzz config audit-profile <name> [--project <path>] [--json]
ultrafuzz topology list [--json]
ultrafuzz topology show <name> [--json]
ultrafuzz topology copy <name> <project-relative-path> [--force] [--json]
```

Profile detail resolves against the selected project so explicit project
settings and topology overrides are visible. `topology copy` stays inside the
project, rejects symlink paths, and does not replace an existing file unless
`--force` is present.

Runs require pinned reference material to already be present in the local cache
when the topology uses reference nodes. Use `ultrafuzz references sync` as the
explicit network step before `run`.

## References

```bash
ultrafuzz references status [--project <path>] [--json]
ultrafuzz references sync [--project <path>] [--json]
ultrafuzz references update --latest [--project <path>] [--json]
```

`status` validates the reference catalog and digest-checked cache presence.
`sync` fetches pinned catalog entries into the local cache. `update` requires
`--latest` and rewrites `.ultrafuzz/references.yml` to current default-branch
SHAs.

## Run Lifecycle

```bash
ultrafuzz ps [--project <path>] [--json]
ultrafuzz inspect <run-id> [--project <path>] [--json]
ultrafuzz status <run-id> \
  [--project <path>] \
  [--window <minutes>] \
  [--watch] \
  [--interval <seconds>] \
  [--json]
ultrafuzz stats <run-id> [--project <path>] [--json]
ultrafuzz stats --bundle <report-bundle.zip> [--json]
ultrafuzz pause <run-id> [--project <path>] [--json]
ultrafuzz cancel <run-id> [--project <path>] [--json]
ultrafuzz why <run-id> [--project <path>] [--json]
ultrafuzz timeline <run-id> [--tree] [--project <path>] [--json]
ultrafuzz snapshots <run-id> [--project <path>] [--json]
ultrafuzz events <run-id> \
  [--node <node-id>] \
  [--type <category>] \
  [--since <duration>] \
  [--limit <n>] \
  [--watch] \
  [--interval <seconds>] \
  [--history] \
  [--project <path>] \
  [--json]
ultrafuzz node <run-id> <node-id> \
  [--iteration <n>] \
  [--attempts] \
  [--tools] \
  [--watch] \
  [--interval <seconds>] \
  [--project <path>] \
  [--json]
ultrafuzz resume <run-id> [--project <path>] [--max-concurrency <n>] \
  [--reset-node <workflow-node-id>] [--json]
ultrafuzz replay <run-id> [--project <path>] [--json]
ultrafuzz fork <run-id> \
  [--project <path>] \
  [--frame <n>] \
  [--reset-node <workflow-node-id>] \
  [--label <label>] \
  [--max-concurrency <n>] \
  [--json]
```

`status`, `pause`, `resume`, `replay`, and `fork` operate on the workflow run
linked from Ultrafuzz run metadata. `status` reports a concise health verdict
and maps workflow details into the stable Ultrafuzz JSON envelope.

Runs created before workflow control seals and authenticated link journals
cannot be resumed or inspected safely in place. Their stored artifacts remain
available, but lifecycle commands report the missing evidence and require a new
run ID rather than constructing a seal or link from mutable historical state.

`status` human output is watch-friendly:

```text
Run: <run-id>
Status: running-healthy (running)
Reason: 1 running, 2 finished in last 10m
Progress: 99% (262 finished / 1 running / 1 pending / 0 failed / 264 total)
ETA: 20 minutes
Time on current step: 10 minutes on stateful-invariant-campaign
Pace: 4 finished in the last 10m
```

`--watch` re-polls every `--interval` seconds (default 30) until the run
reaches a terminal state (`succeeded`, `failed`, `timed-out`, or `canceled`)
or the poll fails. With `--json --watch`, every poll writes one
newline-delimited `ultrafuzz.cli.result.v2` envelope so the stream pipes into
`jq` and other line-oriented tools; without `--watch`, `--json` keeps the
existing pretty-printed single envelope.

`stats` derives its snapshot on demand; it does not read or write a precomputed
statistics artifact. Local-run mode synchronizes linked workflow evidence when
available, then reads `attempts.jsonl`, `usage.jsonl`, `state.json`,
`graph.json`, `graph.fingerprint`, and `run.json` twice as one evidence set.
The command accepts the bytes only when both complete reads match, retries a
recognized mutation race at most three times, and timestamps the snapshot
immediately after the accepted second read. The table shows each node's status,
completed and currently elapsed execution time, token components, estimated
spend, model, and attempt count. JSON output uses `ultrafuzz.stats.v1` inside
the normal CLI envelope and additionally exposes retries, executed/reused
counts, outcomes, failure categories, completeness, unattributed usage, and
cumulative run accounting.

`stats --bundle` reads an `ultrafuzz report bundle` ZIP directly without
extracting it and without the original checkout, workflow backend, provider,
or network. It accepts only the registered
`ultrafuzz.report-bundle-manifest.v3` contract and validates the current run,
state, graph, graph-fingerprint, and ledger contracts against the manifest run
ID. The manifest creation time anchors live elapsed calculations and must not
precede any historical timestamp in the included state, attempts, usage, or
accounting evidence, or be later than the host statistics clock.

A genuinely absent attempt ledger produces a warning and unavailable attempt
counts and durations. A genuinely absent usage ledger produces warnings and
`null` usage; metadata cumulative accounting is also hidden because the
missing ledger cannot authenticate it. A local run that still claims
accounting after losing `usage.jsonl`, a present-but-empty usage ledger paired
with accounting, invalid UTF-8, duplicate JSON keys, malformed rows, duplicate
or conflicting ledger identities, cross-run rows, and aliased or duplicate ZIP
members fail the command. An `artifacts/` subtree by itself is not sufficient.

Bundle creation requires current sealed workflow authority, but manifest v3
does not archive `workflow-run-link-journal.json` or the sealed workflow
control files. Offline statistics therefore prove agreement among the bundled
workflow IDs, control generation, state provenance, graph tasks, and ledgers;
they cannot independently prove the historical backend link that originally
authorized those IDs. The v3 manifest is a snapshot contract, not a standalone
attestation of workflow-link history.

The JSON envelope carries stable machine-readable fields alongside the existing
counts:

- `progress`: `percent`, `finished`, `in_progress`, `pending`, `failed`,
  `skipped`, `remaining`, and `total`. `remaining` is every node that is not
  finished, failed, or skipped, and `percent` is the share of nodes that are
  settled, so it agrees with `remaining` reaching zero even when nodes failed
  or were skipped.
- `eta`: `available`, `seconds`, `basis`, and `unavailable_reason`. `basis` is
  `recent-throughput` when the recent activity window observed completions,
  `run-throughput` when only whole-run throughput is available, and
  `no-remaining-nodes` when nothing is left to run. `unavailable_reason` is
  `no-node-counts` (a live run whose snapshot reports no nodes),
  `no-finished-nodes`, `no-observed-elapsed-time`, `run-paused` (a paused run is
  deliberately not progressing), or `run-terminal`.
- `current_step`: `node_id`, `iteration`, `started_at`, `elapsed_seconds`, and
  `running_count`. Elapsed time comes from Ultrafuzz's synchronized durable
  `state.json` node timestamps, and the reported step is the longest-running
  one. `elapsed_seconds` is `null` when no running node has a recorded start.
  Nodes parked on an approval, event, timer, or controller handover are excluded
  — they are not executing, and `ultrafuzz why` explains those waits.

`progress` and `current_step` are denominated differently and can legitimately
disagree. `progress` counts the linked workflow's own tasks, which include
preparation and verification work that has no durable node, while
`current_step` counts durable Ultrafuzz nodes. Treat `progress` as campaign-wide
completion and `current_step` as what is executing right now.

`--watch` re-synchronizes linked workflow evidence on every poll, exactly as a
single `status` call does, so it is not a read-only command. It stops only at a
terminal run status or a failed poll: `paused` is a deliberate steady state, so
a watch on a paused run keeps polling until interrupted.

`pause` requests a graceful stop: no new tasks are scheduled, in-flight tasks
finish, and the run settles in the resumable `paused` state. `resume` reports
`submitted: false` instead of launching a duplicate continuation when the linked
workflow is still in an active state (running, in-progress, started, queued,
retrying, or waiting). `resume --reset-node` retries one failed workflow node and
its dependents in the same linked run; the applied reset is recorded so retrying
the command after a failed continuation resumes the already-reset run instead of
repeating the reset. `fork` may start from a checkpoint frame and may reset one
workflow node before starting the fork.

Every command in this section takes an Ultrafuzz run ID and resolves the linked
workflow run from existing product evidence; none of them require the
workflow-engine run ID.

`cancel` is terminal, unlike `pause`. The engine accepts a durable cancellation
request before the run actually stops, so `cancel` distinguishes the two: a
submitted request reports `cancel-requested` and leaves the product run
nonterminal, and a confirmed cancellation reports Ultrafuzz's canonical
terminal spelling `canceled` with its terminal timestamp. Rerunning `cancel`
after the run has already stopped converges on the confirmed result instead of
failing. Both outcomes append
distinct product events. Failures use the stable `WORKFLOW_CANCEL_FAILED`
diagnostic.

`why` returns a deterministic diagnosis: a summary, the current node, and typed
blockers with `kind`, `node_id`, `iteration`, `reason`, `unblocker`,
`waiting_since`, `attempt`, and `max_attempts`. Blocker kinds are
`waiting-approval`, `waiting-event`, `waiting-timer`, `retry-backoff`,
`retries-exhausted`, `dependency-failed`, `stale-heartbeat`, `engine-busy`,
`binding`, `side-effect-boundary`, and `other`. It synchronizes linked workflow
evidence first, matching single-run `status`, and `status` recommends it as the
next step.

`timeline` is read-only and returns `frames` with `frame`, `created_at`,
`content_hash`, and fork points. Pass a listed frame number to
`ultrafuzz fork <run-id> --frame <n>`. `--tree` adds forked runs recursively
under `lineage`, each with its own depth and frames.

`snapshots` is read-only and lists durability and workspace checkpoints with
`sequence`, `node_id`, `iteration`, `attempt`, `tier` (an integer durability
tier), `source`, `label`, and `created_at`. There is no `restore` or `rewind` command: those need separate
product-state and side-effect-boundary design.

`events` shows the **linked workflow** lifecycle log, which is distinct from
Ultrafuzz's own product evidence in `.ultrafuzz/runs/<run-id>/events.jsonl`. It
defaults to lifecycle events and never requests raw agent chunks. `--type` is
restricted to lifecycle categories (`approval`, `frame`, `memory`, `node`,
`revert`, `run`, `sandbox`, `scorer`, `snapshot`, `supervisor`, `timer`,
`workflow`); a raw agent or tool category is rejected with
`WORKFLOW_EVENTS_TYPE_UNSUPPORTED` rather than silently widening the view.
Without `--watch` it returns a bounded typed array with `limit` and
`truncated`;
`--limit` defaults to 200 and is capped at 2000. `--watch` streams new events
incrementally rather than buffering the run, printing one redacted event per
line in human mode and one newline-delimited `ultrafuzz.cli.result.v2` envelope
per event with `--json`. `--history` replays existing history before streaming.

`node` takes a workflow node ID as already reported by `ultrafuzz inspect`. It
returns node state, status, duration, attempt counts, agent/model identity, and
output metadata. Attempt and retry history requires `--attempts`. Tool
input/output payloads appear only with explicit `--tools` and pass through the
shared secret redaction helpers; node output itself is reported as metadata
only, never inlined. `--watch` follows the same bounded streaming and cleanup
contract as `events --watch`.

## Doctor

```bash
ultrafuzz doctor [--project <path>] [--json]
```

`doctor` is the operational superset of `validate`; `validate` keeps its
non-launching configuration contract unchanged. Doctor reports:

- config, topology, prompt, and reference validation posture;
- required topology backends, toolchain, and configured agent executable
  availability in the configured execution environment (the local `PATH` for
  local runs or a transient probe of the provider image for cloud runs);
- the bundled workflow engine version, the version the generated project
  requires, and the installed project-local version and bin target;
- npm's latest published stable engine version when the registry check is
  available;
- whether the installed dependency layout passes Ultrafuzz's exact
  manifest and path validation;
- whether required compatibility patches, or their upstream replacements, are
  present. A source carrying neither the patch nor the shape Ultrafuzz patches
  is reported as modified or incompatible, because the next run fails in that
  state.

Doctor does not create project run state or install, upgrade, or repair local
dependencies. For cloud execution, checking required commands may create the
configured provider app on first use and uses a transient sandbox so the probe
runs inside the same image as workflow nodes.

Diagnostics are stable: `DOCTOR_TOOLCHAIN_MISSING`,
`DOCTOR_TOOLCHAIN_PROBE_FAILED`,
`DOCTOR_WORKFLOW_ENGINE_MISSING`,
`DOCTOR_WORKFLOW_ENGINE_VERSION_MISMATCH`,
`DOCTOR_WORKFLOW_ENGINE_LAYOUT_INVALID`,
`DOCTOR_WORKFLOW_ENGINE_PATCHES_PENDING`,
`DOCTOR_WORKFLOW_ENGINE_PATCHES_INCOMPATIBLE`,
`DOCTOR_WORKFLOW_ENGINE_OUTDATED`, and `DOCTOR_REGISTRY_UNAVAILABLE`. A registry or network failure produces a
warning and an `unknown` latest version instead of failing an otherwise valid
offline project. Doctor never installs, mutates, or upgrades dependencies.

## Report

```bash
ultrafuzz report <run-id> [--project <path>] [--json]
```

`report` reads agent-written final report artifacts from:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

If run metadata contains populated cumulative accounting, `report --json`
emits diagnostics when `report.md` or `report.json.run_metadata` leaves
`Tokens used` or `Estimated spend` unavailable, non-positive, missing the
partial-pricing `+` marker, or greater than the current cumulative metadata.

## Materialize

```bash
ultrafuzz materialize <run-id> \
  --copy <run-relative-source:project-relative-destination> \
  [--project <path>] \
  [--yes | --confirm] \
  [--dry-run] \
  [--force] \
  [--json]
```

Materialization is copy-only. Each `--copy` source is relative to the run root,
and each destination is relative to the project root. Non-dry-run
materialization requires `--yes` or `--confirm`. `--force` allows overwriting an
existing file destination after path checks.

Patch artifacts may exist as evidence, but patch application is rejected until
a safe patch applier exists.

## Clean

```bash
ultrafuzz clean <run-id> \
  [--project <path>] \
  [--select <path-under-.ultrafuzz>] \
  [--yes | --confirm] \
  [--dry-run] \
  [--json]
```

Without `--select`, `clean` selects `runs/<run-id>`. Selections are relative to
`.ultrafuzz/` and must name generated run, artifact, or workspace directories.

## Dashboard

```bash
ultrafuzz dashboard \
  [--project <path>] \
  [--host 127.0.0.1] \
  [--port 3875] \
  [--run-id <run-id>] \
  [--no-live]
```

`dashboard` starts a local loopback server and prints the `/dashboard` URL. The
API reads and edits only beta product surfaces, validates mutating saves before
writing, and guards mutating requests with a per-session token.

## Eval

```bash
ultrafuzz eval plan \
  [--project <path>] \
  [--suite <suite-yaml-path>] \
  [--provider braintrust|none] \
  [--target-root <path>] \
  [--ground-truth-root <external-path>] \
  [--skip-target-validation] \
  [--json]
ultrafuzz eval run \
  [--project <path>] \
  [--suite <suite-yaml-path>] \
  [--provider braintrust|none] \
  [--eval-run-id <id>] \
  [--row <row-id>]... \
  [--target-root <path>] \
  [--ground-truth-root <external-path>] \
  [--watch-timeout-seconds <seconds>] \
  [--no-watch] \
  [--json]
ultrafuzz eval status <eval-run-id> \
  [--project <path>] \
  [--watch] \
  [--interval <seconds>] \
  [--json]
ultrafuzz eval score <eval-run-id> [--project <path>] [--llm-judge] [--json]
ultrafuzz eval report <eval-run-id> [--project <path>] [--json]
ultrafuzz eval compare <eval-run-id> --baseline <variant-id> [--project <path>] [--json]
ultrafuzz eval bundle <eval-run-id> --output <directory> [--project <path>] [--json]
ultrafuzz eval compare <candidate-eval-run-id> \
  --against <baseline-eval-run-id> \
  [--allow-incompatible] \
  [--project <path>] \
  [--json]
ultrafuzz eval analyze all \
  --input </external/private-handoff.zip> \
  --output </external/private-analysis-directory> \
  [--project <path>] \
  [--json]
ultrafuzz eval publish <eval-run-id> \
  [--project <path>] \
  [--provider braintrust] \
  [--resume] \
  [--json]
ultrafuzz eval history [eval-run-id] \
  [--project <path>] \
  [--history <history-json-path>] \
  [--charts <svg-directory>] \
  [--benchmark evmbench|ultrafuzz-bench] \
  [--lane smoke|full] \
  [--repository <public-repository-url>] \
  [--artifact <immutable-artifact-reference>] \
  [--publication-url <validated-result-url>] \
  [--check] \
  [--json]
```

`eval analyze` reads a finalized handoff ZIP directly. It accepts only the
current, closed benchmark-analysis contracts. The archive contains an exact
`handoff/current-state.json` member, optionally below one canonical top-level
directory. That document uses
`ultrafuzz.eval.adjudication-handoff.v1` and declares the exact adjudication
output path. The declared directory must contain these versioned documents:

- `finding-manifest.json` — `ultrafuzz.eval.finding-manifest.v1`, with typed row
  descriptors, explicit candidate labels/titles, explicit finding IDs and
  severities, and declared row archive/run metadata paths;
- `instance-to-cluster.json` — `ultrafuzz.eval.instance-clusters.v1`, with an
  `instances` array and explicit nullable match/duplicate fields; and
- `ground-truth-tp-credits.json` —
  `ultrafuzz.eval.ground-truth-credits.v1`, with a typed `clusters` array.

Each declared row archive and nested run metadata member is read by exact path.
Nested `run.json` must be `ultrafuzz.run-metadata.v2`, must identify the row's
declared `runId`, and must contain validated `accounting.cumulative` evidence.
The CLI rejects unmatched findings, rows, candidates, clusters or credits;
count drift; duplicate projected identities; inconsistent duplicate targets;
and duplicate-reference cycles before analysis.

Historical field names and shapes are not compatibility inputs. In particular,
`schemaVersion`, unversioned array/map payloads, candidate `heading`, lowercase
severity aliases, titles containing an inferred finding label, current-only
accounting, and malformed source references are rejected. The CLI does not
rewrite slashes, search ZIP/tar suffixes, supply metadata defaults, parse IDs
from titles, normalize severity, filter invalid rows/references, or repair a
document. A prior handoff must be regenerated against the current schemas.

Available report types are `all`, `upset` (`upsert` alias), `scores`
(`precision-recall-f1` alias), `provenance`, `table`, `cost`, and `pairwise`.
The pairwise chart connects matched Ultrafuzz/no-fuzz rows across ground-truth
TP credits, F1, and total tokens. Charts are written as PNG and editable SVG
alongside CSV, JSON, and Markdown reports. `provenance.json`,
`source_manifest.json`, and `analysis_manifest.json` are validated against
their current JSON Schemas and semantic joins before they are written.
Condition score summaries report the mean, median, and sample standard
deviation across the declared rows.

The input and output paths are required to be outside `--project`. Handoff
archives and generated reports may contain private target details,
ground-truth findings, and adjudication evidence; the CLI refuses to place
either inside the repository tree. Generated reports are private local
artifacts and must not be committed or published without a separate redaction
and disclosure review.

Eval suites benchmark the fuzzing pipeline against targets with known
ground-truth bugs. The experiment definition lives in a committable eval YAML
(default suite path from `[eval].eval_config`, overridable per command with
`--suite`); provider binding and credential env-var names live in the
`ultrafuzz.toml` `[eval]` section. Precedence for both is CLI flag > env
(`ULTRAFUZZ_EVAL_PROVIDER`, `ULTRAFUZZ_EVAL_CONFIG`) > `ultrafuzz.toml`.

`plan` validates config plus suite and prints the trial matrix without
launching workflows. By default it also validates local target checkouts (one
directory per target id under `--target-root`) against the pinned git refs;
`--skip-target-validation` skips that check.

`run` launches Ultrafuzz runs for matrix rows (all rows, or a `--row`
selection), polls them to a terminal state, and streams node telemetry to the
configured provider. `--no-watch` launches detached without polling or
telemetry streaming.

`status` reads the eval matrix, its latest `runs.jsonl` records, and each
linked durable `state.json` without synchronizing or changing workflow state.
Every matrix row remains present in matrix order. Labels are deterministic
opaque ordinals (`row-01`, `row-02`, …), including for private targets; neither
table nor JSON output represents target identities, repositories, paths, refs,
ground truth, findings, diagnostics, raw node output, provenance, or
configuration.

Progress is the count of durable nodes in `succeeded`, `failed`, `skipped`,
`timed-out`, `reused-from-prior-run`, or `invalidated` divided by all planned
nodes in durable state. The output always pairs available percentages with
their completed/total counts. ETA uses observed terminal-node throughput from
the durable workflow start through its latest checkpoint and is explicitly an
estimate because node runtimes differ. ETA is typed as unavailable when no
node has completed, timestamps are missing or invalid, or an incomplete row's
checkpoint is more than five minutes old. `--watch` refreshes the whole matrix
at the requested interval while at least one row is still pending, running,
paused, or not yet launched; typed invalid or inaccessible rows remain visible
without making the command poll forever. Combined with `--json`, watch mode
emits one schema-versioned JSON object per line.

`score` grades finished run reports against external ground truth resolved
under `[eval].ground_truth_root`, deterministically by default and with the
suite's judge model profile when `--llm-judge` is passed. The gateway judge
requires `ULTRAFUZZ_EVAL_JUDGE_API_KEY`; private targets additionally require
`ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA=true`. An optional
`ULTRAFUZZ_EVAL_JUDGE_URL` must be HTTPS without credentials, and redirects
are rejected. `report` shows the scored variant ranking. `compare` either
diffs variants against a `--baseline` variant or compares a candidate run to
an `--against` baseline run after verifying cohort identity, scoring identity,
and variant scope; `--allow-incompatible` is an explicit, reported waiver.

`bundle` derives a versioned, self-contained analysis directory from local
eval evidence. Its fixed allowlist contains aggregate terminal status,
evaluation metrics, accounting, and sanitized attempt history. Raw reports,
findings, diagnostics, configuration, and execution-local identifiers are not
representable in the bundle. Missing optional evidence is recorded in a typed
omission manifest.

`publish` replays a recorded eval run's journals from offset 0 and
reconstructs the full node trace on a provider post hoc; `--resume` continues
from the persisted publish cursor instead. Provider credentials are only
required at publish time, so `provider = "none"` keeps the local
plan → run → score → report → compare loop working offline.

`history` validates and regenerates deterministic public SVGs when no run ID is
given. With a run ID, it accepts only a complete, successfully scored generation
with immutable lineage, appends observations idempotently, and replaces history
and charts together. Append mode also requires the benchmark, lane, public
candidate repository, immutable source artifact, and publication URL flags.
`--check` compares the checked-in SVGs with a fresh in-memory render and
performs no writes.

Eval artifacts are written under `.ultrafuzz/evals/runs/<eval-run-id>/`. See
[Eval Suites](evals.md) for configuration, architecture, and telemetry policy
details.
