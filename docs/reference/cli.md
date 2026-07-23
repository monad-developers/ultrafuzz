# CLI Commands

The CLI binary is `ultrafuzz`.

Every command accepts `--project <path>`. Commands that support automation
accept `--json` and emit the `ultrafuzz.cli.result.v1` envelope.

## Commands

| Command                          | Purpose                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ultrafuzz init`                 | Create root config plus `.ultrafuzz/**` product surfaces and workflow plumbing.                                |
| `ultrafuzz validate`             | Validate config, topology, prompts, path guards, agent references, and trust posture without launching agents. |
| `ultrafuzz run`                  | Validate, render prompts, build run evidence, compile a workflow, and launch a linked workflow run.            |
| `ultrafuzz references status`    | Report whether pinned references are present in the local digest-checked cache.                                |
| `ultrafuzz references sync`      | Explicitly fetch pinned references into the local cache.                                                       |
| `ultrafuzz references update`    | Rewrite the project reference catalog to newer pinned commits when requested.                                  |
| `ultrafuzz ps`                   | List Ultrafuzz runs and linked workflow status.                                                                |
| `ultrafuzz inspect <run-id>`     | Show product evidence and linked workflow details for a run.                                                   |
| `ultrafuzz status <run-id>`      | Show a concise health verdict, progress counts, throughput, and gating nodes.                                  |
| `ultrafuzz pause <run-id>`       | Gracefully pause an active run after its in-flight tasks finish.                                               |
| `ultrafuzz resume <run-id>`      | Delegate resume for the linked workflow run after product checks.                                              |
| `ultrafuzz replay <run-id>`      | Delegate replay for the linked workflow run after product checks.                                              |
| `ultrafuzz fork <run-id>`        | Delegate fork for the linked workflow run after product checks.                                                |
| `ultrafuzz report <run-id>`      | Locate the agent-written final report artifacts.                                                               |
| `ultrafuzz materialize <run-id>` | Copy selected reviewed outputs into the target project after confirmation and path checks.                     |
| `ultrafuzz clean <run-id>`       | Remove selected generated `.ultrafuzz/**` paths after confirmation and path checks.                            |
| `ultrafuzz dashboard`            | Serve the local loopback dashboard and API for product state inspection and editing.                           |
| `ultrafuzz eval plan`            | Dry-run an eval suite matrix without launching workflows.                                                      |
| `ultrafuzz eval run`             | Launch Ultrafuzz runs for an eval suite matrix and stream node telemetry.                                      |
| `ultrafuzz eval status <id>`     | Show disclosure-safe node progress and ETA for every row in an eval matrix.                                    |
| `ultrafuzz eval score <id>`      | Score finished eval run reports against external ground truth.                                                 |
| `ultrafuzz eval report <id>`     | Show the scored eval run variant ranking.                                                                      |
| `ultrafuzz eval compare <id>`    | Compare scored eval variants against a baseline variant.                                                       |
| `ultrafuzz eval analyze <type>`  | Generate private offline tables, provenance, score, intersection, and cost reports from a finalized handoff.   |
| `ultrafuzz eval history [id]`    | Validate/render public eval history, or append one complete scored run.                                        |
| `ultrafuzz eval publish <id>`    | Replay a recorded eval run's node telemetry to the configured provider.                                        |

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
  "schema_version": "ultrafuzz.cli.result.v1",
  "command": "validate",
  "ok": true,
  "diagnostics": [],
  "data": {}
}
```

Machine consumers should read `ok`, `diagnostics`, and `data`.

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

Without `--force`, existing config, topology, prompts, and reference catalog
files are preserved.

## Validate

```bash
ultrafuzz validate [--project <path>] [--json]
```

Validation covers typed TOML config, `.ultrafuzz/topology.yml`, project prompt
copies, safe paths, reference nodes, agent references, and trusted local
execution posture. It does not launch agents.

## Run

```bash
ultrafuzz run \
  [--project <path>] \
  [--run-id <id>] \
  [--input <json-or-path>] \
  [--prompt <text>] \
  [--agent <agent-ref>] \
  [--model <model>] \
  [--max-concurrency <n>] \
  [--json]
```

`--input` accepts inline JSON or a project-relative JSON file path. Model-only
overrides keep the configured agent and reasoning. When `--agent` selects
another agent, backend-specific reasoning is cleared, including when `--model`
also pins a replacement model.
`--max-concurrency` caps workflow task submission concurrency.

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
ultrafuzz status <run-id> [--project <path>] [--window <minutes>] [--json]
ultrafuzz pause <run-id> [--project <path>] [--json]
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
and maps workflow details into the stable Ultrafuzz JSON envelope. `pause`
requests a graceful stop: no new tasks are scheduled, in-flight tasks finish,
and the run settles in the resumable `paused` state. `resume` reports
`submitted: false` instead of
launching a duplicate continuation when the linked workflow is still in an
active state (running, in-progress, started, queued, retrying, or waiting).
`resume --reset-node` retries one failed workflow node and its dependents in
the same linked run; the applied reset is recorded so retrying the command
after a failed continuation resumes the already-reset run instead of repeating
the reset. `fork` may start from a checkpoint frame and may reset one workflow
node before starting the fork.

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
  [--provider braintrust|langsmith|none] \
  [--target-root <path>] \
  [--ground-truth-root <external-path>] \
  [--skip-target-validation] \
  [--json]
ultrafuzz eval run \
  [--project <path>] \
  [--suite <suite-yaml-path>] \
  [--provider braintrust|langsmith|none] \
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
  [--provider braintrust|langsmith] \
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

`eval analyze` reads a finalized handoff ZIP directly and discovers its
adjudication output through `handoff/current-state.json`. Available report
types are `all`, `upset` (`upsert` alias), `scores`
(`precision-recall-f1` alias), `provenance`, `table`, `cost`, and `pairwise`.
The pairwise chart connects matched Ultrafuzz/no-fuzz rows across ground-truth
TP credits, F1, and total tokens. Charts are written as PNG and editable SVG
alongside CSV, JSON, and Markdown reports. Condition score summaries report
the mean, median, and sample standard deviation across completed rows.

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
