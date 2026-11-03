---
name: run-stateful-fuzzing
description: Implement supplied smart-contract properties in a reachable stateful harness, run a bounded campaign, and investigate reproducible counterexamples.
---

Read the properties input and retain its identifiers in tests and the report. Map each property to an executable assertion, relevant actions, actors and preconditions. Mark unsupported or ambiguous properties as blocked with a reason; do not silently skip or reinterpret them.

Start with a deployment that reflects the protocol's initialization and privileges. Reach state through public actions wherever possible. Use handlers to exercise meaningful valid operations without filtering out the edge cases under test. Track independent accounting in ghost state where necessary; do not validate a value by reusing the same computation that produced it. Check that fuzz calls reach intended paths rather than reverting at setup or authorization checks.

Inspect the installed Recon, Chimera and Foundry commands and the target's build configuration. Reuse an appropriate existing harness, or create a small one. Compile and run a deterministic smoke sequence before a longer campaign. Record exact commands, versions and elapsed campaign time. Follow the supplied fuzz budget and reserve time for replay and reporting.

When an assertion fails, replay and minimize the sequence. Confirm the failure in a legitimate reachable state and separate expected reverts, harness defects and oracle mistakes from violations of the supplied guarantee. Preserve the reproducer and property identifier. Explain any corrected assumption before changing an assertion. Report execution failures and unexercised properties even when no vulnerability is established.

Write `report.md` only when finished. Include each property's implemented, blocked, failed or exercised outcome and coverage limits. Place test sources and minimized reproducers in the output directory. Keep corpora, caches and temporary progress outside final deliverables.

## Property references

For standards-specific oracle design, consult [crytic/properties at 5ea14b813ff296e24b4257ab52a0402360f916f6](https://github.com/crytic/properties/tree/5ea14b813ff296e24b4257ab52a0402360f916f6) and, for ERC-4626, [a16z/erc4626-tests at ac485460e014f22807c1ff687e0b4dc3af96ee40](https://github.com/a16z/erc4626-tests/tree/ac485460e014f22807c1ff687e0b4dc3af96ee40). Both revisions declare GNU AGPL v3 in their respective [crytic license](https://github.com/crytic/properties/blob/5ea14b813ff296e24b4257ab52a0402360f916f6/LICENSE) and [a16z license](https://github.com/a16z/erc4626-tests/blob/ac485460e014f22807c1ff687e0b4dc3af96ee40/LICENSE). These are external references; this original skill vendors neither project's text nor implementation. Any proposed code reuse needs an explicit dependency and license decision.
