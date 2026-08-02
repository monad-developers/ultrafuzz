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

If the setup handoffs identify Vyper-only or mixed Solidity/Vyper production
contracts, record visible Solidity interfaces, ABI-derived interfaces, and
existing deployment helper behavior for the Vyper contracts' ABI-visible
public/external functions and events.

For Vyper deployment helpers, record any project-local compiler or bytecode
path, constructor/init argument handling, FFI configuration, runtime bytecode
injection, initializer/manual setup, and import paths already present in the
fixture.

Record whether compilation status is known from existing evidence.

Identify existing dependency locations and import assumptions for the base
fixture. Record missing workspace-relative dependencies as blockers or
unknowns.

For Vyper targets, treat unavailable `forge`, `vyper`, `vyper-json`, or
project-local Vyper dependencies as explicit validation blockers.

Report reusable `BaseTest`/`Setup` fixture paths and import paths that
downstream prompts may reference.

Write your analysis to {{artifact_path}}/setup/base-test-setup.md

Write `[]` to {{output_findings_path}} when this setup review does not
independently reproduce a concrete public-impact target defect with actionable
evidence. Record reusable fixture context in
{{artifact_path}}/setup/base-test-setup.md.
