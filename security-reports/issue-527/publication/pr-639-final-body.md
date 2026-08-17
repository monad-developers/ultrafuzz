## Summary

- scope built-in and configured provider credentials to the generated child that actually uses them
- reconstruct the same boundary on lifecycle and resume paths
- replace wildcard controller-variable forwarding with a documented allowlist
- keep fake-runner test controls file-backed and immutable across the filtered child boundary
- document the accepted same-UID HOME/subscription trust boundary for local YOLO execution

## Exact stacked scope

- Base (#635): `6c0f71dedb5580c9285d928ddd66056ee868de67`
- Head: `62ad4e58f2691bbf55a038f7ae3e7942eafe2a34`
- Incremental footprint: **7 files, +389/−85 = 474 changed lines**

## Validation

- GitHub draft/build and release gates, Socket, and Semgrep passed on exact head `62ad4e58`
- Modal prerequisite and runtime test compilation passed
- targeted credential/environment cluster: **11 passed, 0 failed**, including simultaneous API-key providers and the repaired recovery fixture
- full runtime shard 3/4: **51 passed, 176 deterministically shard-skipped, 0 failed**
- wildcard `SMITHERS_*` forwarding remains removed; the fixture repair embeds only test-owned paths and does not weaken production filtering or executable attestation

Agent YOLO / bypass-permissions behavior is unchanged. This adds no sandbox, command or egress allowlist, approval prompt, or mediated filesystem access.

Closes #636
Addresses R-07/R-25 in #612
Part of #527
