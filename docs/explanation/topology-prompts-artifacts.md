# Topology, Prompts, and Artifacts

Ultrafuzz separates ownership between topology, prompts, references, and
artifacts. That separation keeps editable campaign inputs visible while making
the resulting evidence durable enough to audit.

## Topology Owns Execution Shape

`.ultrafuzz/topology.yml` owns logical node identity, dependencies, grouping,
loop settings, versioned output contracts, reference bindings, prompt
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
mark exactly one contracted output as primary before another prompt can request
that handoff.

## References Own External Context

`.ultrafuzz/references.yml` pins external reference material to full commits and
safe relative paths. Normal runs use the local digest-checked cache. Fetching or
updating references is explicit through the reference commands, not a hidden
side effect of `run`.

When a document reference node runs, Ultrafuzz writes normalized Markdown plus a
`references/manifest.json` under that node's artifact directory. A
`kind: vulnerability-database` reference instead materializes the exact upstream
files below `vulnerability-db/`, alongside the same run reference manifest.
Missing cache entries, digest mismatches, unsafe paths, unknown reference IDs, or
missing required reference artifacts fail before dependent agentic nodes run.

## Artifacts Own Handoffs

Agents write durable handoffs under their node artifact directory. Topology
`outputs` declares which files must exist, how each is validated, which empty
form is valid, and which file is the primary downstream handoff.

This makes handoffs explicit:

- The prompt tells the agent what to write.
- The topology declares a named, versioned contract for the file.
- A deterministic workflow task validates the artifact before dependents start.
- Ultrafuzz persists contract identities, content hashes, and prerequisite
  manifest digests.
- Downstream prompts reference it through typed template helpers.

Findings are normalized as arrays in `findings.json`. Final reports live in
agent-written final-report artifacts such as
`artifacts/final-report/report.md` and `artifacts/final-report/report.json`.
The structured terminal report is validated before scoring or publication.

## Runtime Owns Product Evidence

At launch time, Ultrafuzz validates product state, renders prompts, materializes
reference-node artifacts, persists graph and run evidence, and launches a linked
workflow. Generated workflow files may exist, but they are plumbing rather than
stable product configuration.
