---
id: smoke-threat-model
display_name: Smoke threat model
---

# Smoke threat model

Produce the same canonical Web3 threat-model artifacts as the default
`threat-model` node, using only this bounded real-target context:

{{artifact_handoff:smoke-context}}

Read-only controlled capability registry (use only the top-level
`capabilities` entries during this node):
{{vulnerability_database_path}}

Do not search benchmark ground truth, expected findings, sibling targets,
historical runs, host-global paths, or network resources.

Model repository-backed assets, actors, roles, privileges, trust boundaries,
entry points, attack surfaces, value/accounting flows, lifecycle transitions,
economic and security invariants, and concrete threats. Cover oracles,
callbacks, external integrations, governance/upgrades, liquidation/solvency,
and cross-chain behavior only when repository evidence makes them relevant.

Use stable lowercase colon-separated threat IDs and controlled dotted
capability IDs. Every capability is `present`, `absent`, or `unknown`.
Present and absent require repository evidence; unknown must not become absent.
Emit every registry capability exactly once and do not invent capability IDs.
Ignore vulnerability-class records until the downstream goal planner.

The authoritative contract for this artifact is the canonical JSON Schema
`{{artifact_schema_dir}}/threat-model.schema.json`
(`$id: https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/threat-model`),
generated from the same `ultrafuzz/threat-model@1` validator that gates this
node. The collections below restate that schema; when the two ever disagree,
the schema file wins.

Write `{{artifact_path}}/threat-model.json` with
`schema_version: "ultrafuzz.threat-model.v1"` and these exact collections:

```json
{
  "schema_version": "ultrafuzz.threat-model.v1",
  "title": "Protocol threat model",
  "scope": {
    "summary": "...",
    "repository_evidence": [],
    "exclusions": []
  },
  "protocol": {
    "summary": "...",
    "archetypes": ["..."]
  },
  "capabilities": [],
  "assets": [],
  "actors": [],
  "trust_boundaries": [],
  "attack_surfaces": [],
  "value_flows": [],
  "lifecycle_transitions": [],
  "invariants": [],
  "threats": [],
  "assumptions": [],
  "unknowns": [],
  "coverage_gaps": []
}
```

Use the following record fields:

- capabilities: `id`, `status`, `rationale`, `evidence`;
- assets: `id`, `name`, `description`, `value_at_risk`, `evidence`;
- actors: `id`, `name`, `role`, `trust`, `privileges`, `evidence`;
- trust boundaries: `id`, `name`, `description`, `actor_ids`, `evidence`;
- attack surfaces: `id`, `name`, `description`, `entry_points`, `asset_ids`,
  `actor_ids`, `capability_ids`, `trust_boundary_ids`, `evidence`;
- value flows: `id`, `name`, `description`, `steps`, `asset_ids`,
  `actor_ids`, `evidence`;
- lifecycle transitions: `id`, `name`, `from`, `to`, `trigger`, `guards`,
  `effects`, `evidence`;
- invariants: `id`, `name`, `kind` (exactly one of `economic`, `accounting`,
  `state`, `authorization`, or `integration`; no other value validates),
  `statement`, `asset_ids`, `capability_ids`, `evidence`;
- threats: `id`, `title`, `description`, `preconditions`, `impact`,
  `asset_ids`, `actor_ids`, `attack_surface_ids`, `capability_ids`,
  `trust_boundary_ids`, `invariant_ids`, `assumption_ids`, `unknown_ids`,
  `evidence`;
- assumptions: `id`, `name`, `statement`, `evidence`;
- unknowns: `id`, `name`, `description`, `security_impact`,
  `evidence_needed`;
- coverage gaps: `id`, `name`, `description`, `reason`.

Every `*_ids` field, `privileges`, `entry_points`, `steps`, `guards`,
`effects`, `preconditions`, `exclusions`, `archetypes`, and `evidence` is a
JSON array. Every other leaf field is a single JSON string — in particular
`value_at_risk`, `impact`, `security_impact`, and `evidence_needed` are
strings, never arrays.

All referenced IDs must resolve. Evidence records contain `path` and optional
`line`, `end_line`, `symbol`, and `note`. Each `path` must be a canonical
repository-relative POSIX path to an existing regular file in the current task
workspace. URLs, absolute or Windows paths, backslashes, control characters,
and empty, `.`, or `..` path segments are invalid.

Write a non-empty `{{artifact_path}}/THREAT_MODEL.md` to complete the task.
Ultrafuzz deterministically replaces it with the canonical Markdown rendering
of validated `threat-model.json` before publishing the artifact manifest.
