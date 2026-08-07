# Changelog

## Unreleased

- Publishes a three-target `deepseek / deepseek-v4-flash / max` UltrafuzzBench smoke benchmark judged by `gpt-5.6-sol / xhigh`, with provider-reported-alias identity, an unverified provider version, and the pinned DeepSeek V4 Flash rates (#165).
- `ultrafuzz replay` and `ultrafuzz fork` now require `--frame`, and both report a missing or invalid frame as a typed diagnostic instead of a parser error (#165).
- `ultrafuzz run` now requires a Git repository with a committed `HEAD`, so every benchmark task is pinned to, executes from, and attests one exact revision (#165).
- Hardens workflow-run locking and event-log recovery: a lost lock heartbeat no longer aborts the process or strands a lock directory, terminal lifecycle transitions commit their state and evidence together, and a torn trailing event record is repaired instead of wedging the run (#165).
- Detects and redacts a credential embedded in a base64 body at any byte alignment, so an encoded copy cannot cross the Modal boundary (#165).
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
- Recovery helpers validated against real durable state are recovered from two abandoned changes: an orphaned replacement lineage is adopted when submission reports `RUN_EXISTS`, a no-op rewind is removed from every recovery generation, run-state parsing reads every state a snapshot asserts (including one reported at the top of `data` with no wrapper) and refuses to pick a winner when two disagree, run-identity parsing binds the same wrapper-less shape so proving the run before resume no longer fails on it, and unverified dependencies are read off the run row (#324).
- Foundry test-root discovery is now one model rather than two: the compiled workspace output roots are re-anchored onto the single root the target repository actually uses, and retry cleanup follows those pinned roots plus the previous attempt's, so a `tests/`-only target never has a singular `test/` tree invented for it and never leaves the previous attempt's generated sources behind (#165, #212).
- Findings normalization that rewrites an already-verified `findings.json` now re-seals the attempt's verification marker and records the previous digest, rather than failing the node closed as an artifact-contract violation. The generated workflow normalizes in its own postflight, so the marker is usually already correct and nothing is rewritten; drift the runtime did not itself cause still fails closed (#348).
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
