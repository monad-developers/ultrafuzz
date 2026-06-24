# Edit Prompts and Topology

Ultrafuzz uses project-owned Markdown prompts and `.ultrafuzz/topology.yml` as
the editable campaign graph source of truth.

## Edit A Prompt

After `ultrafuzz init`, prompts live under:

```text
.ultrafuzz/prompts/
```

Open the prompt you want to adjust. Keep frontmatter IDs stable unless you are
intentionally renaming the topology node. `display_name` is a label and does
not automatically change execution identity.

Supported template variables are listed in
[Prompt Variables](../reference/prompt-variables.md). Unknown variables fail
validation instead of being guessed.

## Add A Prompt File

Place the Markdown file under the appropriate prompt group:

```text
.ultrafuzz/prompts/strategies/custom-invariant.md
```

Prompt folders are for organization and dashboard grouping. Execution semantics
come from topology node IDs, dependencies, loop settings, groups, and required
artifacts.

## Wire A Topology Node

Edit `.ultrafuzz/topology.yml`:

```yaml
version: 1
defaults:
  strategy_loops: 3
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: custom-invariant
    prompt: strategies/custom-invariant.md
    group: strategies
    depends_on:
      - property-specification-fanin
    required_artifacts:
      - findings.json
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
```

Agentic nodes run through the existing backend execution path. Topology YAML
does not define arbitrary shell runners.

## Declare Durable Handoffs

Use `required_artifacts` for files a node must write under its artifact
directory:

```yaml
required_artifacts:
  - properties.md
primary_artifact: properties.md
```

Downstream prompts can use:

```md
Read {{artifact_handoff:property-specification-fanin}} before writing tests.
```

Use `{{ancestor_artifacts}}` when a node should read every required artifact
from its direct topology dependencies.

## Validate Before Running

Run:

```bash
ultrafuzz doctor
```

If topology is missing or invalid where a topology is required, Ultrafuzz fails
clearly. Run paths do not synthesize a fallback topology after deletion.
