Parent: #527

## Scope

- **R-01:** Do not grant controller execution authority to target-supplied `.smithers` code.
- **R-03:** Enforce operator-owned credential-name and provider-home policy.
- **R-04:** Add campaign sensitivity classification and provider/cloud disclosure acknowledgement.

This High-priority tranche partially addresses #612 and #613. Those issues remain open for R-07/R-08/R-25 and R-09/R-26 respectively.

## Acceptance criteria

- Target-owned executable `.smithers` content cannot become the controller source; generated controller code is authenticated before execution.
- Repository configuration cannot silently choose arbitrary host credential names or provider-home paths.
- Campaigns default to private sensitivity; operator-owned disclosure acknowledgement names destinations and becomes stale when its bound policy/input digest changes.
- Focused regressions, full workspace/release validation, and local Modal coverage pass on the exact head.
- The footprint is reported transparently. 2,000 changed lines is a reviewability target, not a hard acceptance gate; completing every actionable High takes precedence.

## Non-goal

Agent YOLO / bypass-permissions behavior is unchanged. No sandbox, command/egress allowlist, mediated filesystem reads, or in-run approval is introduced. D-01–D-04 remain Not Applied.

Post-remediation ARI will be measured only on an exact composed candidate; this issue claims no standalone score change.
