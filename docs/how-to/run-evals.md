# Run Eval Suites

Eval suites benchmark the Ultrafuzz pipeline against targets with known
ground-truth bugs and rank prompt or topology variants by precision, recall,
and F1. The full loop is `plan → run → score → report → compare`, with an
optional `publish` step that mirrors node telemetry to an eval cloud provider.

## Configure The Suite

Two files split the configuration:

- The eval YAML (default `.ultrafuzz/evals/bug-finding.yml`) is the
  committable experiment definition: model profiles, targets, variants, trial
  counts, grading metrics, and the telemetry policy. It never names a
  provider, an endpoint, or an env var.
- The `ultrafuzz.toml` `[eval]` section is per-environment: the default suite
  path, the machine-specific `ground_truth_root`, the active `provider`
  (`braintrust | none`), and `[eval.providers.<name>]` profiles
  holding credential env-var _names_.

```toml
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = "/secure/eval-ground-truth"
provider = "none" # keep the local loop offline; switch when publishing
```

Ground truth must live outside the repository; suite targets reference
ground-truth files relative to `ground_truth_root`.

Declare the suite's recovery exposure alongside its metric policy:

```yaml
recovery_equivalence:
  max_repeated_model_executions: 1
  aggregate_non_comparable: separate
  publication: comparable
```

Use a zero repeat budget with `publication: clean` for lanes whose observations
must never include post-model recovery. `summary.md` reports the resulting
classification and recovery totals for every row; `separate` keeps
non-comparable rows out of the primary aggregates while showing their metrics
in a dedicated table.

## Plan The Matrix

```bash
ultrafuzz eval plan --target-root /path/to/target-checkouts
```

`plan` validates the config and suite and prints the target × variant × trial
matrix without launching anything. Local target checkouts are expected under
`--target-root`, one directory per target id, at the suite's pinned git refs;
pass `--skip-target-validation` to skip the ref check. An unknown provider or
missing provider profile fails here, before any run is launched.

Ordinary eval YAML requires an explicit `trials_per_variant`. The public
benchmark lane manifests under `benchmarks/` default it to `1` when omitted.
Those lanes support an explicit larger value, but use it deliberately: row
count, model usage, and cost multiply across every target, runner-model
variant, and trial.

## Launch The Runs

```bash
ultrafuzz eval run --target-root /path/to/target-checkouts
ultrafuzz eval run --row <row-id> --no-watch
```

`run` launches an Ultrafuzz run per matrix row (or a `--row` selection),
polls the runs to a terminal state, and streams node telemetry to the active
provider when the suite enables it. `--no-watch` launches detached without
polling or streaming. Artifacts accumulate under
`.ultrafuzz/evals/runs/<eval-run-id>/`.

## Score And Compare

```bash
ultrafuzz eval score <eval-run-id>
ultrafuzz eval score <eval-run-id> --llm-judge
ultrafuzz eval report <eval-run-id>
ultrafuzz eval compare <eval-run-id> --baseline baseline
ultrafuzz eval compare <candidate-eval-run-id> --against <baseline-eval-run-id>
```

`score` grades run reports against ground truth with a deterministic matcher;
`--llm-judge` additionally uses the suite's judge model profile. `report`
shows the scored variant ranking from `summary.json`/`summary.md`, and
`compare` either diffs variants against the named baseline variant or compares
two releases when `--against` names the baseline eval run. Longitudinal
comparisons require identical cohort fingerprints, scoring fingerprints, and
variant IDs; an explicit `--allow-incompatible` waiver preserves and reports
any differences.
Deterministic scoring requires neither a provider nor provider credentials.

The optional gateway judge has a separate credential and consent boundary:

```bash
export ULTRAFUZZ_EVAL_JUDGE_API_KEY=...
# Required only when scoring a target marked sensitivity: private:
export ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA=true
ultrafuzz eval score <eval-run-id> --llm-judge
```

An optional `ULTRAFUZZ_EVAL_JUDGE_URL` must be HTTPS without embedded
credentials. Judge and reporter requests do not follow redirects.

## Publish Telemetry (Optional)

```bash
ultrafuzz eval publish <eval-run-id> --provider braintrust
ultrafuzz eval publish <eval-run-id> --resume
```

`publish` replays a recorded eval run's journals from offset 0 and
reconstructs the entire node trace (spans, heartbeats, manifests, artifacts,
scores) on the provider after the fact — useful for CI runs that executed
with reporting off or for backfilling a newly added provider. `--resume`
continues from the persisted publish cursor instead of replaying. Missing
credential env vars fail only at this step. Reporter failures degrade to
warnings and never fail an eval run.

For sensitive targets, the suite's `reporting.artifacts` policy defaults to
`manifest-only`: providers see the DAG, timings, and file names/hashes while
payloads stay on disk.

The pinned Ultrafuzz-bench and EVMBench targets are public open-source benchmark
fixtures. Their Modal lane explicitly publishes the allowlisted `report.md`,
`report.json`, and normalized findings payloads as ordinary public artifacts;
the sensitive-target default does not apply to those benchmark bundles.

For configuration and architecture details, see
[Eval Suites](../reference/evals.md), the
[CLI reference](../reference/cli.md#eval), and
[Configuration](../reference/configuration.md#eval).

## Publish Longitudinal History

The checked-in cohort and lane manifests live under `benchmarks/`. The smoke
lane selects the three Ultrafuzz-bench targets, covering Foundry, Hardhat, and
Vyper, and runs GPT-5.6 Luna at `high`. Its canonical controls set
`strategy_loops: 1`, `disable_invariant_tests: true`,
`disable_differential_tests: true`, and `disable_dynamic_strategies: true`.
The adapter selects the CLI-packaged `smoke` audit profile, whose bounded graph
has a single context pass, four parallel ground-truth-informed strategy
families, dedupe, and final report. The production topology is not modified or
filtered.
All three target rows run concurrently, while the four strategy nodes within
each row use a smoke-only four-way workflow concurrency limit.

The full lane uses every checked-in EVMBench target and runs GPT-5.6 Luna at
`high`, Claude Sonnet 5 at `high`, Kimi K3 at `max`, and DeepSeek V4 Pro at
`max`. It also pins
`strategy_loops: 1`, while all three disable flags are `false`, so it retains
the packaged `exhaustive` audit profile with invariant tests, differential tests, and
dynamic strategies. The launcher derives the current packaged audit-profile
catalog and topology digests from the lane and verifies both against the
target's effective policy before creating a run. Public benchmark variants
that supply a topology override are rejected at launch. The actual run-plan
profile, catalog, topology origin, and topology digest are recorded and checked
again before public-history publication. Both lanes default to one trial per
variant and use the separate GPT-5.6 Sol `xhigh` judge. The benchmark adapter
converts either lane into the normal `EvalSuiteSpec` and can project one runner
for an isolated Modal pair while retaining the fixed judge.

After a generation finishes and has been scored, append it and regenerate all
nine SVG charts in one transaction:

```bash
ultrafuzz eval history <eval-run-id> \
  --benchmark ultrafuzz-bench \
  --lane smoke \
  --repository https://github.com/monad-developers/ultrafuzz \
  --artifact <immutable-run-artifact-reference> \
  --publication-url <validated-result-bundle-url>
```

Use `--benchmark evmbench` and `--lane full` for the full cohort. Publication
refuses missing rows, failed or non-terminal workflows, non-clean recovery classifications,
invalid reports, a matrix that differs from the exact public target/variant/trial
scope, incomplete or inconsistent lineage, unpinned targets, and missing scoring
evidence before modifying history. Repeating the same immutable eval result is
idempotent; conflicting content for an existing result is rejected. Candidate,
cohort, execution-policy, and scoring fingerprints remain available in every
published observation.

To regenerate charts without a benchmark or model call, run:

```bash
ultrafuzz eval history
ultrafuzz eval history --check
```

`--check` is the ordinary-CI path: it validates history and reports stale or
missing charts without writing them. If publication fails, inspect the scored
run for a complete `summary.json`, `scores.jsonl`, terminal-success lifecycle,
and available candidate, cohort, and scoring provenance. A known but incomplete
timing or cost value is retained and visibly labeled `partial` with its target
coverage. A value with no usable evidence renders as `n/a` and `unavailable`;
neither case is converted to zero.

Paid benchmarks do not run in this repository's GitHub Actions. Pushes, pull
requests, and manual CI dispatches run the build, test, and static checks without
provider or Modal credentials. Existing history and charts remain available;
new benchmark measurements require an explicitly initiated maintainer run.

Run benchmarks from a clean, isolated checkout of the reviewed candidate, with
credentials scoped to that run on the launcher host. See
[Run evals on Modal](run-evals-on-modal.md#run-public-benchmarks-manually) for the
manual public-lane procedure. Review the selected targets, models, trials,
parallelism, and provider/Modal spending limits before launching. Scoring uses
its own judge credential and contributes separate API spend.

After collecting and validating the complete scored results, run the history
command above, review the changed history and charts, and submit them through a
normal pull request. There is no automatic history publisher or publisher App
bypass. The publication records remain bound to the benchmark candidate's
immutable identity, not the later documentation commit. The ordinary CI
`benchmark:history:check` command still verifies history/chart consistency
without launching models or Modal compute.

The eval summary and comparison record Ultrafuzz runner tokens and runner cost
with explicit completeness. Judge usage in Braintrust and sandbox spend in
Modal remain separate provider-side records keyed by the immutable run IDs; use
those three sources together for the offline frequency/cost review rather than
treating the runner ledger as total spend.
