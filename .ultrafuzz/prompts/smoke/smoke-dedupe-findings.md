---
id: smoke-dedupe-findings
display_name: Dedupe smoke findings
---

# Dedupe smoke findings

Perform one bounded, model-only consolidation pass over the four completed
strategy lanes. Do not rerun tests, install dependencies, edit production code,
or begin new exploratory analysis.

Read every input, including schema-valid empty artifacts:

- Time sequences: `{{artifact_path:time-warp-sequences}}/findings.json`
- External dependencies: `{{artifact_path:external-dependency-boundaries}}/findings.json`
- Externalized accounting: `{{artifact_path:externalized-state-accounting}}/findings.json`
- Lifecycle/views: `{{artifact_path:lifecycle-view-boundaries}}/findings.json`

Use affected code, reachable workflow, violated property, root cause, and
reproduction shape as the dedupe key. Merge only findings proven to share a
root cause. Keep the clearest evidence-bearing record, preserve a stable union
of strategies and provenance, and retain distinct symptoms when common cause is
not established. Do not promote speculation and do not discard a concrete
source-backed finding merely because native execution was blocked.

Write the retained normalized finding array to
`{{output_stage_findings_path}}` using the exact pinned
`{{schema_path}}/findings.schema.json`. Never add a synthetic finding when all
inputs are empty.

Write `{{artifact_path}}/strategy-detections.json` using the exact pinned
`{{schema_path}}/strategy-detections.schema.json`. Emit one detection per
retained root and preserve its finding identity, title, dedupe key, and all
available strategy/attempt/model/loop hit provenance.

Write `{{artifact_path}}/finding-lifecycle-ledger.json` using the exact pinned
`{{schema_path}}/finding-lifecycle-ledger.schema.json`. Preserve the source
artifacts and strategy hits for each root and its raw-to-deduped stage history.
Keep records, detections, and findings in the same order. Each retained
finding has exactly one lifecycle record and detection: their `dedupe_key`,
finding ID, title, optional family ID, and hit arrays agree exactly. Write one
raw stage per source artifact in source order using its exact path and finding
ID, followed by exactly one deduped stage whose `artifact_path` is the portable
declared output-relative path `{{output_stage_findings_relative_path}}` and whose
`finding_id` is the kept finding ID. Do not copy or write fields owned by later
triage, severity, or final-review stages. In particular, remove
`triage_classification` from a dedupe lifecycle record even if an input carries
it; preserving that field would still author a later-stage value at the dedupe
stage. Validate only JSON shape and required normalized-finding fields, then
stop. Those schemas alone define every JSON version, field, type, enum, required
member, and empty form. Run every exact
`ultrafuzz json validate` command rendered in the central output contract;
correct an exit-1 artifact yourself and rerun its command after any later edit.
