# CLI Commands

The CLI binary is `ultrafuzz`.

## Global Commands

| Command | Purpose |
| --- | --- |
| `ultrafuzz init` | Scaffold config, prompts, topology, and run directory in the target repository. |
| `ultrafuzz run` | Build and execute the campaign DAG. |
| `ultrafuzz references` | Sync, status-check, or intentionally update pinned GitHub references. |
| `ultrafuzz restart <run-id>` | Create a clean replay run from a prior run's resolved config and graph. |
| `ultrafuzz continue <run-id>` | Create a new run that reuses compatible completed artifacts and reruns the rest. |
| `ultrafuzz list` | List known runs. |
| `ultrafuzz status [<run-id-or-latest>]` | Show run health and node status. |
| `ultrafuzz doctor` | Validate repository, config, topology, prompts, backend, and permissions. |
| `ultrafuzz config` | Inspect resolved config or print defaults. |
| `ultrafuzz dashboard [<run-id-or-latest>]` | Serve the local dashboard. |
| `ultrafuzz report <run-id-or-latest>` | Render final report output. |
| `ultrafuzz clean <run-id>` | Remove a run directory. |
| `ultrafuzz triage <run-id>` | Read persisted artifacts and render triage output. |
| `ultrafuzz merge <run-id>` | Report deterministic generated-test aggregation results. |
| `ultrafuzz materialize <run-id>` | Copy selected run artifacts or apply selected patches into the target repo as unstaged changes. |

## Init

```bash
ultrafuzz init [--force] [--minimal | --full] [--strategy-loops <N>]
```

`--force` replaces existing scaffolded files. `--strategy-loops` writes the
initial topology default for normal strategy attempts.

## Run

```bash
ultrafuzz run \
  [--plain] [--no-color] [--quiet] [--verbose] \
  [--backend <backend>] \
  [--max-parallel-agents <N>] \
  [--strategy-loops <N>] \
  [--dynamic-strategies-enumerator <N>] \
  [--triage-quorum <N>] \
  [--triage-panel-size <N>] \
  [--invariant-property-priority-threshold high|medium|low] \
  [--invariant-testing-fuzzer-timeout <duration>] \
  [--sync-references]
```

Durations accept `s`, `min`, or `h`, such as `1800s`, `30min`, or `1h`.

`--plain` and `--no-color` keep terminal output unstyled. `--quiet` suppresses
next-command guidance, while `--verbose` keeps the full lifecycle summary.

Default runs are offline and require referenced GitHub material to already be
cached. `--sync-references` performs the trusted network sync phase before the
offline run starts.

## References

```bash
ultrafuzz references sync
ultrafuzz references status
ultrafuzz references update --latest
```

`sync` fetches pinned commits from `.ultrafuzz/references.yml` into the user
cache. `status` validates the catalog, cache presence, source paths, and
digests. `update --latest` intentionally rewrites `.ultrafuzz/references.yml`
with the latest full default-branch SHAs for each tracked GitHub repository.

See [Pinned References](references.md) for the catalog format and cache path.

## Restart

```bash
ultrafuzz restart <run-id> \
  [--plain] [--no-color] [--quiet] [--verbose] \
  [--backend <backend>] \
  [--max-parallel-agents <N>] \
  [--dynamic-strategies-enumerator <N>] \
  [--triage-quorum <N>] \
  [--triage-panel-size <N>] \
  [--invariant-property-priority-threshold high|medium|low] \
  [--invariant-testing-fuzzer-timeout <duration>]
```

## Continue

```bash
ultrafuzz continue <run-id> [--plain] [--no-color] [--quiet] [--verbose]
```

`restart` creates a clean replay run. `continue` creates a new run that reuses
compatible completed work and reruns the rest.

## Status

```bash
ultrafuzz status [<run-id-or-latest>] [--json] [--plain] [--no-color]
```

When no run ID is provided, status resolves the latest run. `--json` emits a
machine-readable summary including run status, node counts, health, and next
commands.

## Doctor

```bash
ultrafuzz doctor [--backend <backend>] [--json] [--plain] [--no-color]
```

`--json` emits repository, backend, output-directory, git, topology, and next
command status for automation.

## Config

```bash
ultrafuzz config inspect
ultrafuzz config defaults
```

When no subcommand is provided, config defaults to inspection behavior.

## Dashboard

```bash
ultrafuzz dashboard [<run-id-or-latest>] [--host <host>] [--port <port>]
```

The default host is `127.0.0.1` and the default port is `3875`.

## Report

```bash
ultrafuzz report <run-id-or-latest>
ultrafuzz report <run-id-or-latest> --json
```

## Clean

```bash
ultrafuzz clean <run-id> [--dry-run] [--force]
```

## Materialize

```bash
ultrafuzz materialize <run-id> \
  [--patch <run-relative-patch>] \
  [--copy <run-relative-path=repo-relative-path>] \
  [--dry-run] \
  [--force]
```
