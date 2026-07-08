# StableSwapNG Vyper Setup Smoke

This benchmark pins Curve StableSwapNG at the MixBytes-audited commit
`8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386` and records the re-audit/fix commit
`bff1522b30819b7b240af17ccfb72b0effbf6c47`.

The target was selected because it is a real audited Vyper project with public
ground-truth findings: 3 Critical, 5 High, 12 Medium, and 21 Low. The
ground-truth manifest in `ground-truth.json` keeps the audit links, selected
finding IDs, affected source locations, audited commit, fixed commit, and
project-local Vyper tooling evidence together.

## Smoke Scope

The CI smoke intentionally stays setup-only:

- fetches `curvefi/stableswap-ng` at the audited commit into an ignored
  `.ultrafuzz/cache/benchmarks/stableswap-ng-vyper` cache;
- scans the pinned checkout for `.vy` production contracts and project-local
  compiler/dependency evidence from `pyproject.toml`, `poetry.lock`, and
  `ape-config.yaml`;
- starts Ultrafuzz against a setup-only topology through a local Smithers shim so
  setup prompts are rendered and workflow handoff evidence is created without a
  long agent run or fuzz campaign;
- writes deterministic setup handoff evidence into the ignored smoke run
  directory;
- fails if the rendered setup path stops carrying Vyper discovery, Solidity
  interface, `vm.ffi`, hex-decoded initcode, constructor argument, or
  `vm.etch` runtime-code guidance.

The smoke does not install Poetry, Vyper, Ape, titanoboa, or Foundry
dependencies, and it does not try to reproduce every MixBytes finding. Historical
tooling is treated as project-local evidence for setup handoff purposes.

## Commands

The focused local command is:

```bash
pnpm -w build
pnpm -w smoke:stableswap-ng-vyper
```

Suggested PR validation commands for this benchmark are:

```bash
git diff --check
pnpm -w format:check
pnpm --filter @ultrafuzz/prompts test
pnpm -w smoke:stableswap-ng-vyper
pnpm -w docs:check
```

## Updating

To update the fixture, choose a full 40-character audited commit, update
`ground-truth.json`, and keep each selected finding tied to public audit source
links plus audited-line evidence. Do not replace the primary target with a
setup-only historical Vyper repository unless a public audit finding is mapped
to that exact revision.
