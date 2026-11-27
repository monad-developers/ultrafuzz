# Configure and run Pareto

This directory is the complete skill. Copy it as a unit when using another agent
host. Python 3.11 or later is sufficient for rendering and assembly. Foundry and
the target's dependencies are needed only when the review actually builds or
tests code. There are no Python package dependencies or model API calls in the
scripts.

## Configuration

Copy `config.toml` to a per-review file. Fill `[target]` with the project name,
repository, full revision ID, existing absolute workspace path, workspace-relative
scope paths, and the threat model. The agent can derive these from the user's
request; it should ask only for missing material inputs. Review the supplied
snapshot, not another copy of the project. A source archive may have no `.git`
directory; record its trusted pinned revision rather than inventing one.

| Section | Controls |
| --- | --- |
| `workflow` | Hunter total and group repetitions, merge batch size, shard count, verifiers per shard, appeal reviewers and restoration limit, concurrency, retries, rejection vote threshold and evidence-length threshold. |
| `runtime` | Requested harness/model, reasoning effort, output-token limit, review/task/sandbox timeouts, CPU, memory, free disk, build threads and optional monetary cap. |
| `references` | Supplied prior-report paths and the separate permission to search for additional reports. Empty paths plus `allow_search = false` exclude prior reports. |
| `reporting` | Severities shown in the main findings sections. Other confirmed findings remain in an appendix. |

The default profile uses OpenCode/DeepSeek. Model choice and allocation
parameters are configurable. The default total is 86 hunters. The coordinator chooses
groups for the project. Default repetitions are five hunters per file group and
four per entry-point group; any allocation changes must be explicit in the saved
plan. The configurable rejection threshold defaults to two votes, and negative
evidence must contain more than ten characters. This is a syntax heuristic, not
an evidence-quality judgment.

The host supplies model access, delegation and execution controls. Configuration
does not make the Python tools enforce CPU, billing or provider limits. Record
the actual settings and any differences in `effective-runtime.json`. Use the
configured concurrency within the host's supported limit. Pass the build-thread
setting to build/test commands. The review timeout limits the whole coordinating
session; a child task cannot extend it. The sandbox timeout limits the worker's
lifetime. Do not silently substitute another model and
describe it as the configured profile. There is no mandatory budget or default
cost cap; a configured cap needs a host that can enforce it.

## Prepare and partition

Use absolute paths. These commands only prepare artifacts:

```bash
python3 /path/to/pareto-security-review/scripts/render.py prepare \
  --config /path/to/review.toml --out /path/to/run
```

Read the rendered coordinator prompt. It describes the partition-plan JSON
fields and the exact commands with this run's paths. Build the plan from source
structure, not suspected vulnerabilities. Give each in-scope source file one
primary file group. Add overlapping call-path groups with public/external entry
points and their dependencies. Save the plan before launching hunters.

The plan records the revision, scope, entry-point inventory, inventory limits,
file groups and entry-point groups. Each group records its purpose, files,
dependencies, relative effort and hunter allocation. Its total must match the
configuration. A partial entry-point inventory must have a stated limitation;
file coverage remains required. The tools check paths and assignments but do not
prove semantic completeness of the entry-point inventory.

```bash
python3 /path/to/pareto-security-review/scripts/render.py hunt \
  --config /path/to/review.toml --out /path/to/run \
  --plan /path/to/run/partition-plan.json
```

Give each named agent its complete rendered prompt. Task files describe work;
they do not execute it. Use the host's existing delegation mechanism. Keep each
hunter's reasoning and report independent. The coordinator tracks task delivery,
progress and bounded retries. It may restore a hunter's missing report from the
exact returned text; it must not fabricate verdicts or findings.

Task names are run-local labels. A host with generic subagents can pass the full
prompt to a fresh subagent and map its returned ID to that label. A host that
requires registered roles must make those roles available before execution; the
renderer does not register them or require a new agent runtime.

Use a fresh run directory for changed review settings or a changed plan. Repeating
an unchanged rendering step supports recovery without replacing completed agent
reports. Keep the skill directory free of target-specific configuration, reports
and generated tasks.

Changing only `reporting.include_severities` is a presentation change. Rerun
assembly with that filter to reformat the saved results; it does not require
another review or invalidate the existing verdicts. The report status records
the filter that was used.

## Merge, verify, appeal and assemble

Follow the rendered coordinator commands in order. The retained helper commands
are `coverage`, `shards` and `assemble`:

- `coverage` compares normalized report headings with merge coverage mappings.
  It does not prove that reports arrived or that every defect survived merging.
- `shards` sorts candidates by Solidity basename and candidate ID, then divides
  them into equal-sized groups. Related candidates remain adjacent; a group of
  same-file candidates can cross a shard boundary.
- `render.py verify` creates verifier tasks and their expected candidate/output
  assignments after sharding. Independent verifiers do not share results.
- `assemble --phase pre-appeal` writes a preliminary report and status sidecar.
  `render.py appeal` divides its rejected candidate IDs among appeal reviewers.
  An appeal output contains restorations or an explicit no-restoration result.
- `assemble --phase final` incorporates expected verifier and appeal outputs.
  One valid positive appeal still restores a candidate. Exceeding the configured
  restoration limit produces a warning; valid extra restorations are preserved.

Every assembly command requires the run manifest. The manifest names expected
outputs and assigned candidates. The helper reads those files rather than
counting arbitrary Markdown files as votes. It counts at most one result from
each assigned reviewer for a candidate. Conflicting duplicates, malformed
results and missing assigned reviews leave the affected review incomplete.
The manifest also binds verifier assignments to the candidate file's contents.
Changing a candidate after assignment makes assembly incomplete; old verdicts
cannot reject the revised candidate merely because its ID stayed the same.
Shards must match those candidates before verifier tasks are rendered. Appeal
assignments likewise bind to the preliminary report and verifier evidence; a
changed input requires a fresh run, preserving the original results.

The report groups findings by High, Medium and Low severity. It separately keeps
informational observations, rejected candidates and unresolved/unreviewed
candidates, with original evidence and verdicts. Retaining a candidate is not an
automatic verification claim. Severity comes from the highest finding verdict,
or from the candidate's label or Low fallback when no finding verdict exists;
the report states that source.

The report's `.status.json` sidecar records `complete`, missing outputs,
warnings, errors and candidate results. Exit code zero from assembly means the
report was written. Check `complete` before saying the review finished. For
example, one result from two assigned verifiers is an incomplete review, even
when the available result says `finding`. Keep partial reports after retries are
exhausted. An incomplete review does not require discarding completed work.

## Offline validation

From the repository root:

```bash
python3 -m unittest discover -s profiles/v2/pareto/skills/pareto-security-review/tests -v
```

The tests use synthetic local files. They do not compile a target, start an audit,
or call a model provider. Passing them validates artifact preparation
and deterministic report behavior, not security-detection performance.
