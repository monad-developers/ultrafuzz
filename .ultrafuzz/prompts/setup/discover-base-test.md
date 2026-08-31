---
id: base-test-setup
display_name: BaseTest / Setup
---

# BaseTest / Setup

You are a Lead Security Researcher.

Your job is to set up the base test infrastructure for the Foundry project so that it can be easily reused by fuzz tests and invariant tests.

Investigate whether a base test file already exists, typically `BaseTest[.t].sol` or analogous, which extends from `forge-std/Test.sol`. If this exists, investigate how the production contracts are deployed and configured for Foundry tests, typically by extending from an abstract `Setup[.t].sol`, `Deploy[.t].sol`, or analogous. This is the ideal configuration for shared support of fuzz tests and invariant tests.

If the configuration is not close to the ideal one, restructure Foundry fuzz tests around a [BaseTest.t.sol](https://github.com/rheo-xyz/very-liquid-vaults/blob/main/test/BaseTest.t.sol#L44) which [extends from Setup.t.sol](https://github.com/rheo-xyz/very-liquid-vaults/blob/main/test/BaseTest.t.sol#L30) that is an [abstract contract](https://github.com/rheo-xyz/very-liquid-vaults/blob/main/test/Setup.t.sol#L45) containing a [`deploy`](https://github.com/rheo-xyz/very-liquid-vaults/blob/main/test/Setup.t.sol#L80) type of function that will create all production contracts, mint tokens, and setup allowances that are necessary for subsequent test files.

The workflow applies the validated setup patch from the preceding Foundry
setup node before this workspace starts, and captures this node's own tracked
and untracked fixture/configuration changes for later strategy nodes. Use and
validate the files that are present in this workspace, then record every file
you create or change in the handoff.

If an existing Foundry fixture already compiles and provides a reusable deploy/setup base, preserve its current file names and imports. Do not rename working fixtures, change import paths, or rewrite source files only to match reference filenames such as `Setup.t.sol`; those examples describe structure, not a required naming migration.

If the setup handoffs identify Vyper-only or mixed Solidity/Vyper production
contracts, make the reusable Foundry fixture Vyper-aware while keeping the tests
Solidity-based. Define Solidity interfaces for the Vyper contracts' ABI-visible
public/external functions and events, or reuse ABI-derived interfaces generated
by the target repository. Do not require Foundry to compile `.vy` files as
Solidity sources.

For Vyper deployment helpers, prefer one reusable path that compiles creation
bytecode with the target project's pinned compiler/tooling from the project
root, normally a project script, `vyper`, or `vyper-json`, then deploys the
returned bytes from Solidity with `vm.ffi` plus inline `create`. The shared
helper must hex-decode ASCII hex compiler stdout into raw creation bytecode
before deployment, and it must append ABI-encoded `__init__` constructor
arguments without a function selector using
`bytes.concat(decodedBytecode, abi.encode(...))` before inline `create` when
the Vyper target has initialization parameters. Keep the helper close to the
shared `BaseTest`/`Setup` fixture and record the import path and required
validation command, such as `forge test --ffi`, or the need for `ffi = true` in
`foundry.toml`.

Do not pass undecoded `vm.ffi` stdout directly to `create` or drop
constructor/init data in the shared base fixture. Strategy tests consume this
fixture, so constructor-dependent Vyper contracts need decoded initcode plus the
appended ABI-encoded arguments during `setUp()`.

Use `vm.etch` only for explicit runtime-bytecode injection cases. Document that
`vm.etch` does not run constructors or init code and does not initialize storage;
for constructor/init-dependent Vyper contracts, deploy creation bytecode with
the helper or call the initializer/manual setup after etching runtime bytecode.

Make sure Foundry compilation is passing.

Any test dependency you add for the base fixture must be patch-visible to
downstream Ultrafuzz workspaces. Do not leave required imports only in a nested
git checkout or submodule whose contents will not be captured in the patch
artifact. If you add `forge-std`, use a project-supported dependency mechanism
or vendor/copy it without `.git` metadata. Verify concrete workspace-relative
files with simple commands or the Read tool, for example `ls -la lib`,
`ls -la lib/forge-std/src/Test.sol`, or Read on the file you will import.

If the setup handoff says `lib/forge-std` exists but this isolated workspace is
missing it, treat that as stale or non-patch-visible handoff evidence. Do not
search global paths or merge optional dependency probes with shell syntax. Use
separate workspace-relative checks and let missing paths report naturally.
If you cannot make `forge-std` patch-visible, do not import it from new base
fixtures; use a minimal local support file under `test/foundry/` and document
the dependency limitation in the handoff.

For Vyper targets, treat unavailable `forge`, `vyper`, `vyper-json`, or
project-local Vyper dependencies as explicit validation blockers. Do not use
host-global compiler paths, nested checkouts, or untracked vendored dependencies
as the normal path for making the fixture compile in this isolated workspace.

Place reusable `BaseTest`/`Setup` fixtures where the target project's
`foundry.toml` and existing conventions make them compile, and record the import
path downstream tests should use. Do not describe that shared fixture location
as the directory where later strategy agents should write generated tests.
Strategy prompts provide their own exact generated-test directory, and
Ultrafuzz collects generated strategy tests from that runtime path under
`test/foundry/<strategy>`.

Write your analysis to {{artifact_path}}/setup/base-test-setup.md
