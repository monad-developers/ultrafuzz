# Ultrafuzz v0.2.0

Ultrafuzz runs a prompt on Modal, collects the agent's report and raw artifacts, and publishes a results PR. One prompt owns the audit strategy, including any native subagents. The runner handles launch, timeouts, one missing-report continuation, collection and publication.

This is a new release with no v0.1 compatibility. It has no workflow graph, Smithers runtime, evaluator, or autoresearch loop. External drivers can use the JSON CLI. The design discussion is [issue #1339](https://github.com/monad-developers/ultrafuzz/issues/1339).

## Setup

Use Bun, Git, Git LFS (for repositories that use it), the GitHub CLI and a Modal account. Authenticate GitHub on the host with `gh auth login`. Configure Modal through its normal host credentials or `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.

```sh
bun install
bun run build
bun dist/cli.js init
```

Edit `~/.ultrafuzz/ultrafuzz.toml`:

```toml
[defaults]
harness = "opencode"
model = "provider/model-id" # An OpenRouter model id; choose a model your harness supports.
audit_profile = "v2/property-specification"

[openrouter]
key_env = "OPENROUTER_API_KEY"

[modal]
app = "ultrafuzz-v2"
cpu = 4
memory_mib = 16384
timeout_seconds = 21600
# environment = "main"
# image = "im-..." # Optional prebuilt image with the same tooling.

[repositories.example]
url = "owner/source-repository"
results_repository = "owner/private-results-repository"
# scope = "src/"
```

Set the configured key in your shell environment. All three harnesses—Claude Code, OpenCode and Codex—use OpenRouter. Only that model key enters the worker. GitHub and Modal credentials stay on the host, which clones source and uploads a snapshot. There is no subscription authentication or credential refresh.

A scoped OpenRouter key with a credit limit per run or per operator is recommended. Ultrafuzz enforces timeouts, not monetary budgets. Network access is unrestricted. Results repositories must be private; minimal credential redaction is not a general data-loss prevention system.

## Run and inspect

```sh
bun dist/cli.js launch example --label properties-baseline --json
bun dist/cli.js status RUN_ID --json
bun dist/cli.js wait RUN_ID --json
bun dist/cli.js list --json
bun dist/cli.js collect RUN_ID --json
bun dist/cli.js cancel RUN_ID --json
bun dist/cli.js recover --json
bun dist/cli.js viewer
```

`launch` also accepts `--harness`, `--model`, `--effort`, `--profile`, `--timeout` (seconds), and `--key-env`. A label groups repeated configurations; each run still has a unique UTC id such as `20261103-120000-a1b2c3d4`. Each JSON command emits one object with a `schema` field. `status` and `wait` collect and publish terminal runs; failed publication is retried on the next observation. Explicit `collect` republishes idempotently. The client need not remain running after launch.

The loopback dashboard lists runs across all configured repositories, launches and cancels runs, and links results PRs. Configuration remains in files. It listens on `127.0.0.1:3000` by default.

Use `--home PATH` for an isolated workspace. The default is:

```text
~/.ultrafuzz/
  ultrafuzz.toml
  prompts/v2/<profile>/
  runs/<run-id>/run.json
  runs/<run-id>/staging/
  runs/<run-id>/collected/
  runs/<run-id>/artifacts/
```

Registry writes are atomic, under a short per-run lock. Observation and publication use a separate operation lock. Each run stores a secret-free record on its Modal Volume. `recover [RUN_ID]` restores missing local records from those Volumes, then `status` collects the results. Volumes are never deleted automatically. A driver interrupted during submission can reconcile the named sandbox with `status`; do not create a replacement run until its state is known.

## Profiles and inputs

| Profile | Deliverable | Input |
| --- | --- | --- |
| `v2/pareto` | `report.md` | Prompt content TBD; launch is refused until supplied. |
| `v2/property-specification` | `report.md`, with stable property IDs | Source repository |
| `v2/stateful-fuzzing` | `report.md` | Explicit existing properties report |

```sh
bun dist/cli.js launch example --label fuzz-baseline \
  --profile v2/stateful-fuzzing --properties PREVIOUS_RUN_ID

bun dist/cli.js launch example --label fuzz-custom \
  --profile v2/stateful-fuzzing --properties ./properties.md \
  --input reference=./supporting-notes
```

`--properties` accepts a file or a collected v0.2 run id. It is copied as an input named `properties`; the runner records its hash and source run. It never launches property specification automatically. Other inputs use the same mechanism, from a local path or repository snapshot. Input references are read-only to the harness.

A profile directory contains `profile.json`, `prompt.mdx`, `skills/` and optional native configuration under `config/`. `config/claude-code.json`, `config/opencode.json` and `config/codex.toml` are merged over generated harness configuration. Named subagents belong in those native configurations. The runner does not interpret their orchestration. Supported harnesses are declared in `profile.json`; incompatible launches fail before execution. MDX is submitted as text, not executed as JavaScript.

Additional native files go in `files/<harness>/`, which is copied into that harness's isolated configuration directory (for example, `files/claude-code/agents/reviewer.md`). Optional `config/opencode.env.json` and `config/claude-code.env.json` hold string-valued native flags such as `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` or `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. Claude fan-out profiles should set the latter to `"1"`; it is not a global default because it also disables background Bash. Credentials, configuration paths and provider routing remain generated by the runner.

`init` copies packaged profiles into the central prompts directory without overwriting existing files. New profile versions use new names. The run records the package version, profile name and digest of the actual installed profile/configuration/plugin files, which are also published under `raw/profile/`. Only bundled/profile skills are registered; audited repository agent customizations are excluded. Property guidance is original text linking to external references, without vendoring their licensed source.

Profiles write `report.md` only when finished. Intermediate notes go elsewhere. Stateful fuzzing receives a suggested wall-clock fuzzing budget of `min(4h, initial harness time / 3)` in its preamble; this is guidance for the prompt.

## Completion and timeouts

The sandbox timeout includes setup, execution, continuation and export. The minimum is one hour. The initial harness deadline is 30 minutes before the sandbox deadline; continuation stops 10 minutes before it. Every phase uses the same absolute deadline.

If the harness exits without a nonempty `report.md`, Ultrafuzz sends exactly one continuation to the same native session when a session id exists, the run was not cancelled, and at least five useful minutes remain. The continuation asks the agent to finish its original task and write the report. There is no manual resume/nudge command or Codex stop hook. Cancel sends SIGTERM, allowing export, with a five-minute hard-stop grace period.

`status: succeeded` means a nonempty report exists. `end` and `exit_code` separately describe execution, so a cancelled run can still have a delivered report. Missing usage or unknown estimated cost does not fail delivery. Costs are estimates with provenance, not invoices.

The OpenCode task guard remains a temporary workaround for empty/truncated native subagent results. It continues the affected child at most twice before reporting failure. It does not require tool calls or named reviewers. Removal depends on an upstream fix and a successful Pareto acceptance run; see [upstream #52378](https://github.com/anomalyco/opencode/issues/52378) and [#59051](https://github.com/anomalyco/opencode/issues/59051).

For comparable experiments, the automatic continuation is the only additional message. Operator prompts, forks, extra continuations, handed-over files or raised limits change the experiment; the runner does not police this policy.

## Results

Each run opens or reopens branch `ultrafuzz/<run-id>` in its configured private results repository, under `attempts/<label>/runs/<run-id>/`:

```text
run.yml
usage.yml
prompt.txt
raw/report.md
raw/agents/
raw/transcript.jsonl
raw/sessions/
raw/profile/
```

`run.yml` records source and actual cloned commit, profile/configuration digest, harness/version/model/effort, times, continuation, outcome and omissions. `usage.yml` records available tokens, estimated cost and its provenance. The source commit is recorded for traceability; the runner does not enforce a pinned revision.

Publication builds on the remote branch, replaces only its owned files, preserves files added by external tools, and never force-pushes. Text over 10 MiB is gzipped. Limits are 50 MiB per file and 200 MiB per run. Optional workspace output is trimmed first; corpus directories are excluded. Every omission is recorded. Reports, transcripts and profile/session evidence cannot be silently dropped: exceeding their limits fails publication, while original output remains on the Volume.

Redaction replaces known secret values and positively identified credential patterns, including validated BIP39 mnemonics, labeled private keys, Google API keys, Modal tokens and JWTs. Common development mnemonics and Anvil keys are allowed. There are no entropy scans, artifact sealing or signing protocols.

## Development and release validation

```sh
bun run check
```

The small test suite exercises lifecycle decisions, local Git publication, profile/input handling and stubbed harness processes. It does not substitute for live acceptance. The release PR must record a run id and results-PR link for each check on a small public source repository:

- Each harness and each available profile.
- A full Pareto run after its prompt is finalized.
- A deliberately missing report, including continuation after a timeout kill for Claude Code and Codex.
- Cancellation mid-run.
- Client exit after launch followed by detached collection.
- Publication failure followed by retry.
- Local registry removal followed by recovery from Modal.
- Chimera/recon smoke check on the pinned Foundry toolchain.

Autoresearch and evaluation live outside this package and can consume its CLI and result directories.
