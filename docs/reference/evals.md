# Eval Suites

Ultrafuzz eval suites benchmark the fuzzing pipeline against targets with
known ground-truth bugs, with a **provider-agnostic `EvalReporter`
abstraction** and **first-class node telemetry**: every node of the
`topology.yml` DAG (lifecycle, heartbeats, and intermediary artifacts —
reports, markdown, JSON) is streamed to Braintrust as spans, live during a run
and replayable after it.

## Configuration split

Rule of thumb: **`ultrafuzz.toml` answers "where does this run and how does it
authenticate in this environment"; the eval YAML answers "what experiment are
we running and how is it graded."** The YAML is committable and portable
across providers; the TOML is per-environment and names credential environment
variables, never inline secret values.

### `ultrafuzz.toml` — the `[eval]` section

```toml
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"   # suite used when --suite is omitted
ground_truth_root = "/secure/eval-ground-truth"    # machine-specific, MUST resolve outside the repo
provider = "braintrust"                            # active reporter: braintrust | none

[eval.providers.braintrust]
api_key_env = "BRAINTRUST_API_KEY"
project = "ultrafuzz-evals"
```

- `provider` selects Braintrust reporting or disables cloud reporting with
  `none`; `[eval.providers.*]` entries are connection profiles.
- Precedence: CLI flag (`--provider`, `--suite`) > env
  (`ULTRAFUZZ_EVAL_PROVIDER`, `ULTRAFUZZ_EVAL_CONFIG`) > `ultrafuzz.toml`.
- `ground_truth_root` is machine-specific and security-sensitive: ground truth
  must live **outside** the repository; suite targets reference files relative
  to this root. Absolute entries, traversal, symlinks, non-regular files, and
  files larger than 1 MiB are rejected.
- The built-in reporter binds credentials to the canonical
  `BRAINTRUST_API_KEY` name and canonical HTTPS origin. Requests reject
  redirects, time out after 30 seconds, and accept at most 1 MiB of response
  data.
- A self-hosted endpoint must be an HTTPS origin and requires an exact,
  operator-owned environment acknowledgement. Set
  `ULTRAFUZZ_EVAL_BRAINTRUST_TRUSTED_ENDPOINT` to the same origin as the
  configured `endpoint`. Repository configuration alone cannot redirect a
  provider credential.
- Validation: an unknown `provider` or a missing `[eval.providers.<name>]`
  profile is a config error at `eval plan` time; a missing env var named by
  `api_key_env` is an error at publish time only, so local-only runs with
  `provider = "none"` keep working offline.

### Eval YAML — the experiment definition

See `.ultrafuzz/evals/bug-finding.yml` for the default suite. It defines model
profiles, targets (repo/ref/ground truth/sensitivity), variants, trial counts,
grading metrics, and the `reporting:` telemetry policy. Nothing in the YAML
names a provider, an endpoint, or an env var.

The `reporting.artifacts` policy is exact-path allowlist-by-default with a size
cap and a sensitivity gate: `sensitivity: private` targets default to
`manifest-only` — the provider sees the DAG, timings, findings counts, and file
names/hashes, while payloads stay on disk unless the suite explicitly opts
into `mode: upload`. Before an allowlisted payload is sent, its manifest and
path containment, regular-file status, size, and SHA-256 digest are checked.

### Held-out benchmark paths

A benchmark that ships a reference solution beside the code under test would
otherwise hand the run its own answer key. A target may withhold those paths:

```yaml
targets:
  - id: target
    repo: "https://github.com/scfuzzbench/aave-v4-scfuzzbench"
    ref: "edd6c82721512540c8c90e7a36a4a8e19fd7bdf3"
    ground_truth: aave-v4-scfuzzbench/findings.yml
    held_out_paths: ["tests/recon"]
```

Materializing a pinned target rewrites the checkout to a **parentless** revision
that never contained the declared paths, then destroys the benchmark commit and
the withheld blobs.

A commit is required rather than a dirty worktree, because every node workspace
is a Git worktree of the pinned branch and would otherwise restore the files.
Keeping the benchmark commit as a parent is equally unsafe — `git show
HEAD^:tests/recon/Properties.sol` would hand the answer key straight back — so
the rewritten revision has no parents and the original objects are pruned along
with the reflog. The single-revision isolation invariants are unchanged:
`revision_count` and `commit_object_count` stay `1`.

The source proof records what was withheld:

```json
"held_out": {
  "source_commit": "edd6c82721512540c8c90e7a36a4a8e19fd7bdf3",
  "source_tree": "3b3910d0657e4a639888ccae45822af680de6ef6",
  "commit": "ac548733fd9c36cf9a32284a653a6429c089abfa",
  "tree": "5e9c604d9474da946403369f652425880babee78",
  "paths": ["tests/recon"],
  "entries": [{ "path": "tests/recon/Properties.sol", "blob": "...", "size": 13722 }]
}
```

`commit` and `tree` are the revision the run actually sees. `source_commit` and
`source_tree` are provenance only — those objects are deliberately absent from
the repository, so a reviewer can see which bytes were withheld without the run
being able to read them back.

Verification proves absence rather than diffing, since there is no parent left
to diff against: HEAD must be the recorded parentless revision, none of the
declared paths may be tracked, none of the recorded blobs may exist in the
object store, the declaration must no longer match anything, and the benchmark
commit must be unreadable. A launch is refused outright if a held-out path is
still present in the checkout.

Ground truth is written against the benchmark commit, so it keeps binding
`source_commit` rather than the hold-out revision.

Declaring a path that matches nothing fails closed rather than silently
running without the hold-out. An agent that writes a similar file inside its
own workspace is a legitimate result and stays allowed; only the materialized
input is constrained.

### Recovery equivalence

Each suite may declare how much model work a recovered row may repeat:

```yaml
recovery_equivalence:
  max_repeated_model_executions: 1
  aggregate_non_comparable: separate # include | exclude | separate
  publication: comparable # comparable | clean
```

Ultrafuzz derives the row classification from the append-only node-attempt
ledger and durable controller submissions. Normal retries within one workflow
execution do not count as recovery re-execution. Re-running the same
model-backed strategy attempt in a later controller generation does. The
persisted row records unique and repeated model executions, infrastructure-only,
model-work, and no-progress recovery generations, plus a reason whenever the
evidence is non-comparable.

`aggregate_non_comparable` controls the primary variant aggregates. `include`
keeps every row, `exclude` removes non-comparable rows while reporting the
excluded count, and `separate` additionally emits dedicated non-comparable
variant aggregates. Individual rows and classification totals always remain
visible. `publication: comparable` rejects non-comparable evidence;
`publication: clean` also rejects otherwise comparable recovered rows. Public
benchmark history requires clean rows.

The classification is captured once in `runs.jsonl` and reused by later
scoring, reporting, and publication. Re-scoring therefore cannot reinterpret
the execution exposure after the fact. Missing, malformed, oversized, or
graph-inconsistent execution ledgers fail closed as non-comparable.

## Architecture

Reporting is **event-sourced from the run journal**, never wired inline into
the workflow runner:

- `packages/evals/src/reporter.ts` defines the `EvalReporter` interface.
  Providers are pure observers/exporters; ultrafuzz owns the loop
  (plan → run → score → summarize, all writing local artifacts: `matrix.json`,
  `runs.jsonl`, `scores.jsonl`, `summary.json`). Adding a provider is one file
  implementing the interface plus one `[eval.providers.<name>]` block.
- `packages/evals/src/node-telemetry.ts` is the pump: a cursor over
  `events.jsonl` + `state.json` + artifact manifests, driven from the eval
  driver's poll loop. The cursor (byte offset + `event_id` dedup ring +
  uploaded-artifact hashes) is persisted durably after delivery, so the driver
  can crash and resume without double-publishing, and reporter failures always
  degrade to warnings.
- `packages/evals/src/reporters/braintrust.ts` maps rows to a three-level span
  tree (row root → topology group → node attempt) with backdated
  `start`/`end` metrics. The reporter speaks the provider's REST API directly
  over `fetch` — `packages/runtime` never imports a provider SDK.
- Heartbeat liveness is bounded by the sync poll cadence: state transitions
  and partial artifacts appear within one poll interval. That is the correct
  trade for a detached orchestrator.

## Versioned lineage

Every new eval run records a versioned provenance block in `eval.json`:

- Candidate identity is resolved from the candidate checkout's exact commit,
  release tag when present, dirty status, and immutable local execution
  identity when available.
- Benchmark identity includes resolved target commits and clean-checkout state,
  ground-truth digests, model controls, trial budget, and a normalized
  execution-policy fingerprint. These controls produce the deterministic
  cohort fingerprint; tracked target modifications make it incomplete.
- Candidate-owned prompts, topology, strategies, and runtime configuration do
  not alter the cohort. Their `graph_fingerprint` and `config_fingerprint` are
  instead recorded on each `runs.jsonl` row so product changes remain visible.
- `summary.json` records a separate scoring identity covering the scorer
  implementation revision, deterministic or optional-judge mode, judge prompt
  version, judge models, and ground-truth digests. Historical artifacts without
  lineage remain readable and are labeled as having unavailable provenance.

Braintrust receives the benchmark series, cohort fingerprint, candidate
identity, execution-policy fingerprint, row graph/config fingerprints, and
scoring identity as filterable metadata. Raw ground truth is never included.

For release-over-release comparisons, pass the candidate run followed by the
baseline run:

```bash
ultrafuzz eval compare <candidate-eval-run-id> --against <baseline-eval-run-id>
```

The comparison runs only when cohort and scoring identities are complete, match,
and cover the same variant IDs. Use `--allow-incompatible` as an explicit
waiver; the result remains marked incompatible and lists the compatibility
differences that were waived.

## CLI surface

```
ultrafuzz eval plan      # validate config + suite, print the matrix
ultrafuzz eval run       # launch rows, poll to terminal state, stream telemetry
ultrafuzz eval status    # observe every row's durable node progress and ETA
ultrafuzz eval score     # grade reports against ground truth (optional --llm-judge)
ultrafuzz eval report    # show the scored variant ranking
ultrafuzz eval compare   # diff variants or release runs with compatible lineage
ultrafuzz eval bundle    # export privacy-safe aggregate evidence for offline analysis
ultrafuzz eval history   # validate/render or append to public longitudinal history
ultrafuzz eval publish   # post-hoc replay of a recorded run to a provider
```

The public cohort and lane manifests under `benchmarks/` adapt EVMbench detect
and the canonical Ultrafuzz benchmark cohort into the same eval-suite types.
The bounded smoke lane selects the three Foundry, Hardhat, and Vyper
Ultrafuzz-bench targets and pins GPT-5.6 Luna `high` for bug-finding. It selects
the CLI-packaged `smoke` audit profile instead of filtering the production
topology: one context pass feeds four strategies in one parallel wave, followed
by dedupe and report passes. Every node uses the selected runner model and
reasoning level. The four
strategies cover time, external dependencies, externalized accounting, and
lifecycle views. Its
lane definition still records `strategy_loops: 1` and the three disabled
strategy families. The full lane selects every checked-in EVMBench target, pins
GPT-5.6 Luna `high`, Claude Sonnet 5 `high`, Kimi K3 `max`, and DeepSeek V4 Pro
`max`, sets the same
one strategy loop, and explicitly leaves all three disable flags off so the
complete topology is included. Both default to one trial per variant and use
GPT-5.6 Sol `xhigh` as an independent judge. Public Modal pairs contain one
runner variant. Repository variables may override the smoke OpenAI model and
reasoning level, while full workflow dispatch inputs may override any full-lane
runner. These overrides retain the lane's fixed provider count, target
selection, and topology. Publication validates every pair as an exact projection
of the candidate commit's trusted lane policy before merging its observations.
Smoke publication additionally requires at least one normalized finding for
every successful target row; the single report-backed failed target may publish
an empty normalized finding list. The smoke workflow profile and selected strategy IDs are part
of the execution-policy fingerprint, so its charts cannot mix with full or
legacy smoke observations.

### Published history

The README overview emits one point only when a candidate run contains every
target pinned by its cohort, exactly once, for the same benchmark, lane,
variant, model profile, cohort, execution policy, and scoring lineage.
Incomplete or duplicate target sets are retained in the append-only history but
omitted from the overview. The **UltrafuzzBench Score** is macro-F1: the
arithmetic mean of the per-target F1 values, so each target and framework has
equal weight. Macro precision and recall use the same equal-target weighting.
Precision and recall remain available in `benchmarks/history.json` but are omitted
from the overview charts.

The latest-result summary sums recorded target cost and uses the slowest
recorded target as the parallel run's wall clock. Complete values appear
without a qualifier. If only part of the target evidence is usable, the known
subtotal or maximum remains visible and is labeled `partial` with its target
coverage (for example, `2/3`); it is not presented as a complete-run total. If
no usable value exists, the summary renders `n/a` with its recorded status.
When the latest run contains multiple model profiles, the summary shows every
profile instead of choosing one by identifier order. The quality overview
shows at most the 12 latest complete candidate runs, gives each model profile a
distinct marker color and shape, and breaks lines when the cohort or execution
policy changes. Solid line segments connect identical scoring identities.
Because an exact scoring identity records the candidate commit itself, dashed
segments provide a visual guide across scoring-identity changes without
claiming strict comparability. Exact scoring identities remain available in
point tooltips and continue to gate strict `eval compare` compatibility.

The performance × cost overview uses the same complete-run aggregation for the
smoke lane: its vertical value is target-macro F1 and its horizontal value is
the sum of target costs. It groups runs by model, places the dot at the marginal
median of each metric, and draws horizontal cost and vertical F1 bands from
Type-7 first and third quartiles. These bands describe observed run dispersion,
not confidence intervals. To avoid mixing Luna's old and current prices, its
comparison starts at the first run in the non-overlapping current-price regime,
`2026-07-31T14:52:13.635Z`; other models use all priced smoke runs. A complete
target cohort with a known partial cost remains in the bivariate summary, with
the model point and legend explicitly marked `partial` and target coverage
shown. Missing targets are never treated as zero. A run with no usable cost is
not plotted; models with no priced run retain their median F1 and sample count
in an explicit unplotted annotation. A one-run model has a dot and a collapsed
IQR.

`eval history` consumes complete scored generations, stores aggregate metrics
plus immutable candidate, cohort, execution-policy, and scoring lineage in
`benchmarks/history.json`, and renders the README SVGs without network or model
calls. A known partial efficiency value remains numeric and renders with a
partial marker and typed reasons. An unavailable value remains `null` and
renders with an `n/a` cross. Legacy partial observations whose numeric value was
not recorded remain `null`, but use a distinct dashed-ring `partial n/a` marker
so they cannot be mistaken for unavailable data.

The history's top-level `supersessions` ledger can name an immutable source run
and the source run that replaces it, with a bounded reason and repository issue
URL. A pending entry does not hide data. An identity-compatible subset of the
replacement may arrive without invalidating history; activation waits for exact
per-target observation cardinality parity. At that point renderers exclude the
old source run while retaining its observations in the append-only file. The
replacement must match the old run's benchmark identity and target revisions;
over-counted targets, duplicate ledger entries, self-references, and chains are
rejected. Cohort fingerprints must match by default. An exceptional migration
between provenance schemas can declare a `cohort_transition` with the exact
superseded and replacement fingerprints; the old pin is checked even while the
entry is pending, the new pin is checked when its source run arrives, and every
non-cohort identity field (including the execution-policy fingerprint) must
still match. This is an auditable migration guardrail, not a general
comparability waiver.

EVMBench and Ultrafuzz-bench reports are non-sensitive public benchmark output.
The Modal publication bundle therefore includes the scored generation and the
allowlisted report and normalized-finding files. It also carries the strict
post-eval diagnostic that certifies each scoreable terminal outcome. A complete
cohort may include one report-backed failed workflow, preserving that failure as
a scored datapoint; two failed rows or missing terminal evidence still block
publication. Bundle path, size, and SHA-256 checks are distinct from
the aggregate-only `eval bundle` privacy contract used for arbitrary targets.

`eval publish --provider braintrust <eval-run-id>` replays the journal from
offset 0 and reconstructs the entire node trace on a provider after the fact
(CI runs with reporting off, backfilling a newly added provider). Live and
post-hoc publishing share one code path; `--resume` continues from the
persisted cursor instead.

Grading never depends on a provider: scores are computed locally
(deterministic matcher, optional LLM judge behind the generic `FindingJudge`
type) and mirrored out. `provider = "none"` keeps the full
plan → run → score → compare loop working offline.

`eval status <eval-run-id>` is the read-only live view across a whole matrix.
It derives node counts, row lifecycle state, checkpoint age, and estimated
remaining time only from recorded eval links, durable run state, and bounded
linked-workflow evidence. It never resumes, retries, synchronizes, collects,
publishes, or otherwise changes a workflow. The compact table shows at most
three active or waiting node IDs per row, truncates each displayed ID after 64
Unicode characters while keeping the JSON value exact, preserves actionable
wait reason → next action pairs, and uses `+N` for the remainder. It also
distinguishes an admitted active linked workflow from a finished, stopped,
failed, paused, waiting, or cancelled one using the current durable workflow
binding rather than a superseded launch-time ID. Recognized Smithers lifecycle
aliases retain their recorded spelling in JSON for compatibility across runner
versions.

All rows use matrix-order opaque labels. The versioned
`ultrafuzz.eval.status.v1` JSON keeps the full `active_node_ids` and
`waiting_nodes` lists; each waiting entry includes its node `status`,
`wait_reason`, and `next_eligible_action`. `linked_workflow_status` carries the
reconciled lifecycle value. It is `null` when no workflow is linked and
`"unknown"` when linked evidence is missing, unsupported, or ambiguous. Wait
reason and next action are likewise `null` when absent or newer than the known
telemetry vocabulary. The existing typed counts, percentages, timestamps,
checkpoint freshness, and ETA availability remain unchanged. Private target
metadata, repository locations, findings, and diagnostics are not
representable.

The compact table renders an unlinked workflow as `none` and ambiguous or
unavailable linked evidence as `unknown`.

Configure an independent judge panel at the root of the eval suite YAML selected
by `--suite` or `[eval].eval_config`:

```yaml
judge_panel:
  total: 4
  quorum: 3
```

The default is three independent members with quorum two. Explicit strict-majority
overrides remain supported, including one member with quorum one and four members
with quorum three. `total` and `quorum` must be positive integers, `quorum` cannot
exceed `total`, and the quorum must be a strict majority. Each member gets a fresh
model context containing the same
versioned adjudicator prompt; panel requests use bounded concurrency while
retaining each request's retry, timeout, privacy, and credential boundaries.
The evaluator applies the normal classification policy to every response and
requires quorum on an identical decision. A true-positive vote's identity
includes its canonical matched bug ID. Findings without quorum enter the human
review queue with the `panel-disagreement` reason.

Each judged finding in `scores.jsonl` records the panel total and quorum,
model, reasoning effort when configured, prompt version, deterministic vote
split, individual member decisions and rationales, and aggregate decision.
Scoring provenance includes the effective panel configuration and versioned
prompt/scorer revisions, so panel scores are not interchangeable with older
single-judge artifacts. Credentials are never part of score artifacts.

`eval bundle <eval-run-id> --output <directory>` is the explicit offline
analysis export. It derives fixed-schema aggregate files rather than copying
the eval or run directories. `analysis-bundle.json` records bundle-relative
paths, sizes, and SHA-256 checksums; `omissions.json` records typed reasons for
expected evidence that was unavailable. Collection validates every payload,
reference, checksum, and the privacy allowlist before replacing the output
directory. The resulting bundle contains no raw agent output, findings,
configuration, absolute execution paths, or deployment identifiers.
When Modal recovery lifecycle evidence is supplied, the bundle includes
`data/recovery-summary.json` with exactly reconciled generation, progress,
model-work, resumption, rotation, and genuine-failure counts. Historical
exports without that evidence record a typed source omission rather than
guessing from launcher attempts.

Scored row summaries take lifecycle timestamps and terminal status from the
durable run state rather than the detached launcher process. Their typed
efficiency block reports wall/active/wait time, total tokens, and cost together
with explicit completeness states, and `summary.md` renders those same
structured fields.

The gateway judge requires its own `ULTRAFUZZ_EVAL_JUDGE_API_KEY`; reporter or
general OpenAI credentials are never reused. `ULTRAFUZZ_EVAL_JUDGE_URL`, when
set, must be HTTPS without embedded credentials, and redirects are rejected.
For a target marked `sensitivity: private`, the judge is disabled unless the
operator explicitly sets `ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA=true`.
Ground-truth IDs are replaced with candidate aliases in the request, and an
LLM result cannot downgrade a deterministic true positive.

Full per-command flags are in the [CLI reference](cli.md#eval). Local eval
artifacts (`eval.json`, `matrix.json`, `runs.jsonl`, `scores.jsonl`,
`summary.json`, `summary.md`, telemetry cursors) are documented in
[Run Artifacts and Reports](artifacts-reports.md#eval-run-artifacts). For a
task-oriented walkthrough, see
[Run Eval Suites](../how-to/run-evals.md).
