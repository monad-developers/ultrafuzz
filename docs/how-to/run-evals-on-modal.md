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
    "repo": "https://example.invalid/private-target.git",
    "ref": "full-commit-sha"
  },
  "ground_truth": {
    "repo": "https://example.invalid/private-ground-truth.git",
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

The launch command writes an ignored, sanitized launch-state file under
`.ultrafuzz/modal/<run-id>/launch-state.json`. Use that file for status and
collection:

```bash
pnpm exec ultrafuzz-modal status --state .ultrafuzz/modal/example-run/launch-state.json
pnpm exec ultrafuzz-modal collect \
  --state .ultrafuzz/modal/example-run/launch-state.json \
  --output .ultrafuzz/modal/results
```

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
terminal. Both contain only an allowlisted aggregate contract: monotonic write
generation, launch generation and attempt, whether model work started, node
counts, checkpoint age and digest, exit category, runtime, aggregate usage,
pricing provenance, and a generic diagnostic code. They never contain
source text, prompts, findings, provider output, exception text, or raw
artifacts. `collect` preserves this boundary; investigate sensitive run data on
the private volume under the repository's normal access controls.

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
`recon-generate`, Echidna, Slither, and `covg-eval`. The equivalent standalone
image definition is in `packages/modal/Dockerfile`.
