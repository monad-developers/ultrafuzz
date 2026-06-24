# First Campaign

This tutorial takes a protocol repository from first Ultrafuzz initialization
through dashboard and report review.

## Prerequisites

You need:

- A local checkout of this Ultrafuzz repository.
- A Solidity target repository you can modify locally.
- Rust and Cargo installed.
- At least one supported agent backend available on your PATH, such as the
  Codex CLI or Claude Code CLI, depending on your config.
- Foundry available or a project layout that Ultrafuzz can prepare for Foundry
  fuzz tests.

## Install The CLI

From the Ultrafuzz repository:

```bash
cargo install --path crates/ultrafuzz-cli --locked
```

During Ultrafuzz development, run the same binary through Cargo:

```bash
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo run -p ultrafuzz-cli -- --help
```

## Initialize The Target Repository

Switch to the Solidity repository:

```bash
cd target-protocol
ultrafuzz init
```

The command writes a repository-local config, topology, editable prompts, and
reference catalog:

```text
ultrafuzz.toml
.ultrafuzz/
  topology.yml
  references.yml
  prompts/
  runs/
```

Existing config, topology, and prompt files are preserved unless you pass
`--force`.

If you want more or fewer normal strategy attempts in the default topology,
choose that before the first run:

```bash
ultrafuzz init --strategy-loops 3
```

## Run Doctor

Validate the project and backend setup:

```bash
ultrafuzz doctor
```

To check a specific backend:

```bash
ultrafuzz doctor --backend claude-code-cli
```

Doctor checks the repository, prompt registry, topology, output directory, git
state, selected CLI backend, sandbox and permission policy, and backend-native
project permission files.

## Start A Campaign

Fetch pinned GitHub references, then run the campaign DAG offline:

```bash
ultrafuzz references sync
ultrafuzz run
```

Common runtime overrides:

```bash
ultrafuzz run --backend codex-cli --max-parallel-agents 4
ultrafuzz run --strategy-loops 5
ultrafuzz run --sync-references
```

`--strategy-loops` updates `.ultrafuzz/topology.yml` before graph construction.
Top-level normal strategy nodes inherit that topology default.
`--sync-references` performs the trusted reference network phase before the
offline run starts.

## Watch And Inspect

List runs and check status:

```bash
ultrafuzz list
ultrafuzz status <run-id>
```

Open the dashboard:

```bash
ultrafuzz dashboard <run-id>
```

The dashboard runs on `127.0.0.1:3875` by default. It shows the campaign graph,
node status, logs, rendered prompts, findings, report data, and command buttons
for existing CLI actions.

## Review The Report

Render the final report:

```bash
ultrafuzz report <run-id>
ultrafuzz report <run-id> --json
```

The final report artifacts live at:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

Treat every finding and generated test as a candidate that needs human review.
The report is designed to show what was claimed, what evidence was produced,
what was triaged away, and which generated tests are worth inspecting.

## Review Generated Tests

The aggregation node copies selected generated tests into the target repository
as unstaged changes under:

```text
test/foundry/<strategy>/
```

Inspect them with normal git tooling:

```bash
git status
git diff -- test/foundry
```

Keep tests that are useful, edit tests that need protocol-specific cleanup, and
discard generated changes that do not hold up under manual review.
