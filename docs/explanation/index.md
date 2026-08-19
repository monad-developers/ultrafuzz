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
The former standalone HTML rendering was removed in response to maintainer
review so the plan has one reviewable source of truth in Git.

One exception to the preamble above: the provider/harness **capability contract**
— the capability names and their exact spellings, the event-class comparison
relation, and the configuration invariants — _is_ normative for
[#658](https://github.com/monad-developers/ultrafuzz/issues/658) and its child
issues, and the Markdown research page is where it is stated. Until
[SPECS.md](../SPECS.md) absorbs that contract, where the issue text and the
research page disagree on a capability spelling, the research page wins. Nothing
else on the page is normative.
