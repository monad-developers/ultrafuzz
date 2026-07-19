---
id: dedupe-findings
display_name: Dedupe findings
---

# Dedupe findings

Your job is to collapse duplicate findings that describe the same root behavior while preserving enough metadata to audit what was removed.

Restart handling: if {{artifact_path}}/deduped-findings.json,
{{artifact_path}}/findings.json, {{artifact_path}}/strategy-detections.json,
and {{artifact_path}}/duplicates.json already exist, first validate their
required JSON shapes (`deduped-findings.json`, `findings.json`, and
`strategy-detections.json` are arrays; `duplicates.json` is an object or array).
If those shapes are valid and the files do not clearly contradict the required
schema, treat them as the materialized dedupe result for this node, refresh only
missing required files, and finish. Do not rebuild the dedupe from scratch,
rerun Forge, edit generated tests, or perform optional post-write validation
unless one of those files is missing, invalid, or clearly contradicts the
required schema.

Run Forge tests and count failing tests. If Foundry dependencies are missing,
restore project-pinned dependencies first, such as
`git submodule update --init --recursive lib/forge-std` when `.gitmodules`
contains that path. Do not run `forge install` or rewrite `foundry.lock` when a
pinned dependency path already exists.

Run `forge --version` as a separate Bash call before any Forge invocation. If
`forge` is available in `PATH`, run focused tests with direct `forge` commands
while preserving the original command's environment variables, flags, match
selectors, and test-root semantics. Do not add inline environment assignment
prefixes to focused test commands; commands should start with `forge` so backend
allowlists match them. Do not use command substitution, shell conditionals,
absolute binary paths, or host-global searches to resolve Foundry. If `forge`
is unavailable in `PATH`, record validation as blocked by tool availability and
do not classify
`forge: command not found` as a failing test count.

Also inspect the Dynamic strategy generator outputs before deduping:

Dynamic strategy plan:
{{artifact_path:dynamic-strategy-generator}}/strategy-plan.json

Dynamic selected strategies:
{{artifact_path:dynamic-strategy-generator}}/selected-strategies.json

Dynamic findings:
{{artifact_path:dynamic-strategy-generator}}/findings.json

Dynamic generated-test manifest:
{{artifact_path:dynamic-strategy-generator}}/generated-tests.json

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
`dedupe_key`. For each deduped root/family, record:

- `source_artifacts`: every raw finding artifact that contributed to the kept
  root, duplicate, or family variant, with `path`, `node_id`, `finding_id`,
  `title`, and `relationship` (`primary`, `duplicate`, or `family-variant`).
- `strategy_hits`: the same complete hit array written to
  `strategy-detections.json`.
- `duplicate_finding_ids` and `family_variant_keys` when applicable.
- `stages`: at least one `raw` stage for each source artifact plus one
  `deduped` stage for the kept record.

After writing the required artifacts, run only a small number of direct JSON
shape checks, then stop. Do not spend the finalization reserve on broad
re-verification once the required artifacts are present and parseable.

Make sure compilation is passing but do not fix any failing tests. Dependency
hydration used only to run verification is not a target workspace change; do
not include lockfile or dependency-vendor drift in the reported artifacts.
