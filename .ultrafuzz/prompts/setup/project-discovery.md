---
id: project-discovery
display_name: Project discovery
---

# Project discovery

You are a Lead Security Researcher.

Your job is to investigate the repository and produce discovery context for
property-guided analysis.


## 1. Development framework

Look into contracts, tests, docs, deployment scripts, existing Foundry tests,
existing Hardhat tests, and any reference implementation or specification files
to derive the project surfaces that can support property-guided analysis.

Produce discovery notes only. Enumerate:

- whether the project is Hardhat, Foundry, or mixed
- whether production contracts are Solidity, Vyper, or mixed Solidity/Vyper
- production source directories and existing test directories, likely contracts/ or src/
- existing automated tests by type and purpose
- deployment scripts, fixtures, shared setup, actors, assets, token decimals
- observable view functions or equality checks that express expected behavior
- documented limitations or currently failing tests that affect interpretation

For Vyper detection, inspect the repository file inventory and project-local
manifests/config files. Record `.vy` production contracts, Solidity/Vyper mixed
layouts, `vyper` or `vyper-json` commands in scripts/tasks, and Vyper-related
configuration or dependency files such as `vyper.json`, `ape-config.yaml`,
`brownie-config.yaml`, `pyproject.toml`, `requirements*.txt`, `Pipfile`,
`poetry.lock`, `uv.lock`, `package.json`, and Hardhat task/config files. Treat
For Vyper-only projects, record the Solidity interface and project-local
compiler evidence needed to understand deployment and ABI interactions.

For projects with Vyper signals, record only project-local compiler evidence:
the exact Vyper command, script, or dependency pin the repository provides,
normally `vyper`, `vyper-json`, a package script, or a Python environment file.
Record visible project-local tooling evidence and any unavailable project-local
tooling as discovery context.

## 2. Existing validation

Summarize existing validation by file or suite and the behavior it appears to
exercise.

## 3. Artifacts

Write the discovery artifact with the framework decisions and project-specific context needed by later workflow nodes in {{artifact_path}}/setup/project-discovery.md
