---
id: dedupe-findings
display_name: Dedupe findings
---

# Dedupe findings

Your job is to collapse duplicate findings that describe the same root behavior while preserving enough metadata to audit what was removed.

The declared outputs are `deduped-findings.json`, `strategy-detections.json`,
and `finding-lifecycle-ledger.json`. Do not write prompt-only `findings.json`,
`duplicates.json`, or alternate compatibility handoffs.

Read the project-discovery and base-test handoffs before validation so the
repository's checked-in test framework and native test root determine the
runner:

Project discovery:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Base test setup (when rendered):
{{artifact_path:base-test-setup}}/setup/base-test-setup.md

Validate only focused generated tests or reproducers that contribute to the
dedupe result. Dispatch each validation through the existing framework recorded
by project discovery, the base setup, and the generated-test manifest:

- For Foundry, run `forge --version` as a separate Bash call, then direct
  focused `forge` commands that preserve the original environment variables,
  flags, match selectors, and test-root semantics.
- For Hardhat, use only the repository's existing package-manager script or
  already-installed local Hardhat executable and its existing JavaScript or
  TypeScript test root. Do not use `npx` or introduce a Foundry harness.
- For Vyper, use only the existing checked-in pytest, Ape, Brownie, or other
  native runner command and test root recorded by the handoffs.

Strategy workspaces are isolated from this node. Never assume a generated test
already exists in the dedupe workspace and never validate a stale same-named
workspace file. Before focused validation, require the strategy-owned
`generated-tests.json` to have the exact `ultrafuzz.generated-tests.v3` shape
with one required root-level `framework` and its required `generated_tests` and
`support_files` arrays. The root `framework` must match
`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`, identify the one native framework for
the whole atomic bundle, remain present on an empty bundle, and never appear on
an individual entry. Treat both arrays together as the complete bundle, copy
every exact byte-for-byte canonical companion into one deterministic bundle
root under the existing native test root in `{{workspace_path}}`, and execute
only the selected runnable entries from `generated_tests`: use
`ultrafuzz/dedupe/<source-node-id>/attempt-<n>/<safe-relative-tail>` below that
root while preserving each path's relative tail below `generated-tests/` so
relative imports continue to resolve. Do not execute a `support_files` entry.
Do not write to `{{repo_path}}`, stage copied files, introduce a new test root,
or overwrite another companion; use a stable source-derived suffix for a
deterministic collision.

Accept the bundle only when every entry contains a normalized relative POSIX
`path` beginning with `generated-tests/`, exact positive `size_bytes`, and exact
lowercase `sha256`; paths must be unique across both arrays and no file path may
be the slash-delimited prefix of another. Each path must contain no empty, `.`
or `..` segment or backslash and resolve to a non-empty strict UTF-8 regular
file inside that source node's artifact directory whose byte length and digest
exactly match the entry. Reject absolute paths, path escapes, every symlink even
when its target remains inside the artifact directory, and every multiply
linked file. Never search a strategy workspace, the dedupe workspace, sibling
runs, or the host for a missing companion. If any canonical companion or an
existing native destination root is unavailable, record focused validation as
blocked without partially copying the bundle. Require each selected runnable
companion extension to match the existing framework: `.t.sol` for Foundry;
`.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts` for Hardhat; and `.py` for a
Vyper project's native Python harness.

For mixed repositories, dispatch every generated test in a bundle according to
the manifest's one root-level `framework`, confirmed against the checked-in
configuration; use optional entry-level `language` only as corroborating
metadata and never coerce every bundle through one runner. Do not infer,
synthesize, normalize, or convert a missing or mismatched framework. If the
bundle framework is absent, invalid, mixed, or incompatible with the checked-in
test stack, record validation as blocked instead of guessing.

Never install, fetch, restore, or update dependencies during dedupe. This
includes `forge install`, `git submodule update`, `npm install`, `pnpm install`,
`yarn install`, `bun install`, `pip install`, and tool bootstrap commands. Do
not rewrite lockfiles or dependency-vendor directories. If a required runner or
pinned dependency is unavailable locally, record that validation as blocked by
tool availability; do not count runner or dependency failure as a target test
failure.

For every native runner, use direct focused commands. Do not use command
substitution, shell conditionals, absolute binary paths, host-global searches,
or inline environment-assignment prefixes. Preserve the original command's
environment, selectors, and test-root semantics, count actual failing tests,
and keep framework-specific blocked and failing results distinct.

Inspect every direct strategy handoff before deduping. This list is derived
from the effective topology and includes each producer's declared findings,
generated-test manifests, campaign evidence, and supporting outputs:

{{ancestor_artifacts}}

Then, build a stable dedupe key from the affected contract or library, function or workflow, property/oracle, normalized title, root cause hypothesis, and reproduction shape. Keep the clearest finding with the best evidence and reproducibility. Record every duplicate with its original id, kept id, title, and dedupe key.

When several proven findings share the same production root cause but exercise
meaningfully different boundaries, actors, states, or PoC shapes, keep one
root finding and express the rest as a finding family instead of emitting
separate root issues. Add a stable `family_id` to the kept root finding and put
the proven variants in `family_variants`. Each variant should include `id`,
`title`, `summary`, `dedupe_key`, and any available provenance fields:
`strategy`, `attempt_index`, `model_id`, `model`, `model_index`, and
`loop_index`. Preserve evidence and reproduction metadata when available.

Use `related_findings` only for adjacent or similar surfaces that are useful to
link but are not proven to share the same root cause. Each related finding
should include `id`, `title`, `relationship`, `summary`, and `dedupe_key` when
available. Do not merge a related finding into the confirmed root issue merely
because it uses a neighboring entrypoint, workflow phase, actor, asset, test
shape, or symptom. A concrete terminal-state failure should stay scoped to the
proven terminal condition unless the artifacts prove the same root cause across
the broader state space.

Save the full deduplicated canonical finding v2 array, including candidates that
may later triage as non-production outcomes, only to
{{output_stage_findings_path}}. Every kept finding object must carry its own
top-level `dedupe_key`, byte-for-byte the same string as the `dedupe_key` on its
lifecycle record and on its `strategy-detections.json` row at the same array
index. The key is not ledger-only metadata: a kept finding without a top-level
`dedupe_key` fails lifecycle reconciliation, and the failure is reported against
every lifecycle record rather than against the finding. Keep each `dedupe_key`
unique across the array. Carry duplicate and family details in the canonical
finding fields and lifecycle ledger.

Do not discard unique symptoms merely because they come from the same strategy.
Do not hide failing tests. Dedupe is only for equivalent findings or proven
same-root family variants, not for minimizing uncomfortable evidence.

Stateful invariant failure records are first-class findings. If a finding's
`notes` contain `stateful_failure_classification=<classification>`, preserve
that token, its reproducer command/path, raw evidence, status, and notes on the
kept finding. Do not drop or merge away distinct stateful records merely because
the same coverage campaign later reached its coverage target. Include the
classification and reproducer shape in the dedupe key whenever two stateful
records differ by classification, replayability, or repairability, including
`blocked-unreproduced` records that still need manual replay.

Preserve `property_ids` on every property-derived finding. When deduplicating
several records into one root or family, use the stable union of their canonical
property IDs on the kept record and relevant family variants; do not discard a
property reference during deduplication.

For every deduped finding, preserve the strategy and loop-attempt provenance of
the kept finding plus every matching duplicate or family variant for the same
production root cause. Save
{{artifact_path}}/strategy-detections.json as a JSON array with one object per
deduped root or family key:

- `dedupe_key`: the stable key for the deduped bug instance, identical to the
  kept finding's top-level `dedupe_key` and to its lifecycle record key.
- `finding_id`: the kept finding id when available.
- `family_id`: the shared family id when the finding has family variants.
- `title`: the kept finding title.
- `hits`: array of every strategy hit that found the same bug, each with
  `strategy`, `attempt_index`, `model_id`, `model`, `model_index`, and
  `loop_index` when those fields are available.

Count each strategy loop attempt only once for the same deduped bug. Do not
rename this metric Temperature.

Also save {{artifact_path}}/finding-lifecycle-ledger.json. It must be a JSON
object with `schema_version: "ultrafuzz.finding-lifecycle-ledger.v1"` and a `records` array keyed by
`dedupe_key`. For each deduped root/family, record:

- `source_artifacts`: every raw finding artifact that contributed to the kept
  root, duplicate, or family variant, with `path`, `node_id`, `finding_id`,
  `title`, and `relationship` (`primary`, `duplicate`, or `family-variant`).
- `strategy_hits`: the same complete hit array written to
  `strategy-detections.json`.
- `duplicate_finding_ids` and `family_variant_keys` when applicable.
- `stages`: at least one `raw` stage for each source artifact plus one
  `deduped` stage for the kept record.

Keep the lifecycle record array in exactly the same order as
`deduped-findings.json`, with one record per finding. In each record, write one
`raw` stage for every `source_artifacts` entry in the same order, using that
entry's exact `path` and `finding_id`, followed by exactly one `deduped` stage
whose `artifact_path` is the portable declared output-relative path
`{{output_stage_findings_relative_path}}` and whose `finding_id` is the kept
finding ID. Do not write triage, severity, disposition, comparison, or later
stage fields during dedupe. The matching `strategy-detections.json` entry must
have the same order, `dedupe_key`, finding ID, title, optional family ID, and
exact hit array as the lifecycle record.

After writing the required artifacts, run only a small number of direct JSON
shape checks, then stop. Do not spend the finalization reserve on broad
re-verification once the required artifacts are present and parseable.

Record the focused native compilation or test result, but do not fix failing
tests or edit production code. Do not mutate the target workspace's dependency
state during verification.
