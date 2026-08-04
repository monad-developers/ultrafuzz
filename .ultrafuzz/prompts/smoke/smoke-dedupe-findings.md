---
id: smoke-dedupe-findings
display_name: Dedupe smoke findings
---

# Dedupe smoke findings

Perform one bounded, model-only consolidation pass over the four fixed strategy
lanes, every generated threat/class goal child, and the fixed roaming goal. Do
not rerun tests, install dependencies, edit production code, or begin new
exploratory analysis.

Read every input, including valid empty arrays:

- Time sequences: `{{artifact_path:time-warp-sequences}}/findings.json`
- External dependencies: `{{artifact_path:external-dependency-boundaries}}/findings.json`
- Externalized accounting: `{{artifact_path:externalized-state-accounting}}/findings.json`
- Lifecycle/views: `{{artifact_path:lifecycle-view-boundaries}}/findings.json`
- Roaming goal: `{{artifact_path:goal-roaming}}/findings.json`
- Every child of the `threat-goals` and `class-goals` dynamic groups, including
  valid empty findings arrays

Use affected code, reachable workflow, violated property, root cause, and
reproduction shape as the dedupe key. Merge only findings proven to share a
root cause. Keep the clearest evidence-bearing record, preserve a stable union
of strategies and provenance, and retain distinct symptoms when common cause is
not established. Do not promote speculation and do not discard a concrete
source-backed finding merely because native execution was blocked.

For every retained root, write the stable first-seen union of all contributing
runtime `source_nodes` values, falling back to legacy `source_node_id`. Keep
`source_node_id` equal to the union's first entry. Never replace generated
human IDs such as `dynamic:threat:...` or `dynamic:class:...` with a group or
dedupe node ID.

Write the retained normalized finding array to
`{{artifact_path}}/deduped-findings.json`. Never add a synthetic finding when
all inputs are empty.

Write `{{artifact_path}}/strategy-detections.json` as an array with one entry
per retained root: `dedupe_key`, `finding_id`, `title`, and `hits`. Each hit
records its strategy and any available attempt/model/loop provenance.

Write `{{artifact_path}}/finding-lifecycle-ledger.json` as an object with
`schema_version: "1.0"` and `records`. Each record includes `dedupe_key`,
`source_artifacts`, `strategy_hits`, and `stages` containing raw and deduped
stages. Validate only JSON shape and required normalized-finding fields, then
stop.
