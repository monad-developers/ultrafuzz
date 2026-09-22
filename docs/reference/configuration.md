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
workspace_mode = "git-worktree"
default_timeout_seconds = 3600
workflow_deadline_seconds = 86400
controller_lease_seconds = 30

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
| `[execution]`                   | Local or provider-backed execution and node resource defaults.             |
| `[models]` and `[models.<id>]`  | Default model profile and model profile definitions.                       |
| `[retry]`                       | Bounded primary retries and opt-in ordered model fallback.                 |
| `[permissions]`                 | Trusted local execution posture and materialization defaults.              |
| `[invariants]`                  | Invariant selection policy and campaign durations.                         |
| `[triage]`                      | Triage quorum and panel size.                                              |
| `[eval]`                        | Eval suite defaults and reporting provider binding.                        |

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
| `keep_workspaces`           | boolean | Retain successful-run node workspaces instead of reaping them.              |
| `forge_guard_enabled`       | boolean | Prepend a run-scoped Forge resource-limit wrapper to worker `PATH`.         |
| `forge_vmem_limit_kb`       | integer | Forge virtual-memory ceiling in KiB. Defaults to 12 GiB.                    |
| `forge_rayon_threads`       | integer | Default Forge Rayon worker count when the caller does not already set one.  |
| `workspace_mode`            | string  | Must be `git-worktree`.                                                     |
| `default_timeout_seconds`   | integer | Default node timeout in seconds. The generated default is 3,600 (one hour). |
| `workflow_deadline_seconds` | integer | Maximum workflow wall time before the next synchronization cancels it.      |
| `controller_lease_seconds`  | integer | Lost-controller threshold used by the scoped renewable recovery supervisor. |

Other workspace modes are outside the product contract.

`max_parallel_agents` is the only concurrency limit the runtime enforces. It
bounds every task the workflow submits, not only agent tasks.

`max_dynamic_nodes` limits total generated nodes, not concurrently active
nodes. Dynamic work still uses `max_parallel_agents`; exceeding the generation
limit fails the run instead of silently dropping items. The selected value is
part of the durable expansion contract, so changing it requires a new or
explicitly incompatible run rather than changing an existing expansion on
resume.
Successful runs remove their generated workspaces by default. Setting
`keep_workspaces = true` retains them; dirty or unpushed workspaces are always
preserved by the workflow runner.

The Forge guard is enabled by default. When Forge is installed, Ultrafuzz
resolves the real executable before launch, writes an executable wrapper under
the run directory, and places that wrapper ahead of Foundry on worker `PATH`.
The memory limit and Rayon default are recorded in `config.resolved.toml` and
`run.json`. Set `forge_guard_enabled = false` to opt out, or raise
`forge_vmem_limit_kb` for intentionally larger jobs. A limited Forge process
exits through the normal task command path, so its diagnostics remain task
evidence without applying the limit to the workflow controller.

Every submitted workflow starts a run-scoped recovery supervisor. The
supervisor renews controller ownership through runner heartbeats and uses an
atomic claim before taking over expired ownership, so completed work is not
resubmitted. The workflow deadline is separate from per-node timeouts and is
checked whenever run state is synchronized by status, inspect, reporting, or
eval watchers.

## Execution

`execution.mode` defaults to `local`. Set it to `cloud`, select a supported
provider, and configure that provider to place every expanded agentic attempt in
a fresh sandbox. `retention_days` defaults to `30`. The default resource table
sets `cpu`, `memory_mib`, and a one-hour `timeout_seconds`; logical topology
nodes may override any resource in `[execution.nodes.<node-id>.resources]`.

Cloud provider configuration names credential variables but never stores their
values. Missing credentials, unsupported provider/auth combinations, invalid
resource bounds, and unknown override node IDs fail before workflow launch.
An inherited cloud resource timeout grows to fit the selected task timeout.
An explicit global `execution.resources.timeout_seconds` or per-node timeout is
a cap: the effective cap must contain the complete task or planning fails before
cloud submission. A per-node cap overrides the global cap. Existing explicit
caps remain deliberate when switching profiles; remove or increase a short cap
before running exhaustive's 16,200-second campaign task. Modal adds a further
1,800-second sandbox lifecycle reserve.

See [Cloud Node Execution](cloud-execution.md) for the Modal configuration,
handoff, retry, recovery, and cleanup contracts.

## Model Profiles

```toml
[models.default]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"
timeout_seconds = 3600
```

The profile named `default` is selected implicitly. Do not also define
`[models] default = "default"`: TOML cannot use `models.default` as both a
string and a table.

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
Keep cloud execution-resource timeouts at least as large as the effective agent
timeout so the provider sandbox does not end first.

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

Automatic retry chains are currently supported only for local execution. Cloud
planning requires one effective attempt until every retry rung can receive a
fresh sandbox and an isolated credential boundary. Local fallback across
different agent implementations is also rejected when any rung uses API-key
authentication; profiles on the same agent may safely select different models.

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
provider = "braintrust"

[eval.providers.braintrust]
api_key_env = "BRAINTRUST_API_KEY"
project = "ultrafuzz-evals"
```

| Key                 | Type   | Meaning                                                                       |
| ------------------- | ------ | ----------------------------------------------------------------------------- |
| `eval_config`       | string | Eval suite YAML used when `--suite` is omitted.                               |
| `ground_truth_root` | string | Machine-specific ground-truth directory; must resolve outside the repository. |
| `provider`          | string | Active eval reporter: `braintrust` or `none`.                                 |

Each `[eval.providers.<name>]` connection profile supports:

| Key           | Type   | Meaning                                                                                             |
| ------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `api_key_env` | string | Canonical key variable: `BRAINTRUST_API_KEY`.                                                       |
| `project`     | string | Provider project name for published experiments.                                                    |
| `endpoint`    | string | Optional HTTPS origin; non-canonical origins require an exact operator environment acknowledgement. |

Profiles name credential environment variables and never contain secret
values. An
unknown `provider` or a missing `[eval.providers.<name>]` profile is a config
error at `eval plan` time; a missing credential env var is an error at publish
time only, so `provider = "none"` keeps local eval runs working offline. The
experiment definition itself lives in the eval YAML — see
[Eval Suites](evals.md).

Reporter credentials are sent only to canonical provider origins by default.
For a self-hosted service, set the configured `endpoint` and independently set
`ULTRAFUZZ_EVAL_BRAINTRUST_TRUSTED_ENDPOINT` to that exact origin. Redirects are
rejected; reporter requests have a 30-second timeout and a 1 MiB response limit.

## Environment Overrides

| Variable                                | Effect                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ULTRAFUZZ_MAX_PARALLEL_AGENTS`         | Positive integer override for `run.max_parallel_agents`.                                                                                                                                                                                                       |
| `ULTRAFUZZ_AGENT_ENV_ALLOWLIST`         | Extra workflow inputs; credential-like names or values are provider-route scoped.                                                                                                                                                                              |
| `ULTRAFUZZ_OUTPUT_DIR`                  | Project-local override for `run.output_dir`.                                                                                                                                                                                                                   |
| `ULTRAFUZZ_KEEP_WORKSPACES`             | Boolean override for `run.keep_workspaces`.                                                                                                                                                                                                                    |
| `ULTRAFUZZ_EVAL_PROVIDER`               | Override for `eval.provider`.                                                                                                                                                                                                                                  |
| `ULTRAFUZZ_EVAL_CONFIG`                 | Override for `eval.eval_config`.                                                                                                                                                                                                                               |
| `ULTRAFUZZ_PRICING_CATALOG_URL`         | Live model-pricing catalog URL, or `disabled`, `none`, or `off`.                                                                                                                                                                                               |
| `ULTRAFUZZ_PRICING_TIMEOUT_MS`          | Positive catalog request timeout in milliseconds, capped at 60 seconds.                                                                                                                                                                                        |
| `ULTRAFUZZ_OBSERVATION_SYNC_TIMEOUT_MS` | Optional deadline in milliseconds for the run-state refresh before `status`, `inspect`, `why`, and `stats`. Unset means no deadline (observers wait for full synchronization); a positive value bounds it, capped at 60000; `0` or `off` is the same as unset. |

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

Custom pricing catalogs must use HTTPS without credentials, query parameters,
or fragments and must resolve entirely to public addresses. The validated DNS
address is pinned for the request, redirects are rejected, and response bodies
are streamed with a 25 MiB limit before strict JSON parsing.

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
