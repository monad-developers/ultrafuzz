---
id: aggregate-test-files
display_name: Aggregate test files
---

# Aggregate test files

This workflow records an empty generated-test aggregation.

Read these review handoffs only to preserve the default review sequence:

Dedupe report:
{{artifact_path:dedupe-findings}}/deduped-findings.json

Severity-classified findings:
{{artifact_path:severity-classification}}/severity-classified-findings.json

Write an empty aggregation manifest to {{artifact_path}}/aggregation.json with
this JSON shape:

- `schema_version`: `"1.0"`
- `source_generated_tests`: `0`
- `copied_generated_tests`: `0`
- `source_support_files`: `0`
- `copied_support_files`: `0`
- `files`: `[]`
- `support_files`: `[]`
- `skipped_files`: `[]`
