---
id: aggregate-test-files
display_name: Aggregate test files
---

# Aggregate Test Files

Aggregate generated tests for `{{repo_path}}` from workspace `{{workspace_path}}`.

{{artifact_path:boundary-tests}}
{{artifact_path:encode-decode}}
{{artifact_path:differential-library-tests}}
{{artifact_path:round-trip}}
{{artifact_path:workflow-property-based-tests}}
{{artifact_path:time-warp-sequences}}
{{artifact_path:expand-coverage}}
{{artifact_path:admin-config-boundaries}}
{{artifact_path:external-dependency-boundaries}}
{{artifact_path:externalized-state-accounting}}
{{artifact_path:amm-boundary-liquidity}}
{{artifact_path:payable-fallback-accounting}}
{{artifact_path:packed-action-parity}}
{{artifact_path:batch-atomicity-unsupported-actions}}
{{artifact_path:router-exact-accounting}}
{{artifact_path:rounding-direction-audit}}
{{artifact_path:market-exhaustion-boundaries}}
{{artifact_path:order-replacement-collateral}}
{{artifact_path:state-machine-boundaries}}
{{artifact_path:lifecycle-view-boundaries}}
{{artifact_path:stateful-invariant-implement-properties}}
{{artifact_path:stateful-invariant-recon-campaign}}
{{artifact_path:differential-lane-author}}
{{artifact_path:differential-repair-and-report-review}}
{{artifact_path:dynamic-strategy-generator}}
{{artifact_path:dedupe-findings}}
{{artifact_path:severity-classification}}

Write aggregation output to `{{artifact_path}}/aggregation.json`.
