# Resume, Replay, Or Fork Runs

Use `resume`, `replay`, and `fork` to operate on the linked workflow run after
Ultrafuzz performs product checks. Use `cancel` when a run should stop for good.

## Find The Run

```bash
ultrafuzz ps --project /path/to/target-protocol
ultrafuzz inspect <run-id> --project /path/to/target-protocol
```

Run evidence lives under:

```text
.ultrafuzz/runs/<run-id>/
```

`inspect` shows product evidence and the linked workflow identity.

## Decide What To Do

Before resuming, replaying, or forking, find out what actually stopped the run:

```bash
ultrafuzz status <run-id> --project /path/to/target-protocol
ultrafuzz why <run-id> --project /path/to/target-protocol
ultrafuzz events <run-id> --project /path/to/target-protocol --since 30m
ultrafuzz node <run-id> <node-id> --project /path/to/target-protocol --attempts
```

`why` names the blockers and the action that clears each one. `events` shows the
linked workflow lifecycle log, which is separate from Ultrafuzz's own product
`events.jsonl`. `node` expands one node's attempts, retries, and timing; tool
payloads require an explicit `--tools`.

## Resume A Linked Run

Use resume when the linked workflow can continue from its current workflow
state:

```bash
ultrafuzz resume <run-id> --project /path/to/target-protocol
ultrafuzz resume <run-id> --project /path/to/target-protocol --max-concurrency 4
ultrafuzz resume <run-id> --project /path/to/target-protocol --refresh-controller
ultrafuzz resume <run-id> --project /path/to/target-protocol \
  --reset-node node:failed-task --max-concurrency 4
```

Resume sends the persisted workflow and same run ID to Smithers with workflow
change acceptance enabled. Smithers reuses its durable finished rows and runs
only unfinished or newly rendered downstream tasks. Ultrafuzz control seals,
link journals, controller generations, graph fingerprints, schema bindings,
and metadata projections do not authorize continuation, so runs created before
those records existed can still reach Smithers. Historical artifact bytes and
embedded run IDs are never rewritten.

Use `--refresh-controller` when continuation should render the currently
installed controller and stock adapters. The new source is retained beside the
historical source, and the same Smithers run is continued. An actively owned
workflow is not refreshed. Accepting changed workflow source transfers replay
determinism responsibility to Smithers and the operator; review the retained
source and Smithers workflow hash when that distinction matters.

Usage recorded before the continuation remains in the run's append-only usage
ledger. After synchronization, segment rollups remain attributable to their
checkpoint generations and the cumulative rollup includes every unique usage
event across the resumed run.

Completed node attempts remain in `attempts.jsonl` across every continuation.
`ultrafuzz inspect` derives its executed and reused attempt counts from that
append-only ledger rather than from a mutable lifecycle counter.

Use `--reset-node` to explicitly retry one failed workflow node and reset its
dependents before the linked run continues. Ordinary resume performs no reset,
timetravel, replay, or fork.

## Replay A Linked Run

Use replay when you want the workflow engine to replay the linked run from the
stored product evidence:

```bash
ultrafuzz replay <run-id> --project /path/to/target-protocol
```

Replay is a linked-workflow operation over existing run evidence. Use a fresh
`ultrafuzz run` when modified config, topology, prompts, or references should
define a new campaign.

## Fork A Linked Run

Use fork when you want a derived linked workflow from a checkpoint or reset
point:

```bash
ultrafuzz timeline <run-id> --project /path/to/target-protocol
ultrafuzz fork <run-id> --project /path/to/target-protocol --label retry-triage
ultrafuzz fork <run-id> --project /path/to/target-protocol --frame 12
ultrafuzz fork <run-id> --project /path/to/target-protocol --reset-node triage --max-concurrency 4
```

`timeline` lists the checkpoint frame numbers `--frame` accepts, and
`ultrafuzz snapshots <run-id>` lists the durability and workspace checkpoints
behind recovery. Both are read-only.

Fork delegates to the workflow engine after product checks and persists the
new linked workflow identity or lifecycle evidence.

## Cancel A Linked Run

Cancellation is terminal, unlike pause:

```bash
ultrafuzz cancel <run-id> --project /path/to/target-protocol
```

The engine accepts a durable cancellation request before the run stops, so the
command distinguishes the two. A submitted request reports `cancel-requested`
and leaves the product run nonterminal; a confirmed cancellation records the
canonical terminal `canceled` state. Rerun `cancel` to confirm a request that
was still in flight.

## When To Start Fresh

If you changed `ultrafuzz.toml`, `.ultrafuzz/topology.yml`,
`.ultrafuzz/prompts/**`, or `.ultrafuzz/references.yml` and want those changes
to define a new campaign, run validation and start a new run:

```bash
ultrafuzz validate --project /path/to/target-protocol
ultrafuzz references sync --project /path/to/target-protocol
ultrafuzz run --project /path/to/target-protocol
```

Sync references only when the run needs pinned references that are not already
present in the local digest-checked cache.

## Restart A Modal Evaluation Row

The commands above operate on a linked local workflow run. A Modal evaluation
row also has a sandbox lifecycle and a durable volume, so restart it through the
Modal runner instead of invoking `ultrafuzz resume` inside a replacement
sandbox.

Use `launch --mode resume` with the original private config, launch-state file,
and model selection. Resume reuses the same volume and completed workflow state;
if the recorded sandbox is still live, it remains the owner and no replacement
is launched. Use `launch --mode fresh` only to start an explicit new generation
after every sandbox in the current generation has stopped. Fresh mode clears the
generation's durable workspaces instead of reusing completed workflow state. Use
a new run ID when the previous generation and volume must remain available.

See [Run Evals on Modal](run-evals-on-modal.md) for the commands, worker status
taxonomy, sanitized result contract, and the dedicated real-cloud smoke.
