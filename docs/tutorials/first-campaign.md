# First Campaign

This tutorial takes a Solidity repository from first Ultrafuzz
initialization through report review and explicit output materialization.

## Prerequisites

You need:

- A local checkout of this Ultrafuzz repository.
- A Solidity target repository you can modify locally.
- Node.js `22.19.0` or newer and the repository-pinned `pnpm` `11.1.1` for the
  TypeScript workspace.
- Bun `1.3` or newer for the Smithers workflow executable, plus Git.
- The CLI executables for the configured agent profiles and their credentials.
  `doctor` checks executables for every configured model profile, including
  profiles that are not selected for a run.
- Foundry (`forge`) and the target project's test dependencies and layout.

See [Development Commands](../reference/development.md) for host runtime and
platform requirements.

> **Security note:** run this tutorial on an ephemeral, isolated virtual machine
> you can discard afterwards. Agents run in an unrestricted, skip-permissions
> workflow and may install or access dangerous tooling or sensitive credentials
> present on the host. Do not run it on a developer workstation, a persistent
> environment, or any machine holding valuable data or credentials. See
> [Security](../security.md).

From the Ultrafuzz repository, install dependencies and build the CLI:

```bash
pnpm install
pnpm --filter @ultrafuzz/cli... build
```

Building the workspace does not install a global `ultrafuzz` command. From the
Ultrafuzz repository root, define a shell function for this terminal session and
check the built CLI:

```bash
ULTRAFUZZ_CLI="$(pwd)/packages/cli/dist/index.js"
ultrafuzz() { node "$ULTRAFUZZ_CLI" "$@"; }
ultrafuzz --help
```

The absolute entrypoint keeps the function usable after changing directories.
The rest of this guide assumes this function is defined or an `ultrafuzz`
executable is already on your PATH. You can also invoke
`node /absolute/path/to/ultrafuzz/packages/cli/dist/index.js` directly with the
same arguments.

## Initialize The Target Repository

```bash
ultrafuzz init --project /path/to/target-protocol
```

Initialization creates or preserves the root config file plus project-owned
Ultrafuzz surfaces:

```text
ultrafuzz.toml
.ultrafuzz/
  topology.yml
  prompts/
  references.yml
  runs/
  workspaces/
  cache/
```

Generated workflow plumbing may also be created, but it is not the stable
operator API. Edit `ultrafuzz.toml`, `.ultrafuzz/topology.yml`, and
`.ultrafuzz/prompts/**` when changing campaign behavior.

## Review And Validate

Agents run under a trusted local execution model. Repository mutation limits
such as "do not commit", "do not push", and "do not open a pull request" are
prompt-level assumptions, so review prompts before launch.

```bash
ultrafuzz validate --project /path/to/target-protocol
```

`validate` checks config, topology, prompts, path guards, agent references, and
trust posture without launching agents.

## Sync Pinned References

Reference fetching is explicit. Sync before runs that need the pinned reference
catalog in `.ultrafuzz/references.yml`.

```bash
ultrafuzz references status --project /path/to/target-protocol
ultrafuzz references sync --project /path/to/target-protocol
```

Normal runs read the digest-checked local cache and fail before dependent nodes
run when required references are missing or mismatched.

## Start A Campaign

```bash
ultrafuzz run --project /path/to/target-protocol
```

Useful run flags include:

```bash
ultrafuzz run --project /path/to/target-protocol --run-id first-campaign
ultrafuzz run --project /path/to/target-protocol --max-concurrency 4
ultrafuzz run --project /path/to/target-protocol --agent CodexAgent --model gpt-5.5
OPENROUTER_API_KEY=... ultrafuzz run --project /path/to/target-protocol \
  --agent OpenRouterAgent --model '~anthropic/claude-sonnet-latest:free'
```

The OpenRouter model string is a catalogue ID and is preserved exactly; keep
the key in the canonical `OPENROUTER_API_KEY` environment variable, never in
`ultrafuzz.toml`. A different `agents.OpenRouterAgent.api_key_env` is rejected
during config validation.

Loops, dependencies, contracted outputs, reference bindings, and model-profile
fan-out belong in `.ultrafuzz/topology.yml`.

## Size Local Concurrency

Normal `ultrafuzz run` campaigns execute on the local machine. The scaffolded
local default is `max_parallel_agents = 4`, and the `--max-concurrency` flag
caps local workflow task submission concurrency for that run.

Choose local concurrency from the host's available CPU, memory, and target test
cost. Modal benchmark resource numbers, including the 16-agent and 32-node
worker override, apply only when launching the separate `ultrafuzz-modal` eval
workflow.

## Inspect Progress

List runs and inspect product evidence for the run ID printed by `run`:

```bash
ultrafuzz ps --project /path/to/target-protocol
ultrafuzz inspect <run-id> --project /path/to/target-protocol
```

Run evidence lives under:

```text
.ultrafuzz/runs/<run-id>/
```

Important evidence includes `run.json`, `config.resolved.toml`, `graph.json`,
`state.json`, `events.jsonl`, rendered prompts, per-node artifacts, review
artifacts, and linked workflow metadata.

## Review The Report

```bash
ultrafuzz report <run-id> --project /path/to/target-protocol
ultrafuzz report <run-id> --project /path/to/target-protocol --json
```

Reports are agent-written final-report artifacts, typically:

```text
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.md
.ultrafuzz/runs/<run-id>/artifacts/final-report/report.json
```

Treat every finding and generated test as evidence for human review. Normalized
findings are JSON arrays in per-node `findings.json` files, and review nodes
may deduplicate, triage, classify severity, aggregate test outputs, and write
the final report.

## Materialize Reviewed Outputs

Materialization is explicit and copy-only. After reviewing a concrete run
artifact, preview the copy:

```bash
ultrafuzz materialize <run-id> --project /path/to/target-protocol --dry-run \
  --copy artifacts/<node-id>/generated-tests/Generated.t.sol:test/foundry/Generated.t.sol
```

Then confirm the exact copy:

```bash
ultrafuzz materialize <run-id> --project /path/to/target-protocol --confirm \
  --copy artifacts/<node-id>/generated-tests/Generated.t.sol:test/foundry/Generated.t.sol
```

Materialized files are ordinary unstaged working-tree changes. Review them with
your normal repository tools before committing anything:

```bash
git -C /path/to/target-protocol status
git -C /path/to/target-protocol diff
```
