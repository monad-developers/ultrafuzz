---
id: nofuzz-severity-classification
display_name: Severity classification
---

# Severity classification

Your job is to turn triaged findings into report-ready severity records. Do not
re-run triage consensus. Preserve each finding's `triage_classification`,
including `incomplete-spec`, `harness-defect`, `repair-candidate`,
`spec-gated`, and `defensive-hardening`.

For each finding, use sub agents with maximum reasoning capacity to inspect the
evidence and assign reportability, severity, likelihood, and impact before
writing the final record. The topology gives this review node an extended
timeout so the sub-agent reviews can finish.

Use these handoffs:

Triaged findings:
{{artifact_path:triage}}/triaged-findings.json

Strategy detection provenance:
{{artifact_path:dedupe-findings}}/strategy-detections.json

Finding lifecycle ledger:
{{artifact_path:triage}}/finding-lifecycle-ledger.json

## Output contract

Write reportable severity records to
{{artifact_path}}/severity-classified-findings.json as JSON. Each kept object
must preserve upstream provenance fields and assign a stable `id`. Use
`schema_version: "1.0"` on every emitted finding object.

For every production report candidate, include these machine-readable fields:

- `severity_guess`: compatibility field for the final classified severity.
  Keep this field; do not replace it with `severity`.
- `final_severity`: final matrix severity, exactly `High`, `Medium`, or `Low`.
- `severity`: compatibility alias for `final_severity`, exactly `High`,
  `Medium`, or `Low`, for the current final-report renderer.
- `impact`: exactly `High`, `Medium`, or `Low`.
- `likelihood`: exactly `High`, `Medium`, or `Low`.
- `confidence`: `High`, `Medium`, or `Low`, based on evidence quality.
- `impact_rationale`, `likelihood_rationale`, and `severity_rationale`: concise
  source-backed explanations.

If the upstream object already had `severity`, `final_severity`,
`severity_guess`, `impact`, or `likelihood`, preserve those original values only
under explicit upstream provenance fields such as `upstream_severity` or
`upstream_severity_guess` when they differ from the final classification. Do
not carry an upstream severity value through as the classified top-level
severity. Include exact machine-readable note tokens
`likelihood=<low|medium|high>` and `impact=<low|medium|high>` in `notes` for
legacy consumers.

Also copy the strategy detection provenance to
{{artifact_path}}/strategy-detections.json without dropping or rewriting hits,
so the final report can compute per-strategy detection rates from loop
provenance.

Also save {{artifact_path}}/finding-lifecycle-ledger.json. Copy the triage
ledger and update every `dedupe_key` record that was severity-classified:

- set `canonical_severity` to the final top-level `severity` for promoted
  production findings;
- set `triage_classification` and preserve `triage_reason`;
- set `final_disposition` to exactly `promoted`, `non-production`, or `dropped`;
- set `demotion_reason` for `non-production` or `dropped` outcomes;
- preserve `source_artifacts`, `strategy_hits`, duplicate ids, family variant
  keys, and all earlier stage records;
- append a `severity-classified` stage pointing to
  {{artifact_path}}/severity-classified-findings.json.

If a prior-run lifecycle comparison is available in the prompt context, set
`comparison_disposition` to exactly `promoted-again`,
`rediscovered-but-demoted`, `not-reproduced`, or `not-searched` by matching
stable `dedupe_key` first, then family ids; do not use title matching.

## Reportability gate

Exclude invalid, out-of-scope, duplicate-only, and unreachable false-positive
records from production report entries. If a record must remain structured for a
non-production appendix, keep its upstream `triage_classification`, use a
canonical `status` such as `needs-review` or `false-positive`, and do not
describe it as a production bug.

Preserve upstream context notes exactly, including
`stateful_failure_classification=<classification>` when present. Use them as
root-cause context, not as permission to promote invalid or blocked records. Do
not promote `blocked-unreproduced` records without replayable evidence. Do not
promote source-comment-only assumptions to production bugs without support from
public docs, README, interfaces, tests, emitted behavior, or other allowed
public sources.

## Public reachability gate for helper-level findings

Before assigning production severity, identify findings whose proof depends on
direct calls to an internal helper, library function, auxiliary wrapper, or
test-only adapter. Production severity requires either a public/external
entrypoint trace or a public caller source chain that reaches the same behavior
under production-like preconditions.

For every helper-level finding that remains in the output, record one of these
exact reachability tokens:

- `reachability=public-entrypoint-trace`
- `reachability=public-caller-source-chain`
- `reachability=helper-only`
- `reachability=public-wrapper-required`

`reachability=public-caller-source-chain` is this topology's substitute for a
generated public wrapper PoC, so it must cite source spans for every link in the
caller chain from the public/external entrypoint down to the helper call site,
and cite the source span showing that caller admitting the offending arguments
or state.

Also include concise `helper_proof=<summary>` and
`public_exploitability=<summary>` notes when they are relevant. Helper-only
failures without public exploitability are harness defects, defensive
hardening, or false positives; they are not production bugs.

## Severity classification

Do not emit `Critical`. Ultrafuzz report classes are exactly High, Medium, and
Low. Severity is the Impact x Likelihood matrix below:

| Impact \ Likelihood | High | Medium | Low |
| --- | --- | --- | --- |
| High | High | High | Medium |
| Medium | Medium | Medium | Low |
| Low | Low | Low | Low |

Apply the matrix mechanically after deciding impact and likelihood:

- High impact + Low likelihood is Medium, not High.
- Medium impact + Low likelihood is Low, not Medium.
- Low impact is always Low.
- If impact and likelihood are available, `final_severity`, `severity`, and
  compatibility `severity_guess` must equal the matrix result.
- If impact or likelihood cannot be supported by evidence, do not guess. Demote
  the finding to a non-production lifecycle outcome such as `incomplete-spec`,
  `spec-gated`, `undetermined`, `defensive-hardening`, or
  `blocked-unreproduced`, and explain the blocker.

Use the impact guidance below as the main decision rule before applying the
matrix:

- High: assets can be stolen, lost, locked, or compromised directly, including
  indirect loss through a concrete valid attack path without hand-wavy
  hypotheticals.
- Medium: assets are not directly at risk, but protocol function,
  availability, accounting, or value can be materially affected under realistic
  stated assumptions or external requirements.
- Low: low-risk, QA, or informational cases, including no direct asset risk,
  dust loss, minor state/spec/comment issues, view-only issues, display or
  event-only impacts without broader protocol consequences, centralization or
  direct admin misuse, and careless user-input or phishing-style assumptions.

Treat all QA, Low, and informational outcomes that remain visible as Ultrafuzz
`low`. Treat Invalid and out-of-scope outcomes as non-reportable, not as Low.

Likelihood still matters inside each impact bucket:

- High likelihood: a normal external actor can trigger the issue reliably from
  realistic public state.
- Medium likelihood: the issue is reachable in plausible production conditions,
  but needs specific state, timing, liquidity, user behavior, a limited role, or
  a competent integration mistake.
- Low likelihood: the issue needs unrealistic assumptions, highly privileged
  mistakes, unlikely coordination, unsupported assets, or future code that is
  not in scope.

Use these caps and invalidation rules:

- Loss of dust amounts is Low. Loss of real fees or matured yield follows the
  normal impact and likelihood assessment. Loss of unmatured yield or yield in
  motion is capped at Medium.
- Reckless admin mistakes and direct misuse of trusted roles are Low at most;
  privilege escalation is judged by impact and likelihood.
- Non-standard ERC20 approve or transfer behavior is out of scope unless the
  token is explicitly supported. Non-standard and non-malicious approve or
  transfer ERC20 behavior is in scope when support is documented.
- Faults rooted entirely in an out-of-scope library are out of scope. Incorrect
  in-scope integration or misuse of that library can be valid.
- Issues requiring careless user input, phishing, or missing transaction
  previews are Low at most.
- Speculation about future code is invalid unless the in-scope root cause and
  realistic future integration path are demonstrated.
- Approve or safeApprove front-run races are not valid vulnerabilities.

## Self-check before writing output

Before saving `severity-classified-findings.json`, check every emitted object:

- `schema_version` is exactly `"1.0"`.
- `final_severity`, `severity`, `impact`, and `likelihood` use only `High`,
  `Medium`, or `Low`.
- No field used as a severity label contains `Critical`.
- `final_severity == matrix(impact, likelihood)`.
- `severity == final_severity`.
- `severity_guess == final_severity`.
- `notes` contains `impact=<low|medium|high>` and
  `likelihood=<low|medium|high>` tokens matching the fields.
- Every kept finding retains provenance, evidence references, lifecycle status,
  triage classification, confidence, and rationale.
- Non-production records keep their lifecycle and triage disposition instead of
  being forced into a Low production finding.

## Examples

High:

```json
{
  "schema_version": "1.0",
  "title": "Public withdrawal path drains vault assets",
  "triage_classification": "true-positive",
  "status": "needs-review",
  "severity": "High",
  "final_severity": "High",
  "severity_guess": "High",
  "impact": "High",
  "likelihood": "High",
  "confidence": "High",
  "impact_rationale": "External withdrawal path directly steals protocol assets.",
  "likelihood_rationale": "The public withdrawal path is reliably reachable from realistic state.",
  "severity_rationale": "Impact High x Likelihood High maps to High.",
  "notes": [
    "likelihood=high",
    "impact=high",
    "classification_reason=external withdrawal path directly steals protocol assets"
  ]
}
```

Medium:

```json
{
  "schema_version": "1.0",
  "title": "Integration-specific accounting drift blocks redemptions",
  "triage_classification": "true-positive",
  "status": "needs-review",
  "severity": "Medium",
  "final_severity": "Medium",
  "severity_guess": "Medium",
  "impact": "High",
  "likelihood": "Low",
  "confidence": "Medium",
  "impact_rationale": "Claimable funds can be locked for affected users.",
  "likelihood_rationale": "The path requires a narrow production state and timing sequence.",
  "severity_rationale": "Impact High x Likelihood Low maps to Medium.",
  "notes": [
    "likelihood=low",
    "impact=high",
    "classification_reason=availability and accounting impact requires specific production state"
  ]
}
```

Low:

```json
{
  "schema_version": "1.0",
  "title": "Rounding dust can be stranded",
  "triage_classification": "defensive-hardening",
  "status": "needs-review",
  "severity": "Low",
  "final_severity": "Low",
  "severity_guess": "Low",
  "impact": "Medium",
  "likelihood": "Low",
  "confidence": "Medium",
  "impact_rationale": "The effect is bounded to limited accounting drift without direct asset theft.",
  "likelihood_rationale": "The path requires a narrow low-probability boundary state.",
  "severity_rationale": "Impact Medium x Likelihood Low maps to Low.",
  "notes": [
    "likelihood=low",
    "impact=medium",
    "classification_reason=low-risk dust impact without meaningful asset loss"
  ]
}
```

Invalid or out of scope:

```json
{
  "title": "Unsupported fee-on-transfer token breaks accounting",
  "triage_classification": "false-positive",
  "status": "false-positive",
  "notes": [
    "classification_reason=out of scope: token behavior is not documented as supported"
  ]
}
```

Do not include invalid or out-of-scope records like the example above in the
production report entries.

Do not run `forge install` or rewrite `foundry.lock` when a pinned dependency
path already exists. Do not include lockfile or dependency-vendor drift in the
reported artifacts.

Save severity-classified findings to
{{artifact_path}}/severity-classified-findings.json as JSON.
Also copy the strategy detection provenance to
{{artifact_path}}/strategy-detections.json without dropping or rewriting hits,
so the final report can compute per-strategy detection rates from loop
provenance.
