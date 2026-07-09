# Start Here

Ultrafuzz runs agentic Solidity fuzzing campaigns against a target
repository. It scaffolds editable campaign topology and prompts, validates
product state before launch, compiles a linked workflow, persists durable run
evidence, and leaves generated changes reviewable until the operator explicitly
materializes them.

Use Ultrafuzz when you want repeatable AI-assisted security exploration with
inspectable prompts, pinned references, artifacts, findings, and reports. It is
built for security researchers auditing a protocol and for protocol developers
hardening their code before or during review.

## The Short Path

From a Solidity repository:

```bash
ultrafuzz init
ultrafuzz validate
ultrafuzz references sync
ultrafuzz run
ultrafuzz ps
ultrafuzz inspect <run-id>
ultrafuzz report <run-id>
```

`init` creates root `ultrafuzz.toml` plus product surfaces under
`.ultrafuzz/**`:

```text
.ultrafuzz/
  topology.yml
  prompts/
  references.yml
  runs/
  workspaces/
  cache/
```

Normal runs use cached pinned references. Use `ultrafuzz references sync` as
the explicit network step before a run that needs reference material.

Generated tests, findings, and reports remain artifacts until you explicitly
copy reviewed outputs into the target project with `ultrafuzz materialize`.

## Where To Go Next

- Follow the [first campaign tutorial](tutorials/first-campaign.md) to get from
  initialization to report review.
- Use [how-to guides](how-to/index.md) for specific operator tasks such as
  editing prompts, materializing tests, reviewing findings, cleaning runs, or
  running eval suites.
- Use [reference](reference/index.md) for exact CLI, config, topology, prompt,
  artifact, reference, eval-suite, dashboard, and development details.
- Use [explanation](explanation/index.md) to understand campaign ownership,
  artifact handoffs, trust boundaries, and evaluation guidance.

## Documentation Shape

This docs tree follows the Diátaxis framework:

- Tutorials teach by guiding you through a complete path.
- How-to guides solve specific operational tasks.
- Reference pages record factual product surfaces.
- Explanation pages describe design tradeoffs and mental models.
