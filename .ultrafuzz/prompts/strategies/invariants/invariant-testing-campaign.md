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

2. Resolve CPU allocation and the supervised timing budgets.
   - Resolve available host parallelism exactly once with
     `availableParallelism()` or the runtime's equivalent and reuse that value.
   - Compute `workers = max(1, available_vcpus)`; the single final backend uses
     the whole host instead of splitting it between competing backends.
   - Record the deterministic cases in the plan: 1 vCPU means 1 worker; higher
     counts use `available_vcpus` workers on the one backend.
   - After validation and the Recon smoke, reserve the complete
     `{{invariant_testing_fuzzer_timeout}}` seconds for the supervised Recon
     process. Do not subtract setup, parsing, shutdown, reproducer, or artifact
     finalization time from it.
   - Use a 300-second host shutdown grace after the fuzzing deadline. This
     grace lets Recon handle the supervisor's `SIGINT`, finish shrinking, and
     flush its corpus and result output before a forced kill.
   - Establish a separate artifact-finalization reserve after the host shutdown
     grace to parse results, deduplicate failures, attempt reproducers, and
     finalize every required artifact. The shutdown grace and artifact reserve
     are both additional to, not part of, the configured fuzzer timeout.
   - The complete configured fuzzer timeout belongs to the one campaign; do not
     divide it into per-backend slices.
   - Before launch, write a preliminary `campaign-plan.json` with
     `configured_fuzzer_timeout_seconds`, `recon_internal_timeout_seconds`,
     `recon_test_limit` (as a decimal string),
     `host_soft_timeout_seconds`, `host_force_kill_grace_seconds`,
     `artifact_finalization_reserve_seconds`, the exact command under
     `backend.exact_shell_escaped_command`, and pending start-derived deadline
     fields. Record the supervised launch timestamp immediately before starting
     the process, then update the plan with `backend_started_at`,
     `fuzzing_deadline_utc = backend_started_at + configured timeout`,
     `force_kill_deadline_utc = fuzzing deadline + host grace`, and
     `final_artifact_deadline_utc = force-kill deadline + artifact reserve`.

3. Run the backend without path collisions.
   - Start the long campaign from this template, substituting the resolved
     worker count and the repository's own contract, config, and corpus
     conventions:
     `timeout --preserve-status --signal=INT --kill-after=300s {{invariant_testing_fuzzer_timeout}}s recon fuzz . --contract CryticTester --test-mode assertion --workers <workers> --test-limit 18446744073709551615 --timeout {{invariant_testing_fuzzer_timeout}} --corpus-dir echidna --recon-corpus-dir recon-corpus`.
     Add `--config <path>` only when the repository's Recon/Echidna config
     requires it. Put cache or other `env KEY=value` assignments before the
     `timeout` executable, leaving the four supervisor arguments immediately
     before `recon fuzz`. Always pass `--workers` with the count resolved in
     step 2; do not reuse the bounded smoke's test limit of 1, `--seq-len`, or
     single-worker flags for the long campaign. The explicit maximum
     `--test-limit` is nonbinding and prevents Recon's default 50,000-call cap
     from ending the campaign before the wall-clock deadline.
   - Give recon-fuzzer distinct corpus, cache, log, raw-result, and reproducer
     paths under `{{artifact_dir}}/backends/recon-fuzzer`. Never let concurrent
     processes write the same path.
   - Record the backend's locally available version and exact shell-escaped
     command/config before launch. The host supervisor's `SIGINT` at the complete
     configured timeout is the authoritative fuzzing cutoff; its forced-kill
     grace is additional. Do not use `--foreground`, which would prevent the
     supervisor from signalling the backend process group.
   - Preserve raw backend output within normal artifact size and safety limits.
     Pass the exact configured timeout to Recon's `--timeout` for auditability
     and forward compatibility even when the locally installed Recon version
     relies on the host supervisor for enforcement. Do not start the backend
     unless the node has enough remaining time for the full timeout, the
     300-second shutdown grace, and the separate artifact-finalization reserve.

4. Finalize the backend record.
   - Write the result record even when the backend is unavailable, fails to
     start, crashes, or times out. The record must contain the backend name and
     version; exact command/config; worker count; start/end timestamps and
     terminal status; exit code or failure category; corpus, result, cache, and
     log paths; every discovered property failure and raw reproducer reference;
     and coverage metadata when the backend provides it. Also record the exact
     `configured_timeout_seconds`, `exact_command`, `start_timestamp`,
     `end_timestamp`, typed `termination_reason`, `campaign_outcome`, and
     `usable_results` fields used by runtime timing validation.
   - A later pass must never erase, downgrade, or overwrite an observed failure.
   - Finalize the backend record before deduplicating failures. Preserve the
     originating backend and raw record reference on every pre-deduplication
     failure and preserve all contributing backend provenance on the final
     deduplicated finding.
   - On every property-derived finding, put the exact failures it deduplicates
     in a non-empty top-level `contributing_backend_failures` array. Across all
     property-derived findings, these arrays must partition every
     property-derived failure from the sibling backend result records exactly
     once: do not omit a failure or claim it in more than one finding. For the
     shipped single-backend campaign, use each failure's exact `id` string. In
     a project-owned multi-backend campaign, a plain ID is valid only when it is
     unique across every sibling result record; otherwise use
     `{"fuzzer_backend":"<backend>","failure_id":"<id>"}` to disambiguate it.
   - Put `deduplication.pre_dedup_count` on every property-derived finding and
     set it to the number of entries in that finding's
     `contributing_backend_failures`. Every contributed failure's
     `property_ids` must be a subset of the finding's `property_ids`, and the
     finding's `property_ids` must be the exact union across those contributed
     failures. Never borrow a property from a failure assigned to another
     finding.
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
   - `complete`: recon-fuzzer ran through the full configured fuzzing interval;
     the supervisor's expected `SIGINT` at that deadline counts as its expected
     terminal state.
   - `partial`: recon-fuzzer produced usable results but ended early, crashed,
     or timed out before its expected terminal state.
   - `blocked`: recon-fuzzer produced no usable results.
   - Use `termination_reason=configured-timeout` only after the full interval.
     Use exactly one of `test-limit`, `process-exit`, `launch-error`, or
     `host-force-kill` for other terminal conditions. An early run with usable
     results is `partial`; a run without usable results is `blocked`. A partial
     campaign must keep every usable finding and clearly report the early
     termination. Record backend start/end timestamps so elapsed time is
     computed from evidence rather than trusted from an authored duration.
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
     cause. The `contributing_backend_failures` arrays provide the separately
     validated deduplication partition.

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
  "configured_timeout_seconds": 3600,
  "exact_command": "timeout --preserve-status --signal=INT --kill-after=300s 3600s recon fuzz . --contract CryticTester --test-mode assertion --workers 32 --test-limit 18446744073709551615 --timeout 3600 --corpus-dir echidna --recon-corpus-dir recon-corpus",
  "start_timestamp": "2026-01-01T00:00:00Z",
  "end_timestamp": "2026-01-01T01:00:00Z",
  "termination_reason": "configured-timeout",
  "campaign_outcome": "complete",
  "usable_results": true,
  "failures": [
    {
      "id": "failure-1",
      "status": "reproduced",
      "property_ids": ["property-1"]
    }
  ]
}
```

The timeout, worker count, command, timestamps, and outcome values above
illustrate the required shape only. Replace them with exact evidence from this
run; never copy the example values.

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

Every property-derived finding must include this accounting shape (the values
below are illustrative):

```json
{
  "id": "failure-1",
  "property_ids": ["property-1"],
  "contributing_backend_failures": ["failure-1", "failure-2"],
  "deduplication": {
    "pre_dedup_count": 2
  }
}
```

Compute the array and count from this run. Do not copy the example values.

If you changed files in the isolated workspace, save a patch at:

{{output_patch_path}}
