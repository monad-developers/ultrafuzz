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
     are both additional to, not part of, the configured fuzzer timeout. Copy
     the exact `Finalization reserve` value from the appended Topology Runtime
     Context; do not choose or reduce this reserve yourself.
   - The complete configured fuzzer timeout belongs to the one campaign; do not
     divide it into per-backend slices.
   - Before launch, write a preliminary `campaign-plan.json` using the exact
     pinned `{{schema_path}}/invariant-campaign-plan-v2.schema.json`. The pinned
     schema alone defines member names, types, and requiredness. Record the
     plan's CPU, worker, budget, deadline, reserve, backend, command-plan, and
     path evidence. Also record
     `configured_fuzzer_timeout_seconds`, `recon_internal_timeout_seconds`,
     `recon_test_limit` (as a decimal string), `host_soft_timeout_seconds`,
     `host_force_kill_grace_seconds`,
     `artifact_finalization_reserve_seconds`, and the exact campaign command in
     both the campaign-phase command-plan row and
     `backend.exact_shell_escaped_command`. Record the supervised launch
     timestamp immediately before starting the process, then finalize the plan
     with `backend_started_at`,
     `fuzzing_deadline_utc = backend_started_at + configured timeout`,
     `force_kill_deadline_utc = fuzzing deadline + host grace`, and
     `final_artifact_deadline_utc = force-kill deadline + artifact reserve`.
     Set the plan's legacy join fields `configured_budget_seconds`, `deadline`,
     and `finalization_reserve_seconds` to the post-smoke supervised budget
     (fuzzer timeout plus shutdown grace plus artifact reserve), final artifact
     deadline, and exact artifact reserve respectively. These runtime-value
     relationships are contextual requirements beyond JSON Schema.

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
     command/config before launch. The host supervisor's `SIGINT` at the
     complete configured timeout is the authoritative fuzzing cutoff; its
     forced-kill grace is additional. Do not use `--foreground`, which would
     prevent the supervisor from signalling the backend process group.
   - Preserve raw backend output within normal artifact size and safety limits.
     Pass the exact configured timeout to Recon's `--timeout` for auditability
     and forward compatibility even when the locally installed Recon version
     relies on the host supervisor for enforcement. Do not start the backend
     unless the node has enough remaining time for the full timeout, the
     300-second shutdown grace, and the separate artifact-finalization reserve.

4. Finalize the backend record.
   - Write the result record even when the backend is unavailable, fails to
     start, crashes, or times out. Use the exact pinned
     `{{schema_path}}/property-campaign.schema.json`; never emit or convert a
     historical campaign document. Bind its artifact references, backend
     identity, execution record, paths, coverage, implemented-property results,
     and every observed failure to the authenticated plan and sibling
     artifacts as described below.
   - Choose the schema-defined execution variant that exactly matches whether
     the backend started, how it terminated, and whether its results are
     consumable. Record actual lifecycle timestamps, exit evidence, and failure
     evidence; the finish time is the record finalization time even when the
     backend never started.
   - Copy every plan-owned backend identity, version, execution worker/deadline
     setting, campaign command, and operational path exactly from
     `campaign-plan.json`. Bind the executed campaign command to the plan's
     campaign-phase command and record the actual configuration-path outcome
     through the pinned result schema's applicable variant.
   - For a v2 campaign plan, also populate the result's timeout-evidence fields:
     `configured_timeout_seconds`, `exact_command`, `start_timestamp`,
     `end_timestamp`, typed `termination_reason`, `campaign_outcome`, and
     `usable_results`. Copy `exact_command` from the plan and the nested
     execution command, copy `start_timestamp` from `backend_started_at` and
     `execution.started_at`, and bind `end_timestamp` to
     `execution.finished_at`. These duplicate joins are intentional evidence
     checks; their values must agree exactly.
   - Populate the schema-defined coverage record only from observed metrics and
     bind every metric to its exact evidence source. When coverage is not
     available, select the schema's unavailable variant and record the actual
     reason.
   - Make `evidence_files` the exact file manifest for the campaign's durable
     evidence. Include `paths.log` whenever `execution.started_at` is present;
     include `paths.raw_results` whenever results are usable, coverage is
     reported, or failures are present; and include every coverage
     `source_ref`, property-result `evidence_refs` entry, failure
     `raw_reproducer_ref`, and every present `deterministic_reproducer_ref`. List each
     unique required path exactly once and no other path. Record each file's
     exact immutable bytes, size, and digest as required by the pinned schema.
     Operational corpus, cache, and reproducer directories are not implicitly
     published; name every file that must survive through one of the typed
     references above.
   - Emit exactly one schema-defined property-result row for every implemented
     record in `implemented-properties.json`, and no other property. Its status,
     failure references, reason, coverage references, and evidence must reflect
     this run exactly; every referenced failure and metric must resolve within
     the sibling campaign record.
   - A later pass must never erase, downgrade, or overwrite an observed failure.
   - Finalize the backend record before deduplicating failures. Preserve the
     originating backend and raw record reference on every pre-deduplication
     failure and preserve all contributing backend provenance on the final
     deduplicated finding.
   - On every property-derived finding, put the exact failures it deduplicates
     in the schema-defined `contributing_backend_failures` collection. Across
     all property-derived findings, these collections must partition every
     property-derived failure from the sibling backend result records exactly
     once: do not omit a failure or claim it in more than one finding. Every
     entry binds the exact backend identity, failure ID, and campaign-result
     artifact reference.
     Copy `fuzzer_backend` and `failure_id` from the exact sibling campaign
     result containing the failure. Set `raw_result_ref` to that authenticated
     campaign result artifact (for this node, `recon-fuzzer-results.json`), not
     to the backend-internal `paths.raw_results` evidence file. Plain failure ID
     strings and omitted `raw_result_ref` values are invalid.
   - Set each property-derived finding's `id` to the exact `failure_id` of one
     entry in that finding's own `contributing_backend_failures`. When a finding
     deduplicates several failures, pick one of them as the representative and
     reuse its ID verbatim. A finding may not invent a new ID, reuse an ID from
     another finding's partition, or use a descriptive slug.
   - Put `deduplication.pre_dedup_count` on every property-derived finding and
     set it to the number of entries in that finding's
     `contributing_backend_failures`. Every contributed failure's
     `property_ids` must be a subset of the finding's `property_ids`, and the
     finding's `property_ids` must be the exact union across those contributed
     failures. Never borrow a property from a failure assigned to another
     finding.
   - Put backend provenance directly on every backend-derived object in
     `findings.json`, using the schema-defined representation for the number of
     contributing siblings. Copy every backend identity exactly from those
     siblings, keep multiple identities unique and sorted, and claim no backend
     when none contributed.
   - Give every backend failure a unique identity and preserve its exact raw
     reproducer, execution classification, entrypoint, sequence, precondition,
     and deterministic-or-blocked evidence. When an implemented invariant
     property caused a failure, copy its exact canonical ID from
     `implemented-properties.json`. Associate no property IDs with setup,
     harness, and other failures that did not originate from a catalog
     property. Never
     invent or silently drop a property reference: a finding may only name a
     property that some backend failure reported.
   - Bind deterministic reproducer evidence or the actual reproduction blocker
     according to the pinned failure variant. A campaign whose results are not
     usable cannot publish observed failures.
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
     reached a test limit, or was force-killed before its expected terminal
     state.
   - `blocked`: recon-fuzzer produced no usable results.
   - Use `termination_reason=configured-timeout` only after the full interval.
     Use exactly one of `test-limit`, `process-exit`, `launch-error`, or
     `host-force-kill` for other terminal conditions. An early run with usable
     results is `partial`; a run without usable results is `blocked`.
   - Choose the pinned summary schema's outcome variant that matches the
     finalized backend execution and result usability. Preserve every usable
     finding when execution ended early, crashed, or timed out, and clearly
     report that termination. Record backend start/end timestamps so the
     recorded budget can be checked against the campaign that actually ran.
   - Whenever the chosen summary variant requires a termination or blocker
     explanation, copy the actual reason from this run. Never synthesize a
     generic fallback or infer a different reason from findings; downstream
     reporting copies this authoritative reason exactly.
   - Populate the schema-admitted summary references and backend status from
     the exact sibling artifacts. Calculate the schema-defined pre-deduplication
     count from every failure in every sibling backend result, including
     failures without property IDs. Calculate the post-deduplication count from
     every object in `findings.json`, including non-property findings. These
     artifact-population counts make omissions visible but do not prove that
     every finding is a distinct root cause; the contributed-backend-failure
     records provide the separately validated deduplication partition.

## Required Outputs

Write the campaign plan to:

{{artifact_dir}}/campaign-plan.json

Its exact pinned schema is
`{{schema_path}}/invariant-campaign-plan-v2.schema.json`.

Write the backend-neutral structured summary to:

{{artifact_dir}}/campaign-summary.json

Read the exact pinned schema at
`{{schema_path}}/campaign-summary.schema.json`; it alone defines the JSON
version, fields, types, enums, required members, and empty forms. Bind the
summary outcome to the finalized backend state, preserve the authenticated
implemented-property suite and campaign-plan references, and derive backend,
finding, reproducer, and failure-count evidence from this run's sibling
artifacts. The pre-deduplication count is the complete sibling backend failure
population; the post-deduplication count is the complete findings population,
as defined above.

Write the backend-neutral campaign report to:

{{artifact_dir}}/campaign-report.md

Write the recon-fuzzer result record to:

{{artifact_dir}}/recon-fuzzer-results.json

Read the exact pinned schema at
`{{schema_path}}/property-campaign.schema.json`; it alone defines the JSON
version, fields, types, enums, required members, and empty forms. Populate it
only from this run's finalized Recon execution, plan, implementation handoff,
findings, summary, and immutable evidence files.

The campaign-plan, implemented-properties, findings, and campaign-summary
references must retain their exact declared artifact paths. The backend fields
and record paths must match the authenticated plan;
the implementation reference must name the authenticated ancestor handoff;
and the findings and summary references must name the authenticated siblings.
Bind the summary's backend evidence to the only configured backend, preserving
the Recon identity, exact execution status, and authenticated result-artifact
reference. Each deduplicated property finding must reuse the ID of one of the
failures it covers and carry every property ID those failures reported and no
others. Do not emit one finding per counterexample: a fuzzer reports the same
violation many times, and the backend record already preserves every one of
them. References to an unknown or non-implemented canonical property fail
artifact validation. The exact durable-evidence reference set above is
authoritative. The verifier captures each listed regular, non-hard-linked file
once, checks its size and digest, and uses that same immutable byte snapshot for
durable publication and marker digests.

Write generated-test and reproducer records to:

{{artifact_dir}}/generated-tests.json

Read the exact pinned schema at `{{schema_path}}/generated-tests.schema.json`.
Classify runnable reproducers separately from their non-runnable imported
support, bind every entry to its exact mirrored companion, and use the
schema-defined empty bundle only when no runnable reproducer was produced.

Write structured findings to:

{{output_findings_path}}

Read the exact pinned schema at `{{schema_path}}/findings.schema.json`. Use its
schema-defined empty form only when the backend record is finalized and the
campaign observed no fuzzer failures or deterministic reproducers.

Finalize all interdependent JSON artifacts, then run every exact
`ultrafuzz json validate` command displayed in the output contract. Correct an
exit-1 artifact and rerun its command; after any later edit, rerun it again.
Finish only after every displayed command exits 0. Do not repair, normalize,
or convert an older campaign document to make validation pass.

For every property-derived finding, compute the contributing backend-failure
partition and pre-deduplication count from this run. Its finding ID must be the
exact failure ID of one entry in its own partition. The property-ID union,
backend identity, raw-result reference, and count must agree with those exact
contributing failures. This cross-artifact accounting is contextual validation,
not a second JSON shape definition.

If you changed files in the isolated workspace, save a patch at:

{{output_patch_path}}
