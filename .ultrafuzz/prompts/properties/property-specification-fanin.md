---
id: property-specification-fanin
display_name: Properties deduplication
---

# Properties Deduplication

You are a Property Specification specialist.

Your job is to consolidate this project's properties and invariants into a single source of truth.

Read these target-context handoffs before consolidating:

Project discovery:
{{artifact_handoff:project-discovery}}

Structured discovery ledger JSON (the machine-readable source of truth):
`{{artifact_path:project-discovery}}/setup/invariant-evidence-ledger.json`
Validate it with `{{schema_path}}/invariant-evidence-ledger.schema.json`.

Actor and flow map:
{{artifact_handoff:actors-flows}}

Base test setup:
{{artifact_handoff:base-test-setup}}

## 1. Consolidate

Consolidate properties from these topology-required lens artifacts into a single catalog.
Each lens now emits `properties/<lens>.json` alongside its Markdown table. Read
and validate every lens JSON artifact first; it is the machine-readable source
of truth. Use the Markdown only as a human-readable companion and parity check.
Use `{{schema_path}}/property-lens.schema.json` to validate each
source catalog and assign every retained priority as `high`, `medium`, or
`low`.

{{ancestor_artifacts}}

Deduplicate equivalent properties across artifacts. When in doubt, err on the side of retaining multiple similar properties rather than risk removing one that represents a distinct concept or carries different meaning.

Assign each retained property a canonical ID (`property-1`, `property-2`, and so
on) and use that exact ID in both output artifacts. For every contributing
source row, preserve:

- `source_node_id`: the logical topology node ID that produced the source
  table, such as `property-specification-certora`;
- `source_property_id`: the prefixed property ID copied exactly from that
  source table.
- `reference_expectations`: copy the exact identifiers present on contributing
  source rows when those identifiers are supplied by the reference artifacts or
  pinned-reference artifacts. Merge equivalent rows by taking the union
  of supplied expectation identifiers, preserving each identifier unchanged.
  When source rows carry no supplied expectation identifier, leave the field
  absent.

When a pinned-reference node declares a catalog with
`ultrafuzz/reference-expectations@2`, read its declared artifact and validate it
with `{{schema_path}}/reference-expectations.schema.json`.

When several source rows describe one equivalent property, emit one canonical
property with every distinct contributing source in `sources`. Never keep only
the first source. Canonical IDs only need to remain stable within this run, but
all downstream artifacts must use them unchanged.

## Target-derived consolidation

Use the project-discovery, actor/flow, base-setup, and lens artifacts together
to preserve target-derived requirements. Retain every explicit mathematical
invariant, accounting equation, bound, and state relation represented by the
source catalogs. Preserve exact operands, constants, units, denominator
expressions, and rounding direction in each canonical description. Keep
distinct formula, denominator, and rounding variants as separate canonical
property rows. Carry explicitly documented or source-observed aggregate
accounting relationships between supplied assets, borrowed assets, and shares
into their descriptions. Preserve the target getter, function, test, or source
location that supplies each oracle so downstream implementation can observe
the same relation.

Read the `Verbatim source-evidence ledger` in the project-discovery handoff
before deduplicating, including its structured `inventory_rows` and `scan_probes`.
Map every ledger entry to at least one canonical property
row, retaining the copied source wording and its path plus line or symbol
location in the description or source list. A ledger entry may be merged with an
equivalent row only when the canonical row preserves every operand, comparison
direction, unit, denominator, and rounding term; otherwise keep a separate row.
For machine-verifiable provenance, add a `ledger_ids` array to every canonical
property that represents one or more ledger entries, copying the stable ledger
IDs exactly. Every ledger ID must appear in at least one canonical property's
`ledger_ids`; one source statement may map to several canonical properties and
several equivalent source statements may share one canonical property. Preserve
the complete mapping in both `properties.json` and its Markdown companion.
For each property, when that property has ledger IDs, include its complete
`ledger_ids` list. Omit the `ledger_ids` field entirely for a property that maps
to no ledger entry.
In `properties.md`, use one reversible companion grammar. Render each canonical
row between `### Canonical property: <json-string-id>` and
`### End canonical property: <json-string-id>`, where both IDs are the strict
JSON string encoding of the exact property ID, including for simple IDs. Inside
the block, emit exactly one line for each JSON member in this order:
`description`, `category`, `priority`, `sources`, then optional `ledger_ids` and
`reference_expectations`. Each line is `<field>: <strict-json-value>`: scalars
are JSON strings, sources are the exact JSON array of source objects, and ID
lists are the exact JSON arrays of strings. Do not use Markdown backticks,
tables, bullets, colon-delimited source pairs, comma/`<br>` lists, indented
multiline values, aliases, or ledger-evidence suffixes. Preserve array order.
When an optional member is absent from JSON, omit its Markdown field entirely;
a blank field or `[]` is not omission. Do not add any other field or block.

Use neutral authorized-QA language in the consolidated catalog. Phrase each row as
an expected property, invariant, boundary condition, state transition, or
regression target. If an upstream lens uses misuse-oriented or sensational
security wording, normalize it into test-focused language before copying the
concept into `properties.md`. Do not include public abuse paths or instructions
for misuse; this catalog is for local property and regression test generation
only.

## 2. Artifacts

Write `{{artifact_path}}/properties.json` first and validate it against
`{{schema_path}}/properties.schema.json`. Use the schema as the
source of truth for the required fields, types, and source records.

Every property must have at least one source. Keep source pairs unique and
canonical property IDs unique. The runtime validates this artifact before any
downstream node can run.

Then write the strict Markdown companion blocks with the same canonical IDs,
descriptions, categories, priorities, and complete source lists to
`{{artifact_path}}/properties.md`.
