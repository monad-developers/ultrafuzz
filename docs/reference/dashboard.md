# Dashboard Controls and Security

The dashboard is served by `ultrafuzz dashboard`.

## Launch

```bash
ultrafuzz dashboard [<run-id>] [--host <host>] [--port <port>]
```

Default:

```text
127.0.0.1:3875
```

## Surfaces

The dashboard exposes:

- Logical React Flow campaign graph.
- Loop-expanded attempts in details and toggles.
- Run status, logs, event timelines, findings, report data, and prompts.
- Project prompt editor.
- Topology editor.
- Project config editor.
- Command-job buttons for existing CLI operations.

## Command Jobs

Supported dashboard-triggered commands include:

```text
list
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

`materialize` and `clean` require confirmation.

## Local Security Assumptions

Dashboard file-mutating and command-running APIs require:

- A local Host header.
- A local Origin header when Origin is present.
- The dashboard session token.

The server rejects non-loopback hosts. Path-sensitive prompt, topology,
materialization, and run-ID operations validate inputs to prevent traversal and
unsafe relative paths.

The dashboard is a local operator tool. Do not expose it on an untrusted network
interface.
