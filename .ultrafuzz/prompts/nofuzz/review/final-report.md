---
id: nofuzz-final-report
display_name: Generate report
---

# Generate report

Your job is to produce a concise final audit issue list from the upstream
finding, triage, severity classification, lifecycle, and strategy detection
outputs.

A bounded benchmark topology may intentionally omit triage, severity,
or harness handoffs. When no rendered path is provided,
do not treat the omitted handoff as an error. When the severity-classification
handoff is absent, perform one source-backed bounded classification pass over
each deduplicated finding and enrich its matching dedupe lifecycle record in
memory before selecting report entries:

- choose exactly one `triage_classification` from `true-positive`,
  `false-positive`, `undetermined`, `incomplete-spec`, `harness-defect`,
  `repair-candidate`, `spec-gated`, or `defensive-hardening`;
- set a concise source-backed `triage_reason` on every record;
- set `final_disposition` to `promoted` only for a `true-positive` that passes
  every reportability and evidence gate in this prompt, to `dropped` for a
  `false-positive`, and to `non-production` for every other actionable class;
- set a concise `demotion_reason` for every `non-production` or `dropped`
  record, and set `canonical_severity` after applying the matrix to every
  promoted record; and
- append a `bounded-final-review` lifecycle stage pointing to the generated
  `report.json`, while preserving all dedupe source artifacts and strategy
  hits.

If evidence is insufficient for `true-positive`, use `undetermined`; never
guess missing validation. Treat these enriched records as the lifecycle source
of truth and copy them into the matching report objects. Render unavailable
provenance fields as `unavailable`, and emit a schema-valid report even when the
resulting issue list is empty.

## Required Inputs

Read these review handoffs before writing the report:

Severity-classified findings:
`{{artifact_path:severity-classification}}/severity-classified-findings.json`

The beta severity artifact may be either a top-level findings array or an object
with a `findings` array. Treat `severity-classified-findings.json#/findings` as
the source of truth when that field exists. Use the top-level array form only
for legacy-compatible artifacts.

Strategy detection provenance:
`{{artifact_path:severity-classification}}/strategy-detections.json`

Finding lifecycle ledger:
`{{artifact_path:severity-classification}}/finding-lifecycle-ledger.json`

When the severity-classification handoff is absent in a bounded topology, use
these exact dedupe-stage fallbacks instead:

Dedupe strategy detection provenance:
`{{artifact_path:dedupe-findings}}/strategy-detections.json`

Dedupe finding lifecycle ledger:
`{{artifact_path:dedupe-findings}}/finding-lifecycle-ledger.json`

Dedupe report:
`{{artifact_path:dedupe-findings}}/deduped-findings.json`

This topology renders no property catalog and no implemented-property handoff,
so no provenance join from a finding's `property_ids` to canonical properties
exists. Exactly one behaviour therefore applies to every run under this
topology, whether or not any finding carries `property_ids`: emit the empty
array (`[]`) for `report.json.property_provenance`, render the Property
provenance body as `No property-derived findings.` in `report.md`, and
continue report generation.

Use these setup handoffs:

Project discovery:
`{{artifact_path:project-discovery}}/setup/project-discovery.md`

Foundry setup (when rendered):
`{{artifact_path:setup-foundry}}/setup/setup-foundry.md`

Base test setup:
`{{artifact_path:base-test-setup}}/setup/base-test-setup.md`

Use exactly the rendered filenames above when reading prior-node outputs. When
you mention an input internally or in `report.json` provenance, preserve the
exact source filename where useful, for example
`{{artifact_path:severity-classification}}/severity-classified-findings.json`,
`{{artifact_path:severity-classification}}/strategy-detections.json`,
`{{artifact_path:severity-classification}}/finding-lifecycle-ledger.json`, and
`{{artifact_path:dedupe-findings}}/deduped-findings.json`. Do not invent legacy
filenames such as `dedupe-findings/findings.json` when the exact rendered
filename differs.

The base test setup handoff is the source of truth for reusable fixture paths.
Read it before writing or minimizing PoCs, and use the exact fixture path it
names. Do not assume legacy paths when the handoff names a different location.

Use these run metadata files for the Run summary section. `{{run_metadata_path}}`
is the rendered path to `run.json`; `state.json`, `graph.json`, and
`config.resolved.toml` are sibling files in the same run directory. If a
public-facing field is absent or unavailable, write `unavailable` instead of
guessing or writing a long parenthetical explanation:

Run metadata:
`{{run_metadata_path}}`

Run state:
`state.json` next to `{{run_metadata_path}}`

Run graph:
`graph.json` next to `{{run_metadata_path}}`

Resolved config:
`config.resolved.toml` next to `{{run_metadata_path}}`

Repository URL:
Run `git remote get-url origin` from the repository workspace. For GitHub
remotes, normalize HTTPS and SSH forms to
`https://github.com/<owner>/<repository>` and remove a trailing `.git`. If the
origin is missing or is not a GitHub repository, write `unavailable`.

Use any embedded runtime contexts for Run Summary, Run Accounting, Run Health,
and Finding Lifecycle Ledger when present in this prompt as the source of truth
for computed summary/accounting/lineage fields. If those contexts are absent,
fall back to the persisted metadata files listed above. Do not recompute pricing
manually. If pricing is partial, preserve the plus suffix. If accounting is
unavailable, write `unavailable` for token usage and estimated spend.

Accounting contract:

- Read `accounting.cumulative.tokens_used` from run metadata and render it as
  `Tokens used`.
- Read `accounting.cumulative.estimated_spend` from run metadata and render it
  as `Estimated spend`.
- Preserve any trailing `+` on `estimated_spend`; it means pricing is partial.
- If either accounting value is missing, write `unavailable` for that field.
- In `report.json`, include `run_metadata.tokens_used`,
  `run_metadata.estimated_spend`, `run_metadata.partial_pricing`, and
  `run_metadata.source_run_ids` with the same values used in `report.md` when
  those values are present in run metadata.
- In `report.json`, include `run_metadata.repository` with the same normalized
  URL rendered as `Repository` in `report.md`.
- Copy the effective audit policy from `{{run_metadata_path}}` into
  `report.json.run_metadata`: `audit_profile`,
  `audit_profile_catalog_digest`, `topology_digest`, `prompt_digest`, and
  `expanded_graph_fingerprint`. Use the effective profile name and the exact
  digests/fingerprint recorded by the runtime; do not reconstruct them from
  paths.

Use `run.json#source_run_id` for `Source run ID`. If there is no source run,
write `none` for `Source run ID`.

The Run summary contains exactly these public fields when available: `Run ID`,
`Source run ID`, `Repository`, `Elapsed time`, `Models used`, `Tokens used`,
`Estimated spend`, `Strategy loops`, `Audit profile`, `Audit profile catalog
digest`, `Topology digest`, `Prompt digest`, and `Expanded graph fingerprint`.
Render each concrete value as Markdown inline code.

## Finding Selection

Read every issue surfaced by the upstream findings and severity classification
path. Do not drop low-confidence, inconclusive, or needs-review production issue
results unless the upstream artifact explicitly removed them.

Preserve actionable non-production classifications such as `incomplete-spec`,
`harness-defect`, `repair-candidate`, `spec-gated`, and
`defensive-hardening` in a concise appendix table instead of mixing them into
the production issue list.

For stateful analysis records, preserve every upstream finding whose `notes`
contain `stateful_failure_classification=<classification>`. Production-bug
records with source-backed evidence belong in the normal issue
list. Preserve
stateful `harness-defect` and `incomplete-spec` records through the
non-production actionable outcomes appendix and `report.json`
`non_production_outcomes` when their triage classification is actionable.

Use `finding-lifecycle-ledger.json` as the source of truth for source artifacts,
strategy hits, lifecycle stages, triage reason, demotion reason, final
disposition, and prior-run comparison disposition. Do not promote a production
issue or non-production outcome when its matching lifecycle record is missing
required lifecycle metadata. Include a `lifecycle` object copied from the
matching ledger record in each `report.json` production issue and
non-production outcome.

## Global Report Rules

Apply these rules to the whole generated `report.md` and `report.json`, not
only to the examples below.

The report severity, impact, and likelihood vocabularies are closed: High,
Medium, and Low. Never render or preserve another severity, impact, or
likelihood label anywhere in `report.md` or `report.json`, including headings,
issue IDs, index rows, summary buckets, provenance fields, alternate severity
fields, or copied lifecycle data. When an upstream artifact uses a value outside
the closed vocabulary, normalize it into the closest allowed value using the
upstream classification rationale before rendering. If the upstream artifact
lacks enough rationale to choose one of High, Medium, or Low, stop and report
the invalid upstream classification artifact instead of guessing.

Independently reassess every production issue's impact and likelihood from its
evidence before finalizing the report. Treat upstream severity fields and
rationales as inputs, not immutable results. When reassessment changes them,
render the revised impact, likelihood, matrix severity, and concise rationale
consistently in both report formats.

Use these risk boundaries before applying the matrix:

- High impact requires direct asset loss or compromise through a concrete valid
  path. High likelihood means any participant can trigger it reliably, or it
  can occur naturally under realistic conditions.
- Medium impact means assets are not directly at risk, but protocol function,
  availability, accounting, or value is materially affected under realistic
  stated assumptions or external requirements.
- Low covers no direct asset risk, minor state or specification defects,
  view-only, display-only, or event-only effects without broader consequences,
  and issues the protocol can safely continue operating without fixing.
- The evidentiary burden increases with severity; unsupported or hand-wavy
  assumptions cannot establish High or Medium.

Apply this trusted-role boundary explicitly:

- Reckless mistakes by a trusted administrator are non-production outcomes.
- Direct misuse of a trusted role, and code defects reachable only after an
  administrator makes a mistake, are Low.
- A privileged function used under reasonable, intended assumptions can be
  Medium only when it exposes a genuine protocol bug. Because a trusted role is
  required, assign Low likelihood, so even High impact maps to Medium.
- Privilege escalation is assessed normally from its impact and likelihood.
- High severity requires a path that does not depend solely on an already
  trusted role choosing, supplying, or executing the harmful action.

Apply this Impact x Likelihood matrix before publishing any production issue:

| Impact \ Likelihood | High | Medium | Low |
| --- | --- | --- | --- |
| High | High | High | Medium |
| Medium | Medium | Medium | Low |
| Low | Low | Low | Low |

For every production issue, recompute severity from the reassessed impact and
likelihood. Publish that matrix result even when it corrects an upstream
severity, and explain the corrected assessment from evidence. If the evidence
cannot support impact or likelihood, stop and report the invalid upstream
classification artifact instead of guessing. In particular:

- High impact + Low likelihood must render as Medium.
- Medium impact + Low likelihood must render as Low.

Never render `Critical`.

Reachability is not a standalone report section anywhere. Include concrete
public/helper callability evidence only inside the Likelihood and Impact
reasoning when it changes the assessment.

Use concrete actor or system-role language throughout issue-related prose,
including issue descriptions, Severity explanations, PoC steps, family variant
summaries, non-production outcome summaries, and recommended next actions.
Choose actor wording from the evidence and reuse it consistently. Use `Attacker`
only when another party can gain an advantage, grief, steal, or otherwise harm
someone else. Use `User` when the behavior is self-impacting or the protocol
does not work as intended for the same user who triggers it. Prefer precise
roles such as `Depositor`, `Borrower`, `Liquidator`, `Relayer`, or `Operator`
when clearer. Do not combine multiple roles with slash notation. Do not leave
placeholder tokens, anonymous variable labels, or copied boilerplate in the
final report.

## Required Markdown Shape

Sort production issue entries by report severity before writing them: High
first, then Medium, then Low. The report severity vocabulary is exactly High,
Medium, and Low. Normalize upstream values according to the global closed
vocabulary rule before rendering `report.md` or `report.json`. Do not render
any other report severity or issue-id class. Preserve the upstream order within
the same report severity.

After sorting, assign issue title IDs independently per severity in rendered
order. Use `H` for High, `M` for Medium, and `L` for Low. Start each severity
counter at `01`, increment only within that severity, and zero-pad IDs to two
digits. Do not copy or reuse upstream finding IDs in rendered issue titles.

The report must start with this fixed title, followed immediately by a Markdown
issue index table when production issues exist:

```md
# Ultrafuzz report

| Issue id | Title |
| --- | --- |
| H-01 | [[H-01] - <issue title>](#h-01---issue-title-anchor) |
| H-02 | [[H-02] - <next high issue title>](#h-02---next-high-issue-title-anchor) |
| M-01 | [[M-01] - <medium issue title>](#m-01---medium-issue-title-anchor) |
| L-01 | [[L-01] - <low issue title>](#l-01---low-issue-title-anchor) |

The report contains <total issue count> issues, with severity distribution <high count> high, <medium count> medium, and <low count> low.

Ultrafuzz is an automated smart-contract fuzzing campaign assistant. Issues below are machine-generated findings that must be manually validated. This report is not a security review and does not guarantee the protocol is secure.

## Run summary

- Run ID: `<run id>`
- Source run ID: `<source run id, or none>`
- Repository: `<normalized GitHub repository URL, or unavailable>`
- Elapsed time: `<duration rounded to whole hours/minutes, for example 6h 4m, or unavailable>`
- Models used: `<models from config/state/backend metadata, including reasoning effort when configured, or unavailable>`
- Tokens used: `<token usage, or unavailable>`
- Estimated spend: `<cost estimate such as $123 or $123+ when pricing is partial, or unavailable>`
- Strategy loops: `<configured loop summary, or unavailable>`
```

Each production issue entry must use exactly this Markdown section order. The
following example is structural only; replace the title, actor names, actions,
outcomes, explanations, code, variants, and strategy IDs with issue-specific
content from the upstream evidence:

````md
## [H-01] - Depositor withdrawal accounting can lock claimable funds

Depositor can withdraw after accounting state diverges which leads to claimable funds remaining locked. The cited source evidence shows the stale share balance persists after the withdrawal path completes.

### Severity

- **Impact**: High: Locked claimable funds prevent affected depositors from recovering principal.
- **Likelihood**: Medium: The withdrawal path is reachable through the public redeem flow after the recorded state transition.

### Proof of Concept

1. Depositor prepares a position that records shares against the vault state, tracked by the share accounting in `Vault.deposit`.
2. Depositor performs the public redeem action after the accounting state diverges, reaching the stale-balance branch in `Vault.redeem`.
3. Depositor observes claimable funds remain locked after the redeem action completes, because the recorded share total is never reconciled.

#### Family variants

- Alternate withdrawal route: The same accounting mismatch appears through a second redeem helper.

### Strategy

| Strategy | Detection rate |
| --- | --- |
| stateful-invariant | 2/8 |
````

The first issue paragraph and every Proof of Concept step must use concrete
actor or role language, following the global actor-role rule.

The first sentence under each issue heading must be a grammatical concrete
sentence in this exact shape:
`Depositor can withdraw after accounting state diverges which leads to claimable
funds remaining locked.`
It must not duplicate prose awkwardly, for example avoid constructions like
`Fallback caller can exercise selectorless fallback which leads to Registered
fallback callers could...`. Tighten copied upstream text into a clean actor,
action, and outcome.

Severity must be recomputed from the final report's reassessed impact and
likelihood. Upstream `final_severity`, `severity`, and legacy `severity_guess`
are review inputs only. Normalize the recomputed result to High, Medium, or Low
and use it consistently for issue IDs, ordering, counts, Markdown, and JSON.

Impact and Likelihood must each render as exactly High, Medium, or Low followed
by a colon and concise explanation, for example
`- **Impact**: High: ...` and `- **Likelihood**: Medium: ...`. Use severity
classification fields or notes when available. Include helper/public
reachability evidence in the Likelihood explanation when relevant. Do not add a
separate reachability section anywhere in the report; reachability belongs in
the Likelihood and Impact reasoning.

## Proof of Concept Rules

The Proof of Concept section must include a short numbered human-readable
scenario before or alongside the code. Prefer meaningful actor names such as
`Victim`, `Attacker`, `Borrower`, `Lender`, `Depositor`, or `Liquidator` when
they improve understanding; otherwise use generic names such as `Alice` and
`Bob`.

Use the finding's recorded source evidence to locate the exact production code
that the scenario exercises. Prefer evidence that names the contract or library,
the function or workflow, and the source location the upstream artifact cited.
Do not substitute a similarly named function, a neighboring entrypoint, or a
different code path for the one the evidence actually cites.

For each production issue, express the Proof of Concept as an ordered
source-backed scenario in prose: name the actor, the state the actor
establishes, the public or external call sequence, and the observable divergence
from the cited property. Quote or paraphrase the specific production statements,
conditions, and arithmetic that produce the divergence, and name the contract,
function, and source location for each step.

Describe the preconditions, actor balances, configuration values, and state
transitions the scenario depends on, so a reviewer can follow the argument
against the source without a prepared harness. Omit unrelated behavior,
exploratory reasoning, and observations that do not advance the argument. Stop
and report an invalid upstream artifact if no cited source evidence or
followable scenario is available for a production issue.

Do not write local file paths, artifact-relative paths, generated test paths,
Markdown links, or permalink labels in the human-readable issue body. The
report must be self-sufficient when `report.md` is sent by itself.

If the upstream finding has `family_variants`, keep one issue entry for the
shared production root cause and add a `#### Family variants` subheading inside
the Proof of Concept section after the primary source-backed scenario. List
variants as concise bullets with each variant title and summary
only. Omit the subheading when there are no family variants.

## Strategy Section

Compute the Strategy section from `strategy-detections.json`, the lifecycle
ledger, and configured strategy loop counts. For each strategy that found the
same deduped bug instance or same-root family variant, count matching loop
attempts for that strategy and divide by the total configured loops for that
strategy. Match strategy detections by stable `dedupe_key` first. Only fall back
to `finding_id` when the finding has no dedupe key and that finding id is unique
in both the severity-classified findings and strategy detections.

Render the human-readable Strategy section as a Markdown table with columns
`Strategy` and `Detection rate`. Detection rates must be exact `M/N` counts
without percentages. Keep loop-attempt provenance in `report.json`, not in the
human-readable Strategy section. Do not call this metric Temperature.

## Additional Sections

Add `## Property implementation coverage` after the production issue entries
and before `## Property provenance`. This topology renders no property catalog
at all and declares no property-implementation handoff, so nothing can supply a
`selection` object. This run therefore has no implementation-coverage lineage:
render the literal `unavailable` under that heading in `report.md`, and emit the
string `unavailable` for `report.json.property_implementation_coverage`. Do not
synthesize a coverage object from the findings, the lifecycle ledger, or the
source tree.

Only a topology that renders an implemented-property handoff supplying a
`selection` object and property records lets the report carry a coverage object
at all. When such a handoff is rendered, emit `property_implementation_coverage` with
this exact shape:

```json
{
  "priority_threshold": "medium",
  "priorities": ["high", "medium"],
  "selected_property_ids": ["property-1", "property-2"],
  "implemented_property_ids": ["property-1"],
  "blocked_property_ids": [],
  "pending_property_ids": [],
  "deferred_property_ids": ["property-2"],
  "reference_expected_property_ids": ["property-1"],
  "reference_expectation_ids": ["scfuzzbench:example:expectation-1"],
  "blocker_summaries": [
    "property-2: The handler cannot observe the premium delta returned by the Hub."
  ]
}
```

Use the canonical catalog order for every ID array. Keep the arrays as the
machine-readable source of truth; counts in Markdown must match them exactly.
When the canonical catalog contains `reference_expectations`, include every
corresponding canonical property ID in `reference_expected_property_ids` and
every distinct expectation identifier in `reference_expectation_ids`, in
catalog order. Preserve these arrays even when the property priority is below
the configured threshold.
Include `blocker_summaries` for selected records whose status is `blocked`,
`pending`, or `deferred`. Every element is a plain string, never an object:
write each one as `<property-id>: <the record's blocker summary text>`, in
canonical catalog order. Copy that summary text verbatim from the handoff
record's `blocker.summary` — do not shorten, rephrase, re-punctuate, or
re-case it. The typed blocker's other fields stay in the handoff record; do not
copy the blocker object into the report.
If selection metadata is unavailable, use the string `"unavailable"` in
`report.json` and write `unavailable` in Markdown.

The Markdown body of `## Property implementation coverage` is compared line by
line against the JSON above, so write exactly these bullets, in this order, with
these labels and backticks, and nothing else before the blocker list:

These bullets are the Markdown rendering of exactly the JSON above, so read the
two together:

```markdown
- Priority threshold: `medium`
- Included priorities: `high<br>medium`
- Selected properties: `2`
- Implemented properties: `1`
- Blocked properties: `0`
- Pending properties: `0`
- Deferred properties: `1`
- Reference expectation properties: `1`

Blocker summaries:
- property-2: The handler cannot observe the premium delta returned by the Hub.
```

Join `Included priorities` with `<br>`, and write `unavailable` in the backticks
when the threshold or priorities are missing. Each count is the length of the
JSON array with the matching name, except `Reference expectation properties`,
which counts `reference_expected_property_ids`. Introduce the blocker list with
a line reading exactly `Blocker summaries:`, then one `- ` bullet per element of
`blocker_summaries`, in the same order as the JSON, with no blank line between
the heading and the first bullet: the list ends at the first line that is not a
`- ` bullet. Omit the heading and the list entirely when there are no blockers.

Write each blocker bullet as the JSON string itself. Collapsing runs of
whitespace to single spaces is fine; rewording, truncating, or re-punctuating it
is not. Markdown-escaping the special characters is accepted but not required,
so a summary naming `_beforeTokenTransfer` may appear either as
`- property-2: _beforeTokenTransfer reverts` or as
`- property-2: \_beforeTokenTransfer reverts`.

Add `## Property provenance` after the implementation coverage section. This
topology renders no implemented-property handoff, so the `implementation_paths`
and `test_paths` lineage that every provenance row requires does not exist for
any finding, and the join cannot be completed even when findings carry
`property_ids`. Emit the empty array (`[]`) for
`report.json.property_provenance`, and write `No property-derived findings.` as
the entire Markdown body of that heading. That sentence is exactly what the
Ultrafuzz runtime renders for an empty `property_provenance` array when it
regenerates `report.md` from `report.json`, so writing anything else here is
overwritten on publish and only creates a mismatch.

Do not render a provenance table and do not synthesize provenance rows,
`implementation_paths`, `test_paths`, or backend fields from the findings,
the lifecycle ledger, or the source tree. Reserve the
literal `unavailable` for the individual public-facing fields that are genuinely
unavailable; it is never a valid `report.json.property_provenance` value and it
is not the body of this heading under this topology.

When lifecycle records contain `comparison_disposition`, add a concise
`## Prior finding disposition` section after Property provenance and before
the non-production appendix. Group entries under exactly these labels
when present: `Promoted again`, `Rediscovered but demoted`, `Not reproduced`,
and `Not searched`. Match records by `dedupe_key` or family ids from the ledger,
not by titles.

For non-production actionable outcomes, append a single
`## Non-production actionable outcomes` table after the production issue
entries. The table should include classification, title, status, concise
evidence reference, strategy provenance, and recommended next action. Keep this
appendix short and do not include exploit-style PoC sections for these outcomes.

The human-readable report contains, in this order: the fixed title, issue index
table when production issues exist, fixed preamble, Run summary, concise
production issue entries with their Strategy sections, Property implementation
coverage, Property provenance, optional prior finding disposition section, and
non-production actionable outcomes appendix. If there are no production issues
and no appendix outcomes, skip the issue index table and write `No issues
reported.` before the Property implementation coverage section.

Save the human-readable report to `{{artifact_path}}/report.md`.

## Required JSON Shape

Also save `{{artifact_path}}/report.json` as structured JSON for the CLI. Include
`schema_version`, a `run_metadata` object matching the public Run summary
fields, a production `issues` array, a `non_production_outcomes` array, and
`property_provenance`.

`property_provenance` is always the empty array (`[]`) under this topology. A
provenance object is only well-formed when it carries `finding_id`, `title`,
non-empty `property_ids`, `sources` entries with `source_node_id` and
`source_property_id`, and the required `implementation_paths` and `test_paths`
arrays; this topology renders no implemented-property handoff, so that lineage
does not exist and no such object can be constructed. Emit `[]` for every run,
including runs whose findings carry `property_ids`. Never emit a provenance
entry, and never substitute the string `"unavailable"` for the
`property_provenance` value or for either path array.

Each production issue object must satisfy the canonical normalized finding
schema. Include at least `schema_version`, `id`, `title`, `status`,
`severity_guess`, `confidence`, and `summary`, and keep those fields consistent
with the final rendered issue. Also include the report-specific fields
`description`, `severity`, `likelihood`, `impact`, and `proof_of_concept`, plus
`family_id`, `family_variants`, and `related_findings` when those fields are
available. Keep the canonical `strategy` field a non-empty originating strategy
name when one is available. The structured `strategy_provenance` object must
contain a non-empty `detection_rates` or `strategies` array. Use exactly one of
these array keys; never emit both. Every array element must be an object with a
non-empty `strategy` string and provide either:

- a non-negative integer detection count under `detections`, `detected_loops`,
  `hits`, `matches`, or `loop_attempts` (an array under one of those keys is
  counted by its length), together with a positive-integer `configured_loops`
  that is greater than or equal to the detection count; or
- a `rate` or `detection_rate` string matching `^\d+/\d+$`, whose denominator
  is greater than zero and whose numerator does not exceed its denominator.

For example, this is a canonical renderable value:

```json
{
  "strategy_provenance": {
    "detection_rates": [
      { "strategy": "boundary-tests", "detections": 2, "configured_loops": 8 }
    ]
  }
}
```

Keep any additional loop-attempt provenance in this object for downstream
analysis. The production issue
`severity_guess`, `severity`, `impact`, and `likelihood` values must use the same
High, Medium, or Low report vocabulary rendered in Markdown. Do not add
alternate severity fields that preserve nonstandard upstream severity labels;
`severity_guess` must contain the normalized matrix severity. The production
issue `title` value must include the same severity-local title ID rendered in the
Markdown heading, for example
`[H-01] - Selectorless fallback can refund or spend stale contract ETH`.

In every `report.json` evidence object, keep `path` as a safe relative base path
without selectors and preserve independent `detail` prose exactly. Represent one
source span with positive integer `line` and optional `end_line`. Use
`line_ranges` only for at least two disjoint spans; never emit a one-entry
`line_ranges`, and never combine `line_ranges` with `line` or `end_line`.

Each non-production outcome object must preserve machine-readable
`triage_classification`, `status`, evidence, strategy provenance, and
`recommended_next_action`. Both production issues and non-production outcomes
must include a `lifecycle` object copied from the matching ledger record with
`dedupe_key`, `source_artifacts`, `strategy_hits`, `triage_classification`,
`triage_reason`, `demotion_reason`, `final_disposition`, and
`comparison_disposition` when those fields are present.

Before finishing, verify that:

- `report.md` starts with `# Ultrafuzz report`.
- Production issue headings use `[H-01]`, `[H-02]`, `[M-01]`, or `[L-01]`
  severity-local numbering.
- The issue index table uses exactly `Issue id` and `Title`.
- Immediately below the issue index table, `report.md` includes one sentence
  stating the total production issue count and High/Medium/Low severity
  distribution.
- Production issue descriptions and Proof of Concept steps use concrete
  actor-role language and do not contain placeholder tokens, anonymous variable
  labels, or copied boilerplate.
- Production issues include `### Proof of Concept`.
- Production issue Proof of Concept sections give an ordered source-backed
  scenario that names the contract, function, and source location for each step.
- Production issues include a `### Strategy` detection-rate table.
- Production issues do not include a standalone reachability section.
- Production issue Impact and Likelihood bullets each begin with exactly High,
  Medium, or Low followed by a colon.
- Every production issue severity equals the Impact x Likelihood matrix result.
- `report.json` contains `schema_version`, `run_metadata`, `issues`, and
  `non_production_outcomes`, plus `property_provenance` as the empty array
  (`[]`).
- Every `report.json` production issue satisfies the canonical normalized
  finding schema, including `schema_version`, `id`, `title`, `status`,
  `severity_guess`, `confidence`, and `summary`.
- Every `report.json` production issue keeps canonical `strategy` as a string
  when present and stores structured strategy details in `strategy_provenance`.
- `report.md` contains `## Property provenance` whose body is exactly
  `No property-derived findings.`, with no provenance table and no invented
  property IDs, because this topology renders no implemented-property handoff and
  the runtime renders that sentence for an empty `property_provenance` array.
- `report.json.property_provenance` is the empty array (`[]`), not a provenance
  entry and not the string `"unavailable"`.
- `report.md` contains `## Property implementation coverage` rendered as the
  literal `unavailable`, because the default topology declares no
  property-implementation handoff.
- `report.json.property_implementation_coverage` is the string `unavailable`,
  not a synthesized coverage object.
- `report.json.run_metadata.tokens_used` and
  `report.json.run_metadata.estimated_spend` match the values rendered in
  `report.md`, and preserve the exact cumulative accounting values from
  `run.json` when those metadata values are available.
- `report.json.run_metadata.repository` matches the normalized `Repository`
  value rendered in `report.md`.
- `report.json` production issue `severity_guess`, `severity`, `impact`, and
  `likelihood` fields use only High, Medium, or Low.
- `report.json` does not contain alternate severity fields that preserve
  nonstandard upstream labels.
