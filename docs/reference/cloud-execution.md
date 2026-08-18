# Cloud Node Execution

Ultrafuzz can run every concrete agentic attempt in an isolated cloud sandbox
while leaving planning, expansion, meta nodes, reporting, and lifecycle control
on the operator machine. Local execution remains the default.

## Configure Modal

Build the candidate image as described in
[Run Evals on Modal](../how-to/run-evals-on-modal.md#build-and-launch), then
select it in `ultrafuzz.toml`:

```toml
[execution]
mode = "cloud"
provider = "modal"
retention_days = 30

[execution.resources]
cpu = 4
memory_mib = 8192
timeout_seconds = 3600

[execution.providers.modal]
app = "ultrafuzz"
image = "ultrafuzz"
credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]

[execution.nodes.project-discovery.resources]
cpu = 8
memory_mib = 16384
timeout_seconds = 2400
```

`credential_env` is fixed to `["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]`, the two operator-owned host variables used by the Modal client. Provider routes selected through acknowledged environment variables are supported; host provider-home route files are rejected during cloud planning because they are not transported to Modal.
Values are read only when configuration is resolved and when a sandbox is
launched or cleaned; values are not serialized into run configuration,
handoff archives, tags, errors, or logs. API-key agent credentials are injected
through a per-launch Modal Secret. Subscription-based agent authentication is
not supported by cloud node execution.

An OpenRouter task uses the `api_key_env` configured for `OpenRouterAgent`
(`OPENROUTER_API_KEY` by default). Only that named credential is forwarded for
the task; the provider identity and exact catalogue model ID remain in task and
Modal provenance, while the key value does not. The sandbox uses the same
official `https://openrouter.ai/api/v1` route as local execution.

Node overrides use logical topology node IDs and are applied after model and
strategy fan-out, so every concrete attempt derived from that logical node
receives the override. Unknown node IDs fail validation before launch.

## Execution and Retry Model

Each expanded agentic attempt maps to one Smithers sandbox node. Cloud execution
currently accepts only a one-rung model chain (`same_agent_attempts = 1` with no
applicable fallback). Planning rejects longer chains before creating run state;
this avoids running nominally isolated retry rungs in one VM or sharing sibling
agent credentials. The task and its artifact-contract verifier run in the same
VM; the controller independently verifies the published artifacts before
dependent nodes can start.

The image installs a root-owned, non-writable `/usr/local/bin/ultrafuzz`
launcher for the same source build under `/opt/ultrafuzz`. Before model work,
the worker runs `ultrafuzz json validate` on a real known-valid fixture and
checks the registered schema ID, schema SHA-256, bundle SHA-256, and validator
build returned by the command. A missing, writable, shadowed, or mismatched
launcher/schema is a setup failure; the worker does not spend model tokens with
another validator.

The controller uses stable, bounded provider tags derived from the run and
attempt identities. On resume it reattaches to one matching live sandbox. If a
worker published its result before the controller stopped, the replacement
sandbox checks the durable result first and does not execute the attempt again.
Multiple live sandboxes for one attempt are rejected instead of guessed at.

Modal workers run on Linux and require procfs to remain mounted at `/proc`.
Before invoking Smithers, the worker opens the canonical sealed execution
generation and passes the child a `/proc/<worker-pid>/fd/<descriptor>` path.
Custom images must preserve that procfs view; the worker fails closed when the
cross-process descriptor anchor is unavailable.

Cancellation terminates the current sandbox. Retryable provider failures and
timeouts become provider-scoped workflow errors. Automatic model retries remain
local-only until each cloud retry can be projected to a fresh VM with a sealed
per-rung credential boundary. Once an agent session returns, a missing or
schema-invalid required artifact is terminal. It does not trigger a correction
turn, full-node model retry, or compatibility recovery.

`resume` keeps the same workflow run and execution generation, so live attempts
are reattached and proven publications are reused. `--reset-node` advances a
durable execution generation before resetting the selected node and its
dependents; only tasks Smithers actually resets run again, and those tasks
cannot reuse a pre-reset publication. `replay` and `fork` use the new workflow
run ID returned by Smithers, which gives newly executed tasks a distinct
provider namespace while preserving checkpoint lineage for completed tasks.

## Handoff Contract

The cloud input is a clean immutable archive of the controller's committed
`HEAD`, augmented only with the generated workflow, the current rendered
prompt, generated agent adapters, and artifact directories of declared
dependencies. Current-attempt output, unrelated sibling output, workspaces,
logs, and other run evidence are excluded. Symlinks, hard links, special files,
traversal, and paths outside the project are rejected. The controller records a
SHA-256 identity for the archive and the worker verifies it before validated
streaming extraction.

Dependency artifacts keep their existing producer directories. Fan-in nodes
receive the collection of those declared artifact snapshots; Ultrafuzz never
merges dependency workspaces or silently chooses one producer's tree.

The worker publishes its artifact and workspace bundle to a run-scoped Modal
Volume. It writes to a temporary namespace, computes a SHA-256 digest, renames
the complete bundle into place, and flushes the volume. The controller verifies
the digest and filesystem shape before replacing local attempt directories.
Downstream nodes therefore see either the prior complete publication or the new
complete publication, never a partially copied result.

Publication requires the current `ultrafuzz.artifact-verification.v2` marker and
copies only the exact digest-bound files it names. There is no markerless legacy
mode, manifest-v1 upgrade, artifact normalization, or fallback to a complete
directory copy. The controller then validates the corresponding
`ultrafuzz.artifact-manifest.v3` and its persisted schema bindings.

## Retention and Cleanup

Cloud run volumes are retained for the configured number of days as a lifecycle
policy and for recovery. The initial Modal provider stores this value in run
configuration; provider-side automatic expiry is not available, so operators
must schedule `ultrafuzz clean` within their retention policy.

`ultrafuzz clean --dry-run` performs no provider mutation. A confirmed clean
terminates active sandboxes for the selected run and deletes its volume before
removing local evidence. Without confirmation, active cloud runs are refused.
If provider cleanup fails, local evidence is preserved for recovery.

Use provider quotas and budgets as the hard cost boundary. CPU, memory, timeout,
retry count, topology fan-out, and workflow concurrency all multiply cloud
cost.
