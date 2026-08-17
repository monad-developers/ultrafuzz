<!-- ultrafuzz-527-final-implementation-report -->

## Prioritized AppSec remediation and ARI refresh

Following the review on #632, the candidate was reduced from eight remediation groups to two groups and an all-inclusive footprint below 2,000 changed lines. This in-place report supersedes the earlier eight-group result.

## Implemented recommendations

| Group | Recommendations | Draft PR | Tracking issue | Exact head |
| --- | --- | --- | --- | --- |
| Secret-safe artifacts and credentials | R-02, R-05, R-18, R-28 | #622 | #614 | `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb` |
| Archive dependency hardening | R-10 | #623 | #616 | `372b23045b1ef9d5a676c66652ad7dea48eb116e` |

PR #622 retains `Closes #614`. PR #623 now states `Addresses R-10 in #616`, so #616 remains open for its five deferred recommendations.

## Exact aggregate

- Aggregate draft PR: #632
- Base: `e0b872e387307128cc6fbf049e7623b031c5ff22`
- Candidate: `8c6a7985df4cc38404a577a0977f85e9f3e629a2`
- Tree: `356c46c0f5afad4b052e5ff33a7150a44f2fc333`
- All-inclusive footprint: **25 files, +1,831/−167 = 1,998 changed lines**
- Dependency manifest and lockfile changes are included in that total.

## Deferred recommendations

The other 33 recommendations are deferred:

`R-01, R-03–R-04, R-06–R-09, R-11–R-17, R-19–R-27, R-29–R-38`.

The deferred grouped PRs #620, #624, #625, #627, #629, and #630 were closed without deleting their branches. Their child issues remain open. No PR was merged.

## Exact-candidate validation

- Frozen install: **passed**.
- Production dependency audit: **passed; zero known advisories reported**.
- Full workspace build: **passed**.
- Local Modal suite: **561/561 passed**; no remote Modal workload dispatch is claimed.
- Release matrix: **17/17 required gates passed, zero failures**.
- Independent secret-safety review, affected package tests, exact-tree and ancestry checks, formatting, lint, Prettier, diff, and YOLO-sensitive-path audits passed.
- Release report SHA-256: `dbb3644f9310fb3a92f199b9180f62fcf773117eb10e6dc7e01ca6e86edc8a4b`.

## ARI v1.1

OpenAI and Anthropic are separate assessment lanes and are not averaged.

| Lane | Pinned before | Refreshed-scope pivot | After | Control delta |
| --- | --- | --- | --- | --- |
| OpenAI (`gpt-5.6-sol`, xhigh) | 33.8163, Grade D, RM 16.57 / RC 49 | 44.5238, Grade D, RM 28.05 / RC 63 | 35.1905, Grade D, RM 22.17 / RC 63 | −9.3333 (safer) |
| Anthropic (`claude-fable-5` → approved `claude-opus-4-8` fallback, max) | 28.3929, Grade C, RM 7.95 / RC 28 | 31.0938, Grade C, RM 9.95 / RC 32 | 22.1563, Grade C, RM 7.09 / RC 32 | −8.9375 (safer) |

The old → pivot change reflects refreshed threat scope; pivot → after is the controls-only comparison. Scope deltas: OpenAI **+10.7075**; Anthropic **+2.7009**. Total pinned-before → after deltas: OpenAI **+1.3741 (higher risk after scope expansion)**; Anthropic **−6.2366 (safer)**. Negative control deltas are safer. Severity gates cap OpenAI at D and Anthropic at C; Anthropic's final numeric band is B.

Pinned assessment inputs: baseline `a634d948038f502e5e677477138dca0c763e2380`; threat-model skill `d4846045a1e4079676e5ea539af7db8bfa8c3c9e`; ARI v1.1 `847f5e300d1977be9a437ead50826ddd5930a01d`; assessed candidate `8c6a7985df4cc38404a577a0977f85e9f3e629a2`.

Verified ARI report SHA-256 values: OpenAI `df8357e1a6a9f5e05fe3173d8f59776fd281efd0cd5e272b11a3fbf1e689937c`; Anthropic `570433a5164c939c3b05965a043796813ac9b553f410bead20f82e00788d7891`.

## Not Applied: required YOLO residuals

D-01–D-04 remain **Not Applied**:

- **D-01:** agents remain outside OS/container containment.
- **D-02:** agent network egress remains unrestricted.
- **D-03:** agent commands remain unrestricted and uninterrupted by in-run approvals.
- **D-04:** agent filesystem reads remain direct rather than mediated.

Agent YOLO / bypass-permissions behavior is unchanged.

## Publication state

PRs #622, #623, and #632 remain drafts. Each affected PR retains its single pre-existing review-request comment; no additional review-request comment was posted. Aggregate PR #632 closes only #628 if merged. #527 remains open.

**#527 remains open.**
