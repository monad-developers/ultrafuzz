# Configure Backends and Models

Ultrafuzz resolves built-in defaults, `ultrafuzz.toml`, environment variables,
and CLI overrides into one typed campaign config.

## Inspect The Effective Config

```bash
ultrafuzz config inspect
ultrafuzz config defaults
```

`config inspect` and run artifact `resolved-config.toml` output redact backend
and model-profile environment values by default while keeping environment key
names visible for diagnosis. Only these explicitly non-secret diagnostic keys
keep their configured values: `CI`, `NO_COLOR`, `RUST_BACKTRACE`, and
`RUST_LOG`. Sensitive key names and known token-looking values are still
redacted even under those keys.

For `restart` and `continue`, Ultrafuzz restores redacted backend and
model-profile env values from the current project config before executing the
new run. If a source run references a redacted env key that is no longer present
in `ultrafuzz.toml`, restart fails with an explicit restore-the-value error
instead of running with the literal `<redacted>` placeholder.

## Choose The Default Backend

Edit `ultrafuzz.toml`:

```toml
[backend]
default = "codex-cli"
```

Check it:

```bash
ultrafuzz doctor --backend codex-cli
```

For a single run:

```bash
ultrafuzz run --backend codex-cli
```

## Define Model Profiles

Model profiles are provenance IDs. The profile `backend` selects the CLI runner,
and `model` is passed to that CLI unless the profile's base args already set a
model.

```toml
[models]
default = "gpt-5-5"

[models.gpt-5-5]
backend = "codex-cli"
model = "gpt-5.5"

[models.claude-4-6]
backend = "claude-code-cli"
model = "claude-4.6"
```

Assign profiles to a strategy override table:

```toml
[strategies.encode-decode]
models = ["gpt-5-5", "claude-4-6"]
enabled = true
```

If a strategy omits `models`, it uses the configured default profile.

## Backend Trust Boundary

Leave backend commands at their defaults unless you intentionally opt into the
dangerous bypass mode:

```toml
[backend.codex_cli]
command = "codex"

[backend.claude_code_cli]
command = "claude"
```

Config-supplied backend or model env can set ordinary provider/model knobs, but
loader, shell-startup, path, git, and backend config-directory variables are
rejected by default. Codex `-c` / `--config` entries that override sandbox,
network, permission, or approval policy are also rejected, as are Codex
`--search`, `--profile`, and `--yolo`, unless
`permissions.allow_dangerous_bypass = true` is explicitly set.

Codex extra context directories are passed with `--add-dir`, which makes those
directories writable in workspace-write mode. If a run uses extra context
directories, add `extra-context` to `permissions.write_allow` intentionally or
Ultrafuzz will fail closed before launching the backend.

## Override Parallelism

```toml
[run]
max_parallel_agents = 4
```

For one run or restart:

```bash
ultrafuzz run --max-parallel-agents 4
ultrafuzz restart <run-id> --max-parallel-agents 8
```

## Use Environment Overrides

Supported environment overrides:

```text
ULTRAFUZZ_BACKEND
ULTRAFUZZ_MAX_PARALLEL_AGENTS
ULTRAFUZZ_OUTPUT_DIR
ULTRAFUZZ_KEEP_WORKSPACES
```

Use `ultrafuzz config inspect` after setting them to verify the final config.

## Tune Campaign-Specific Counts

Dynamic strategy enumeration:

```toml
dynamic_strategies_enumerator = 3
```

```bash
ultrafuzz run --dynamic-strategies-enumerator 5
```

Triage adjudication:

```toml
[triage]
quorum = 3
panel_size = 5
```

```bash
ultrafuzz run --triage-quorum 4 --triage-panel-size 7
```

Invariant implementation:

```toml
[invariants]
property_priority_threshold = "high"
invariant_testing_fuzzer_timeout = "1h"
```

```bash
ultrafuzz run --invariant-property-priority-threshold medium
ultrafuzz run --invariant-testing-fuzzer-timeout 45min
```
