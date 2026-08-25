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

Every replacement value is a short human-readable label, not a record: the
referenced record's `title`, optionally followed by its ID when two titles
would read alike, on one line of plain prose and well under 200 characters.
Never put JSON, a nested object, or the record's `evidence`, `actors`,
`assets`, `attack_surfaces`, preconditions, invariants, assumptions, or
unknowns in a replacement value. The coverage-gap key
`threat-model:coverage-gap` takes the same treatment: a short label naming the
uncovered class, not a synthesized threat record.

Each label only has to identify which record to open. The hunter reads full
detail from files, and `strategies/goal-hunter.mdx` already gives it every
path it needs.

## Output

Read `{{artifact_schema_dir}}/goal-plan.schema.json` before authoring the plan.
It is the sole authority for field names, types, required values, and the
registered contract identity. Write `{{artifact_path}}/goal-plan.json` to that
schema and validate it with the exact command in the injected output contract.

Bind the plan to the SHA-256 of the exact supplied `threat-model.json` bytes,
not reserialized JSON. Likewise bind it to the database version and aggregate
identity copied from the supplied planner catalog and to the SHA-256 of that
catalog's exact bytes. The snapshot-manifest identity is the constant required
by the pinned schema. Copy every modeled threat and catalog class into the
corresponding plan collections, record every applicability decision, retain the
selected source-record identities, and include the fixed roaming goal.

Do not write `expected_child_count`, `threat_count`, `applicable_class_count`,
`max_dynamic_nodes`, or `goal_lanes` -- omit those five keys entirely. Ultrafuzz
derives them after you return, from the plan you wrote plus the run's configured
dynamic-node limit, and fails closed if a value you wrote disagrees with what it
derives.

The canonical schema marks those five keys optional, so a plan that omits them
validates. Do not compute them. `max_dynamic_nodes` is a run setting this prompt
never states, so you cannot know it, and `expected_child_count` counts threat and
class goals only and excludes the roaming goal -- a plan that is internally
consistent can still disagree with the derivation and fail closed.

If you do write them, the contract checks each one against the plan you wrote and
rejects a value that disagrees, so run the validation command and correct any
value it reports rather than leaving it for the run to reject later.

`modeled_threat_ids` must exactly equal the IDs in the upstream threat model;
class goals may reference only those IDs.

Copy the database version and aggregate identity from the supplied catalog.
Compute the planner-catalog digest over the exact bytes at the supplied
read-only path, the same way the threat-model digest is computed. The catalog's
embedded upstream-catalog digest names a different source file and must not be
substituted. For selected records, copy their selected artifact path, source
digest, and byte size exactly into the schema-designated fields.

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
`goal_prompt` and has a short label value in `replacements`: keep each
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

The fixed roaming record names node `goal-roaming`, prompt
`strategies/roaming-goal.md`, and the purpose of challenging taxonomy and
threat-model completeness.

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
