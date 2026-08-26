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
        contract: ultrafuzz/findings@2
        primary: true
      - path: generated-tests.json
        contract: ultrafuzz/generated-tests@3
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

## Author A JSON Handoff

Choose a current, named contract from the
[contract migration inventory](../reference/artifact-contract-migration-v2.md).
Do not use the removed `ultrafuzz/json-object@1` or
`ultrafuzz/json-array@1` contracts, and do not copy an old version literal from
an earlier run. The checked-in JSON Schema is the canonical whole-document
shape; prompt prose should explain the domain task without inventing aliases or
alternate empty forms.

Ultrafuzz centrally appends the resolved schema, valid-empty form, and exact
schema and contract validation commands for every declared JSON output. You do
not need to hard-code either command in the editable prompt. The rendered
instructions look like:

```bash
ultrafuzz json validate --schema '<trusted absolute schema path>' --file '<absolute artifact path>'
ultrafuzz artifact validate '<contract-id>' '<absolute artifact path>'
```

Generated-test outputs also receive a third, task-context command. Ultrafuzz
fills its `--run-id`, `--logical-node-id`, and `--artifact-root` arguments from
the sealed task; do not hard-code or override it in an editable prompt.

Tell the producer to finish the file, run every displayed command, correct and
rerun an exit-`1` draft in the same session, and return only after all commands
exit `0`. Exit `2` means the trusted validator or schema setup failed; it is not
permission to edit the schema. If the file changes after validation, its
command must be rerun.

Do not ask a downstream node or the host to repair, normalize, convert, or
reconstruct invalid JSON. Once the producer returns, its bytes are immutable.
The host still applies named semantic/context gates and makes missing or invalid
required output a terminal attempt failure.

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

`ultrafuzz validate` checks project configuration and graph inputs. To check a
JSON fixture against the same document-shape validator used by producers and
the host, run the separate command with explicit files:

```bash
ultrafuzz json validate \
  --schema /absolute/path/to/current.schema.json \
  --file /absolute/path/to/fixture.json
```

Exit `0` proves portable shape conformance only. Cross-file joins, filesystem
facts, Git facts, and digest relationships remain host gates.
