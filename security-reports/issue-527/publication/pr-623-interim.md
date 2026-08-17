Addresses R-10 in #616.

Related to #527. Issue #616 remains open because R-11, R-20, R-34, R-35, and R-38 are deferred.

## Prioritized scope

This draft implements only:

- **R-10:** upgrade the vulnerable ZIP parser while retaining and testing malicious-archive limits.

Exact reviewed head: `372b23045b1ef9d5a676c66652ad7dea48eb116e`.

## What changed

- Upgrades `adm-zip` from `^0.5.18` to `^0.6.0`.
- Reads each benchmark ZIP through a regular-file snapshot before parsing, rejecting symlinks, concurrent replacement, and compressed input above 256 MiB.
- Retains entry-count, selected-entry expansion, nested-archive, and uncompressed-size ceilings.
- Rejects duplicate, aliased, non-canonical, absolute, traversal, control-character, backslash, and colon-bearing member names before extraction.
- Adds regressions for CVE-2026-39244 forged allocation, truncated and oversized input, duplicate or aliased central-directory names, and selected-entry expansion budgets.

No dependency-policy, Git-transport, provenance-monitoring, pinning-policy, or EVMBench interpolation changes are included in this reduced PR.

## Validation

- Malicious-archive regressions and the full CLI/release lanes passed on the exact aggregate containing this head.
- Frozen install passed; the production audit reported zero known advisories.
- The exact aggregate passed a frozen install, production dependency audit, full workspace build, and affected package lanes. The remaining sharded exact-head release lanes are in progress; their merged report and SHA-256 will replace this sentence when complete.
- Corrected-head GitHub CI and security-scanner results are recorded in the review response after completion.

## Aggregate assurance

This head is included in prioritized aggregate `8c6a7985df4cc38404a577a0977f85e9f3e629a2` (tree `356c46c0f5afad4b052e5ff33a7150a44f2fc333`), based on `e0b872e387307128cc6fbf049e7623b031c5ff22`.

The aggregate's all-inclusive delta is **25 files, +1,831/−167 = 1,998 changed lines**, including dependency manifest and lockfile changes. ARI is assessed only on that aggregate candidate; this grouped PR makes no standalone ARI claim.

## YOLO invariant

Agent YOLO / bypass-permissions execution is unchanged. This PR adds no agent command or network allowlist. D-01–D-04 remain **Not Applied**.

This PR must remain a draft. #527 remains open.
