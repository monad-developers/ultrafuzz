---
id: dedupe-findings
display_name: Dedupe findings
---

# Dedupe findings

Your job is to collapse duplicate findings that describe the same root behavior while preserving enough metadata to audit what was removed.

Restart handling: if {{artifact_path}}/deduped-findings.json,
{{artifact_path}}/findings.json, {{artifact_path}}/strategy-detections.json,
{{artifact_path}}/finding-lifecycle-ledger.json, and
{{artifact_path}}/duplicates.json already exist, first validate their
required JSON shapes (`deduped-findings.json`, `findings.json`, and
`strategy-detections.json` are arrays; `duplicates.json` is an object or array;
`finding-lifecycle-ledger.json` is an object whose `records` array covers every
upstream finding exactly once). Rebuild rather than finish if the ledger is
truncated, has an empty `records` array while upstream findings exist, or leaves
any upstream finding unaccounted for.
If those shapes are valid and the files do not clearly contradict the required
schema, treat them as the materialized dedupe result for this node, refresh only
missing required files, and finish. Do not rebuild the dedupe from scratch,
rerun native tests, edit generated tests, or perform optional post-write validation
unless one of those files is missing, invalid, or clearly contradicts the
required schema.

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
workspace file. Before focused validation, read the strategy-owned
`generated-tests.json` entry and copy only its exact byte-for-byte canonical
companion into a deterministic path under the existing native test root in
`{{workspace_path}}`: use
`ultrafuzz/dedupe/<source-node-id>/attempt-<n>/<safe-relative-tail>` below that
root. Do not write to `{{repo_path}}`, stage the copied file, introduce a new
test root, or overwrite another companion; use a stable source-derived suffix
for a deterministic collision.

Accept a companion only when the manifest `path` is a normalized relative POSIX
path beginning with `generated-tests/`, contains no empty, `.` or `..` segment
or backslash, and resolves to a regular file inside that source node's artifact
directory. Reject absolute paths, path escapes, and every symlink even when its
target remains inside the artifact directory. Never search a strategy workspace,
the dedupe workspace, sibling runs, or the host for a missing companion. If the
canonical companion or an existing native destination root is unavailable,
record focused validation as blocked. Require the companion extension to match
the selected existing framework: `.t.sol` for Foundry; `.js`, `.cjs`, `.mjs`,
`.ts`, `.cts`, or `.mts` for Hardhat; and `.py` for a Vyper project's native
Python harness.

For mixed repositories, dispatch each generated test according to its manifest
`framework` and `language`, confirmed against the checked-in configuration;
never coerce every test through one runner. If those fields are absent, infer a
runner only from an unambiguous native extension plus the discovered existing
test stack. Otherwise record validation as blocked instead of guessing.

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

Save the full deduplicated finding array, including candidates that may later
triage as non-production outcomes, to {{artifact_path}}/deduped-findings.json.
This file is validated as a normalized finding array, so every retained object
must carry `schema_version`, `id`, `title`, `status`, `severity_guess`,
`confidence`, and `summary`, plus its `source_nodes` union. Carry each through
from the finding you kept rather than inventing a new value.
Also save the same array to {{artifact_path}}/findings.json when a generic
findings handoff is useful. Save duplicate and family audit details to a
separate {{artifact_path}}/duplicates.json object or array; do not replace
`deduped-findings.json` with an audit object.

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

Treat each input finding's runtime-normalized `producer_node_id`,
`source_nodes`, and compatibility `source_node_id` as provenance, not agent
commentary. For every retained root, form a stable first-seen union of every
contributing finding's `source_nodes` (or legacy `source_node_id`). Write the
union to `source_nodes` and its first entry to `source_node_id`; never replace
the discovery sources with `dedupe-findings` or a dynamic group ID. Record each
nested family variant's and duplicate audit record's own source union on that
nested object, which never narrows the root's own `source_nodes`.

A retained root's `source_nodes` must be exactly the set of `node_id` values in
its own ledger record's `source_artifacts` — no more and no less. That includes
the node of every family variant nested inside it, because those artifacts
belong to the root's record. Do not add the node of a `related_findings` entry
you deliberately did not merge, and do not add a corroborating node that has no
`source_artifacts` entry in that record.

For every deduped finding, preserve the strategy and loop-attempt provenance of
the kept finding plus every matching duplicate or family variant for the same
production root cause. Save
{{artifact_path}}/strategy-detections.json as a JSON array with one object per
deduped root or family key:

- `dedupe_key`: the stable key for the deduped bug instance.
- `finding_id`: the kept finding id when available.
- `family_id`: the shared family id when the finding has family variants.
- `title`: the kept finding title.
- `hits`: array of every strategy hit that found the same bug, each with
  `strategy`, `attempt_index`, `model_id`, `model`, `model_index`, and
  `loop_index` when those fields are available.

Count each strategy loop attempt only once for the same deduped bug. Do not
rename this metric Temperature.

Also save {{artifact_path}}/finding-lifecycle-ledger.json. It must be a JSON
object with `schema_version: "1.0"` and a `records` array keyed by
`dedupe_key`. Every record carries a `dedupe_key`, including the
coverage-only ones described below. For each deduped root/family, record:

- `source_artifacts`: every raw finding artifact that contributed to the kept
  root, duplicate, or family variant, with `path`, `node_id`, `finding_id`,
  `title`, and `relationship` (`primary`, `duplicate`, or `family-variant`).
- `strategy_hits`: the same complete hit array written to
  `strategy-detections.json`.
- `duplicate_finding_ids` and `family_variant_keys` when applicable.
- `stages`: at least one `raw` stage for each source artifact plus one
  `deduped` stage for the kept record.

Write the record's `dedupe_key` onto the kept finding in
`deduped-findings.json` as its own `dedupe_key` field, byte-for-byte identical.
Provenance is matched on finding identity, so a root whose `source_nodes` spans
more than one upstream node resolves to its ledger record only through that
shared key; without it the merge is rejected as not preserving the exact
discovery-source union.

Every finding in every dependency `findings.json` enumerated above must appear
exactly once across all `source_artifacts` in the ledger, including the ones you
recorded only as a duplicate or family variant and the ones you judged
unsupported. Coverage is checked against what the runtime read, not against the
lanes you chose to inspect, so a missing or doubly-claimed source fails the node.

What the runtime read never includes a goal search lane whose result was not
published and verified. Such a lane carries no coverage obligation: it
contributes no finding to account for, and whatever bytes an interrupted goal
worktree happens to hold were never published or contract-verified, so they are
not provenance. Do not invent a ledger record for it, and do not attach it to an
unrelated root to make a lane count come out even.

Never treat a goal lane that did not complete as a zero-finding source. A goal
search may end without returning while the run continues, and every goal lane's
outputs are pre-seeded with a contract-valid empty findings array, so an empty
`findings.json` is not by itself evidence that a goal was searched. A lane with
no agent output row was stopped early and searched nothing, which is a different
fact from a lane that ran, published a verified result, and reported `[]`. Only
the second is a negative result, and only the second is coverage.

The runtime records which is which in its own goal search coverage census,
`goal-search-coverage.json` next to `{{run_metadata_path}}`, under schema
`ultrafuzz.goal-search-coverage.v1`. Each of its `goals` entries carries a
`status` of `stopped-early`, `unverified`, `completed-with-findings`,
`completed-no-findings`, or `completed`, and only the `completed` statuses are
searched goals. Read it when you need to know whether a quiet goal lane was
searched, and prefer it to any inference from the handoff directories you can
see. Do not describe a `stopped-early` or `unverified` lane as searched,
covered, or clean in any artifact you write, and do not let its seeded empty
array widen the apparent breadth of the dedupe result.

Write `node_id` by copying the producing node out of the finding itself, from
its own `source_nodes` entry or `producer_node_id`. Never write the group
template ID, and never write a directory name taken from the artifact path; for
a generated child those differ from the ID the finding reports. Write
`finding_id` as that finding's own `id`.

A finding you judged unsupported still needs coverage. Give it its own ledger
record with no retained finding rather than attaching it to an unrelated root,
so no retained root's `source_artifacts` names a node that did not contribute
to it. That record still needs its own `dedupe_key`, and every `dedupe_key` in
the ledger must be unique: two records sharing one are read as a single
provenance claim and fail the node.

After writing the required artifacts, run only a small number of direct JSON
shape checks, then stop. Do not spend the finalization reserve on broad
re-verification once the required artifacts are present and parseable.

Record the focused native compilation or test result, but do not fix failing
tests or edit production code. Do not mutate the target workspace's dependency
state during verification.
