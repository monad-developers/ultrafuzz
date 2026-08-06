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

### Web3 vulnerability database

The vulnerability database uses a dedicated reference kind. A project must pin
an immutable commit that already contains the complete external contract:

```yaml
vulnerability-database.web3:
  kind: vulnerability-database
  provider: github
  repo: aviggiano/web3-vulnerability-database
  commit: e46c0e472c28596f30decbb08549c9d9630f47cb
  paths:
    - database.yml
    - capabilities.yml
    - catalog.json
  resolved_at: "2026-08-06T23:31:09Z"
```

The shipped `.ultrafuzz/references.yml` defines exactly this entry, so a clean
`ultrafuzz init` scaffold already pins the reviewed database release and the
`reference-vulnerability-database`, `threat-model`, `goal-plan`, and goal-fanout
nodes run by default. Run `ultrafuzz references sync` once to populate the cache
before running offline.

#### Public unauthenticated materialization

`aviggiano/web3-vulnerability-database` is public, so the immutable commit
`e46c0e472c28596f30decbb08549c9d9630f47cb` is fetched
anonymously by `ultrafuzz references sync`, including in the detached Modal
worker's pre-model phase. This reference needs no GitHub token, App installation,
SSH agent, or credential helper.

The pin was verified from a fresh unauthenticated fetch of the full commit. The
three contract files carry these digests:

| Path               |  Bytes | SHA-256                                                            |
| ------------------ | -----: | ------------------------------------------------------------------ |
| `database.yml`     |     96 | `0da89f82af4680a9d62770c520073d9937f55d932f2a16f737024e48633694f1` |
| `capabilities.yml` |  6,176 | `fabaae6efe20335b53e978699fe90049d9a8bf90bd51813a80ca60bd9f39ac82` |
| `catalog.json`     | 44,680 | `8710705a3fb50707c32ccfe55775f7fca4cb87cb7c0fece54af62ea557f35402` |

The catalog declares `schemaVersion: 1`, `algorithm: sha256`, aggregate digest
`62b7fb8047b3e74783283cd1aa23eca14c24846d8c62233b34fa47e44cc5ff91`,
28 capabilities, and 23 records (all currently `draft`) across the `accounting`,
`authorization`, `cross-chain`, `derivatives`, `governance`, `integrations`,
`lending`, `numeric`, `operations`, and `oracle` categories. Ultrafuzz does not trust
repository visibility or the mutable default branch as integrity evidence: it
fetches the exact 40-character commit, verifies the selected Git tree and every
declared file digest, recomputes the catalog aggregate, and records the pinned
source identity in the materialized manifest.

Replace the commit only with another reviewed database release commit. The three
configured paths are fixed. Ultrafuzz reads the canonically ordered record
paths from `catalog.json`, verifies that the pinned Git tree contains exactly
those regular Markdown files below `classes/`, and adds them to the same
digest-checked cache entry. Mutable branches and an external checkout that has
not yet published the contract fail closed.

The pinned commit publishes the upstream v1 contract: `database.yml` declares
`schema_version: 1` with `classes/**/*.md`, `capabilities.yml`, and
`catalog.json`; `capabilities.yml` declares the controlled capability registry
with optional aliases; and `catalog.json` carries `schemaVersion`, `algorithm`,
`aggregateSha256`, capability definitions, and records with dotted IDs,
`sourcePath`, `selectedArtifactPath`, `sha256`, `bytes`, `routing`,
`applicability`, `sources`, and `reviewStatus`. Ultrafuzz validates that shape
strictly, recomputes the upstream aggregate digest over the canonical catalog
payload, and only then normalizes it into its own digest-bound planner catalog.
Nothing from an external repository is executed, and no unvalidated upstream
field reaches a planner prompt.

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

During planning, normal document reference nodes materialize normalized
Markdown headed with the reference ID, repo, commit, and resolved timestamp.
Non-Markdown source files are included as fenced code blocks.

A `kind: vulnerability-database` reference instead materializes the exact
upstream database files below `vulnerability-db/` in its node artifact
directory. Its primary output is `vulnerability-db/catalog.json`, the unmodified
upstream file. Validation independently checks the upstream top-level schema and
digest algorithm, the capability registry against `capabilities.yml`, strict
record frontmatter and the required upstream sections, safe class and selected
artifact paths, the domain/category/path agreement rule, capability references,
canonical ordering, every source digest and byte size, and the recomputed
aggregate digest. The runtime never executes code from the external repository.

Planning then normalizes the validated upstream catalog into the internal
planner catalog (`ultrafuzz.vulnerability-db.planner-catalog.v1`) written to
`vulnerability-db/catalog.json` in the run root. That document is a pure
function of the validated upstream bytes and records both digests:
`database_aggregate_sha256` from upstream and `upstream_catalog_sha256` for the
exact upstream file it was derived from. Goal plans bind the planner catalog by
its own digest. The normalized records also carry the validated required class
sections, including hunter instructions and examples, so goal planning retains
its class-replacement context without reconstructing Markdown. A planner
catalog that does not re-derive from the pinned database fails closed.

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
