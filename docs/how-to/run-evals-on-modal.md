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

## Run the public post-main matrix

The checked-in GitHub workflow uses Actions only as a control plane. Every push
to `main` installs and builds the candidate, then builds an immutable Modal
image named for that commit and launches four independent sandboxes:

- GPT-5.6 Luna at `high` on EVMBench;
- Claude Sonnet 5 at `high` on EVMBench;
- GPT-5.6 Luna at `high` on Ultrafuzz-bench; and
- Claude Sonnet 5 at `high` on Ultrafuzz-bench.

Every pair has a 3,600-second model-work budget. Scoring is independent of the
runner and always uses GPT-5.6 Sol at `xhigh`. The ordinary main-push lane uses
the pinned smoke cohorts and caps every explicit topology node timeout to the
configured 900-second node budget, including the Kaden coordinator. The public Modal launcher rejects the unchunked full
cohorts before creating any sandbox: their matrix cannot fit the bounded
control-plane deadline. Run full suites through the generic eval path only after
splitting them into independently recoverable chunks.

Configure `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, and `BRAINTRUST_API_KEY` as Actions secrets. Modal receives
only the provider credential needed by a pair plus the judge credential. It
never receives a GitHub token.

The worker clones the exact candidate and target commits, obtains EVMBench
labels from the pinned public Frontier Evals revision, and uses the versioned
public Ultrafuzz-bench labels. Public target reports and normalized findings are
packed with SHA-256 and path validation. Actions uploads the four bundles with
30-day retention. No partial generation updates history: all four pairs must
finish and score before the workflow regenerates charts and updates the
`automation/eval-history` pull request with a `[ci skip]` commit.

Set the optional `EVAL_HISTORY_PR_TOKEN` Actions secret to a repository-scoped
token that can create pull requests when organization policy prevents
`github.token` from doing so. Without that secret, publication falls back to
`github.token`. If policy still blocks PR creation, the workflow succeeds with
a warning, preserves the complete publication on `automation/eval-history`,
and adds a compare-and-open link to the job summary for manual completion.

For a controlled issue #55 measurement, dispatch the workflow with
`paired-kadenzipfel`. It launches eight detached pairs: candidate and
`without-kadenzipfel` for each model × benchmark pair. The latter removes only
the pinned Kaden reference and its coordinator, on top of the ordinary smoke
exclusions. The workflow validates the paired lineage and includes
`kadenzipfel-ablation-comparison.json` and `.md` with quality, token, and cost
deltas in the same public artifact; ablation rows are intentionally excluded
from longitudinal history.

The comparison's token and cost fields come from the Ultrafuzz runner ledger.
Braintrust tracks the independent judge calls and Modal tracks sandbox spend;
all three are correlated offline by the immutable generation and eval-run IDs.

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
benchmark, lane, experiment, model, reasoning, and eval-run lineage all match
that config and the launch state. Private collection does not require a config.

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
artifacts. By default, `collect` copies only `status.json`, `result.json`, and the generic
worker lifecycle log; investigate sensitive run data on the private volume under
the repository's normal access controls. Collection validates each contract and
generic log line before writing locally and refuses pre-hardening or malformed
volume artifacts.

Public EVMBench and Ultrafuzz-bench targets use a separate explicit contract.
For those old open-source projects, `collect --public-results --config <path>`
additionally copies the scored eval generation plus `report.md`, `report.json`,
and `findings.normalized.json`. The bundle validates a fixed path allowlist,
byte limits, canonical base64, unique paths, sizes, SHA-256 hashes, exact launch
lineage, complete per-row report files, and the absence of generic or exact
injected secrets before any file is extracted or uploaded.

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
