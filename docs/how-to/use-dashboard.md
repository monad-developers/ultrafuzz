# Use the Dashboard

The dashboard is served by the same Rust binary as the CLI.

## Launch

```bash
ultrafuzz dashboard
ultrafuzz dashboard <run-id>
ultrafuzz dashboard <run-id> --host 127.0.0.1 --port 3875
```

By default, the dashboard binds to `127.0.0.1:3875`.

## Read The Graph

The main graph shows logical campaign nodes by default. Loop-expanded attempts
are available through details and toggles, but the editable surface stays
logical so prompt and topology changes map back to project files.

Use the dashboard to inspect:

- Run status, DAG nodes, edges, logs, and event timelines.
- Rendered prompts and strategy metadata.
- Findings, report data, strategy source/category, and command jobs.
- Project config, prompt files, and topology editing surfaces.

## Edit Project Assets

Prompt edits save under:

```text
.ultrafuzz/prompts/
```

Topology edits save to:

```text
.ultrafuzz/topology.yml
```

The dashboard validates path safety and topology/prompt shape before accepting
mutating saves.

## Run Commands From The Dashboard

Dashboard command buttons call existing CLI operations, including:

```text
run
restart
continue
status
doctor
config inspect
config defaults
report
triage
merge
materialize
clean
```

Destructive or file-mutating operations such as `materialize` and `clean`
require confirmation.

## Understand Preview Mode

If launched before a project has `ultrafuzz.toml`, the dashboard scaffolds the
default config, topology prompts, and runs directory, then serves a preview
graph until the first run exists.
