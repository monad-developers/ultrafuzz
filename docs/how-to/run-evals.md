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
  (`braintrust | langsmith | none`), and `[eval.providers.<name>]` profiles
  holding credential env-var _names_.

```toml
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = "/secure/eval-ground-truth"
provider = "none" # keep the local loop offline; switch when publishing
```

Ground truth must live outside the repository; suite targets reference
ground-truth files relative to `ground_truth_root`.

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
ultrafuzz eval publish <eval-run-id> --provider langsmith
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
The adapter derives the exact invariant, differential, and dynamic topology
node exclusions from those flags; node IDs are not duplicated in the manifest.

The full lane uses every checked-in EVMBench target and runs GPT-5.6 Luna at
`high` plus Claude Sonnet 5 at `high`. It also pins `strategy_loops: 1`, while
all three disable flags are `false`, so it retains the complete production
topology with invariant tests, differential tests, and dynamic strategies.
Both lanes default to one trial per variant and use the separate GPT-5.6 Sol
`xhigh` judge. The benchmark adapter converts either lane into the normal
`EvalSuiteSpec` and can project one runner for an isolated Modal pair while
retaining the fixed judge.

After a generation finishes and has been scored, append it and regenerate all
six charts in one transaction:

```bash
ultrafuzz eval history <eval-run-id> \
  --benchmark ultrafuzz-bench \
  --lane smoke \
  --repository https://github.com/monad-developers/ultrafuzz \
  --artifact <immutable-run-artifact-reference>
```

Use `--benchmark evmbench` and `--lane full` for the full cohort. Publication
refuses missing rows, failed or non-terminal workflows,
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
and available candidate, cohort, and scoring provenance. Missing timing or cost
is allowed and renders as unavailable; it is never converted to zero.

Commits on `main` and head commits of trusted, non-draft pull requests launch
the real three-target Ultrafuzz-bench smoke as detached Modal work, then restore
its state in a separate collection job. Draft pull requests skip paid work;
marking one ready for review launches its current head. A newer commit on the
same pull request or branch cancels the older smoke. GPT-5.6 Luna `high` is the
only smoke runner. Candidate installation and build happen before any Modal
launch, so a broken commit fails without allocating the benchmark matrix.

A manual workflow dispatch launches the full EVMBench cohort instead, with
GPT-5.6 Luna `high` and Claude Sonnet 5 `high` by default. Its model and
reasoning inputs can override both runners. Full runs only through that manual
dispatch; pushes and pull-request events always select smoke. Both modes retain
the standard Modal CPU and memory allocation, give each target row a
3,600-second watchdog, and publish ordinary 30-day Actions artifacts. Missing
credentials, revision drift, unavailable ground truth, failed model work,
scoring errors, or an incomplete configured matrix fail before publication.

Every publisher updates one fixed pull request from the latest remote
publication tip and uses a normal fast-forward push; a lost race is retried
with the new tip. The exact candidate checkout supplies the benchmark policy,
and observations and regenerated charts stay keyed to that candidate commit.
This compare-and-swap loop retains every complete generation without relying
on a GitHub concurrency queue, which can discard a pending job. The publication
commit uses `[ci skip]`, preventing a chart-only merge from recursively
allocating another benchmark matrix.

When organization policy disables pull-request creation by `github.token`, set
the optional `EVAL_HISTORY_PR_TOKEN` Actions secret to a repository-scoped
credential that can create pull requests. If it is absent or PR creation is
still blocked, the pushed `automation/eval-history` branch remains intact and
the successful job emits a warning plus a manual compare/PR link in its
summary; no complete scored generation is discarded.

The eval summary and comparison record Ultrafuzz runner tokens and runner cost
with explicit completeness. Judge usage in Braintrust and sandbox spend in
Modal remain separate provider-side records keyed by the immutable run IDs; use
those three sources together for the offline frequency/cost review rather than
treating the runner ledger as total spend.
