---
id: severity-classification
display_name: Severity classification
---

# Severity classification

Your job is to turn triaged findings into report-ready severity records. Do not
re-run triage consensus. Preserve each finding's `triage_classification`,
including `incomplete-spec`, `harness-defect`, `repair-candidate`,
`spec-gated`, and `defensive-hardening`.

For each finding, use sub agents with maximum reasoning capacity to inspect the
evidence and assign reportability, severity, likelihood, and impact before
writing the final record.

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
must preserve upstream provenance fields and assign a stable `id`.
Set top-level `severity` to the final classified severity, exactly `low`,
`medium`, or `high`. Also set `severity_guess` to the same value for
compatibility with earlier finding schemas. Do not carry an upstream
`severity` field through as the top-level classified severity; if the upstream
object already had a severity, preserve it only as `upstream_severity` or
inside explicit upstream provenance. Include exact machine-readable note tokens
`likelihood=<low|medium|high>` and `impact=<low|medium|high>`.

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

Preserve stateful invariant context notes exactly, including
`stateful_failure_classification=<classification>`. Use them as root-cause
context, not as permission to promote invalid or blocked records. Do not
promote `blocked-unreproduced` records without replayable evidence. Do not
promote source-comment-only assumptions to production bugs without support from
public docs, README, interfaces, tests, emitted behavior, or other allowed
public sources.

## Public reachability gate for helper-level findings

Before assigning production severity, identify findings whose proof depends on
direct calls to an internal helper, library function, generated wrapper, or
test-only adapter. Production severity requires either a public/external
entrypoint trace or a generated public wrapper PoC that reaches the same
behavior under production-like preconditions.

For every helper-level finding that remains in the output, record one of these
exact reachability tokens:

- `reachability=public-entrypoint-trace`
- `reachability=generated-public-wrapper-poc`
- `reachability=helper-only`
- `reachability=public-wrapper-required`

Also include concise `helper_proof=<summary>` and
`public_exploitability=<summary>` notes when they are relevant. Helper-only
failures without public exploitability are harness defects, defensive
hardening, or false positives; they are not production bugs.

## Severity classification

Severity is `Likelihood x Impact`, but we use the impact guidance below as the
main decision rule:

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

## Examples

High:

```json
{
  "title": "Public withdrawal path drains vault assets",
  "triage_classification": "true-positive",
  "status": "needs-review",
  "severity": "high",
  "severity_guess": "high",
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
  "title": "Integration-specific accounting drift blocks redemptions",
  "triage_classification": "true-positive",
  "status": "needs-review",
  "severity": "medium",
  "severity_guess": "medium",
  "notes": [
    "likelihood=medium",
    "impact=medium",
    "classification_reason=availability and accounting impact requires specific production state"
  ]
}
```

Low:

```json
{
  "title": "Rounding dust can be stranded",
  "triage_classification": "defensive-hardening",
  "status": "needs-review",
  "severity": "low",
  "severity_guess": "low",
  "notes": [
    "likelihood=medium",
    "impact=low",
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

Make sure compilation is passing but do not fix any failing tests. If Foundry
dependencies are missing, restore project-pinned dependencies first, such as
`git submodule update --init --recursive lib/forge-std` when `.gitmodules`
contains that path. Do not run `forge install` or rewrite `foundry.lock` when a
pinned dependency path already exists. Dependency hydration used only to run
verification is not a target workspace change; do not include lockfile or
dependency-vendor drift in the reported artifacts.

Save severity-classified findings to
{{artifact_path}}/severity-classified-findings.json as JSON.
Also copy the strategy detection provenance to
{{artifact_path}}/strategy-detections.json without dropping or rewriting hits,
so the final report can compute per-strategy detection rates from loop
provenance.
