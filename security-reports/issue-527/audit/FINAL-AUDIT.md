# Issue #527 final publication audit

Audited at `2026-08-16T13:34:30Z`: **PASS**.

## Publication state

- Umbrella issue [#527](https://github.com/monad-developers/ultrafuzz/issues/527) remains open. Its single final implementation report is [comment 5307678134](https://github.com/monad-developers/ultrafuzz/issues/527#issuecomment-5307678134); the hidden marker occurs exactly once.
- Remote `main` remains unchanged at `e0b872e387307128cc6fbf049e7623b031c5ff22`.
- All nine PRs are open drafts against `main`; none was merged or marked ready. Each has exactly one comment whose complete body is `@aviggiano please review`.
- Grouped mappings and exact heads are:
  - #630 closes #612 — `aeaf0292653777df82f37fa9d476397c49051cc4`
  - #629 closes #613 — `5aee31e7c40ec20f01bb1f5d734c543c8f866d9b`
  - #622 closes #614 — `8efb875194121d4882e12832fe575f608ab05a38`
  - #624 closes #615 — `ee10fa82b5285fd107d922040766a64026d0b157`
  - #623 closes #616 — `fe23ef9a3298187c99a051619f7f2365440171cb`
  - #625 closes #617 — `0738125263cf9758c928c2424741c288f2842ae1`
  - #627 closes #618 — `118e013c01a2a72ca14f90719865f43175526c73`
  - #620 closes #619 — `9c123b5c2ca0f3aec4f6e0e6b51dc1d14613618f`
- Every grouped body contains only its assigned closing reference plus `Part of #527`. #630/#627 retain their documented main-reconciliation conflicts; the reconciled aggregate passes. #625's genuine Modal material-fingerprint defect was corrected on its owning branch and its grouped CI, Socket, and Semgrep checks pass.
- #625 has exactly one refreshed Socket disposition, [comment 5307307719](https://github.com/monad-developers/ultrafuzz/pull/625#issuecomment-5307307719), matching the prepared local body.

## Aggregate and validation

- [Draft PR #632](https://github.com/monad-developers/ultrafuzz/pull/632) is the sole PR for `security/527-aggregate-candidate`. It contains only `Closes #628` and `Part of #527`; it does not close #527.
- Exact aggregate commit: `506c16ce9720adbf11a702e91a31738b75807e76`.
- Exact aggregate tree: `e7dd35813a22913d7ba4e4007cad83b18c12da4d`.
- All eight grouped heads are ancestors of the aggregate.
- Aggregate draft/build, release-gates, both Socket checks, and Semgrep succeeded. Draft-only `release-validation` is skipped as designed.
- The exact local release report passes all 19 required gates with zero failures. SHA-256: `52ff2deaf7eeb62f94d11fbc81908afdf5f3787fc0cb8ed60d6e32f46c3d8adb`.

## Verified ARI v1.1

- OpenAI (`gpt-5.6-sol`, `xhigh`, no degradation): before `33.8163` (D), pivot `43.7500` (D), after `16.5833` (C), `Delta_controls = -27.1667`. Report SHA-256: `9afc923c996c79b37f11664ad9aabbe25a054d5cbca26e5f0603f894cd5d399d`.
- Anthropic (direct approved `claude-opus-4-8`, `max`, explicit fallback, Opus-only usage): before `28.3929` (C), pivot `35.3947` (C), after `14.8947` (C), `Delta_controls = -20.5000`. Report SHA-256: `80fe48015c9a100ec822dfa70279c10cdbfadbda371e18da60f368554302d161`.
- Both reports passed canonical schema/provenance verification and independent recomputation of risk mass, risk capacity, ARI, scope delta, control delta, and total delta.
- D-01 through D-04 remain deliberately Not Applied and accepted: agents still run in YOLO/bypass-permissions mode without OS/container isolation, egress restrictions, command allowlists or in-run approvals, or mediated filesystem reads. This invariant was not described as remediated.

No live or publication-ready PR body contains an unresolved placeholder. There is one final #527 report, one #625 Socket disposition, and no duplicate aggregate PR. Nothing closes #527.
