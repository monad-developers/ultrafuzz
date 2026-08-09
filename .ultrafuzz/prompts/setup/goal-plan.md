---
id: goal-plan
display_name: Goal plan
---

# Goal plan

Create the complete additive vulnerability-hunting plan from the canonical
threat model and the materialized vulnerability-database planner catalog.

Threat model:
{{artifact_path:threat-model}}/threat-model.json

Read-only vulnerability database planner catalog:
{{vulnerability_database_path}}

If the catalog path is `unavailable`, missing, outside the supplied runtime
input, or invalid, fail closed. Do not inspect package installation paths,
download content, or replace the curated catalog with invented classes.

## Selection policy

The v0.1.0 default is additive:

1. Create exactly one threat goal for every modeled threat.
2. Create exactly one class goal for every applicable database class.
3. Record the fixed `goal-roaming` goal, which runs independently.

Do not rank a top subset, truncate to a fixed lane count, or form a full
threat-by-class Cartesian product. One class goal may reference several
relevant threats. If an applicable class has no matching explicit threat, still
emit its class goal with `threat_ids: []`, `coverage_gap: true`, and a general
threat-model coverage-gap replacement. This missing mapping is a signal, not a
reason to suppress the class.

Evaluate class applicability from the catalog's required, optional, and
incompatible controlled capabilities:

- a required capability proven `absent` is a hard exclusion;
- an incompatible capability proven `present` is a hard exclusion;
- `unknown` is not a hard exclusion;
- every exclusion must cite the threat-model capability rationale and evidence.

Copy every catalog record ID into `catalog_class_ids` and emit exactly one
`applicability_decision` for each ID. Do not omit a class merely because it is
inapplicable, and do not invent decisions for IDs absent from the catalog.
For each decision, emit exactly one check for every capability named in that
catalog record's `required`, `optional`, and `incompatible` lists, preserving
the list name as `requirement`. If the capability exists in the threat model,
copy its `status` into `observed_status` and its `rationale` and complete
`evidence` byte-for-byte — the same strings, every evidence field, in the same
order; any paraphrase, summary, or reordering fails validation. Build these
checks mechanically (for example with a small script that reads
`threat-model.json` and emits the copied values) instead of retyping them by
hand. If it was not modeled, record it as `unknown` with empty evidence and
explain that it was not established by the upstream model. Do not infer
`absent` from an omitted capability.

## MDX replacement contract

Every dynamic item contains a scalar `replacements` map. Its `goal_prompt`
must preserve item-scoped MDX placeholders until the dynamic-node renderer
resolves them.

Threat goal example (using invented IDs):

```text
Your /goal is to find any vulnerability affecting a delayed clock tick using threat model threat \{{clockwork:late-tick}}.
```

Class goal example (using invented IDs):

```text
Your /goal is to find a vulnerability of type \{{class:clockwork.deferred-settlement-gap}} using threat model \{{clockwork:late-tick}}.
```

The replacement value for each threat key contains the full selected threat,
assets, actors, surfaces, preconditions, invariants, assumptions, unknowns, and
evidence. The class replacement contains the database record's focused hunter
instructions and relevant examples. Never flatten a placeholder to a bare
literal ID.

## Output

The authoritative contract for this artifact is the canonical JSON Schema
`{{artifact_schema_dir}}/goal-plan.schema.json`
(`$id: https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/goal-plan`),
generated from the same `ultrafuzz/goal-plan@1` validator that gates this node.
The rules below restate that schema; when the two ever disagree, the schema
file wins.

Write `{{artifact_path}}/goal-plan.json` with
`schema_version: "ultrafuzz.goal-plan.v1"` and `policy: "additive-v1"`.
Include:

- `threat_model_sha256`, computed over the exact bytes of the supplied upstream
  `threat-model.json` file (not reserialized JSON);
- `vulnerability_database` with explicit planner-catalog and snapshot-manifest
  schema versions, database schema version, aggregate digest, and
  planner-catalog digest (`catalog_sha256`, computed over the exact bytes of
  the supplied planner catalog file itself, like `threat_model_sha256`);
- all `modeled_threat_ids`;
- all `catalog_class_ids`;
- `threat_goals`;
- `class_goals`;
- every `applicability_decision`;
- `selected_class_records`;
- fixed `roaming_goal`;
- exact `counts`.

Do not write `expected_child_count`, `threat_count`, `applicable_class_count`,
`max_dynamic_nodes`, or `goal_lanes`. After the agent returns, Ultrafuzz
deterministically records those from the plan you wrote plus the run's
configured dynamic-node limit, and fails closed if a value you wrote disagrees.
The canonical schema lists them as required because they are present by the time
the plan is validated.

`modeled_threat_ids` must exactly equal the IDs in the upstream threat model;
class goals may reference only those IDs.

Name the two schema fields `planner_catalog_schema_version` and
`snapshot_manifest_schema_version`. Set the latter to
`"ultrafuzz.vulnerability-db.snapshot.v1"`. Copy the former,
`database_schema_version`, and `aggregate_sha256` (from
`database_aggregate_sha256`) out of the supplied catalog document. Set
`catalog_sha256` to the SHA-256 you compute over the exact bytes of the
planner catalog file at the supplied read-only catalog path above, the same
way `threat_model_sha256` hashes the upstream threat-model file. The
catalog's embedded `upstream_catalog_sha256` names the upstream source file
and never validates here. For selected records, copy
`selected_artifact_path`, `source_sha256`, and `source_size_bytes` exactly into
the plan's `path`, `sha256`, and `size_bytes` fields.

Each threat goal has `kind`, `id`, `node_id`, `title`, one-element
`threat_ids`, `class_ids`, `attack_surface_ids`, `goal_prompt`,
`replacements`, and `selection_rationale`. Its node ID is
`dynamic:threat:<threat-id>`. Set `id` byte-for-byte equal to the sole
`threat_ids` element; never add a `goal:` prefix. Therefore `node_id` is
exactly `dynamic:threat:` followed by `id`, and `goal_prompt` retains the
placeholder whose key is exactly that same threat ID.

Each class goal has `kind`, `id`, `node_id`, `class_id`,
`class_replacement_key`, `threat_ids`, `threat_replacement_keys`,
`attack_surface_ids`, `coverage_gap`, `title`, `selected_record`,
`goal_prompt`, `replacements`, and `selection_rationale`. Its node ID is
`dynamic:class:<class-id>`. Set `id` byte-for-byte equal to `class_id`; never
add a `goal:` prefix. Therefore `node_id` is exactly `dynamic:class:` followed
by `id`, and `class_replacement_key` is exactly `class:` followed by `id`.

For a mapped class goal, `threat_replacement_keys` must contain exactly its
`threat_ids`. For a coverage-gap class goal it must contain only
`threat-model:coverage-gap`. Every listed key remains an MDX placeholder in
`goal_prompt` and has a full contextual value in `replacements`: keep each
key wrapped in its literal double braces inside `goal_prompt` — a
coverage-gap goal keeps the exact `threat-model:coverage-gap` key in that
brace-wrapped form — and never substitute a placeholder with its
replacement value.

In both goal kinds, `attack_surface_ids` holds `id` values copied from the
threat model's `attack_surfaces` records — lowercase slug IDs, never
human-readable surface names or invented labels.

Each applicability decision has `class_id`, `decision`, `checks`, and
`rationale`. Each check has `capability_id`, `requirement`,
`observed_status`, `evidence`, and `rationale`.

Set the fixed roaming record to:

```json
{
  "node_id": "goal-roaming",
  "prompt_path": "strategies/roaming-goal.md",
  "purpose": "Challenge taxonomy and threat-model completeness."
}
```

Use each catalog record's source digest, byte size, and selected artifact path
for `selected_class_records`; do not reconstruct source records from the catalog's
structured guidance. After the agent returns, Ultrafuzz deterministically
materializes `{{artifact_path}}/vulnerability-db-manifest.json` and the exact
source bytes for only those selected records beneath the task artifact
directory at `vulnerability-db/selected/`. It fails closed if the plan,
catalog, bundled database, manifest, or selected bytes disagree. Write only
`goal-plan.json` yourself: never create `vulnerability-db-manifest.json` or
anything under `vulnerability-db/` — Ultrafuzz publishes those bytes and a
manifest you write will conflict with them. Do not copy the whole database or
inspect package installation paths.
