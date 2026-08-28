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

## Failure-resilient checkpoint

Before extended analysis, read the schema, the controlled capability registry,
the supplied handoffs, and enough repository evidence to satisfy every
non-empty collection required by the schema. Then immediately write a
conservative, schema-valid working `{{artifact_path}}/threat-model.json` and a
non-empty `{{artifact_path}}/THREAT_MODEL.md`, and run the exact validation
command from the injected output contract. Mark capabilities whose status is
not yet established as `unknown`, and record uncertainty explicitly; never
fabricate evidence merely to complete the checkpoint.

Refine the validated JSON in bounded increments and revalidate after each
material update. If a validated checkpoint from an interrupted attempt already
exists at the artifact path, validate and refine it instead of starting over.
Do not postpone the first validated artifacts until the end of the task.

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

Read `{{artifact_schema_dir}}/threat-model.schema.json` before authoring the
structured artifact. It is the sole authority for field names, types,
required values, and the registered contract identity. Write
`{{artifact_path}}/threat-model.json` to that schema and validate it with the
exact command in the injected output contract.

Keep every identifier unique within its collection and resolve every reference
to an identifier in the corresponding collection. Preserve ordered protocol
steps and lifecycle effects in source order. Empty relationships remain empty
collections rather than invented links. The capability status and repository
evidence rules above are semantic requirements in addition to the schema.

## Human artifact

Write a non-empty `{{artifact_path}}/THREAT_MODEL.md` so the task handoff is
complete. After the agent returns, Ultrafuzz deterministically replaces that
file with the canonical rendering of the validated JSON. The canonical
renderer includes scope, capabilities, assets, actors, trust boundaries,
attack surfaces, value/accounting flows, lifecycle transitions, invariants,
threats, assumptions, unknowns, and coverage gaps. `report.md` links to that
artifact rather than duplicating it.
