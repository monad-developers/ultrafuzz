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
| `resume <run-id>`      | Resume a linked run after product checks.                                                                                 |
| `replay <run-id>`      | Replay a linked run after product checks.                                                                                 |
| `fork <run-id>`        | Fork a linked run after product checks.                                                                                   |
| `report <run-id>`      | Show the agent-written final report artifact.                                                                             |
| `materialize <run-id>` | Copy selected outputs into the project after confirmation and path checks.                                                |
| `clean <run-id>`       | Remove selected generated paths after confirmation and path checks.                                                       |
| `dashboard`            | Serve the local loopback dashboard and API.                                                                               |

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

Agent and model flags override the default Ultrafuzz model profile for the
launched workflow.

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
