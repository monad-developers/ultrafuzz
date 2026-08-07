# Changelog

## Unreleased

- Adds first-class dynamic runtime nodes to topology v2. A static node can expand a schema-validated array from a completed upstream node into independently scheduled children with deterministic IDs such as `dynamic:threat:liquidation:overdue`. Children are ordinary nodes: visible, durable, independently retryable, bound by the existing global concurrency limit, and attributable in findings. The first successful expansion persists a manifest, so resume and controller takeover reuse it rather than re-evaluating changed planner output. A configurable `run.max_dynamic_nodes` (env `ULTRAFUZZ_MAX_DYNAMIC_NODES`) fails an oversized expansion explicitly instead of truncating it (#179).
- Adds threat modeling and additive `/goal` discovery to the default topology. A `threat-model` node produces `THREAT_MODEL.md` and canonical `threat-model.json` from actor/flow evidence, `goal-plan` turns that plus the pinned vulnerability database into schema-validated `goal-plan.json`, and the runtime expands one goal per threat and one per applicable vulnerability class alongside a fixed roaming goal that is an ordinary static node. Findings, deduplication, reports, and inspection carry the producing node ID (#182).
- Integrates the pinned external Web3 vulnerability database as a dedicated `kind: vulnerability-database` reference. Ultrafuzz fetches the exact immutable commit through the existing digest-checked reference cache, validates the upstream catalog, capability registry, and record frontmatter before planning, records repository/commit/schema/aggregate provenance in `vulnerability-db-manifest.json`, and copies only the exact selected Markdown records into the report bundle. The shipped pin is public and materializes without any credential (relates to #180).
- Adds a validated controller-to-worker selected-task handoff so a Modal node worker executes only the attempt its controller materialized, and refuses a handoff that does not reproduce the canonical task identity. Controller-owned state, including expansion manifests and rendered prompt snapshots, is never rematerialized by a worker (#179, #182).
- Invariant-suite handoffs now carry a deletion channel: the published manifest records tombstones, and a source a stage deleted, renamed away from, or emptied can no longer be resurrected out of an indirect ancestor artifact into a downstream workspace. A retry of the same stage drops the previous attempt's tombstones, so a source the restored workspace snapshot puts back is never published as a chain-wide deletion (#217).
- Invariant dependency handoff provenance is now persisted as a schema-validated record under durable run state and re-verified before materialization, so a restart between an invariant agent task and its verifier no longer kills the run and no longer reverts harness sources the stage already authored. The record binds itself to the ancestor manifests it was derived from, so a legitimately re-executed ancestor supersedes it instead of failing the stage closed (#219).
- Upgrades the pinned workflow engine to Smithers 0.32.0, moves both the workspace and the generated runner workspace onto one pinned Effect 4 tree, and migrates existing 0.31.0 manifests forward (#274).
- Fixes durable resume hydration so it runs after the engine resets stale in-progress attempts; upgrading alone would have restored a task as finished while the durable record said pending (#274).
- A partially installed workflow-runner dependency tree now reinstalls itself instead of failing every later resume of a durable run (#274).
- `ultrafuzz doctor` now reports a posture for every workflow-engine compatibility patch instead of only the two CLI patches, and its registry check survives the upstream package rename so the upgrade signal stays alive (#274).
- Adds first-class DeepSeek V4 Pro support through DeepSeek's official Claude
  Code endpoint, including cache-aware token telemetry, first-party pricing,
  Modal benchmark plumbing, and public benchmark coverage (#163).
- Fixes Kimi token accounting so UltrafuzzBench publishes tokens and an API-comparison cost for Kimi runs, and pins Kimi model pricing to the Moonshot provider (#162).

## v0.0.4

- Adds eval suites with a provider-agnostic `EvalReporter` and first-class node telemetry (#17).
- Adds eval suite documentation across the docs tree (#21).
- Adds Vyper target support in the setup phase (#11).
- Adds the StableSwapNG Vyper ground-truth benchmark and CI smoke coverage (#13).
- Generated Codex agents now request xhigh reasoning (#14).

## v0.0.3

- Adds the local dashboard package and `ultrafuzz dashboard` command.
- Adds target-repository E2E CI coverage and fixtures.
- Adds stricter report accounting, generated-test, and severity artifact validation.

## v0.0.2

- TypeScript rewrite release candidate.
- Removes the Rust workspace and rewrite-only scaffolding.
- Validated with TypeScript release gates and bounded target simulations.

## v0.0.1

- First external private release.
