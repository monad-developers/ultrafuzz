# Ultrafuzz v0.2 (experimental)

> **Experimental release (`0.2.0-experimental`).** Five real runs have completed on this runner, all with OpenCode on the Modal executor: three of the profile `v2/pareto` (a Foundry project, a Hardhat project and a Vyper project), and one each of `v2/property-specification-collaborative` and `v2/stateful-fuzzing` (the Foundry project). No real run has completed on Docker, or with Claude Code or Codex. No test calls a model. The offline tests use fakes, and the two live tests (one on a real Docker Engine, one on a real Modal account) use a stub harness. Expect failures, and expect the interface to change.

Ultrafuzz starts one security audit from one prompt and brings the agent's `report.md` back to your machine. A profile supplies the prompt and its skills. The agent harness (Claude Code, OpenCode or Codex) controls the audit and any subagents. The runner does the rest: launch, timeouts, one continuation when the report is missing, collection, and optional publication to GitHub.

The specification is [issue #1342](https://github.com/monad-developers/ultrafuzz/issues/1342). This release has no compatibility with v0.1. It has no workflow graph, no evaluator and no autoresearch loop.

## Status

In the code, with tests that call no model:

- The command line, the configuration file, the run registry and its locks.
- The Docker executor. Its unit tests use a fake `docker` command. One integration test uses a real Docker Engine and a fake harness; it runs in CI, not in `bun run check`.
- The Modal executor. Its unit tests use a fake client, and the real Modal client library with a stubbed connection. One live test uses a real Modal account and a stub harness. It passes there. It needs Modal credentials, so it runs by hand: not in CI and not in `bun run check`.
- The worker: prompt delivery, deadlines, one continuation, export. Its tests use fake harness commands.
- Local collection, redaction and the result package.
- GitHub publication. Its tests use a local Git remote and a fake `gh` command.
- Three profiles. The tests check that they load and stage. They do not run them.

Not done:

- Real runs have completed only with OpenCode on Modal: three of `v2/pareto`, one of `v2/property-specification-collaborative` and one of `v2/stateful-fuzzing`. No real run has completed on Docker, or with Claude Code or Codex.
- The Recon fuzzer does not start in the worker image. See [Tools in the worker image](#tools-in-the-worker-image).
- No real run has reached its time limit. The collection of such a run is not tested.
- No publication to a real GitHub repository.
- Treat the Docker executor as untested on a commit until the `docker` job of the Check workflow passes for that commit.

## Quick start with Docker

Docker is the default executor. You need no cloud account and no GitHub setup for a public target.

You need:

- A Linux x86-64 machine with Docker Engine. Your user must be able to run `docker`. The worker image builds for amd64 only.
- [Bun](https://bun.sh) 1.3 or later, and Git. Install Git LFS if the target uses it.
- An OpenRouter API key in an environment variable. All three harnesses use OpenRouter.
- At least the CPUs and memory that the `[docker]` table asks for (4 CPUs and 8192 MiB in the template). A launch fails when the Docker host has less.

Build and initialize:

```sh
bun install
bun run build
bun dist/cli.js init
```

`init` writes `~/.ultrafuzz/ultrafuzz.toml` and copies the profiles to `~/.ultrafuzz/prompts/`. It does not overwrite files that exist. Edit the configuration file. A Docker-only configuration looks like this:

```toml
[defaults]
executor = "docker"
harness = "opencode"
model = "provider/model-id" # An OpenRouter model ID that your harness supports.
audit_profile = "v2/property-specification-collaborative"
# effort = "high"

[docker]
cpu = 4
memory_mib = 8192
timeout_seconds = 21600 # 3600 to 86400.
# image = "your-image:tag" # Optional. Without it, the package Dockerfile is built.

[openrouter]
key_env = "OPENROUTER_API_KEY"

[repositories.example]
url = "owner/source-repository"
# scope = "src/"
# revision = "a commit, tag or branch" # Optional. The default branch is used without it.
```

The template also has a `[modal]` table. You can leave it or delete it. Only the table of the selected executor must be present. Without `executor`, Docker is used. If only a `[modal]` table is present, Modal is used. Without `audit_profile`, the profile is `v2/pareto`.

Launch a run, wait for it, and read the report:

```sh
export OPENROUTER_API_KEY=... # your key
bun dist/cli.js launch example --label first-run
bun dist/cli.js wait RUN_ID
```

`launch` prints the run ID, for example `20261103-120000-a1b2c3d4`. The first launch builds the worker image, and that takes a long time. `launch` returns when the container has started. The run then continues without the command line.

`wait` returns when the run has ended and its results are on your machine. It prints the path of the report:

```text
~/.ultrafuzz/runs/<run-id>/artifacts/raw/report.md
```

`status`, `collect` and `list` print the same path. If the run wrote no report, `status`, `wait` and `collect` say so and print the path of the collected evidence instead.

## Commands

Run `bun dist/cli.js --help` for the same list.

| Command | Purpose |
| --- | --- |
| `init` | Create the configuration file and install the bundled profiles. |
| `launch <repository-alias>` | Start a detached run. `--label` is required. |
| `list` | List local runs. |
| `status <id>` | Refresh a run. Collect its report if it ended. |
| `wait <id>` | Wait until a run ends and its report is collected. A failed status request does not end it: it prints one line, continues, and stops only after 10 minutes of failures. A request that fails because another command works on the run (its lock is busy) is not such a failure: `wait` prints one line each 10 minutes and stops only after 2 hours. |
| `watch [id...]` | Collect many runs as they end, then print a summary. See [Watch many runs](#watch-many-runs). |
| `collect <id>` | Collect the local report. Retry publication if it is enabled. |
| `cancel <id>` | Request a stop, with time to export artifacts. |
| `recover [id]` | Rebuild local records from the executor's retained storage. |
| `profiles` | List profiles and their supported harnesses. |
| `viewer` | Serve the local dashboard on `127.0.0.1`. |

Global options: `--home <directory>`, `--json`, `--help`, `--version`.

| Command | Option | Meaning |
| --- | --- | --- |
| `launch` | `--repository <alias>` | Alternative to the positional alias. |
| `launch` | `--label <name>` | Groups repeated configurations. Letters, digits, dots, underscores and hyphens. |
| `launch` | `--profile <name>` | Profile name. The default is `audit_profile` in the configuration, or `v2/pareto` without it. |
| `launch` | `--executor <name>` | `docker` or `modal`. The default is `executor` in the configuration. |
| `launch` | `--revision <ref>` | Commit, tag or branch to audit. The default is `revision` of the repository in the configuration, or the default branch. |
| `launch` | `--publish` | Also open a pull request in the results repository. |
| `launch` | `--harness <name>` | `claude-code`, `opencode` or `codex`. |
| `launch` | `--model <provider/model>` | OpenRouter model ID. |
| `launch` | `--effort <value>` | Reasoning effort of the harness. |
| `launch` | `--properties <file\|run-id>` | A property-specification report, as a file or a collected run. |
| `launch` | `--key-env <name>` | Environment variable that holds the key for this run. |
| `launch` | `--timeout <seconds>` | Timeout for this run, 3600 to 86400. A run on Modal gets 86100 at most. |
| `launch` | `--input <name=path\|JSON>` | A named file, directory or repository input. Repeatable. |
| `launch` | `--inputs <file.json>` | A JSON array of input records. |
| `watch` | `--label <name>` | Watch the runs with this label. Not together with run IDs. |
| `watch` | `--interval <seconds>` | The pause between two cycles, from 5 to 86400. The default is 60. |
| `watch` | `--once` | Do one cycle, print the summary and exit. |
| `collect` | `--force` | Download and package again. If this fails for a run that is already collected, the command fails, and the earlier package and the record stay as they are. |
| `recover` | `--executor <name>` | The executor whose storage is read. |
| `viewer` | `--port <number>` | The default is 3000. |

With `--json`, each command prints one JSON object with a `schema` field. `watch` prints one such line for each change and one at the end. `wait`, `collect` and `watch` exit with code 1 when collection failed, or when a requested publication failed. A failed audit is not a failed command. `watch` has more exit codes: see [Watch many runs](#watch-many-runs).

`status`, `wait` and `watch` collect a run that has ended. A failed collection or publication is tried again on the next `status`, `wait` or `collect`, and in a later cycle of `watch`. Plain `collect` does nothing when the run is already collected and, if publication is on, published.

A launch can fail before the run reaches the executor, for example when Docker is not installed or the clone fails. A launch can also fail at the executor, for example when Docker cannot start the container or Modal refuses the sandbox. The executor then removes what it created. In both cases the run is recorded as failed at once. It has nothing to collect, and `status` prints the cause. If the executor cannot confirm that nothing is left, the run stays in the state `launching`: the error text says `Use status to reconcile a possibly accepted launch`, and `status` records such a run as lost after 30 minutes. If a launch is killed while it prepares the run, the record stays in the state `prepared`. Use `cancel` and then `status` to end it.

A run can end without the completion record of its worker, for example when the executor stopped the worker or did not know the run for 30 minutes. `status` on such a run asks the executor again. If the record is there then, the run is collected again. If the executor has the run alive, the run is active again. If the run was recorded as lost and the executor now gives the exit code of its worker, the run is recorded as ended with an error and with that code, and its outputs are collected. `watch` and the dashboard do this only while the run is not settled.

A run can be recorded as lost although the executor has no store for it. The collection of such a run fails each time with the text `was not found`, and each `watch` without IDs tries it again and exits with code 1. There are two causes. The first is a launch that was killed after the record got the state `launching` and before the executor created the store: `status` records such a run as lost after 30 minutes. The second is a failed launch from an earlier commit of this release, after which the executor removed the store. No command repairs such a record. Make sure that the credentials and the environment of the command are those of the launch. Then delete the directory `~/.ultrafuzz/runs/<run-id>/`.

A command with a run ID that the workspace does not have fails with the text `Run <id> was not found`. It creates nothing.

After `cancel`, the lines of `cancel`, `status`, `list` and the summary of `watch` show `running (stop requested)` for the run, or `prepared (stop requested)`, until the run has ended. With `--json` the request is the value `cancelled` in `end`.

`cancel` fails when the executor does not know a run that is recorded as running, and it changes nothing then: nothing was stopped. This happens with other credentials, another Modal environment or another Docker host. It also happens when the container of a running run was removed by hand. Such a run ends as lost after 30 minutes.

The dashboard lists the runs of all configured repositories. It can launch and cancel runs, and it links the local report. It listens only on `127.0.0.1`. While it runs, it refreshes each run that is not settled every 5 seconds, so it also collects and publishes. It does not try a failed collection or publication again at each refresh: the next attempts come after 2, 4, 8 and 16 minutes, and after five failures in a row it leaves the run alone until it is restarted. `collect <id>` and `status <id>` always try at once. The run list of the page does not wait for a collection: after 2 seconds it shows the stored records, and the refresh continues. If the status check of a run fails, for example in a shell without the credentials of the executor, the page shows `Status check failed` for that run with the cause, and the dashboard writes one line to standard error for each row of such failures.

### Watch many runs

`watch` collects many runs with one command. It stays in the foreground and works in cycles. In each cycle it calls `status` for each watched run that is not settled, one run after the other. Thus it collects each run that has ended, and publishes it if publication is on. It never starts, cancels or deletes a run.

```sh
bun dist/cli.js watch                      # every run that is not settled
bun dist/cli.js watch --label properties   # the runs with one label
bun dist/cli.js watch RUN_ID RUN_ID        # these runs only
```

A run is settled when it has ended, it is collected, and it is published if publication is on. A run that ended without a report is settled when its evidence is collected.

- **Runs.** With IDs, `watch` watches those runs. With `--label`, it watches the runs with that label. In these two cases the summary also shows the runs that were settled before. With neither, it watches every local run that is not settled. This includes old runs whose collection or publication failed: `watch` tries them again, and it exits with code 1 if they fail again. Without IDs, each cycle also picks up the runs that were launched after the watch started.
- **Credentials.** Start `watch` with the same executor credentials as the launches. For Modal, use the same profile and environment. If the executor does not know a running run, `status` and `watch` keep the run as it is. Each command writes one line to standard error for such a run, with the time of the first such answer and the minutes that are left. On Modal there is one more line, which names the sandbox, the app and the environment. The run is recorded as lost only when the answer stays the same for 30 minutes, and the command that records it writes one more line. A cancelled run waits the same 30 minutes. A later `status <id>` with the right credentials corrects a wrong record, but `watch` does not look at a settled run again. So run `status <id>` on one run first, and read standard error.
- **Output.** One line for each change: a run started, a run ended, a run was collected (with the path of the report), a collection or publication failed, a run was published, a run was given up. A run that already runs when the watch starts gets no `started` line, so standard output can stay empty until the first run ends. At the end there is a summary. Its first line counts the runs, the runs with a report, the settled runs, the watch failures and the runs that are not settled. Then there is one line for each run: ID, label, repository, outcome, the failed step if there is one, the path of `report.md` or `no report`, and the pull request if there is one. An ID without a usable record gives the line `<id>  unknown run`. A watch failure is a run whose collection or requested publication failed, a run that was given up, or an ID without a usable record. A failed audit is not a watch failure.
- **JSON.** With `--json`, each line on standard output is a JSON object with `"schema": "ultrafuzz.watch.v2"`, a `type` and the time `at`. Use this mode for a log: the text lines have no time. An argument error, or a registry that cannot be read in the first cycle, gives one line with the schema `ultrafuzz.error.v2` and no summary.
  - A change has the type `started`, `ended`, `collected`, `collection_failed`, `published`, `publication_failed` or `gave_up`. Its fields are `id`, `label`, `repository`, `state`, `status`, `end`, `executor`, `collection`, `publication`, `package_path`, `report_path` and `pr_url`. A failure also has `error`, and `attempt` and `attempts` for a collection or publication.
  - The last line has the type `summary`. Its fields are the counts `total`, `reports`, `settled`, `failed` and `not_settled`, the list `runs`, and the list `unknown` of IDs without a usable record. Each item of `runs` has the fields of a change and the booleans `settled` and `gave_up`.
- **Failed status check.** The network, the executor or the lock of a run can make a status check fail. `watch` writes one line to standard error and tries again in each cycle. If each check for one run fails for 2 hours, `watch` gives that run up and continues with the other runs. A status call that takes longer than ten minutes gets a line on standard error each ten minutes.
- **Failed collection or publication.** `watch` tries again later, at most 5 times in a row for each of the two steps. The pauses between the attempts are 2, 4, 8 and 16 minutes, so the attempts cover 30 minutes. An attempt is made in the first cycle after its pause. After the fifth failure, `watch` stops work on that run. Use `collect <id>` to try again later. If that works while the watch still runs, the summary shows the run as settled.
- **Damaged or removed record.** If the record of a run cannot be read, or is removed during the watch, `watch` writes one line to standard error and does not work on that run. The other runs are not affected. With IDs, a run without a usable record is a watch failure. With `--label` or with no ID, a run whose record cannot be read when the watch starts is not watched and is not in the summary.
- **End.** `watch` ends when each watched run is settled or was given up. With `--once` it ends after one cycle. With nothing to watch it prints one line and ends. It has no time limit. A run whose record stays in the state `prepared` keeps it alive: end such a run with `cancel`, as the paragraph above shows.
- **Signals.** After `SIGINT` or `SIGTERM`, `watch` completes the run that it is working on, prints the summary and ends. A signal that is sent to the `watch` process does not stop a collection in the middle. A second signal in the first 2 seconds is ignored, because some tools send each signal twice. A later second signal ends the process immediately. `SIGHUP` is not handled: a watch in a terminal that closes ends at once, without a summary, so start a long watch with `nohup` or in a terminal multiplexer. Ctrl-C in a terminal goes to the full process group. It thus also stops the `docker`, `git` and `gh` commands that the collection of a Docker run and a publication use. That step is then recorded as failed, and the next `status`, `collect` or `watch` tries it again. The collection of a Modal run is not affected.
- **Exit code.** 0 when the watch ended and there was no watch failure. A label that matches no run also gives `No runs to watch.` and 0, so check the spelling of the label. An argument error gives 1. A failed audit and a run without a report do not change this. With `--once`, a run that is still active does not change this. 1 when there was a watch failure. 130 after `SIGINT` and 143 after `SIGTERM` when there was no watch failure but a run was not settled. Exit code 0 does not show that each run has a report: read `reports` in the summary, or `report_path` of each run.
- **Progress.** `watch` writes one progress line to standard error before the first pause, and then at most one in ten minutes.

`--home <directory>` or the `ULTRAFUZZ_HOME` variable selects another workspace. The default layout is:

```text
~/.ultrafuzz/
  ultrafuzz.toml
  prompts/v2/<profile>/
  runs/<run-id>/run.json      the run record
  runs/<run-id>/staging/      what was sent to the worker
  runs/<run-id>/collected/    the raw download
  runs/<run-id>/artifacts/    the result package, with raw/report.md
```

## Profiles and inputs

| Profile | What it does | Harnesses | Inputs |
| --- | --- | --- | --- |
| `v2/pareto` | Pareto v2 security review: many independent hunters, merges, verification and appeals. Work in progress. | `opencode` | The source. Optional `threat-model` input. |
| `v2/property-specification-collaborative` | Eight lenses each write a property catalog and share one log file. A fan-in merges the catalogs into `report.md` with stable IDs (`P-001`, ...). Work in progress. | `claude-code`, `opencode`, `codex` | The source. Optional offline copies of the pinned references. |
| `v2/stateful-fuzzing` | Implements the supplied properties and runs a bounded stateful fuzzing campaign. | `claude-code`, `opencode`, `codex` | The source and a properties report (`--properties`, required). |

Each profile has completed a live run on this runner, on Modal with OpenCode: `v2/pareto` three, and the other two profiles one each. In that test the stateful-fuzzing run used the report of the property-specification run as its input. The only deliverable of each profile is `report.md`. A launch with a harness that the profile does not list fails before execution.

**Property specification.** Each lens studies one or two external references, pinned by repository and commit. The profile does not contain their text. A lens downloads them during the run. To supply one offline, pass a snapshot of its repository as an input with the reference ID as its name, for example `--input reference-properties-crytic=./crytic-properties`. The IDs are in `skills/property-specification-collaborative/references.md` in the profile. When the harness can start subagents, the lenses run as subagents in two groups of four. Otherwise they run one after another in the same session.

**Stateful fuzzing.** `--properties` takes a file or the ID of a collected run. The report is copied into the new run as an input named `properties`, and the runner records its hash and its source run. The runner never starts property specification by itself. The prompt receives a suggested fuzzing budget of `min(4 hours, initial harness time / 3)`. This is guidance for the agent, not a limit that the runner enforces.

```sh
bun dist/cli.js launch example --label fuzz-baseline \
  --profile v2/stateful-fuzzing --properties PREVIOUS_RUN_ID

bun dist/cli.js launch example --label fuzz-custom \
  --profile v2/stateful-fuzzing --properties ./properties.md \
  --input reference=./supporting-notes
```

**Inputs.** `--input name=path` adds a local file or directory. A JSON object adds a repository snapshot: `--input '{"name":"reference","repository":"https://github.com/org/repo","revision":"main"}'`. The harness sees each input read-only at `/run-data/reference/<name>`.

**Profile files.** A profile directory holds `profile.json`, `prompt.mdx`, `skills/` and optional harness configuration under `config/`. `config/claude-code.json`, `config/opencode.json` and `config/codex.toml` are merged over the configuration that the runner generates. `config/opencode.env.json` and `config/claude-code.env.json` hold harness flags as strings. Extra harness files go in `files/<harness>/`. The prompt is sent as text. It is not executed.

**A profile is trusted.** The runner generates the harness configuration: the model, the OpenRouter route and the permissions. A profile's `config/` file is merged over it and can replace any of these values. A changed route can send the OpenRouter key to another endpoint. Only the `*.env.json` files are restricted: they cannot set credentials or configuration paths. Read a profile before you install it, as you read code before you run it.

The run records the package version, the profile name and a digest of the installed profile files. The host makes the digest at launch, and it is the same for every harness and model. Python bytecode (`__pycache__`, `*.pyc`) and `.DS_Store` files in a profile directory are not part of the profile: they are not installed, not hashed and not sent to the worker. Every other profile file must be UTF-8 text. A launch fails and names the file if one is not. Agent customization files in the audited repository, such as `CLAUDE.md` and `AGENTS.md`, are not loaded.

`init` does not overwrite installed profiles. If `~/.ultrafuzz/prompts` holds profiles from an earlier checkout, delete that directory and run `init` again.

### Pareto v2 (work in progress)

`v2/pareto` is set up for OpenCode only, with the model `deepseek/deepseek-v4.1-flash-1017`. **Three live runs of this profile have completed on this runner, on Modal with `cpu = 8`: one on a Foundry project, one on a Hardhat project and one on a Vyper project. Expect failures.**

The profile contains the Pareto v2 workflow from [Can open-weight models achieve frontier security performance?](https://www.monad.xyz/blog/can-open-weight-models-achieve-frontier-security-performance):

- `prompt.mdx`: the initial prompt for the coordinating session.
- `skills/pareto-security-review/prompts/`: the six role prompts (coordinator, hunter, batch merger, final merger, verifier and appeal).
- `skills/pareto-security-review/scripts/`: `render.py` prepares the run and renders the hunt, verify and appeal tasks. `pareto_tools.py` checks merge coverage, splits candidates into shards and assembles the report. The scripts use only the Python 3.11 standard library and do not call a model.
- `skills/pareto-security-review/config.toml`: the defaults. They are 86 hunters, 20 shards with two verifiers each, and six appeal reviewers.
- `config/opencode.env.json`: the 131,072-token output limit that the workflow requests.

The workflow requests 16 CPUs, 64 GiB of memory and a 24-hour limit, with maximum reasoning effort. The runner defaults are much smaller, and a profile cannot change them. Set them in `~/.ultrafuzz/ultrafuzz.toml` before you launch, in the table of the executor that you use. The Docker host must have that many CPUs and that much memory. On Modal the longest run is 86,100 seconds, which is five minutes less than 24 hours.

```toml
[defaults]
harness = "opencode"
model = "deepseek/deepseek-v4.1-flash-1017"
effort = "max"

[docker]
cpu = 16
memory_mib = 65536
timeout_seconds = 86400

[modal]
app = "ultrafuzz"
cpu = 16 # Modal bills this as physical cores. Only cpu = 8 has been run so far.
memory_mib = 65536
timeout_seconds = 86100 # The longest run on Modal. A larger value is lowered to this.
```

```sh
bun dist/cli.js launch example --label pareto-v2 \
  --profile v2/pareto --input threat-model=./threat-model.md
```

The `threat-model` input is optional. Without it, the coordinating session writes a threat model from the project's documentation and says so in the report.

## Example launches

These are three small public repositories: one Foundry project, one Hardhat project and one Vyper project. The commands below are correct for the code. Three `v2/pareto` runs have completed on these repositories (see [Pareto v2](#pareto-v2-work-in-progress)). One `v2/property-specification-collaborative` run and one `v2/stateful-fuzzing` run have completed on the Foundry project. All five runs were on Modal with OpenCode. No property-specification or stateful-fuzzing run has completed on the Hardhat or the Vyper project. No run has completed on Docker, which the commands below use by default, or with Claude Code or Codex.

Each entry pins the commit to audit with `revision`. Without `revision`, the runner clones the default branch. The run record shows the commit in both cases. Add the three repositories to `~/.ultrafuzz/ultrafuzz.toml`:

```toml
[repositories.very-liquid-vaults] # Foundry
url = "rheo-xyz/very-liquid-vaults"
revision = "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec"

[repositories.venus] # Hardhat
url = "code-423n4/2023-05-venus"
revision = "9853f6f4fe906b635e214b22de9f627c6a17ba5b"

[repositories.stableswap-ng] # Vyper
url = "curvefi/stableswap-ng"
revision = "8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386"
```

Launch a property specification on each target. Set `model` in the configuration first, or add `--model`.

```sh
bun dist/cli.js launch very-liquid-vaults --label properties --profile v2/property-specification-collaborative
bun dist/cli.js launch venus --label properties --profile v2/property-specification-collaborative
bun dist/cli.js launch stableswap-ng --label properties --profile v2/property-specification-collaborative
bun dist/cli.js list
bun dist/cli.js wait RUN_ID
```

Then use the report of a finished run as the input of a fuzzing run:

```sh
bun dist/cli.js launch very-liquid-vaults --label fuzz \
  --profile v2/stateful-fuzzing --properties RUN_ID
```

Each run uses the CPUs and memory of the `[docker]` table at the same time as the others. On a small machine, launch one run and wait for it before you launch the next.

`--revision <ref>` on `launch` overrides the configured revision for one run. A run with a revision gets the tree of that commit and the submodules of that commit only. In both cases some names are left out of the tree: see [Credentials and limits](#credentials-and-limits). The image has two Vyper compilers, but Slither supports Vyper only in part, so expect a weaker result on the Vyper target. See [Tools in the worker image](#tools-in-the-worker-image).

## Executors

A run keeps the executor that it was launched on. `status`, `wait`, `collect` and `cancel` use the executor in the run record.

### Docker (default)

Each run has one detached container and one named volume. Both are named `ultrafuzz-<run-id>` and carry the label `ultrafuzz.run=<run-id>`. The volume is the only mount of the container. The container gets no host directory and no Docker socket, and it is not privileged. Its network is not restricted.

Read these points before you use it:

- **The key is readable through Docker.** The OpenRouter key is in the environment of the container. Anyone who can use Docker on that machine can read it, for example with `docker inspect`. It stays there after the run ended, until you remove the container. Use a key with a spending limit.
- **Nothing is deleted automatically.** The container, the volume, the worker image and the local files of every run stay until you remove them. The one exception is a launch that failed before its container started: its container and its volume are removed, and the run is recorded as failed with nothing to collect.
- **The first image build takes a long time.** Without `image` under `[docker]`, the first launch builds the package Dockerfile as `ultrafuzz-worker:<hash>`. Later launches use that image again. With `image` set, that image is used as it is, and it is pulled when it is absent.
- **A run does not survive the host.** The container continues when the command line exits. It does not continue after a host restart or a stop of the Docker daemon. `recover` rebuilds local records from retained volumes. It does not continue an audit.

List what Ultrafuzz left in Docker:

```sh
docker ps -a --filter label=ultrafuzz.run
docker ps -a --filter label=ultrafuzz.reader   # Reader containers that a stopped command left.
docker volume ls --filter label=ultrafuzz.run
docker image ls --filter label=ultrafuzz.dockerfile
```

List and remove the container and the volume of one run. Replace `RUN_ID`.

```sh
docker ps -a --filter label=ultrafuzz.run=RUN_ID
docker volume ls --filter label=ultrafuzz.run=RUN_ID
docker rm ultrafuzz-RUN_ID          # The container, with its copy of the key.
docker ps -aq --filter label=ultrafuzz.reader=RUN_ID | xargs -r docker rm   # Reader containers of the run, if any.
docker volume rm ultrafuzz-RUN_ID   # The outputs of the run in Docker. Collect first.
```

Remove the container before the volume. `docker rm` refuses a container that is still running. After a run has ended you can remove its container and keep its volume: `status`, `collect` and `recover` then read the volume through a short-lived container that is never started. This needs the worker image. Such a reader container is named `ultrafuzz-reader-<run-id>-<random>` and carries the label `ultrafuzz.reader=<run-id>`, not `ultrafuzz.run`. The command removes it when it ends. A command that is stopped with Ctrl-C or killed can leave one behind, and it then keeps the volume in use: remove it before the volume. The local files of a run are in `~/.ultrafuzz/runs/<run-id>/`.

A custom image must provide `sh`, `mkdir`, `cp`, `touch`, `sync`, a GNU-style `timeout`, `bun` and the harness. The container is created with `--init`, so the Docker host must provide `docker-init`.

### Modal

Select Modal with `executor = "modal"` under `[defaults]`, or with `--executor modal` for one run. The host needs Modal credentials and a `[modal]` table. It needs no Docker.

**What is tested.** The live test with a stub harness (`bun run test:modal`, see [Development and tests](#development-and-tests)) passes on a real Modal account. Five real runs with OpenCode have completed on Modal: three of `v2/pareto`, one of `v2/property-specification-collaborative` and one of `v2/stateful-fuzzing`. `ultrafuzz watch` collected each report. Those runs used a worker from an earlier commit of this release.

**Credentials.** Ultrafuzz uses the Modal client library. The library reads `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` from the environment. Without them it reads the profile file `~/.modal.toml`, which `modal token new` of the Modal command line writes. `MODAL_ENVIRONMENT` selects the Modal environment. `environment` in the `[modal]` table, when set, is used instead of it. A launch checks for credentials before it builds the image and before it clones the source. The credentials stay on the host.

**Configuration.**

```toml
[modal]
app = "ultrafuzz"
cpu = 4
memory_mib = 8192
timeout_seconds = 21600 # 3600 to 86400. A run on Modal gets 86100 at most.
# environment = "main"
# image = "im-..." # Optional: a Modal image ID or a registry image.
```

- `app` is the Modal app that holds the sandboxes. It is created when it does not exist.
- `cpu` is the number of CPU cores of the worker sandbox. Modal counts and bills them as physical cores. `memory_mib` is its memory. Each value is the reservation and also the limit, so a run cannot use more. Measured: a sandbox with `cpu = 8` and `memory_mib = 65536` shows 8 processors and about 64 GiB.
- `timeout_seconds` covers the same stages as on Docker: source setup in the worker, the harness, the continuation and the export. Modal ends every sandbox after 24 hours at most, and the worker needs 300 seconds after its deadline to write its completion record. So a run on Modal gets 86,100 seconds at most. A larger value, from the configuration or from `--timeout`, is lowered to 86100, and the run record shows the value that was used.

**First launch.** Run `bun run build` first: the worker bundle is uploaded with each run. Without `image`, Modal builds the worker image from the package Dockerfile: the base image of the `FROM` line and the `ARG`, `ENV`, `RUN`, `USER` and `WORKDIR` lines. `COPY`, `CMD` and `ENTRYPOINT` lines are left out, because Modal has no build context. `launch` prints one line and then waits for the build. The build output is on the page of the app in the Modal dashboard. The first build took about 4 minutes. Later launches use the same image again. A change of one of these lines builds the whole image again. With `image` set, that image is used as it is.

```sh
export MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... # or: modal token new
export OPENROUTER_API_KEY=...
bun run build
bun dist/cli.js launch example --label first-run --executor modal
bun dist/cli.js wait RUN_ID
```

**What a run uses.** Each run has one worker sandbox and one Modal Volume. Both are named with the run ID. The Volume is mounted at `/run-data`. The sandbox continues when the command line exits. Short helper sandboxes (`debian:bookworm-slim`, 0.25 CPU, 256 MiB, 30 minutes at most) upload the run inputs at launch and read the Volume for `recover`, and for `status` and `wait` after the worker ended. The helper that packs and copies the outputs for a collection has 6 hours at most, because the time of a collection grows with the outputs. It is stopped when the collection ends. `status` and `wait` also start one when a launch has no sandbox yet (once a minute at most) and when Modal does not know the sandbox of a run. When a worker has just ended and its completion record is not visible, the helper looks again for up to 25 seconds. For a run that has already ended without a completion record, each later `status <id>` starts one helper for one look, as long as the Volume exists.

**A request without an answer.** While a worker runs, a status check looks for the completion record through the worker sandbox. If Modal does not answer such a look in 30 seconds, the command continues without it. The copy of the outputs in a collection has a limit too (see [Result package](#result-package)). In both cases the request stays open and can keep the process alive. So `status`, `collect`, `wait` and `watch` end the process themselves when they have printed their result, with their usual exit code. The dashboard is a server and continues. This case has not been seen on a real Modal account.

**What stays on Modal.** One Volume for each run, the app, and the image. Ultrafuzz does not delete them. The one exception is a launch that failed before its worker sandbox started: its Volume is deleted, and the run is recorded as failed with nothing to collect. The Volume is kept when the request for the worker sandbox ended with a connection error, because Modal can have accepted it. Delete such a Volume by hand when no sandbox with the run ID exists.

**The Volume is sensitive.** The OpenRouter key enters the sandbox only as a Modal secret, and Ultrafuzz redacts it from the collected outputs. The Volume also holds the harness state (its home directory and its session database) and the workspace. These are not redacted. The harness and its tools have the key in their environment, so a file there can contain it. Delete the Volume after you collected the run.

List and delete what is retained, with the Modal command line. Replace `RUN_ID`. Add `--env NAME` when you do not use the default environment.

```sh
modal volume list            # One Volume for each retained run. Its name is the run ID.
modal volume delete RUN_ID   # The outputs, the harness state and the workspace of the run. Collect first.
modal app list               # The app. Its page in the dashboard lists the sandboxes.
modal app stop ultrafuzz     # Ends the app and every sandbox in it, also runs that are not finished.
```

Use `cancel` to stop one run. The local files of a run are in `~/.ultrafuzz/runs/<run-id>/`.

**Recover.** `recover RUN_ID --executor modal` reads the Volume of that run. `recover --executor modal` without an ID reads every Volume of the environment that is named like a run ID, one after the other, each through a helper sandbox. It also finds runs that were launched from another machine in the same environment. With many retained Volumes it takes a long time. Delete the Volumes of collected runs, or use a separate Modal environment.

### Tools in the worker image

The package Dockerfile lists every tool with its pinned version. Both executors build the image from it. For Vyper projects: `vyper` is Vyper 0.3.9, because Slither and crytic-compile in the image read the output of Vyper 0.3 only. The second version is Vyper 0.4.3. Each version is on `PATH` as `vyper-<version>` and is installed at `/opt/vyper/<version>/vyper`. To use the other version as `vyper` for one command, put its directory first: `PATH="/opt/vyper/0.4.3:$PATH" forge build`. For any other compiler version, and for Python packages, make an environment for the project with `uv` (`uv venv`, `uv pip install`). `uv` can also download other Python versions. Test frameworks are not preinstalled, because they must match the compiler of the project. For Solidity, `solc-select` installs compiler versions, and `solc` runs the selected one.

**Recon does not start.** The image installs the Recon fuzzer as its release binary, and that binary needs version 2.39 of the C library. The image is Debian 12, which has version 2.36, so `recon` stops with a `GLIBC` error. A real `v2/stateful-fuzzing` run reported this. That run used Foundry and Echidna, which work. Medusa starts in the image, but no real run has used it. `recon-generate` is a different program, an npm package, so it does not depend on that library version. No workflow starts it.

## Credentials and limits

Only the OpenRouter key enters the worker. GitHub and Modal credentials stay on the host. The host clones the source and sends a snapshot to the worker. The snapshot is the tree of the commit without each file and directory that has one of these names, at any depth: `.git`, `.git-credentials`, `.netrc`, `.ssh`, `.aws`, `.env`, `.npmrc`, `.pypirc`, `.cache`, `.npm`, `node_modules`, `__pycache__` and `.pytest_cache`. These are names of credential stores and caches. A path with such a name is left out also when the commit tracks it, so a build that needs it (for example a tracked `.npmrc`) can fail or change in the worker. `launch` writes one line to standard error when it left out a tracked path, and the run record lists the paths in `omitted` with the prefix `source/` (50 at most, then a count). A tracked link to such a name is kept; it has no target until the run makes one. A launch fails, and names the link, when a tracked link is absolute, points out of the tree or points into `.git`. The same names are left out of each `--input`; there a link to such a name is refused. A public target needs no login. A private GitHub target over HTTPS uses the credentials of the GitHub CLI, so run `gh auth login` on the host first.

Ultrafuzz enforces timeouts. It does not enforce a spending limit, so use an OpenRouter key that has one. The network of the worker is not restricted.

## Completion and timeouts

The timeout covers source setup in the worker, the harness, the continuation and the export. It starts when the worker is started, after the image build and the upload. The minimum is one hour and the maximum is 24 hours. On Modal a run gets 86,100 seconds at most. The first harness call must end 30 minutes before the deadline. The continuation must end 10 minutes before it. At the deadline the optional workspace export stops; the run record lists what was skipped.

If the harness exits without a nonempty `report.md`, Ultrafuzz sends one continuation message to the same harness session. It does this only when a session ID exists, the run was not cancelled, and at least five minutes remain for it. The message asks the agent to finish its task and write the report. There is no manual resume command.

`cancel` asks the worker to stop. The worker then has five minutes: it stops the optional export of the sessions and of the workspace after 150 seconds, writes its record, and ends itself when the five minutes are over. This also holds for a stop request that arrives during the export. A worker that is still alive after that is killed. On Docker the Docker daemon does this. On Modal a timer in the sandbox does this, and the next `status` or `wait` stops a sandbox that still runs. Each executor also stops a worker that runs past its deadline.

`status: succeeded` means that a nonempty report exists. The report must be a regular file: a `report.md` that is a link is not a report, and the continuation message says so. `end` and `exit_code` describe the execution separately, so a cancelled run can still have a report. When the worker wrote its completion record, `end` is what the worker recorded: a `cancel` that came after the worker ended does not change it. A worker that ended without a record before the `cancel` is still recorded as `cancelled`. After a continuation they describe the second harness call; `continuation.initial_end` and `continuation.initial_exit_code` keep the outcome of the first one. A run with missing usage data can still succeed.

The OpenCode task guard is a temporary workaround for empty or truncated subagent results. It continues the affected subagent at most two times and then reports a failure. A unit test with a fake client covers this rule. No test loads the guard into OpenCode; the five real runs did. See [upstream issue 52378](https://github.com/anomalyco/opencode/issues/52378) and [upstream issue 59051](https://github.com/anomalyco/opencode/issues/59051).

For comparable experiments, the automatic continuation is the only extra message. Operator prompts, extra continuations, handed-over files or raised limits change the experiment. The runner does not check this.

## Result package

Collection downloads the worker's outputs to `runs/<run-id>/collected/` and writes the result package to `runs/<run-id>/artifacts/`. On Modal the outputs travel as one tar archive in parts of 4,000 MiB, because Modal copies at most 5 GiB in one file (measured); the archive is a temporary file beside `collected/`, so collection needs about twice the size of the outputs on disk. A collection on Modal has time limits: 2 hours to pack the outputs, and about 6 hours from its start to the end of the copy. A collection that passes a limit fails with a text that names the run and the Volume, and the outputs stay in the Volume. No collection of this size has been run.

A collection that cannot end in its limits also holds other work. One attempt can take about 6 hours. `watch` works on one run at a time, so during an attempt it does not refresh or collect another run. In that time it writes one line to standard error each ten minutes. `watch` makes 5 attempts for a run, and it works on the other runs between two attempts. Thus one such run can hold the other runs of a `watch` for about 30 hours in total before `watch` gives it up. To collect the other runs in that time, start a second `watch` with their IDs, or use `status <id>` for each of them. The run list of the dashboard does not refresh the other runs again while one collection runs.

The package has these files:

```text
run.yml
usage.yml
prompt.txt
raw/report.md
raw/transcript.jsonl
raw/sessions/
raw/profile/
raw/agents/       when the run wrote them
raw/workspace/    when the run wrote them
```

`run.yml` records the source and the cloned commit, the profile digest, the harness, its version, the model and the effort, the times, the continuation, the outcome and the omissions. `usage.yml` records the token counts and the cost estimate that were available, with the source of the estimate.

The package holds text files only. Text over 10 MiB is compressed with gzip. The limits are 50 MiB for one file and 200 MiB for one run. Optional workspace output is removed first. Fuzzing corpus, build and cache directories and package environments (for example `out`, `cache`, `.venv`) are always left out: each is one entry with a file count. Omissions are recorded in the run record; a very long list is cut, with a count of the rest. If the report, a transcript, or session or profile evidence does not fit, collection fails. The original outputs stay in the run's volume.

The rule for build and cache directories and package environments holds for the workspace export only. A directory with such a name that the agent made in the output directory itself is packaged like other output, within the size limits. A fuzzing corpus is left out in both places; in the output directory it gives one entry for each file.

On Modal, an output file whose name has a backslash or a control character is left out, and the run record lists it. On Docker such a file is collected with its name.

No link is made on your machine. A symbolic link and a special file in the outputs are left out, and the run record lists them. A file with two names (a hard link) is collected as two files; on Docker the second name is left out when its file is not in the outputs. On Docker the copies for such second names have a size limit: together they get at most as many bytes as the archive of the outputs has. A name whose copy does not fit is left out, and the run record lists it. On Modal each name is a full file in the archive, so there is no such limit. If `raw/report.md` itself is left out, the run is collected as a run without a report. If `raw/transcript.jsonl` is left out, collection fails.

If one file of the workspace cannot be copied, the worker copies the others and the run record says that the export is incomplete.

Redaction replaces the known secret values and some credential patterns that it can identify, such as valid BIP39 mnemonics, labelled private keys and JWTs. The known secret values are the key of the run and, on the host, the value of each environment variable with `TOKEN`, `KEY`, `PASSWORD` or `SECRET` in its name. A value of fewer than 8 characters is not used: such a value, for example `1` or `false`, is an ordinary word, and its replacement would change the report. So a host secret that is shorter than 8 characters is not replaced. Common development mnemonics and the default Anvil keys are kept. This is not a general protection against data leaks.

## Optional GitHub publication

Publication is off by default. A run without it needs no GitHub setup. Publication has not been run against a real GitHub repository with this release.

To turn it on:

1. Authenticate the GitHub CLI on the host with `gh auth login`, or set `GH_TOKEN`. Git gets its credentials for `github.com` from the GitHub CLI and never asks at the terminal.
2. Set `results_repository = "owner/name"` under the repository in `ultrafuzz.toml`. The repository must be private and must have a default branch.
3. Launch with `--publish`, or tick the checkbox in the dashboard.

`--publish` without a results repository is refused before launch. Publication is decided at launch. There is no command that publishes a run that was launched without it.

A published run has the branch `ultrafuzz/<run-id>` and one pull request. The result package is copied to `attempts/<label>/runs/<run-id>/`. Publication replaces only the files that it wrote before, keeps files that other tools added, and never force-pushes. It checks out only the directory of the run, and it adds each file of the package also when an ignore rule of the results repository matches it. A failed publication does not start a new download or a new audit. The next `status`, `wait` or `collect` tries it again from the local package.

Merged results are never changed. A later collection of a published run can give another package: a completion record showed late, or you used `collect --force`. If the pull request was merged before that, the run stays published and the merged files stay as they are. This is not a failed publication, so the command does not fail and `watch` does not try again. The command writes one line to standard error, `status` shows the line `Not published again`, and the record keeps the reason in `publication.error`. The new package is only on your machine. This also holds when the record has no address of the pull request, for example after `recover`: the publisher finds the merged request by the branch of the run and records its address.

A run that has its pull request can have a later publication that fails for another reason. Then `status` shows both lines, `Results PR` and `Publication failed`, and the next `status`, `wait` or `collect` tries again.

## Not included in the experimental release

The specification describes these items. This release does not have them:

- Installable plugin packages and the plugin commands. The executors and the publisher are part of this package.
- Direct OpenAI and Anthropic API routes. All harnesses use OpenRouter.
- ChatGPT and Claude subscription routes.
- The retention plugin and the cleanup command. Remove storage by hand, as shown in the Docker and Modal sections.
- Launch retry with a request ID.
- The `config`, `show`, `logs` and `publish` commands.
- The extra outcome states. A run has `state`, `status` and `end` only.
- Pareto v2 on Claude Code and Codex.

## Development and tests

```sh
bun run check
```

`check` runs the type checker, the unit tests (`bun test`), the Python tests of the Pareto tools and the build. It needs Bun, Git and Python 3.11 or later. It needs no Docker, no Modal account and no key. You can also run the Pareto tests alone:

```sh
bun run test:pareto
```

Two live tests are not part of `check`. **They create and delete real resources.** Each one cleans up only what it launched.

The Docker integration test needs a real Docker Engine. It builds a small test image with a fake harness, clones one public repository, calls no model and uses no secret. It removes the containers and volumes of its own runs and leaves the test image on the host.

```sh
bun run build
bun run test:docker
```

The Modal integration test needs a real Modal account and its credentials (see [Modal](#modal)). It builds a small test image with a fake harness on Modal, clones the same public repository, calls no model and uses no real key. It starts small sandboxes in the app `ultrafuzz-test`; `ULTRAFUZZ_MODAL_TEST_APP` names another app. At the end it stops the sandboxes and deletes the Volumes of its own runs. The app and the test image stay on Modal. One of its tests calls `recover` without an ID, which reads every Volume of the environment that is named like a run ID. Set `MODAL_ENVIRONMENT` to a test environment when the default one holds many retained runs. A pass took about 90 seconds.

```sh
bun run build
bun run test:modal
```

Two GitHub workflows run in CI. `Check` runs `bun run check` and then the built command line (`--version`, `init` and `profiles`, all offline). In a second job it runs the Docker integration test. `Worker image` builds the real worker image with `docker build` and starts most pinned tools in it, each with `--version` or `--help`. It does not start the five Traverse tools (`sol2cg`, `sol2test`, `sol2bnd`, `sol-storage-analyzer`, `storage-trace`), `roundme`, `recon`, `recon-generate`, `jq`, `rg` and `git-lfs`: for these it only checks that the file is there. So this workflow cannot show that one of them starts; `recon` does not (see [Tools in the worker image](#tools-in-the-worker-image)). As the unprivileged user of the harness, it also compiles with each Vyper version, builds a Python environment with `uv` and selects a Solidity compiler. It runs on a pull request that changes the Dockerfile, and on request. No workflow runs the Modal integration test.

These tests do not replace live runs. The acceptance list in section 12 of the specification is still open.
