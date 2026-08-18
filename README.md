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

## Getting started

Tell your agent:

```
Run Ultrafuzz on my project and monitor it from start to finish.
If any node fails, for example, due to cyber refusals, resume from where it left off.
Use subscription auth, the best available model at its highest reasoning effort,
high concurrency limits, and the default audit profile.
If you need to install any dependencies, ask for my approval first.
```

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
- [Licensing](docs/licensing.md)

## Evals

Longitudinal results from the public benchmark suite. See [Eval Suites](docs/reference/evals.md) for methodology.

![UltrafuzzBench quality over time](docs/assets/eval-history/quality.svg)

![Latest UltrafuzzBench result](docs/assets/eval-history/latest-summary.svg)

![UltrafuzzBench model performance versus cost](docs/assets/eval-history/performance-cost.svg)

## Security review

Ultrafuzz has been through an automated, AI-assisted security review whose findings were then reviewed and
dispositioned by a maintainer. That review is **not** a formal third-party security audit and must not be read as one:
no independent auditor has assessed this code, and automated scanners do not constitute an audit.

Residual risk was explicitly accepted rather than eliminated. Agents run in YOLO / bypass-permissions mode, so
Ultrafuzz deliberately ships without OS or container sandboxing for agent execution, without agent network-egress
allowlists, without command allowlists or in-run approval prompts, and without mediated agent filesystem reads. Treat
launching a campaign as authorizing arbitrary code execution on your machine and against your credentials. See
[Security](docs/security.md) for the current posture.

## License

MIT — see [LICENSE](LICENSE). Every workspace package declares `"license": "MIT"`. See
[Licensing](docs/licensing.md) for the copyright attribution evidence and for why the project ships no NOTICE file.
