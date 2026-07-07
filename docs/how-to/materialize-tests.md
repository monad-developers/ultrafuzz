# Materialize Generated Tests

Generated tests and patches are run evidence until you explicitly copy reviewed
files into the target repository. Materialization is copy-only; patch
application is rejected.

## Choose A Concrete Output

Use the report and review artifacts to identify the exact run output you want:

```bash
ultrafuzz report <run-id> --project /path/to/target-protocol
ultrafuzz inspect <run-id> --project /path/to/target-protocol
```

Prefer copying reviewed files from run-relative `artifacts/` paths, such as
`artifacts/<node-id>/generated-tests/<file>`. Review metadata may also live
under run-relative `review/` paths.

## Preview A Copy

```bash
ultrafuzz materialize <run-id> --project /path/to/target-protocol --dry-run \
  --copy artifacts/<node-id>/generated-tests/Generated.t.sol:test/foundry/Generated.t.sol
```

The left side is relative to `.ultrafuzz/runs/<run-id>/`. The right side is
relative to the target repository.

## Confirm The Copy

```bash
ultrafuzz materialize <run-id> --project /path/to/target-protocol --confirm \
  --copy artifacts/<node-id>/generated-tests/Generated.t.sol:test/foundry/Generated.t.sol
```

Use `--yes` instead of `--confirm` if you prefer. Use `--force` only when you
intend to overwrite an existing destination file.

Materialized files are left as unstaged working-tree changes. Ultrafuzz writes
an audit record under `.ultrafuzz/materialize-audit.jsonl`.

## Review The Working Tree

```bash
git -C /path/to/target-protocol status
git -C /path/to/target-protocol diff -- test
```

Edit or discard copied tests with normal repository tools. Ultrafuzz does not
stage, commit, push, open pull requests, or submit findings for you.
