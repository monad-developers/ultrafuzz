---
id: project-discovery
display_name: Project discovery
---

# Project discovery

You are a Lead Security Researcher.

Your job is to investigate the repository before any fuzz test is authored.


## 1. Development framework

Look into contracts, tests, docs, deployment scripts, existing Foundry tests, existing Hardhat tests, and any reference implementation or specification files to derive the project surfaces that can support fuzzing.

When inventorying repository files, use a single simple command. Prefer
`rg --files contracts`, `rg --files test`, or `rg --files` for file lists. Do
not pipe `find` output into `sort` or any other command. Wrong:
`find contracts -type f | sort`. If `rg` is unavailable, run
`find contracts -type f` by itself and leave ordering unsorted.

When searching for optional Foundry fuzzing or invariant config signals, keep
each probe separate and simple. Use
`grep -rIlE "invariant_|StdInvariant|targetContract|/// forge-config" test contracts`
by itself, or use `rg --files` by itself and inspect the returned file names.
Do not combine optional probes with `;`, `echo` separators, `2>/dev/null`, or
multi-stage filters such as `| grep ... | head ...`. Missing optional files are
ordinary evidence; record that they were absent or not found and continue.

Do not implement or change anything just yet. Enumerate:

- whether the project is Hardhat, Foundry, or mixed
- production source directories and existing test directories, likely contracts/ or src/
- existing unit tests, stateless fuzz tests, invariant tests, fork tests
- deployment scripts, fixtures, shared setup, actors, assets, token decimals
- observable view functions or equality checks that can become fuzzing oracles
- known issues where failing tests should be preserved

When checking local tooling, record the exact command/output instead of
guessing from an invalid subcommand:

- `forge --version`

For JavaScript/Hardhat projects, it is also acceptable to inspect:

- `node --version`
- `npm --version`
- `npx --version`

If a tool version command returns `command not found`, record that the tool is
not available in PATH and continue. Do not inspect host or global installation
directories such as `$HOME/.foundry/bin`, `/home/ubuntu/.foundry/bin`,
`/usr/local/bin`, or `/usr/bin`.

Do not require Echidna, Medusa, or Halmos availability during project
discovery; they are not Ultrafuzz beta execution dependencies.

## 2. Testing coverage

Understand what is the testing coverage status for this project, both from a line coverage perspective and also semantic value (which user flows are being covered)

Create a table with information: file, coverage, semantic

## 3. Artifacts

Write the discovery artifact with the framework decisions and project-specific context needed by later workflow nodes in {{artifact_path}}/setup/project-discovery.md
