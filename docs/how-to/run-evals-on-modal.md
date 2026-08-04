# Run evals on Modal

Ultrafuzz can run long evaluation rows in Modal sandboxes while reporting live
telemetry and scores to Braintrust. The runner uses the Modal TypeScript SDK;
Python is not required.

## Security and storage boundaries

Keep the benchmark config under an ignored path such as
`.ultrafuzz/modal/benchmark.json`, or outside the repository entirely. The
config contains the target and ground-truth locations and must not be
committed.

At launch time the runner copies the config to `/run/ultrafuzz-config` inside
the sandbox. Subscription credentials are never placed in a Modal Secret,
image, environment variable, launch-state file, or log. Cloud Codex and Claude
subscription authentication is rejected until a provider-backed refresh broker
is available. Kimi subscription authentication stages the selected Kimi Code
credential in a private per-row directory on a v2 Modal Volume. A disposable
child receives only a private copy. After execution, the untrusted child
credential is accepted only as a candidate refresh token: the trusted outer
controller exchanges it with Kimi OAuth and persists only the normalized
provider response.

Non-secret run state is stored under `/data/<run-id>/<model>/workspace` on a
private Modal Volume. This preserves Ultrafuzz state, generated tests, reports,
and Smithers workspaces when a sandbox exits. Each sandbox has a 24-hour
timeout; eval watching stops two hours earlier so terminal persistence, scoring,
publishing, and volume flushing retain a bounded completion window.

Benchmark sandboxes reserve 16 physical CPU cores (32 vCPUs) and 32 GiB of
memory, with a 64 GiB memory limit. The Modal benchmark worker override
configuration permits 16 parallel agents and 32 parallel planned nodes so the
workflow can use that capacity.

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
`api_key` config field. DeepSeek API-key runs require `DEEPSEEK_API_KEY`; the
worker forwards it only to the selected DeepSeek pair, whose generated adapter
routes Claude Code to DeepSeek's Anthropic-compatible endpoint.

For subscription auth, launch at most one Kimi row at a time. Use Kimi API-key
auth or serial launches when comparing multiple Kimi profiles, so OAuth
refresh-token rotation remains single-writer.

## Create a private runtime config

The eight-model matrix is built in, so `models` may be omitted. The default is
one run each for GPT-5.5, GPT-5.6 Sol/Terra/Luna, Claude Fable 5, Claude Opus
4.8, Kimi K3, and DeepSeek V4 Pro, with the default production strategy loop
count `loops = 3`.
Public CI launch configs intentionally set `loops = 1` for their smoke and full
lanes.

```json
{
  "schema_version": "ultrafuzz.modal.benchmark.v1",
  "run_id": "example-run",
  "target": {
    "repo": "https://example.invalid/subject.git",
    "ref": "full-commit-sha"
  },
  "ground_truth": {
    "repo": "https://example.invalid/reference-findings.git",
    "ref": "full-commit-sha",
    "file": "findings.yml"
  },
  "braintrust": {
    "project": "private-evals",
    "api_key_env": "BRAINTRUST_API_KEY"
  }
}
```

The ground-truth file must use the format accepted by `ultrafuzz eval score`.
The config schema intentionally accepts credential environment-variable names,
not inline credential values.

Audit reports with bracketed issue headings can set `ground_truth.format` to
`audit-markdown` and provide `ground_truth.expected_findings`. Conversion runs
inside the sandbox, and a count mismatch fails before evaluation starts.

For judges that require short-lived credentials, configure an HTTPS
`braintrust.judge_credential_endpoint`. The worker requests a model-scoped
credential in memory immediately before scoring and never persists it.

## Run the public benchmark workflow

The checked-in GitHub workflow uses Actions only to build the candidate and as a
control and collection plane; all benchmark and model compute runs on Modal.
Every non-deletion push to a branch in this repository launches the paid smoke
for the exact pushed commit, including pushes to branches whose pull requests
are still drafts. Fork pull-request events do not run this workflow. Repository
write access that is allowed to receive Actions secrets is therefore inside the
benchmark credential and cost trust boundary; protect that access and enforce
scoped provider credentials and hard provider/Modal budgets. A newer commit on
the same branch cancels its older smoke workflow. Each run installs and builds
the exact candidate commit before building its immutable Modal image.

Cancellation is latest-wins only within one branch. A separate recovery
workflow uses tooling from the trusted default branch, treats the exact
candidate checkout only as fingerprinted data, and semantically validates the
incomplete attempt's immutable pre-compute plan before giving termination code
Modal credentials. It recovers failed, timed-out, and cancelled generations.
Runs on different branches and independent full dispatches may overlap, so
provider and Modal budgets remain the hard aggregate cost boundary.

The smoke has exactly three targets: one Foundry target, one Hardhat target, and
one Vyper target. It defaults to GPT-5.6 Luna at `high`, uses one strategy loop,
and uses the dedicated `benchmarks/smoke-benchmark.yml` graph. One
medium-reasoning context node feeds four high-reasoning bug-finding strategies
in parallel; medium-reasoning dedupe and report nodes finish the row. Invariant,
differential, dynamic, and production-only review stages are absent from this
graph. Repository variable `BENCHMARK_SMOKE_OPENAI_MODEL` can override the
smoke model without changing its single OpenAI/Codex provider, fixed
high/medium reasoning split, or target and topology limits.

A manual `workflow_dispatch` requires a `benchmark_scope`. The default `full`
scope evaluates every checked-in EVMBench target with GPT-5.6 Luna at `high`,
Claude Sonnet 5 at `high`, Kimi K3 at `max`, and DeepSeek V4 Pro at `max` by
default. Dispatch inputs `openai_model`, `openai_reasoning`,
`anthropic_model`, `anthropic_reasoning`, `kimi_model`, `kimi_reasoning`,
`deepseek_model`, and `deepseek_reasoning` provide explicit full-lane
overrides. The full lane retains the production strategy set, including
invariant, differential, and dynamic strategies, with all three disable flags
set to `false`. Push events can never select this lane.

The `deepseek-v4-flash-smoke` scope is a fixed publication profile, not a
free-form model override. It runs only `deepseek-v4-flash` at `max` over the
same exact three-target smoke lane and GPT-5.6 Sol `xhigh` judge described
above. Recovery discovers its immutable `smoke` plan artifact instead of
assuming every manual dispatch is full, and automatic publication requires the
successful producer's exact scope marker, exactly one launch job, and the
trusted `deepseek` / `deepseek-v4-flash` / `max` profile all the way through
manifest, config, terminal evidence, and public bundle validation. Dispatch this
scope on `main`; feature-branch runs retain review artifacts but cannot publish
history automatically.

Here “fixed” describes the requested API profile and benchmark plan, not an
immutable provider release. DeepSeek documents `deepseek-v4-flash` as a moving
API alias, and its Anthropic-compatible response reports that alias without a
concrete backend version. Public diagnostics therefore retain the exact alias
observed on every invocation, mark its identity scope as
`provider-reported-alias`, and leave the provider version `unverified`. The
history model label and observation timestamp must not be read as an attestation
of immutable backend weights.

```bash
gh workflow run eval-benchmarks.yml \
  --ref main \
  -f benchmark_scope=deepseek-v4-flash-smoke
```

Both lanes use the standard Modal benchmark resources described above. Each
smoke target row has a 15,000-second model-work watchdog: the smoke graph's four
sequential agent stages may each use three 1,200-second attempts, with ten minutes
left for workflow transitions and final synchronization. Full-lane rows retain
the 3,600-second bound. The smoke admits all three
rows at a time; the full lane admits 20, keeping each checked-in cohort to two row
waves. Smoke uses four-way workflow concurrency; full uses eight-way concurrency
so production rows can progress without serializing their agent work.
Scoring remains independent of the runner and always uses GPT-5.6 Sol at
`xhigh`.

`trials_per_variant` defaults to `1` when it is omitted, and both checked-in
lanes resolve to one trial. Increase it only deliberately: benchmark work and
cost multiply across every selected target, runner model, and trial.

Configure `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and `OPENAI_API_KEY` as
Actions secrets. Full dispatches additionally require `ANTHROPIC_API_KEY` and
either `KIMI_API_KEY` or `MOONSHOT_API_KEY`, plus `DEEPSEEK_API_KEY`. The fixed
DeepSeek Flash smoke requires `DEEPSEEK_API_KEY`; automatic push smokes do not.
Set `KIMI_BASE_URL` as an Actions secret or variable only when the Kimi run
should use a compatible non-default HTTPS endpoint.
Public rows score from their local artifacts and do not require a Braintrust
reporting key. Modal receives only the provider credential needed by a pair plus
the OpenAI judge credential. It never receives a GitHub token.

The worker verifies the exact candidate and target commits, obtains EVMBench
labels from the pinned public Frontier Evals revision, and uses the versioned
public Ultrafuzz-bench labels. Public target reports and normalized findings are
packed with SHA-256 and path validation and uploaded with 30-day retention. No
partial generation updates history: the trusted publisher verifies that the
exact producer attempt's launch and collection jobs both succeeded, and every
configured pair must finish and score before publication. Branch results remain
keyed to the exact pushed commit.

Smoke publication also fails when any target row produces zero normalized
findings. This is a no-regression signal, not a synthetic canary: the workflow
must find and support a real issue from target source evidence.

The compare-and-swap publisher validates the generation with the benchmark
policy from the exact candidate checkout, appends observations keyed to that
candidate commit, regenerates the charts, and commits the exact publication
allowlist directly to `main`. It authenticates with the repository-scoped eval
history GitHub App, which has `Contents: read and write` and an explicit
`Always allow` exception in the default-branch ruleset. A changed remote tip is
rebuilt and retried before a normal fast-forward push. Publication-only history
and chart paths are excluded from the Modal push trigger, so the App commit
cannot recursively start another benchmark run.

Only a successful producer run whose candidate is still reachable from the
repository's default `main` branch may mint the publisher token. Feature-branch
smoke runs still execute and upload review artifacts, but their data is not
published; the successful `main` run after merge is the publication source.
Full-lane runs follow the same boundary by dispatching the Modal benchmark
workflow on `main`. There is no free-form artifact replay entry point.

Configure the App client ID as the `EVAL_HISTORY_APP_CLIENT_ID` Actions
variable and its private key as the `EVAL_HISTORY_APP_PRIVATE_KEY` Actions
secret. The workflow exchanges those credentials for a short-lived
installation token; the private key is never passed to Modal.

## Build and launch

```bash
pnpm install
pnpm --filter @ultrafuzz/modal build
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

Private collection remains aggregate-only. The public workflow opts into the
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
additionally copies the scored eval generation plus `report.md`, `report.json`,
and `findings.normalized.json`. It also embeds the exact
`public-eval-diagnostics.json` sidecar under `eval/`, so report-backed genuine
task failures remain verifiable when the generation is published to history.
The bundle validates a fixed path allowlist, byte limits, canonical base64,
unique paths, sizes, SHA-256 hashes, exact launch and diagnostic lineage,
score-ready lifecycle evidence, complete per-row report files, and the absence
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

The production benchmark entrypoint runs the trusted outer worker as root so it
can create and supervise a separate disposable Modal Sandbox for every model
attempt. A child receives no row Volume and has no `/data`; the controller
copies in only the exact task archive and selected model credential. The model
workflow runs as UID/GID 65532 with a clean environment, empty capabilities,
and `no_new_privs`. The root child supervisor kills any surviving agent-owned
processes before postflight. Results are copied into local quarantine, the child
is confirmed stopped, and only then are canonical artifacts published. Modal
controller and judge credentials are never forwarded to the child.

## Toolchain image

The runner image includes Foundry (`forge`, `cast`, and `anvil`), recon-fuzzer,
`recon-generate`, Slither, and `covg-eval`. recon-fuzzer is the only fuzzing
backend, so Echidna and Medusa are not installed. The equivalent standalone
image definition is in `packages/modal/Dockerfile`.
