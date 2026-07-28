# Cloud Node Execution

Ultrafuzz can run every concrete agentic attempt in an isolated cloud sandbox
while leaving planning, expansion, meta nodes, reporting, and lifecycle control
on the operator machine. Local execution remains the default.

## Configure Modal

Build the candidate image as described in
[Run Evals on Modal](../how-to/run-evals-on-modal.md#build-and-launch), then
select it in `ultrafuzz.toml`:

```toml
# Existing projects may omit this table; local remains the default.
[execution]
mode = "local"
```

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

The Smithers sandbox-provider interface is the provider-neutral architecture
boundary. Topology expansion and scheduling supply concrete attempt identity,
resources, immutable inputs, cancellation, and heartbeat callbacks; the Modal
adapter owns launch, reattachment, provider status, publication, and cleanup.
A later ECS adapter can implement the same boundary without changing graph or
fan-in semantics.

## Execution and Retry Model

Each expanded agentic attempt maps to one Smithers sandbox node. A new Modal VM
is created for its first execution and for every retry. The task and its
artifact-contract verifier run in that same VM; the controller independently
verifies the published artifacts before dependent nodes can start.

The controller uses stable, bounded provider tags derived from the run and
attempt identities. A new sandbox starts with an entrypoint that waits for a
content-addressed request, archive, and ready marker. The controller records the
sandbox ID before uploading those inputs. If it stops anywhere in that
handshake, resume reattaches to the exact live sandbox, verifies or completes
the same immutable upload, and never submits a competing VM.

Attempt evidence is scoped to both the Ultrafuzz run and the linked Smithers
controller-run identity. A fork or replay controller therefore cannot reuse a
successful publication from the original provider namespace. Result download,
directory replacement, digest verification, and the success commit are
serialized per attempt so concurrent recovering controllers converge on one
local publication.

If the original VM stopped after publishing but before the controller copied
the result locally, resume mounts the run volume read-only in a short-lived
inspector with no agent credentials or network access. A replacement attempt
is launched only after that inspector proves no valid publication exists.
Inspectors are not attempt VMs and are excluded from provider execution IDs.
Multiple live sandboxes for one attempt are rejected instead of guessed at.
Every attempt VM mounts only its own immutable subdirectory of the run volume;
a no-secret, no-network initializer creates that subdirectory before launch.
Concurrent controllers use the same deterministic initializer and reattach to
the winner rather than treating provider `AlreadyExists` as a failed attempt.
Sibling attempt publications are therefore not readable or writable from an
agent VM.

Cancellation terminates the current owned sandbox even when the new controller
reattached it rather than creating it. Worker failures and timeouts are
normalized to provider-scoped workflow errors, then Smithers applies the
existing node retry policy with a fresh VM.

`resume` keeps the same workflow run and execution generation, so live attempts
are reattached and proven publications are reused. `--reset-node` advances a
durable execution generation and commits the reset marker only after that
generation is durable; only tasks Smithers actually resets run again, and those
tasks cannot reuse a pre-reset publication. A resetting fork also advances the
generation before its controller resumes. `replay` and `fork` use the new
workflow run ID returned by Smithers, which gives newly executed tasks a
distinct provider namespace while preserving checkpoint lineage for completed
tasks.

## Handoff Contract

The cloud input is a clean immutable archive of the controller's committed
`HEAD`, augmented only with the generated workflow, the current rendered
prompt, generated agent adapters, and artifact directories of declared
dependencies. Current-attempt output, unrelated sibling output, workspaces,
logs, and other run evidence are excluded. Symlinks, hard links, special files,
traversal, and paths outside the project are rejected. The controller records a
SHA-256 identity for the archive and the worker verifies it before validated
streaming extraction.

Initialized submodules are recursively archived at the exact gitlink revisions
recorded by `HEAD`, including nested submodules. An absent checkout or revision
mismatch fails handoff construction instead of sending an empty gitlink
directory to the VM.

Tracked credential and agent-auth paths are removed even when they exist in
`HEAD`, including `.env` files, cloud/SSH/GitHub credentials, package registry
tokens, and private agent state. Explicit `.env.example`, `.env.sample`, and
`.env.template` documentation remains allowed. The generated `.smithers`
directory is rebuilt from the narrow workflow/adapter allowlist rather than
copied from the commit.

The first archive, resolved request, and dependency-tree digests are cached
under the run root through a staged directory and atomic rename. The cache key
includes the controller run, task, attempt, and execution generation. An
interrupted cache publication is discarded and rebuilt; a complete cache is
immutable. A retry reuses those exact bytes only while the current dependency
digests still match the committed manifest. Dependency mutation fails closed,
and a replay, fork, or reset creates a fresh immutable input identity.

Dependency artifacts keep their existing producer directories. Fan-in nodes
receive the collection of those declared artifact snapshots; Ultrafuzz never
merges dependency workspaces or silently chooses one producer's tree. Evidence
binds each input digest to the exact producer attempt ID, so a count-equivalent
or wrong-parent fan-in is rejected.

The worker publishes its artifact and workspace bundle to a run-scoped Modal
Volume. It writes to a temporary namespace, computes a SHA-256 digest, renames
the complete bundle into place, and flushes the volume. The controller verifies
the digest and filesystem shape before replacing local attempt directories,
then records deterministic local artifact/workspace tree digests. A later
successful reuse rechecks those local digests; mutated or missing local output
is republished from the proven remote bundle. Downstream nodes therefore see
either the prior complete publication or the new complete publication, never a
partially copied result.

Before creating the result archive, the worker scans artifact and workspace
file names and contents for every injected agent credential value. A match
fails the attempt and deletes the temporary publication, so successful volume
state and later dependency handoffs cannot contain those credentials.

## Retention and Cleanup

Cloud run volumes are retained for the configured number of days as a lifecycle
policy and for recovery. Every provider access renews a local, controller-bound
expiry record. When a later access finds that record expired, it first proves
that the controller namespace has no live attempt, inspector, or initializer,
then deletes the exact Modal volume before renewing the policy. Explicit clean
remains the deterministic way to remove resources immediately.

`ultrafuzz clean --dry-run` performs no provider mutation. A confirmed clean
terminates active sandboxes and deletes volumes for the original, replayed,
forked, and evidence-discovered controller namespaces before removing local
evidence. Without confirmation, active cloud runs are refused. If any namespace
cleanup fails, local evidence is preserved for an idempotent retry.

`ultrafuzz cancel <run-id>` submits cancellation to the exact linked controller.
The provider abort path terminates fresh and reattached owned sandboxes, so a
cancelled attempt cannot continue remotely and publish after cancellation.

Successful public cloud-node benchmark workers write their sanitized evidence
bundle before forcing cleanup of every nested target run. Cleanup failures keep
the already-sealed bundle and fail the worker; a resumed worker validates the
bundle and retries the idempotent cleanup instead of repeating model work.
Cancelled or timed-out outer workflows reconstruct the exact nested controller
IDs from the immutable benchmark plan and sweep attempt VMs, inspectors, volume
initializers, and run volumes twice before declaring cleanup complete.

Use provider quotas and budgets as the hard cost boundary. CPU, memory, timeout,
retry count, topology fan-out, and workflow concurrency all multiply cloud
cost.

## Inspect Cloud Attempts

`ultrafuzz inspect <run-id>` includes a provider-neutral `cloud_attempts` array
in JSON mode. Human output shows each logical task, lifecycle state, retry
index, provider VM IDs, requested resources, provider-confirmed resolved
resources, handoff digest, resume/reuse flags, and cleanup state. The underlying
evidence lives at
`.ultrafuzz/runs/<run-id>/cloud-execution/attempts/`; malformed or symlinked
entries make inspection fail closed instead of silently disappearing.

Each record includes immutable handoff and request digests, exact dependency
producer IDs and input digests, requested/resolved resources plus provider
confirmation, provider execution lineage, remote and local publication digests,
transitions, sanitized terminal reason, and cleanup state. Credential values
and unrelated filesystem paths are never part of the public cloud evidence.
