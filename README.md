# Ultrafuzz v0.2 (experimental)

> **Experimental release (`0.2.0-experimental`).** No real audit has completed on this runner yet: not on Docker and not on Modal. No test calls a model. The offline tests use fakes, and the two live tests (one on a real Docker Engine, one on a real Modal account) use a stub harness. Expect failures, and expect the interface to change.

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

- No real audit has completed, on either executor, with any harness or any profile.
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
| `wait <id>` | Wait until a run ends and its report is collected. A failed status request does not end it: it prints one line, continues, and stops only after 10 minutes of failures. |
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
| `collect` | `--force` | Download and package again. |
| `recover` | `--executor <name>` | The executor whose storage is read. |
| `viewer` | `--port <number>` | The default is 3000. |

With `--json`, each command prints one JSON object with a `schema` field. `wait` and `collect` exit with code 1 when collection failed, or when a requested publication failed. A failed audit is not a failed command.

`status` and `wait` collect a run that has ended. A failed collection or publication is tried again on the next `status`, `wait` or `collect`. Plain `collect` does nothing when the run is already collected and, if publication is on, published.

A launch can fail before the run reaches the executor, for example when Docker is not installed or the clone fails. Such a run is recorded as failed. It has nothing to collect, and `status` prints the cause. If a launch is killed while it prepares the run, the record stays in the state `prepared`. Use `cancel` and then `status` to end it.

The dashboard lists the runs of all configured repositories. It can launch and cancel runs, and it links the local report. It listens only on `127.0.0.1`.

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

None of the three has completed a live run on this runner. The only deliverable of each profile is `report.md`. A launch with a harness that the profile does not list fails before execution.

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

The run records the package version, the profile name and a digest of the installed profile files. Agent customization files in the audited repository, such as `CLAUDE.md` and `AGENTS.md`, are not loaded.

`init` does not overwrite installed profiles. If `~/.ultrafuzz/prompts` holds profiles from an earlier checkout, delete that directory and run `init` again.

### Pareto v2 (work in progress)

`v2/pareto` is set up for OpenCode only, with the model `deepseek/deepseek-v4.1-flash-1017`. **No live run of this profile has completed on this runner yet. Expect failures.**

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

These are three small public repositories: one Foundry project, one Hardhat project and one Vyper project. The commands below are correct for the code, but no such launch has completed yet.

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

`--revision <ref>` on `launch` overrides the configured revision for one run. The image has two Vyper compilers, but Slither supports Vyper only in part, so expect a weaker result on the Vyper target. See [Tools in the worker image](#tools-in-the-worker-image).

## Executors

A run keeps the executor that it was launched on. `status`, `wait`, `collect` and `cancel` use the executor in the run record.

### Docker (default)

Each run has one detached container and one named volume. Both are named `ultrafuzz-<run-id>` and carry the label `ultrafuzz.run=<run-id>`. The volume is the only mount of the container. The container gets no host directory and no Docker socket, and it is not privileged. Its network is not restricted.

Read these points before you use it:

- **The key is readable through Docker.** The OpenRouter key is in the environment of the container. Anyone who can use Docker on that machine can read it, for example with `docker inspect`. It stays there after the run ended, until you remove the container. Use a key with a spending limit.
- **Nothing is deleted automatically.** The container, the volume, the worker image and the local files of every run stay until you remove them. The one exception is a launch that failed before its container started: its container and its volume are removed.
- **The first image build takes a long time.** Without `image` under `[docker]`, the first launch builds the package Dockerfile as `ultrafuzz-worker:<hash>`. Later launches use that image again. With `image` set, that image is used as it is, and it is pulled when it is absent.
- **A run does not survive the host.** The container continues when the command line exits. It does not continue after a host restart or a stop of the Docker daemon. `recover` rebuilds local records from retained volumes. It does not continue an audit.

List what Ultrafuzz left in Docker:

```sh
docker ps -a --filter label=ultrafuzz.run
docker volume ls --filter label=ultrafuzz.run
docker image ls --filter label=ultrafuzz.dockerfile
```

List and remove the container and the volume of one run. Replace `RUN_ID`.

```sh
docker ps -a --filter label=ultrafuzz.run=RUN_ID
docker volume ls --filter label=ultrafuzz.run=RUN_ID
docker rm ultrafuzz-RUN_ID          # The container, with its copy of the key.
docker volume rm ultrafuzz-RUN_ID   # The outputs of the run in Docker. Collect first.
```

Remove the container before the volume. `docker rm` refuses a container that is still running. After a run has ended you can remove its container and keep its volume: `status`, `collect` and `recover` then read the volume through a short-lived container that is never started. This needs the worker image. The local files of a run are in `~/.ultrafuzz/runs/<run-id>/`.

A custom image must provide `sh`, `mkdir`, `cp`, `touch`, `sync`, a GNU-style `timeout`, `bun` and the harness. The container is created with `--init`, so the Docker host must provide `docker-init`.

### Modal

Select Modal with `executor = "modal"` under `[defaults]`, or with `--executor modal` for one run. The host needs Modal credentials and a `[modal]` table. It needs no Docker.

**What is tested.** The live test with a stub harness (`bun run test:modal`, see [Development and tests](#development-and-tests)) passes on a real Modal account. No real audit has completed on Modal yet.

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

**What a run uses.** Each run has one worker sandbox and one Modal Volume. Both are named with the run ID. The Volume is mounted at `/run-data`. The sandbox continues when the command line exits. Short helper sandboxes (`debian:bookworm-slim`, 0.25 CPU, 256 MiB, 30 minutes at most) upload the run inputs at launch and read the Volume for `collect`, for `recover`, and for `status` and `wait` after the worker ended. `status` and `wait` also start one when a launch has no sandbox yet (once a minute at most) and when Modal does not know the sandbox of a run.

**What stays on Modal.** One Volume for each run, the app, and the image. Ultrafuzz does not delete them. The one exception is a launch that failed before its worker sandbox started: its Volume is deleted. The Volume is kept when the request for the worker sandbox ended with a connection error, because Modal can have accepted it. Delete such a Volume by hand when no sandbox with the run ID exists.

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

## Credentials and limits

Only the OpenRouter key enters the worker. GitHub and Modal credentials stay on the host. The host clones the source and sends a snapshot to the worker. A public target needs no login. A private GitHub target over HTTPS uses the credentials of the GitHub CLI, so run `gh auth login` on the host first.

Ultrafuzz enforces timeouts. It does not enforce a spending limit, so use an OpenRouter key that has one. The network of the worker is not restricted.

## Completion and timeouts

The timeout covers source setup in the worker, the harness, the continuation and the export. It starts when the worker is started, after the image build and the upload. The minimum is one hour and the maximum is 24 hours. On Modal a run gets 86,100 seconds at most. The first harness call must end 30 minutes before the deadline. The continuation must end 10 minutes before it. At the deadline the optional workspace export stops; the run record lists what was skipped.

If the harness exits without a nonempty `report.md`, Ultrafuzz sends one continuation message to the same harness session. It does this only when a session ID exists, the run was not cancelled, and at least five minutes remain for it. The message asks the agent to finish its task and write the report. There is no manual resume command.

`cancel` asks the worker to stop. The worker then has five minutes: it stops the optional workspace export after 150 seconds, writes its record, and ends itself when the five minutes are over. A worker that is still alive after that is killed. On Docker the Docker daemon does this. On Modal a timer in the sandbox does this, and the next `status` or `wait` stops a sandbox that still runs. Each executor also stops a worker that runs past its deadline.

`status: succeeded` means that a nonempty report exists. `end` and `exit_code` describe the execution separately, so a cancelled run can still have a report. A run with missing usage data can still succeed.

The OpenCode task guard is a temporary workaround for empty or truncated subagent results. It continues the affected subagent at most two times and then reports a failure. See [upstream issue 52378](https://github.com/anomalyco/opencode/issues/52378) and [upstream issue 59051](https://github.com/anomalyco/opencode/issues/59051).

For comparable experiments, the automatic continuation is the only extra message. Operator prompts, extra continuations, handed-over files or raised limits change the experiment. The runner does not check this.

## Result package

Collection downloads the worker's outputs to `runs/<run-id>/collected/` and writes the result package to `runs/<run-id>/artifacts/`. On Modal the outputs travel as one tar archive in parts of 4,000 MiB, because Modal copies at most 5 GiB in one file (measured); the archive is a temporary file beside `collected/`, so collection needs about twice the size of the outputs on disk. The package has these files:

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

Redaction replaces the known secret values and some credential patterns that it can identify, such as valid BIP39 mnemonics, labelled private keys and JWTs. Common development mnemonics and the default Anvil keys are kept. This is not a general protection against data leaks.

## Optional GitHub publication

Publication is off by default. A run without it needs no GitHub setup. Publication has not been run against a real GitHub repository with this release.

To turn it on:

1. Authenticate the GitHub CLI on the host with `gh auth login`.
2. Set `results_repository = "owner/name"` under the repository in `ultrafuzz.toml`. The repository must be private and must have a default branch.
3. Launch with `--publish`, or tick the checkbox in the dashboard.

`--publish` without a results repository is refused before launch. Publication is decided at launch. There is no command that publishes a run that was launched without it.

A published run has the branch `ultrafuzz/<run-id>` and one pull request. The result package is copied to `attempts/<label>/runs/<run-id>/`. Publication replaces only the files that it wrote before, keeps files that other tools added, and never force-pushes. A failed publication does not start a new download or a new audit. The next `status`, `wait` or `collect` tries it again from the local package.

## Not included in the experimental release

The specification describes these items. This release does not have them:

- Installable plugin packages and the plugin commands. The executors and the publisher are part of this package.
- Direct OpenAI and Anthropic API routes. All harnesses use OpenRouter.
- ChatGPT and Claude subscription routes.
- The retention plugin and the cleanup command. Remove storage by hand, as shown in the Docker and Modal sections.
- Launch retry with a request ID.
- The `config`, `show`, `logs`, `publish` and `watch` commands.
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

Two GitHub workflows run in CI. `Check` runs `bun run check` and, in a second job, the Docker integration test. `Worker image` builds the real worker image with `docker build` and runs each pinned tool in it. As the unprivileged user of the harness, it also compiles with each Vyper version, builds a Python environment with `uv` and selects a Solidity compiler. It runs on a pull request that changes the Dockerfile, and on request. No workflow runs the Modal integration test.

These tests do not replace live runs. The acceptance list in section 12 of the specification is still open.
