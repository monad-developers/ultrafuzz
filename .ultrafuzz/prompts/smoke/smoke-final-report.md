---
id: smoke-final-report
display_name: Generate smoke report
---

# Generate smoke report

Turn the bounded dedupe result into the terminal report used by eval scoring.
This is one final evidence review, not another repository-wide audit.

Required inputs:

- Context: `{{artifact_path:smoke-context}}/smoke-context.md`
- Findings: `{{artifact_path:dedupe-findings}}/deduped-findings.json`
- Strategy hits: `{{artifact_path:dedupe-findings}}/strategy-detections.json`
- Lifecycle: `{{artifact_path:dedupe-findings}}/finding-lifecycle-ledger.json`
- Run metadata: `{{run_metadata_path}}`

For every retained finding, decide whether the supplied source and execution
evidence establishes a reachable production bug. Preserve supported production
bugs in `issues`; place incomplete specifications, harness defects, and other
actionable non-production results in `non_production_outcomes`. Do not silently
drop evidence-supported findings just because a native runner was unavailable,
and never invent a finding to satisfy CI.

Use only High, Medium, or Low for severity, impact, and likelihood. Recompute
severity from evidence with this exact matrix: Low impact is Low; Medium impact
with Low likelihood is Low and otherwise Medium; High impact with Low
likelihood is Medium and otherwise High. Set the final `severity` to that
matrix result while preserving each finding's preliminary `severity_guess`.
Each production issue includes:
include at least:

- `schema_version: "ultrafuzz.finding.v2"`, stable `id`, concise `title`, `status`,
  `severity_guess`, `confidence`, and `summary`;
- `strategy` as one originating strategy string, affected files/functions, and
  concrete evidence;
- `severity`, `impact`, `likelihood`, all three rationale fields,
  `description`, and `proof_of_concept` as an object with non-empty `scenario`,
  `language`, and `code`; and
- structured `strategy_provenance` and its matching lifecycle record when
available.

Write every issue's `confidence` as one of the strings `high`, `medium`, or
`low`; never use a numeric confidence in the normalized report.

Write `{{artifact_path}}/report.json` with `schema_version: "ultrafuzz.report.v2"`.
The closed `run_metadata` object has `run_id`, `source_run_id`, `repository`,
`elapsed_time`, `models_used`, `tokens_used`, `estimated_spend`,
`partial_pricing`, and integer `strategy_loops`. Write canonical finding v2
objects with matching lifecycle records in production `issues` and
`non_production_outcomes`, `property_provenance: []`, and this required typed
coverage value because the smoke topology does not declare a property
implementation track:

```json
"property_implementation_coverage": {
  "status": "not-planned",
  "reason": "property-implementation-track-not-declared"
}
```

The `issues` array is the scoring source of truth and must remain non-empty
whenever at least one deduped finding is supported as a production bug.

Every non-production outcome also preserves the canonical finding v2 fields and
adds required `triage_classification`, `recommended_next_action`, and
`lifecycle`.

Write `{{artifact_path}}/report.md` beginning with `# Ultrafuzz report`. Include
a concise run summary, an issue index, and for each production issue its
severity reasoning, evidence/PoC, affected code, and strategy detections. Add a
short non-production outcomes table when needed. State `No issues reported.`
only when the evidence supports no production issue. Under
`## Property implementation coverage`, render exactly:

```markdown
- Status: `not-planned`
- Reason: `property-implementation-track-not-declared`
```

Validate both required files against their output contracts, then stop.
