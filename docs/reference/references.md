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
  repo: monad-developers/web3-vulnerability-database
  commit: fbf00e990b1316879b674e9903548dba452e40d5
  paths:
    - database.yml
    - capabilities.yml
    - catalog.json
  resolved_at: "2026-08-04T22:33:24Z"
```

The shipped `.ultrafuzz/references.yml` defines exactly this entry, so a clean
`ultrafuzz init` scaffold already pins the reviewed database release and the
`reference-vulnerability-database`, `threat-model`, `goal-plan`, and goal-fanout
nodes run by default. Run `ultrafuzz references sync` once to populate the cache
before running offline.

#### Read access is a prerequisite

`monad-developers/web3-vulnerability-database` is currently a **private**
repository, so materializing it needs a read credential. References are fetched
anonymously by default — the right default, because most references are public
and a fetch must never carry a credential it does not need — and a credential is
attached only when it is declared explicitly:

| Variable                           | Meaning                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `ULTRAFUZZ_REFERENCE_GITHUB_TOKEN` | The short-lived read token.                                   |
| `ULTRAFUZZ_REFERENCE_GITHUB_REPOS` | Comma-separated `owner/repo` values the token may be sent to. |

Both are required together. A token with no allowlist is inert, and a reference
whose repo is not in the allowlist is still fetched anonymously even while a
token is present — so a token minted for one private repository can never be
leaked to an unrelated remote just because the catalog names it.

The token reaches git through `GIT_CONFIG_*` variables carrying an
`http.<remote>.extraheader` setting keyed to the exact remote URL. It is never
written into the remote URL, a command argument, a config file, or a credential
helper, so it cannot surface in `git remote -v`, a process listing, a cache
manifest, or a `GIT_FAILED` diagnostic — those redact both the token and its
derived basic-auth encoding.

Without a usable credential, `ultrafuzz references sync` fails closed with the
`GIT_FAILED` reference diagnostic wrapping the git stderr:

```text
error: GIT_FAILED: git command failed: git fetch --depth=1 --filter=blob:none origin fbf00e990b1316879b674e9903548dba452e40d5: remote: Repository not found.
fatal: Authentication failed for 'https://github.com/monad-developers/web3-vulnerability-database.git/'
```

Every downstream node fails closed behind that. A project that genuinely cannot
reach the repository must remove the `vulnerability-database.web3` entry together
with the `reference-vulnerability-database` node and the nodes that consume it;
removing only the catalog entry leaves the reference node dangling and validation
fails with `INVALID_REFERENCE_NODE`.

##### Cloud runs

The detached Modal benchmark worker runs `ultrafuzz references sync` in its
**pre-model** phase, so the credential must be inside the sandbox, not merely on
the CI runner. `Modal Eval Benchmarks` therefore:

1. mints a short-lived installation token from the existing eval-history GitHub
   App (`vars.EVAL_HISTORY_APP_CLIENT_ID` plus
   `secrets.EVAL_HISTORY_APP_PRIVATE_KEY`), scoped to
   `permission-contents: read` on `web3-vulnerability-database` alone;
2. proves read access with `scripts/ci/preflight-reference-access.mjs` **before**
   the immutable image build, using only immutable repository metadata and the
   pinned commit — no clone, no blob fetch, no model contact — so a missing
   installation or permission costs nothing;
3. forwards only the token and its allowlist into the Modal secret, alongside the
   model API keys. The App private key never leaves the trusted GitHub runner.

The App private key is reachable only from `push` and `workflow_dispatch`, which
never expose repository secrets to fork code — the same trust boundary the Modal
and model-provider secrets already rely on. Adding a `pull_request` or
`pull_request_target` trigger to that workflow would break it.

Both the `launch` job and the `collect` job mint their **own** token with
`skip-token-revoke: true`. Two independent timing constraints require this: an
installation token expires one hour after creation while `collect` can wait far
longer, and the sandboxes are detached, so a post-job revocation would invalidate
the credential a worker still needs. The token is also registered as a forbidden
value for public bundles, diagnostics, and lifecycle logs, exactly like a model
API key.

If the App is not installed on the database repository, or its installation lacks
`Contents: Read-only`, the preflight stops the run before any paid compute and
prints the exact external action required. That action is external by
construction: a repository administrator must grant it, and no change inside this
repository can substitute for it.

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
