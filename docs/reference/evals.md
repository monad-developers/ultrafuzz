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
across providers; the TOML is per-environment and names credential environment
variables, never inline secret values.

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
# endpoint = "https://langsmith.internal.example" # requires the exact operator acknowledgement below
```

- `provider` selects the active reporter; `[eval.providers.*]` entries are
  connection profiles, so switching providers (or adding a new one) is a
  one-line change with no YAML edits.
- Precedence: CLI flag (`--provider`, `--suite`) > env
  (`ULTRAFUZZ_EVAL_PROVIDER`, `ULTRAFUZZ_EVAL_CONFIG`) > `ultrafuzz.toml`.
- `ground_truth_root` is machine-specific and security-sensitive: ground truth
  must live **outside** the repository; suite targets reference files relative
  to this root. Absolute entries, traversal, symlinks, non-regular files, and
  files larger than 1 MiB are rejected.
- Built-in reporters bind credentials to their canonical names
  (`BRAINTRUST_API_KEY`, `LANGSMITH_API_KEY`, and, when configured,
  `LANGSMITH_WORKSPACE_ID`) and canonical HTTPS origins. Requests reject
  redirects, time out after 30 seconds, and accept at most 1 MiB of response
  data.
- A self-hosted endpoint must be an HTTPS origin and requires an exact,
  operator-owned environment acknowledgement. Set
  `ULTRAFUZZ_EVAL_BRAINTRUST_TRUSTED_ENDPOINT` or
  `ULTRAFUZZ_EVAL_LANGSMITH_TRUSTED_ENDPOINT` to the same origin as the
  corresponding `endpoint`. Repository configuration alone cannot redirect a
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
Ultrafuzz-bench targets and pins GPT-5.6 Luna `high`. The full lane selects every
checked-in EVMBench target and pins GPT-5.6 Luna `high` plus Claude Sonnet 5
`high`. Both default to one trial per variant and use GPT-5.6 Sol `xhigh` as an
independent judge. Public Modal pairs may contain one runner variant, including
an explicit workflow model override, but publication validates that it is an
exact projection of the candidate commit's checked-in matrix before merging its
observations.
`eval history` consumes only complete scored generations, stores aggregate
metrics plus immutable candidate, cohort, execution-policy, and scoring lineage
in `benchmarks/history.json`, and renders the README SVGs without network or
model calls. Efficiency values that are not complete remain `null` with typed
reasons and render as unavailable.

EVMBench and Ultrafuzz-bench reports are non-sensitive public benchmark output.
The Modal publication bundle therefore includes the scored generation and the
allowlisted report and normalized-finding files. It also carries the strict
post-eval diagnostic that certifies each scoreable terminal outcome; history
accepts a failed workflow only when that evidence identifies a report-backed
genuine task failure. Bundle path, size, and SHA-256 checks are distinct from
the aggregate-only `eval bundle` privacy contract used for arbitrary targets.

`eval publish --provider langsmith <eval-run-id>` replays the journal from
offset 0 and reconstructs the entire node trace on a provider after the fact
(CI runs with reporting off, backfilling a newly added provider). Live and
post-hoc publishing share one code path; `--resume` continues from the
persisted cursor instead.

Grading never depends on a provider: scores are computed locally
(deterministic matcher, optional LLM judge behind the generic `FindingJudge`
type) and mirrored out. `provider = "none"` keeps the full
plan → run → score → compare loop working offline.

`eval bundle <eval-run-id> --output <directory>` is the explicit offline
analysis export. It derives fixed-schema aggregate files rather than copying
the eval or run directories. `analysis-bundle.json` records bundle-relative
paths, sizes, and SHA-256 checksums; `omissions.json` records typed reasons for
expected evidence that was unavailable. Collection validates every payload,
reference, checksum, and the privacy allowlist before replacing the output
directory. The resulting bundle contains no raw agent output, findings,
configuration, absolute execution paths, or deployment identifiers.

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
