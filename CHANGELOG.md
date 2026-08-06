# Changelog

## Unreleased

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
