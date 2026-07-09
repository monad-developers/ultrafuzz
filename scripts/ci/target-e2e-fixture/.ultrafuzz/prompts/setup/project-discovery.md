---
id: project-discovery
display_name: CI Project Snapshot
---

# CI Project Snapshot

Write:

- {{artifact_path}}/setup/project-discovery.md
- {{output_findings_path}}

Run exactly this command and then stop. Do not install dependencies, run extra analysis, edit production files, or include secret values.

```bash
bun "{{repo_path}}/.ultrafuzz/ci/target-e2e-artifacts.ts" project-discovery --repo "{{repo_path}}" --artifact "{{artifact_path}}" --out "{{output_findings_path}}"
```
