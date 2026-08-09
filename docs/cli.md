# Ultrafuzz CLI

Every command accepts `--project <path>`. Commands that support automation
accept `--json` and emit the `ultrafuzz.cli.result.v2` envelope.

| Command                   | Purpose                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `init`                    | Create project config/topology, pinned references, `.ultrafuzz/**` run surfaces, editable prompts, and workflow plumbing. |
| `validate`                | Validate config, topology, prompts, safe paths, trust posture, and agent references.                                      |
| `json validate`           | Validate one JSON document against a strict Draft 2020-12 schema without modifying either file.                           |
| `run`                     | Plan, render prompts, launch a fuzzing workflow, and persist product evidence.                                            |
| `references status`       | Show whether pinned references are present in the local digest-checked cache.                                             |
| `references sync`         | Explicitly fetch pinned references into the local cache.                                                                  |
| `references update`       | Rewrite the project reference catalog to current default-branch SHAs with `--latest`.                                     |
| `ps`                      | List Ultrafuzz runs with linked workflow status.                                                                          |
| `inspect <run-id>`        | Show product evidence and linked workflow details for a run.                                                              |
| `status <run-id>`         | Show a concise health verdict, progress, ETA, current-step duration, throughput, and gating nodes.                        |
| `pause <run-id>`          | Gracefully pause a running workflow after in-flight tasks finish.                                                         |
| `why <run-id>`            | Diagnose why a run is blocked, paused, quota-parked, waiting, or unable to progress.                                      |
| `timeline <run-id>`       | Show checkpoint frames and fork lineage, with the frame numbers `fork --frame` accepts.                                   |
| `events <run-id>`         | Show linked workflow lifecycle events, optionally streaming with `--watch`.                                               |
| `node <run-id> <node-id>` | Show one workflow node's status, attempts, retries, timing, and output metadata.                                          |
| `snapshots <run-id>`      | List durability and workspace checkpoints for recovery and time-travel diagnosis.                                         |
| `cancel <run-id>`         | Cancel an active run; cancellation is terminal, unlike pause.                                                             |
| `doctor`                  | Report validation, toolchain, and pinned workflow engine install posture.                                                 |
| `resume <run-id>`         | Resume a linked run after product checks.                                                                                 |
| `replay <run-id>`         | Replay a linked run after product checks.                                                                                 |
| `fork <run-id>`           | Fork a linked run after product checks.                                                                                   |
| `report <run-id>`         | Show the agent-written final report artifact.                                                                             |
| `materialize <run-id>`    | Copy selected outputs into the project after confirmation and path checks.                                                |
| `clean <run-id>`          | Remove selected generated paths after confirmation and path checks.                                                       |
| `dashboard`               | Serve the local loopback dashboard and API.                                                                               |
| `eval plan`               | Dry-run an eval suite matrix without launching workflows.                                                                 |
| `eval run`                | Launch runs for an eval suite matrix and stream node telemetry to the configured provider.                                |
| `eval status <id>`        | Show disclosure-safe node progress and ETA for every row in an eval matrix.                                               |
| `eval score <id>`         | Score finished eval run reports against external ground truth, optionally with `--llm-judge`.                             |
| `eval report <id>`        | Show the scored eval run variant ranking.                                                                                 |
| `eval compare <id>`       | Compare scored eval variants against a `--baseline` variant.                                                              |
| `eval analyze <type>`     | Generate private offline benchmark analysis from a finalized handoff ZIP.                                                 |
| `eval history [id]`       | Validate/render public eval history, or append one complete scored run.                                                   |
| `eval publish <id>`       | Replay a recorded eval run's node telemetry to a provider post hoc.                                                       |

The dashboard/API is a local operator surface over product state, not a
workflow-engine API.

`init` may create implementation plumbing for the workflow adapter. That
plumbing is not an end-user API. User-owned configuration, prompts, topology,
references, run evidence, and materialized outputs remain under root
`ultrafuzz.toml`, `.ultrafuzz/**`, and reviewed project files.

## Run Flags

- `--run-id <id>`
- `--input-json <strict-json>`
- `--input-file <json-path>`
- `--prompt <text>`
- `--agent <agent-ref>`
- `--model <model>`
- `--max-concurrency <n>`
- `--json`

Model-only overrides keep the configured agent and reasoning. When `--agent`
selects another agent, backend-specific reasoning is cleared, including when
`--model` also pins a replacement model.

`--input-json` and `--input-file` are mutually exclusive. Inline input is
always parsed as strict RFC 8259 JSON and is never reinterpreted as a path.
Relative file input is resolved from the project root, then read once from a
bounded, non-symlink regular-file snapshot.
Duplicate keys, invalid UTF-8, malformed JSON, symlinks, nonregular files, and
files that change during the read are rejected. Ultrafuzz does not infer or
normalize the application-defined operator payload.

## JSON Schema Validation

```bash
ultrafuzz json validate \
  --schema /absolute/path/to/schema.json \
  --file /absolute/path/to/artifact.json \
  [--ref /absolute/path/to/local-ref.json] \
  [--max-errors 50] \
  [--json]
```

The command accepts Draft 2020-12 JSON Schema and RFC 8259 JSON only. It rejects
invalid UTF-8, duplicate object keys, remote references, schema traversal, and
symlinked schema or artifact files. `--ref` is repeatable for explicit local
schema dependencies; bundled schema references resolve from Ultrafuzz's pinned
offline registry.

Exit `0` means the document conforms to the schema. Exit `1` means the artifact
is missing, malformed, or violates the schema and should be corrected by its
author. Exit `2` means invocation, schema, reference, resource, or validator
setup failed. Validation never repairs, normalizes, coerces, or rewrites the
document. `--json` uses the usual `ultrafuzz.cli.result.v2` envelope.

## Run Lifecycle

- `status <run-id> [--window <minutes>] [--watch] [--interval <seconds>]`
  shows whether a run is healthy, blocked, stalled, quota-parked, paused, or
  finished, plus node progress, an ETA, and how long the current step has been
  running. Progress counts every settled node, so failed and skipped nodes
  advance the percentage instead of pinning it below 100%. Progress counts
  linked workflow tasks while the current step counts durable Ultrafuzz nodes,
  so the two can legitimately disagree. `--watch` refreshes
  every `--interval` seconds (default 30) until the run is terminal; with
  `--json` each poll is one newline-delimited `ultrafuzz.cli.result.v2`
  envelope.
- `pause <run-id>` stops new task scheduling and lets in-flight work settle
  before the run becomes `paused`.
- `resume <run-id>` continues a paused run using the existing linked workflow.
- `cancel <run-id>` halts a run for good. A submitted request reports
  `cancel-requested`; a confirmed cancellation records the canonical terminal
  `canceled` state.
- `why <run-id>` explains what is blocking a run, with typed blockers and the
  action that unblocks each one.
- `timeline <run-id> [--tree]` lists checkpoint frames to pass to
  `fork --frame <n>`, plus fork lineage.
- `snapshots <run-id>` lists durability and workspace checkpoints.
- `events <run-id> [--watch] [--interval <seconds>]` shows the **linked
  workflow** lifecycle log, which is separate from Ultrafuzz's product
  `events.jsonl`.
- `node <run-id> <node-id> [--attempts] [--tools] [--watch]` shows one
  workflow node's status, retries, timing, and output metadata. Tool payloads
  require explicit `--tools`.
- `doctor` reports validation, toolchain, and pinned workflow engine install
  posture without changing anything. It is the operational superset of
  `validate`.

## Reference Commands

`init` writes `.ultrafuzz/references.yml`, a pinned catalog of property-writing
references. Normal runs do not fetch from the network; reference nodes read only
from the local cache and fail before launch if required cached files or digests
are missing.

- `references status`
- `references sync`
- `references update --latest`

Use `references sync` as the explicit network step after init or after an
intentional catalog update. The cache stores files under
`${XDG_CACHE_HOME:-$HOME/.cache}/ultrafuzz/references` with a digest manifest;
run artifacts receive normalized Markdown handoffs plus
`references/manifest.json`.

## Materialize Flags

- `--copy <source:destination>`
- `--yes` or `--confirm`
- `--dry-run`
- `--force`

Patch artifacts are not materialized until Ultrafuzz can apply them safely. Use
explicit `--copy` selections for files you have reviewed.

## Eval Commands

`eval plan | run | status | score | report | compare | bundle | analyze | history | publish` drive eval suites that
benchmark the pipeline against targets with known ground-truth bugs. The suite
YAML (default from `[eval].eval_config`, overridable with `--suite`) defines
the experiment; the `ultrafuzz.toml` `[eval]` section binds the reporting
provider (`braintrust | none`) and credential env-var names.
Common flags:

- `--suite <suite-yaml-path>` (plan, run)
- `--provider <name>` (plan, run, publish)
- `--target-root <path>` (plan, run)
- `--ground-truth-root <external-path>` (plan, run)
- `--row <row-id>` (run, repeatable)
- `--watch-timeout-seconds <seconds>` (run)
- `--no-watch` (run)
- `--watch` and `--interval <seconds>` (status)
- `--llm-judge` (score)
- `--baseline <variant-id>` (compare variants within one run)
- `--against <eval-run-id>` (compare releases with compatible lineage)
- `--allow-incompatible` (explicitly waive release provenance mismatches)
- `--output <directory>` (bundle, required)
- `--input <external-handoff.zip>` and `--output <external-directory>`
  (`analyze`, both required and refused inside the project repository)
- `--history <path>` and `--charts <directory>` (history)
- `--publication-url <url>` (history source bundle location, required when appending)
- `--check` (history validation without writes)
- `--resume` (publish)

Artifacts land under `.ultrafuzz/evals/runs/<eval-run-id>/`. See
[Eval Suites](reference/evals.md) and the
[CLI reference](reference/cli.md#eval) for full details.

`eval status <eval-run-id>` is observational: it reads the entire matrix and
linked durable state without synchronizing or changing any run. It uses
deterministic opaque row labels in table and JSON output, counts every terminal
node disposition as completed, and reports ETA as unavailable when completion
or fresh timing evidence is insufficient.

`eval bundle` exports only fixed-schema aggregate evidence for offline
analysis. The self-contained directory is checksum-verified and excludes raw
reports and execution-local data.

`eval analyze all` reads an already-finalized private benchmark handoff and
generates CSV, JSON, Markdown, PNG, and editable SVG reports. Score summaries
include the mean, median, and sample standard deviation across declared rows.
The handoff, finding manifest, instance clusters, ground-truth credits, and
nested run metadata must use their exact current versioned schemas. Row archive
and nested `run.json` members are read only at their declared paths, and cost
comes only from validated run-metadata v2 `accounting.cumulative` evidence.
Historical field names, unversioned array/map shapes, severity aliases, title
parsing, path rewriting, missing-field defaults, malformed-row filtering, and
current-accounting fallback are not supported. Regenerate older handoffs; the
command does not convert or repair them. Generated provenance and source/output
manifests are schema- and semantics-validated before writing.
Individual report commands are `upset`, `scores`, `provenance`, `table`, and
`cost`, plus `pairwise` for matched Ultrafuzz/no-fuzz row comparisons;
`upsert` and `precision-recall-f1` are compatibility aliases. Because the
source and output may contain private target and ground-truth details, both
paths must remain outside the repository and generated analysis must not be
committed.

## JSON Envelope

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

Machine consumers should read `ok`, `diagnostics`, and `data`; human text is
not the stable automation contract. Version 2 is intentionally breaking: each
known command has a closed, command-specific `data` schema, diagnostics expose
only their public fields, and unknown invocation failures can emit only
`ok: false` with `data: null`. The only deliberately opaque JSON values are
explicit operator workflow input and redacted third-party tool input/output.
There is no version-1 compatibility reader or automatic conversion.
