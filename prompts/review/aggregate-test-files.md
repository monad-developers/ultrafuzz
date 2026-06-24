---
id: aggregate-test-files
display_name: Aggregate test files
---

# Aggregate test files

Your job is to collect generated Foundry `.t.sol` files from isolated strategy attempts and copy them deterministically into this node's isolated workspace.

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

Recon-fuzzer invariant campaign:
{{artifact_path:stateful-invariant-recon-campaign}}/generated-tests.json

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
manifest listed above, including empty manifests. Do not rely on the current
working tree or a strategy workspace scan as a substitute for a missing
manifest entry. Preserve attribution by strategy id, attempt index, source
artifact path, source relative path, and destination path. Copy under
`{{workspace_path}}/test/foundry/<strategy>/attempt-<n>/` or the configured
aggregation destination under `{{workspace_path}}`, using deterministic suffixes
when names collide.

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
- `source_test_files`: total number of manifest `test_files` entries considered
- `copied_test_files`: number of `.t.sol` test files copied into the workspace
- `source_support_files`: total number of manifest `support_files` entries considered, or `0`
- `copied_support_files`: number of helper `.sol` support files copied into the workspace, or `0`
- `files`: array of copied `.t.sol` test records with `strategy`, `node_id`, `attempt_index`, `source_manifest_path`, `source_artifact_path`, `source_relative_path`, `destination_path`, `destination_relative_path`, and `bytes`
- `support_files`: array of copied helper `.sol` records with the same fields as `files`, or `[]`
- `skipped_files`: array of skipped file records with `reason`, or `[]`
