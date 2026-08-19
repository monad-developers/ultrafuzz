# Explanation

Explanation pages describe why Ultrafuzz is shaped the way it is. The
normative behavior is still [SPECS.md](../SPECS.md); these pages explain the
product model behind that contract.

- [How Campaigns Work](campaigns.md)
- [Topology, Prompts, and Artifacts](topology-prompts-artifacts.md)
- [Agents, Workflow Boundary, and Safety](backends-safety.md)
- [Provider-agnostic Coding Harness Research](provider-harness-research.md)
- [Provider/Harness Architecture Plan (HTML report)](provider-harness-plan.html)
- [Aave v4 Invariant Case Study](aave-v4-invariant-case-study.md)
- [Monad Bugfinder Context](bugfinder.md)

## Reading the provider/harness pair

The two provider/harness pages are one piece of work in two formats, and they
are read differently:

- **[Provider-agnostic Coding Harness Research](provider-harness-research.md)**
  is the GitHub-readable companion. It renders inline in the GitHub file
  browser and carries the evidence, the capability contract, the conformance
  gate, and the full source list.
- **[Provider/Harness Architecture Plan](provider-harness-plan.html)** is a
  self-contained HTML report. GitHub serves `.html` files as plain text rather
  than rendering them, so **download the file and open it in a browser** (or
  view it from a local checkout) to read it as intended.

Most sections appear in both. Two are unique to the HTML plan: **§7 Risks**,
the severity-ranked risk register with its mitigations, and **§9 Proposed
GitHub issues**, the drafted issue bodies that became
[#658](https://github.com/monad-developers/ultrafuzz/issues/658)–[#664](https://github.com/monad-developers/ultrafuzz/issues/664).
Read the Markdown page for the evidence; open the HTML plan for the risks and
the issue breakdown.
