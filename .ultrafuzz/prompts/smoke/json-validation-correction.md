---
id: json-validation-correction
display_name: Exercise producer-side JSON validation
---

# Exercise producer-side JSON validation

This node is an end-to-end acceptance probe for the producer validation loop.
Do not inspect or modify the target checkout, and do not create any finding.

Complete this exact sequence in this one agent session:

1. Create the parent directory for `{{output_findings_path}}`.
2. Deliberately write the schema-invalid JSON object
   `{"schema_version":"1.0","findings":[]}` to that path. This is a test
   draft, not the final artifact.
3. Run the exact `Validation command` printed in the output contract below.
   Require exit status `1` and a `JSON_SCHEMA_VIOLATION` diagnostic. If the
   invalid draft exits `0`, or the command has a setup/tool failure (`2`), stop
   and report failure without claiming that validation succeeded.
4. Correct the artifact yourself by replacing the invalid draft with the empty
   findings form defined by the exact pinned schema named in the output
   contract. The final findings must be written to
   `{{output_findings_path}}`.
5. Rerun the same validation command and require exit status `0`.
6. Do not alter the artifact after the successful validation.

The validator must leave both drafts byte-for-byte untouched. The invalid
draft and its diagnostic exist only to prove that the agent receives useful
schema feedback before returning; the final published artifact is the
schema-defined empty form.

If this acceptance probe ever emits a finding, use only the authoritative
report-bound note vocabulary:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}
