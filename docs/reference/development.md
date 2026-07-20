# Development Commands

Ultrafuzz is a TypeScript workspace managed with `pnpm`.

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
pnpm -w ci
```

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

These tests also validate the exact three-target automatic smoke and two-model full
EVMBench configuration, the fixed Sol judge, one-hour row budget, immutable
image naming, hash-manifested public bundles, and the Modal-only benchmark
workflow. They make no cloud or model calls.

The real-cloud smoke is deliberately separate from every normal test and CI
script. It must be selected explicitly, once per provider:

```bash
pnpm --filter @ultrafuzz/modal smoke -- --provider openai
pnpm --filter @ultrafuzz/modal smoke -- --provider anthropic
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
