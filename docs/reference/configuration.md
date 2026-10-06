# Configuration and Environment

Ultrafuzz has one root project config file:

```text
ultrafuzz.toml
```

Topology, prompts, references, runs, workspaces, and cache state live under
`.ultrafuzz/**`; they are not configured through alternate root files.

## Common Shape

```toml
schema_version = "ultrafuzz.config.v2"
audit_profile = "default"
dynamic_strategies_enumerator = 3

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = 4
max_dynamic_nodes = 2048
keep_workspaces = false
forge_guard_enabled = true
forge_vmem_limit_kb = 12582912
forge_rayon_threads = 1
friction_log_enabled = false
workspace_mode = "git-worktree"
default_timeout_seconds = 3600
workflow_deadline_seconds = 86400
controller_lease_seconds = 30
refresh_prompts_on_resume = true

[execution]
mode = "local"
retention_days = 30

[execution.resources]
cpu = 4
memory_mib = 8192
timeout_seconds = 3600

[models.default]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"
timeout_seconds = 3600

[retry]
same_agent_attempts = 3

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true

[invariants]
# Omit these keys to inherit the selected audit profile.
# Explicit overrides, if desired:
# property_priority_threshold = "high"
# invariant_testing_smoke_timeout = "10min"
# invariant_testing_fuzzer_timeout = "1h"

[triage]
quorum = 3
panel_size = 4
```

Unknown TOML keys fail validation. Strategy execution behavior belongs in
`.ultrafuzz/topology.yml`, not in TOML.

`schema_version` is an exact, intentionally breaking contract literal. Only
`ultrafuzz.config.v2` is accepted; Ultrafuzz does not alias, normalize, convert,
or repair older spellings such as `1.0`. The resolved camelCase JSON document is
closed by `packages/config/schema/resolved-config.schema.json`. Its registered
schema ID, per-schema SHA-256, and config-schema bundle digest identify the exact
contract used by the CLI and runtime.

## Top-Level Keys

| Key                             | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `schema_version`                | Config schema version string.                                              |
| `audit_profile`                 | Named effort/topology preset. Defaults to `default`.                       |
| `topology_path`                 | Optional project-local topology override that replaces a profile topology. |
| `strategy_loops`                | Optional positive strategy-loop override.                                  |
| `dynamic_strategies_enumerator` | Non-negative integer or `"unlimited"` used by dynamic-strategy prompts.    |
| `[project]`                     | Project paths.                                                             |
| `[run]`                         | Run output, parallelism, workspace, and timeout settings.                  |
| `[execution]`                   | Validated but no longer affects execution; `mode` must be `local`.         |
| `[models]` and `[models.<id>]`  | Default model profile and model profile definitions.                       |
| `[retry]`                       | Bounded primary retries and opt-in ordered model fallback.                 |
| `[permissions]`                 | Trusted local execution posture and materialization defaults.              |
| `[invariants]`                  | Invariant selection policy and campaign durations.                         |
| `[triage]`                      | Triage quorum and panel size.                                              |
| `[eval]`                        | Eval suite defaults and local reporting selection.                         |

See [Audit profiles](audit-profiles.md) for the generated catalog, packaged
topologies, effective-setting inspection commands, and precedence rules.

## Project

| Key    | Type   | Meaning                                                           |
| ------ | ------ | ----------------------------------------------------------------- |
| `repo` | string | Project-local target repository path. `.` means the project root. |
| `name` | string | Optional display name.                                            |

Project paths must be project-local relative paths. Absolute paths, traversal,
empty path components, and dot components fail validation.

## Run

| Key                         | Type    | Meaning                                                                     |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| `output_dir`                | string  | Project-local run output directory. Defaults to `.ultrafuzz/runs`.          |
| `max_parallel_agents`       | integer | Positive workflow submission concurrency default.                           |
| `max_dynamic_nodes`         | integer | Positive run-wide safety limit for runtime-generated topology nodes.        |
| `keep_workspaces`           | boolean | Keep every task worktree instead of deleting the disposable ones.           |
| `forge_guard_enabled`       | boolean | Prepend a run-scoped Forge resource-limit wrapper to worker `PATH`.         |
| `forge_vmem_limit_kb`       | integer | Forge virtual-memory ceiling in KiB. Defaults to 12 GiB.                    |
| `forge_rayon_threads`       | integer | Default Forge Rayon worker count when the caller does not already set one.  |
| `friction_log_enabled`      | boolean | Let agents record tooling roadblocks in a run-local friction log.           |
| `workspace_mode`            | string  | Must be `git-worktree`.                                                     |
| `default_timeout_seconds`   | integer | Default node timeout in seconds. The generated default is 3,600 (one hour). |
| `workflow_deadline_seconds` | integer | Workflow wall-time limit, checked only when a command syncs (see below).    |
| `controller_lease_seconds`  | integer | Lost-controller threshold used by the scoped renewable recovery supervisor. |
| `refresh_prompts_on_resume` | boolean | Re-render unfinished tasks' prompts on `resume`. Defaults to `true`.        |

Other workspace modes are outside the product contract.

A run's configuration is frozen when it launches, with one exception:
`refresh_prompts_on_resume` is never part of it. Every `resume` reads the key
from the project's current `ultrafuzz.toml`, so setting it to `false` also
keeps the prompts of a run already in flight, and it appears in neither the
run's `config.resolved.toml` nor its `smithers/resolved-config.json`. When
`ultrafuzz.toml` cannot be read, resume keeps the run's prompts and warns. With
the key `true` or absent, resume re-renders the prompts of the run's unfinished
tasks from `.ultrafuzz/prompts/**` and the packaged built-ins before it starts
the engine; see
[Change A Prompt Of A Running Campaign](../how-to/restart-continue.md#change-a-prompt-of-a-running-campaign).

`max_parallel_agents` is the only concurrency limit the runtime enforces. It
bounds every task the workflow submits, not only agent tasks.

`max_dynamic_nodes` limits total generated nodes, not concurrently active
nodes. Dynamic work still uses `max_parallel_agents`; exceeding the generation
limit fails the run instead of silently dropping items. The selected value is
part of the durable expansion contract, so changing it requires a new or
explicitly incompatible run rather than changing an existing expansion on
resume.

`workflow_deadline_seconds` accepts up to 604,800 (seven days).
`default_timeout_seconds` and `controller_lease_seconds` accept up to 86,400
(one day).

`workflow_deadline_seconds` is not a guaranteed wall-clock limit. Ultrafuzz
records `workflow_deadline_at` in run state when the run is created, and again
from each `replay`, `fork`, or `resume` that starts a controller (not one that
finds the run still active), but nothing enforces it on a timer: an
unattended run keeps executing, and incurring provider cost, past its deadline.
The deadline is checked only when a command synchronizes the run: `ultrafuzz
status` (including each `--watch` poll), `inspect`, `why`, and `stats`, plus
the dashboard's inspect action and the eval runner's poll loop. `ultrafuzz run`
does not check it. If the run is running or pending at the first
synchronization after the deadline, that synchronization requests cancellation
and, when the request succeeds, marks the run `timed-out` and appends a
`workflow-deadline-exceeded` event. A paused run is not cancelled: it executes
nothing, and resuming it records a new deadline. A failed request is reported as
a `WORKFLOW_DEADLINE_CANCEL_FAILED` warning and leaves the run active, and the
next synchronization requests cancellation again; a synchronization that fails
or is skipped (for example `WORKFLOW_STATE_SYNC_SKIPPED` or
`WORKFLOW_SYNC_IN_PROGRESS`) does not check the deadline at all. A run that
finished first keeps its terminal outcome, with no timeout record. To bound an
unattended run, run `ultrafuzz status <run-id> --json` periodically (for example
from cron) and act on the warnings in its `diagnostics` (plain `status` prints
them on stdout), or cancel it with `ultrafuzz cancel <run-id>`.
Workflow-side enforcement is tracked in
[#1110](https://github.com/monad-developers/ultrafuzz/issues/1110).

Ultrafuzz, not the workflow engine, deletes task worktrees. With the default
`keep_workspaces = false`, the first command that synchronizes a run after it
ends (`status`, `inspect`, `stats`, the dashboard or an eval poll) deletes, for
each task that succeeded, its worktree under `workspaces/<attempt>/`, the Git
registration and the `ultrafuzz/<run-id>/<attempt>` branch: the task's outputs
are already published under `artifacts/<attempt>/`. Everything else in that
worktree goes with it: `.ultrafuzz/`, the `artifacts/` mirror, the strategy
scratch directory `test/foundry/<node>/` (its verified tests are published as
`generated-tests/` companions, which `ultrafuzz materialize` writes back into a
tree), `foundry.lock` (a Forge byproduct) and any edit outside the declared
outputs and `workspace.patch`. To keep something, declare it as an output. A
task that did not succeed keeps its worktree while `artifacts/<attempt>/` inside
it holds a file, so a rejected output stays at
`workspaces/<attempt>/artifacts/<attempt>/`; a failed task that wrote no output
is deleted. `resume --retry-failed`, `--reset-node` and `fork` rerun a task and
replace its earlier output. With `keep_workspaces = true` nothing is deleted.
The value is fixed at launch, so changing it, or `ULTRAFUZZ_KEEP_WORKSPACES`,
for a `resume` has no effect. A deletion that fails is reported as a
`TASK_WORKTREE_REMOVAL_FAILED` warning, and the next command retries it.

The Forge guard is enabled by default. When Forge is installed, Ultrafuzz
resolves the real executable before launch, writes an executable wrapper under
the run directory, and places that wrapper ahead of Foundry on worker `PATH`.
The memory limit and Rayon default are recorded in `config.resolved.toml` and
`run.json`. `run.json` records the guard as active only when the workflow
engine keeps the wrapper on `PATH`. The engine keeps it only from
`<project>/.ultrafuzz/runs/<run-id>/safe-bin` on a path without symbolic
links, holding just the wrapper and not writable by group or others; launch,
`resume`, `replay` and `fork` restrict that directory's mode and remove
anything else from it. Otherwise, for example with a custom `output_dir`,
tasks run the real Forge, and the command that starts the controller reports
a `FORGE_GUARD_INACTIVE` warning. Set
`forge_guard_enabled = false` to opt out, or raise
`forge_vmem_limit_kb` for intentionally larger jobs. A limited Forge process
exits through the normal task command path, so its diagnostics remain task
evidence without applying the limit to the workflow controller.

The friction log is disabled by default. With `friction_log_enabled = true`,
every agent task is told to record Ultrafuzz, tooling, or instruction
roadblocks with [Frog](https://github.com/wevm/frog), pinned as a dependency of
`@ultrafuzz/runtime`, through `<run>/friction-bin/ultrafuzz-friction-log`. That
command runs the Frog of the Ultrafuzz install that rendered the workflow. It
accepts only `frog log`, with `--body`, `--severity`, `--label`, `--force` and
`--format`, and `frog list`, with `--format`, and refuses every other command
and option, such as publishing, `--update`, `--mcp`, `--cwd` and `--target`.
It also refuses the built-in flags of incur, Frog's CLI framework, such as
`--mcp` and `--help`, where an option value belongs, because incur acts on them
anywhere on the command line. It points Frog at `<run>/friction` and sets
`GIT_DIR` to a path that does not exist, so Git discovery never reaches the
target repository and Frog writes entries to
`<run>/friction/.agents/friction-log/<YYYYMMDDHHMMSS>-<slug>/friction.md`. It
unsets `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_API_URL`, Frog's Postgres store
settings (`FROG_DATABASE_URL`, `FROG_NAMESPACE`, `FROG_SCHEMA`) and `COMPLETE`,
which makes incur print shell completions instead of running the command, sets
`NO_UPDATE_NOTIFIER=1` so incur skips its update check, and gives Frog
`/dev/null` as stdin, so Frog never prompts or opens an editor.

The command guards against an agent misusing Frog by mistake and enforces
nothing. Agents run unsandboxed (see [Security](../security.md)), so
`<run>/friction` is where the command writes entries, not a boundary, and an
agent can run Frog, or anything else, directly. Nor does the command remove
GitHub credentials: Frog falls back to `gh auth token`, and although the
command points `GH_CONFIG_DIR` at a path that does not exist, gh still reads a
token kept in the system keyring. What keeps entries unpublished is that no
command the wrapper accepts publishes or reads from GitHub, and that agents are
told never to publish them.

Every task preparation creates `<run>/friction` and rewrites the command,
replacing any file or symlink at its path. A friction log that cannot be
prepared is reported on the workflow's stderr and never fails the task.
Agents are told to continue their task when a command fails, and never to
create, edit, or delete anything under `<run>/friction` themselves.

Frog is installed with the runtime whether or not the friction log is
enabled, but runs never copy it: the trusted CLI closure and the execution
snapshot leave it out. A disabled run renders byte-identical prompts.

Ultrafuzz never publishes entries. They are free-form agent text that the
artifact secret scan does not cover, and they can describe private targets, so
check them for credentials, such as RPC URLs with API keys, before publishing
anything. Read the Markdown files under `<run>/friction/.agents/friction-log/`
directly. To list them with Frog, run the Frog pinned in the Ultrafuzz
checkout, not one from the target checkout, with Git discovery fenced off:

```bash
GIT_DIR=/nonexistent node /path/to/ultrafuzz/packages/runtime/node_modules/frog/dist/bin.js \
  list --cwd /path/to/target/.ultrafuzz/runs/<run-id>/friction
```

Never use a bare `npx frog`, which can run the target's own
`node_modules/.bin/frog` or fetch an unpinned Frog. Frog refuses every `log`
and `list` while one entry is malformed, for example after an edit by hand; to
recover, delete that entry's directory.

The agent instructions are one paragraph appended after the shared trust
boundary. Their only variables are the command and entry directory, which are
the same for every task in a run, so enabled runs keep them inside the prompt
prefix all of the run's tasks share.

Every submitted workflow starts a run-scoped recovery supervisor. The
supervisor renews controller ownership through runner heartbeats and uses an
atomic claim before taking over expired ownership, so completed work is not
resubmitted. The workflow deadline is separate from per-node timeouts and is
checked only when run state is synchronized, as described above.

## Execution

Every agentic attempt runs locally in its own Git worktree. `ultrafuzz init`
still scaffolds an `[execution]` table, and it is still accepted and validated
so existing `ultrafuzz.toml` files and persisted run configs keep loading. None
of its settings changes how a run executes: `mode` must be `local`, and runs
only record `retention_days`, `[execution.resources]`, and
`[execution.nodes.<node-id>.resources]` in their resolved config, plan, and
task manifest.

Per-node cloud execution (`mode = "cloud"`, `provider`, and
`[execution.providers.modal]`) was removed; those settings fail validation with
`CONFIG_EXECUTION_CLOUD_REMOVED`, and `resume` refuses a run planned with
`mode = "cloud"` with `WORKFLOW_CLOUD_EXECUTION_REMOVED`. To use Modal, run the
whole campaign inside one sandbox: the `ultrafuzz-modal` eval runner does this
for benchmark rows (see [Run Evals on Modal](../how-to/run-evals-on-modal.md)).

## Model Profiles

```toml
[models.default]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"
timeout_seconds = 3600
```

The profile named `default` is selected implicitly. Setting `[models] default`
to any other profile ID is rejected: the built-in `[models.default]` profile
always exists, and TOML cannot use `models.default` as both a string and a
table. To make another profile primary, list it first in `[retry] agents`, for
example `agents = ["claude"]`.

Profile IDs must use safe ASCII identifier characters. Each profile supports:

| Key               | Type    | Meaning                                                                                      |
| ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| `agent`           | string  | Agent factory registered by the project registry generated by `ultrafuzz init`.              |
| `model`           | string  | Optional model selected for the workflow task and underlying generated adapter.              |
| `reasoning`       | string  | Optional reasoning effort passed to task-aware generated adapters such as the Codex adapter. |
| `timeout_seconds` | integer | Optional profile timeout metadata.                                                           |

If topology does not select `model_profiles`, an agentic node uses the
configured default profile only. Multi-model fan-out must be explicit in a
topology node or group default.

The effective agent timeout uses this precedence: a topology node or group
timeout, then the model profile timeout, then `[run].default_timeout_seconds`.
A topology pin wins even when it is shorter, so raising the profile or run
default does not reach a pinned node. `validate`, `doctor` and `run` report a
`TOPOLOGY_TIMEOUT_SHADOWS_DEFAULT` warning for each node or group pin below the
default it overrides. The packaged `goals`, `strategies`, `specialists` and `review`
groups pin 7,200 seconds, so a `default_timeout_seconds` above that warns for
them.

Generated defaults may include `[models] synthesized_default = true` when the
default profile was synthesized by the scaffold.

### OpenRouter profiles

The generated `OpenRouterAgent` table already configures API-key auth. Add a
model profile to route Codex model work through OpenRouter:

```toml
[models.openrouter]
agent = "OpenRouterAgent"
model = "openai/gpt-5.4"
reasoning = "high"
```

The endpoint is fixed to `https://openrouter.ai/api/v1`. Catalogue model IDs
are passed unchanged and are not checked against a static list; aliases that
start with `~` and suffix variants such as `:free` are valid. OpenRouter IDs
must be non-empty, no longer than 256 characters, and contain no whitespace or
control characters. Subscription auth is rejected.

An OpenRouter HTTP 429 is recovered for up to two minutes with exponential
backoff, a 30-second base-delay cap, and up to 25% jitter, while the caller's
total timeout continues to bound the whole operation. Before substantive
activity, the adapter can retry fresh. After Codex emits a substantive model,
tool, command, or file event, it continues only through the exact Codex thread
with `codex exec resume`; the original prompt is never replayed. Recovery fails
closed if no stable thread ID is available or a resumed process reports a
different ID. No new request starts at the recovery deadline; the last observed
provider rate-limit error is returned instead.

## Retry Policy

```toml
[retry]
same_agent_attempts = 3
agents = ["sol-xhigh", "gpt55-xhigh"]
```

`same_agent_attempts` is a positive integer counting the first primary attempt.
The shipped `default` profile uses three attempts. `smoke` and `low-cost` use
one, the maximum-effort `exhaustive` profile uses five, and `invariant-only` inherits three.
An explicit project `[retry]` value still overrides the selected audit profile.
The optional `agents` array contains unique existing model-profile IDs. Its
first entry is the default primary profile; later entries each receive one
fallback attempt in order. Neither `same_agent_attempts` nor the expanded
primary-plus-fallback chain may exceed 100 attempts. Profile names are opaque: `gpt55-xhigh` maps to
`model = "gpt-5.5"` and `reasoning = "xhigh"` only through its explicit
`[models.gpt55-xhigh]` table.

Fallback is disabled when `agents` is absent or empty. A topology node
`max_attempts` overrides its group, and a group value overrides
`retry.same_agent_attempts`. Automatic retries are generic Smithers-retryable
failures: Ultrafuzz neither parses the error nor changes the effective task
prompt. Each retry uses a fresh session and bounded exponential backoff.
Benchmark/eval rows reject
configured fallback so a row cannot silently change models.

Fallback across different agent implementations is rejected when any rung uses
API-key authentication; profiles on the same agent may safely select different
models.

## Permissions

```toml
[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true
```

The trust model is trusted local execution. Ultrafuzz does not expose a
TOML command allowlist, network allowlist, or sandbox policy. The durable
product boundary is reviewable prompts before launch, explicit reference sync,
durable artifacts, and explicit copy-only materialization.

`materialize_outputs_as_unstaged = true` records the expected materialization
posture: copied outputs are left as ordinary unstaged working-tree changes.

## Invariants

| Key                                | Type                       | Meaning                                                                                                                                            |
| ---------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `property_priority_threshold`      | `high`, `medium`, or `low` | Inclusive priority threshold for invariant implementation (`high` only; `medium` includes high and medium; `low` includes all three).              |
| `reference_expectation_selection`  | `priority` or `mandatory`  | `priority` keeps tagged properties subject to the priority threshold; `mandatory` also requires properties carrying `reference_expectations` tags. |
| `invariant_testing_smoke_timeout`  | duration string            | Bounded Recon deployment/compile smoke timeout rendered into invariant prompts; set it high enough for the target build path.                      |
| `invariant_testing_fuzzer_timeout` | duration string            | Duration of supervised Recon fuzzing over the shared selected property suite; excludes setup, smoke, shutdown, and artifact finalization.          |

Durations accept `s`, `min`, or `h`, such as `1800s`, `30min`, or `1h`.

The shipped default uses high priority, a one-hour campaign, and `priority`
selection. Exhaustive uses high and medium priority, a four-hour campaign, and
`priority` selection. The benchmark-specific `invariant-only` profile uses
`mandatory` selection. Reference tags remain provenance metadata even when the
property is excluded; reporting must distinguish unselected checks from
implemented checks.

The resolved campaign node and enclosing execution budgets must leave room for
the deployment smoke, shutdown, and artifact finalization as well as the full
fuzzing duration. Insufficient budgets fail validation before execution. See
[Audit profiles](audit-profiles.md) for the shipped timeout and retry envelope.

## Triage

```toml
[triage]
quorum = 3
panel_size = 4
```

`quorum` and `panel_size` must be positive integers, and quorum must not exceed
panel size.

## Eval

```toml
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = "/secure/eval-ground-truth"
provider = "none"
```

| Key                 | Type   | Meaning                                                         |
| ------------------- | ------ | --------------------------------------------------------------- |
| `eval_config`       | string | Eval suite YAML used when `--suite` is omitted.                 |
| `ground_truth_root` | string | Machine-specific ground-truth directory outside the repository. |
| `provider`          | string | Only `none` is supported; evaluation reporting stays local.     |

Precedence is `--provider` over `ULTRAFUZZ_EVAL_PROVIDER` over project settings.
Any other selected provider fails before credential access or workflow launch.
Generic provider-profile metadata remains readable in saved configurations, but
there is no external reporting transport and fresh defaults contain no profiles.
See [Eval Suites](evals.md) and the
[migration guidance](../how-to/run-evals.md#migrate-retired-reporting-settings).

Optional LLM judging is separate from reporting. It requires an explicit HTTPS
`ULTRAFUZZ_EVAL_JUDGE_URL` and a dedicated `ULTRAFUZZ_EVAL_JUDGE_API_KEY`.
Private targets additionally require `ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA=true`.
There is no default judge gateway or credential fallback; deterministic scoring
is local and remains the default.

## Environment Overrides

| Variable                                | Effect                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ULTRAFUZZ_MAX_PARALLEL_AGENTS`         | Positive integer override for `run.max_parallel_agents`.                                                                                                                                                                                                       |
| `ULTRAFUZZ_AGENT_ENV_ALLOWLIST`         | Extra workflow inputs; credential-like names or values are provider-route scoped.                                                                                                                                                                              |
| `ULTRAFUZZ_OUTPUT_DIR`                  | Project-local override for `run.output_dir`.                                                                                                                                                                                                                   |
| `ULTRAFUZZ_KEEP_WORKSPACES`             | Boolean override for `run.keep_workspaces`.                                                                                                                                                                                                                    |
| `ULTRAFUZZ_EVAL_PROVIDER`               | Override for `eval.provider`; only `none` is supported.                                                                                                                                                                                                        |
| `ULTRAFUZZ_EVAL_CONFIG`                 | Override for `eval.eval_config`.                                                                                                                                                                                                                               |
| `ULTRAFUZZ_PRICING_CATALOG_URL`         | Live model-pricing catalog URL, or `disabled`, `none`, or `off`.                                                                                                                                                                                               |
| `ULTRAFUZZ_PRICING_TIMEOUT_MS`          | Positive catalog request timeout in milliseconds, capped at 60 seconds.                                                                                                                                                                                        |
| `ULTRAFUZZ_OBSERVATION_SYNC_TIMEOUT_MS` | Optional deadline in milliseconds for the run-state refresh before `status`, `inspect`, `why`, and `stats`. Unset means no deadline (observers wait for full synchronization); a positive value bounds it, capped at 60000; `0` or `off` is the same as unset. |
| `ULTRAFUZZ_RUNNER_QUERY_TIMEOUT_MS`     | Timeout in milliseconds for each read-only runner query (`inspect`, `events`, `node`, `status`, `why`, `ps`, `timeline`, `snapshots`); one that exceeds it fails. Defaults to 120000, capped at 600000; `0`, `off`, or any invalid value means the default.    |

Boolean values accept `1`, `true`, `yes`, `on`, `0`, `false`, `no`, and `off`.

`ULTRAFUZZ_OBSERVATION_SYNC_TIMEOUT_MS` optionally bounds the run-state
synchronization that `status`, `inspect`, `why`, and `stats` perform before
their direct runner query. When it is unset there is no deadline: the command
waits for full synchronization, which is the only CLI path that converges local
run state from runner evidence. Set it to a positive number of milliseconds to
bound the refresh; values above 60000 are capped at 60000, and `0` or `off` is
the same as unset. When a configured deadline passes, the command reports a
`WORKFLOW_SYNC_DEADLINE_EXCEEDED` warning and continues with the local run
state, whose node states, attempt ledgers, and usage counts may then be stale.

A command or eval poll that finds another synchronization of the same run in
progress skips its own pass instead of running alongside it, reports
`WORKFLOW_SYNC_IN_PROGRESS`, and continues with the local run state. The lock
behind this lives in `.workflow-sync.lock` in the run directory; one left behind
by a killed process is taken over five minutes after its holder last refreshed
it. A pass that cannot create the lock, for example in a read-only run
directory, reports `WORKFLOW_SYNC_LOCK_FAILED` and writes nothing. During its
refresh, `status` reports a failed or malformed runner `inspect` or `events`
query, a lock it cannot take, and an unexpected synchronization error as
warnings, so it still shows the workflow runner's health and `--watch` keeps
polling. When nothing but the observation time changed,
`status` and any synchronization of a finished run leave `state.json` untouched;
any other synchronization of a live run still renews its controller lease.

Custom pricing catalogs must use HTTPS without credentials, query parameters,
or fragments and must resolve entirely to public addresses. The validated DNS
address is pinned for the request, redirects are rejected, and response bodies
are streamed with a 25 MiB limit before strict JSON parsing. Whether the
catalog is available, disabled, or unreachable, accounting prices a packaged
default model the catalog leaves unpriced at the versioned
[fallback list prices](artifacts-reports.md#spend-pricing) and records them in
`pricing_catalog.fallback`; any other model without a recorded cost stays
unpriced.

## Completion policy

`[run].completion_policy` accepts `"best-effort"` (the default) or
`"require-complete"`. `ultrafuzz run --require-complete` selects strict completion
for one run. The saved policy determines whether incomplete coverage makes the
terminal run unsuccessful. Both modes retain the configured retry counts and
attempt eligible agent-written reporting. A failed report agent leaves report
availability unavailable; no replacement report is synthesized. Custom
topologies keep their declared group failure policies.

`ultrafuzz report --require-verified` is independent: it requires verification of
an available agent-written report, not complete execution coverage.

## Resolution Order

1. Packaged defaults from `packages/config/defaults.toml`.
2. Selected audit profile.
3. Project `ultrafuzz.toml`.
4. Supported environment overrides.
5. Runtime overrides from the CLI.

The user-authored TOML contract remains `ultrafuzz.config.v2`: adding the
optional `[retry]` table does not invalidate existing project files. The
redacted operator-facing resolved config is persisted for each run as
`config.resolved.toml`, with restore metadata in `config.redactions.json`. The
unredacted workflow control contract is serialized once as camelCase JSON,
identified as `ultrafuzz.resolved-config.v4`, validated against
`urn:ultrafuzz:schema:config:resolved-config:4`, and published
byte-for-byte as `smithers/resolved-config.json` before it is sealed into the
execution snapshot. Sealed readers run the same strict parser and schema; they
do not use historical fallbacks. That JSON document carries the audit-profile
resolution — catalog schema version, catalog digest, declared topology path,
profile settings, effective settings, per-setting origins, and overridden
settings — as typed fields of the same closed contract.

## Rejected Config Surfaces

The TOML schema does not accept backend, dashboard, sandbox, network,
tool-allowlist, strategy-definition, prompt-frontmatter execution, or reference
catalog keys. Put campaign graph behavior in `.ultrafuzz/topology.yml`, prompt
text in `.ultrafuzz/prompts/**`, and pinned reference metadata in
`.ultrafuzz/references.yml`.
