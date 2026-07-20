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
the sandbox. Subscription credentials are copied directly from the host to
`/run/ultrafuzz-auth`; they are never placed in a Modal Secret, image,
environment variable, persistent volume, launch-state file, or log.

Non-secret run state is stored under `/data/<run-id>/<model>/workspace` on a
private Modal Volume. This preserves Ultrafuzz state, generated tests, reports,
and Smithers workspaces when a sandbox exits. Each sandbox has a 24-hour
timeout; eval watching stops two hours earlier so terminal persistence, scoring,
publishing, and volume flushing retain a bounded completion window.

Benchmark sandboxes reserve 16 physical CPU cores (32 vCPUs) and 32 GiB of
memory, with a 64 GiB memory limit. The generated target configuration permits
16 parallel agents and 32 parallel planned nodes so the workflow can use that
capacity.

## Authenticate locally

For subscription auth, log in before launching:

```bash
codex login
claude auth login
```

By default the runner reads `CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`) and `CLAUDE_CONFIG_DIR/.credentials.json` (normally
`~/.claude/.credentials.json`). API-key auth is also supported per model; only
the named host environment variable is forwarded through a Modal Secret.

## Create a private runtime config

The six-model matrix is built in, so `models` may be omitted. The default is
one run each for GPT-5.5, GPT-5.6 Sol/Terra/Luna, Claude Fable 5, and Claude
Opus 4.8, with `loops` fixed to `1`.

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
and explicitly disables invariant tests, differential tests, and dynamic
strategies. Repository variables `BENCHMARK_SMOKE_OPENAI_MODEL` and
`BENCHMARK_SMOKE_OPENAI_REASONING` can override that smoke runner without
changing its single OpenAI/Codex provider or its target and topology limits.

A manual `workflow_dispatch` runs the full lane instead. It evaluates every
checked-in EVMBench target with GPT-5.6 Luna at `high` and Claude Sonnet 5 at
`high` by default. Dispatch inputs `openai_model`, `openai_reasoning`,
`anthropic_model`, and `anthropic_reasoning` provide explicit overrides. The
full lane retains the production strategy set, including invariant,
differential, and dynamic strategies, with all three disable flags set to
`false`. Push events can never select this lane.

Both lanes use the standard Modal benchmark resources described above. Every
target row has a 3,600-second model-work watchdog. The smoke admits two rows at
a time; the full lane admits 20, keeping each checked-in cohort to two row
waves. Both modes use eight-way workflow concurrency so full rows can progress
through the complete production topology without serializing their agent work.
Scoring remains independent of the runner and always uses GPT-5.6 Sol at
`xhigh`.

`trials_per_variant` defaults to `1` when it is omitted, and both checked-in
lanes resolve to one trial. Increase it only deliberately: benchmark work and
cost multiply across every selected target, runner model, and trial.

Configure `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and `OPENAI_API_KEY` as
Actions secrets. Full dispatches additionally require `ANTHROPIC_API_KEY`;
automatic smoke runs do not. Public rows score from their local artifacts and
do not require a Braintrust reporting key. Modal receives only the provider
credential needed by a pair plus the OpenAI judge credential. It never receives
a GitHub token.

The worker verifies the exact candidate and target commits, obtains EVMBench
labels from the pinned public Frontier Evals revision, and uses the versioned
public Ultrafuzz-bench labels. Public target reports and normalized findings are
packed with SHA-256 and path validation and uploaded with 30-day retention. No
partial generation updates history: the trusted publisher verifies that the
exact producer attempt's launch and collection jobs both succeeded, and every
configured pair must finish and score before publication. Branch results remain
keyed to the exact pushed commit.

The compare-and-swap publisher validates the generation with the benchmark
policy from the exact candidate checkout, appends observations keyed to that
candidate commit, regenerates the charts, and updates the
`automation/eval-history` pull request. It retries a changed remote publication
tip and commits with `[ci skip]`, so chart-only publication does not start a new
benchmark run.

Set the optional `EVAL_HISTORY_PR_TOKEN` Actions secret to a repository-scoped
token that can create pull requests when organization policy prevents
`github.token` from doing so. Without that secret, publication falls back to
`github.token`. If policy still blocks PR creation, the workflow succeeds with
a warning, preserves the complete publication on `automation/eval-history`,
and adds a compare-and-open link to the job summary for manual completion.

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
`incompatible-checkpoint`.

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
public worker reached the post-eval gate. The diagnostic contains only row
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
```

Each invocation uses the published production image and its installed compiled
smoke entrypoint with a tiny generic state fixture. It checks the selected
subscription-auth path without copying the other provider's credential, asserts
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

The runner image includes Foundry (`forge`, `cast`, and `anvil`), Recon,
`recon-generate`, Echidna, Medusa, Slither, and `covg-eval`. The equivalent
standalone image definition is in `packages/modal/Dockerfile`.
