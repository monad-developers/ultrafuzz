# Configuration and Environment

`ultrafuzz.toml` resolves built-in defaults, prompt frontmatter, config file
values, environment variables, and CLI overrides.

## Common Shape

```toml
dynamic_strategies_enumerator = 3

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = 4
workspace_mode = "git-worktree"
enable_dashboard = true

[backend]
default = "codex-cli"

[triage]
quorum = 3
panel_size = 5

[invariants]
property_priority_threshold = "high"
invariant_testing_fuzzer_timeout = "1h"

[dashboard]
host = "127.0.0.1"
port = 3875
live_updates = true
```

## Model Profiles

```toml
[models]
default = "default"

[models.default]
backend = "codex-cli"
model = "gpt-5.5"
```

Profile IDs must use ASCII letters, digits, hyphen, underscore, or dot.

## Strategy Definitions

Strategy definitions can set model selection, enablement, category, loop count,
and timeout. Normal top-level strategy loop counts are controlled by topology
`defaults.strategy_loops`.

```toml
[strategies.encode-decode]
models = ["default"]
enabled = true
category = "encode-decode"
timeout_seconds = 1800
```

Runtime strategy categories are:

- `differential`
- `round-trip`
- `property-based`
- `encode-decode`
- `invariant`
- `custom`

## Environment Overrides

| Variable | Effect |
| --- | --- |
| `ULTRAFUZZ_BACKEND` | Overrides `[backend].default`. |
| `ULTRAFUZZ_MAX_PARALLEL_AGENTS` | Overrides `[run].max_parallel_agents`. |
| `ULTRAFUZZ_OUTPUT_DIR` | Overrides `[run].output_dir`. |
| `ULTRAFUZZ_KEEP_WORKSPACES` | Keeps isolated attempt workspaces for inspection. |

## Sensitive Defaults

The default permission policy denies reads from sensitive paths and patterns,
including `.env`, `.env.*`, `secrets/**`, `.secrets/**`, `.ssh/**`, `.aws/**`,
`.gcloud/**`, `.azure/**`, `*.pem`, and `*.key`. Files named `.env.example`
are treated as non-secret template exceptions for the broad `.env.*` defaults;
exact `.env.example` entries in project policy still deny them.

Backend attempts fail closed when a denied read pattern exists under a
backend-visible root such as the attempt workspace, artifact directory, or
extra context directory. Read-deny scanning follows symlinks that stay under
the visible root and rejects symlinks that escape it. `permissions.write_allow`
currently supports the backend roots `workspace`, `artifacts`, `extra-context`,
and `final-materialization`; unknown or stricter write policies are rejected
when Ultrafuzz cannot enforce them. Codex extra context directories require the
`extra-context` write entry because Codex exposes them with `--add-dir`.

Backend commands are constrained to the executable for their backend kind
(`codex` for `codex-cli`, `claude` for `claude-code-cli`). Config-supplied
backend and model env rejects process loader, shell startup, path, git, and
backend config-directory keys by default. Dangerous sandbox arguments and Codex
`-c` / `--config` sandbox, network, permission, or approval overrides are also
rejected unless `permissions.allow_dangerous_bypass = true` is explicitly set;
this includes Codex web-search overrides, `--search`, `--yolo`, and config
layering through `--profile` / `-p`.
