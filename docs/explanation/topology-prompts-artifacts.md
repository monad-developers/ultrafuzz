# Topology, Prompts, and Artifacts

Ultrafuzz separates ownership between topology, prompts, and artifacts.

## Topology Owns Execution

`.ultrafuzz/topology.yml` owns node identity, dependencies, grouping, loop
settings, and required artifacts. It is the graph construction source of truth.

This prevents prompt folders from becoming hidden execution semantics. A prompt
can move for organization, but the topology node decides when and how it runs.

## Prompts Own Agent Instructions

Project prompts are Markdown files under `.ultrafuzz/prompts/`. They can use
frontmatter for user-facing metadata and supported template variables for
runtime context.

Unknown template variables fail validation. Ultrafuzz does not silently guess
or alias old placeholders because wrong prompt context can produce misleading
artifacts.

## Artifacts Own Handoffs

Agents write durable handoffs under their node artifact directory. Topology
`required_artifacts` declares which files must exist for downstream nodes and
reviewers.

This makes handoffs explicit:

- The prompt tells the agent what to write.
- The topology declares that the file is required.
- The executor validates and persists it.
- Downstream prompts reference it through typed template helpers.

## Rust Owns Boundaries

Rust owns parsing, validation, deterministic graph expansion, execution,
persistence, artifact handling, and migration decisions. That keeps campaign
state typed and testable even though the prompts remain editable Markdown.
