# Issue #527 AppSec remediation archive

This directory is the durable evidence bundle for [ultrafuzz issue #527](https://github.com/monad-developers/ultrafuzz/issues/527). The archive commit is based on the exact selected aggregate commit `950c0c44bfea54f4a7706ff99eb10ccf11127597` (tree `9f7ad9f21ef1493a91e97270b67be87493c32b36`) so the evidence and the assessed source share one immutable history. The audit baseline is `a634d948038f502e5e677477138dca0c763e2380`. Files are evidence only; this branch is not an additional implementation PR.

## Decision and implementation status

- Implemented in the selected candidate: R-01, R-02, R-03, R-04, R-05, R-07, R-10, R-11, R-15, R-16, R-18, R-25, and R-28.
- Coverage: High 4/4, Medium 6/12, Low 3/15, Informational 0/7.
- Next best candidate: R-08. Consider R-06 only if dashboard exposure broadens. Keep R-09, R-12, R-13, R-14, and the remaining lower-priority backlog deferred unless their security-to-maintenance ROI changes.
- The 2,000 changed-line figure is a reviewability target, not a security acceptance ceiling. The exact selected aggregate is 8,699 changed lines and passed all 19 required local release gates.
- Non-negotiable invariant: agents continue to run in YOLO/bypass-permissions mode. No OS/container isolation, egress restriction, command allowlist/in-run approval, or mediated filesystem access is claimed.

## Open draft delivery

| Draft PR | Scope | Exact head |
|---|---|---|
| [#622](https://github.com/monad-developers/ultrafuzz/pull/622) | R-02, R-05, R-18, R-28 | `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb` |
| [#623](https://github.com/monad-developers/ultrafuzz/pull/623) | R-10 | `372b23045b1ef9d5a676c66652ad7dea48eb116e` |
| [#635](https://github.com/monad-developers/ultrafuzz/pull/635) | R-01, R-03, R-04 | `6c0f71dedb5580c9285d928ddd66056ee868de67` |
| [#639](https://github.com/monad-developers/ultrafuzz/pull/639) | R-07, R-25 | `62ad4e58f2691bbf55a038f7ae3e7942eafe2a34` |
| [#640](https://github.com/monad-developers/ultrafuzz/pull/640) | R-15, R-16 | `38ebd41573a9400ba2c0452defbf26c1e662d2d4` |
| [#641](https://github.com/monad-developers/ultrafuzz/pull/641) | R-11 | `bc345d86ef5f4a29e5cd35524387946ec6cec1e0` |
| [#632](https://github.com/monad-developers/ultrafuzz/pull/632) | Exact aggregate of all scopes above | `950c0c44bfea54f4a7706ff99eb10ccf11127597` |

All seven were open drafts, unmerged, merge-clean, green, and had exactly one `@aviggiano please review` comment when this archive was prepared on 2026-08-17. PRs #639 and #641 are intentionally stacked on #635 and #623 respectively; #632 is the single exact integration view.

## ARI results

| Independent lane | Before | Refreshed pivot | After | Control delta | Canonical report SHA-256 |
|---|---:|---:|---:|---:|---|
| OpenAI `gpt-5.6-sol` xhigh | 33.8163 D | 43.4500 D | 18.7667 C | -24.6833 | `b4518019e09c4c7fc716d28702fd3d007778ca0eca0c6a56e5bf96d17bcdf82d` |
| Anthropic `claude-opus-4-8` max | 28.3929 C | 39.1724 C | 18.8621 C | -20.3103 | `a4ad575edc3686c408ed2f4c349b64dc7a095eb847fd1ba54e84dcc7f633ef51` |

Negative control delta is safer. Both after states reach numeric band B, but the accepted High-severity YOLO residual caps the reported grade at C. `ari/.../anthropic-refresh-v1.json` is intentionally retained as rejected negative evidence; its control arrays failed the canonical independence/arithmetic requirements. Anthropic v2 is the accepted canonical result.

## Evidence layout

- `publication/`: issue/PR prose plus the self-contained implementation questionnaire, human one-pager, recommendation matrix, and issue-by-issue LOC/status/PR table.
- `baseline-reports/`: all 16 independent source AppSec reports (eight methods across two assessor lanes).
- `analysis/`: the normalized finding set and recommendation-to-issue grouping.
- `ari/`: canonical reports, raw/event provenance, prompts, metadata, schemas, verifier code, and the rejected Anthropic v1 evidence.
- `validation/950c0c44-merged.json`: exact aggregate release report; status `pass`, 19/19 required gates, SHA-256 `1d5e927e0a6d4d3e11caac1a066681425b80fc79e175be7314bb59f067ffec4f`.
- `audit/FINAL-AUDIT.md`: historical publication audit retained for provenance. It describes the earlier candidate at the time it was written and is superseded where the final expanded report differs.
- `MANIFEST.sha256`: content hash for every archived evidence file except the manifest itself.

The source report pack was at `b4f992a23e1f9a33f7c5fa2d4a5c6817c7c7a06a`; the questionnaire lane, including its final provenance correction, is independently preserved at `monad-exp/ultrafuzz-sec-skills@2d3105f709fbe5155f5bc81e95006addece75e5a` on `archive/security-527-questionnaire`; ARI v1.1 was at `847f5e300d1977be9a437ead50826ddd5930a01d`. Local-only Ultrafuzz historical tips are preserved under `archive/security-527/*`. The conflicted `aggregate-final` worktree was not altered: its exact four-file working state is preserved in the explicitly non-mergeable recovery commit `3d867290c3495b7f262f28dae7ab50ec2f536579` on `archive/security-527/unresolved-aggregate-snapshot`. The original unmerged-stage blobs are:

- `packages/runtime/src/materialize.ts`: base `51d1ecd36c5fe48f758e85bc14442e0758c1c729`, ours `911995726cc7514fb781585df8785175f241d2ee`, theirs `d5d7f08bf6340bd75dc96710fb92b6f1ab25ecac`.
- `packages/runtime/test/materialize.test.ts`: base `592fd184a791350d21efcc79630a489356562622`, ours `3d0207b22ea4f9ece481c07b03fb1254d1cf0265`, theirs `e591a32ab237b251bfa2e74b9302fae9d0938ef0`.
