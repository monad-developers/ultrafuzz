# Clean Runs

Runs accumulate under `.ultrafuzz/runs/`. Remove old run directories explicitly.

## Preview Cleanup

```bash
ultrafuzz clean <run-id> --dry-run
```

## Remove A Run

```bash
ultrafuzz clean <run-id>
```

Use `--force` when the command requires explicit confirmation for the local
state you are cleaning:

```bash
ultrafuzz clean <run-id> --force
```

Cleaning a run removes persisted run artifacts for that run. It does not commit
or revert target repository changes.
