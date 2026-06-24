# Start Here

Ultrafuzz runs agentic Solidity fuzzing campaigns against a target protocol
repository. It scaffolds editable campaign prompts and topology, executes
isolated agent attempts through configured CLI backends, persists deterministic
run artifacts, and gives reviewers a local dashboard plus final report.

Use Ultrafuzz when you want repeatable AI-assisted security exploration that is
auditable after the run. It is built for security researchers auditing a
protocol and for protocol developers hardening their own code before or during
review.

![Ultrafuzz dashboard](assets/ultrafuzz-dashboard.png)

## The Short Path

Install the CLI from this repository:

```bash
cargo install --path crates/ultrafuzz-cli --locked
```

Run Ultrafuzz from the Solidity repository you want to test:

```bash
cd target-protocol
ultrafuzz init
ultrafuzz doctor
ultrafuzz references sync
ultrafuzz run
ultrafuzz dashboard
ultrafuzz report <run-id>
```

`init` creates:

```text
ultrafuzz.toml
.ultrafuzz/
  topology.yml
  references.yml
  prompts/
  runs/
```

Ultrafuzz never commits, pushes, auto-submits findings, or auto-merges target
repository code. Generated tests and materialized artifacts are left as
unstaged working-tree changes for a human to review.

Pinned GitHub references are synced during an explicit trusted network phase
with `ultrafuzz references sync`. Normal runs are offline and fail before agents
start if required cached references are missing.

## Where To Go Next

- Follow the [first campaign tutorial](tutorials/first-campaign.md) to get from
  install to report review.
- Use [how-to guides](how-to/index.md) when you have a specific task, such as
  configuring models, editing topology, continuing a run, or materializing
  generated tests.
- Use [reference](reference/index.md) for exact CLI, config, topology, prompt,
  artifact, dashboard, and development details.
- Use [explanation](explanation/index.md) to understand campaign ownership,
  artifact handoffs, backend safety boundaries, and the Monad Bugfinder
  relationship.

## Documentation Shape

This site follows the Diátaxis documentation framework:

- Tutorials teach by guiding you through a complete path.
- How-to guides solve specific operational tasks.
- Reference pages record factual surfaces.
- Explanation pages describe the design and tradeoffs behind the system.
