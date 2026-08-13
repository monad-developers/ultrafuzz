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
max_parallel_nodes = 8
keep_workspaces = false
forge_guard_enabled = true
forge_vmem_limit_kb = 12582912
forge_rayon_threads = 1
workspace_mode = "git-worktree"
default_timeout_seconds = 1800
workflow_deadline_seconds = 86400
controller_lease_seconds = 30

[execution]
mode = "local"
retention_days = 30

[execution.resources]
cpu = 4
memory_mib = 8192
timeout_seconds = 1800

[models]
default = "default"

[models.default]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"
timeout_seconds = 1800

[retry]
same_agent_attempts = 1

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true

[invariants]
property_priority_threshold = "high"
invariant_testing_smoke_timeout = "10min"
invariant_testing_fuzzer_timeout = "1h"

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
| `schema_version`                | Exact config contract literal: `ultrafuzz.config.v2`.                      |
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
| `[invariants]`                  | Invariant prompt defaults.                                                 |
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
| `max_parallel_nodes`        | integer | Positive graph planning parallelism limit.                                  |
| `keep_workspaces`           | boolean | Retain successful-run node workspaces instead of reaping them.              |
| `forge_guard_enabled`       | boolean | Prepend a run-scoped Forge resource-limit wrapper to worker `PATH`.         |
| `forge_vmem_limit_kb`       | integer | Forge virtual-memory ceiling in KiB. Defaults to 12 GiB.                    |
| `forge_rayon_threads`       | integer | Default Forge Rayon worker count when the caller does not already set one.  |
| `workspace_mode`            | string  | Must be `git-worktree`.                                                     |
| `default_timeout_seconds`   | integer | Default node timeout in seconds.                                            |
| `workflow_deadline_seconds` | integer | Maximum workflow wall time before the next synchronization cancels it.      |
| `controller_lease_seconds`  | integer | Lost-controller threshold used by the scoped renewable recovery supervisor. |

Other workspace modes are outside the product contract.
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
sets `cpu`, `memory_mib`, and `timeout_seconds`; logical topology nodes may
override any resource in `[execution.nodes.<node-id>.resources]`.

Cloud provider configuration names credential variables but never stores their
values. Missing credentials, unsupported provider/auth combinations, invalid
resource bounds, and unknown override node IDs fail before workflow launch.
See [Cloud Node Execution](cloud-execution.md) for the Modal configuration,
handoff, retry, recovery, and cleanup contracts.

## Model Profiles

```toml
[models]
default = "default"

[models.default]
agent = "CodexAgent"
model = "gpt-5.5"
reasoning = "xhigh"
timeout_seconds = 1800
```

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

Generated defaults may include `[models] synthesized_default = true` when the
default profile was synthesized by the scaffold.

## Retry Policy

```toml
[retry]
same_agent_attempts = 3
agents = ["sol-xhigh", "gpt55-xhigh"]
```

`same_agent_attempts` is a positive integer counting the first primary attempt.
The optional `agents` array contains unique existing model-profile IDs. Its
first entry is the default primary profile; later entries each receive one
fallback attempt in order. Neither `same_agent_attempts` nor the expanded
primary-plus-fallback chain may exceed 100 attempts. Profile names are opaque: `gpt55-xhigh` maps to
`model = "gpt-5.5"` and `reasoning = "xhigh"` only through its explicit
`[models.gpt55-xhigh]` table.

Fallback is disabled when `agents` is absent or empty. A topology node
`max_attempts` overrides its group, and a group value overrides
`retry.same_agent_attempts`. Automatic retries are generic Smithers-retryable
failures: Ultrafuzz neither parses the error nor changes the prompt. Each retry
uses a fresh session and bounded exponential backoff. Benchmark/eval rows reject
configured fallback so a row cannot silently change models.

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

| Key                                | Type                       | Meaning                                                                                                                                  |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `property_priority_threshold`      | `high`, `medium`, or `low` | Inclusive priority threshold rendered into invariant prompts (`high` only; `medium` includes high and medium; `low` includes all three). |
| `invariant_testing_smoke_timeout`  | duration string            | Bounded Recon deployment/compile smoke timeout rendered into invariant prompts; set it high enough for the target build path.            |
| `invariant_testing_fuzzer_timeout` | duration string            | Timeout rendered into invariant testing prompts.                                                                                         |

Durations accept `s`, `min`, or `h`, such as `1800s`, `30min`, or `1h`.

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

| Variable                        | Effect                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `ULTRAFUZZ_MAX_PARALLEL_AGENTS` | Positive integer override for `run.max_parallel_agents`.                          |
| `ULTRAFUZZ_MAX_PARALLEL_NODES`  | Positive integer override for `run.max_parallel_nodes`.                           |
| `ULTRAFUZZ_AGENT_ENV_ALLOWLIST` | Comma-separated extra environment-variable names forwarded to workflow processes. |
| `ULTRAFUZZ_OUTPUT_DIR`          | Project-local override for `run.output_dir`.                                      |
| `ULTRAFUZZ_KEEP_WORKSPACES`     | Boolean override for `run.keep_workspaces`.                                       |
| `ULTRAFUZZ_EVAL_PROVIDER`       | Override for `eval.provider`.                                                     |
| `ULTRAFUZZ_EVAL_CONFIG`         | Override for `eval.eval_config`.                                                  |

Boolean values accept `1`, `true`, `yes`, `on`, `0`, `false`, `no`, and `off`.

## Resolution Order

1. Built-in root TOML defaults.
2. Project `ultrafuzz.toml`.
3. Supported environment overrides.
4. Runtime overrides from the CLI.

The redacted operator-facing resolved config is persisted for each run as
`config.resolved.toml`, with restore metadata in `config.redactions.json`. The
unredacted workflow control contract is serialized once as camelCase JSON,
validated against `urn:ultrafuzz:schema:config:resolved-config:2`, and published
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
