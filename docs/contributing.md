# Contributing

This repository is a TypeScript workspace for Ultrafuzz Beta.

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
- `@ultrafuzz/cli`: the beta command surface.

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
