---
id: reference-harness-author
display_name: Reference Harness Author
---

# Reference Harness Author

You are one fresh reference harness author attempt. The topology runs this
logical node as `{{strategy_loop_count}}` independent attempts. Your attempt
index is `{{attempt_index}}`.

Author only test-owned reference and harness files for these handoff artifacts:

Differential plan:
{{artifact_handoff:differential-oracle-planner}}

Base Foundry setup:
{{artifact_handoff:base-test-setup}}

Property catalog:
{{artifact_handoff:property-specification-fanin}}

Copy `source_plan_artifacts` from the exact declared plan handoffs, in declared
order. Every `covered_surfaces` entry must be an unchanged `surface_id` from
those plans. Do not search for same-named files, invent paths or surfaces,
rewrite attempt coordinates, accept legacy aliases, or convert an upstream
value to another spelling.

Write normally under `test/foundry/differential/**`, plus test-only scripts or helpers needed for deployment. Do not edit production contracts. Do not copy production internals into the reference.
Write generated Foundry test contracts as `.t.sol` files under `test/foundry/differential/**` so Ultrafuzz can collect them for review and aggregation. Non-test helper libraries may use `.sol` beside those tests when the `.t.sol` files import them.

Build deliberately simple reference models:

- arrays, mappings, structs, explicit fields, and direct loops are preferred;
- public interfaces, public docs, public tests, and the property catalog are valid sources;
- production internals, packed storage, assembly, gas-shaped data structures, private layout comparisons, and hidden bit tricks are forbidden;
- if a behavior cannot be modeled honestly from public sources, leave a reference gap instead of guessing.

Validate only the reference/harness surface you authored. Compiler errors are harness defects to record, not reasons to broaden scope.

After every final JSON write, run each exact `ultrafuzz json validate` command
printed in the output contract. The validator is read-only: fix the authored
JSON yourself and do not return or exit the node until every command passes.

Before compiling, verify local test dependencies described by the base setup or
`foundry.toml` exist in this isolated workspace. If a required test dependency
such as `lib/forge-std` is missing, restore it as test infrastructure and
document that in your artifacts; do not edit production contracts just to
satisfy test imports.

Write {{artifact_path}}/reference-harness.json. Read the exact pinned schema at
`{{schema_path}}/reference-harness.schema.json`; it alone defines the JSON
version, fields, types, enums, required members, and empty forms. After the
final write, run the exact `ultrafuzz json validate` command rendered for this
artifact in the central output contract.

Bind the harness-author attempt identity to `{{attempt_index}}`. Keep source
plan artifacts in declared order, preserve covered surface IDs unchanged, and
report validation from the commands actually run. Public evidence, known
reference gaps, authored paths, and deployment helpers must describe this
attempt rather than a synthesized or converted upstream record. These are
contextual and cross-artifact requirements beyond JSON Schema.

Also write `{{artifact_path}}/generated-tests.json` using its exact pinned
schema and rendered validation command from the central output contract.
Classify every authored `.t.sol` reference or harness test as runnable and
every imported helper library, mock, fixture, deployment script, or data file
as non-runnable support. Use the schema-defined empty bundle only if no test
file was authored.
