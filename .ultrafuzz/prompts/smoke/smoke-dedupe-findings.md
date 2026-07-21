---
id: smoke-dedupe-findings
display_name: Dedupe smoke findings
---

# Dedupe smoke findings

Perform one bounded, model-only consolidation pass over the eight completed
strategy lanes. Do not rerun tests, install dependencies, edit production code,
or begin new exploratory analysis.

Read every input, including valid empty arrays:

- Admin/config: `{{artifact_path:admin-config-boundaries}}/findings.json`
- Time sequences: `{{artifact_path:time-warp-sequences}}/findings.json`
- External dependencies: `{{artifact_path:external-dependency-boundaries}}/findings.json`
- Externalized accounting: `{{artifact_path:externalized-state-accounting}}/findings.json`
- AMM/liquidity: `{{artifact_path:amm-boundary-liquidity}}/findings.json`
- Rounding: `{{artifact_path:rounding-direction-audit}}/findings.json`
- State machines: `{{artifact_path:state-machine-boundaries}}/findings.json`
- Lifecycle/views: `{{artifact_path:lifecycle-view-boundaries}}/findings.json`

Use affected code, reachable workflow, violated property, root cause, and
reproduction shape as the dedupe key. Merge only findings proven to share a
root cause. Keep the clearest evidence-bearing record, preserve a stable union
of strategies and provenance, and retain distinct symptoms when common cause is
not established. Do not promote speculation and do not discard a concrete
source-backed finding merely because native execution was blocked.

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
