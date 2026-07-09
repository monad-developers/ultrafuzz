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
```

`score` grades run reports against ground truth with a deterministic matcher;
`--llm-judge` additionally uses the suite's judge model profile. `report`
shows the scored variant ranking from `summary.json`/`summary.md`, and
`compare` diffs variants against the named baseline variant. None of this
requires a provider or credentials.

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

For configuration and architecture details, see
[Eval Suites](../reference/evals.md), the
[CLI reference](../reference/cli.md#eval), and
[Configuration](../reference/configuration.md#eval).
