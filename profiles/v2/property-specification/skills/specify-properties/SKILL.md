---
name: specify-properties
description: Derive falsifiable protocol invariants and transition properties from the supplied smart-contract source for a property-specification run.
---

Connect each proposed property to an intended guarantee and an observable state relation. Distinguish a protocol invariant from an ERC compatibility rule, a policy choice, or a desirable feature. When intent is unclear, record the assumption instead of treating it as a vulnerability.

Use stable `P-001` identifiers. For each property specify the actors, quantities and units, allowed actions, preconditions, independent oracle, tolerances, source locations and a sequence that could falsify it. An oracle that calls the same suspect implementation is not independent. Account for fees, donations, rounding and permitted losses before asserting conservation or monotonicity. Describe when a revert is expected and when it indicates a liveness failure.

For stateful testing, include relationships before and after a transaction and across multiple actors. Consider stale approvals, callbacks, partial fills, empty and nearly empty state, role changes, and operation ordering only where relevant to this protocol. Avoid a generic checklist disconnected from reachable code.

Write the final specification to `report.md`. Include a concise coverage map and identify properties blocked by unavailable dependencies or unresolved intent. Property generation is not a proof of correctness and does not require inventing a finding.

## Reference catalogs

These projects can inform which standards-related properties deserve investigation. Verify applicability against the supplied code rather than importing a catalog wholesale. This skill's guidance is original; no upstream text or code is bundled.

- [crytic/properties at 5ea14b8](https://github.com/crytic/properties/tree/5ea14b813ff296e24b4257ab52a0402360f916f6) catalogs reusable Ethereum properties. Its [license at that revision](https://github.com/crytic/properties/blob/5ea14b813ff296e24b4257ab52a0402360f916f6/LICENSE) is GNU AGPL v3.
- [a16z/erc4626-tests at ac48546](https://github.com/a16z/erc4626-tests/tree/ac485460e014f22807c1ff687e0b4dc3af96ee40) is a reference for vault compatibility testing. Its [license at that revision](https://github.com/a16z/erc4626-tests/blob/ac485460e014f22807c1ff687e0b4dc3af96ee40/LICENSE) is GNU AGPL v3.

The citations are references, not vendored dependencies. Do not copy their implementation into the target as part of this specification task.
