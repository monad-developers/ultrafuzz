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
- whether production contracts are Solidity, Vyper, or mixed Solidity/Vyper
- production source directories and existing test directories, likely contracts/ or src/
- existing unit tests, stateless fuzz tests, invariant tests, fork tests
- deployment scripts, fixtures, shared setup, actors, assets, token decimals
- observable view functions or equality checks that can become fuzzing oracles
- known issues where failing tests should be preserved

For Vyper detection, inspect the repository file inventory and project-local
manifests/config files. Record `.vy` production contracts, Solidity/Vyper mixed
layouts, `vyper` or `vyper-json` commands in scripts/tasks, and Vyper-related
configuration or dependency files such as `vyper.json`, `ape-config.yaml`,
`brownie-config.yaml`, `pyproject.toml`, `requirements*.txt`, `Pipfile`,
`poetry.lock`, `uv.lock`, `package.json`, and Hardhat task/config files. Treat
Vyper-only projects as still needing Solidity-based Foundry tests: downstream
setup should interact through Solidity interfaces and compile Vyper bytecode
with the target project's pinned tooling from the project root.

When checking local tooling, record the exact command/output instead of
guessing from an invalid subcommand:

- `forge --version`

For JavaScript/Hardhat projects, it is also acceptable to inspect:

- `node --version`
- `npm --version`
- `npx --version`

For projects with Vyper signals, record only project-local compiler evidence:
the exact Vyper command, script, or dependency pin the repository provides,
normally `vyper`, `vyper-json`, a package script, or a Python environment file.
If `vyper --version` or `vyper-json --version` is directly available in PATH you
may record it, but do not search global install directories and do not install or
vendor untracked compiler dependencies during discovery.

If a tool version command returns `command not found`, record that the tool is
not available in PATH and continue. Do not inspect host or global installation
directories such as `$HOME/.foundry/bin`, `/home/ubuntu/.foundry/bin`,
`/usr/local/bin`, or `/usr/bin`.

Do not require Echidna, Medusa, or Halmos availability during project
discovery; they are not Ultrafuzz beta execution dependencies.

## Invariant and equation inventory

Read the target's documentation, NatSpec, interfaces, source comments, tests,
and existing harnesses for target-derived invariants and liveness requirements.

### Verbatim source-evidence ledger

Before writing the normalized inventory, create a `Verbatim source-evidence
ledger` in the discovery artifact. For every source section whose heading or
symbol names invariants, accounting, solvency, conservation, monotonicity, or
liveness, copy every explicitly enumerated invariant, equation, inequality, or bound verbatim before interpreting it, as well as each explicitly enumerated state relation. Include the source path and line or symbol location beside each copied entry. Do not summarize, merge, or omit a source bullet before it has a corresponding inventory entry;
the normalized inventory must map one-to-one to the ledger and retain the
original operands, comparison direction, units, denominator, and rounding
terms. If a separate source probe finds no matching section, record that probe
and its result rather than silently skipping it.

Extract every explicit equation, inequality, bound, and state relation into the
discovery artifact with its exact operands, units, and rounding semantics.
Preserve distinct denominator and rounding variants as separate entries, even
when they describe the same business rule. For each entry, name the getter,
function, test, or source location that supplies each oracle, including
aggregate accounting relationships between supplied assets, borrowed assets,
and shares when those relationships are explicitly documented or observed in
the target. Record liveness requirements for public and external operations,
including valid-state preconditions and source-defined validation outcomes.

## 2. Testing coverage

Understand what is the testing coverage status for this project, both from a line coverage perspective and also semantic value (which user flows are being covered)

Create a table with information: file, coverage, semantic

## 3. Artifacts

Write the discovery artifact with the framework decisions and project-specific context needed by later workflow nodes in {{artifact_path}}/setup/project-discovery.md
