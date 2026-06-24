# Restart or Continue Campaigns

Use restart when you want a clean replay from a prior run. Use continue when
you want to reuse compatible completed work and rerun the rest.

## List Runs

```bash
ultrafuzz list
ultrafuzz status <run-id>
```

Run directories live under:

```text
.ultrafuzz/runs/<run-id>/
```

## Restart A Run

```bash
ultrafuzz restart <run-id>
```

With overrides:

```bash
ultrafuzz restart <run-id> --backend claude-code-cli --max-parallel-agents 8
ultrafuzz restart <run-id> --triage-quorum 4 --triage-panel-size 7
```

Restart creates a new run from the prior run's resolved config and graph. It
does not mutate the old run.

Run artifact `resolved-config.toml` redacts backend and model-profile
environment values. When a prior run contains redacted env keys, `restart`
restores those values from the current project `ultrafuzz.toml` before executing
the new run. If the current config cannot provide an unredacted value for a
redacted source key, restart fails with an explicit error instead of running
with the literal `<redacted>` placeholder.

## Continue A Run

```bash
ultrafuzz continue <run-id>
```

Continue creates a new run that first validates graph, config, topology, prompt,
and artifact compatibility. It reuses valid succeeded node artifacts and reruns
unfinished, failed, timed-out, skipped, invalidated, or affected downstream
work.

Like restart, continue restores redacted backend and model-profile env values
from the current project config before checking config compatibility.

## Keep Workspaces For Debugging

Set:

```bash
export ULTRAFUZZ_KEEP_WORKSPACES=1
```

Then inspect the isolated attempt workspaces after the run. Clear the variable
when you no longer need local debugging artifacts.
