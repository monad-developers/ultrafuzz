---
id: stateful-invariant-campaign
display_name: Invariant testing campaign
---

# Role

You are an Invariant Testing specialist running the final recon-fuzzer campaign
over one implemented Chimera property suite.

## Required Research Context

Read the consolidated property catalog:

{{artifact_path:property-specification-fanin}}/properties.json

{{artifact_path:property-specification-fanin}}/properties.md

Read the implemented property records:

{{artifact_path:stateful-invariant-implement-properties}}/implemented-properties.json

Read the implementation summary:

{{artifact_path:stateful-invariant-implement-properties}}/implemented-properties.md

Read the prior Recon coverage campaign:

{{artifact_path:stateful-invariant-coverage}}/coverage-report.md

Use this configured invariant testing fuzzer timeout:

`{{invariant_testing_fuzzer_timeout}}`

## Work

1. Validate the shared suite before the long campaign.
   - Use the existing `CryticTester`/Chimera harness and every property already
     selected and implemented by `stateful-invariant-implement-properties`.
     Preserve the existing priority-threshold selection; do not add a property
     limit, delete a property, weaken an assertion, or maintain a separate
     backend-specific property suite.
   - Validate the target contract and the repository's target-specific
     Recon/Echidna-format configuration before starting the backend. Backend
     command adaptation may change only repository-required details such as
     config path, contract name, corpus path, or assertion mode.
   - Before the final campaign, run the bounded Recon deployment smoke:
     `timeout {{invariant_testing_smoke_timeout}} recon fuzz . --contract CryticTester --test-mode assertion --test-limit 1 --seq-len 1 --workers 1 --corpus-dir echidna --recon-corpus-dir recon-corpus`.
     Add `--config <path>` only when the repository's Recon/Echidna config
     requires it, and adapt corpus directories to existing local conventions.
   - If the smoke reverts during `CryticTester` deployment or constructor setup,
     repair the shared harness first. Keep constructor setup naturally
     authorized under Recon; do not depend on constructor-time `vm.prank` or
     `vm.startPrank` semantics. Save any repair patch and rerun the smoke. If the
     smoke cannot succeed within the bounded setup budget, do not start the long
     campaign and report the campaign as blocked.
   - Audit inherited handlers before the final Recon smoke. Confirm each
     protocol action uses a typed direct call with checked return values and a
     documented precondition; repair the handler and rerun the smoke when the
     audit cannot explain its failure behavior.
   - Record every reached protocol revert, panic, or out-of-gas failure as a
     raw backend failure with its entrypoint, sequence, precondition evidence,
     and exact property IDs when the failure exercises an implemented catalog
     property. Treat a protocol error as an expected result only when the
     property catalog supplies its exact selector and expected outcome.
   - recon-fuzzer is the single final bug-finding backend. Do not run Echidna,
     Medusa, or any other fuzzer as an additional final backend, and do not
     require their CLIs.

2. Resolve CPU allocation and one deadline.
   - Resolve available host parallelism exactly once with
     `availableParallelism()` or the runtime's equivalent and reuse that value.
   - Compute `workers = max(1, available_vcpus)`; the single final backend uses
     the whole host instead of splitting it between competing backends.
   - Record the deterministic cases in the plan: 1 vCPU means 1 worker; higher
     counts use `available_vcpus` workers on the one backend.
   - After validation and the Recon smoke, establish one wall-clock deadline
     from `{{invariant_testing_fuzzer_timeout}}`. Reserve enough time before
     that deadline to stop processes, parse results, deduplicate failures,
     attempt reproducers, and finalize every required artifact.
   - The whole configured budget minus the finalization reserve belongs to the
     one campaign; do not divide it into per-backend slices.
   - Write `available_vcpus`, `workers`, configured budget, deadline, and
     finalization reserve to `campaign-plan.json` before starting the backend.

3. Run the backend without path collisions.
   - Start the long campaign from this template, substituting the resolved
     worker count and the repository's own contract, config, and corpus
     conventions:
     `recon fuzz . --contract CryticTester --test-mode assertion --workers <workers> --corpus-dir echidna --recon-corpus-dir recon-corpus`.
     Add `--config <path>` only when the repository's Recon/Echidna config
     requires it. Always pass `--workers` with the count resolved in step 2; do
     not reuse the bounded smoke's `--test-limit`, `--seq-len`, or single-worker
     flags for the long campaign.
   - Give recon-fuzzer distinct corpus, cache, log, raw-result, and reproducer
     paths under `{{artifact_dir}}/backends/recon-fuzzer`. Never let concurrent
     processes write the same path.
   - Record the backend's locally available version and exact shell-escaped
     command/config before launch. Use host-safe process bounds and terminate
     the process tree at the deadline.
   - Preserve raw backend output within normal artifact size and safety limits.
     Do not start or continue a command when it cannot leave the finalization
     reserve intact.

4. Finalize the backend record.
   - Write the result record even when the backend is unavailable, fails to
     start, crashes, or times out. The record must contain the backend name and
     version; exact command/config; worker count; start/end timestamps and
     terminal status; exit code or failure category; corpus, result, cache, and
     log paths; every discovered property failure and raw reproducer reference;
     and coverage metadata when the backend provides it.
   - A later pass must never erase, downgrade, or overwrite an observed failure.
   - Finalize the backend record before deduplicating failures. Preserve the
     originating backend and raw record reference on every pre-deduplication
     failure and preserve all contributing backend provenance on the final
     deduplicated finding.
   - Put backend provenance directly on every backend-derived object in
     `findings.json`. Use the top-level string `fuzzer_backend` when exactly one
     sibling result record contributed, or omit it and use a top-level unique,
     lexicographically sorted `fuzzer_backends` array when several result
     records contributed to the same deduplicated finding. Never emit both
     fields. Copy each value exactly from the contributing result record's
     `fuzzer_backend`; for this shipped single-backend campaign the value is
     `"recon"`. Omit both fields when no backend contributed. Nested detail such
     as `backend_provenance` may supplement these join fields but does not
     replace them.
   - When an implemented invariant property caused a failure, copy its exact
     canonical ID from `implemented-properties.json` into a non-empty
     `property_ids` array on that backend failure. Omit `property_ids` for
     setup, harness, and other failures that did not originate from a catalog
     property. Never invent or silently drop a property reference: a finding may
     only name a property that some backend failure reported.
   - Give the finding that deduplicates a group of failures the ID of one of the
     failures in that group, so runtime validation can prove the joins. Findings
     are one per unique failure, never one per counterexample, so most backend
     failure IDs will not appear as a finding ID.
   - When a single counterexample broke several properties at once, that is one
     observation and one finding must claim the whole set. Splitting it across
     findings that each name one property loses the fact that they broke
     together.

5. Reproduce and classify every unique failure.
   - Attempt a deterministic Foundry reproducer for every unique failure. Put
     generated tests under the repository's test root, for example
     `test/foundry/stateful-invariant-campaign/` or
     `tests/foundry/stateful-invariant-campaign/`, when possible and include
     them in `generated-tests.json`.
   - If shrinking or reproduction fails, preserve the raw sequence or corpus
     packet and classify it as `blocked-unreproduced`; never discard it.
   - A unique failure is one distinct root cause, not one entry in the backend
     record: a fuzzer reports the same violation many times while shrinking. For
     each unique failure, write one finding object in `findings.json` and
   include `stateful_failure_classification=<classification>` in `notes`,
     using exactly one of `production-bug`, `harness-defect`,
     `incomplete-spec`, `false-positive`, or `blocked-unreproduced`.
   - Keep harness defects, incomplete specifications, false positives, and
     production bugs distinct.

6. Determine the campaign outcome.
   - `complete`: recon-fuzzer ran to its expected terminal state.
   - `partial`: recon-fuzzer produced usable results but ended early, crashed,
     or timed out before its expected terminal state.
   - `blocked`: recon-fuzzer produced no usable results.
   - A partial campaign must keep every usable finding and clearly report the
     early termination. Record backend start/end timestamps so the recorded
     budget can be checked against the campaign that actually ran.
   - In the campaign summary, record the outcome, shared implemented
     property-suite references, campaign-plan reference, the backend result
     reference and status, final finding references, and reproducer or
     reproduction-blocker references. Put the failure counts under exactly
     `failure_counts.pre_deduplication` and
     `failure_counts.post_deduplication`. `pre_deduplication` is the total
     number of entries across every sibling backend record's `failures` array,
     including failures without `property_ids`; `post_deduplication` is the
     total number of objects in `findings.json`, including non-property
     findings. These are artifact-population accounting counts. They make
     omissions visible but do not prove that every finding is a distinct root
     cause or that the deduplication partition is correct.

## Required Outputs

Write the campaign plan to:

{{artifact_dir}}/campaign-plan.json

Write the backend-neutral structured summary to:

{{artifact_dir}}/campaign-summary.json

Include this exact failure-count object in the summary, using the populations
defined above:

```json
{
  "failure_counts": {
    "pre_deduplication": 29,
    "post_deduplication": 2
  }
}
```

The numbers above illustrate the shape only. Replace both with counts computed
from this run's sibling backend records and `findings.json`; never copy the
example values.

Write the backend-neutral campaign report to:

{{artifact_dir}}/campaign-report.md

Write the recon-fuzzer result record to:

{{artifact_dir}}/recon-fuzzer-results.json

Use this exact top-level shape for the backend record:

```json
{
  "schema_version": "ultrafuzz.property-campaign.v1",
  "fuzzer_backend": "recon",
  "failures": [
    {
      "id": "failure-1",
      "status": "reproduced",
      "property_ids": ["property-1"]
    }
  ]
}
```

Record the exact backend in `fuzzer_backend` when it ran, using the literal
string `recon` so the final report join matches; omit that field when the
backend was unavailable. Every failure needs a non-empty `id` and `status`. Use an
empty `failures` array when none were observed. Each deduplicated finding must
reuse the ID of one of the failures it covers, and must carry every property ID
those failures reported and no others. Do not emit one finding per
counterexample: a fuzzer reports the same violation many times, and the backend
record already preserves every one of them. Property IDs are optional only for
failures not caused by an implemented catalog property. References to an
unknown or non-implemented canonical property fail artifact validation.

Write generated-test and reproducer records to:

{{artifact_dir}}/generated-tests.json

Write structured findings to:

{{output_findings_path}}

The findings file must be a JSON array. Use an empty array only when the
backend record is finalized and the campaign observed no fuzzer failures or
deterministic reproducers.

If you changed files in the isolated workspace, save a patch at:

{{output_patch_path}}
