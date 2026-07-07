# Topology YAML

Project topology lives at:

```text
.ultrafuzz/topology.yml
```

It is the source of truth for campaign graph construction.

## File Shape

```yaml
version: 1
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
    required_artifacts:
      - findings.json
    primary_artifact: findings.json
  - id: final-report
    kind: agentic
    prompt: review/final-report.md
    group: review
    depends_on:
      - boundary-tests
    required_artifacts:
      - report.md
      - report.json
    primary_artifact: report.md
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
```

## Top-Level Fields

| Field                     | Meaning                                               |
| ------------------------- | ----------------------------------------------------- |
| `version`                 | Topology version. Current value is `1`.               |
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
| `model_profiles`  | Explicit model profile list for nodes in the group. |

Node fields override group defaults. A node or group `model_profiles` list is
the model fan-out surface. When neither a node nor its group selects model
profiles, the node uses the configured default model profile only.

## Node Fields

Every node must define:

| Field        | Meaning                       |
| ------------ | ----------------------------- |
| `id`         | Stable logical node ID.       |
| `depends_on` | Logical predecessor node IDs. |

Agentic nodes support:

| Field                | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `kind`               | Optional. Defaults to `agentic`.                            |
| `prompt`             | Prompt path under `.ultrafuzz/prompts/`.                    |
| `group`              | Group ID.                                                   |
| `loops`              | Node loop count. Overrides group and global loop defaults.  |
| `loop_mode`          | `parallel` or `series`. Defaults to `parallel`.             |
| `timeout_seconds`    | Node timeout override.                                      |
| `required_artifacts` | Files the node must write under its artifact directory.     |
| `primary_artifact`   | One required artifact used by `artifact_handoff:<node-id>`. |
| `model_profiles`     | Explicit model profile fan-out for this node.               |

Prompt paths and artifact paths must be relative, traversal-free paths. Required
artifact paths are relative to the node artifact directory and must not start
with `artifacts/` or `.ultrafuzz/`.

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
  required_artifacts:
    - references/rounding.md
    - references/manifest.json
  primary_artifact: references/rounding.md
```

Reference nodes must:

- Use `kind: reference`.
- Set `reference` to an ID in `.ultrafuzz/references.yml`.
- Use one parallel loop.
- Define `required_artifacts`.
- Include `references/manifest.json` in `required_artifacts`.
- Define `primary_artifact`, and not use `references/manifest.json` as the primary artifact.
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
    required_artifacts:
      - findings.json
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
- Unsafe required or primary artifact paths.
- `primary_artifact` values not listed in `required_artifacts`.
- Invalid or unknown model profile IDs.
- Prompt artifact references to unknown producers, non-ancestors, or producers
  without declared artifacts.
