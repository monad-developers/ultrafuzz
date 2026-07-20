# Pinned References

Reference nodes let prompts use pinned external material without giving normal
runs a network fetch step. The operator syncs references explicitly, then runs
consume the local digest-checked cache.

## Catalog

Project reference metadata lives in:

```text
.ultrafuzz/references.yml
```

The catalog is the editable lock source of truth. `commit` must be a full
40-character SHA; mutable refs such as `main`, `master`, and tags are rejected.

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

Reference IDs must start with a lowercase letter or digit and may contain
lowercase letters, digits, dots, underscores, and hyphens. Paths must be
relative, traversal-free paths inside the referenced repository.

## Cache

Synced content is stored outside the project repository:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/ultrafuzz/references/github/<owner>/<repo>/<commit>/
```

Each cache entry contains the requested source files plus:

```text
.ultrafuzz-reference-manifest.json
```

The cache manifest records provider, repo, commit, fetch time, file sizes, and
SHA-256 digests. Third-party reference content is not committed to Ultrafuzz or
to the target repository.

## Commands

Fetch pinned references into the cache:

```bash
ultrafuzz references sync
```

Verify catalog shape, full SHAs, cache presence, source paths, and digests:

```bash
ultrafuzz references status
```

Intentionally move tracked GitHub repos to current default-branch HEAD commits
and rewrite `.ultrafuzz/references.yml`:

```bash
ultrafuzz references update --latest
```

`update` requires `--latest` so catalog rewrites are deliberate.

## Run Behavior

`ultrafuzz run` does not fetch missing references. If active topology contains
reference nodes and the cache is missing or corrupt, planning fails before
dependent agentic nodes run:

```bash
ultrafuzz references sync
ultrafuzz run
```

During planning, reference nodes materialize cached content into their node
artifact directory. The primary artifact is normalized Markdown headed with the
reference ID, repo, commit, and resolved timestamp. Non-Markdown source files
are included as fenced code blocks.

When one catalog entry pins multiple paths, the normalized Markdown contains a
source-path heading for every file in catalog order. This lets a coordinator
such as `kadenzipfel-vulnerability-strategies` enumerate a pinned corpus while
the cache still fetches and verifies the shared repository revision once.

Every reference node must also write:

```text
references/manifest.json
```

The run reference manifest records schema version, reference ID, provider, repo,
commit, resolved timestamp, source files, artifact files, sizes, and digests.

Downstream prompts should consume reference material through topology artifact
handoffs:

```md
{{artifact_handoff:reference-properties-montyly-rounding}}
```

## Failure Cases

Reference validation fails for:

- Missing `.ultrafuzz/references.yml`.
- Unsupported catalog version.
- Empty catalogs.
- Unsupported providers.
- Invalid reference IDs.
- Invalid `owner/repo` values.
- Non-full commit SHAs.
- Empty, duplicate, absolute, traversal, or unsafe source paths.
- Unknown topology reference IDs.
- Missing cache directories or source files.
- Cache manifest provider, repo, commit, size, or digest mismatches.
