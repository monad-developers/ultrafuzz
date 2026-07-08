# StableSwapNG Vyper Smoke Benchmark

Ultrafuzz includes a setup-only smoke benchmark for
`curvefi/stableswap-ng@8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386`, the
MixBytes-audited Curve StableSwapNG revision. The matching re-audit/fix commit
is `bff1522b30819b7b240af17ccfb72b0effbf6c47`.

The ground-truth manifest lives at
`benchmarks/stableswap-ng-vyper/ground-truth.json`. It records selected Critical
and High audit findings, affected Vyper source lines, source audit links, the
audited commit, the fixed commit, and project-local compiler evidence from
`pyproject.toml`, `poetry.lock`, and `ape-config.yaml`.

Run the focused smoke with:

```bash
pnpm -w build
pnpm -w smoke:stableswap-ng-vyper
```

The smoke fetches the pinned target into
`.ultrafuzz/cache/benchmarks/stableswap-ng-vyper`, starts a setup-only Ultrafuzz
workflow through a local Smithers shim, and checks that Vyper handoffs still
cover project discovery, Solidity interfaces for Vyper ABIs, project-local
compiler/dependency evidence, `vm.ffi` deployment helpers, hex-decoded initcode,
ABI-encoded `__init__` arguments, and `vm.etch` only for runtime-code injection.

It does not install or run the historical Vyper toolchain, compile contracts,
launch a fuzz campaign, or reproduce every audit finding. Leave those heavier
checks to target-specific CI or follow-up campaigns.
