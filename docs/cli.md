# Ultrafuzz CLI

Every command accepts `--project <path>`. Commands that support automation
accept `--json` and emit the `ultrafuzz.cli.result.v1` envelope.

| Command                | Purpose                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `init`                 | Create project config/topology, pinned references, `.ultrafuzz/**` run surfaces, editable prompts, and workflow plumbing. |
| `validate`             | Validate config, topology, prompts, safe paths, trust posture, and agent references.                                      |
| `run`                  | Plan, render prompts, launch a fuzzing workflow, and persist product evidence.                                            |
| `references status`    | Show whether pinned references are present in the local digest-checked cache.                                             |
| `references sync`      | Explicitly fetch pinned references into the local cache.                                                                  |
| `references update`    | Rewrite the project reference catalog to current default-branch SHAs with `--latest`.                                     |
| `ps`                   | List Ultrafuzz runs with linked workflow status.                                                                          |
| `inspect <run-id>`     | Show product evidence and linked workflow details for a run.                                                              |
| `status <run-id>`      | Show a concise health verdict, progress, throughput, and gating nodes.                                                    |
| `pause <run-id>`       | Gracefully pause a running workflow after in-flight tasks finish.                                                         |
| `resume <run-id>`      | Resume a linked run after product checks.                                                                                 |
| `replay <run-id>`      | Replay a linked run after product checks.                                                                                 |
| `fork <run-id>`        | Fork a linked run after product checks.                                                                                   |
| `report <run-id>`      | Show the agent-written final report artifact.                                                                             |
| `materialize <run-id>` | Copy selected outputs into the project after confirmation and path checks.                                                |
| `clean <run-id>`       | Remove selected generated paths after confirmation and path checks.                                                       |
| `dashboard`            | Serve the local loopback dashboard and API.                                                                               |
| `eval plan`            | Dry-run an eval suite matrix without launching workflows.                                                                 |
| `eval run`             | Launch runs for an eval suite matrix and stream node telemetry to the configured provider.                                |
| `eval score <id>`      | Score finished eval run reports against external ground truth, optionally with `--llm-judge`.                             |
| `eval report <id>`     | Show the scored eval run variant ranking.                                                                                 |
| `eval compare <id>`    | Compare scored eval variants against a `--baseline` variant.                                                              |
| `eval publish <id>`    | Replay a recorded eval run's node telemetry to a provider post hoc.                                                       |

The dashboard/API is a local operator surface over product state, not a
workflow-engine API.

`init` may create implementation plumbing for the workflow adapter. That
plumbing is not an end-user API. User-owned configuration, prompts, topology,
references, run evidence, and materialized outputs remain under root
`ultrafuzz.toml`, `.ultrafuzz/**`, and reviewed project files.

## Run Flags

- `--run-id <id>`
- `--input <json-or-path>`
- `--prompt <text>`
- `--agent <agent-ref>`
- `--model <model>`
- `--max-concurrency <n>`
- `--json`

Model-only overrides keep the configured agent and reasoning. When `--agent`
selects another agent, backend-specific reasoning is cleared, including when
`--model` also pins a replacement model.

## Run Lifecycle

- `status <run-id> [--window <minutes>]` shows whether a run is healthy,
  blocked, stalled, quota-parked, paused, or finished.
- `pause <run-id>` stops new task scheduling and lets in-flight work settle
  before the run becomes `paused`.
- `resume <run-id>` continues a paused run using the existing linked workflow.

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

`eval plan | run | score | report | compare | publish` drive eval suites that
benchmark the pipeline against targets with known ground-truth bugs. The suite
YAML (default from `[eval].eval_config`, overridable with `--suite`) defines
the experiment; the `ultrafuzz.toml` `[eval]` section binds the reporting
provider (`braintrust | langsmith | none`) and credential env-var names.
Common flags:

- `--suite <suite-yaml-path>` (plan, run)
- `--provider <name>` (plan, run, publish)
- `--target-root <path>` (plan, run)
- `--row <row-id>` (run, repeatable)
- `--no-watch` (run)
- `--llm-judge` (score)
- `--baseline <variant-id>` (compare, required)
- `--resume` (publish)

Artifacts land under `.ultrafuzz/evals/runs/<eval-run-id>/`. See
[Eval Suites](reference/evals.md) and the
[CLI reference](reference/cli.md#eval) for full details.

## JSON Envelope

```json
{
  "schema_version": "ultrafuzz.cli.result.v1",
  "command": "validate",
  "ok": true,
  "diagnostics": [],
  "data": {}
}
```

Machine consumers should read `ok`, `diagnostics`, and `data`; human text is
not the stable automation contract.
