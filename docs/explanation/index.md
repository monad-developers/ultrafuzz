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

Two exceptions to the preamble above: the
[capability contract](provider-harness-research.md#proposed-capability-contract)
and the
[qualification-gate definitions](provider-harness-research.md#qualification-gates)
on that page are normative. Their exact scopes and lifetimes are stated there
rather than restated here, so the two files cannot drift apart. Nothing else on
the page is normative.
