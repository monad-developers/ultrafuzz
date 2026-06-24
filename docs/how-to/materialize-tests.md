# Materialize Generated Tests

The normal aggregation node copies selected generated tests into the target
repository as unstaged changes under:

```text
test/foundry/<strategy>/
```

Use `materialize` for explicit non-default copies or patches from a run.

## Copy A Generated File

```bash
ultrafuzz materialize <run-id> \
  --copy artifacts/encode-decode-0/generated-tests/test/foundry/encode-decode/Generated.t.sol=test/foundry/manual/Generated.t.sol
```

The left side is run-relative. The right side is repository-relative.

## Apply A Patch

```bash
ultrafuzz materialize <run-id> \
  --patch artifacts/some-node/patch.diff
```

The command uses `git apply` or file copy without staging changes. It rejects
unsafe run-relative and repo-relative paths, preserves `HEAD`, and writes a
materialization record under the run's artifacts.

## Preview Before Writing

```bash
ultrafuzz materialize <run-id> --dry-run \
  --copy artifacts/final-report/generated.t.sol=test/Generated.t.sol
```

Review the resulting working tree before committing anything:

```bash
git status
git diff
```
