# Explanation

Explanation pages describe why Ultrafuzz is shaped the way it is. The
normative behavior is still [SPECS.md](../SPECS.md); these pages explain the
product model behind that contract.

- [How Campaigns Work](campaigns.md)
- [Topology, Prompts, and Artifacts](topology-prompts-artifacts.md)
- [Agents, Workflow Boundary, and Safety](backends-safety.md)
- [Provider-agnostic Coding Harness Research](provider-harness-research.md)
- [Aave v4 Invariant Case Study](aave-v4-invariant-case-study.md)
- [Monad Bugfinder Context](bugfinder.md)

## Reading The Provider/Harness Plan

The
**[Provider-agnostic Coding Harness Research](provider-harness-research.md)**
page is the complete GitHub-readable plan. It carries the recommendation and
action summary, evidence matrix, configuration and capability contracts,
qualification gates, child-issue mapping, constraints, and pinned source list.

One exception to the preamble above: the
[capability contract](provider-harness-research.md#proposed-capability-contract)
on that page is normative for the seven child issues of
[#653](https://github.com/monad-developers/ultrafuzz/issues/653) —
[#658](https://github.com/monad-developers/ultrafuzz/issues/658) through
[#664](https://github.com/monad-developers/ultrafuzz/issues/664) — until
[SPECS.md](../SPECS.md) absorbs it. The rule and its scope are
stated there rather than restated here, so the two cannot drift apart. Nothing
else on the page is normative.
