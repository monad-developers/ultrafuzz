# Use The Dashboard

Dashboard/API is a beta product requirement, but this reset may ship a
CLI-only operator surface first. The current beta CLI does not expose
`ultrafuzz dashboard`; use this guide as the dashboard workflow target and use
the listed CLI commands until the dashboard implementation lands.

## Prepare A Run

Start from a validated beta project:

```bash
ultrafuzz init --project <project>
ultrafuzz validate --project <project>
ultrafuzz references sync --project <project>
ultrafuzz run --project <project> --run-id <run-id>
```

The dashboard should read the same product surfaces as the CLI:

```text
ultrafuzz.toml
.ultrafuzz/topology.yml
.ultrafuzz/prompts/**
.ultrafuzz/references.yml
.ultrafuzz/runs/**
```

## Inspect The Graph

The dashboard should show logical topology nodes by default. Expanded strategy
loops and model fan-out may appear in technical details, but graph edits should
map back to `.ultrafuzz/topology.yml`.

Until the dashboard is available, inspect the same run evidence with:

```bash
ultrafuzz ps --project <project>
ultrafuzz inspect --project <project> <run-id>
ultrafuzz report --project <project> <run-id>
```

## Edit Project Assets

Dashboard editors should save only beta product inputs:

- Runtime settings in root `ultrafuzz.toml`.
- Campaign graph changes in `.ultrafuzz/topology.yml`.
- Prompt text in `.ultrafuzz/prompts/**`.
- Reference catalog state through the explicit references flow.

Edits must validate before they are accepted and must not leave partial writes
after failed validation. For the CLI equivalent, edit the files directly and
run:

```bash
ultrafuzz validate --project <project>
```

## Run Product Operations

Dashboard command jobs must map to current beta CLI operations:

```text
validate
run
references status
references sync
references update
ps
inspect
resume
replay
fork
report
materialize
clean
```

Destructive or target-repository-mutating jobs require confirmation. In the
CLI, materialization requires explicit reviewed copies:

```bash
ultrafuzz materialize --project <project> <run-id> \
  --copy artifacts/<node>/stdout.txt:reviewed/stdout.txt \
  --yes
```

Cleanup removes only selected generated `.ultrafuzz/**` paths:

```bash
ultrafuzz clean --project <project> <run-id> --select runs/<run-id> --yes
```
