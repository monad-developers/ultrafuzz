# Changelog

## Unreleased

- Adds the `threat-model` benchmark lane: the v0.1.0 release gate that runs the production topology against the three pinned Ultrafuzz-bench targets. The smoke lane substitutes the reduced `benchmarks/smoke-benchmark.yml` graph and the full lane is bound to the EVMBench cohort, so before this lane the `threat-model`, `goal-plan`, `threat-goals`, and `class-goals` nodes never met a real pinned protocol. The lane prunes nothing, takes its GPT-5.6 Luna/high runner from `benchmarks/lanes.json` rather than the dispatch form, retains `THREAT_MODEL.md`, `threat-model.json`, `goal-plan.json`, and `vulnerability-db-manifest.json` from every row, and is refused by the history publisher so its different execution policy never joins the longitudinal series. Select it with the `benchmark_lane` workflow-dispatch input; nothing dispatches it automatically (#183).
- Adds first-class dynamic runtime nodes to topology v2. A static node can expand a schema-validated array from a completed upstream node into independently scheduled children with deterministic IDs such as `dynamic:threat:liquidation:overdue`. Children are ordinary nodes: visible, durable, independently retryable, bound by the existing global concurrency limit, and attributable in findings. The first successful expansion persists a manifest, so resume and controller takeover reuse it rather than re-evaluating changed planner output. A configurable `run.max_dynamic_nodes` (env `ULTRAFUZZ_MAX_DYNAMIC_NODES`) fails an oversized expansion explicitly instead of truncating it (#179).
- Adds threat modeling and additive `/goal` discovery to the default topology. A `threat-model` node produces `THREAT_MODEL.md` and canonical `threat-model.json` from actor/flow evidence, `goal-plan` turns that plus the pinned vulnerability database into schema-validated `goal-plan.json`, and the runtime expands one goal per threat and one per applicable vulnerability class alongside a fixed roaming goal that is an ordinary static node. Findings, deduplication, reports, and inspection carry the producing node ID (#182).
- Integrates the pinned external Web3 vulnerability database as a dedicated `kind: vulnerability-database` reference. Ultrafuzz fetches the exact immutable commit through the existing digest-checked reference cache, validates the upstream catalog, capability registry, and record frontmatter before planning, records repository/commit/schema/aggregate provenance in `vulnerability-db-manifest.json`, and copies only the exact selected Markdown records into the report bundle. The shipped pin is public and materializes without any credential (relates to #180).
- Adds a validated controller-to-worker selected-task handoff so a Modal node worker executes only the attempt its controller materialized, and refuses a handoff that does not reproduce the canonical task identity. Controller-owned state, including expansion manifests and rendered prompt snapshots, is never rematerialized by a worker (#179, #182).
- The non-default-branch smoke gate now forgives any operational failure category instead of only `resume-required` with collected diagnostics, so an infrastructure failure on one control pair no longer blocks unrelated pull requests. The failure is still surfaced as a warning annotation rather than silently passed (#321).
- Every invariant-discovery git enumeration now runs under an explicit capture bound and reports an oversized listing by naming the subcommand, the bound and the largest contributing roots, instead of failing as an anonymous `ENOBUFS` system error. Five call sites were unbounded, not the three originally reported (#323).
- A worker that ends unexpectedly now records a bounded, redacted tail of its child's stderr as the cause of its terminal error and prints a frame-only stack, so an unanticipated failure is diagnosable instead of surfacing as a bare `worker operation failed`. The public worker's previously raw stderr embedding is routed through the same redactor (#307).
- A fault the worker names itself is no longer reported as a sandbox exit, and the collector no longer demands a public eval diagnostics document that a failing build never wrote. The eval journal is now read after a nonzero `ultrafuzz eval run` exit, where the corroboration could previously never run at all; an externally killed command keeps its raised flag because it may have launched work it never journaled (#320, #332).
- `status.json` and `recovery-lifecycle.json` now render one recovery summary from a single authority, instead of independently recomputing summaries that disagreed about whether model work happened (#322).
- A verification marker the runtime refreshed can now be republished when the only difference is a digest matching the bytes actually published, instead of stranding the attempt on a byte comparison that repeated identically on every retry. Source-proof publication keeps its unconditional comparison (#280).
- A terminally failed workflow whose failing task is an artifact-preparation wrapper is preserved through worktree reaping and surfaces as an attributable failed node (#122).
- Invariant-suite source enumeration is now depth-bounded, and one shared budget is charged across the whole ancestor union before traversal rather than giving each ancestor a fresh allowance, so a deep or wide suite fails closed before roughly a thousand files are written (#218).
- Invariant-suite handoff behaviour is now covered by tests that execute the real helpers rather than harness stubs: the protected baseline outranks a rewritten sidecar, a changed `src/` helper reaches the manifest and survives one hop downstream, plural Foundry test roots are preserved, an inherited-only ancestor source survives, and an unexpected file in the suite root fails publication closed (#211, #212, #213, #214, #215).
- An invariant evidence ledger with no entries now fails both the discovery and fan-in gates unless it records `no_invariants_justification`, so silent emptiness cannot satisfy the evidence requirement while a genuinely invariant-free target stays possible and auditable. The fan-in gate also checks scan-probe containment, which it previously skipped for every ledger shape (#292).
- An absent property reference-expectation catalogue is now reported instead of silently yielding an empty identifier set, and enforcement is switchable through `[invariants] reference_expectation_enforcement`, defaulting to `warn` (#285).
- The runtime gate and the generated workflow template now share one scan-probe source validator, so `ultrafuzz validate` no longer predicts a different outcome from the run it is validating (#301).
- Recovery helpers validated against real durable state are recovered from two abandoned changes: an orphaned replacement lineage is adopted when submission reports `RUN_EXISTS`, a no-op rewind is removed from every recovery generation, run-state parsing gains a top-level fallback, and unverified dependencies are read off the run row (#324).
- Invariant-suite handoffs now carry a deletion channel: the published manifest records tombstones, and a source a stage deleted, renamed away from, or emptied can no longer be resurrected out of an indirect ancestor artifact into a downstream workspace. A retry of the same stage drops the previous attempt's tombstones, so a source the restored workspace snapshot puts back is never published as a chain-wide deletion (#217).
- Invariant dependency handoff provenance is now persisted as a schema-validated record under durable run state and re-verified before materialization, so a restart between an invariant agent task and its verifier no longer kills the run and no longer reverts harness sources the stage already authored. The record binds itself to the ancestor manifests it was derived from, so a legitimately re-executed ancestor supersedes it instead of failing the stage closed (#219).
- A terminally failed workflow whose failing task is an artifact preparation wrapper now surfaces as a failed durable node with an `artifact-contract` failure category and a `causal_task_id` naming the wrapper, instead of leaving a ready pending node on a run that already ended; a terminal failure that still cannot be attributed to any node records a durable `WORKFLOW_TERMINAL_WITHOUT_FAILED_NODE` diagnostic naming the failing workflow tasks. A cancelled or stalled wrapper is left unattributed, and a node that later succeeds no longer keeps the failure attribution from the attempt that failed (#272).
- The Modal pre-model launch retry budget is now charged against consecutive attempts that never reached model work instead of every attempt a model has made in the generation, so a long run is no longer abandoned as `recovery-budget-exhausted` because earlier attempts did real model work and then asked for a durable resume. The unattended overseer now records the model-work observation it already read from the volume when it relaunches, so the streak resets on that path too, and an abandonment message names the pre-model budget only when that budget is what stopped the run. The outer no-progress recovery bound is unchanged (#267).
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
