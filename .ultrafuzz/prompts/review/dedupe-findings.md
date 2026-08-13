---
id: dedupe-findings
display_name: Dedupe findings
---

# Dedupe findings

Your job is to collapse duplicate findings that describe the same root behavior while preserving enough metadata to audit what was removed.

The declared outputs are `deduped-findings.json`, `strategy-detections.json`,
and `finding-lifecycle-ledger.json`. Do not write prompt-only `findings.json`,
`duplicates.json`, or alternate compatibility handoffs.

Inspect every rendered input before deduping. The list is derived from the
effective topology and includes every direct producer's declared handoffs:

{{ancestor_artifacts}}

When the list includes project-discovery or base-test setup handoffs, read them
before validation so the repository's checked-in test framework and native test
root determine the runner. A bounded topology may intentionally omit those
handoffs. When they are absent, do not treat the omission as an error and do not
run native tests during dedupe; perform one model-only consolidation pass over
the rendered finding inputs instead.

When native validation context is present, validate only focused generated
tests or reproducers that contribute to the dedupe result. Dispatch each
validation through the existing framework recorded by project discovery, the
base setup, and the generated-test manifest:

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
`generated-tests.json` to validate against the exact pinned
`{{schema_path}}/generated-tests.schema.json`. That schema alone defines the
manifest version, fields, types, enums, required members, and empty bundle.
Treat the schema-defined runnable and support entries together as the complete bundle, copy
every exact byte-for-byte canonical companion into one deterministic bundle
root under the existing native test root in `{{workspace_path}}`, and execute
only the selected runnable entries: use
`ultrafuzz/dedupe/<source-node-id>/attempt-<n>/<safe-relative-tail>` below that
root while preserving each path's relative tail below `generated-tests/` so
relative imports continue to resolve. Do not execute a non-runnable support entry.
Do not write to `{{repo_path}}`, stage copied files, introduce a new test root,
or overwrite another companion; use a stable source-derived suffix for a
deterministic collision.

Accept the bundle only when every schema-defined entry resolves to its exact
non-empty strict UTF-8 regular-file companion inside that source node's
artifact directory and the recorded byte length and digest match. Reject path
escapes, every symlink even
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

Then, build a stable dedupe key from the affected contract or library, function or workflow, property/oracle, normalized title, root cause hypothesis, and reproduction shape. Keep the clearest finding with the best evidence and reproducibility. Record every duplicate with its original id, kept id, title, and dedupe key.

When several proven findings share the same production root cause but exercise
meaningfully different boundaries, actors, states, or PoC shapes, keep one
root finding and express the rest as a finding family instead of emitting
separate root issues. Use the pinned findings schema's family representation,
give the family a stable identity, and preserve each proven variant's identity,
explanation, dedupe key, available provenance, evidence, and reproduction
metadata.

Use the pinned schema's related-finding representation only for adjacent or
similar surfaces that are useful to link but are not proven to share the same
root cause. Preserve the related finding's identity, relationship, explanation,
and dedupe evidence. Do not merge a related finding into the confirmed root
issue merely because it uses a neighboring entrypoint, workflow phase, actor,
asset, test shape, or symptom. A concrete terminal-state failure should stay
scoped to the proven terminal condition unless the artifacts prove the same
root cause across the broader state space.

Save the full schema-defined deduplicated findings artifact, including candidates that
may later triage as non-production outcomes, only to
{{output_stage_findings_path}}. Every kept finding's `dedupe_key` must be
exactly equal as JSON to the corresponding `dedupe_key` on its lifecycle record
and on the `strategy-detections.json` row at the same position. The key is not
ledger-only metadata: missing or unequal kept-finding provenance fails lifecycle
reconciliation, and the failure is reported against every lifecycle record
rather than against the finding. Keep the dedupe keys unique across the kept
finding population. Carry duplicate and family details in the canonical finding
fields and lifecycle ledger.

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
production root cause. Save {{artifact_path}}/strategy-detections.json using
the exact pinned `{{schema_path}}/strategy-detections.schema.json`; it alone
defines the JSON shape. Emit one detection record per deduped root or family
key. Its key, finding identity, title, optional family identity, and complete
strategy-hit provenance must agree with the kept finding and lifecycle record.

Count each strategy loop attempt only once for the same deduped bug. Do not
rename this metric Temperature.

Also save {{artifact_path}}/finding-lifecycle-ledger.json using the exact
pinned `{{schema_path}}/finding-lifecycle-ledger.schema.json`; it alone defines
the JSON shape. For each deduped root or family, preserve every contributing
raw source artifact and its primary, duplicate, or family-variant relationship;
copy the complete strategy-hit set used by the matching detection; preserve
duplicate and family identities; and record the raw-to-deduped stage history.

Keep the lifecycle record array in exactly the same order as
`deduped-findings.json`, with one record per finding. In each record, write one
`raw` stage for every `source_artifacts` entry in the same order, using that
entry's exact `path` and `finding_id`, followed by exactly one `deduped` stage
whose `artifact_path` is the portable declared output-relative path
`{{output_stage_findings_relative_path}}` and whose `finding_id` is the kept
finding ID. Do not write triage, severity, disposition, comparison, or later
stage fields during dedupe. In particular, remove `triage_classification` from
a dedupe lifecycle record even if an input carries it; preserving that field
would still author a later-stage value at the dedupe stage. The matching
`strategy-detections.json` entry must have the same order, `dedupe_key`, finding
ID, title, optional family ID, and exact hit array as the lifecycle record.

After writing the required artifacts, run every exact
`ultrafuzz json validate` command rendered for them in the central output
contract, then stop. Correct an exit-1 artifact yourself and rerun its command
after any later edit. Do not spend the finalization reserve on broad
re-verification once the required artifacts pass their commands.

Record the focused native compilation or test result, but do not fix failing
tests or edit production code. Do not mutate the target workspace's dependency
state during verification.
