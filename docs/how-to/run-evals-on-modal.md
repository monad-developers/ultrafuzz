# Run evals on Modal

Ultrafuzz can run long evaluation rows in Modal sandboxes while retaining
telemetry, scores, and reports in the run workspace. The runner uses the Modal
TypeScript SDK; Python is not required.

## Security and storage boundaries

Keep the benchmark config under an ignored path such as
`.ultrafuzz/modal/benchmark.json`, or outside the repository entirely. The
config contains the target and ground-truth locations and must not be
committed.

At launch time the runner copies the config to `/run/ultrafuzz-config` inside
the sandbox. Subscription credentials are copied directly from the host to
`/run/ultrafuzz-auth`; they are never placed in a Modal Secret, image,
environment variable, launch-state file, or log. Kimi is the exception for
same-volume resume: after the host token is refreshed, a refreshable snapshot of
the selected Kimi Code credential is staged into a private per-row auth
directory on the Modal Volume.

Non-secret run state is stored under `/data/<run-id>/<model>/workspace` on a
private Modal Volume. This preserves Ultrafuzz state, generated tests, reports,
and Smithers workspaces when a sandbox exits. Each sandbox has a 24-hour
timeout; eval watching stops two hours earlier so terminal persistence, scoring,
and volume flushing retain a bounded completion window.

Benchmark sandboxes reserve 16 physical CPU cores (32 vCPUs) and 32 GiB of
memory, with a 64 GiB memory limit. The Modal benchmark worker override
configuration permits 16 parallel agents and 32 parallel planned nodes so the
workflow can use that capacity.

## Four-hour exhaustive campaigns

The exhaustive profile runs one four-hour Recon campaign over its selected high
and medium priority properties. The deployment smoke, shutdown, and artifact
finalization require additional time: at least 15,600 seconds in total. Its
campaign task allows 16,200 seconds; per-node Modal execution adds a further
1,800-second lifecycle reserve, producing a five-hour sandbox. An explicit
resource cap must accommodate the full task.

The retained public full benchmark configuration allows only 15,000 seconds per
row. Launch validation rejects it before execution with
`MODAL_CAMPAIGN_ENVELOPE_TOO_SHORT`. Use local or per-node Modal execution with a
compatible budget for the four-hour profile until the full benchmark's row and
control budgets are deliberately revised. The runner does not silently shorten
the campaign or increase these paid benchmark budgets. Each campaign shares the
workflow deadline with its other stages and retries.

## Authenticate locally

For subscription auth, log in before launching:

```bash
codex login
claude auth login
kimi login
```

By default the runner reads `CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`) and `CLAUDE_CONFIG_DIR/.credentials.json` (normally
`~/.claude/.credentials.json`). Kimi subscription auth reads the current Kimi
Code home from `KIMI_CODE_HOME`, `KIMI_SHARE_DIR`, or `~/.kimi-code`, and stages
only `config.toml`, the selected file-backed OAuth credential, and `device_id`
for the worker. Before sandbox fan-out, the launcher refreshes a near-expiry
token under Kimi Code's cross-process OAuth lock and atomically persists it on
the host. Each worker then stages the selected credential into the row's durable
`kimi-code-auth` directory, and Kimi invocations keep their session homes under
the row's durable `kimi-code-sessions` directory while symlinking config and auth
from runtime-only snapshots. Modal workers refresh one shared row credential
under Kimi Code's OAuth lock; host reconciliation only promotes a refreshed
Modal credential if it descends from the host token staged for that row.
API-key auth is also supported per model; Kimi accepts either
`KIMI_API_KEY` or `MOONSHOT_API_KEY` on the launcher host, exposes the value to
the worker as `KIMI_API_KEY`, and binds it through Kimi Code's provider
`api_key` config field. DeepSeek V4 Pro requires `DEEPSEEK_API_KEY`; the worker
forwards it only to the selected DeepSeek pair, whose generated adapter routes
Claude Code to DeepSeek's Anthropic-compatible endpoint.
OpenRouter rows require `OPENROUTER_API_KEY`, always use `auth_mode =
"api-key"`, and route the Codex CLI through `https://openrouter.ai/api/v1`.
The selected OpenRouter catalogue ID is retained verbatim in the benchmark
config and launch evidence.

For subscription auth, launch at most one Kimi row at a time. Use Kimi API-key
auth or serial launches when comparing multiple Kimi profiles, so OAuth
refresh-token rotation remains single-writer.

## Create a private runtime config

The v3 document is an exact contract: every operational value is explicit.
The loader does not add models, loop counts, image names, credential names,
timeouts, judge settings, or target selections. Configure each model row you
intend to run; the public benchmark config generator sets `loops = 1` for its
smoke and full lanes.

```json
{
  "schema_version": "ultrafuzz.modal.benchmark.v3",
  "run_id": "example-run",
  "app_name": "ultrafuzz-evals",
  "image_name": "ultrafuzz-security-runner:latest",
  "target": {
    "repo": "https://example.invalid/subject.git",
    "ref": "full-commit-sha"
  },
  "ground_truth": {
    "repo": "https://example.invalid/reference-findings.git",
    "ref": "full-commit-sha",
    "file": "findings.yml",
    "format": "ultrafuzz"
  },
  "benchmark_execution": {
    "excluded_node_ids": []
  },
  "judge": {
    "api_key_env": "OPENAI_API_KEY",
    "url": "https://api.openai.com/v1/chat/completions",
    "credential_ttl_seconds": 57600
  },
  "node_timeout_seconds": 7200,
  "loops": 3,
  "models": [
    {
      "slug": "gpt-5-6-sol",
      "model": "gpt-5.6-sol",
      "provider": "openai",
      "agent": "CodexAgent",
      "reasoning": "xhigh",
      "auth_mode": "subscription"
    }
  ]
}
```

The ground-truth file must use the format accepted by `ultrafuzz eval score`.
The config schema intentionally accepts credential environment-variable names,
not inline credential values. Validate the exact file before launch; validation
does not repair or rewrite it:

```bash
ultrafuzz json validate \
  --schema packages/modal/schema/modal-benchmark-config.schema.json \
  --file .ultrafuzz/modal/benchmark.json
```

For a private benchmark, the ground-truth file must bind the bugs to the target
codebase, independently of the repository that stores the file:

```yaml
schema_version: ultrafuzz.eval-ground-truth.v1
subject:
  repository: https://example.invalid/subject
  revision: 0123456789abcdef0123456789abcdef01234567
bugs: []
```

`subject.repository` is compared with `target.repo` and `subject.revision` with
the materialized target commit before model work, before scoring, and when a
Modal workspace resumes. A storage repository may therefore be a separate
private repository, but an upstream repository and its fork are different
subjects. Private benchmarks fail closed without this binding; there is no
historical compatibility reader.

Audit reports with bracketed issue headings can set `ground_truth.format` to
`audit-markdown` and provide `ground_truth.expected_findings`. Conversion runs
inside the sandbox, receives the target binding above, and preserves it in the
converted scorer input. A count mismatch fails before evaluation starts.

For judges that require short-lived credentials, configure an HTTPS
`judge.credential_endpoint`. The worker requests a model-scoped
credential in memory immediately before scoring and never persists it.

### Migrate old benchmark configurations

Fresh launches require `ultrafuzz.modal.benchmark.v3`. Regenerate public pair
configs with the current generator. For a fresh private run, replace the old
`braintrust` object with `judge`, map `judge_api_key_env` to `api_key_env`,
`judge_url` to `url`, `judge_credential_endpoint` to `credential_endpoint`, and
`judge_credential_ttl_seconds` to `credential_ttl_seconds`. Remove the old
reporting `project`, `api_key_env`, and top-level `eval_reporting` settings.
The new `judge.api_key_env` names the judge credential, not the retired
reporting credential.

Do not rewrite a saved configuration for an existing launch: its exact bytes
are part of the launch identity. Current config-based launch, resume,
collection, and cleanup reject old v2 documents. Existing sandboxes can still
be stopped using their launch state without loading an old config:

```bash
ultrafuzz-modal terminate --state /path/to/launch-state.json
```

### Curated private lanes

`benchmark_execution.excluded_node_ids` prunes named nodes from the production
topology, which is how a lane isolates one part of it, such as an
invariant-only comparison. An empty or omitted list runs the whole topology.

A non-empty list is treated as a curated lane, so the threat-model and goal
fanout nodes are pruned with it: `reference-vulnerability-database`,
`threat-model`, `goal-plan`, `goal-roaming`, `threat-goals`, and `class-goals`.
Curated lists were written before those IDs existed and cannot name them, so
without this a curated lane would silently widen, run a threat model and
unbounded goal hunters, and stop being comparable with its earlier runs. Set
`benchmark_execution.include_threat_model_goal_fanout` to `true` to measure
them deliberately.

The pruned lane executes the same graph it executed before these nodes existed,
but `excluded_node_ids` is part of `benchmark_execution`, which is hashed into
the execution-policy and cohort fingerprints. A curated lane's history therefore
starts a new lineage group at the release that introduced these nodes even
though its work is unchanged. Expect one discontinuity in a long-running
comparison such as an invariant-only trend line, and read across it deliberately
rather than treating it as a measured regression.

## Run public benchmarks manually

This repository's GitHub Actions do not launch paid benchmarks, hold provider or
Modal credentials, or publish new benchmark history. Maintainers explicitly
launch public benchmarks from a clean, isolated checkout of a reviewed commit.
Keep credentials on that launcher host and apply scoped provider and Modal
spending limits. Neither a process timeout nor a local token ledger is a total
spend limit.

The checked-in smoke lane selects three Ultrafuzz-bench targets: one Foundry,
one Hardhat, and one Vyper target. Full selects the checked-in EVMBench cohort
and its four runner providers. Both use one strategy loop and an independent
OpenAI judge. The lane manifests retain their model, target, trial, and
concurrency policies; see [Eval Suites](../reference/evals.md#cli-surface).

The retained plan generator and validators under `scripts/ci/` can prepare a
public run locally. These commands only build local tooling, probe anonymous
repository reachability, and write a plan; they do not launch Modal or a model:

```bash
pnpm install --frozen-lockfile
pnpm --filter @ultrafuzz/modal... build
candidate="$(git rev-parse HEAD)"
generation="$(date +%s)-1"
control=".ultrafuzz/modal/public-$generation"
node scripts/ci/verify-cohort-reachability.mjs --lane smoke
node scripts/ci/prepare-modal-benchmarks.mjs \
  "$candidate" https://github.com/monad-developers/ultrafuzz \
  "$generation" "$control" smoke
node scripts/ci/validate-modal-benchmark-launch.mjs "$control/manifest.json" . smoke
```

Use a fresh positive `number-attempt` generation ID for each plan; it is a
local lineage identifier and does not require a GitHub run. Resolve any
reachability failure before paying for an image or sandbox. Select `full` in
all three commands only when intending the complete four-provider cohort.
Review `manifest.json` and every generated pair config before proceeding.
An explicit `BENCHMARK_MODELS_JSON` can override the runner selection while
the validator enforces the lane's provider count and target policy.

Export `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and the selected pair's provider
key on the launcher host. Every public pair also needs `OPENAI_API_KEY` for
its explicitly configured judge. Reporting requires no additional credential.
Do not add these credentials to Actions secrets or commit them with a config.

For the single-pair smoke plan, the following commands start paid compute:

```bash
image_name="$(jq -r '.image_name' "$control/manifest.json")"
config="$control/$(jq -r '.pairs[0].config_path' "$control/manifest.json")"
state="$control/$(jq -r '.pairs[0].state_path' "$control/manifest.json")"
pnpm exec ultrafuzz-modal build --image "$image_name" --build-scope "$generation" --repo-root .
pnpm exec ultrafuzz-modal launch --config "$config" --state "$state" --mode fresh --repo-root .
pnpm exec ultrafuzz-modal status --state "$state"
```

For full, inspect and explicitly launch each selected pair from the manifest
using its own config and state paths. Preserve the plan and state files for
status, collection, and exact termination. The sandboxes are detached:
stopping the launcher does not stop their work. There is no Actions recovery
job. To stop a launched pair, terminate it and confirm its remote state:

```bash
pnpm exec ultrafuzz-modal terminate --state "$state"
pnpm exec ultrafuzz-modal status --state "$state"
```

If a launch did not persist its state, the retained
`prepare-modal-benchmark-cleanup.mjs` and `terminate-modal-benchmark.sh` helpers
can validate a preserved plan and terminate its exact build and pair scopes.
Use trusted tooling and confirm uncertain remote cleanup before retiring
credentials. Keep cleanup access available until the detached work is stopped.

After a pair completes, collect its validated public bundle with `collect
--public-results --config <path>` and extract it with `unpack-public`. Preserve
all scored rows and candidate/target lineage. A complete generation can then
be appended locally with [manual history publication](run-evals.md#publish-longitudinal-history),
and the reviewed history/chart changes submitted through a normal pull
request. Existing charts stay unchanged until such a publication.

## Build and launch

```bash
pnpm install --frozen-lockfile
pnpm --filter @ultrafuzz/modal... build
pnpm exec ultrafuzz-modal build --repo-root .
pnpm exec ultrafuzz-modal launch \
  --config .ultrafuzz/modal/benchmark.json \
  --mode fresh
```

Image staging includes Git-tracked files only. Commit the runner changes you
intend to build; ignored and untracked benchmark material cannot enter the
image archive.

To canary one model under a new run ID, use non-destructive resume mode and
repeat `--model` as needed:

```bash
pnpm exec ultrafuzz-modal launch \
  --config .ultrafuzz/modal/benchmark.json \
  --mode resume \
  --model gpt-5-6-sol
```

`fresh` starts an explicit generation and must include every configured model.
For an existing launch-state file, it first proves that no current-generation
sandbox is live, increments the generation, retains sanitized attempt history,
and clears each durable workspace. Use a new run ID when the prior volume must
remain available.

## Resume after a sandbox stops

Resume only after the prior sandbox is no longer running. Use the same private
config, launch-state file, model selection, and durable volume:

```bash
pnpm exec ultrafuzz-modal launch \
  --config .ultrafuzz/modal/benchmark.json \
  --state .ultrafuzz/modal/example-run/launch-state.json \
  --mode resume \
  --model example-model
```

Resume validates the preserved model, source, configuration, and image identity,
attaches at most one new worker to the existing volume, and lets the workflow
engine reuse completed nodes. It does not make a fresh workspace or repeat
completed work. If the previous sandbox is still live, it remains the owner; if
another exact-lineage continuation exists, the runner adopts that owner instead
of launching another. Use `fresh` when run-defining inputs should intentionally
start a new generation.

Before a new worker can start, the runner stages every ephemeral input, persists
the sandbox identity and launched phase, and then publishes an attempt-scoped
readiness marker. A restart adopts the exact tagged sandbox and completes that
handshake; an uncertain termination is never followed by an automatic competing
launch.

For unattended recovery of resumable private rows, run the overseer with a
separate durable recovery-state file:

```bash
pnpm exec ultrafuzz-modal overseer \
  --config .ultrafuzz/modal/benchmark.json \
  --state .ultrafuzz/modal/example-run/launch-state.json \
  --recovery-state .ultrafuzz/modal/example-run/recovery-state.json
```

The overseer reads canonical workflow state from the persistent volume on every
poll. Recent state transitions or completed nodes keep a live worker healthy
even if its mirrored worker status is stale. `--resume-grace-seconds` controls
the minimum time before a resumed worker can be classified as stalled;
`--max-no-progress-generations` and the bounded backoff options limit repeated
workers that complete no nodes. Exhausting that budget persists a typed terminal
state and stops launching workers.

An optional repeated `--image` selects a recovery image. A healthy worker keeps
ownership when that selection changes; the new image is used after a natural
recovery. Use `--force-rollout` only for an intentional immediate replacement.
Rollouts are recorded separately and do not consume the workflow-failure budget.

The launch command writes an ignored, sanitized launch-state file under
`.ultrafuzz/modal/<run-id>/launch-state.json`. Use that file for status and
collection:

```bash
pnpm exec ultrafuzz-modal status --state .ultrafuzz/modal/example-run/launch-state.json
pnpm exec ultrafuzz-modal collect \
  --state .ultrafuzz/modal/example-run/launch-state.json \
  --output .ultrafuzz/modal/results
```

Private collection remains aggregate-only. Public collection opts into the
larger allowlisted result contract with `--public-results --config <path>`, then
validates and extracts it with `unpack-public`. Public collection requires the
exact config used at launch and accepts a bundle only when its candidate,
benchmark, lane, model, reasoning, and eval-run lineage all match that config
and the launch state. Private collection does not require a config.

Launch-state files written by the earlier Modal runner are upgraded in place on
the next guarded resume after the current config, source, and image identity are
captured for hardened lineage checks. Unversioned durable workspaces are not
resumed; start a fresh generation when an old volume does not contain the
hardened lineage record.

## Read status and sanitized results

Runner state (`live`, `exited`, or `missing`) describes the Modal sandbox. The
runner combines that state with the exact-attempt worker snapshot to select a
machine-readable action such as `succeeded`, `resume-required`,
`transient-operational-failure`, `permanent-operational-failure`, or
`incompatible-checkpoint`. Each status row also reports a recovery summary
derived from the launch state's append-only lifecycle records. The summary
separates genuine worker failures from controller rotations and reports total,
progress-making, no-progress, model-work, and resumed generations.

Lifecycle records use typed start reasons and typed terminal reasons. Image
rollouts, stale-probe rotations, and operator requests remain controller
actions even when the terminated sandbox has a nonzero exit code; an exit code
is retained only as supporting evidence. A terminal transition is write-once
and idempotent. Older launch states are upgraded with unavailable lifecycle
facts set to `unknown` rather than inferred from an attempt number or exit
code.

Persisted worker snapshots use this separate stable exit taxonomy:

| Worker category              | Meaning                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `live`                       | A partial checkpoint from a worker that may still make progress.       |
| `finished`                   | The row and terminal persistence completed normally.                   |
| `capacity-unavailable`       | Required compute capacity was not available.                           |
| `authentication-failure`     | A required provider-scoped authentication path could not be used.      |
| `sandbox-exited`             | The sandbox stopped without a more specific safe classification.       |
| `unreachable`                | A required service or persistence operation could not be reached.      |
| `genuine-evaluation-failure` | The workflow finished with verified task failures, not an infra error. |

`status.json` is a replaceable partial or terminal snapshot. `result.json` is
terminal. Status and resume inspect both files and use the newest exact-attempt
generation, so a crash between the two atomic replacements cannot hide a
durable terminal result. Both contain only an allowlisted aggregate contract: monotonic write
generation, launch generation and attempt, whether model work started, node
counts, checkpoint age and digest, exit category, runtime, aggregate usage,
pricing provenance, and a generic diagnostic code. They never contain
source text, prompts, findings, provider output, exception text, or raw
artifacts. By default, `collect` copies `status.json`, `result.json`, the generic
worker lifecycle log, and an allowlisted `public-eval-diagnostics.json` when a
public worker reached the post-eval gate. It also writes
`recovery-lifecycle.json` and a privacy-safe analysis bundle whose recovery
totals are derived from those exact records. The lifecycle projection contains
only typed reasons, timestamps, aggregate node counts, fingerprints, and
hashed ledger/evaluation linkage; it excludes sandbox IDs, paths, logs,
prompts, findings, and provider output. The diagnostic contains only row
identities, terminal states, report-presence flags, diagnostic codes, exact
launch lineage, and a bounded failed-node projection (node ID, status, timeout
flag, and allowlisted failure category or code). It never contains messages,
paths, findings, or provider output.
This lets failed Actions runs publish useful lifecycle evidence without
repeating paid model work. Investigate arbitrary sensitive run data on the
private volume under the repository's normal access controls. Collection validates each contract and
generic log line before writing locally and refuses pre-hardening or malformed
volume artifacts.

Public EVMBench and Ultrafuzz-bench targets use a separate explicit contract.
For those old open-source projects, `collect --public-results --config <path>`
additionally copies the scored eval generation plus `report.md` and the
schema-validated `report.json`. The latter's `issues` array is the sole terminal
finding authority. The bundle also embeds the exact
`public-eval-diagnostics.json` sidecar under `eval/`, so report-backed genuine
task failures remain verifiable when the generation is published to history.
The bundle validates a fixed path allowlist, byte limits, canonical base64,
unique paths, sizes, SHA-256 hashes, exact launch and diagnostic lineage,
score-ready lifecycle evidence, report/run/score identity joins, complete
per-row report files, and the absence
of generic or exact injected secrets before any file is extracted or uploaded.

This public mode assumes the pinned benchmark repositories are trusted inputs.
Its hashes and lineage checks detect corruption, stale results, and accidental
raw-secret publication; they are not a cryptographic attestation boundary
against benchmark or model code deliberately encoding a credential. Do not use
`--public-results` for untrusted targets. Keep those results on the private
volume and use the ordinary sanitized aggregate collection path instead.

## Run the opt-in real-Modal smoke

The smoke is a dedicated cloud command, not part of `test`, and has no
environment toggle. Build and publish the current production image first, then
run each provider independently so one authentication path is never a
prerequisite for the other:

```bash
pnpm --filter @ultrafuzz/modal smoke -- --provider openai
pnpm --filter @ultrafuzz/modal smoke -- --provider anthropic
pnpm --filter @ultrafuzz/modal smoke -- --provider deepseek
pnpm --filter @ultrafuzz/modal smoke -- --provider kimi
```

Each invocation uses the published production image and its installed compiled
smoke entrypoint with a tiny generic state fixture. It checks the selected
subscription-auth path, or the isolated `DEEPSEEK_API_KEY` staging path for
DeepSeek, without copying another provider's credential, asserts
the worker is non-root, writes to a Modal Volume, terminates the first sandbox
after one unit completes, resumes on that same volume, verifies the completed
unit was not repeated, and races two continuation requests to prove that
exactly one owns the launch. The temporary volume is closed after the run, and
the command prints only boolean checks and aggregate counts.

The smoke lane intentionally does not implement benchmark runner recovery,
worker checkpointing, or result classification. Those core integrations must
land from their owning lanes; a smoke failure must remain a blocker rather than
being bypassed with a test toggle or a smoke-only runner branch.

The Modal entrypoint stages mounts and runtime-only credentials as root, then
changes ownership of only those run-scoped paths and executes the worker as the
image's non-root `ubuntu` user. This is required for unattended Claude Code
runs because its skip-permissions mode cannot run with root privileges.

## Toolchain image

The runner image includes Foundry (`forge`, `cast`, and `anvil`), recon-fuzzer,
`recon-generate`, Slither, and `covg-eval`. recon-fuzzer is the only fuzzing
backend, so Echidna and Medusa are not installed. The equivalent standalone
image definition is in `packages/modal/Dockerfile`.
