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

## Remove Modal Storage Of Per-Node Cloud Runs

An earlier release could plan a run for per-node Modal execution
(`[execution] mode = "cloud"`). That run's Modal volume and any of its
sandboxes still running outlive the run directory, and `clean` no longer
removes them. For such a run, the preview and the removal both report a
`CLEAN_CLOUD_STORAGE_RETAINED` warning, and without `--json` the removal
prints it before it deletes anything. It names the Modal app, the volume and
the sandboxes' `run` tag, read from the run's `plan.json`, which the removal
deletes. The removal still deletes the run. Delete the volume with the command
the warning prints, for example:

```bash
modal volume delete ultrafuzz-node-ultrafuzz-run-20260930t161149123-d99772718708
```

Copy the volume name from the warning, or find it with `modal volume list`,
rather than writing it from the run ID: the removed provider kept at most 32
characters of `ultrafuzz-<run-id>`, which cuts a generated run ID short, and
appended 12 hex digits of its SHA-256. Then stop any sandbox tagged
`purpose=ultrafuzz-node` with the warning's `run` tag that is still running in
the named app.

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
