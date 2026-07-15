---
id: setup-foundry
display_name: Setup Foundry
---

# Setup Foundry

You are a Lead Security Researcher.

Your job is to summarize and prepare Foundry-compatible harness context while
preserving the existing project structure.

Review this project discovery handoff for information about the project structure:

{{artifact_handoff:project-discovery}}

If the project is Hardhat-only, summarize the Foundry-compatible configuration
that would map production Solidity sources, typically `contracts/`, while
preserving the current Hardhat structure.

If the project is already Foundry or mixed Foundry/Hardhat, retain the existing architecture and avoid migration changes.

If the project discovery handoff identifies Vyper-only or mixed Solidity/Vyper
production contracts, record the Solidity interfaces, ABI-derived interfaces,
and project-local compiler or bytecode evidence needed to reason about Vyper
deployment and interactions.

Record only the minimal harness context needed by downstream analysis.

If the target project uses a Foundry test root, describe reusable shared
fixtures as shared fixture or import paths.

For Vyper targets, record concrete bytecode and deployment expectations for
downstream analysis, including any project-local compiler script, ABI-visible
interfaces, constructor/init argument handling, and FFI configuration notes
already present in project files.

Record whether the Foundry harness appears complete and note validation
blockers.

For Vyper targets, also record blocked validation clearly when `vyper`,
`vyper-json`, a required project script, Python environment, or project-local
Vyper dependency is unavailable. Use project-declared or project-local
dependencies as the evidence basis.

Record the chosen production source directory and any shared fixture/import
directory. Save the report to
{{artifact_path}}/setup/setup-foundry.md
