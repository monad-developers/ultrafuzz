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
  strategy_loops: 3
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    prompt: setup/project-discovery.md
    group: setup
    depends_on:
      - __start__
    required_artifacts:
      - setup/project-discovery.md
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
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
```

## Required Fields

| Field | Meaning |
| --- | --- |
| `version` | Topology schema version. Current value is `1`. |
| `defaults.strategy_loops` | Global default for top-level normal strategy attempts. |
| `nodes` | Ordered list of logical graph nodes. |
| `id` | Stable topology node identity. |
| `depends_on` | Logical predecessor node IDs. |

## Agentic Node Fields

| Field | Meaning |
| --- | --- |
| `prompt` | Prompt path under `.ultrafuzz/prompts/`. |
| `group` | Dashboard and graph grouping. |
| `loops` | Explicit loop count for nodes that do not inherit the normal strategy default. |
| `required_artifacts` | Files the node must write under its artifact directory. |
| `primary_artifact` | One required artifact used by `artifact_handoff:<node-id>`. Set it explicitly on handoff producers. |
| `timeout_seconds` | Node timeout override. |

## Meta Nodes

`__start__` is the only valid root and `__finish__` is the only valid terminal
node.

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

Meta nodes are graph wiring anchors only. They do not load prompts, run
backends, or require artifacts.

## Reference Nodes

Reference nodes are deterministic executor-owned nodes, not agent nodes. They
materialize pinned GitHub cache entries from `.ultrafuzz/references.yml` into
run artifacts.

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

Reference nodes must not set `prompt` or `role`, must use `loops: 1`, and must
declare `references/manifest.json` plus a primary reference artifact. Downstream
agent prompts consume the primary artifact with:

```md
{{artifact_handoff:reference-properties-montyly-rounding}}
```

## Strategy Loop Defaults

```yaml
defaults:
  strategy_loops: 3
```

`ultrafuzz init --strategy-loops <N>` writes the initial value.
`ultrafuzz run --strategy-loops <N>` persists a new value before building the
campaign graph.

Top-level normal strategy nodes in the `strategies` group with prompts under
`strategies/` inherit this default. Invariant, differential, setup, property,
review, custom non-strategy, and meta nodes keep explicit loop behavior.

## Validation Rules

Topology validation rejects:

- Unsupported topology versions.
- Missing `defaults`.
- Missing or malformed `__start__` and `__finish__`.
- Root nodes other than `__start__`.
- Terminal nodes other than `__finish__`.
- Meta nodes with prompts, required artifacts, primary artifacts, or invalid
  roles.
- Reference nodes without a catalog `reference`, with a prompt or meta role,
  with loop settings other than a single parallel pass, or without
  `references/manifest.json`.
- Required artifact paths that escape the artifact directory.
- `primary_artifact` values that are not listed in `required_artifacts`.
- Prompt artifact handoff references to unknown, non-ancestor, or unproduced
  artifacts.
