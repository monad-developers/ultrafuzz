---
id: nofuzz-dedupe-findings
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
missing required files, and finish unless one of those files is missing,
invalid, or clearly contradicts the required schema.

Dedupe from written findings, source evidence, and
current-run strategy summaries.

Never install, fetch, restore, or update dependencies during dedupe. This
includes `forge install`, `git submodule update`, `npm install`, `pnpm install`,
`yarn install`, `bun install`, `pip install`, and tool bootstrap commands.
Do not rewrite lockfiles or dependency-vendor directories, and do not mutate the
target workspace's dependency state.

Inspect every direct strategy handoff before deduping. This list is derived
from the effective topology and includes each producer's declared findings,
source evidence, and supporting outputs:

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
Also save the same array to {{artifact_path}}/findings.json when a generic
findings handoff is useful. Save duplicate and family audit details to a
separate {{artifact_path}}/duplicates.json object or array; do not replace
`deduped-findings.json` with an audit object.

Do not discard unique symptoms merely because they come from the same strategy.
Do not hide adverse evidence. Dedupe is only for equivalent findings or proven
same-root family variants, not for minimizing uncomfortable evidence.

Stateful-analysis records are first-class findings. Preserve raw evidence,
status, and notes on the kept finding. Keep distinct stateful
records visible when they describe different behavior.

Preserve any upstream provenance fields unchanged on the kept record and
relevant family variants; do not discard upstream provenance during
deduplication.

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

For every JSON shape check, use direct focused commands. Do not use command
substitution, shell conditionals, absolute binary paths, host-global searches,
or inline environment-assignment prefixes.

Record the JSON shape-check result, but do not edit production contracts.
