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
  commit: 74c2a5114b7adbd208eb49e47c137daa49b4a395
  paths:
    - database.yml
    - capabilities.yml
    - catalog.json
  resolved_at: "2026-08-09T01:15:37Z"
```

The shipped `.ultrafuzz/references.yml` defines exactly this entry, so a clean
`ultrafuzz init` scaffold already pins the reviewed database release and the
`reference-vulnerability-database`, `threat-model`, `goal-plan`, and goal-fanout
nodes run by default. Run `ultrafuzz references sync` once to populate the cache
before running offline.

#### Public unauthenticated materialization

`aviggiano/web3-vulnerability-database` is public, so the immutable commit
`74c2a5114b7adbd208eb49e47c137daa49b4a395` is fetched
anonymously by `ultrafuzz references sync`, including in the detached Modal
worker's pre-model phase. This reference needs no GitHub token, App installation,
SSH agent, or credential helper.

The pin was verified from a fresh unauthenticated fetch of the full commit. The
three contract files carry these digests:

| Path               |   Bytes | SHA-256                                                            |
| ------------------ | ------: | ------------------------------------------------------------------ |
| `database.yml`     |      97 | `7c74b02face305b84d3af7bfbda75d47827fd1f8cb7e757a810d3838bc99d601` |
| `capabilities.yml` |  20,097 | `22c3cdd7dd6c5d1f8474814644fc09b795ca05ef8b5714270e1c9f9445cbd607` |
| `catalog.json`     | 412,076 | `1da846ce98905da0f58a24c0d77b17a0dc9d334743eb8682bfa0f06530423bbc` |

The catalog declares `schemaVersion: 3`, `algorithm: sha256`, aggregate digest
`c66a85c323d09464ce4f1a750786f2cdd92dab4213935c29233d6662475c4215`,
68 capabilities, and 141 records (all currently `draft`) across the `accounting`,
`amm`, `auctions`, `authorization`, `coverage`, `cross-chain`, `derivatives`,
`distribution`, `governance`, `integrations`, `lending`, `numeric`, `operations`,
`oracle`, `randomness`, `stablecoin`, `staking`, `trading`, and `yield` domains.
Ultrafuzz does not trust repository visibility or the mutable default branch as integrity evidence: it
fetches the exact 40-character commit, verifies the selected Git tree and every
declared file digest, recomputes the catalog aggregate, and records the pinned
source identity in the materialized manifest.

Replace the commit only with another reviewed database release commit. The three
configured paths are fixed. Ultrafuzz reads the canonically ordered record
paths from `catalog.json`, verifies that the pinned Git tree contains exactly
those regular YAML files below `classes/`, and adds them to the same
digest-checked cache entry. Mutable branches and an external checkout that has
not yet published the contract fail closed.

The pinned commit publishes the upstream v3 contract: `database.yml` declares
`schema_version: 3` with `classes/**/*.yml`, `capabilities.yml`, and
`catalog.json`; `capabilities.yml` keeps registry schema v1 while allowing a
deprecated entry to name its `supersededBy` replacement; and each YAML class
stores its seven sections under `sections`, with detection guidance split into
`strategy`, non-empty `codeSurfaces`, and closed typed `steps`. Ultrafuzz accepts
the historical v1 Markdown contract for existing immutable pins, dispatches the
record and path validators by database schema, recomputes the upstream aggregate
digest over the canonical catalog payload, and only then normalizes it into its
own digest-bound planner catalog. The planner's string `detection_guidance`
remains the v3 `detection.strategy`; exact selected YAML snapshots preserve the
structured surfaces and checks for focused hunters. Nothing from an external
repository is executed, and no unvalidated upstream field reaches a planner
prompt.

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
digest algorithm, the capability registry against `capabilities.yml`, strict v1
Markdown or v3 YAML record structure and required sections, typed v3 detection
steps, safe class and selected artifact paths, the domain/category/path agreement
rule, capability references and replacements, canonical ordering, every source
digest and byte size, and the recomputed aggregate digest. The runtime never
executes code from the external repository.

Planning then normalizes the validated upstream catalog into the internal
planner catalog (`ultrafuzz.vulnerability-db.planner-catalog.v1`) written to
`vulnerability-db/catalog.json` in the run root. That document is a pure
function of the validated upstream bytes and records both digests:
`database_aggregate_sha256` from upstream and `upstream_catalog_sha256` for the
exact upstream file it was derived from. Goal plans bind the planner catalog by
its own digest. The normalized records also carry the validated required class
sections, including hunter instructions and examples, so goal planning retains
its class-replacement context without reconstructing source records. A planner
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
