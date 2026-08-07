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
likelihood is Medium and otherwise High. Set both `severity` and
`severity_guess` to that matrix result. Normalize each production issue to
include at least:

- `schema_version: "1.0"`, stable `id`, concise `title`, `status`,
  `severity_guess`, `confidence`, and `summary`;
- `strategy` as one originating strategy string, affected files/functions, and
  concrete evidence;
- `severity`, `impact`, `likelihood`, `description`, and a reproducible
  `proof_of_concept` or precise execution trace; and
- structured `strategy_provenance` and its matching lifecycle record when
  available; and
- the complete non-empty `source_nodes` discovery union with compatibility
  `source_node_id` equal to its first entry.

Write every issue's `confidence` as one of the strings `high`, `medium`, or
`low`; never use a numeric confidence in the normalized report.

Write `{{artifact_path}}/report.json` with `schema_version: "1.0"`, a
`run_metadata` object, normalized production `issues`,
`non_production_outcomes`, and `property_provenance: []`. The `issues` array is
the scoring source of truth and must remain non-empty whenever at least one
deduped finding is supported as a production bug.

Write the exact same normalized production issue array to
`{{artifact_path}}/findings.normalized.json`. Use `[]` only when the bounded
final review supports no production issue; this is a required smoke terminal
artifact and must never contain synthetic findings.

Write `{{artifact_path}}/report.md` beginning with `# Ultrafuzz report`. Include
a concise run summary, an issue index, and for each production issue its
severity reasoning, evidence/PoC, affected code, strategy detections, and a
`- **Source nodes**:` bullet listing the finding's `source_nodes` union as
comma-separated backticked IDs. Add a short
non-production outcomes table when needed. State `No issues reported.`
only when the evidence supports no production issue. Validate all three
required files against their output contracts, then stop.
