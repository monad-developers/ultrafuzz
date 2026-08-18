# Ultrafuzz Schemas

Ultrafuzz checks in complete Draft 2020-12 JSON Schema documents under
`packages/artifacts/schema/`, `packages/cli/schema/`, `packages/config/schema/`,
`packages/evals/schema/`, `packages/evmbench/src/schema/`,
`packages/modal/schema/`, `packages/references/schema/`, `packages/runtime/schema/`, and
`packages/topology/schema/`. JSON Schema is the canonical whole-document shape
contract. TypeScript types describe consumers; where a Zod parser remains
useful, parity tests require it to accept and reject the same structures without
coercion, defaults, transforms, aliases, or property stripping.

Schema IDs are stable, fragment-free URNs such as:

- `urn:ultrafuzz:schema:artifacts:findings:2`
- `urn:ultrafuzz:schema:artifacts:generated-tests:3`
- `urn:ultrafuzz:schema:cli:result:2`
- `urn:ultrafuzz:schema:cli:operator-input:1`
- `urn:ultrafuzz:schema:cli:report-bundle-manifest:3`
- `urn:ultrafuzz:schema:evals:suite:2`
- `urn:ultrafuzz:schema:evals:evmbench-cohort:1`
- `urn:ultrafuzz:schema:evals:benchmark-cohort:1`
- `urn:ultrafuzz:schema:evals:benchmark-lanes:2`
- `urn:ultrafuzz:schema:evals:ground-truth:1`
- `urn:ultrafuzz:schema:evals:history:2`
- `urn:ultrafuzz:schema:evals:history-automatic-publication-plan:1`
- `urn:ultrafuzz:schema:evals:history-publication-generation:1`
- `urn:ultrafuzz:schema:evals:run-record:3`
- `urn:ultrafuzz:schema:evals:recovery-equivalence:1`
- `urn:ultrafuzz:schema:evals:status:1`
- `urn:ultrafuzz:schema:evals:public-eval-diagnostics:2`
- `urn:ultrafuzz:schema:modal:node-input:1`
- `urn:ultrafuzz:schema:references:reference-cache-manifest:1`
- `urn:ultrafuzz:schema:runtime:workflow-control-integrity:2`
- `urn:ultrafuzz:schema:runtime:invariant-suite-handoff:1`
- `urn:ultrafuzz:schema:runtime:data-governance-policy:1`
- `urn:ultrafuzz:schema:runtime:data-disclosure-acknowledgements:1`
- `urn:ultrafuzz:schema:topology:expanded-graph:4`

The generated-tests v3 schema describes an atomic strict UTF-8 text bundle.
`generated_tests` contains runnable tests and reproducers; `support_files`
contains their non-runnable dependencies. Both arrays use the same closed entry
shape and `generated-tests/` namespace. The manifest requires one root-level
`framework` matching `^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$` for the entire
atomic bundle, including an empty bundle; entry rows cannot repeat or override
it. Semantic gates enforce bundle-wide path uniqueness, support-to-test
coupling, current run/node identity, singly linked filesystem integrity, and
authenticated aggregation. Aggregation preserves `framework` on each
`source_bundles` record and never infers it or repeats it on copied/skipped
entry rows. Version 2 is not accepted or converted.

The IDs identify schemas and resolve bundled `$ref` values; they are never
fetched. Package-local registries enumerate every checked-in schema, its role,
contract IDs, TypeScript export, local references, semantic gates, SHA-256, and
optional Zod parser. CI fails when a schema or contract is absent from those
registries, cannot compile strictly, contains an unresolved or remote
reference, or differs from its exported representation.

## Validate a Document

```bash
ultrafuzz json validate \
  --schema '/absolute/path/to/schema.json' \
  --file '/absolute/path/to/artifact.json'
```

Use repeatable `--ref` flags only for explicitly supplied local dependencies.
Bundled sibling schemas resolve offline without flags. The CLI and host use the
same non-mutating parser, schema registry, Ajv configuration, resource limits,
schema digest, bundle digest, and validator-build identity.

Every planned JSON output persists the registered schema filename, `$id`,
schema SHA-256, owning package's schema-bundle SHA-256, and validator build.
The expanded graph, run state, `ultrafuzz.artifact-verification.v2` marker, and
`ultrafuzz.artifact-manifest.v3` repeat that binding. A missing, partial, stale,
or mismatched identity is a host setup/verification failure even when the JSON
would match a different schema with the same general shape.

Schema-backed producers receive a run-owned trusted launcher ahead of
target-controlled `PATH` entries. Local and Modal environments use that launcher
to validate a real known-valid fixture and compare the returned schema, bundle,
and validator-build identity before model work. A path lookup alone is not a
preflight, and a missing or tampered launcher is not silently repaired on
resume.

Exit `0` establishes portable document-shape conformance only. Cross-file
joins, projected-key uniqueness, filesystem and Git facts, digest relationships,
and other contextual rules remain named host semantic gates. Exit `1` means the
artifact author must correct the document. Exit `2` is a schema, invocation, or
tool setup failure. The validator never repairs either file.

Campaign governance policy and acknowledgement inputs follow that split. Their
registered schemas enforce closed shapes, canonical text and timestamp forms,
and Unicode code-point length limits. Runtime semantic gates enforce projected
destination uniqueness, exact destination-policy coverage, and canonical policy
array ordering. Runtime parsing returns accepted values unchanged; it never
trims or reorders them.

## Breaking Contract Policy

Each retained JSON handoff has one current versioned contract and one complete
schema. Old contract IDs, version spellings, compatibility conversions, and
historical readers are not supported across this transition. Agent-authored
bytes are immutable after the agent session returns: validation, publication,
reporting, dashboards, and bundles may reject them, but may not normalize,
synthesize, reseal, or rewrite them.

Runtime-owned documents follow the same rule before publication. For example,
reference cache manifests use only
`ultrafuzz.reference-cache-manifest.v1`; caches carrying the old generic
`"1.0"` literal are rejected and must be fetched again.

The host also does not request a correction turn after the session returns,
retry the model for an artifact-shape failure, create a canonical empty file,
rebuild output from dependencies, or fall back to a sibling artifact or final
response. Correction is ordinary producer authorship only while the original
session is still active and must be followed by another successful validation
command.

## Runtime-Owned Durable Documents

The runtime registry owns complete current schemas for the following retained
documents. Reads validate one immutable byte snapshot with the strict JSON
parser, JSON Schema, and every named semantic gate before using any field.
Writes validate the complete proposed value before durable publication.

- `ultrafuzz.workspace-patch-baseline.v1`
- `ultrafuzz.workspace-patch-preparation.v1`
- `ultrafuzz.invariant-suite-baseline.v1`
- `ultrafuzz.invariant-workspace-snapshot.v1`
- `ultrafuzz.invariant-suite-handoff.v1`
- `ultrafuzz.workflow-control-integrity.v2`
- `ultrafuzz.workflow-execution-dependencies.v1`
- `ultrafuzz.workflow-run-link-journal.v1`
- `ultrafuzz.cloud.execution-generation.v1`
- `ultrafuzz.smithers.submission.v1`
- `ultrafuzz.smithers.reset-node.v1`

Projected path/identity uniqueness, canonical ordering, aggregate byte budgets,
workflow-link chaining, and dependency-graph closure are named runtime semantic
gates because JSON Schema cannot express them portably. Trusted run, attempt,
filesystem, Git, event-journal, and digest equalities remain contextual checks
at the consuming boundary. Missing evidence means only a causal `ENOENT`;
malformed, inaccessible, partial, stale, or unexpected present evidence is not
treated as absent and is never rewritten.

`ultrafuzz.terminal-disposition.v1` has its own registered whole-document
schema and is also embedded as a closed value in the canonical run-state v5
document. Runtime production and Modal consumption validate the value against
that same root contract. Dependency `package.json` files, GitHub Actions event
and REST API responses, and the transient models.dev catalog are third-party
envelopes rather than Ultrafuzz evidence: they are strictly parsed from bounded
bytes and narrowly projected, but their provider-defined whole shape is
intentionally not registered as an Ultrafuzz schema.
