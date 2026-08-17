Parent: #527

This issue tracks the exact prioritized integration candidate selected after 2,000 changed lines became a reviewability target rather than a hard security ceiling. The expanded draft contains every actionable High-severity recommendation plus the selected security-to-maintenance-ROI tranche.

## Exact inputs

| Group | Recommendations | Draft PR | Exact head |
| --- | --- | --- | --- |
| Secret-safe artifacts and credentials | R-02, R-05, R-18, R-28 | #622 | `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb` |
| Archive dependency hardening | R-10 | #623 | `372b23045b1ef9d5a676c66652ad7dea48eb116e` |
| Remaining actionable High controls | R-01, R-03, R-04 | #635 | `6c0f71dedb5580c9285d928ddd66056ee868de67` |
| Per-child credential minimization | R-07, R-25 | #639 | `62ad4e58f2691bbf55a038f7ae3e7942eafe2a34` |
| Bounded eval/pricing inputs | R-15, R-16 | #640 | `38ebd41573a9400ba2c0452defbf26c1e662d2d4` |
| Production advisory policy | R-11 | #641 | `bc345d86ef5f4a29e5cd35524387946ec6cec1e0` |

## Exact candidate

- Base: `e0b872e387307128cc6fbf049e7623b031c5ff22`
- Candidate: `950c0c44bfea54f4a7706ff99eb10ccf11127597`
- Tree: `9f7ad9f21ef1493a91e97270b67be87493c32b36`
- All-inclusive footprint: **97 files, +7,746/−953 = 8,699 changed lines**.
- Footprint split: **4,665 production/docs/config; 3,879 tests; 155 schema/lockfile**.

## Acceptance evidence

- **19/19 required release gates passed; 0 failed.**
- Split: 11 package/policy gates, 3 CLI/benchmark/typecheck gates, and 5 runtime gates (supporting plus shards 1–4).
- The exact repaired recovery fixture passed in runtime shard 3; CI policy fixtures passed 82/82 and local Modal package tests passed 562/562.
- Merged release-validation report v2 SHA-256: `1d5e927e0a6d4d3e11caac1a066681425b80fc79e175be7314bb59f067ffec4f`.
- Additional exact-head checks passed: full workspace build, Prettier, ESLint, and `git diff --check`. No remote or paid Modal workload was run.

## ARI v1.1

OpenAI and Anthropic remain separate assessment lanes and are not averaged. Lower is safer.

<!-- FINAL_ARI -->

| Lane | Pinned before | Refreshed-scope pivot | After draft | Controls-only delta |
| --- | --- | --- | --- | --- |
| OpenAI (`gpt-5.6-sol`, xhigh) | 33.8163, Grade D, RM 16.57 / RC 49 | 43.4500, Grade D, RM 26.07 / RC 60 | 18.7667, Grade C, RM 11.26 / RC 60 | **−24.6833** |
| Anthropic (`claude-fable-5` → approved `claude-opus-4-8` fallback, max) | 28.3929, Grade C, RM 7.95 / RC 28 | 39.1724, Grade C, RM 11.36 / RC 29 | 18.8621, Grade C, RM 5.47 / RC 29 | **−20.3103** |

The old → pivot change is refreshed threat scope: OpenAI **+9.6337** and Anthropic **+10.7796**. Pivot → after is the implementation-only comparison shown above. Total pinned-before → after improvement is OpenAI **−15.0497** and Anthropic **−9.5308**. Both after states reach numeric band B, but the accepted High-severity YOLO residual caps each final grade at C.

Verified report SHA-256 values: OpenAI `b4518019e09c4c7fc716d28702fd3d007778ca0eca0c6a56e5bf96d17bcdf82d`; Anthropic `a4ad575edc3686c408ed2f4c349b64dc7a095eb847fd1ba54e84dcc7f633ef51`.

## Scope and publication state

Implemented recommendations are R-01, R-02, R-03, R-04, R-05, R-07, R-10, R-11, R-15, R-16, R-18, R-25, and R-28: High 4/4, Medium 6/12, Low 3/15, Informational 0/7.

The other 25 recommendations remain deferred, and their parent issues remain open. D-01–D-04 remain **Not Applied**. Agent YOLO / bypass-permissions behavior is unchanged: no sandbox, egress or command allowlist, mediated filesystem reads, or in-run approval is introduced.

Aggregate PR #632 remains a draft and closes only this issue if merged. #527 remains open.
