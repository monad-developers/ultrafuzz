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
| `ultrafuzz resume <run-id>`      | Delegate resume for the linked workflow run after product checks.                                              |
| `ultrafuzz replay <run-id>`      | Delegate replay for the linked workflow run after product checks.                                              |
| `ultrafuzz fork <run-id>`        | Delegate fork for the linked workflow run after product checks.                                                |
| `ultrafuzz report <run-id>`      | Locate the agent-written final report artifacts.                                                               |
| `ultrafuzz materialize <run-id>` | Copy selected reviewed outputs into the target project after confirmation and path checks.                     |
| `ultrafuzz clean <run-id>`       | Remove selected generated `.ultrafuzz/**` paths after confirmation and path checks.                            |

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

`--input` accepts inline JSON or a project-relative JSON file path. `--agent`
and `--model` override the configured default model profile for the launched
workflow. `--max-concurrency` caps workflow task submission concurrency.

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
ultrafuzz resume <run-id> [--project <path>] [--max-concurrency <n>] [--json]
ultrafuzz replay <run-id> [--project <path>] [--json]
ultrafuzz fork <run-id> \
  [--project <path>] \
  [--frame <n>] \
  [--reset-node <workflow-node-id>] \
  [--label <label>] \
  [--max-concurrency <n>] \
  [--json]
```

`resume`, `replay`, and `fork` operate on the workflow run linked from
Ultrafuzz run metadata. `fork` may start from a checkpoint frame and may reset
one workflow node before starting the fork.

## Report

```bash
ultrafuzz report <run-id> [--project <path>] [--json]
```

`report` reads agent-written final report artifacts from:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

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
