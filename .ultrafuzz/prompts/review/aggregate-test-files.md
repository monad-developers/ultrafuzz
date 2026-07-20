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
manifest listed above, including empty manifests. Treat each manifest's
`generated_tests` array as the source of truth and ignore any non-canonical file
list arrays. Do not rely on the current working tree or a strategy workspace
scan as a substitute for a missing manifest entry.

For each `generated_tests` entry, accept the exact byte-for-byte companion only
when its `path` is a normalized relative POSIX path beginning with
`generated-tests/`, contains no empty, `.` or `..` segment or backslash, and
resolves to a regular file inside the source node's artifact directory. Reject
absolute paths, path escapes, and every symlink even when its target remains
inside the artifact directory. Record rejected entries in `skipped_files`;
never search for or substitute another file with the same basename.

Determine the destination from the entry's `framework` and `language`, checked
against project discovery, base setup, and the target's checked-in test
configuration. Accept framework-native test extensions: Foundry `.t.sol`;
Hardhat `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`; and Vyper projects'
existing native Python test `.py` files. Infer a missing framework only when the
extension and discovered test stack identify it unambiguously; otherwise skip
the entry with a reason. Do not introduce a new framework or test root.

Copy Foundry tests under the configured Foundry aggregation destination (for
example `test/foundry/<strategy>/attempt-<n>/`). Copy Hardhat tests under the
repository's existing JavaScript or TypeScript test root and Vyper tests under
its existing pytest, Ape, Brownie, or other native test root, in both cases
using `ultrafuzz/<strategy>/attempt-<n>/` below that root. Keep every destination
under `{{workspace_path}}`. Preserve the companion's relative tail when safe
and use a stable source-derived suffix when two entries would otherwise collide;
never overwrite one entry with another.

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

- `schema_version`: `"1.0"`
- `source_generated_tests`: total number of manifest `generated_tests` entries considered
- `copied_generated_tests`: number of framework-native test files copied into the workspace
- `source_support_files`: total number of manifest `support_files` entries considered, or `0`
- `copied_support_files`: number of explicitly manifested native support files copied into the workspace, or `0`
- `files`: array of copied native test records with `strategy`, `node_id`, `attempt_index`, `source_manifest_path`, `source_artifact_path`, `source_relative_path`, `destination_path`, `destination_relative_path`, `bytes`, and preserved `language`, `framework`, `description`, and `provenance` fields when present
- `support_files`: array of explicitly manifested native support-file records with the same attribution, path-safety, framework, and provenance fields as `files`, or `[]`
- `skipped_files`: array of skipped file records with `reason`, or `[]`
