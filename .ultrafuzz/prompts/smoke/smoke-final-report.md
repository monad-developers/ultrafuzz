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
Each production issue must preserve the normalized finding identity,
preliminary severity, confidence, summary, originating strategy, affected
code, evidence, strategy provenance, and matching lifecycle record. Add final
severity, impact, likelihood, their source-backed rationales, and a non-empty
proof-of-concept scenario in the target's native language. These preservation
and evidence requirements are semantic; the pinned schema owns their shape.

Write `{{artifact_path}}/report.json` using the exact pinned
`{{schema_path}}/report.schema.json`; it alone defines the JSON version, fields,
types, enums, required members, and empty forms. Copy the public run metadata
from the supplied run record, preserve matching lifecycle records with
production and non-production findings, emit no property provenance rows, and
use the schema's typed `not-planned` property-implementation coverage variant
because the smoke topology declares no property implementation track. Never
synthesize that variant to hide missing or malformed evidence in a topology
that does declare the track.

This smoke topology declares no campaign-summary ancestor, so omit
`campaign_outcome`; never synthesize an agent-authored campaign status.

The `issues` array is the scoring source of truth and must remain non-empty
whenever at least one deduped finding is supported as a production bug.

Every non-production outcome preserves every upstream finding field exactly and
adds the report-context classification, recommendation, and lifecycle values
required by the pinned report schema.

Copy the effective audit policy from the supplied run metadata into the same
closed `run_metadata` object: `audit_profile`, `audit_profile_catalog_digest`,
`topology_digest`, `prompt_digest`, and `expanded_graph_fingerprint`. Use the
runtime-recorded values exactly, never reconstruct them from paths, and show
them in the Markdown Run summary.

After `report.json` passes its exact rendered validation command, generate the
required byte-exact canonical Markdown with this producer command:

```sh
ultrafuzz report render --file '{{artifact_path}}/report.json' --output '{{artifact_path}}/report.md'
```

The command fails instead of inventing missing final-review evidence. Treat
exit 1 as a report JSON authoring failure: correct `report.json`, rerun its exact
validation command, and rerun this renderer. Do not author or hand-edit
`report.md` after the renderer succeeds.

The rendered `report.md` begins with `# Ultrafuzz report` and includes a concise
run summary, an issue index, and for each production issue its severity
reasoning, evidence/PoC, affected code, and strategy detections. It includes a
short non-production outcomes table when needed and states `No issues reported.`
only when the evidence supports no production issue. Under
`## Property implementation coverage`, render exactly:

```markdown
- Status: `not-planned`
- Reason: `property-implementation-track-not-declared`
```

Run every exact `ultrafuzz json validate` command rendered in the central
output contract; correct an exit-1 JSON artifact yourself and rerun its command
after any later edit. Then run the canonical Markdown renderer above and stop.
