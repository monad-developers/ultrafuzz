# Ultrafuzz

<img src="docs/assets/ultrafuzz-logo.svg" alt="Ultrafuzz logo" width="96" height="96" />

Ultrafuzz is an agentic orchestrator for smart contract fuzzing.

Model work can run through first-party Codex, Claude, Kimi, and DeepSeek
adapters or through OpenRouter. The dedicated `OpenRouterAgent` accepts current
OpenRouter catalogue IDs without a built-in allowlist and reads
`OPENROUTER_API_KEY`; see [Config](docs/config.md#openrouter-agent).

![Ultrafuzz dashboard](docs/assets/ultrafuzz-dashboard.png)

This tool initializes a protocol repository with editable prompts and topology, runs
specialized agents, collects generated fuzz tests and findings, and serves a
local dashboard plus final report for review.

> **Trust model:** Agents run in a trusted, skip-permissions workflow, and
> user-editable prompts can influence what is written into a target repository.
> Review the checked-in `.ultrafuzz/prompts/` before launching a campaign, and
> review generated artifacts before copying anything into your project. See
> [Security](docs/security.md) for details.

## Requirements

Campaign execution is supported on Linux with procfs mounted and accessible at
`/proc`. Ultrafuzz holds each sealed workflow generation open and gives the
Smithers child a `/proc/<controller-pid>/fd/<descriptor>` path, so containers
and custom worker images must not hide or unmount procfs. The supported host
runtime is Node.js 22.19 or newer; Smithers execution also requires Bun 1.3+.

## Operator Flow

1. `ultrafuzz init --project <project>`
   Creates root config plus project-owned topology, editable prompt copies,
   pinned references, run/cache/workspace directories, and workflow plumbing.
2. `ultrafuzz validate --project <project>`
   Validates config, topology, prompts, path guards, agent references, and the
   trust model. It does not execute agents.
3. `ultrafuzz references sync --project <project>`
   Explicitly fetches pinned property references into the local digest-checked
   cache. Normal runs stay offline and fail before launch when required
   references are not cached.
4. `ultrafuzz run --project <project>`
   Renders prompts, writes the product plan, launches the workflow, and stores
   run evidence under `.ultrafuzz/runs/**`.
5. `ultrafuzz ps`, `ultrafuzz status <run-id>`, and `ultrafuzz inspect <run-id>`
   Show product run evidence, concise health, and linked workflow status.
6. `ultrafuzz why <run-id>`, `ultrafuzz events <run-id>`, and
   `ultrafuzz node <run-id> <node-id>`
   Diagnose a blocked run, follow linked workflow lifecycle events, and drill
   into one node's attempts, retries, and timing.
7. `ultrafuzz pause|resume|replay|fork|cancel <run-id>`
   Pause, resume, replay, fork, or cancel a linked run. `ultrafuzz timeline
<run-id>` and `ultrafuzz snapshots <run-id>` show the checkpoint frames and
   durability snapshots those operations work from.
8. `ultrafuzz report <run-id>`
   Shows the agent-written final report artifact when the run has produced one.
9. `ultrafuzz materialize <run-id>` and `ultrafuzz clean <run-id>`
   Perform explicit, selected, path-safe filesystem operations. Agent limits
   around commits, pushes, pull requests, external submissions, staging, and
   merges are prompt instructions and trust-model assumptions, not a
   deterministic repository-mutation enforcement layer.

## Documentation

- [Start Here](docs/index.md)
- [Specification](docs/SPECS.md)
- [Tutorials](docs/tutorials/index.md)
- [How-To Guides](docs/how-to/index.md)
- [Reference](docs/reference/index.md)
- [Explanation](docs/explanation/index.md)
- [CLI](docs/cli.md)
- [Config](docs/config.md)
- [Eval Suites](docs/reference/evals.md)
- [EVMBench integration](benchmarks/evmbench/README.md)
- [Schemas](docs/schemas.md)
- [Security](docs/security.md)

## Development Checks

```bash
pnpm -w typecheck
pnpm --filter @ultrafuzz/runtime test
pnpm --filter @ultrafuzz/cli test
pnpm -w docs:check
```

Some package-local scripts build their direct workspace dependencies first
because workspace package exports point at `dist/**` entrypoints.

## Evals

Longitudinal results from the public benchmark suite. See [Eval Suites](docs/reference/evals.md) for methodology.

![UltrafuzzBench quality over time](docs/assets/eval-history/quality.svg)

![Latest UltrafuzzBench result](docs/assets/eval-history/latest-summary.svg)

![UltrafuzzBench model performance versus cost](docs/assets/eval-history/performance-cost.svg)
