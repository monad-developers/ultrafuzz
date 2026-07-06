# Clean Runs

Runs and generated workspaces accumulate under `.ultrafuzz/`. Clean only the
generated paths you intentionally select.

## Preview Cleanup

```bash
ultrafuzz clean <run-id> --project /path/to/target-protocol --dry-run
```

Without an explicit selection, `clean <run-id>` targets:

```text
.ultrafuzz/runs/<run-id>
```

## Remove A Run

```bash
ultrafuzz clean <run-id> --project /path/to/target-protocol --confirm
```

`--yes` is accepted as an alias for `--confirm`.

## Clean A Generated Subpath

Selections are relative to `.ultrafuzz/` and must name generated run,
artifact, or workspace directories.

```bash
ultrafuzz clean <run-id> --project /path/to/target-protocol --dry-run \
  --select runs/<run-id>/artifacts/<node-id>

ultrafuzz clean <run-id> --project /path/to/target-protocol --confirm \
  --select runs/<run-id>/artifacts/<node-id>
```

Cleanup rejects unsafe paths, symlink escapes, missing selections, and
non-generated product surfaces. It does not revert files that were already
materialized into the target repository.
