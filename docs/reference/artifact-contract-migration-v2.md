# Artifact contract migration inventory

This inventory records the compatibility decision for every artifact contract that existed before the strict-schema migration. A producer or persisted topology must use only the current IDs in `ARTIFACT_CONTRACT_IDS`; old IDs are not runtime aliases.

| Previous contract                     | Current decision                                 | Reason                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ultrafuzz/campaign-summary@1`        | Bumped to `ultrafuzz/campaign-summary@2`         | The formerly partial object now has a closed, versioned campaign summary shape.                                                                                                                                                                                                           |
| `ultrafuzz/coverage-goal@1`           | Bumped to `ultrafuzz/coverage-goal@2`            | Coverage goals now use exact scoped declaration counts, threshold-derived terminal states, and a defined below-target result for an empty denominator.                                                                                                                                    |
| `ultrafuzz/findings@1`                | Bumped to `ultrafuzz/findings@2`                 | Findings now require `ultrafuzz.finding.v2`, lowercase confidence, title-case `High`/`Medium`/`Low` severity values, and one canonical preliminary/final severity model.                                                                                                                  |
| `ultrafuzz/generated-tests@1`         | Replaced by `ultrafuzz/generated-tests@3`        | The v2 migration removed alternate list/provenance shapes; current runs accept only the v3 bundle contract.                                                                                                                                                                               |
| `ultrafuzz/generated-tests@2`         | Bumped to `ultrafuzz/generated-tests@3`          | The manifest now requires one bundle-level canonical `framework`, separate closed `generated_tests` and `support_files` arrays, bundle-wide path uniqueness, and authenticated singly linked text companion integrity. No framework or v2 manifest is inferred, converted, or backfilled. |
| `ultrafuzz/implemented-properties@1`  | Replaced by `ultrafuzz/implemented-properties@3` | Historical records without current selection metadata are no longer accepted by a current workflow.                                                                                                                                                                                       |
| `ultrafuzz/implemented-properties@2`  | Bumped to `ultrafuzz/implemented-properties@3`   | Selection, blocker, and implementation-path conditions are now part of the canonical closed document.                                                                                                                                                                                     |
| `ultrafuzz/invariant-campaign-plan@1` | Bumped to `ultrafuzz/invariant-campaign-plan@2`  | Campaign plans cross a breaking boundary to `ultrafuzz.invariant-campaign-plan.v2`; the v1 contract, schema registration, and historical reader are removed.                                                                                                                              |
| `ultrafuzz/invariant-ledger@1`        | Remains `@1`                                     | The declared evidence/inventory document and its version literal did not change; the checked-in schema now expresses the constraints the v1 runtime validator already enforced.                                                                                                           |
| `ultrafuzz/json-array@1`              | Removed                                          | A bare array never identified an artifact shape. Every former use now declares a named array contract such as `harness-repairs@1`, `strategy-detections@1`, `triaged-findings@1`, or `severity-classified-findings@1`.                                                                    |
| `ultrafuzz/json-object@1`             | Removed                                          | A bare object never identified an artifact shape. Every former use now declares a named workflow contract and schema.                                                                                                                                                                     |
| `ultrafuzz/nonempty-markdown@1`       | Remains `@1`                                     | Its canonical contract is still non-whitespace UTF-8 Markdown; no JSON shape exists to narrow.                                                                                                                                                                                            |
| `ultrafuzz/properties@1`              | Bumped to `ultrafuzz/properties@2`               | The canonical catalog now has closed properties, required stable sources, and strict versioned provenance.                                                                                                                                                                                |
| `ultrafuzz/property-campaign@1`       | Replaced by `ultrafuzz/property-campaign@3`      | Historical campaign records are unsupported; current producers must emit the fully typed v3 execution and evidence document.                                                                                                                                                              |
| `ultrafuzz/property-campaign@2`       | Bumped to `ultrafuzz/property-campaign@3`        | V3 binds the plan, implementation handoff, findings, and summary; types execution, coverage, per-property results, failures, and paths; and removes all v2 compatibility or conversion behavior.                                                                                          |
| `ultrafuzz/property-lens@1`           | Bumped to `ultrafuzz/property-lens@2`            | Lens properties are closed and must use the v2 version literal and lowercase priority enum.                                                                                                                                                                                               |
| `ultrafuzz/reference-expectations@1`  | Bumped to `ultrafuzz/reference-expectations@2`   | Expectation entries are closed, versioned, and uniquely identified.                                                                                                                                                                                                                       |
| `ultrafuzz/report@1`                  | Bumped to `ultrafuzz/report@2`                   | Terminal report metadata, findings, lifecycle, provenance, and coverage are now one closed canonical document.                                                                                                                                                                            |
| `ultrafuzz/report@2`                  | Bumped to `ultrafuzz/report@3`                   | Terminal reports can carry the exact typed coverage-evidence handoff and its unavailable variant without changing the v2 contract in place.                                                                                                                                               |
| `ultrafuzz/text@1`                    | Remains `@1`                                     | Its canonical contract is still arbitrary UTF-8 text, including empty text.                                                                                                                                                                                                               |
| `ultrafuzz/workspace-patch@1`         | Remains `@1`                                     | The manifest fields and v1 literal did not change; the checked-in schema now matches path and uniqueness rules the v1 runtime validator already enforced.                                                                                                                                 |

The migration also introduces named v1 contracts for previously generic workflow artifacts: admin/config boundary matrices, aggregation manifests, audited differential lanes, boundary recipes, coverage evidence, dependency scope matrices, differential plans/results/triage/repair/gap/report review, dynamic enumerator outputs/plans/provenance, externalized-state accounting, finding lifecycle ledgers, harness repairs, reference harnesses/manifests, selected strategies, semantic-red registries, strategy detections, triaged findings, and severity-classified findings. These are new identities rather than version bumps because no earlier canonical contract described their fields. Invariant campaign plans are the exception documented above: only their v2 contract and document identity remain supported.

Bare arrays are versioned by their contract and whole-document schema identity. Their items do not gain a synthetic `schema_version`; for example, each harness repair remains an ordinary record inside the versioned `ultrafuzz/harness-repairs@1` array.

The runtime-owned ZIP index formerly emitted as the unregistered
`ultrafuzz.report_bundle.v1` document is now the closed, registered
`ultrafuzz.report-bundle-manifest.v3` document. V3 removes the historical
pre-regeneration report-backup exclusion because current producers never create
those backups. Current readers and producers do
not convert historical bundle manifests.

## Persisted documents outside the artifact-contract registry

The artifact-contract table above is only one part of the breaking boundary.
The following runtime-owned, operator-facing, evaluation, and Modal documents
were also narrowed. These versions are exact identities, not aliases: a reader
for the current identity does not accept the previous spelling or infer missing
fields.

### Core run, CLI, topology, and dashboard documents

| Document                              | Previous identity                                                   | Current identity or decision                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node-attempt ledger                   | `1.0`                                                               | `ultrafuzz.node-attempt-ledger.v1`; the named identity accompanies the closed attempt, parent, reuse, digest, and outcome rules.    |
| Event record                          | `1.0`                                                               | `ultrafuzz.event-record.v2`; event variants are closed and validated as whole documents.                                            |
| Event query facade and index key      | Anonymous query/index projections                                   | `ultrafuzz.event-query-facade.v1` and `ultrafuzz.event-index-key.v1`.                                                               |
| Artifact manifest                     | `1.0`                                                               | `ultrafuzz.artifact-manifest.v3`; publications, digests, ownership, and contract metadata are required and closed.                  |
| Artifact verification                 | `ultrafuzz.artifact-verification.v1`                                | `ultrafuzz.artifact-verification.v2`; verification is bound to exact producer attempts and publications.                            |
| Invariant-suite manifest              | `ultrafuzz.invariant-suite-manifest.v1`                             | `ultrafuzz.invariant-suite-manifest.v2`; producer identity and exact file/tombstone projections are required.                       |
| Planned graph                         | `ultrafuzz.planned-graph.v3` with graph version `3`                 | `ultrafuzz.planned-graph.v4` with graph version `4`; retry limits are part of the closed graph shape.                               |
| Expanded graph                        | `urn:ultrafuzz:schema:topology:expanded-graph:3`, graph version `3` | `urn:ultrafuzz:schema:topology:expanded-graph:4` with graph version `4`; retry limits are part of the closed graph shape.           |
| Run layout                            | `1.0`                                                               | `ultrafuzz.run-layout.v2`; no historical layout reader remains.                                                                     |
| Source-run link                       | `1.0`                                                               | `ultrafuzz.source-run.v2`.                                                                                                          |
| Run plan                              | `1.0`                                                               | `ultrafuzz.run-plan.v2`.                                                                                                            |
| Run metadata                          | `1.0`                                                               | `ultrafuzz.run-metadata.v2`; accounting and graph authority are typed.                                                              |
| Config redactions                     | `1.0`                                                               | `ultrafuzz.config-redactions.v2`.                                                                                                   |
| Accounting                            | `2.0`                                                               | `ultrafuzz.accounting.v3`; incomplete pricing and current control-segment evidence are explicit.                                    |
| Accounting checkpoint                 | `1.0`                                                               | `ultrafuzz.accounting-checkpoint.v1`.                                                                                               |
| Run state                             | `1.1` / `ultrafuzz.state.v1`                                        | `ultrafuzz.run-state.v5`; old runs fail with an unsupported-version diagnostic.                                                     |
| Usage ledger                          | `1.0`                                                               | `ultrafuzz.usage-ledger.v1`.                                                                                                        |
| Release-validation report             | `ultrafuzz.release-validation.report.v1`                            | `ultrafuzz.release-validation.report.v2`.                                                                                           |
| Smithers workflow manifest            | `ultrafuzz.smithers.workflow.v3`                                    | `ultrafuzz.smithers.workflow.v4`; retry-chain and producer authority are required.                                                  |
| Smithers task metadata                | `ultrafuzz.smithers.task.v2`                                        | `ultrafuzz.smithers.task.v3`; retry-chain metadata is required.                                                                     |
| Resolved config                       | `ultrafuzz.config.v2` resolved JSON                                 | `ultrafuzz.resolved-config.v3`; retry policy is required in the closed persisted shape. Project TOML remains `ultrafuzz.config.v2`. |
| Reference cache manifest              | `1.0`                                                               | `ultrafuzz.reference-cache-manifest.v1`.                                                                                            |
| CLI result envelope                   | `ultrafuzz.cli.result.v1` and the eval-result envelope              | `ultrafuzz.cli.result.v2`; the separate eval-result compatibility envelope was removed.                                             |
| Dashboard audit                       | `1.0`                                                               | `ultrafuzz.dashboard.audit.v1`.                                                                                                     |
| Dashboard HTTP and SSE wire documents | Unversioned endpoint/event objects                                  | `ultrafuzz.dashboard.http.v1` and `ultrafuzz.dashboard.sse.v1`.                                                                     |
| Report-bundle manifest                | Unregistered `ultrafuzz.report_bundle.v1` and later partial forms   | `ultrafuzz.report-bundle-manifest.v3`, as detailed above.                                                                           |

The following existing identities retain their version but are now registered,
closed whole-document schemas with named semantic gates where needed:
`ultrafuzz.analysis-bundle.v1` and its component documents,
`ultrafuzz.invariant-evidence-ledger.v1`,
`ultrafuzz.invariant-source-proof.v1`,
`ultrafuzz.terminal-disposition.v1`, the invariant-suite baseline and handoff
documents, materialize/clean audit documents, lifecycle/control journals, and
runtime handoff/integrity documents. Retaining the literal means that the
already-declared canonical shape did not change; it does not create a loose or
historical reader.

The migration also introduces first canonical identities for
`ultrafuzz.trusted-cli.v1`, the registered
`urn:ultrafuzz:schema:artifacts:json-validator-preflight-success:1` envelope,
and `ultrafuzz.cli.public-run-state.v1`. These are new runtime/control evidence,
not renamed historical payloads.

### Evaluation and benchmark documents

| Document                           | Previous identity                                               | Current identity or decision                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evaluation suite                   | `ultrafuzz.eval.v1`                                             | `ultrafuzz.eval.v2`; suite inputs and dependency/model policy are closed.                                                                                                        |
| Evaluation run                     | `ultrafuzz.eval.run.v1`                                         | `ultrafuzz.eval.run.v3`; current launch, report, telemetry, and scoring authority is required.                                                                                   |
| Run summary                        | Previously unversioned                                          | `ultrafuzz.eval.run-summary.v2`.                                                                                                                                                 |
| Finding score                      | `ultrafuzz.eval.finding-score.v1`                               | `ultrafuzz.eval.finding-score.v2`; exact verified report authority is required.                                                                                                  |
| Score summary                      | `ultrafuzz.eval.score-summary.v1`                               | `ultrafuzz.eval.score-summary.v2`; rows and counts are bound to exact scoring authority.                                                                                         |
| Review-queue item                  | `ultrafuzz.eval.review-queue-item.v1`                           | `ultrafuzz.eval.review-queue-item.v2`; exact report and judge authority is required.                                                                                             |
| Evaluation matrix                  | Bare/unregistered matrix                                        | Whole-document schema `urn:ultrafuzz:schema:evals:matrix:2`.                                                                                                                     |
| Evaluation history                 | `ultrafuzz.eval.history.v1`                                     | `ultrafuzz.eval.history.v2`.                                                                                                                                                     |
| History observation                | `ultrafuzz.eval.history.observation.v5` and earlier generations | `ultrafuzz.eval.history.observation.v6`; v1-v5 readers were removed.                                                                                                             |
| Benchmark lanes                    | `ultrafuzz.benchmark.lanes.v1`                                  | `ultrafuzz.benchmark.lanes.v2`, registered as `urn:ultrafuzz:schema:evals:benchmark-lanes:2`.                                                                                    |
| Public diagnostics                 | `ultrafuzz.modal.public-eval-diagnostics.v1`                    | `ultrafuzz.modal.public-eval-diagnostics.v2`; the v1 reader was removed.                                                                                                         |
| Benchmark-analysis source/manifest | Unregistered or generic analysis shapes                         | `ultrafuzz.eval.benchmark-source-manifest.v1` and `ultrafuzz.eval.benchmark-analysis-manifest.v1`, with typed adjudication, finding, cluster, credit, and provenance companions. |
| EVMBench catalog                   | `ultrafuzz.evmbench.catalog.v1`                                 | `ultrafuzz.evmbench.catalog.v2`.                                                                                                                                                 |
| EVMBench lock                      | `ultrafuzz.evmbench.lock.v1`                                    | `ultrafuzz.evmbench.lock.v2`.                                                                                                                                                    |
| EVMBench profile                   | `ultrafuzz.evmbench.profile.v1`                                 | `ultrafuzz.evmbench.profile.v2`.                                                                                                                                                 |
| EVMBench result                    | `ultrafuzz.evmbench.result.v1`                                  | `ultrafuzz.evmbench.result.v2`, returned through the shared CLI v2 envelope.                                                                                                     |

Retained evaluation documents for ground truth, publication/status,
recovery-equivalence, telemetry cursors, automatic history publication, and
benchmark provenance now have registered closed schemas. New typed analysis
documents include adjudication handoff, finding manifest, instance clusters,
ground-truth credits, benchmark provenance, benchmark source/analysis
manifests, and the embedded verified-report authority used by scoring. Their v1
identities are first canonical versions rather than compatibility aliases.

### Modal documents

| Document                | Previous identity                                                    | Current identity or decision                                                                        |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Benchmark configuration | `ultrafuzz.modal.benchmark.v1`                                       | `ultrafuzz.modal.benchmark.v2`; the benchmark matrix, source, model, and control policy are closed. |
| Public benchmark bundle | `ultrafuzz.modal.public-benchmark-bundle.v4` plus a legacy v3 reader | `ultrafuzz.modal.public-benchmark-bundle.v5` only.                                                  |
| Node result             | v1 and v2 accepted                                                   | `ultrafuzz.modal.node-result.v2` only.                                                              |
| Worker status/result    | Separate worker-status compatibility shape plus result v2            | `ultrafuzz.modal.worker-result.v2`; partial and terminal states share one closed contract.          |
| Launch state            | `ultrafuzz.modal.launch-state.v3` with v1/v2 migration readers       | `ultrafuzz.modal.launch-state.v3` remains current, but the v1/v2 migration path is removed.         |

The retained Modal node input, dependency manifest, pinned source proof,
worker lineage, node checkpoint/index/restore, node-worker error, recovery state
and lifecycle, and result documents now have registered whole-document schemas.
New control evidence uses
`ultrafuzz.modal.benchmark-control-manifest.v1`,
`ultrafuzz.modal.smoke-checkpoint.v1`,
`ultrafuzz.modal.smoke-completion.v1`, and
`ultrafuzz.modal.smoke-result.v1`.

## Removed readers and repair paths

There is no historical-run fallback for the following removed formats:

- artifact reconciliation grace state and any post-completion artifact
  synthesis or copying path;
- findings aliases, missing versions, numeric confidence conversion,
  scalar-to-array conversion, and `final_severity` compatibility;
- config `1.0` and alternate resolved-config version spellings;
- CLI result v1 and the separate eval-result v1 envelope;
- Modal launch-state v1/v2, worker-status, node-result v1, and public bundle
  v3/v4 readers;
- evaluation history v1, observation v1-v5, public diagnostics v1, and scoring
  aliases or inferred report authority.

Current producers must emit the current identity and exact canonical bytes.
Readers reject unsupported versions; they do not normalize an old version into
the new one. Agent-authored correction is available only before the original
agent session returns and is performed by the agent after running
`ultrafuzz json validate`, never by a reader or synchronization fallback.
