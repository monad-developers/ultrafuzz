# Contributing

This repository is a Rust workspace for Ultrafuzz.

## Repository Map

Workspace crates live under `crates/`:

- `ultrafuzz-core`: shared IDs, statuses, findings, backend/workspace enums.
- `ultrafuzz-config`: config loading, defaults, overrides, validation, and
  redaction.
- `ultrafuzz-prompts`: bundled and project Markdown prompts, frontmatter,
  template validation/rendering, and prompt scaffolding.
- `ultrafuzz-topology`: `.ultrafuzz/topology.yml` loading, validation, loop
  expansion, graph serialization, and fingerprints.
- `ultrafuzz-artifacts`, `ultrafuzz-events`, `ultrafuzz-state`, and
  `ultrafuzz-workspace`: run layout, event stores, restartable state, and
  isolated workspaces.
- `ultrafuzz-agent`, `ultrafuzz-executor`, `ultrafuzz-dashboard`, and
  `ultrafuzz-cli`: backend subprocesses, DAG execution, local dashboard, and
  CLI.

Bundled prompt defaults live in `prompts/`. Initialized target projects get
editable copies under `.ultrafuzz/prompts/`.

The dashboard frontend lives in:

```text
crates/ultrafuzz-dashboard/frontend
```

## Development Stance

Prefer typed domain structs and serde forms over stringly typed logic. Parse and
validate data at boundaries: config, topology YAML, prompt frontmatter,
dashboard requests, artifact manifests, and backend outputs.

Do not add runtime fallbacks that synthesize missing product state. `ultrafuzz
init` may scaffold topology, but run and dashboard paths should fail clearly if
required topology is missing or invalid.

Keep generated artifacts out of git, including:

```text
site/
.cargo-home/
.cargo-target/
.codex-runs/
.ultrafuzz/
crates/ultrafuzz-dashboard/frontend/dist/
crates/ultrafuzz-dashboard/frontend/playwright-report/
crates/ultrafuzz-dashboard/frontend/test-results/
node_modules/
```

## Checks

Use the commands in [Development Commands](reference/development.md). Prefer the
narrowest useful check while iterating, then run broader gates before PR
handoff when the change touches shared behavior or release workflows.
