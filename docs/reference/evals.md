# Eval Suites

Ultrafuzz eval suites benchmark the fuzzing pipeline against targets with
known ground-truth bugs, with a **provider-agnostic `EvalReporter`
abstraction** and **first-class node telemetry**: every node of the
`topology.yml` DAG (lifecycle, heartbeats, and intermediary artifacts —
reports, markdown, JSON) is streamed to the configured eval cloud provider
(Braintrust, LangSmith, …) as spans/child runs, live during a run and
replayable after it.

## Configuration split

Rule of thumb: **`ultrafuzz.toml` answers "where does this run and how does it
authenticate in this environment"; the eval YAML answers "what experiment are
we running and how is it graded."** The YAML is committable and portable
across providers; the TOML is per-environment and holds only env-var _names_,
never secret values.

### `ultrafuzz.toml` — the `[eval]` section

```toml
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"   # suite used when --suite is omitted
ground_truth_root = "/secure/eval-ground-truth"    # machine-specific, MUST resolve outside the repo
provider = "braintrust"                            # active reporter: braintrust | langsmith | none

[eval.providers.braintrust]
api_key_env = "BRAINTRUST_API_KEY"
project = "ultrafuzz-evals"

[eval.providers.langsmith]
api_key_env = "LANGSMITH_API_KEY"
workspace_id_env = "LANGSMITH_WORKSPACE_ID"
project = "ultrafuzz-evals"
# endpoint = "https://api.smith.langchain.com"     # optional override
```

- `provider` selects the active reporter; `[eval.providers.*]` entries are
  connection profiles, so switching providers (or adding a new one) is a
  one-line change with no YAML edits.
- Precedence: CLI flag (`--provider`, `--suite`) > env
  (`ULTRAFUZZ_EVAL_PROVIDER`, `ULTRAFUZZ_EVAL_CONFIG`) > `ultrafuzz.toml`.
- `ground_truth_root` is machine-specific and security-sensitive: ground truth
  must live **outside** the repository; suite targets reference files relative
  to this root.
- Validation: an unknown `provider` or a missing `[eval.providers.<name>]`
  profile is a config error at `eval plan` time; a missing env var named by
  `api_key_env` is an error at publish time only, so local-only runs with
  `provider = "none"` keep working offline.

### Eval YAML — the experiment definition

See `.ultrafuzz/evals/bug-finding.yml` for the default suite. It defines model
profiles, targets (repo/ref/ground truth/sensitivity), variants, trial counts,
grading metrics, and the `reporting:` telemetry policy. Nothing in the YAML
names a provider, an endpoint, or an env var.

The `reporting.artifacts` policy is allowlist-by-default with a size cap and a
sensitivity gate: `sensitivity: private` targets default to `manifest-only` —
the provider sees the DAG, timings, findings counts, and file names/hashes,
while payloads stay on disk unless the suite explicitly opts into
`mode: upload`.

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
  `start`/`end` metrics; `reporters/langsmith.ts` maps the same stream to
  root/child runs via `parent_run_id`/`dotted_order`, creating runs live on
  `node-started` and patching them on `node-finished`. Both reporters speak
  the providers' REST APIs directly over `fetch` — `packages/runtime` never
  imports a provider SDK.
- Heartbeat liveness is bounded by the sync poll cadence: state transitions
  and partial artifacts appear within one poll interval. That is the correct
  trade for a detached orchestrator.

## CLI surface

```
ultrafuzz eval plan      # validate config + suite, print the matrix
ultrafuzz eval run       # launch rows, poll to terminal state, stream telemetry
ultrafuzz eval score     # grade reports against ground truth (optional --llm-judge)
ultrafuzz eval report    # show the scored variant ranking
ultrafuzz eval compare   # diff variants against a --baseline
ultrafuzz eval publish   # post-hoc replay of a recorded run to a provider
```

`eval publish --provider langsmith <eval-run-id>` replays the journal from
offset 0 and reconstructs the entire node trace on a provider after the fact
(CI runs with reporting off, backfilling a newly added provider). Live and
post-hoc publishing share one code path; `--resume` continues from the
persisted cursor instead.

Grading never depends on a provider: scores are computed locally
(deterministic matcher, optional LLM judge behind the generic `FindingJudge`
type) and mirrored out. `provider = "none"` keeps the full
plan → run → score → compare loop working offline.
