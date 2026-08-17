Closes #628

Related to #527.

## Purpose

This draft publishes the exact prioritized candidate requested in review: two remediation groups, five recommendations, and no more than 2,000 all-inclusive changed lines.

## Exact composition

| Group | Recommendations | Draft PR | Tracking issue | Exact head |
| --- | --- | --- | --- | --- |
| Secret-safe artifacts and credentials | R-02, R-05, R-18, R-28 | #622 | #614 | `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb` |
| Archive dependency hardening | R-10 | #623 | #616 | `372b23045b1ef9d5a676c66652ad7dea48eb116e` |

- Integration base: `e0b872e387307128cc6fbf049e7623b031c5ff22`
- Exact candidate: `8c6a7985df4cc38404a577a0977f85e9f3e629a2`
- Exact tree: `356c46c0f5afad4b052e5ff33a7150a44f2fc333`
- Exact all-inclusive footprint: **25 files, +1,831/−167 = 1,998 changed lines**
- Dependency manifest and lockfile changes are included in that total.

## Recommendation disposition

Implemented: **R-02, R-05, R-10, R-18, and R-28**.

The other 33 recommendations are deferred:

`R-01, R-03–R-04, R-06–R-09, R-11–R-17, R-19–R-27, R-29–R-38`.

Deferred child issues remain open. R-10 addresses only part of #616, so #616 also remains open.

## Exact-candidate validation

- Frozen install: **passed**.
- Production dependency audit: **passed; zero known advisories reported**.
- Full workspace build: **passed**.
- Local Modal suite: **561/561 passed**. No remote Modal workload dispatch is claimed.
- Release matrix: **exact-head sharded rerun in progress; no current-lane failure observed**.
- Release report SHA-256: **pending merged exact-head report**.
- Independent secret-safety review, exact-tree and ancestry checks, formatting, lint, Prettier, diff, and YOLO-sensitive-path audits passed.

## ARI v1.1

The model-family lanes are reported separately and are never averaged.

| Lane | Pinned before | Refreshed-scope pivot | After | Control delta |
| --- | --- | --- | --- | --- |
| OpenAI (`gpt-5.6-sol`, xhigh) | 33.8163, Grade D, RM 16.57 / RC 49 | Exact-head refresh in progress | Exact-head refresh in progress | Pending verification |
| Anthropic (`claude-fable-5` → approved `claude-opus-4-8` fallback, max) | 28.3929, Grade C, RM 7.95 / RC 28 | Exact-head refresh in progress | Exact-head refresh in progress | Pending verification |

Pinned inputs: baseline `a634d948038f502e5e677477138dca0c763e2380`; threat-model skill `d4846045a1e4079676e5ea539af7db8bfa8c3c9e`; ARI v1.1 `847f5e300d1977be9a437ead50826ddd5930a01d`.

Verified ARI report SHA-256 values will be added after both exact-head lane outputs pass deterministic verification.

## YOLO invariant

Agent YOLO / bypass-permissions execution is unchanged. The candidate does not add a product sandbox, command or egress allowlist, mediated filesystem reads, or in-run approval prompts.

D-01–D-04 remain **Not Applied**:

- **D-01:** no OS/container containment for agents.
- **D-02:** no agent-egress restriction.
- **D-03:** no agent command allowlist or in-run approval.
- **D-04:** no mediated agent filesystem reads.

## Draft-only status

This PR must remain a draft. It is not authorization to merge or release. It closes only #628 if merged and intentionally leaves #527 open.
