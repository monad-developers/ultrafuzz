---
id: threat-model
display_name: Threat model
---

# Threat model

Build an evidence-backed threat model for this repository. The structured model
is routing input for parallel vulnerability hunters, not a remediation backlog.

Use only the target repository and these current-run handoffs:

Project discovery:
{{artifact_handoff:project-discovery}}

Actors, roles, and flows:
{{artifact_handoff:actors-flows}}

Read-only controlled capability registry (use only the top-level
`capabilities` entries during this node):
{{vulnerability_database_path}}

Do not inspect sibling runs, historical reports, benchmark ground truth,
host-global files, or network resources.

## Analysis

Start from scope, assets, value stores, actors, roles, privileges, trust
boundaries, entry points, and attack surfaces. Then model the Web3-specific
security mechanics that actually exist:

- protocol archetypes and controlled protocol capabilities;
- value, share, debt, collateral, fee, and accounting flows;
- economic, accounting, state, authorization, and integration invariants;
- lifecycle and state-machine transitions;
- solvency, liquidation, bad debt, and backstops when present;
- oracle dependencies, freshness, manipulation, and settlement;
- callbacks, hooks, reentrancy, tokens, and external integrations;
- governance, timelocks, privileged operations, and upgrades;
- cross-chain messaging, sequencing, replay, and finality when applicable.

Do not add ARI, LINDDUN, privacy analysis, or remediation planning to this
hunting artifact.

## Evidence and uncertainty rules

Use lowercase stable hierarchical IDs. Threat IDs use colon-separated slugs,
for example `liquidation:overdue`, `oracle:stale-price`, and
`governance:upgrade-bypass`. Capability IDs use controlled dotted slugs, for
example `lending.liquidation` and `oracle.external-price`.

Every evidence reference contains `path` and may contain `line`, `end_line`,
`symbol`, and `note`. `path` must be a canonical repository-relative POSIX path
to an existing regular file in the current task workspace. URLs, absolute or
Windows paths, backslashes, control characters, and empty, `.`, or `..` path
segments are invalid. Paths and lines must point to current repository
evidence.

Every capability has exactly one status:

- `present`: repository evidence establishes that the capability exists;
- `absent`: repository evidence establishes that the capability does not exist;
- `unknown`: neither case was established.

Present and absent capabilities require evidence. Unknown is never equivalent
to absent. Record assumptions, unknowns, and coverage gaps explicitly instead
of converting uncertainty into a hard applicability decision.

Emit every controlled capability from the supplied registry exactly once and
do not invent additional capability IDs. Use repository architecture,
interfaces, entry points, and flows as evidence when a capability is clearly
absent. If presence or absence cannot be established, retain `unknown`. Ignore
the catalog's vulnerability-class records in this node; class applicability and
hunter selection belong to `goal-plan`.

## Canonical JSON

The authoritative contract for this artifact is the canonical JSON Schema
`{{artifact_schema_dir}}/threat-model.schema.json`
(`$id: https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/threat-model`),
generated from the same `ultrafuzz/threat-model@1` validator that gates this
node. The shape below restates that schema for convenience; when the two ever
disagree, the schema file wins.

Write `{{artifact_path}}/threat-model.json` first with this exact top-level
shape and `schema_version: "ultrafuzz.threat-model.v1"`:

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

Required record shapes:

- capability: `id`, `status`, `rationale`, `evidence`;
- asset: `id`, `name`, `description`, `value_at_risk`, `evidence`;
- actor: `id`, `name`, `role`, `trust`, `privileges`, `evidence`;
- trust boundary: `id`, `name`, `description`, `actor_ids`, `evidence`;
- attack surface: `id`, `name`, `description`, `entry_points`, `asset_ids`,
  `actor_ids`, `capability_ids`, `trust_boundary_ids`, `evidence`;
- value flow: `id`, `name`, `description`, ordered `steps`, `asset_ids`,
  `actor_ids`, `evidence`;
- lifecycle transition: `id`, `name`, `from`, `to`, `trigger`, `guards`,
  `effects`, `evidence`;
- invariant: `id`, `name`, `kind`, `statement`, `asset_ids`,
  `capability_ids`, `evidence`;
- threat: `id`, `title`, `description`, `preconditions`, `impact`, `asset_ids`,
  `actor_ids`, `attack_surface_ids`, `capability_ids`, `trust_boundary_ids`,
  `invariant_ids`, `assumption_ids`, `unknown_ids`, `evidence`;
- assumption: `id`, `name`, `statement`, `evidence`;
- unknown: `id`, `name`, `description`, `security_impact`,
  `evidence_needed`;
- coverage gap: `id`, `name`, `description`, `reason`.

All referenced IDs must exist in their corresponding top-level collection.
Keep IDs unique within every collection. Use empty arrays, not omitted fields,
when no optional references exist.

## Human artifact

Write a non-empty `{{artifact_path}}/THREAT_MODEL.md` so the task handoff is
complete. After the agent returns, Ultrafuzz deterministically replaces that
file with the canonical rendering of the validated JSON. The canonical
renderer includes scope, capabilities, assets, actors, trust boundaries,
attack surfaces, value/accounting flows, lifecycle transitions, invariants,
threats, assumptions, unknowns, and coverage gaps. `report.md` links to that
artifact rather than duplicating it.
