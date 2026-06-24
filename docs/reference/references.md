# Pinned References

Properties lenses can depend on pinned GitHub reference material without giving
agents network access. The operator performs an explicit trusted network phase,
then normal runs read immutable cache entries offline.

## Catalog

Project reference metadata lives in one committed file:

```text
.ultrafuzz/references.yml
```

The file is both the editable catalog and the lock source of truth. `commit`
must be a full 40-character SHA; mutable refs such as `main` or `master` are
rejected.

```yaml
version: 1
references:
  properties.montyly-rounding:
    provider: github
    repo: montyly/montyly.github.io
    commit: a3dbfa1fbacd05fb2e5e7c66acb2243dafd1483d
    paths:
      - blog/2026/january/rounding.md
    resolved_at: "2026-06-23T00:00:00Z"
```

Paths must be relative, traversal-free paths inside the referenced repository.

## Cache

Synced content is stored outside the project repository:

```text
$XDG_CACHE_HOME/ultrafuzz/references/github/<owner>/<repo>/<commit>/
```

If `XDG_CACHE_HOME` is not set, Ultrafuzz uses:

```text
$HOME/.cache/ultrafuzz/references/github/<owner>/<repo>/<commit>/
```

The cache directory contains the requested source files plus an internal digest
manifest. Third-party reference content is not committed to Ultrafuzz or to the
target repository.

## Commands

Fetch all pinned references into the cache:

```bash
ultrafuzz references sync
```

Verify catalog shape, full SHAs, cache presence, required source paths, and
digests:

```bash
ultrafuzz references status
```

Intentionally move every tracked GitHub repo to its current default-branch HEAD
and rewrite `.ultrafuzz/references.yml` with full SHAs:

```bash
ultrafuzz references update --latest
```

`update` requires `--latest` so catalog rewrites are deliberate.

## Run Behavior

Default `ultrafuzz run` is offline. If the active topology contains reference
nodes and the cache is missing or corrupt, the run fails before launching
agents:

```bash
ultrafuzz references sync
ultrafuzz run
```

For convenience, a run can perform the trusted network sync phase first:

```bash
ultrafuzz run --sync-references
```

After the sync phase, reference nodes materialize normalized markdown into run
artifacts such as `references/rounding.md` and write
`references/manifest.json`. Property prompts read those artifacts through
typed artifact handoffs.
