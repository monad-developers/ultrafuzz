---
id: signal-analysis
display_name: CI Signal Analysis
---

# CI Signal Analysis

Use:
{{artifact_path:project-discovery}}/setup/project-discovery.md

Write:

- {{artifact_path}}/signal-analysis.md
- {{artifact_path}}/generated-tests.json
- {{output_findings_path}}

Run exactly this command and then stop. Do not install dependencies, run extra analysis, edit production files, or include secret values.

```bash
bun "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.ts" signal-analysis --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```
