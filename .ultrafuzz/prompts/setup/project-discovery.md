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

Before writing the normalized inventory, create a machine-readable `Verbatim
source-evidence ledger` at
`{{artifact_path}}/setup/invariant-evidence-ledger.json`. Use the task-local
`{{schema_path}}/invariant-evidence-ledger.schema.json` and assign each entry a
stable `id`, source path, line or symbol location, kind, verbatim source text,
and one or more `inventory_ids` using the `inventory-` prefix. Scan every
relevant documentation, specification, NatSpec, source-comment, test, and
harness section and every explicitly enumerated bullet or formula, regardless of
the section heading. Classify statements that express invariants, accounting,
solvency, conservation, monotonicity, safety, risk, interest accrual,
liquidation, liveness, or another state relation. Copy each such statement
verbatim before interpreting it, including statements under generic headings such
as `Hub`, `Risk`, or `Operations`. Obtain each cited source span mechanically from
the checked-out file (for example with a line-range `sed` or `nl`/`sed` probe) and
paste that output into the JSON value. Do not retype or render Markdown or LaTeX.
Preserve every backslash, quote, punctuation mark, repeated escape, and source
character exactly; JSON escaping is serialization only, so the parsed `verbatim`
value must contain the same characters as the cited source span. Before finishing
discovery, load the JSON ledger and compare each `verbatim` field with its cited
source line range (allowing only the source's line-ending convention), then fix
any mismatch before publishing the artifact. Include source path and line or symbol location
beside each copied entry. Do not summarize, merge, or omit a source
bullet before it has a corresponding ledger entry; the normalized inventory must
map each ledger entry to one or more `inventory_ids` and retain the original
operands, comparison direction, units, denominator, and rounding terms. If a
separate source probe finds no matching section, record that probe and its result
rather than silently skipping it.

The JSON ledger must also contain `inventory_rows`, where each row has a
stable `inventory-` ID, a normalized description, and one or more
`ledger_ids`; every `inventory_id` in an entry must name one of these rows.
Record each negative source probe in `scan_probes` with a stable `probe-` ID,
source path, query, and result. A probe `source_path` may name a real
directory you searched, or a path that turned out not to exist; neither is
snapshotted, so either is a fine record of where you looked. A symlink is not:
neither a symlinked directory nor any path reached through one is accepted. A
probe that names an existing file IS snapshotted: it must be UTF-8 text,
tracked at the pinned commit and unmodified, so prefer the directory you
searched or the absent path itself over a generated or untracked file such as
build output. What a probe does not need is quoted text: an entry's `verbatim`
is compared against its source, a probe's `result` is not. Use `safety`,
`risk`, or `interest` as the `kind` when those are the most precise
classifications. Keep every `source_path` target-relative; for ledger
`entries`, use a line range or symbol that can be checked against the
checked-out source.
If no invariant statement is found, emit `entries: []`, `inventory_rows: []`,
at least one non-empty `scan_probes` record explaining the searches and
their results, and a `no_invariants_justification` stating why this target
carries no invariant: what you searched, and why the absence is a property of
the target rather than of the search. The justification is required only for an
empty ledger and is rejected on a ledger that has entries.

### Byte-preserving ledger construction

Treat every `verbatim` value as a byte-preserving source slice. The verifier
normalizes only line endings, terminal line separators, and a leading Markdown
presentation prefix; retain internal and trailing source whitespace. For a line
location, derive the value by reading the cited file and slicing the requested
line range; for a symbol location, derive it from the matching declaration.
Use a short local script that reads the source and serializes the ledger with
`JSON.stringify` (or an equivalent JSON serializer), then inspect the parsed
JSON value before publishing it. This keeps Markdown math and escaped literals
such as `\\%` and `\\times` intact: JSON source shows each backslash escaped,
while the parsed `verbatim` value must equal the source slice, including repeated
backslashes and other literals. Build the Markdown
handoff from those same parsed ledger objects so its `verbatim` blocks carry the
identical text. Render multiline `verbatim` values as an indented literal block:
place two spaces before each source line after the `verbatim:` field. This keeps
source headings and delimiter-looking lines inside the field while preserving
the parsed text. Keep extraction scripts small and file-based so source slices
are not retyped in a large inline shell command.

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

The Markdown discovery handoff must reproduce every ledger entry's stable ID,
source path, source location, verbatim text, and inventory IDs so reviewers can
audit the structured artifact without opening JSON. A source statement may map to
multiple normalized inventory rows, and equivalent source statements may map to
one row; record those cardinalities explicitly rather than forcing a one-to-one
mapping. Render each entry in a delimited block beginning with
`### Ledger entry: <id>` and each normalized row in a block beginning with
`### Inventory row: <inventory-id>`, including the complete fields in each block.
Close those blocks with `### End ledger entry: <id>` and
`### End inventory row: <inventory-id>` respectively.
