---
id: base-test-setup
display_name: BaseTest / Setup
---

# BaseTest / Setup

You are a Lead Security Researcher.

Your job is to setup the base test infrastructure for the Foundry project so that it can be easily reused by fuzz tests and invariant tests.

Investigate whether a base test file already exists, typically `BaseTest[.t].sol` or analogous, which extends from `forge-std/Test.sol`. If this exists, investigate how the production contracts are deployed and configured for Foundry tests, typically by extending from an abstract `Setup[.t].sol`, `Deploy[.t].sol`, or analogous. This is the ideal configuration for concomitant support of fuzz tests and invariant tests.

If the configuration is not close to the ideal one, restructure Foundry fuzz tests around a reusable `BaseTest.t.sol` which extends a setup helper such as `Setup.t.sol` or `Deploy.t.sol`. That setup helper should contain a deploy-style function that creates all production contracts, mints tokens, and establishes the allowances that subsequent test files need.

If an existing Foundry fixture already compiles and provides a reusable deploy/setup base, preserve its current file names and imports. Do not rename working fixtures, change import paths, or rewrite source files only to match reference filenames such as `Setup.t.sol`; those examples describe structure, not a required naming migration.

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
search global paths or merge optional dependency probes with shell syntax.
Wrong: `find / -type d -name "forge-std" 2>/dev/null`. Wrong:
`ls -la node_modules/forge-std node_modules/.bin/forge 2>&1; echo "---"; ls node_modules 2>&1 | head -5`.
Use separate workspace-relative checks and let missing paths report naturally.
If you cannot make `forge-std` patch-visible, do not import it from new base
fixtures; use a minimal local support file under `test/foundry/` and document
the dependency limitation in the handoff.

Place reusable `BaseTest`/`Setup` fixtures where the target project's
`foundry.toml` and existing conventions make them compile, and record the import
path downstream tests should use. Do not describe that shared fixture location
as the directory where later strategy agents should write generated tests.
Strategy prompts provide their own exact generated-test directory, and
Ultrafuzz collects generated strategy tests from that runtime path under
`test/foundry/<strategy>`.

Write your analysis to {{artifact_path}}/setup/base-test-setup.md
