# Topology, Prompts, and Artifacts

Ultrafuzz separates ownership between topology, prompts, references, and
artifacts. That separation keeps editable campaign inputs visible while making
the resulting evidence durable enough to audit.

## Topology Owns Execution Shape

`.ultrafuzz/topology.yml` owns logical node identity, dependencies, grouping,
loop settings, required artifacts, primary artifacts, reference bindings, prompt
bindings, timeout overrides, and explicit model-profile fan-out. It is the graph
construction source of truth.

This prevents prompt folders from becoming hidden execution semantics. A prompt
can move for organization, but the topology node decides when and how it runs.
Group defaults can provide shared loop, timeout, or model-profile settings, and
node overrides make exceptions explicit.

Reference nodes are topology nodes too. They bind a graph dependency to a
pinned reference ID from `.ultrafuzz/references.yml` and declare the artifacts
that downstream agentic nodes can consume.

## Prompts Own Agent Instructions

Project prompts are Markdown-compatible files under `.ultrafuzz/prompts/**`.
They can use frontmatter only for identity and display metadata:

```md
---
id: boundary-tests
display_name: Boundary Tests
---
```

Prompt frontmatter does not own loops, enabled state, model profiles, or
timeouts. Unknown frontmatter fields and unknown template variables fail
validation because wrong prompt context can produce misleading artifacts.

Rendered prompts are stored as run artifacts before the linked workflow starts.
Artifact handoff helpers can reference only ancestor nodes, and producers must
declare a `primary_artifact` before another prompt can request that handoff.

## References Own External Context

`.ultrafuzz/references.yml` pins external reference material to full commits and
safe relative paths. Normal runs use the local digest-checked cache. Fetching or
updating references is explicit through the reference commands, not a hidden
side effect of `run`.

When a reference node runs, Ultrafuzz writes normalized Markdown plus a
`references/manifest.json` under that node's artifact directory. Missing cache
entries, digest mismatches, unsafe paths, unknown reference IDs, or missing
required reference artifacts fail before dependent agentic nodes run.

## Artifacts Own Handoffs

Agents write durable handoffs under their node artifact directory. Topology
`required_artifacts` declares which files must exist for downstream nodes and
reviewers.

This makes handoffs explicit:

- The prompt tells the agent what to write.
- The topology declares that the file is required.
- Ultrafuzz validates and persists the artifact.
- Downstream prompts reference it through typed template helpers.

Findings are normalized as arrays in `findings.json`. Final reports live in
agent-written final-report artifacts such as
`artifacts/final-report/report.md` and `artifacts/final-report/report.json`.

## Runtime Owns Product Evidence

At launch time, Ultrafuzz validates product state, renders prompts, materializes
reference-node artifacts, persists graph and run evidence, and launches a linked
workflow. Generated workflow files may exist, but they are plumbing rather than
stable product configuration.
