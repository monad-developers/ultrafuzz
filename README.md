# Ultrafuzz

Ultrafuzz is a Rust-native orchestrator for agentic Solidity fuzzing campaigns.
It initializes a protocol repository with editable prompts and topology, runs
isolated agent attempts through CLI backends, collects generated Foundry tests
and findings, and serves a local dashboard plus final report for review.

![Ultrafuzz dashboard](docs/assets/ultrafuzz-dashboard.png)

## Install

From this repository:

```bash
cargo install --path crates/ultrafuzz-cli --locked
```

During development, run the CLI through Cargo:

```bash
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo run -p ultrafuzz-cli -- --help
```

## Quick Start

Run Ultrafuzz from the Solidity repository you want to audit or harden:

```bash
cd target-protocol
ultrafuzz init
ultrafuzz doctor
ultrafuzz references sync
ultrafuzz run
ultrafuzz dashboard
ultrafuzz report <run-id>
```

`init` writes `ultrafuzz.toml`, `.ultrafuzz/topology.yml`,
`.ultrafuzz/references.yml`, editable prompt copies under
`.ultrafuzz/prompts/`, and `.ultrafuzz/runs/`. `references sync` performs the
trusted pre-run network phase for pinned GitHub references; normal runs are
offline and fail before agents start if required cached references are missing.
Ultrafuzz does not auto-commit, auto-push, auto-submit findings, or auto-merge
target repository changes.

## Documentation

The full documentation site lives under [`docs/`](docs/index.md) and is
published with GitHub Pages for repository members. It includes tutorials,
how-to guides, reference material, and conceptual explanation for security
researchers and protocol developers using Ultrafuzz.

For background on the research direction that shaped this work, read the
[Monad Bugfinder blog post](https://blog.monad.xyz/blog/monad-bugfinder).

## License

Ultrafuzz is licensed under the MIT license.
