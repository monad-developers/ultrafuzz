---
id: final-report
display_name: Generate report
---

# Generate report

Your job is to produce a concise final audit issue list from the upstream
finding and severity classification outputs.

Use these review handoffs:

Aggregation manifest:
{{artifact_path:aggregate-test-files}}/aggregation.json

`aggregation.json` has `schema_version`, numeric `source_test_files` and
`copied_test_files` counts, optional numeric `source_support_files` and
`copied_support_files` counts, a `files` array of copied `.t.sol` test records,
a `support_files` array for copied helper `.sol` records, and a `skipped_files`
array. `aggregation.json` is a JSON object, not a top-level array. Read copied
test metadata from `.files[]`, where each record has `strategy`, `node_id`,
`attempt_index`, `source_manifest_path`, `source_artifact_path`,
`source_relative_path`, `destination_path`, `destination_relative_path`, and
`bytes`. Use `files` when matching generated or copied test destinations; do
not treat the count fields as arrays, and do not run `.[] | .strategy` over the
whole object because that walks scalar summary fields and will produce false
schema errors.

Severity-classified findings:
{{artifact_path:severity-classification}}/severity-classified-findings.json

Strategy detection provenance:
{{artifact_path:severity-classification}}/strategy-detections.json

Finding lifecycle ledger:
{{artifact_path:severity-classification}}/finding-lifecycle-ledger.json

Dedupe report:
{{artifact_path:dedupe-findings}}/deduped-findings.json

Deduped findings array:
{{artifact_path:dedupe-findings}}/findings.json

Use these setup handoffs:

Project discovery:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Foundry setup:
{{artifact_path:setup-foundry}}/setup/setup-foundry.md

Base test setup:
{{artifact_path:base-test-setup}}/setup/base-test-setup.md

The base test setup handoff is the source of truth for reusable fixture paths.
Read it before writing or minimizing PoCs, and use the exact fixture path it
names, commonly `test/foundry/shared/BaseTest.t.sol` with imports from a
strategy directory such as `../shared/BaseTest.t.sol`. Do not assume legacy
paths such as `test/shared/BaseTest.t.sol` or `test/BaseTest.t.sol` when the
handoff names a different location.

Use these run metadata files for the Run summary section. If a field is absent
or unavailable, write `unavailable` instead of guessing or writing a long
parenthetical explanation:

Run metadata:
{{run_metadata_path}}/run.json

Run state:
{{run_metadata_path}}/state.json

Use the persisted `usage` object in `state.json`, or the embedded `Run
Accounting` runtime context when present, as the source of truth for `Tokens
used` and `Estimated spend`. Do not recompute pricing manually in the report
agent. If the persisted usage object is absent, write `unavailable` for those
fields.

Use `run.json#restart_mode`, `run.json#source_run_id`,
`run.json#reused_nodes`, and `state.json` node statuses for continuation fields
in the Run summary. If there is no source run, write `none` for `Source run ID`
and `fresh` for `Continuation mode`. If there are no reused nodes, write
`0 (none)` for `Reused nodes`.

Use the embedded `Run Summary Context` runtime context when present as the
source of truth for computed summary values such as `Elapsed time`. Do not
recompute those fields from raw timestamps when the context provides a concrete
non-null value.

Run graph:
{{run_metadata_path}}/graph.json

Resolved config:
{{run_metadata_path}}/config.resolved.toml

Read every issue surfaced by the upstream findings and severity classification
path, using `severity-classified-findings.json` as the severity source of truth.
Emit concise production issue entries for production-bug findings. Do not drop
low-confidence, inconclusive, or needs-review production issue results unless the
upstream artifact explicitly removed them. Preserve actionable non-production
classifications (`incomplete-spec`, `harness-defect`, `repair-candidate`,
`spec-gated`, and `defensive-hardening`) in a concise appendix table instead of
mixing them into the production issue list.

For stateful invariant records, preserve every upstream finding whose `notes`
contain `stateful_failure_classification=<classification>`. Coverage-only
success in an earlier strategy report is not a reason to remove these records.
Production-bug records with generated Solidity PoCs belong in the normal issue
list. Preserve stateful `harness-defect` and `incomplete-spec` records through
the non-production actionable outcomes appendix and `report.json`
`non_production_outcomes` when their triage classification is actionable. Do
not force `harness-defect`, `incomplete-spec`, `false-positive`, or
`blocked-unreproduced` records without replayable generated tests into the
PoC-only issue list, and do not fabricate PoCs for them. Stateful
`false-positive` and `blocked-unreproduced` records must remain in structured
`report.json` findings with their upstream status, reproducer or blocked-replay
note, evidence, and classification token even when they do not appear in the
human-readable production issue list.

Sort production issue entries by severity before writing them: High first, then
Medium, then Low. Preserve the upstream order within the same severity.
After sorting, assign issue title IDs independently per severity in rendered
order. Use `H` for High, `M` for Medium, and `L` for Low. Start each severity
counter at `01`, increment only within that severity, and zero-pad IDs to two
digits. Do not copy or reuse upstream issue IDs in the rendered issue title.

The report must start with this fixed title, followed immediately by a Markdown
issue index table with exactly the columns `Issue id` and `Title`. Use the
severity-local rendered issue title ID for `Issue id`. Preserve links to each
issue section in the `Title` cell. After the fixed preamble, render a
`## Run summary` section before issue entries. Render each concrete Run summary
value as Markdown inline code:

# Ultrafuzz report

| Issue id | Title |
| --- | --- |
| H-01 | [[H-01] - <issue title>](#h-01---issue-title-anchor) |
| M-01 | [[M-01] - <next issue title>](#m-01---next-issue-title-anchor) |

Ultrafuzz is an automated Solidity fuzzing campaign assistant. Issues below are machine-generated findings that must be manually validated. This report is not a security review and does not guarantee the protocol is secure.

## Run summary

- Run ID: `<run id>`
- Source run ID: `<source run id, or none>`
- Continuation mode: `<fresh, clean, reuse-completed-artifacts, or unavailable>`
- Reused nodes: `<count and reused node IDs, or 0 (none)>`
- Elapsed time: `<duration rounded to whole hours/minutes, with no seconds or subseconds, e.g. 6h 4m, or unavailable>`
- Models used: `<models from config/state/backend metadata, including reasoning effort such as xhigh when configured, or unavailable>`
- Tokens used: `<token usage, or unavailable>`
- Estimated spend: `<spend estimate, or unavailable>`
- Strategy loops: `<configured loop summary, or unavailable>`

Each issue entry must use exactly this Markdown structure, in this order:

## [<H|M|L>-<two digit severity-local id>] - <concise issue title copied or tightened from upstream>

<Actor or role> can do X/Y/Z which leads to A/B/C/loss of funds. <one concise sentence grounded in upstream evidence>

### Severity

- **Impact**: <Impact>: <concise impact explanation copied or tightened from severity classification notes>
- **Likelihood**: <Likelihood>: <concise likelihood explanation copied or tightened from severity classification notes>

### Public Reachability

- Helper-level proof: <direct helper/library/generated-wrapper proof summary,
  or `not helper-level`>
- Public exploitability: <public entrypoint trace, generated public wrapper PoC,
  public wrapper requirement, or no demonstrated public reachability>

### Proof of Concept

1. <Actor> performs the relevant action.
2. <Actor or another meaningful role> triggers the generated test sequence.
3. <Actor> observes the loss or invariant violation.

```solidity
// Minimized self-contained Foundry reproducer:
// - include all imports, mocks, harnesses, constants, setup, and helpers needed
//   to compile and run the relevant test
// - include only the test function(s) that prove this issue
// - omit unrelated generated tests and local file paths
```

#### Family variants

- <variant title>: <variant summary>

### Strategy

| Strategy | Detection rate |
| --- | --- |
| <strategy id or unknown> | <matching loop attempts / total configured loops as M/N, or unknown> |

If the upstream finding has `family_variants`, keep this as one issue entry for
the shared production root cause and add a `#### Family variants` subheading
inside the Proof of Concept section after the primary Solidity PoC code block.
List variants as concise bullets with each variant title and summary only; do
not include local paths, links, or artifact provenance in family variant
bullets. Omit the subheading entirely when there are no family variants. If the upstream finding has
`related_findings`, list them as related-only bullets in the same Proof of
Concept section; do not promote related-only adjacent surfaces into the issue
title, description, severity, or impact unless upstream triage explicitly proved
the same production root cause.

Description must follow the pattern
`<Actor or role> can do X/Y/Z which leads to A/B/C/loss of funds`, replacing the
placeholder actor, action, and impact with concrete upstream facts when
available. Choose the actor wording from the evidence. Use `Attacker` only when
another party can gain an advantage, grief, steal, or otherwise harm someone
else. Use `User` when the behavior is a self-impacting footgun or the protocol
does not work as intended for the same user who triggers it. Prefer a precise
role such as `Depositor`, `Borrower`, `Liquidator`, `Relayer`, or `Operator`
when that is clearer. Do not use the combined wording `User/Attacker`.
Severity must be copied from the severity classification node's top-level
`severity` field. Do not invent or reclassify severity while writing the
report. `severity` must be one of Low, Medium, or High, case-insensitive. If a
record also contains legacy `severity_guess`, it must match `severity`
case-insensitively; if the two fields disagree, stop and report the invalid
upstream classification artifact instead of choosing one. If top-level
`severity` is missing but `severity_guess` is present, treat that as a legacy
artifact and use `severity_guess`. If neither field is present, stop and report
the invalid upstream classification artifact instead of guessing.

Likelihood and Impact must be copied from the severity classification notes.
They must each be exactly Low, Medium, or High. Do not infer missing values from
severity alone. Render them only inside the single
`### Severity` section as Impact and Likelihood bullets with the level followed
by a short textual explanation; do not add separate Likelihood or Impact
subheaders.

If a severity-classified finding has a `reachability=...`, `helper_proof=...`,
or `public_exploitability=...` note, render the `### Public Reachability`
section immediately after Severity and before Proof of Concept. Use
`helper_proof` for the helper-level proof line and `public_exploitability` for
the public exploitability line. If either summary is absent, say what is absent
without inventing evidence. Omit the section only when no reachability notes are
present.

The Proof of Concept section must include a short numbered human-readable
scenario before or alongside the code. Prefer meaningful actor names such as
`Victim`, `Attacker`, `Borrower`, `Lender`, `Depositor`, or `Liquidator` when
they improve understanding; otherwise use generic names such as `Alice` and
`Bob`. Use the severity finding's explicit generated test path first, then the
aggregation manifest, to locate generated or copied tests. Prefer an aggregation
record that matches the same source artifact path, source relative path,
strategy, and attempt index as the finding. If the aggregation manifest is
missing that exact source test, or if same-path generated tests differ across
attempts and a copied destination would be ambiguous, read the source artifact's
`generated-tests/.../*.t.sol` file instead of the flattened copy. Do not write
local file paths, artifact-relative paths, generated test paths, Markdown links,
or permalink labels in the human-readable report. The report must be
self-sufficient when `report.md` is sent by itself.

For each production issue, include exactly one Solidity code block with an
opening fence exactly equal to ```` ```solidity ```` so Markdown renders syntax
highlighting. The code block must be a minimized self-contained Foundry
reproducer, not a pointer to a file and not an unedited full generated test
suite. Include every import, mock, harness, constant, `setUp`, and helper needed
for the relevant test function(s) to compile and run in the target Foundry
project. Remove unrelated generated test functions, unused helpers, exploratory
assertions, logging-only code, and comments that do not help reproduce the
issue. Keep multiple test functions only when they are all necessary to prove
the same production issue. Stop and report an invalid upstream artifact if no
relevant generated test source, scenario, or self-contained reproducer source is
available for an issue.

Compute the Strategy section from `strategy-detections.json` and the configured
strategy loop counts. For each strategy that found the same deduped bug
instance or same-root family variant, count matching loop attempts for that
strategy and divide by the total configured loops for that strategy. Match
strategy detections by stable `dedupe_key` first. Only fall back to
`finding_id` when the finding has no dedupe key and that finding id is unique in
both the severity-classified findings and strategy detections; never merge
distinct records merely because they reuse a display id such as `RDA-001`. For
family variants, match each variant's own `dedupe_key` before considering
family or finding ids. If strategy or loop provenance is missing, keep the
section and write `unknown` instead of guessing. Render the human-readable
Strategy section as a Markdown table with columns `Strategy` and `Detection
rate`. Detection rates must be exact `M/N` counts without percentages. Keep
loop-attempt provenance in `report.json`, not in the human-readable Strategy
section. Do not call this metric Temperature.

Use `finding-lifecycle-ledger.json` as the source of truth for source
artifacts, lifecycle stage trail, triage reason, demotion reason, final
disposition, and prior-run comparison disposition. Do not promote a production
issue or non-production outcome when its lifecycle record is missing
`source_artifacts`, `strategy_hits`, `triage_classification`,
`triage_reason`, or `final_disposition`; report the upstream artifact as
invalid instead. For promoted production issues, `canonical_severity` must
match the severity-classified finding severity. For demoted or dropped records,
`demotion_reason` is required.

When lifecycle records contain `comparison_disposition`, add a concise
`## Prior finding disposition` section after the production issue entries and
before the non-production appendix. Group entries under exactly these labels
when present: `Promoted again`, `Rediscovered but demoted`, `Not reproduced`,
and `Not searched`. Match records by `dedupe_key` or family ids from the ledger,
not by titles.

For non-production actionable outcomes, append a single
`## Non-production actionable outcomes` table after the production issue entries.
The table should include the classification, title, status, concise evidence
reference, strategy provenance, and recommended next action. Keep this appendix
short and do not include exploit-style PoC sections for these outcomes.

Do not add executive summaries, methodology, environment notes, generated-test
sections, aggregation sections, failed-attempt narratives, reproduction-command
sections, next steps, provenance fields, confidence fields, status fields, or
any other narrative section outside the Run summary, allowed production issue
entries, the conditional Public Reachability section, the prior finding
disposition section, and the non-production actionable outcomes appendix. After
the title, issue index table, fixed
preamble, and Run summary, the human-readable report should be only the concise
production issue entries with their Strategy sections, followed by the optional
prior-disposition section and appendix. If there are no production issues and
no appendix outcomes, skip the issue index table and write `No issues
reported.`

Save the human-readable report to {{artifact_path}}/report.md.

Also save {{artifact_path}}/report.json as structured JSON for the CLI. Include
`schema_version`, a `run_metadata` object matching the Run summary fields, a
production `issues` array, and a `non_production_outcomes` array. Each
production issue object must contain
`title`, `description`, `severity`, `likelihood`, `impact`, and
`proof_of_concept`, plus `family_id`, `family_variants`, `related_findings`,
and a structured `strategy` object carrying strategy names, detection rates,
and loop-attempt provenance for downstream analysis when those fields are
available. The production issue `title` value must include the same
severity-local title ID rendered in the Markdown heading, for example
`[H-01] - Selectorless fallback can refund or spend stale contract ETH`. Each
non-production outcome object must preserve machine-readable
`triage_classification`, `status`, evidence, strategy provenance, and
`recommended_next_action`. Both production issues and non-production outcomes
must include a `lifecycle` object copied from the matching ledger record with
`dedupe_key`, `source_artifacts`, `strategy_hits`, `triage_classification`,
`triage_reason`, `demotion_reason`, `final_disposition`, and
`comparison_disposition` when those fields are present.
