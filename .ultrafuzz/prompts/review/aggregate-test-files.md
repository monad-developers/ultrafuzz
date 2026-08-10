---
id: aggregate-test-files
display_name: Aggregate test files
---

# Aggregate test files

Your job is to collect canonical generated-test companions from isolated
strategy attempts and copy them deterministically into this node's isolated
workspace using the target's existing Foundry, Hardhat, or Vyper test layout.

The original target repository root is:
{{repo_path}}

Do not run commands against `{{repo_path}}` and do not use it as a file-tool
destination. Use `{{workspace_path}}` as the destination root for every copied
test and support file. Record each copied file's `destination_relative_path` as
the workspace-relative path that would also be target-repository-relative if the
generated tests are later materialized.

Use these review handoffs:

Prefer the Read tool for the exact manifest files listed below. If you use
Bash to inspect artifact directories or copied files, run one command at a
time and inspect the output as-is. Do not use shell pipelines or chained
commands. Wrong: `ls {{artifact_path}} | sort`. Use `ls {{artifact_path}}` by
itself, or read the exact manifest path directly. For copied-file size checks,
use standalone `wc -c <path>` commands. Do not use `stat`, `find ... -printf`,
or any other shell command outside the provided allowed tool list.

Dedupe report:
{{artifact_path:dedupe-findings}}/deduped-findings.json

Severity-classified findings:
{{artifact_path:severity-classification}}/severity-classified-findings.json

Project discovery:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Base test setup (when rendered):
{{artifact_path:base-test-setup}}/setup/base-test-setup.md

Strategy generated-test manifests:

Boundary tests:
{{artifact_path:boundary-tests}}/generated-tests.json

Encode/decode:
{{artifact_path:encode-decode}}/generated-tests.json

Differential library tests:
{{artifact_path:differential-library-tests}}/generated-tests.json

Reference harness author:
{{artifact_path:reference-harness-author}}/generated-tests.json

Differential lane authors:
{{artifact_path:differential-lane-author}}/generated-tests.json

Differential repair and report review:
{{artifact_path:differential-repair-and-report-review}}/generated-tests.json

Round trip:
{{artifact_path:round-trip}}/generated-tests.json

Workflow property tests:
{{artifact_path:workflow-property-based-tests}}/generated-tests.json

Time-warp sequences:
{{artifact_path:time-warp-sequences}}/generated-tests.json

Stateful invariant coverage:
{{artifact_path:stateful-invariant-coverage}}/generated-tests.json

Implemented invariant properties:
{{artifact_path:stateful-invariant-implement-properties}}/generated-tests.json

Invariant campaign:
{{artifact_path:stateful-invariant-campaign}}/generated-tests.json

Expand coverage:
{{artifact_path:expand-coverage}}/generated-tests.json

Admin/config boundaries:
{{artifact_path:admin-config-boundaries}}/generated-tests.json

External dependency boundaries:
{{artifact_path:external-dependency-boundaries}}/generated-tests.json

AMM boundary liquidity:
{{artifact_path:amm-boundary-liquidity}}/generated-tests.json

Payable/fallback accounting:
{{artifact_path:payable-fallback-accounting}}/generated-tests.json

Externalized-state accounting:
{{artifact_path:externalized-state-accounting}}/generated-tests.json

Packed action parity:
{{artifact_path:packed-action-parity}}/generated-tests.json

Batch atomicity unsupported actions:
{{artifact_path:batch-atomicity-unsupported-actions}}/generated-tests.json

Router exact accounting:
{{artifact_path:router-exact-accounting}}/generated-tests.json

Rounding direction audit:
{{artifact_path:rounding-direction-audit}}/generated-tests.json

Market exhaustion boundaries:
{{artifact_path:market-exhaustion-boundaries}}/generated-tests.json

Order replacement collateral:
{{artifact_path:order-replacement-collateral}}/generated-tests.json

State machine boundaries:
{{artifact_path:state-machine-boundaries}}/generated-tests.json

Lifecycle view boundaries:
{{artifact_path:lifecycle-view-boundaries}}/generated-tests.json

Dynamic strategy generator:
{{artifact_path:dynamic-strategy-generator}}/generated-tests.json

Use only files reported by strategy-owned generated-test manifests. Read every
manifest listed above, including empty manifests. Require the exact
`ultrafuzz.generated-tests.v3` shape and treat its required `generated_tests`
and `support_files` arrays together as the complete source bundle. Reject a
manifest with a path repeated within or across the arrays, with one file path
as the slash-delimited prefix of another, or with non-empty `support_files` and
no runnable `generated_tests`. Ignore any non-canonical file list arrays. Do
not rely on the current working tree or a strategy workspace scan as a
substitute for a missing manifest entry.

For every entry in either array, accept the exact byte-for-byte companion only
when its `path` is a normalized relative POSIX path beginning with
`generated-tests/`, contains no empty, `.` or `..` segment or backslash, and
resolves to a non-empty strict UTF-8 text regular file inside the source node's
artifact directory. This text-only rule also applies to data fixtures. Reject
absolute paths, path escapes, and every symlink even when its
target remains inside the artifact directory. Require both `size_bytes` and
`sha256` to be present and to match the companion exactly. Record rejected
entries in `skipped_files` with the corresponding `generated-test` or
`support-file` kind; never search for or substitute another file with the same
basename. The manifest is one atomic bundle: if any entry fails these checks,
copy none of its entries and record every row from that manifest as skipped,
using the specific failure for invalid rows and a bundle-rejected reason for
the remaining rows.

Determine each bundle's destination from its runnable entries' `framework` and
`language`, checked against project discovery, base setup, and the target's
checked-in test configuration. Accept framework-native runnable test
extensions: Foundry `.t.sol`; Hardhat `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or
`.mts`; and Vyper projects' existing native Python test `.py` files. Infer a
missing framework only when the extension and discovered test stack identify
it unambiguously; otherwise skip the affected runnable entry with a reason. Do
not introduce a new framework or test root.

Copy Foundry tests under the configured Foundry aggregation destination (for
example `test/foundry/<strategy>/attempt-<n>/`). Copy Hardhat tests under the
repository's existing JavaScript or TypeScript test root and Vyper tests under
its existing pytest, Ape, Brownie, or other native test root, in both cases
using `ultrafuzz/<strategy>/attempt-<n>/` below that root. Treat each accepted
manifest as one atomic bundle: copy its accepted runnable tests and all required
support files beneath one destination root while preserving every companion's
relative tail below `generated-tests/`, so relative imports continue to
resolve. Keep every destination under `{{workspace_path}}`. Use a stable
source-derived suffix on the whole bundle when two manifests would otherwise
collide; never flatten files or overwrite one entry with another.

Preserve attribution by strategy id, source node id, attempt index, source
manifest path, source artifact path, source relative path, and destination path.
Also preserve every manifest entry's `language`, `framework`, `description`,
and `provenance` fields without rewriting them. Do not copy unknown manifest
entry fields into `aggregation.json`.

Do not merge, rewrite, or "fix" generated test logic during aggregation. The
isolated workspace may receive unstaged generated test files, but the git index
must not be staged or otherwise changed.

Before finishing, verify from `{{workspace_path}}` that each copied
`destination_relative_path` exists in the workspace and that each
`destination_path` is an absolute path under `{{workspace_path}}`, not under
`{{repo_path}}`. Prefer the Read tool for spot checks; when checking file sizes
with Bash, use one standalone `wc -c <destination_path>` command per file or
per small group of files, with no pipes or command chaining.

Save the aggregation manifest to {{artifact_path}}/aggregation.json as JSON with this shape:

- `schema_version`: `"ultrafuzz.aggregation-manifest.v1"`
- `source_generated_tests`: total number of manifest `generated_tests` entries considered
- `copied_generated_tests`: number of framework-native test files copied into the workspace
- `source_support_files`: total number of manifest `support_files` entries considered, or `0`
- `copied_support_files`: number of explicitly manifested native support files copied into the workspace, or `0`
- `source_bundles`: one record for every listed `generated-tests.json`, including
  empty manifests. Each record requires the source manifest's logical
  `strategy`/`node_id`, exact source artifact-directory basename as
  `source_attempt_id`, exact `attempt_index`, absolute `source_manifest_path`,
  artifact-relative `source_manifest_relative_path`, lowercase digest of the
  exact manifest bytes as `source_manifest_sha256`, manifest `run_id` as
  `source_run_id`, exact `generated_test_count` and `support_file_count`, and a
  `disposition` of `empty`, `copied`, or `skipped`. A `skipped` bundle requires
  one non-empty `reason`; `empty` and `copied` bundles must omit `reason`.
- `files`: copied runnable-test rows. Every row requires `strategy`, `node_id`,
  `source_attempt_id`, `attempt_index`, `source_manifest_path`,
  `source_manifest_relative_path`, `source_manifest_sha256`, absolute
  `source_artifact_path`, `source_relative_path`, positive `size_bytes`,
  lowercase `sha256`, absolute `destination_path`, and workspace-relative
  `destination_relative_path`. Preserve `language`, `framework`, `description`,
  and `provenance` exactly when the source entry contains them; omit each field
  when the source entry omits it.
- `support_files`: copied support-file rows with the same exact source,
  destination, digest, size, and optional metadata fields as `files`, or `[]`.
- `skipped_files`: skipped source rows with the same exact source identity,
  source artifact path, digest, size, and optional metadata fields as copied
  rows, plus required `kind` (`generated-test` or `support-file`) and non-empty
  `reason`; skipped rows have no destination fields.

Every considered source entry appears exactly once across its typed copied
array or `skipped_files`; do not omit, fabricate, duplicate, or swap the kind
of an entry. A bundle is atomic: `copied` means all of its generated tests and
support files appear once in their copied arrays and none are skipped;
`skipped` means all appear once in `skipped_files` and none are copied; `empty`
means both source counts are zero and no row refers to the bundle.
`source_generated_tests` and `source_support_files` equal the sums of the
corresponding `source_bundles` counts. The copied counts equal their
corresponding copied-array lengths. Keep all four arrays whole-item unique and
keep source identities unique across the copied/skipped union.
