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

Write severity records to
{{output_stage_findings_path}} using the exact pinned
`{{schema_path}}/severity-classified-findings.schema.json`; it alone defines
the JSON version, fields, types, enums, required members, and empty forms. The
output holds exactly one object per
triaged finding, in the same order, with the same `id`. Never drop, add, merge,
split, or reorder a record: exclusion from the production report happens later,
through the lifecycle `final_disposition`, not by deleting a record here.

You own exactly six fields on each record and may write nothing else:
`severity`, `impact`, `likelihood`, `impact_rationale`, `likelihood_rationale`,
and `severity_rationale`. Copy every other field of the triaged record
byte-for-byte, including `id`, `title`, `status`, `confidence`, `notes`,
`severity_guess`, `summary`,
`triage_classification`, evidence, provenance, and each property-derived
finding's `property_ids`. Do not touch `status`, `notes`, or `confidence`; they
belong to triage, and any difference from the triaged record fails the upstream
preservation check.

For every production report candidate, preserve the upstream preliminary
severity estimate and lowercase confidence unchanged. Decide impact and
likelihood from evidence, derive the one final severity mechanically from the
matrix below, and add concise source-backed impact, likelihood, and severity
rationales. Never emit a final-severity alias or re-rate confidence.

If the upstream object already had an unauthorized final `severity`, reject the
upstream handoff instead of copying it into aliases. Preserve `severity_guess`
unchanged, decide `impact` and `likelihood`, and write only the canonical final
`severity` plus the three rationale fields. Do not emit `final_severity`,
`upstream_severity`, note-token aliases, or compatibility fields.

Also copy the strategy detection provenance to
{{artifact_path}}/strategy-detections.json using the exact pinned
`{{schema_path}}/strategy-detections.schema.json`, without dropping or
rewriting hits, so the final report can compute per-strategy detection rates
from loop provenance.

Copy the complete strategy-detections array exactly, including entry order and
every optional field; do not regenerate it from findings or the ledger.

Also save {{artifact_path}}/finding-lifecycle-ledger.json using the exact
pinned `{{schema_path}}/finding-lifecycle-ledger.schema.json`. Copy the triage
ledger and update every `dedupe_key` record that was severity-classified:

- set `canonical_severity` to the final top-level `severity` for promoted
  production findings;
- set `triage_classification` and preserve `triage_reason`;
- set `final_disposition` to exactly `promoted`, `non-production`, or `dropped`;
- set `demotion_reason` for `non-production` or `dropped` outcomes;
- preserve `source_artifacts`, `strategy_hits`, duplicate ids, family variant
  keys, and all earlier stage records;
- append a `severity-classified` stage whose `artifact_path` is the portable
  declared output-relative path `{{output_stage_findings_relative_path}}`.

Preserve the triage ledger record order and every upstream field and stage
exactly. Add only `canonical_severity`, `final_disposition`, optional
`comparison_disposition`, and one final `severity-classified` stage whose
artifact path and finding ID exactly identify the current severity output.
`true-positive` records are `promoted` and copy their top-level `severity` into
`canonical_severity`; `false-positive` records are `dropped`; every other
classification is `non-production`. Non-promoted records omit
`canonical_severity`.

If a prior-run lifecycle comparison is available in the prompt context, set
`comparison_disposition` to exactly `promoted-again`,
`rediscovered-but-demoted`, `not-reproduced`, or `not-searched` by matching
stable `dedupe_key` first, then family ids; do not use title matching.

## Reportability gate

Invalid, out-of-scope, duplicate-only, and unreachable false-positive records
stay in `severity-classified-findings.json` like every other triaged record.
Keep them out of the production report entries through their lifecycle record
instead: give the matching `dedupe_key` a `final_disposition` of `dropped` or
`non-production` with a `demotion_reason`. Copy their upstream
`triage_classification` and `status` unchanged, and do not describe them as
production bugs.

Preserve stateful invariant context notes exactly, including the typed
stateful-failure classification entry from the authoritative note-key list. Use them as root-cause
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

For every helper-level finding, record one authoritative reachability token in
`severity_rationale`, which you own:

{{finding_reachability_vocabulary}}

Use the authoritative report-bound keys below for concise helper proof and
public exploitability clauses in the same rationale when they are relevant:

{{finding_note_key_vocabulary}}

Never append these tokens to `notes`: triage owns `notes`, and you must copy the
upstream array unchanged, including any reachability tokens triage already
recorded there. Helper-only failures without public exploitability are harness
defects, defensive hardening, or false positives; they are not production bugs.

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
- If impact and likelihood are available, `severity` must equal the matrix
  result. `severity_guess` remains the preliminary upstream estimate.
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

Before saving `severity-classified-findings.json`, check the array as a whole:

- It has exactly one object per triaged finding, in the same order, and each
  `id` equals the `id` at the same index in `triaged-findings.json`.
- Only `severity`, `impact`, `likelihood`, `impact_rationale`,
  `likelihood_rationale`, and `severity_rationale` differ from the triaged
  record. Every other field, `status`, `notes`, and `confidence` included, is
  byte-for-byte identical.

Then check every emitted object:

- `severity`, `impact`, and `likelihood` use only `High`, `Medium`, or `Low`.
- No field used as a severity label contains `Critical`.
- Severity must equal the matrix result for impact and likelihood.
- `severity_guess` is preserved even when the final matrix differs.
- `confidence` is the preserved upstream lowercase `high`, `medium`, or `low`.
- Neither `final_severity` nor a compatibility/upstream severity alias exists.
- Every finding retains provenance, evidence references, lifecycle status,
  triage classification, confidence, and rationale.
- Non-production records keep their lifecycle and triage disposition instead of
  being forced into a Low production finding.

## Examples

Copy every unowned value verbatim from the triaged record in each case. A
public withdrawal that reliably drains assets is High impact and High
likelihood, hence High severity. Accounting drift that can lock claimable funds
only in a narrow state is High impact and Low likelihood, hence Medium. Rounding
dust reached only at a low-probability boundary is at most Medium impact and
Low likelihood, hence Low. An unsupported fee-on-transfer-token claim is a
false positive when support is not documented.

Keep invalid or out-of-scope records in
`severity-classified-findings.json` with their triaged fields intact, and mark
them `dropped` in the lifecycle ledger. Their `final_disposition` is what keeps
them out of the production report entries.

Make sure compilation is passing but do not fix any failing tests. If Foundry
dependencies are missing, restore project-pinned dependencies first, such as
`git submodule update --init --recursive lib/forge-std` when `.gitmodules`
contains that path. Do not run `forge install` or rewrite `foundry.lock` when a
pinned dependency path already exists. Dependency hydration used only to run
verification is not a target workspace change; do not include lockfile or
dependency-vendor drift in the reported artifacts.

Save severity-classified findings to
{{output_stage_findings_path}} as JSON.
Also copy the strategy detection provenance to
{{artifact_path}}/strategy-detections.json without dropping or rewriting hits,
so the final report can compute per-strategy detection rates from loop
provenance.

After all three final writes, run every exact `ultrafuzz json validate` command
rendered for them in the central output contract. Correct any exit-1 artifact
yourself and rerun its command after any later edit.
