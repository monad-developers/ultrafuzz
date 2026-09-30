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
ultrafuzz resume <run-id> --project /path/to/target-protocol --retry-failed
ultrafuzz resume <run-id> --project /path/to/target-protocol \
  --reset-node node:failed-task --max-concurrency 4
```

Resume sends the persisted workflow and same run ID to Smithers with workflow
change acceptance enabled. Smithers reuses its durable finished rows and runs
only unfinished or newly rendered downstream tasks. Ultrafuzz control seals,
link journals, controller generations, graph fingerprints, schema bindings,
and metadata projections do not authorize continuation, so runs created before
those records existed can still reach Smithers. Historical artifact bytes and
embedded run IDs are never rewritten. Before it resets anything or starts the
engine, resume applies the project's current prompts to the tasks that have not
finished; see
[Change A Prompt Of A Running Campaign](#change-a-prompt-of-a-running-campaign).

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
dependents before the linked run continues. `--retry-failed` resets every failed
or stalled node, retrying a failed artifact verifier from its agent producer.
Ordinary resume performs no reset, timetravel, replay, or fork.

A task skipped because a prerequisite failed is not reused like a finished row:
the resumed workflow decides the skip again from the restored task states. It
stays skipped while the prerequisite is still failed, and runs once a reset lets
the prerequisite succeed.

Retrying a failed node of a `failure_policy: continue` group does not undo work
that already ran without it. A task that started before the retried node
verified keeps the result it produced without that node, and only tasks that
start afterwards read the new output. The retried node then counts as
succeeded, so the report's completion can read COMPLETE and a
`--require-complete` run can succeed, although those earlier tasks never read
its output. For a property lens, those are the property fan-in and everything
after it. A retried artifact verifier is different: resetting its agent
producer also resets every node that started after that producer's attempt, so
those nodes run again.

## Change A Prompt Of A Running Campaign

Edit the project's prompt under `.ultrafuzz/prompts/`, then resume the run:

```bash
ultrafuzz resume <run-id> --project /path/to/target-protocol
```

Every `resume`, with or without `--refresh-controller`, `--retry-failed` or
`--reset-node`, first applies the project's current prompts to every task of
the run that has not finished, before it resets anything or starts the engine.
It selects each prompt exactly as `ultrafuzz run` does, from
`.ultrafuzz/prompts/**` and the packaged built-ins, and renders it the way the
run's launch did, with the run's own config. A task has finished when the
workflow engine reports its agent `finished` and the resume does not reset it.
The refresh reaches:

- static tasks that have not run, that failed or were interrupted, and those
  that `--retry-failed` or `--reset-node` reruns, with the tasks that depend on
  them;
- the rendered prompts of generated children and of later nodes such as the
  final report, once their dynamic group has expanded;
- the template copies under `dynamic-prompt-templates/` from which every prompt
  not rendered yet is rendered, such as the children of a group that has not
  expanded.

A finished task keeps its `prompt.rendered.md`, the record of the prompt it
ran with. To rerun a finished task with the edited prompt, use
`resume --reset-node node:<attempt-id>`. A reset also reruns finished tasks
that merely started after the reset task; those keep their prompt. While the
workflow engine still reports the run active, resume refreshes nothing, and an
attempt that is running keeps the prompt it started with.

Resume reports what the refresh did, and none of it fails the resume:

- `PROMPTS_REFRESHED` (info) names the tasks whose prompts it rewrote and
  counts the template copies. It copies each file first to
  `.ultrafuzz/runs/<run-id>/prompt-history/<time>-<id>/`, at the file's path
  in the run, then replaces it atomically; `refresh.json` there lists every
  rewritten file with its old and new SHA-256.
- `PROMPT_REFRESH_REJECTED` (warning) names a prompt it did not apply, and why:
  `ultrafuzz run` would reject it, it does not render for one of its tasks, it
  names an artifact authority that a task was not compiled with, or it shares
  a template copy with another prompt whose new text differs. A prompt is
  applied to every task rendered from it or to none, and the other prompts
  still apply. Fix it and resume again.
- `PROMPT_REFRESH_SKIPPED` (warning) means it applied nothing, for example
  because the project's topology no longer matches the run's, or
  `ultrafuzz.toml` cannot be read. Change the topology only for a new run.

A prompt that renders now can still fail later: a typo in an item variable,
such as `{{item.goal_promt}}`, fails only when the group expands, and then only
the child's task, at the `assert-task-inputs` step. Fix the project prompt and
run `resume --retry-failed`.

### Edit A Run's Own Prompt Files

To edit a run's prompt files by hand instead, turn the refresh off first, or
the next resume renders the project's prompt over your edit:

```toml
[run]
refresh_prompts_on_resume = false
```

Resume reads this key from the project's current `ultrafuzz.toml`, so it also
applies to runs already in flight. With the refresh off, every engine hands the
agent the run's own file as it is: `resume` with or without
`--refresh-controller`, `--retry-failed` or `--reset-node`, and `replay` and
`fork`, which never refresh prompts. Nothing re-renders it or compares it with
the launch render, so the edit neither strands the run nor stops `status` from
synchronizing.

```text
.ultrafuzz/runs/<run-id>/artifacts/<attempt-id>/prompt.rendered.md
```

Edit the file in place and keep it a regular file: a symlink or a directory at
that path fails the task.

- A prompt that waits on a dynamic group, a generated child's or a later
  node's such as the final report, has no file until the group expands. Before
  then, edit the template copy under `dynamic-prompt-templates/` that
  `.ultrafuzz/runs/<run-id>/smithers/tasks.json` names: the task's
  `promptTemplatePath`, or, for the generated children of a group that has not
  expanded, the group's `templatePath` under `dynamic_groups`. A copy is
  rendered when the group expands; after that, edit the rendered files. A copy
  is named by the digest of its launch text and shared by every task that
  launched with the same text, such as the loop and model attempts of one node,
  so an edit to it reaches each of them that has not rendered yet.
- When `resume --retry-failed` reruns the source of a dynamic group, it
  withdraws the group's generated children and the rendered prompts that wait
  on the group, and those prompts render again from their template copies. To
  keep an edit across such a retry, make it in the template copy as well.
- Change the task text and keep the output-contract block, the
  `Validate against:`, `Validation command:` and `Contract validation command:`
  lines. The agent needs them, and they are checked only when a prompt is
  rendered, not when you edit it.
- A running attempt keeps the prompt it started with; the edit reaches the
  task's next attempt. `--reset-node` and `--retry-failed` restart the task's
  attempt numbers in the workflow engine, and each rerun attempt replaces the
  engine's record of the earlier attempt with the same number, including the
  prompt that attempt received. Run `ultrafuzz status` before the reset so that
  `attempts.jsonl` records the finished attempt, and keep a copy of the prompt
  file if you need to know what it received.
- A deleted static prompt is restored from its launch copy in
  `prompt-snapshots/` before the next engine starts, so it comes back without
  your edit. A deleted runtime prompt is rendered again from its template copy.
- A prompt that cannot be rendered, for example after a typo in a template
  copy, or a prompt file that is still missing or cannot be read, fails only its
  own task, at the `assert-task-inputs` preparation step, with the cause. Fix
  the file and run `resume --retry-failed`.

### Runs Launched By An Earlier Release

For a run launched by a release before this one, edit prompts only while the
run is stopped (`pause` it first), then resume it with this release, using
`resume --refresh-controller`. Until then, its original engine still reads
sealed copies of static prompts, so a static edit is lost, and still compares
runtime prompts, so a runtime edit stops the run. A plain `resume` continues
the run's launch workflow, which stops the whole run, instead of one task, when
a runtime prompt no longer renders, including one rendered from a template copy
that the refresh rewrote; with `--refresh-controller` the run continues on this
release's workflow instead. `replay` and `fork` of such a run keep running its
launch snapshot, and so behave like its original engine. That engine has also
removed the prompt file of every static task it started. Resume renders the
file again for such a task that has not finished; for a finished one it
restores the launch copy that `plan.json` names for the attempt
(`rendered_prompts[].rendered_prompt_snapshot_path`). To edit one by hand with
the refresh off, copy that launch copy to the attempt's `prompt.rendered.md`,
then edit it.

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
to define a new campaign, run validation and start a new run. To change the
prompt of a task in a run that has already launched instead, see
[Change A Prompt Of A Running Campaign](#change-a-prompt-of-a-running-campaign).

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
