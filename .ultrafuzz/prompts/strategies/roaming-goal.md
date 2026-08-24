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

Use these runtime-owned vocabularies exactly when authoring any finding:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}

Derive this node's absolute UTC deadline from the Topology Runtime Context:
run `date -u +%s` once at startup and add the working budget it states.
Re-run `date -u +%s` before each expensive step and compare epochs. At the
deadline, stop roaming, write the findings and generated-test artifacts, and
exit cleanly. An empty result is a negative result, not a failure: publishing
the contract-defined empty result is strictly better than being killed at the timeout with no
output, and better than inventing a finding.

Write normalized findings to `{{output_findings_path}}`. When no supported
vulnerability is found, publish the empty result defined by the pinned schema.
If you create focused tests, put them below
`{{strategy_attempt_test_dir}}` and write the ordinary generated-test manifest
to `{{artifact_path}}/generated-tests.json`. Otherwise satisfy the pinned
generated-test schema with its no-test result.
