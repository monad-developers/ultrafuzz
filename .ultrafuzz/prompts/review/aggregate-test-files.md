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

Strategy generated-test manifests declared by ancestor nodes in the effective
topology:

{{ancestor_generated_test_manifests}}

When the list above renders the no-match sentinel
`None declared by this topology.`, no ancestor declares a generated-test
manifest: copy nothing and write the schema-defined empty `aggregation.json`
with zero source bundles. That is a successful aggregation for a findings-only
topology, not an error.

Use only files reported by strategy-owned generated-test manifests. Read every
manifest listed above, including empty manifests. Validate each one against the
exact pinned `{{schema_path}}/generated-tests.schema.json`; that schema alone
defines its JSON version, fields, types, enums, required members, and empty
bundle. Treat the schema-defined runnable and support entries together as one
atomic source bundle. Bind its one framework to the checked-in native framework
for the whole bundle. Do not rely on the current working tree, a non-canonical
file list, or a strategy workspace scan as a substitute for a missing manifest
entry.

For every schema-defined entry, accept the exact byte-for-byte companion only
when it resolves to a non-empty strict UTF-8 text regular file inside the source
node's artifact directory. This text-only rule also applies to data fixtures.
Reject path escapes, every symlink even when its target remains inside
the artifact directory, and every multiply linked file. Require both
the recorded byte size and digest to match the companion exactly.
Record rejected entries in `skipped_files` with the corresponding
`generated-test` or `support-file` kind; never search for or substitute another
file with the same basename. The manifest is one atomic bundle: if any entry
fails these checks, copy none of its entries and record every row from that
manifest as skipped, using the specific failure for invalid rows and a
bundle-rejected reason for the remaining rows.

Determine each bundle's destination from its required root-level `framework`,
checked against project discovery, base setup, and the target's checked-in test
configuration. Use an entry's optional `language` only as corroborating
metadata. Accept framework-native runnable test extensions: Foundry `.t.sol`;
Hardhat `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`; and Vyper projects'
existing native Python test `.py` files. Never infer, synthesize, normalize, or
convert a missing or mismatched framework. If the declared bundle framework is
missing, invalid, mixed, or incompatible with the checked-in test stack, skip
the whole bundle. Do not introduce a new framework or test root.

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
Copy each row's `strategy` and `node_id` byte-for-byte from the value of the
source manifest's own root-level `node_id`; that value is the logical producer
node this topology declares and may be any strategy id. Read `source_run_id`
and `framework` from that same manifest's root fields. Never derive a source
identity from a destination path, from a copy-layout directory segment such as
`attempt-<n>`, from an ordinal, or from this aggregating node's own id, and
never abbreviate, normalize, or reorder it.
Preserve the manifest's one `framework` only on its `source_bundles` record.
Preserve every entry's `language`, `description`, and `provenance` fields without
rewriting them; copied and skipped entry rows must not repeat `framework`. Do
not copy unknown manifest entry fields into `aggregation.json`.

Do not merge, rewrite, or "fix" generated test logic during aggregation. The
isolated workspace may receive unstaged generated test files, but the git index
must not be staged or otherwise changed.

Before finishing, verify from `{{workspace_path}}` that each copied
`destination_relative_path` exists in the workspace and that each
`destination_path` is an absolute path under `{{workspace_path}}`, not under
`{{repo_path}}`. Prefer the Read tool for spot checks; when checking file sizes
with Bash, use one standalone `wc -c <destination_path>` command per file or
per small group of files, with no pipes or command chaining.

Save the aggregation manifest to {{artifact_path}}/aggregation.json. Read the
exact pinned `{{schema_path}}/aggregation-manifest.schema.json`; it alone
defines the JSON version, fields, types, enums, required members, and empty
forms. Record one source-bundle row for every declared manifest, including an
empty or rejected bundle. Bind each row to the source manifest's logical node,
attempt, run, framework, exact path, immutable digest, entry counts, and actual
disposition. For copied and skipped entries, preserve the source identity,
attempt, manifest identity, artifact-relative path, byte size, digest, and any
source metadata exactly; add destination identity only to copied entries and a
specific reason only to skipped entries. Preserve the source framework at the
bundle level rather than copying it onto individual entry rows.

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

After the final write, run the exact `ultrafuzz json validate` command rendered
for `aggregation.json` in the central output contract. Correct any exit-1
artifact yourself and rerun its command after any later edit.
