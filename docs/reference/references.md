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

### OWASP Smart Contract Security

The default vulnerability-database reference uses the
[OWASP SCS repository](https://github.com/OWASP/owasp-scs). It pins the SCWE
weakness enumeration and SCSVS topic registry at an immutable commit:

```yaml
vulnerability-database.owasp-scs:
  kind: vulnerability-database
  provider: github
  repo: OWASP/owasp-scs
  commit: fefd476b83074666ada2d816f103436a18e1ece4
  paths:
    - License.md
    - docs/SCSVS/scsvs.yaml
    - docs/SCWE/index.md
  resolved_at: "2026-09-08T00:00:00Z"
```

A clean `ultrafuzz init` includes this pin.
The public OWASP repository needs no GitHub credentials.

The pin contains 156 SCWE records and 11 SCSVS groups. Sync discovers
`docs/SCWE/SCSVS-*/SCWE-*.md` from the pinned Git tree, rejects non-regular
entries, and caches the exact source bytes with SHA-256 digests. The three
configured paths are fixed for the OWASP adapter. Unrelated website content is
not fetched. The source license is retained with the materialized reference.

Ultrafuzz derives its planner catalog from validated SCWE frontmatter and bodies
and the SCSVS YAML registry. Internal schema revision `4` identifies this adapter;
it is **not an OWASP schema or release version**. Internal identifiers use
lowercase (`scwe-016`, `scsvs-auth`); original IDs, Markdown, and paths remain
unchanged in selected snapshots and source links.

SCSVS groups are security topics, not protocol prerequisites. They appear as
optional capability hints, with no required or incompatible capability gates.
The declared SCWE mappings determine routing even when an upstream directory
uses a different group. Goal planning must assess applicability from the source
and target evidence. Source bodies provide detection guidance; generic adapter
instructions ask hunters to establish preconditions, violated properties, and
impact from target code. Records remain `draft`, without implying an upstream
review endorsement.

The aggregate digest covers a path-sorted list of SHA-256 digests and byte sizes
for the license, registry, index, and every SCWE record. `upstream_catalog_sha256`
binds the exact SCWE index bytes; the planner catalog has its own digest. Cache
validation rejects altered, added, or removed records. Runtime planning
re-derives the catalog from the materialized source, and selected snapshots keep
the exact original SCWE Markdown. No upstream code is executed.

### Migrating from the former Web3 database

The OWASP adapter is a breaking replacement. The former
`vulnerability-database.web3` reference layout and database revisions `1` and `3`
are no longer accepted. Existing run catalogs, selected-record snapshots, and
goal plans are not converted. Keep the previous Ultrafuzz version available for
ongoing or historical runs that use those artifacts.

For an existing project, generate a clean scaffold in a temporary directory with
the new CLI and review its changes against the project's configuration. Plain
`ultrafuzz init` preserves existing project files; `init --force` can overwrite
customizations and is not a migration command.

1. Replace the former database stanza in `.ultrafuzz/references.yml` with the
   `vulnerability-database.owasp-scs` stanza above, including its three paths.
2. Update the database reference in `.ultrafuzz/topology.yml` and any custom
   topologies. Review the new scaffold's setup prompts and artifact schemas,
   incorporating OWASP guidance while preserving project-specific instructions.
3. Run `ultrafuzz references sync` and `ultrafuzz references status` with the new
   CLI, then start a fresh run. Preserve previous run directories and caches.

Plan for 156 class goals from this pin, in addition to threat goals and the
roaming hunter. Under the current goal-plan contract, optional SCSVS hints cannot
exclude classes; source and target evidence guide the investigation. Account for
this work when choosing run budgets and concurrency.

### Private references

The shipped references are all public and need no credential. A project that
pins a reference in a private repository supplies one through two environment
variables, and both are required together:

| Variable                           | Meaning                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `ULTRAFUZZ_REFERENCE_GITHUB_REPOS` | Comma-separated `owner/repo` allowlist the token may be sent to. |
| `ULTRAFUZZ_REFERENCE_GITHUB_TOKEN` | The token itself. Never commit it or pass it on a command line.  |

The token is attached as a per-fetch HTTP `extraheader` scoped to a repository
on the allowlist, so it is never written to a config file, never sent to a
repository the allowlist does not name, and is redacted from logs.

The two failure modes are deliberately asymmetric. Declaring repositories
without supplying a token fails a Modal launch closed, because that combination
can only mean a missing credential. Supplying a token without an allowlist is
inert instead: the credential is simply never attached, since there is no
repository it has been authorized for. A private reference then fetches
anonymously and fails as not found, so set both variables or neither.

## Cache

Synced content is stored outside the project repository:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/ultrafuzz/references/github/<owner>/<repo>/<commit>/
```

Vulnerability-database references use
`<repo>/vulnerability-database/<commit>/`, a sibling namespace that cannot
collide with document references pinned to the same repository and commit.

Each cache entry contains the requested source files plus:

```text
.ultrafuzz-reference-manifest.json
```

The cache manifest records provider, repo, commit, fetch time, file sizes, and
SHA-256 digests. Synced reference content is not committed to the target
repository. Ultrafuzz retains a licensed pinned-source fixture for offline
adapter regression tests; production packages do not ship that fixture.

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

During planning, normal document reference nodes materialize normalized
Markdown headed with the reference ID, repo, commit, and resolved timestamp.
Non-Markdown source files are included as fenced code blocks.

A `kind: vulnerability-database` reference materializes source files below
`vulnerability-db/` in its node artifact directory. For OWASP SCS, its primary
output `vulnerability-db/catalog.json` is the derived planner catalog.

Planning writes the internal planner catalog
(`ultrafuzz.vulnerability-db.planner-catalog.v1`) to
`vulnerability-db/catalog.json` in the run root. Goal plans bind that document
by digest, and a catalog that does not re-derive from the validated pinned source
fails closed. Selected records and source provenance are recorded in
`vulnerability-db-manifest.json`.

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
- Vulnerability-database catalog traversal, Git symlinks, undeclared class
  files, malformed records, unknown capabilities, broken related classes, or
  aggregate/source digest mismatches.
