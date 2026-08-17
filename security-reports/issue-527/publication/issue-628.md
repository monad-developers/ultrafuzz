Parent: #527

This issue tracks the exact prioritized integration candidate selected after review reduced the remediation from eight groups to two groups and required an all-inclusive footprint no greater than 2,000 changed lines.

## Prioritized inputs

| Group | Recommendations | Draft PR | Exact head |
| --- | --- | --- | --- |
| Secret-safe artifacts and credentials | R-02, R-05, R-18, R-28 | #622 | `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb` |
| Archive dependency hardening | R-10 | #623 | `372b23045b1ef9d5a676c66652ad7dea48eb116e` |

## Exact candidate

- Base: `e0b872e387307128cc6fbf049e7623b031c5ff22`
- Candidate: `8c6a7985df4cc38404a577a0977f85e9f3e629a2`
- Tree: `356c46c0f5afad4b052e5ff33a7150a44f2fc333`
- All-inclusive footprint: **25 files, +1,831/−167 = 1,998 changed lines**, including dependency manifest and lockfile changes.

## Acceptance evidence

- Frozen install, production audit, full workspace build, local Modal coverage, affected tests, formatting, lint, diff, ancestry, exact-tree, and YOLO-sensitive-path audits passed against the exact candidate.
- Release matrix: **17/17 required gates passed, zero failures**.
- Release report SHA-256: `dbb3644f9310fb3a92f199b9180f62fcf773117eb10e6dc7e01ca6e86edc8a4b`.
- ARI was refreshed against this exact candidate and reported separately:
  - OpenAI (`gpt-5.6-sol`, xhigh): pinned 33.8163/D (RM 16.57 / RC 49); refreshed pivot 44.5238/D (RM 28.05 / RC 63); final 35.1905/D (RM 22.17 / RC 63); scope delta +10.7075; controls delta −9.3333; total delta +1.3741 (higher risk after scope expansion).
  - Anthropic (approved `claude-opus-4-8` fallback, max): pinned 28.3929/C (RM 7.95 / RC 28); refreshed pivot 31.0938/C (RM 9.95 / RC 32); final 22.1563/C (RM 7.09 / RC 32); scope delta +2.7009; controls delta −8.9375; total delta −6.2366 (safer).
- Aggregate PR #632 remains a draft and closes only this issue if merged.
- #527 remains open.

## Deferred scope

Implemented recommendations are limited to R-02, R-05, R-10, R-18, and R-28. The other 33 recommendations remain deferred, and their child issues remain open.

D-01–D-04 remain **Not Applied**. Agent YOLO / bypass-permissions behavior is unchanged: no sandbox, egress or command allowlist, mediated filesystem reads, or in-run approval is introduced.
