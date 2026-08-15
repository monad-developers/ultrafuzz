# Development Commands

Ultrafuzz is a TypeScript workspace managed with `pnpm`.

The supported host runtime is Node.js `22.19` or newer. This satisfies the
pinned pnpm 11 toolchain, the pinned Smithers release's Node 22 declaration, and
the exact Kimi Code 0.29.1 CLI used by the adapter contract tests. Smithers'
executable and those contract tests run with Bun 1.3+. The Modal image uses
Node.js 22.23.

Workflow execution is supported on Linux with procfs mounted at `/proc`.
Sealed workflow controls are opened through directory descriptors, and the
Smithers child receives the held generation as
`/proc/<controller-pid>/fd/<descriptor>`. A self-process `/dev/fd` alias does
not provide that cross-process execution path. Windows and macOS execution are
not currently supported by this hardened boundary.

## Workspace Checks

```bash
pnpm -w format:check
pnpm -w lint
pnpm -w typecheck
pnpm -w build
pnpm -w test
pnpm -w validate:release
pnpm -w docs:check
```

The root CI script runs format check, lint, build, and release validation:

```bash
pnpm -w run ci
```

Pull requests run formatting, lint, and the workspace build while they are
drafts. Marking a pull request ready for review adds benchmark-history and full
release validation. Feature branches are validated only by the pull-request
event, avoiding a duplicate push run; pushes to `main` run the full lane.
Release validation uses seven isolated CI lanes with a maximum of seven jobs in
parallel: package and CLI/typecheck lanes, one runtime-supporting lane, and four
deterministic runtime integration shards. It then records their results in
stable gate order in the JSON report.

## Package Checks

Focused package iteration uses pnpm filters:

```bash
pnpm --filter @ultrafuzz/config test
pnpm --filter @ultrafuzz/topology test
pnpm --filter @ultrafuzz/prompts test
pnpm --filter @ultrafuzz/references test
pnpm --filter @ultrafuzz/artifacts test
pnpm --filter @ultrafuzz/runtime test
pnpm --filter @ultrafuzz/cli test
pnpm --filter @ultrafuzz/modal test
```

Package-local `typecheck` and `test` scripts may build direct workspace
dependencies first because package exports point at `dist/**`.

## Docs Check

```bash
pnpm -w docs:check
```

The docs check verifies that required documentation entrypoints exist. It does
not build a static site.

## Modal Integration Checks

Modal unit and contract tests are deterministic and local:

```bash
pnpm --filter @ultrafuzz/modal test
pnpm --filter @ultrafuzz/modal typecheck
pnpm --filter @ultrafuzz/modal build
```

These tests also validate the exact three-target automatic smoke and four-provider full
EVMBench configuration, the fixed Sol judge, four-hour-ten-minute smoke and one-hour full row budgets,
immutable image naming, hash-manifested public bundles, and the Modal-only benchmark
workflow. They make no cloud or model calls.

The real-cloud smoke is deliberately separate from every normal test and CI
script. It must be selected explicitly, once per provider:

```bash
pnpm --filter @ultrafuzz/modal smoke -- --provider openai
pnpm --filter @ultrafuzz/modal smoke -- --provider anthropic
pnpm --filter @ultrafuzz/modal smoke -- --provider deepseek
pnpm --filter @ultrafuzz/modal smoke -- --provider kimi
```

Do not add the smoke to `test`, gate it on an environment variable, or replace
its generic fixture with real project material. A passing run exercises the
published production image, provider-isolated subscription auth, non-root
execution, writable durable storage, mid-run termination, same-volume resume,
completed-work reuse, and single launch ownership. Output is restricted to
aggregate checks; cloud IDs, credentials, provider output, prompts, findings,
source contents, and artifacts are not test output.

## Generated Output

Build output lives under package `dist/` directories and is not a product
surface. User-owned Ultrafuzz state remains root `ultrafuzz.toml` and
`.ultrafuzz/**`.
