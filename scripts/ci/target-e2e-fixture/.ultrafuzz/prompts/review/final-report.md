---
id: final-report
display_name: CI Final Report
---

# CI Final Report

Use:
{{run_metadata_path}}
{{artifact_path:signal-analysis}}/signal-analysis.md
{{artifact_path:signal-analysis}}/findings.json

Write:

- {{artifact_path}}/report.md
- {{artifact_path}}/report.json

Run exactly this command and then stop. Do not install dependencies, run extra analysis, edit production files, or include secret values.

```bash
python3 "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.py" final-report --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}" --findings "{{artifact_path:signal-analysis}}/findings.json" --run-metadata "{{run_metadata_path}}"
```
