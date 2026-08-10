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
   - Write `campaign-plan.json` before starting the backend with
     `schema_version: "ultrafuzz.invariant-campaign-plan.v1"`, positive integer
     `available_vcpus`, `workers`, and `configured_budget_seconds`, RFC 3339
     `deadline`, non-negative `finalization_reserve_seconds`, `backend` with
     fixed `name: "recon"` and nullable `version`, a typed `command_plan`, and
     exact `paths` for `corpus`, `cache`, `log`, `raw_results`, and
     `reproducers`.

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
     start, crashes, or times out. Use only
     `ultrafuzz.property-campaign.v3`; never emit or convert a historical
     campaign shape. The record must contain the four authenticated artifact
     references; backend name and nullable version; closed execution, path,
     and coverage objects; one result row for every implemented property; and
     every observed failure with its raw and deterministic-or-blocked
     reproducer evidence.
   - Set `execution.status` to exactly one of `complete`, `partial`, `blocked`,
     `failed`, `timed-out`, or `unavailable`. `usable_results` is true only
     when results may be consumed. A complete execution has a non-null start,
     exit code `0`, and null failure. A partial execution has usable results,
     a non-null start, and typed failure evidence. A blocked or unavailable
     execution did not start and has null start and exit code. A timed-out
     execution has a non-null start, null exit code, and
     `deadline-exceeded` failure evidence. `finished_at` is always the record
     finalization time, including when the backend never started.
   - Copy `fuzzer_backend`, `backend_version`, `execution.workers`,
     `execution.deadline`, `execution.command`, and all five `paths` values
     exactly from `campaign-plan.json`. `execution.command` is the sole
     `command_plan` row whose phase is `campaign`. Record the actual config
     path or null in `execution.config_path`.
   - Set coverage to `reported` only when at least one typed metric is
     available. Each metric has a unique `name`, non-negative `value`, one of
     `count`, `ratio`, `percent`, `seconds`, `bytes`, or
     `executions-per-second`, and an exact `source_ref`. Otherwise use
     `status: "unavailable"`, an empty metrics array, and a non-empty reason.
   - Make `evidence_files` the exact file manifest for the campaign's durable
     evidence. Include `paths.log` whenever `execution.started_at` is non-null;
     include `paths.raw_results` whenever results are usable, coverage is
     reported, or failures are present; and include every coverage
     `source_ref`, property-result `evidence_refs` entry, failure
     `raw_reproducer_ref`, and non-null `deterministic_reproducer_ref`. List each
     unique required path exactly once and no other path. Each closed entry has
     only `path`, positive `size_bytes`, and the lowercase SHA-256 of the exact
     bytes. The manifest has at most 4096 files, each file is at most 16 MiB,
     and their aggregate is at most 64 MiB. Operational corpus, cache, and
     reproducer directories are not implicitly published; name every file that
     must survive through one of the typed references above.
   - Emit exactly one `property_results` row for every record whose status is
     `implemented` in `implemented-properties.json`, and no other property.
     Use `passed`, `failed`, `inconclusive`, or `not-executed`; make
     `failure_ids` exactly the campaign failures naming that property. Failed
     rows require failures and a null reason, passed rows require no failures
     and a null reason, and inconclusive/not-executed rows require no failures
     and a non-empty reason. Coverage metric names must resolve to the sibling
     coverage object.
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
   - Every backend failure has a unique ID, a status of `reproduced` or
     `blocked-unreproduced`, a `property_ids` array, nullable entrypoint,
     sequence and precondition-evidence arrays, and a non-empty raw reproducer
     reference. When an implemented invariant property caused a failure, copy
     its exact canonical ID from `implemented-properties.json` into a
     non-empty `property_ids` array. Use an empty array for setup, harness, and
     other failures that did not originate from a catalog property. Never
     invent or silently drop a property reference: a finding may only name a
     property that some backend failure reported.
   - A reproduced failure requires a non-null deterministic reproducer path
     and a null blocker. A blocked-unreproduced failure requires a null
     deterministic path and a non-empty blocker. A campaign with
     `usable_results: false` cannot publish observed failures.
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
     cause. The `contributing_backend_failures` arrays provide the separately
     validated deduplication partition.

## Required Outputs

Write the campaign plan to:

{{artifact_dir}}/campaign-plan.json

Write the backend-neutral structured summary to:

{{artifact_dir}}/campaign-summary.json

Set its `schema_version` to `"ultrafuzz.campaign-summary.v2"`. Include exact
keys `outcome`, non-empty `implemented_property_suite_refs`,
`campaign_plan_ref`, `backend_results`, `finding_refs`, `reproducer_refs`, and
`failure_counts`. Each backend row has `fuzzer_backend`, `status`, and
`result_ref`; each reproducer row has `finding_id`, nullable `path`, and nullable
`blocker`.

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

Use the current closed backend-record shape below. The values illustrate a
complete campaign with one reproduced property failure; replace every value
with this run's evidence while retaining every field:

```json
{
  "schema_version": "ultrafuzz.property-campaign.v3",
  "campaign_plan_ref": "campaign-plan.json",
  "implemented_properties_ref": "implemented-properties.json",
  "findings_ref": "findings.json",
  "campaign_summary_ref": "campaign-summary.json",
  "fuzzer_backend": "recon",
  "backend_version": "0.1.0",
  "execution": {
    "status": "complete",
    "usable_results": true,
    "command": "recon fuzz . --contract CryticTester --test-mode assertion --workers 8 --corpus-dir echidna --recon-corpus-dir recon-corpus",
    "config_path": null,
    "workers": 8,
    "started_at": "2026-01-01T00:00:00Z",
    "finished_at": "2026-01-01T00:55:00Z",
    "deadline": "2026-01-01T01:00:00Z",
    "exit_code": 0,
    "failure": null
  },
  "paths": {
    "corpus": "backends/recon-fuzzer/corpus",
    "cache": "backends/recon-fuzzer/cache",
    "log": "backends/recon-fuzzer/run.log",
    "raw_results": "backends/recon-fuzzer/results.json",
    "reproducers": "backends/recon-fuzzer/reproducers"
  },
  "evidence_files": [
    {
      "path": "backends/recon-fuzzer/run.log",
      "size_bytes": 1024,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    {
      "path": "backends/recon-fuzzer/results.json",
      "size_bytes": 2048,
      "sha256": "1111111111111111111111111111111111111111111111111111111111111111"
    },
    {
      "path": "backends/recon-fuzzer/reproducers/failure-1.t.sol",
      "size_bytes": 4096,
      "sha256": "2222222222222222222222222222222222222222222222222222222222222222"
    }
  ],
  "coverage": {
    "status": "reported",
    "metrics": [
      {
        "name": "executions",
        "value": 10000,
        "unit": "count",
        "source_ref": "backends/recon-fuzzer/results.json"
      }
    ],
    "unavailable_reason": null
  },
  "property_results": [
    {
      "property_id": "property-1",
      "status": "failed",
      "failure_ids": ["failure-1"],
      "coverage_metric_names": ["executions"],
      "evidence_refs": ["backends/recon-fuzzer/results.json"],
      "reason": null
    }
  ],
  "failures": [
    {
      "id": "failure-1",
      "status": "reproduced",
      "property_ids": ["property-1"],
      "entrypoint": "handler_deposit(uint256)",
      "sequence": ["handler_deposit(1)"],
      "precondition_evidence": ["deposit amount was bounded to the available balance"],
      "raw_reproducer_ref": "backends/recon-fuzzer/results.json",
      "deterministic_reproducer_ref": "backends/recon-fuzzer/reproducers/failure-1.t.sol",
      "reproduction_blocker": null
    }
  ]
}
```

The four reference fields must retain the exact declared artifact paths shown
above. The backend fields and record paths must match the authenticated plan;
the implementation reference must name the authenticated ancestor handoff;
and the findings and summary references must name the authenticated siblings.
The campaign summary's sole backend row must use `recon`, the execution's exact
status, and `recon-fuzzer-results.json`. Each deduplicated property finding must
reuse the ID of one of the failures it covers and carry every property ID those
failures reported and no others. Do not emit one finding per counterexample: a
fuzzer reports the same violation many times, and the backend record already
preserves every one of them. References to an unknown or non-implemented
canonical property fail artifact validation.
`evidence_files` has no redundant role field: the exact status-dependent and
explicit reference set above is the authority. The verifier captures each
listed regular, non-hard-linked file once, checks its size and digest, and uses
that same immutable byte snapshot for durable publication and marker digests.

Write generated-test and reproducer records to:

{{artifact_dir}}/generated-tests.json

Write structured findings to:

{{output_findings_path}}

The findings file must be a JSON array. Use an empty array only when the
backend record is finalized and the campaign observed no fuzzer failures or
deterministic reproducers.

Finalize all interdependent JSON artifacts, then run every exact
`ultrafuzz json validate` command displayed in the output contract. Correct an
exit-1 artifact and rerun its command; after any later edit, rerun it again.
Finish only after every displayed command exits 0. Do not repair, normalize,
or convert an older campaign document to make validation pass.

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
