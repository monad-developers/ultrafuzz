# Dashboard And API

Dashboard/API is part of the product contract. The CLI exposes a local operator
surface with:

```bash
ultrafuzz dashboard --project <project>
```

The server binds to loopback by default and serves the dashboard at the printed
`/dashboard` URL. Dashboard behavior is specified here and in
[SPECS.md](../SPECS.md).

## Product Surfaces

The dashboard must treat these as the stable Ultrafuzz product surfaces:

- Root `ultrafuzz.toml` for runtime settings.
- `.ultrafuzz/topology.yml` for logical campaign topology.
- `.ultrafuzz/prompts/**` for editable prompt text.
- `.ultrafuzz/references.yml` for pinned reference catalog state.
- `.ultrafuzz/runs/**` for run evidence, rendered prompts, artifacts, events,
  and report outputs.

Generated workflow-engine files outside `.ultrafuzz/` are implementation
plumbing and are not a dashboard/API product surface.

## Graph Model

The default graph view should show logical topology nodes. Expanded loop
attempts and model fan-out may be shown in details, timelines, or toggles, but
editable graph changes must write back to the logical topology file.

Editors for config, topology, prompts, and reference state must apply the same
validation as the CLI. Invalid changes must be rejected without partial writes.

## Command Jobs

Dashboard command jobs must map only to supported product operations:

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

`materialize` and `clean` require explicit confirmation. Materialization copies
only selected reviewed outputs into the target project; patch application is
not exposed until safe patch handling exists. Cleanup removes only selected
generated `.ultrafuzz/**` paths.

## Local Security

Dashboard/API servers must bind to loopback by default. Mutating APIs must use
local request protections and a cryptographically random session token.

Path and run-ID inputs must use the same safe-path and safe-ID validation as
the CLI, including rejection of traversal, absolute-path injection, unsafe
relative paths, symlink escapes, and unsafe run IDs.

The dashboard is a local operator tool. Do not expose it on an untrusted
network interface.

`ultrafuzz dashboard` accepts `--host`, `--port`, `--run-id`, and `--no-live`.
The host must be loopback (`127.0.0.1`, `::1`, or `localhost`).

## Asset

`docs/assets/ultrafuzz-dashboard.png` is a byte-for-byte copy of the original
Ultrafuzz dashboard screenshot. Use it as visual context for the intended
local operator UI; product behavior is governed by this page and the spec.
