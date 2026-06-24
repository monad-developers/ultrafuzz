---
id: property-specification
display_name: Property specification
---

# Property specification

Review the project documentation, README, whitepaper, architecture notes,
protocol docs, and existing tests. Enumerate properties that can be used in
fuzz, invariant, and property-based tests before the strategy agents author
tests.

Use project documentation, tests, and any pinned reference artifacts supplied by the active topology for general property-writing guidance.

# Property Discovery Workflow

Work from specification to implementation, not the other way around:

- Understand the system at a high level from docs, storage, interfaces, scripts,
  and existing tests before writing test code.
- Draft properties in English or pseudocode first.
- Make assumptions explicit and separate setup requirements from property logic.
- Keep properties independent, well-scoped, and not just mirrors of
  implementation internals.
- Maintain a property inventory with type, impact, priority, source evidence,
  required setup, and confidence.
- Remove duplicates and rank by severity and bug-finding value.
- Prefer team-reviewable statements that protocol designers and engineers can
  challenge.

# Property Classes

Capture candidate properties by class:

- Valid states: for each state machine state, assert what must be true. Look for
  paused, frozen, initialized, recovery, borrowing, liquidating, migrated, or
  settled states. Identify implicit states hidden behind combinations of flags,
  timestamps, balances, debt, duplicated storage, or non-disjoint modifiers.
- State transitions: assert what must change at state-machine edges. Examples:
  transfers move balances, proposal states advance only after required
  conditions, unlocks happen only after duration, liquidation changes solvency
  status, and finalization clears pending state.
- Variable transitions: track specific variables across calls. Examples: fees
  only increase or stay flat when monotonicity is required, rates stay in
  documented bounds, indexes do not move backwards, share price evolves
  consistently, and accounting deltas match the operation.
- High-level properties: capture system-wide guarantees across actors, markets,
  assets, and roles. Examples: solvency, fair share pricing, no unexpected
  value extraction, no unbacked claims, conservation of assets, and aggregate
  accounting equality.
- Unit-test and scenario properties: reserve precise sequences for regression
  or deliberately extreme "should never happen" stories. Do not start with only
  scripted sequences when the fuzzer should discover unexpected orderings.
- Round-trip properties: when a sequence should be reversible, compare pre- and
  post-state or value. Examples: deposit then withdraw, swap in then out, mint
  then burn, wrap then unwrap, or `decode(encode(x)) == x`.
- Access-control properties: record authorization rules such as only admins can
  pause or upgrade, only governance can set parameters, and unauthorized calls
  revert. Prefer actor modeling when it improves coverage, but keep explicit
  access-control properties where authorization is a core guarantee.
- Differential and reference-model properties: compare target behavior with
  reference contracts, adapters, library implementations, formulas, existing
  tests, or documented examples.
- Decode/encode and serialization properties: check ABI, packed encoding,
  custom serialization, malformed input behavior, empty values, zero values,
  maximum values, nested values, and lossy casts.
- Known gap properties: record rounding, dust, precision, phase, oracle,
  external dependency, and setup-bias gaps separately so downstream agents can
  decide whether they are properties, assumptions, or blockers.

# Preconditions And Implementation Notes

For each candidate, identify:

- the states or preconditions where the property is meaningful
- the smallest realistic setup needed to reach those states
- actors, assets, managers, roles, approvals, mocks, and time movement
- ghost variables needed for before/after, historical, or aggregate checks
- whether a ghost update could overflow, revert, or become too gas-intensive
- whether failures should be target bugs, specification/model bugs, harness
  bugs, or inconclusive

When analyzing a candidate, ask "when can this happen?" and avoid unnecessary
assumptions. If a property requires a precise sequence, list the sequence, but
also note whether a stateful fuzzer should be allowed to discover it naturally.

# False Positive Traps

Call out risks that would make a property misleading:

- the property is impossible or not well-defined for some reachable state
- the property is too local and duplicates an existing require/assert
- the property mirrors implementation details instead of the intended behavior
- the handler model creates unrealistic paths
- the setup makes the property true by construction
- the property hides a real bug behind broad skips, broad try/catch, or overly
  restrictive preconditions

For each property, record the source document or test that motivated it, the
contract or workflow under test, the observable oracle, necessary setup,
preconditions, expected fuzzing framework, and whether failures should be
treated as target bugs, specification/model bugs, harness bugs, or inconclusive.

Write a concise property catalog artifact that downstream strategies can read
before implementing tests.

Findings discipline: property candidates are planning material, not campaign
findings. Do not copy the property catalog into `findings.json`; write `[]`
there unless you independently identify a concrete target vulnerability with
specific evidence.
