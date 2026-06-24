# AGENTS.md

## Purpose

This file is the short map for agents working in this repository. Keep it
compact: put durable details in repo-local docs and tests, then link or mention
them here. If a recurring correction shows up in review, encode it in
tooling/tests or durable product documentation.

## Repository Map

- This is a Rust workspace for `ultrafuzz`, a Rust-native agentic Solidity
  fuzzing campaign orchestrator.
- Workspace crates live under `crates/`:
  - `ultrafuzz-core`: shared IDs, statuses, findings, backend/workspace enums.
  - `ultrafuzz-config`: config loading, defaults, overrides, validation,
    redaction.
  - `ultrafuzz-prompts`: bundled/project Markdown prompts, frontmatter,
    template validation/rendering, prompt scaffolding.
  - `ultrafuzz-topology`: `.ultrafuzz/topology.yml` loading, validation,
    loop expansion, graph serialization/fingerprints.
  - `ultrafuzz-artifacts`, `ultrafuzz-events`, `ultrafuzz-state`,
    `ultrafuzz-workspace`: run layout, event stores, restartable state,
    isolated workspaces.
  - `ultrafuzz-agent`, `ultrafuzz-executor`, `ultrafuzz-dashboard`,
    `ultrafuzz-cli`: backend subprocesses, DAG execution, local dashboard,
    and CLI.
- Bundled prompt defaults live in `prompts/`; initialized target projects get
  editable copies under `.ultrafuzz/prompts/`.
- The dashboard frontend is in `crates/ultrafuzz-dashboard/frontend`.

## Product Direction

- Treat project-owned Markdown prompts and `.ultrafuzz/topology.yml` as the
  editable source of truth for campaign graph construction.
- Rust owns parsing, validation, deterministic expansion, execution,
  persistence, artifact handling, and explicit migration decisions.
- Do not reintroduce a fixed Rust topology fallback for normal run paths.
  Missing or invalid topology should fail clearly where a topology is required.
- Do not add arbitrary shell-command runner types to topology YAML. Agentic
  nodes run through the existing backend execution path.
- Prompt folders are organizational and visual; execution semantics come from
  topology node IDs, edges, loop settings, groups, and required artifacts.
- Keep the product behavior conservative: no auto-commit, auto-push,
  auto-submit, or auto-merge of target repositories.

## Legacy, Fallbacks, And Compatibility

- Default stance: do not preserve old behavior unless the current task
  explicitly asks for a migration path. Prefer clear failure, regeneration, or a
  small documented migration over silent compatibility shims.
- Do not add runtime fallbacks that synthesize missing product state. For
  example, `ultrafuzz init` may scaffold `.ultrafuzz/topology.yml`, but run and
  dashboard paths should not invent a fallback topology after the user deletes
  it.
- Do not keep legacy CLI aliases, config keys, prompt paths, graph nodes, or
  template variable names just to be forgiving. Removed surfaces should usually
  be rejected with a clear error and covered by regression tests.
- Do not silently alias unknown prompt variables or deprecated placeholders.
  Unknown variables should fail validation unless a PRD explicitly calls for a
  one-time migration.
- New scaffolding should use only the canonical current prompt tree and topology
  shape. Do not reintroduce obsolete project prompt files for older layouts.
- If compatibility is genuinely required, make it narrow, visible, and tested:
  document the reason in durable docs, add regression coverage, and avoid
  letting the old path become a second supported way to do the same thing.

## Rust Practices

- Prefer typed domain structs/enums and serde forms over stringly-typed logic.
- Parse and validate data at boundaries: config, topology YAML, prompt
  frontmatter, dashboard requests, artifact manifests, and backend outputs.
- Keep crate boundaries meaningful and dependency directions simple. Do not add
  broad generic framework layers when a concrete Ultrafuzz type or helper is
  enough.
- Preserve deterministic output paths, graph fingerprints, run artifacts, and
  restart behavior. Be careful with changes that affect persisted `graph.json`,
  `state.json`, event stores, or artifact schemas.
- Avoid `unwrap`/`expect` in production paths unless the invariant is local and
  obvious. Prefer `thiserror` for library errors and `anyhow` at CLI/executor
  orchestration boundaries, matching the existing code.
- Keep Clippy clean with warnings denied.

## Prompt And Topology Rules

- Supported template variables are defined in
  `crates/ultrafuzz-prompts/src/lib.rs` as `SUPPORTED_TEMPLATE_VARIABLES`.
  Update validation, rendering, dashboard session data, tests, bundled prompts,
  and README together when this surface changes.
- Built-in and project prompts should fail fast on unsupported variables; do not
  silently guess or expand unknown placeholders.
- Prompt saves and topology saves must stay path-safe: no escaping
  `.ultrafuzz/prompts/`, no unsafe relative paths, and no symlink traversal.
- For node identity UX, prefer Markdown frontmatter `id` as the normal
  user-facing rename path. Keep topology IDs, prompt files, dependencies,
  logical metadata, and loop-expanded concrete IDs synchronized.
- `display_name` is for labels. Do not change it automatically just because an
  `id` changes.
- Required topology artifacts should be explicit and enforced. Runtime prompt
  context should tell agents the exact required artifact paths.

## Dashboard And Frontend Rules

- The supported CLI command is `ultrafuzz dashboard`; do not restore a legacy
  `ui` alias.
- Dashboard APIs that mutate files or run commands must keep session-token and
  local Host/Origin protections.
- Dashboard topology/prompt editors should prevent invalid saves and show useful
  validation errors instead of accepting broken state.
- React Flow displays logical nodes by default. Loop-expanded attempts can be
  shown in details/toggles, but the editable surface should stay logical.
- Do not show internal node IDs, prompt IDs, raw `kind` strings, or strategy
  slugs on normal graph cards when display names or labels are available.
- Keep generated frontend assets out of git. `crates/ultrafuzz-dashboard/frontend/dist/`,
  `node_modules/`, Playwright output, screenshots, Cargo targets, `.ultrafuzz/`,
  and `.codex-runs/` are local artifacts unless explicitly requested otherwise.

## Taste And Product Judgment

- Delete obsolete surfaces once they are superseded. Do not leave old prototype
  files, stale prompt catalogs, unused Make targets, deprecated aliases, or
  stale docs in place as archaeological layers.
- Avoid duplicate user-facing identity. In dashboard chrome and normal user
  flows, prefer display names, labels, statuses, and actions. Keep raw node IDs,
  prompt IDs, paths, and serialized kind strings inside Markdown frontmatter,
  technical details, artifacts, or developer-oriented views.
- The dashboard should feel operational, not decorative. Favor dense but
  readable layouts, useful status, visible errors, restrained styling, stable
  graph grouping, and cards that explain workflow state without exposing
  internal slugs.
- Repo-local docs must track reality. When behavior changes, update the relevant
  README section, reference doc, or prompt guidance so future agents do not
  follow stale instructions.
- Prefer explicit user-visible errors over silent recovery. Invalid topology,
  invalid prompt variables, rejected dashboard saves, command failures, and
  security/path checks should fail clearly with actionable messages.
- Visual/dashboard changes need real smoke evidence. For graph layout, prompt
  editing, topology editing, asset loading, or responsive UI changes, run
  Playwright/browser smoke where practical and verify labels, overflow, grouping,
  and embedded assets instead of relying only on typecheck/build.

## Planning And Review

- Treat automated PR review comments as required unless they are clearly stale
  or non-actionable. If you decide one is stale, record why.
- Work depth-first: reproduce or inspect the concrete failure, make the smallest
  coherent fix, add/adjust focused tests when useful, then run the lightest
  relevant verification. Save broad gates for PR validation unless risk demands
  them earlier.
- Prefer strengthening repo-local feedback loops over leaving instructions only
  in prose. If a rule can be a test, lint, validation error, or smoke check,
  encode it.

## Commands

Use workspace-local Cargo cache directories for repeatable checks.

Default iteration should be lightweight and scoped to touched code:

```bash
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo check -p <crate>
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test -p <crate> <test-name>
npm --prefix crates/ultrafuzz-dashboard/frontend run test -- <test-file-or-filter>
npm --prefix crates/ultrafuzz-dashboard/frontend run typecheck
```

PR validation Rust gates:

```bash
cargo fmt --all -- --check
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo check --workspace
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo clippy --workspace --all-targets -- -D warnings
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test --workspace
```

PR validation dashboard frontend gates:

```bash
npm --prefix crates/ultrafuzz-dashboard/frontend ci
npm --prefix crates/ultrafuzz-dashboard/frontend run format:check
npm --prefix crates/ultrafuzz-dashboard/frontend run lint
npm --prefix crates/ultrafuzz-dashboard/frontend run test
npm --prefix crates/ultrafuzz-dashboard/frontend run typecheck
npm --prefix crates/ultrafuzz-dashboard/frontend run build
```

PR validation dashboard embedded-asset and browser smoke gates:

```bash
ULTRAFUZZ_DASHBOARD_REQUIRE_ASSETS=1 CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test -p ultrafuzz-dashboard
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target npm --prefix crates/ultrafuzz-dashboard/frontend run smoke
make dashboard-smoke
```

## Verification Guidance

- During ordinary Codex interactions, prefer the smallest command that exercises
  the changed behavior: a focused unit test, one crate check, TypeScript
  typecheck, or a targeted frontend test.
- Do not run full workspace tests, full frontend gates, embedded-asset tests, or
  browser smoke by default. Run them during PR validation, before merge/push, on
  explicit request, or when the change is broad/high-risk enough to justify the
  time.
- If behavior crosses crate boundaries, run the narrowest useful set of affected
  crate tests first; escalate to workspace gates at PR validation time.
- For dashboard UI changes, use targeted frontend tests/typecheck while
  iterating. Reserve full format/lint/test/typecheck/build and Playwright smoke
  for PR validation unless the change is specifically visual, graph layout,
  prompt/topology editing, or asset-loading behavior.
- Run the embedded asset test after building frontend assets during PR
  validation when touching dashboard serving or `build.rs`.
- If a command cannot be run, state the reason and the remaining risk in the
  final response or review audit.
