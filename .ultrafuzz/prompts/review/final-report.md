---
id: final-report
display_name: Generate report
---

# Generate report

Use the authoritative reachability tokens and report-bound note keys below for every finding; do not copy or rename them locally:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}

Your job is to produce a concise final audit issue list from the upstream
finding, triage, severity classification, lifecycle, strategy detection, and
generated-test aggregation outputs.

A bounded benchmark topology may intentionally omit triage, severity, test
aggregation, property, or harness handoffs. When no rendered path is provided,
do not treat the omitted handoff as an error. Use exactly one of these modes:

- **Strict severity-handoff mode** applies when
  `severity-classified-findings.json` is rendered. Preserve and validate that
  handoff as described below; never recompute its classification fields.
- **Bounded classification mode** applies only when that handoff is absent.
  Perform one source-backed classification pass over each deduplicated finding
  and enrich its matching dedupe lifecycle record only in the report object
  before selecting report entries.

In bounded classification mode:

- choose exactly one `triage_classification` from `true-positive`,
  `false-positive`, `undetermined`, `incomplete-spec`, `harness-defect`,
  `repair-candidate`, `spec-gated`, or `defensive-hardening`;
- set a concise source-backed `triage_reason` on every record;
- set `final_disposition` to `promoted` only for a `true-positive` that passes
  every reportability and evidence gate in this prompt, to `dropped` for a
  `false-positive`, and to `non-production` for every other actionable class;
- set a concise `demotion_reason` for every `non-production` or `dropped`
  record, and set `canonical_severity` after applying the matrix to every
  promoted record;
- for every promoted finding, author source-backed `impact`, `likelihood`, and
  their rationales, compute `severity` from the matrix, and set a concise
  `severity_rationale`; and
- preserve the dedupe lifecycle record's source artifacts, strategy hits, and
  `stages` array byte-for-byte. Do not append a report-only lifecycle stage;
  report schemas admit only stages backed by actual review artifacts.

If evidence is insufficient for `true-positive`, use `undetermined`; never
guess missing validation. Copy every normalized deduped-finding field
byte-for-byte into the selected report row before adding only report-schema
fields. Preserve `severity_guess` as preliminary provenance. Treat the enriched
lifecycle records as the bounded lifecycle source of truth and copy them into
the matching report objects. Render unavailable provenance fields as
`unavailable`, and emit a schema-valid report even when the resulting issue
list is empty.

## Required Inputs

Read every rendered input below before writing the report. The list is filtered
to the exact report handoffs declared by ancestors, so a bounded topology can
omit stages without leaving stale paths or exposing unrelated patches, raw
campaign plans, or generated-test bundles:

{{ancestor_artifacts_by_path:aggregation.json,severity-classified-findings.json,deduped-findings.json,strategy-detections.json,finding-lifecycle-ledger.json,properties.json,implemented-properties.json,recon-fuzzer-results.json,campaign-summary.json,setup/project-discovery.md,setup/setup-foundry.md,setup/base-test-setup.md,smoke-context.md}}

Use exact declared filenames to identify the available handoffs. When
`severity-classified-findings.json`, its `strategy-detections.json`, and its
`finding-lifecycle-ledger.json` are present, treat them as the review source of
truth. Validate the severity artifact against the exact pinned
`{{schema_path}}/severity-classified-findings.schema.json`; that schema alone
defines its JSON shape. Preserve its complete ordered finding population and
never substitute a legacy or converted artifact.

When the severity-classification handoffs are absent, use the rendered
`deduped-findings.json`, `strategy-detections.json`, and
`finding-lifecycle-ledger.json` as the exact dedupe-stage fallbacks. Do not
invent a missing path or legacy filename.

When `aggregation.json` is present, validate it against the exact pinned
`{{schema_path}}/aggregation-manifest.schema.json`; that schema alone defines
its JSON shape. Use copied runnable-test rows when matching generated or copied
destinations. Bind each row through its exact authenticated source-bundle and
manifest identity, preserve its byte size, digest, language, and provenance,
and never infer a framework from an extension or mix different bundles. These
joins and byte-preservation rules are contextual requirements beyond JSON
Schema.

Use `properties.json`, `implemented-properties.json`,
`recon-fuzzer-results.json`, and `campaign-summary.json` as property provenance
handoffs when they are present in the rendered list.

The catalog, implementation records, and campaign results form the provenance
join from a finding's `property_ids` to its canonical properties, source lens
rows, implementation/test paths, and recorded fuzzer backends. Treat references
to an unknown canonical property as an invalid current-run artifact. Every
declared current-run provenance handoff and every `property_ids` lineage needed
for the join must be present and valid. If one is absent or cannot be joined
exactly, stop with validation failure; do not guess, repair, or render a
historical compatibility value.

When the topology declares the authoritative campaign summary, validate it
against `{{schema_path}}/campaign-summary.schema.json` and copy its `outcome`
and its `reason` when present, exactly as parsed JSON values, into the report's
`campaign_outcome`. When no campaign-summary ancestor is declared, omit
`campaign_outcome`. Never infer an outcome from backend logs, findings, missing
files, or an agent-authored fallback. This authoritative ancestor join is
semantic and remains required in addition to report-schema validation.

Use project-discovery, Foundry setup, and base-test setup handoffs when their
declared Markdown files are present. Preserve every exact rendered filename
when mentioning an input internally or in `report.json` provenance. Do not
invent legacy filenames such as `dedupe-findings/findings.json` when the
rendered filename differs.

When `smoke-context.md` is present, use it as the authoritative bounded source,
harness, and reachability context for the classification pass.

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

For stateful invariant records, preserve every upstream finding whose `notes`
contain the typed stateful-failure classification entry from the authoritative
note-key list. Production-bug
records with generated target-native reproducers belong in the normal issue
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
Medium, and Low. Never render or preserve another label or an alternate severity
field. In strict severity-handoff mode, copy the severity artifact's `severity`,
`impact`, `likelihood`, and rationale fields exactly. If they are missing,
invalid, or fail the matrix, reject the upstream artifact; do not normalize,
recompute, or rewrite it. In bounded classification mode, author those fields
once from the supplied evidence and the boundaries below, then preserve the
authored values consistently throughout the report.

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

For every production issue, require final `severity` to equal the matrix result
for its `impact` and `likelihood`. In strict severity-handoff mode, reject a
mismatch instead of correcting the artifact. In bounded classification mode,
compute and author the matrix result. In particular:

- High impact + Low likelihood must render as Medium.
- Medium impact + Low likelihood must render as Low.

Never render `Critical`.

Reachability is not a standalone report section anywhere. Include concrete
public/helper callability evidence only inside the Likelihood and Impact
reasoning when it changes the assessment.

Use concrete actor or system-role language throughout the issue-related prose
you author yourself: everything you write in `report.md`, including issue
descriptions, Severity explanations, PoC steps, family variant bullets,
non-production outcome text, and recommended next actions as rendered there,
plus the `report.json` fields that exist only in the report, which are
`description` and `proof_of_concept`. This rule never licenses rewriting a
field you copy from the selected strict or bounded source finding. In `report.json`,
`summary`, `family_variants`, and `recommended_next_action` stay byte-identical
to the upstream finding even when their wording is weaker than the prose you
write around them. Choose actor wording from the evidence and reuse it
consistently. Use `Attacker` only when another party can gain an advantage,
grief, steal, or otherwise harm someone else. Use `User` when the behavior is
self-impacting or the protocol does not work as intended for the same user who
triggers it. Prefer precise roles such as `Depositor`, `Borrower`,
`Liquidator`, `Relayer`, or `Operator` when clearer. Do not combine multiple roles with slash notation. Do not leave
placeholder tokens, anonymous variable labels, or copied generated-test
boilerplate in the final report.

## Required Markdown Shape

The final-report producer owns production issue presentation in `report.json`:
stable-sort issues High, then Medium, then Low while preserving source order
within each severity. Assign severity-local IDs independently, starting at
`H-01`, `M-01`, and `L-01`; use a minimum of two digits so the sequence
continues `H-09`, `H-10`, and beyond. Set each JSON title to
`[<report ID>] - <original title text>`. Do not copy or reuse an upstream
machine ID in the report ID or title prefix. Preserve authenticated upstream
identity through the exact `lifecycle.dedupe_key`, `source_artifacts`, and
other source metadata. The host renderer validates this authored order,
numbering, and title shape without sorting, renumbering, or rewriting JSON.
The report severity vocabulary is exactly High, Medium, and Low. Reject any
other upstream value without normalizing, converting, or rewriting it.

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

Depositor can withdraw after accounting state diverges which leads to claimable funds remaining locked. The generated reproducer shows the stale share balance persists after the withdrawal path completes.

### Severity

- **Impact**: High: Locked claimable funds prevent affected depositors from recovering principal.
- **Likelihood**: Medium: The withdrawal path is reachable through the public redeem flow after the recorded state transition.

### Proof of Concept

1. Depositor prepares a position that records shares against the vault state.
2. Depositor performs the public redeem action after the accounting state diverges.
3. Depositor observes claimable funds remain locked after the redeem action completes.

```typescript
// Example only: replace this with the minimized target-native reproducer,
// including the imports, fixtures, setup, and helpers needed to run it.
```

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
action, and outcome. The title prefix is report-owned; all substantive copied
fields keep the upstream wording byte-for-byte.

Use the final `severity` selected by the active strict or bounded mode
consistently for issue IDs, ordering, counts, Markdown, and JSON after verifying
the matrix. Preserve `severity_guess` as preliminary provenance, and reject
`final_severity` or any other alias.

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

Use the selected source finding's explicit generated test path first, then the
aggregation manifest, to locate generated or copied tests. Prefer an aggregation
record that matches the same source artifact path, source relative path,
strategy, and attempt index as the finding. If the aggregation manifest is
missing that exact source test, or if same-path generated tests differ across
attempts and a copied destination would be ambiguous, read the source artifact's
exact canonical `generated-tests/<relative-file>` companion instead of a
flattened copy. Do not replace an unavailable native companion with a similarly
named file from another attempt or framework.

For each production issue with a generated test, include exactly one fenced code
block containing a minimized self-contained target-native reproducer, not a
pointer to a file and not an unedited full generated test suite. Select the
language fence from the canonical companion and aggregation metadata: use
`solidity` for Foundry `.t.sol`, `javascript` or `typescript` for Hardhat, and
`python` (or `vyper` only when the reproducer itself is Vyper source) for a
Vyper project's native harness. Never translate a JavaScript, TypeScript,
Python, or Vyper reproducer into Solidity merely for the report.

Include every import, mock, fixture, harness, constant, setup step, and helper
needed for the relevant test function or functions to run in the target's
existing framework. Remove unrelated generated test functions, unused helpers,
exploratory assertions, logging-only code, and comments that do not help
reproduce the issue. Keep multiple test functions only when they are all
necessary to prove the same production issue. Stop and report an invalid
upstream artifact if no relevant generated test source, executable scenario, or
self-contained reproducer source is available for a production issue.

Do not write local file paths, artifact-relative paths, generated test paths,
Markdown links, or permalink labels in the human-readable issue body. The
report must be self-sufficient when `report.md` is sent by itself.

If the upstream finding has `family_variants`, keep one issue entry for the
shared production root cause and add a `#### Family variants` subheading inside
the Proof of Concept section after the primary native reproducer or execution
trace. List variants as concise bullets with each variant title and summary
only. Omit the subheading when there are no family variants.

## Strategy Section

Compute the Strategy section from `strategy-detections.json`, the lifecycle
ledger, and configured strategy loop counts. For each strategy that found the
same deduped bug instance or same-root family variant, count matching loop
attempts for that strategy and divide by the total configured loops for that
strategy. Every selected source finding carries `dedupe_key`, identical to its
lifecycle record and its strategy-detections row, so match strategy detections
by that key. Stop and report an invalid upstream artifact when a finding has no
`dedupe_key`; never fall back to `finding_id` and never invent a key.

Render the human-readable Strategy section as a Markdown table with columns
`Strategy` and `Detection rate`. Detection rates must be exact `M/N` counts
without percentages. Keep loop-attempt provenance in `report.json`, not in the
human-readable Strategy section. Do not call this metric Temperature.

## Additional Sections

When `stateful-invariant-coverage` published `coverage-evidence.json`, copy it
exactly into `report.json` as `coverage_evidence`. Add `## Scoped coverage
evidence` to `report.md` and render every view as
`- <scope>: \`<covered_ranges>/<total_ranges>\`` plus the count of
`zero_coverage_components`. Never render a bare coverage percentage.

Add `## Property implementation coverage` after the production issue entries
and before `## Property provenance`. The runtime supplies the authoritative
current-run value in this prompt. Copy that JSON value exactly; do not derive,
repair, normalize, omit, or convert it. The exact pinned
`{{schema_path}}/report.schema.json` alone defines the tracked and not-planned
JSON variants. When the topology declares the property-implementation track,
preserve the runtime-supplied tracked value.

Use the canonical catalog order for every ID array. Keep the arrays as the
machine-readable source of truth; counts in Markdown must match them exactly.
When the canonical catalog contains `reference_expectations`, include every
corresponding canonical property ID in `reference_expected_property_ids` and
every distinct expectation identifier in `reference_expectation_ids`, in
catalog order. Preserve these arrays even when the property priority is below
the configured threshold.
For every selected record whose status is `blocked`, `pending`, or `deferred`,
preserve its blocker summary in `blocker_summaries` as
`<property-id>: <the record's blocker summary text>`, in canonical catalog
order. Copy that summary text verbatim from the handoff record's
`blocker.summary` — do not shorten, rephrase, re-punctuate, or re-case it. The
typed blocker's other fields stay in the handoff record; do not copy the blocker
object into the report.
When the current topology does not declare a property-implementation track,
preserve the runtime-supplied schema-defined not-planned value exactly.

Render that runtime value in Markdown as exactly:

```markdown
- Status: `not-planned`
- Reason: `property-implementation-track-not-declared`
```

Missing or invalid current selection metadata is a contract failure. It is not
an absence case and must never be converted to the `not-planned` variant.

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
when the threshold or priorities are unavailable. Derive each count from the
corresponding schema-defined collection in the authoritative coverage value;
`Reference expectation properties` counts the properties carrying a reference
expectation. Introduce the blocker list with a line reading exactly `Blocker summaries:`.
Then write one `- ` bullet per authoritative blocker summary, in the same order
as the coverage value, with no blank line between the heading and the first
bullet: the list ends at the first line that is not a `- ` bullet. Omit the
Markdown heading and list when the authoritative value has no blockers.

Write each blocker bullet from the exact corresponding blocker-summary value.
Collapsing runs of whitespace to single spaces is fine; rewording, truncating,
or re-punctuating it is not. Markdown-escaping the special characters is
accepted but not required, so a summary naming `_beforeTokenTransfer` may appear either as
`- property-2: _beforeTokenTransfer reverts` or as
`- property-2: \_beforeTokenTransfer reverts`.

Add `## Property provenance` after the implementation coverage section. For every
property-derived production or non-production finding, render one concise table
row containing:

- its final finding ID/title;
- every canonical property ID established by the joined property lineage;
- every source `source_node_id` and `source_property_id` joined from
  `properties.json`;
- the union of `implementation_paths` and `test_paths` joined from
  `implemented-properties.json`;
- every originating backend recorded for the same stable finding ID in
  `recon-fuzzer-results.json`, preserving the exact backend union through the
  report schema's backend-provenance representation. When no campaign backend
  is known, render `unavailable` in the Markdown table and do not invent JSON
  backend evidence.

Use table columns `Finding`, `Property IDs`, `Source nodes`, `Source property
IDs`, `Implementation/test paths`, and `Fuzzer backends`. Do not add a row for a
finding with no joined canonical property lineage; it is a valid non-property finding. If current
artifacts contain no property-derived findings, write `No property-derived
findings.` Missing or unjoinable current-run lineage is a validation failure;
do not render `unavailable`, continue, or guess.

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

## Structured report semantics

Also save `{{artifact_path}}/report.json` as structured JSON for the CLI. Read
the exact pinned `{{schema_path}}/report.schema.json`; it alone defines the JSON
version, fields, types, enums, required members, optional members, and empty
forms. After the final write, run the exact `ultrafuzz json validate` command
rendered for this artifact in the central output contract.

After `report.json` passes validation, generate the required byte-exact
canonical Markdown with this producer command:

```sh
ultrafuzz report render --file '{{artifact_path}}/report.json' --output '{{artifact_path}}/report.md'
```

The command fails instead of inventing missing final-review evidence. Treat
exit 1 as a report JSON authoring failure: correct `report.json`, rerun its exact
validation command, and rerun this renderer. Do not hand-edit `report.md` after
the renderer succeeds.

Copy run identity, repository, elapsed time, model, token, pricing, loop, and
audit-policy metadata from the authoritative run record. Preserve each exact
value used in the Markdown Run summary and never synthesize a missing value.

Emit one property-provenance record per property-derived finding, joined to its
canonical property sources and implementation/test paths. Preserve the complete
set of campaign backends that produced the stable finding, uniquely and in
deterministic order. The pinned report schema alone defines how zero, one, or
several producing backends are represented; never invent a backend or use a
historical compatibility value. Use stable unions when several properties
contribute and emit no property-provenance records when there are no
property-derived findings.

In strict severity-handoff mode, copy every field the severity-classified
finding already carries into its `report.json` issue object byte-for-byte except
the report-owned `id` and `title`, including `summary`,
`recommended_next_action`, `family_variants` and their nested summaries,
`severity`, `impact`, `likelihood`, `evidence`, and `strategy_provenance` when
the upstream finding has it. In bounded classification mode, apply the same
byte-for-byte rule to every field already carried by the normalized deduped
finding, then ADD the bounded classification and report-owned fields it lacks.
Apart from authoring canonical report `id` and `title`, only add fields admitted
by the pinned report schema. Rewriting, tightening, or re-voicing any other
copied field fails the report. Keep the canonical originating strategy name
when one is available.
Derive structured detection rates from the exact strategy hits and configured
loop counts, and preserve optional attempt provenance from the canonical hit
records. Do not emit removed or compatibility aliases.

Keep any additional loop-attempt provenance only in the fields admitted by the
schema. `severity_guess` remains the upstream preliminary estimate and need not
equal final `severity`; `severity`, `impact`, and `likelihood` use the report
vocabulary. Never add `final_severity` or upstream/compatibility aliases. The
production issue `id`, `title`, and cross-severity order are report-owned.
Author them in canonical presentation form before validation; the renderer
only validates and renders them. Use exact lifecycle and source metadata—not
presentation identity—to retain the corresponding source finding.
Whenever a property-derived finding is assigned a different report presentation
ID, set its `property_provenance.source_finding_id` to the exact authenticated
upstream campaign finding ID and keep `property_provenance.finding_id` equal to
the report ID. Obtain that source ID from the matching lifecycle source record;
do not copy the report ID into both fields, infer an ID from a property, or omit
`source_finding_id` after renumbering.

In every `report.json` evidence object, keep `path` as a safe relative base path
without selectors and preserve independent `detail` prose exactly. Put section
anchors in `fragment`. For every schema-admitted multi-span citation, sort the
spans by their starting line, require them not to touch or overlap, and cite the
earliest span first even when a later one is the interesting one. Apply the
same ordering to family-variant evidence. These ordering rules are not checked
by `ultrafuzz json validate`.

Each non-production outcome preserves its complete normalized finding,
classification, status, evidence, strategy provenance, and recommended next
action. Both production and non-production rows must copy the complete matching
lifecycle record exactly, including every optional field that is actually
present. These preservation, ordering, and cross-artifact joins are contextual
requirements beyond JSON Schema.

Before finishing, verify that:

- `report.md` starts with `# Ultrafuzz report`.
- Production issue headings are stable-sorted High, Medium, Low, preserve
  source order within each severity, and use canonical severity-local IDs and
  prefixed titles (`H-01`, `H-09`, `H-10`, `M-01`, and `L-01`).
- The issue index table uses exactly `Issue id` and `Title`.
- Immediately below the issue index table, `report.md` includes one sentence
  stating the total production issue count and High/Medium/Low severity
  distribution.
- Production issue descriptions and Proof of Concept steps use concrete
  actor-role language and do not contain placeholder tokens, anonymous variable
  labels, or copied generated-test boilerplate.
- Production issues include `### Proof of Concept`.
- Production issues with generated tests include exactly one inline fenced code
  block whose language matches the target-native reproducer.
- Production issues include a `### Strategy` detection-rate table.
- Production issues do not include a standalone reachability section.
- Production issue Impact and Likelihood bullets each begin with exactly High,
  Medium, or Low followed by a colon.
- Every production issue severity equals the Impact x Likelihood matrix result.
- `report.json` passes the exact rendered validation command for its pinned
  schema.
- In strict severity-handoff mode, every `report.json` production issue
  preserves the complete normalized severity-classified finding except for
  report-owned `id` and `title`.
- In bounded classification mode, every `report.json` production issue
  preserves every normalized deduped-finding field byte-for-byte and adds the
  source-backed classification and report-owned fields required by the schema.
- Every `report.json` production issue reproduces every non-presentation field
  already present on its selected source byte-for-byte, including `summary`,
  `recommended_next_action`, and `family_variants` when present, and adds only
  fields that source does not carry.
- Every source finding you render has a `dedupe_key` exactly equal to its
  lifecycle record's corresponding value.
- Every `line_ranges` array is sorted by ascending `line`, with each entry's
  `line` greater than the previous entry's `end_line`.
- Every `report.json` production issue preserves the canonical originating
  strategy value when present and keeps its structured strategy details.
- `report.md` contains `## Property provenance`, including every
  property-derived finding and no invented property IDs for non-property
  findings.
- `report.md` contains `## Property implementation coverage` with counts that
  match the authoritative tracked value, or the exact runtime-supplied
  not-planned rendering when the current topology has no implementation track.
- `report.json` exactly preserves the runtime-supplied authoritative property
  implementation coverage value.
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
