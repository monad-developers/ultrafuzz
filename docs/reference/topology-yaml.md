# Topology YAML

Project topology lives at:

```text
.ultrafuzz/topology.yml
```

It is the source of truth for campaign graph construction.

## File Shape

```yaml
version: 2
defaults:
  strategy_loops: 1
groups:
  strategies:
    label: Strategies
    color: "#7c3aed"
    defaults:
      loops: 3
      model_profiles:
        - default
  review:
    label: Review
    color: "#0f766e"
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: boundary-tests
    kind: agentic
    prompt: strategies/boundary-tests.md
    group: strategies
    depends_on:
      - setup-foundry
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@2
        primary: true
  - id: final-report
    kind: agentic
    prompt: review/final-report.md
    group: review
    depends_on:
      - boundary-tests
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: report.json
        contract: ultrafuzz/report@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
```

## Top-Level Fields

| Field                     | Meaning                                               |
| ------------------------- | ----------------------------------------------------- |
| `version`                 | Topology version. Current value is `2`.               |
| `defaults.strategy_loops` | Global fallback loop count for normal strategy nodes. |
| `groups`                  | Optional group labels, colors, and defaults.          |
| `nodes`                   | Ordered list of logical topology nodes.               |

## Groups

Group IDs must be safe IDs. Group colors, when present, must be six-digit hex
colors such as `#7c3aed`.

Group defaults may include:

| Field             | Meaning                                             |
| ----------------- | --------------------------------------------------- |
| `loops`           | Default loop count for nodes in the group.          |
| `timeout_seconds` | Default timeout for nodes in the group.             |
| `max_attempts`    | Maximum attempts for an agent task.                 |
| `model_profiles`  | Explicit model profile list for nodes in the group. |

Node fields override group defaults. A node or group `model_profiles` list is
the model fan-out surface. When neither a node nor its group selects model
profiles, the node uses the configured default model profile only.
`max_attempts` defaults to `1`; values greater than one retry the same agent task
for retryable provider or execution failures that occur before agent completion
under Smithers' bounded policy. They do not retry a completed agent session
whose required output is missing or schema-invalid; that post-agent contract
failure is terminal.

## Node Fields

Every node must define:

| Field        | Meaning                       |
| ------------ | ----------------------------- |
| `id`         | Stable logical node ID.       |
| `depends_on` | Logical predecessor node IDs. |

Agentic nodes support:

| Field               | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `kind`              | Optional. Defaults to `agentic`.                            |
| `prompt`            | Prompt path under `.ultrafuzz/prompts/`.                    |
| `group`             | Group ID.                                                   |
| `loops`             | Node loop count. Overrides group and global loop defaults.  |
| `loop_mode`         | `parallel` or `series`. Defaults to `parallel`.             |
| `timeout_seconds`   | Node timeout override.                                      |
| `max_attempts`      | Maximum attempts for the agent task.                        |
| `outputs`           | Required output paths, named contracts, and primary marker. |
| `model_profiles`    | Explicit model profile fan-out for this node.               |
| `required_commands` | Bare executable names that must pass launch preflight.      |

Every executable node must declare at least one output, every output must name a
resolvable contract, and exactly one output must set `primary: true`. Prompt
paths and artifact paths must be relative, traversal-free paths. Output paths
are relative to the node artifact directory and must not start
with `artifacts/` or `.ultrafuzz/`. The runtime-owned
`artifact-manifest.json` path is reserved and cannot be declared as an output.
`required_commands` entries are deduplicated across the active, transformed
topology. Local runs resolve them from stable absolute entries on the effective
task `PATH`; cwd-dependent entries are ignored because tasks run in fresh Git
worktrees. Cloud runs probe the configured provider image. A missing command
aborts launch before run state, workflow IDs, node attempts, or model work are
created. Ultrafuzz never installs these backend commands during a run. Resume,
replay, and fork recheck the sealed expanded graph before they can create
another node attempt or model invocation.
Meta and reference nodes cannot require commands because they do not
execute workflow commands.

Current JSON contracts include `ultrafuzz/findings@2`,
`ultrafuzz/generated-tests@3`, `ultrafuzz/properties@2`,
`ultrafuzz/implemented-properties@3`, `ultrafuzz/property-campaign@3`,
`ultrafuzz/invariant-campaign-plan@1`, `ultrafuzz/property-lens@2`,
`ultrafuzz/reference-expectations@2`, and `ultrafuzz/report@2`, plus named
contracts for the other workflow-specific JSON documents.
`ultrafuzz/json-object@1` and `ultrafuzz/json-array@1` were removed; they are not
generic escape hatches. See the
[strict contract migration inventory](artifact-contract-migration-v2.md) for
the breaking-version decisions. Non-JSON outputs use the explicit
`ultrafuzz/nonempty-markdown@1` or `ultrafuzz/text@1` contracts.

`ultrafuzz/generated-tests@3` is an atomic text bundle. Its manifest requires
one root-level canonical ASCII `framework` for the entire bundle, including an
empty bundle, plus both `generated_tests` for runnable tests/reproducers and
`support_files` for their imported helpers, mocks, fixtures, scripts, and text
data. Entry rows cannot carry or override `framework`. Every path is under
`generated-tests/`, unique across both arrays, and bound to a non-empty,
singly linked, non-symlink, strict UTF-8 regular companion. Every entry requires the
companion's exact positive `size_bytes` and lowercase `sha256`; no file path may
be the slash-delimited prefix of another. Support-only manifests are invalid;
aggregation preserves the declared framework per atomic source bundle without
inference or conversion. V2 manifests are rejected without conversion.

Every retained JSON contract maps to one complete checked-in Draft 2020-12
schema. Contract definitions supply runtime validation plus the shape,
valid-empty form, and exact validation command appended to producer prompts.
Only current contract IDs are accepted. The invariant campaign-plan contract
retains its sealed v1 reader for historical runs; newly rendered campaigns emit
v2 timeout evidence. Other old schema versions, aliases, conversion readers,
and generic JSON contracts are unsupported.

## Meta Nodes

`__start__` and `__finish__` are graph wiring anchors.

```yaml
- id: __start__
  kind: meta
  role: start
  depends_on: []
- id: __finish__
  kind: meta
  role: finish
  depends_on:
    - final-report
```

Meta nodes must use `kind: meta`, `role: start` or `role: finish`, `loops: 1`,
and `loop_mode: parallel`. They must not define prompts, references, groups,
timeouts, artifacts, or model profiles.

## Reference Nodes

Reference nodes materialize pinned cached reference content into run artifacts.

```yaml
- id: reference-properties-montyly-rounding
  kind: reference
  reference: properties.montyly-rounding
  group: references
  depends_on:
    - __start__
  outputs:
    - path: references/rounding.md
      contract: ultrafuzz/nonempty-markdown@1
      primary: true
    - path: references/manifest.json
      contract: ultrafuzz/reference-manifest@1
```

Reference nodes must:

- Use `kind: reference`.
- Set `reference` to an ID in `.ultrafuzz/references.yml`.
- Use one parallel loop.
- Define contracted `outputs`.
- Include `references/manifest.json` in `outputs`.
- Mark exactly one non-manifest output as primary.
- Avoid `prompt`, `role`, and `model_profiles`.

Downstream prompts can consume the normalized Markdown primary artifact with:

```md
{{artifact_handoff:reference-properties-montyly-rounding}}
```

## Loop Expansion

Loop expansion is deterministic:

| Logical loops | Concrete IDs           |
| ------------- | ---------------------- |
| `loops: 1`    | `id`                   |
| `loops: 3`    | `id-0`, `id-1`, `id-2` |

`loop_mode: parallel` makes every attempt depend on the expanded dependencies.
`loop_mode: series` chains attempt `i` after attempt `i - 1`; downstream nodes
depend on the final series attempt.

The scaffold uses the `strategies` group default to run normal strategy nodes
three times, and uses explicit single-loop behavior for setup, references,
review, invariant, and exception-flow nodes.

## Model Fan-Out

Model profile fan-out is explicit:

```yaml
groups:
  strategies:
    defaults:
      model_profiles:
        - default
        - audit-heavy
nodes:
  - id: rounding-direction-audit
    group: strategies
    prompt: strategies/rounding-direction-audit.md
    depends_on:
      - base-test-setup
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@2
        primary: true
```

The node above fans out across both model profiles because the group default is
explicit. A node-level `model_profiles` list replaces the group list. Omitting
model selection does not fan out; it resolves to `[models].default`.

When a concrete node has multiple model profiles, artifact and workspace attempt
IDs include model and attempt metadata, such as
`rounding-direction-audit__model_1__attempt_1`.

## Validation Rules

Topology validation rejects:

- Unsupported topology versions.
- Missing or empty node lists.
- Duplicate or unsafe node IDs.
- Invalid group IDs or colors.
- Malformed meta, reference, or agentic nodes.
- Unknown, duplicate, or cyclic dependencies.
- Root nodes other than `__start__` or terminal nodes other than `__finish__`.
- Zero or excessive loop counts.
- Expanded graph size over implementation limits.
- Prompt paths that escape `.ultrafuzz/prompts/`.
- Missing prompt files during run validation.
- Unsafe, duplicate, missing, or uncontracted output paths.
- Nodes without exactly one primary output.
- Unknown fields at every topology level.
- Invalid or unknown model profile IDs.
- Required commands that are paths, flags, or shell fragments rather than bare
  executable names.
- Prompt artifact references to unknown producers, non-ancestors, or producers
  without declared artifacts.

## JSON Schema Bindings And Producer Validation

Users declare `path`, `contract`, and `primary` in topology; they do not paste a
schema path or digest into YAML. During planning, Ultrafuzz resolves each JSON
contract through the checked-in registry and persists this complete binding on
the planned output:

- schema filename and fragment-free `$id`;
- SHA-256 of the exact schema bytes;
- package schema-bundle digest; and
- validator build identity.

The expanded graph, run state, verification marker, and
`artifact-manifest.json` carry the same identity. The host rejects a missing,
partial, stale, or mismatched binding before publication.

Topology YAML remains version `2`; the persisted expanded graph uses
`graphVersion: "3"` and schema ID
`urn:ultrafuzz:schema:topology:expanded-graph:3` for this binding-bearing shape.

The rendered output contract gives the producer one safely quoted command per
JSON output:

```bash
ultrafuzz json validate --schema '<trusted absolute schema path>' --file '<absolute artifact path>'
```

The producer runs every command after its final write and before returning.
Exit `1` means it must correct its own draft and rerun during that same agent
session; exit `2` is a setup failure; all commands must exit `0`. Any later edit
requires another run. After the session returns, Ultrafuzz validates the exact
bytes again and applies named filesystem, Git, digest, uniqueness, and
cross-artifact gates. It never converts, normalizes, synthesizes, or repairs a
missing or invalid agent output, and it does not fall back to another file or
the model's final message. A post-session shape failure is terminal for that
attempt.
