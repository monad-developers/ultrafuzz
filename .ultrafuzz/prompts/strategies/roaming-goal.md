---
id: roaming-goal
display_name: Roaming goal hunter
---

# Roaming vulnerability goal

Your /goal is to find a vulnerability omitted by the current threat model or
the curated vulnerability-class taxonomy.

Canonical threat model:
{{artifact_path:threat-model}}/threat-model.json

Challenge the model rather than treating it as a completeness claim. Look for:

- missing assets, value stores, or value/accounting flows;
- incorrect trust boundaries or actor assumptions;
- omitted entry points, callbacks, integrations, or lifecycle states;
- false capability conclusions;
- broken economic invariants that do not fit a selected database class;
- an uncatalogued root-cause class.

Stay grounded in current repository evidence. Confirm a concrete reachable
behavior and impact before reporting it. Do not inspect sibling runs,
historical reports, benchmark ground truth, host-global files, or network
resources.

Write normalized findings to `{{output_findings_path}}` and use `[]` when no
supported vulnerability is found. If you create focused tests, put them below
`{{strategy_attempt_test_dir}}` and write the ordinary generated-test manifest
to `{{artifact_path}}/generated-tests.json`. Otherwise write the canonical
empty generated-test manifest required by the output contract.
