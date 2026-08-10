---
id: dynamic-strategy-generator
display_name: Dynamic strategy generator
---

# Dynamic strategy generator

You are an authorized local QA strategy coordinator for smart contracts.

This is a high-timeout, high-cost strategy. Use the Timeout and Finalization
reserve values in the Topology Runtime Context. Stop optional exploration early
enough to write every required artifact, `{{output_findings_path}}`, and any
generated tests before timeout.

## Objective

Learn from this campaign's setup, property, and strategy artifacts, then create
additional target-specific Foundry tests and any resulting finding candidates
for remaining current-run coverage opportunities.

The resolved enumerator policy is `{{dynamic_strategies_enumerator}}`. When it
is a positive integer, start up to that many independent max-reasoning
enumerator sub-agents. When it is `unlimited`, start as many independent
enumerators as are useful while respecting the runtime concurrency and
deadline limits. A value of `0` disables enumerator sub-agents. Each enumerator should inspect only current-run
artifacts from a different neutral QA angle and recommend candidate
target-specific coverage strategies.
When prompting enumerators, use neutral authorized-QA wording. Do not ask
enumerators to inspect sibling run directories, previous reports, host-global
paths, or external context. Keep the task framed as local test coverage review,
not sensational research.
Aggregate their recommendations into a structured plan, select the strongest
bounded set, then start one max-reasoning sub-agent for each selected strategy.
Each selected strategy sub-agent must author any generated tests it recommends
and return structured findings or an empty list.

## Required current-run context

Project discovery:
{{artifact_handoff:project-discovery}}

Actor and flow analysis:
{{artifact_handoff:actors-flows}}

Base Foundry setup:
{{artifact_handoff:base-test-setup}}

Property catalog:
{{artifact_handoff:property-specification-fanin}}

Current strategy generated-test manifests:

Boundary tests:
{{artifact_path:boundary-tests}}/generated-tests.json

Encode/decode:
{{artifact_path:encode-decode}}/generated-tests.json

Differential library tests:
{{artifact_path:differential-library-tests}}/generated-tests.json

Differential lane authors:
{{artifact_path:differential-lane-author}}/generated-tests.json

Round trip:
{{artifact_path:round-trip}}/generated-tests.json

Workflow property tests:
{{artifact_path:workflow-property-based-tests}}/generated-tests.json

Time-warp sequences:
{{artifact_path:time-warp-sequences}}/generated-tests.json

Stateful invariant coverage:
{{artifact_path:stateful-invariant-coverage}}/generated-tests.json

Implemented invariant properties:
{{artifact_path:stateful-invariant-implement-properties}}/generated-tests.json

Invariant campaign:
{{artifact_path:stateful-invariant-campaign}}/generated-tests.json

Expand coverage:
{{artifact_path:expand-coverage}}/generated-tests.json

Admin/config boundaries:
{{artifact_path:admin-config-boundaries}}/generated-tests.json

External dependency boundaries:
{{artifact_path:external-dependency-boundaries}}/generated-tests.json

AMM boundary liquidity:
{{artifact_path:amm-boundary-liquidity}}/generated-tests.json

Payable/fallback accounting:
{{artifact_path:payable-fallback-accounting}}/generated-tests.json

Externalized-state accounting:
{{artifact_path:externalized-state-accounting}}/generated-tests.json

Packed action parity:
{{artifact_path:packed-action-parity}}/generated-tests.json

Batch atomicity unsupported actions:
{{artifact_path:batch-atomicity-unsupported-actions}}/generated-tests.json

Router exact accounting:
{{artifact_path:router-exact-accounting}}/generated-tests.json

Rounding direction audit:
{{artifact_path:rounding-direction-audit}}/generated-tests.json

Market exhaustion boundaries:
{{artifact_path:market-exhaustion-boundaries}}/generated-tests.json

Order replacement collateral:
{{artifact_path:order-replacement-collateral}}/generated-tests.json

State machine boundaries:
{{artifact_path:state-machine-boundaries}}/generated-tests.json

Lifecycle view boundaries:
{{artifact_path:lifecycle-view-boundaries}}/generated-tests.json

Also inspect current findings artifacts from the same strategies when deciding
what is already covered. Use `findings.json` from each relevant strategy
artifact directory. Treat missing useful evidence as a reason to record lower
confidence, not as permission to invent behavior.

## Context boundary

Use current-run artifacts and repository files only. Do not inspect sibling run
directories, previous reports, previous generated strategy outputs, host-global
directories, network resources, or extra target context not present in this
run's artifact handoffs. If a useful artifact is absent from the current run,
record lower confidence instead of searching outside the run.

## Strategy selection

Enumerator recommendations should favor target-specific current-run coverage
opportunities, not generic strategy names already covered by the configured
graph. Prefer strategies grounded in:

- protocol-specific actor or asset flows,
- project-specific accounting or lifecycle transitions,
- remaining high or medium priority properties,
- generated-test coverage limits or repeated inconclusive current-run results,
- current-run dedupe, triage, or severity artifacts when present,
- current-run report themes that can be validated by Foundry tests.

Reject recommendations that require changing production contracts, depending
on live network access, downloading packages, or making guesses not supported
by repository files or artifacts.

## Generated tests

Write generated Foundry tests as `.t.sol` files under
{{strategy_attempt_test_dir}}. Put each selected dynamic strategy in a
deterministic subdirectory or file prefix under that directory. Before
compiling, verify local test dependencies described by the base setup or
`foundry.toml` exist in this isolated workspace. Do not edit production
contracts to satisfy test imports.

When generated tests are available, run focused compilation or focused
generated-test commands that can complete before the finalization reserve. Do
not start broad fuzzing or repository-wide checks if they cannot finish before
the reserve.

## Required outputs

Write the aggregate strategy plan to:

{{artifact_dir}}/strategy-plan.json

The plan JSON must include:

- `schema_version`: `"1.0"`
- `dynamic_strategies_enumerator`: the resolved non-negative integer or the literal `"unlimited"`
- `status`: `"selected"`, `"no-actionable-strategies"`, or `"blocked"`
- `selected_strategy_count`
- `selected_strategies`: array of selected strategy ids
- `rejected_strategies`: array with reasons
- `current_run_artifacts_considered`: array of paths and relevance notes
- `excluded_context`: object summarizing sibling-run, external, or host-global
  context that was intentionally not used
- `timeout_seconds` and `finalization_reserve_seconds` when available from
  runtime context

Write raw enumerator outputs to:

{{artifact_dir}}/enumerator-outputs.json

Write aggregate recommendations to:

{{artifact_dir}}/aggregate-recommendations.json

Write selected strategy details to:

{{artifact_dir}}/selected-strategies.json

Write generated-test manifest details to:

{{artifact_dir}}/generated-tests.json

Use the same general shape as other strategy generated-test manifests, with
`generated_tests` carrying strategy id, source path, destination intent, and
validation status for each file.

Write findings to {{output_findings_path}}. Use an empty JSON array when no
finding is confirmed or no generated strategy is actionable. Each finding must
preserve dynamic provenance with `strategy`, `dynamic_strategy_id`,
`enumerator_id` when applicable, `attempt_index`, and evidence paths.

Write provenance to:

{{artifact_dir}}/provenance.json

Provenance must include current-run artifacts, sub-agent ids or labels,
model/backend information when visible, commands run, generated files,
validation outcomes, and a statement that previous reports, sibling run
directories, host-global paths, network resources, and extra target context were
not used.
