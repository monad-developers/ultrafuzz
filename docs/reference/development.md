# Development Commands

Ultrafuzz Beta is a TypeScript workspace managed with `pnpm`.

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
```

Package-local `typecheck` and `test` scripts may build direct workspace
dependencies first because package exports point at `dist/**`.

## Docs Check

```bash
pnpm -w docs:check
```

The docs check verifies that required documentation entrypoints exist. It does
not build a static site.

## Generated Output

Build output lives under package `dist/` directories and is not a product
surface. User-owned Ultrafuzz state remains root `ultrafuzz.toml` and
`.ultrafuzz/**`.
