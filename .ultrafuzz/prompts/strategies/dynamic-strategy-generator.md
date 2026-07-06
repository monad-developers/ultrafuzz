---
id: dynamic-strategy-generator
display_name: Dynamic strategy generator
---

# Dynamic Strategy Generator

Read setup and property handoffs:

{{artifact_handoff:project-discovery}}
{{artifact_handoff:actors-flows}}
{{artifact_handoff:base-test-setup}}
{{artifact_handoff:property-specification-fanin}}

Read strategy artifacts:

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
{{artifact_path:stateful-invariant-setup}}
{{artifact_path:stateful-invariant-handlers}}
{{artifact_path:stateful-invariant-coverage}}
{{artifact_path:stateful-invariant-implement-properties}}
{{artifact_path:stateful-invariant-recon-campaign}}
{{artifact_path:differential-oracle-planner}}
{{artifact_path:reference-harness-author}}
{{artifact_path:reference-and-lane-auditor}}
{{artifact_path:differential-lane-author}}
{{artifact_path:differential-red-triage}}
{{artifact_path:differential-repair-and-report-review}}

Generate `{{dynamic_strategies_enumerator}}` candidate strategies under `{{strategy_attempt_test_dir}}` and write findings to `{{output_findings_path}}`.
