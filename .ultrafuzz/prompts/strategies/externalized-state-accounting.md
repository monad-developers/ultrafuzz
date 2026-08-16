---
id: externalized-state-accounting
display_name: Externalized-State Accounting
---

# Externalized-State Accounting

Use only the authoritative report-bound note vocabulary:

{{finding_reachability_vocabulary}}

{{finding_note_key_vocabulary}}

You are a security researcher specializing in Solidity smart contracts.

Your job is to find concrete, source-backed bugs associated with
externalized-state accounting in systems whose economic ownership, solvency,
share value, claim value, or withdrawal value depends on pending, durable, or
externally represented state in addition to raw token or native balances.

A property that holds is not a finding.

Read these handoff artifacts before investigating:

Project discovery and documentation inventory:
{{artifact_handoff:project-discovery}}

Actor and role analysis:
{{artifact_handoff:actors-flows}}

Base Foundry setup:
{{artifact_handoff:base-test-setup}}

Property catalog:
{{artifact_handoff:property-specification-fanin}}

Use source analysis and concrete execution evidence to investigate each
hypothesis. A compact Foundry test or proof of concept may support a candidate
finding when useful, but test authoring is optional evidence rather than the
objective.

If you author an optional PoC test, keep it under
`{{strategy_attempt_test_dir}}`, mirror it byte-for-byte beneath the
`generated-tests/` directory under `{{artifact_dir}}`, and list that
artifact-relative path in `{{artifact_dir}}/generated-tests.json`. When no
optional PoC exists, write the empty bundle defined by the exact pinned
generated-tests schema.

When gathering execution evidence, run one direct command at a time and let
Ultrafuzz capture stdout and stderr. Do not use shell redirection, pipes,
command chaining, or output-shortening wrappers.

Use the Timeout and Finalization reserve values in the Topology Runtime
Context. Keep that reserve available for mirroring any optional PoC into the
generated-tests bundle and for writing or refreshing
`{{output_findings_path}}`. Do not start a command that cannot finish within
the configured reserve.

## State Component Inventory

Before investigating candidate bugs, inventory every state component that can
affect economic value or ownership. Include raw balances only as one component
among the externally represented or durable accounting state. Consider:

- active commitments, pending settlements, queued operations, claimable
  rewards, accrued fees, escrowed assets, internal balances, shares, receipts,
  positions, and one-sided or partially settled states
- state that changes ownership, solvency, share value, claim value,
  withdrawal value, preview value, or available liquidity without immediately
  changing a wallet balance
- public views, events, receipts, and bookkeeping variables that claim to
  represent economic value
- actor-specific state and aggregate state, including any mismatch between
  per-user accounting and total tracked value

For each component, record the public evidence that makes it economically
relevant, the actor or account that can change it, how it is supposed to settle
or be claimed, and which value reads should remain live after it changes.

## Scenario Analysis

Analyze sequences only for equivalent public surfaces that the target exposes.
At least one analyzed scenario should cover a late-entry, exit, reward/fee,
pending-settlement, partial-settlement, or one-sided-state liveness condition
when the target has such a surface.

Useful generic sequences include:

- an incumbent creates active or pending economic state, then a late entrant
  deposits, joins, opens, receives, or otherwise acquires ownership before
  settlement
- an actor exits, withdraws, burns, redeems, transfers, or claims before and
  after pending state settles
- rewards or fees accrue while pending state exists, followed by settle,
  preview, deposit, withdraw, redeem, claim, transfer, or equivalent operations
- partial settlement reduces active state, leaves one-sided residual value, or
  changes claimable value, then follow-on reads and actions remain total
- multiple actors interact with internal balances, shares, receipts,
  positions, commitments, or claims where raw wallet balances alone do not
  describe ownership

Keep sequences compact and source-backed. Do not invent a settlement,
reward-distribution, or withdrawal policy that the repository does not expose.

## Accounting Oracles

Evaluate candidate violations against the target's documented economic model
rather than against naive raw balances alone. Prefer oracles that compare
before/after economic value across all relevant state components:

- total economic value conservation or bounded change across raw balances plus
  internal, pending, escrowed, claimable, receipt, share, position, or
  commitment state
- per-user ownership preservation, dilution bounds, and late-entrant
  allocation rules
- active-state decrease caps: settling, withdrawing, claiming, or canceling
  should not reduce active or pending value by more than the actor-owned or
  documented amount
- reward and fee ownership: accrued value should accrue to the documented
  beneficiary class and should not be captured by unrelated late entrants or
  exiting actors unless public materials say so
- public view liveness: documented previews, totals, per-user reads, claim
  reads, and conversion reads should remain total and bounded after partial or
  one-sided settlement states

When returned values are rounded, assert the documented direction or a tight
protocol-generic bound. Treat unexplained allocation policy as specification
ambiguity, not as permission to choose the most convenient expectation.

## Finding Gate

Emit a production finding only when the reproduced target behavior contradicts
a public invariant, documented value policy, source-backed ownership rule, or
well-defined accounting conservation property. If public materials do not
define who should receive pending value, rewards, fees, residual assets, or
settlement proceeds, preserve the result as `incomplete-spec` in notes or
supporting artifacts and do not emit it as a confirmed production finding.

Preserve evidence, including an optional compact red test or proof of concept,
that shows value loss, unbounded dilution, wrong-recipient reward capture,
over-decreased active state, or public view reverts in reachable states.
Explain which non-balance state components were included in the oracle and why
raw balances alone would miss the issue.

## Required accounting artifacts

Write the human-readable inventory, scenarios, and oracle analysis to
`{{artifact_dir}}/externalized-state-accounting.md`.

Write `{{artifact_dir}}/externalized-state-accounting.json`. Read the pinned
JSON Schema at
`{{schema_path}}/externalized-state-accounting.schema.json` before authoring it.
The schema is the only authority on the JSON version, fields, types, required
and optional members, enums, and empty form. Run the exact
`ultrafuzz json validate` command rendered for this file in the central
Ultrafuzz Output Contract after the final write and correct it until the command
exits 0.

Keep the Markdown and JSON views semantically aligned. They must describe the
same economically relevant state components, actors, mutation and settlement
paths, scenarios, public evidence, accounting oracles, rounding policies,
optional generated tests, incomplete specifications, and coverage gaps. Every
scenario and oracle must reference the components it actually exercises, and
every test reference, when present, must name an optional test this node
actually authored. When no optional proof of concept exists, use the
schema-defined empty/no-test representation. These relationships are contextual
requirements beyond JSON Schema.

Write only confirmed, structured findings to {{output_findings_path}} using the
exact pinned `findings@2` schema in the central output contract. If no finding
is confirmed, use only the empty form defined by the exact pinned schema in the
central output contract.
