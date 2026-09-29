# Contributing

This repository is a TypeScript workspace for Ultrafuzz.

Report security vulnerabilities privately as described in the
[Security Policy](../SECURITY.md). Use GitHub issues for ordinary bugs and
feature requests, and pull requests for proposed changes. Contributors should
follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository Map

Workspace packages live under `packages/`:

- `@ultrafuzz/config`: `ultrafuzz.toml` loading, defaults, overrides,
  validation, and redaction.
- `@ultrafuzz/security`: shared path, ID, materialization, and cleanup policy
  helpers.
- `@ultrafuzz/prompts`: project prompt catalog discovery, frontmatter
  validation, template validation/rendering, and prompt scaffolding.
- `@ultrafuzz/topology`: `.ultrafuzz/topology.yml` loading, validation, loop
  expansion, group defaults, reference nodes, graph serialization, and
  fingerprints.
- `@ultrafuzz/references`: pinned reference catalog validation, local cache
  status, sync/update support, and reference artifact materialization.
- `@ultrafuzz/artifacts`: run layout, events, findings, manifests, generated
  test manifests, and run state.
- `@ultrafuzz/runtime`: project validation, planning, workflow compilation,
  lifecycle delegation, synchronization, materialization, cleanup, and report
  lookup.
- `@ultrafuzz/cli`: the command surface.

Bundled editable product assets live under `.ultrafuzz/` in this repository.
Initialized target projects receive project-owned copies of the same product
surfaces.

## Development Stance

Prefer typed domain structures and parser-backed validation over ad hoc string
handling. Parse and validate data at boundaries: config, topology YAML, prompt
frontmatter, references, artifact manifests, findings, materialization
selections, cleanup selections, and CLI JSON output.

Do not add runtime fallbacks that synthesize missing product state. `ultrafuzz
init` may scaffold topology and prompts, but validation, run, dashboard, and
report paths should fail clearly when required product state is missing or
invalid.

JSON Schema is the canonical document-shape contract for JSON handoffs. Do not
add version aliases, coercion, normalization, repair, or historical readers for
agent-owned JSON. Once an agent returns, its declared artifact bytes must remain
unchanged through host validation, synchronization, reporting, dashboards, and
bundling. Put cross-file, filesystem, Git, or projected-key checks in named
semantic/context gates instead of a competing shape parser.

Keep generated artifacts out of git, including:

```text
node_modules/
dist/
dist-test/
.codex-runs/
.ultrafuzz/runs/
.ultrafuzz/workspaces/
.ultrafuzz/cache/
```

## Checks

Useful workspace checks:

```bash
pnpm -w format:check
pnpm -w lint
pnpm -w docs:check
pnpm -w typecheck
pnpm -r test
```

Prefer narrow package checks while iterating, then run broader gates before PR
handoff when a change touches shared behavior or release workflows.

## Complexity and Size Budgets

`pnpm -w lint` applies complexity and size budgets to all code under
`packages/` and `scripts/`: cyclomatic complexity 20, nesting depth 4, 500 lines
per file, 80 lines and 40 statements per function, 5 parameters, and 4 nested
callbacks. Tests and workflow templates allow complexity 25, 1000 lines per
file, 150 lines and 80 statements per function, and 6 parameters.

Violations that predate the budgets are counted per file and rule in
`eslint-suppressions.json`, ESLint's bulk-suppressions file:

- A change that adds a violation to a file fails lint, because that file's
  count for the rule rises above the recorded count. Fix the new violation.
- A change that removes violations also fails lint, with "There are
  suppressions left that do not occur anymore". Run `pnpm -w lint:prune` and
  commit the smaller `eslint-suppressions.json`.
- Moving code that already exceeds a budget, including renaming its file,
  needs its count moved to the new path in `eslint-suppressions.json`.

Counts are per file and rule, so a function that already exceeds a budget can
grow without failing lint. `pnpm -w lint:strict:ci` adds the type-aware strict
rules, `no-console`, and the TODO/FIXME check for changed lines only.
