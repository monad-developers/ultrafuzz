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
timeout_seconds = 1800

[execution.providers.modal]
app = "ultrafuzz"
image = "ultrafuzz"
credential_env = ["YOUR_PROVIDER_ID_VARIABLE", "YOUR_PROVIDER_SECRET_VARIABLE"]

[execution.nodes.project-discovery.resources]
cpu = 8
memory_mib = 16384
timeout_seconds = 2400
```

`credential_env` identifies the two host variables used by the Modal client.
Values are read only when configuration is resolved and when a sandbox is
launched or cleaned; values are not serialized into run configuration,
handoff archives, tags, errors, or logs. API-key agent credentials are injected
through a per-launch Modal Secret. Subscription-based agent authentication is
not supported by cloud node execution.

Node overrides use logical topology node IDs and are applied after model and
strategy fan-out, so every concrete attempt derived from that logical node
receives the override. Unknown node IDs fail validation before launch.

## Execution and Retry Model

Each expanded agentic attempt maps to one Smithers sandbox node. A new Modal VM
is created for its first execution and for every retry. The task and its
artifact-contract verifier run in that same VM; the controller independently
verifies the published artifacts before dependent nodes can start.

The controller uses stable, bounded provider tags derived from the run and
attempt identities. On resume it reattaches to one matching live sandbox. If a
worker published its result before the controller stopped, the replacement
sandbox checks the durable result first and does not execute the attempt again.
Multiple live sandboxes for one attempt are rejected instead of guessed at.

Cancellation terminates the current sandbox. Worker failures and timeouts are
normalized to provider-scoped workflow errors, then Smithers applies the
existing node retry policy with a fresh VM.

## Handoff Contract

The cloud input is a clean immutable archive of the controller's committed
`HEAD`, augmented only with the generated workflow, generated agent adapters,
and durable run evidence needed by declared dependencies. Workspaces and logs
are excluded. Symlinks, hard links, special files, traversal, and paths outside
the project are rejected.

Dependency artifacts keep their existing producer directories. Fan-in nodes
receive the collection of those declared artifact snapshots; Ultrafuzz never
merges dependency workspaces or silently chooses one producer's tree.

The worker publishes its artifact and workspace bundle to a run-scoped Modal
Volume. It writes to a temporary namespace, computes a SHA-256 digest, renames
the complete bundle into place, and flushes the volume. The controller verifies
the digest and filesystem shape before replacing local attempt directories.
Downstream nodes therefore see either the prior complete publication or the new
complete publication, never a partially copied result.

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
