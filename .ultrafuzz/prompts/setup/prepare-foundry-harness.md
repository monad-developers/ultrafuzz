---
id: setup-foundry
display_name: Setup Foundry
---

# Setup Foundry

You are a Lead Security Researcher.

Your job is to make the repository ready for Foundry fuzz tests while preserving the existing project structure.

Review this project discovery handoff for information about the project structure:

{{artifact_handoff:project-discovery}}

If the project is Hardhat-only, set up a Foundry-compatible project without removing the current Hardhat structure. This means you should configure `foundry.toml` to use the production Solidity sources, typically `contracts/`, while adding a Foundry-specific test folder under the existing Hardhat test directory, typically `test/foundry/`.

If the project is already Foundry or mixed Foundry/Hardhat, retain the existing architecture and avoid migration changes.

If the project discovery handoff identifies Vyper-only or mixed Solidity/Vyper
production contracts, keep Foundry as the test harness and do not ask Foundry to
compile `.vy` files as Solidity sources. Configure the harness so generated
`.t.sol` tests interact with Vyper contracts through Solidity interfaces that
match the contracts' public/external ABI, or through ABI-derived Solidity
interfaces when the target repository already generates them.

Create only the minimal harness layout needed by later fuzzing agents.

Solidity dependencies should already have been materialized in this worktree.
The harness preamble's note that dependencies may be absent and should be
installed fresh describes JavaScript packages; it does not apply to `lib/`,
which is populated before your agent runs. Do not copy, vendor, re-download or duplicate any
dependency tree into this workspace under any name. Build against the
dependencies that are already here, and if a dependency genuinely appears to be
missing, record that as blocked in the handoff instead of vendoring a copy.

Every untracked file you create is captured into the workspace patch below, so a
vendored copy of a dependency puts megabytes of third-party source into an audit
artifact. That fails the artifact secret gate on credential-shaped strings those
libraries legitimately contain, which kills this node and every lane that
depends on it.

The workflow captures tracked and untracked harness/configuration changes from
this workspace into a provenance-bound workspace patch for dependent setup and
strategy nodes. Make the changes in this workspace, validate them, and record
the exact paths in the handoff; downstream workspaces receive the validated
patch before their agents run.

Ultrafuzz collects generated strategy tests from the canonical
`test/foundry/<strategy>` tree rendered in each strategy prompt as the exact
strategy test directory. Do not choose or document a different path as the
directory where later strategy agents should write generated tests. If the
target project uses another Foundry test root, you may create reusable shared
fixtures under that active root, but describe them as shared fixture or import paths
rather than the generated strategy test directory.

For Vyper targets, record a concrete bytecode path for downstream tests:

- compile Vyper bytecode with the target project's pinned compiler/tooling from
  the project root, normally a project script, `vyper`, or `vyper-json`;
- prefer a reusable Solidity deployment helper that calls `vm.ffi` to run the
  project-local Vyper compile command, hex-decodes the compiler stdout from
  ASCII hex into raw creation bytecode, appends any ABI-encoded `__init__`
  arguments without a function selector using
  `bytes.concat(decodedBytecode, abi.encode(...))`, and deploys that combined
  initcode with inline `create`;
- never pass undecoded `vm.ffi` stdout directly to `create`; even contracts
  without `__init__` arguments need decoded initcode, and constructor-dependent
  contracts need the ABI-encoded arguments appended before deployment;
- document that local validation and downstream strategy runs must use
  `forge test --ffi`, or `ffi = true` in `foundry.toml`, when the helper uses
  `vm.ffi`;
- reserve `vm.etch` for runtime-bytecode injection cases only. Explain that
  `vm.etch` writes runtime bytecode to an address and does not run constructor
  logic, initialize storage, or execute init code; constructor/init-dependent
  contracts need the deployment helper or an explicit initializer/manual setup
  after etching.

Make sure Foundry compilation is passing.

Check Foundry availability only with `forge --version`. If it reports command
not found, record that `forge` is not available in PATH and continue by writing
the minimal Foundry scaffold and a clear validation note. Do not inspect host
install directories or shell environment variables. Wrong: `echo "$PATH"`.
Wrong: `ls -la ~/.foundry/bin`. Wrong:
`ls -la /home/ubuntu/.foundry/bin`.

For Vyper targets, also record blocked validation clearly when `vyper`,
`vyper-json`, a required project script, Python environment, or project-local
Vyper dependency is unavailable. Do not silently fall back to host-global
compiler paths, nested git checkouts, or untracked vendoring.

Keep dependencies patch-visible for downstream Ultrafuzz workspaces. Do not use
`git clone`, `forge install`, or a submodule just to create `lib/forge-std`
unless the resulting files are ordinary workspace files without nested `.git`
metadata. A nested checkout may compile locally but be omitted from downstream
workspace snapshots, and cleanup with `rm -rf` may be denied. If `forge-std` is
not already present and you cannot make it patch-visible, do not claim it was
vendored; instead use a minimal local test support file under `test/foundry/`
or record the missing dependency clearly in the setup handoff.

Do not stage, commit, push, or rewrite unrelated configuration. Record every
file created or changed, the chosen production source directory, any shared
fixture/import directory you created, and the fact that generated strategy tests
must use the exact runtime strategy test directory from their own prompts. Save
the report to {{artifact_path}}/setup/setup-foundry.md
