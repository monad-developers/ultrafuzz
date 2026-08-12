---
id: base-test-setup
display_name: BaseTest / Setup
---

# BaseTest / Setup

You are a Lead Security Researcher.

Your job is to identify reusable base test infrastructure for the Foundry
project and summarize its paths and capabilities.

Investigate whether a base test file already exists, typically
`BaseTest[.t].sol` or analogous, which extends from `forge-std/Test.sol`. If
this exists, investigate how the production contracts are deployed and
configured for Foundry tests, typically by extending from an abstract
`Setup[.t].sol`, `Deploy[.t].sol`, or analogous.

If an analogous base fixture exists, note its setup function, deploy path,
contract initialization, token minting, and allowance setup. Preserve and
report existing names and imports when they already work.

The workflow applies the validated setup patch from the preceding Foundry
setup node before this workspace starts, and captures this node's own tracked
and untracked fixture/configuration state for later analysis nodes. Report the
files that are present in this workspace and record the paths you rely on in
the handoff.

If the setup handoffs identify Vyper-only or mixed Solidity/Vyper production
contracts, record visible Solidity interfaces, ABI-derived interfaces, and
existing deployment helper behavior for the Vyper contracts' ABI-visible
public/external functions and events.

For Vyper deployment helpers, record any project-local compiler or bytecode
path, constructor/init argument handling, FFI configuration, runtime bytecode
injection, initializer/manual setup, and import paths already present in the
fixture.

Record whether compilation status is known from existing evidence.

Do not edit production contracts or repository source files; write only the
required artifacts. Do not rename or rewrite working fixtures, and do not change
import paths only to match reference filenames such as `Setup.t.sol`; those
examples describe structure, not a required naming migration. Do not stage,
commit, push, or rewrite unrelated configuration.

Identify existing dependency locations and import assumptions for the base
fixture. Record missing workspace-relative dependencies as blockers or
unknowns. Do not install, fetch, restore, or update dependencies to resolve
them: no `git clone`, `forge install`, `git submodule update`, `npm install`,
`pnpm install`, `yarn install`, `bun install`, or `pip install`, and no
rewritten lockfiles or dependency-vendor directories. This node's workspace
state is captured into the patch every downstream analysis workspace receives,
so any such change would move the whole run off the pinned source snapshot.

For Vyper targets, treat unavailable `forge`, `vyper`, `vyper-json`, or
project-local Vyper dependencies as explicit validation blockers.

Report reusable `BaseTest`/`Setup` fixture paths and import paths that
downstream prompts may reference.

Write your analysis to {{artifact_path}}/setup/base-test-setup.md
