# Edit Prompts And Topology

Ultrafuzz uses project-owned Markdown prompts and
`.ultrafuzz/topology.yml` as the campaign graph source of truth.

## Edit A Prompt

After `ultrafuzz init`, editable prompts live under:

```text
.ultrafuzz/prompts/
```

Prompt frontmatter may include only identity and display metadata:

```md
---
id: boundary-tests
display_name: Boundary Tests
---
```

Keep `id` stable unless you are intentionally changing execution identity.
`display_name` is only a label. Execution knobs such as loops, enabled state,
model profiles, and timeouts belong in topology, not prompt frontmatter.

Supported prompt variables are listed in [SPECS.md](../SPECS.md#prompts).
Unknown variables fail validation.

## Add A Prompt File

Place the prompt under `.ultrafuzz/prompts/**`:

```text
.ultrafuzz/prompts/strategies/custom-invariant.md
```

Folders are for organization. Execution comes from topology node IDs,
dependencies, loop settings, groups, model profiles, and output contracts.

## Wire A Topology Node

Edit `.ultrafuzz/topology.yml`:

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
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: custom-invariant
    kind: agentic
    prompt: strategies/custom-invariant.md
    group: strategies
    depends_on:
      - property-specification-fanin
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@1
        primary: true
      - path: generated-tests.json
        contract: ultrafuzz/generated-tests@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - custom-invariant
```

Agentic nodes run through the configured workflow adapter. Topology does not
define arbitrary shell runners.

## Declare Durable Handoffs

Use `outputs` for files a node must write under its artifact directory. Every
output names a contract, and exactly one output is the primary handoff.

```yaml
outputs:
  - path: properties.md
    contract: ultrafuzz/nonempty-markdown@1
    primary: true
```

Downstream prompts can reference ancestor artifacts:

```md
Read {{artifact_handoff:property-specification-fanin}} before writing tests.
```

Handoff variables resolve only to ancestor nodes. Producers must declare the
artifacts they hand off.

## Work With References

Reference nodes bind to IDs in `.ultrafuzz/references.yml`. If you add or
update reference bindings, sync the cache explicitly before runs that need
those pinned files:

```bash
ultrafuzz references sync --project /path/to/target-protocol
```

## Validate Before Running

```bash
ultrafuzz validate --project /path/to/target-protocol
```

Validation rejects missing prompt files, invalid topology versions, duplicate
node IDs, unknown dependencies, unsafe artifact paths, unknown model profiles,
and prompt artifact references to non-ancestor producers.
