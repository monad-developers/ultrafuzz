# Explanation

Explanation pages describe why Ultrafuzz is shaped the way it is. The
normative behavior is still [SPECS.md](../SPECS.md); these pages explain the
product model behind that contract.

- [How Campaigns Work](campaigns.md)
- [Topology, Prompts, and Artifacts](topology-prompts-artifacts.md)
- [Agents, Workflow Boundary, and Safety](backends-safety.md)
- [Provider-agnostic Coding Harness Research](provider-harness-research.md)
- [Separating Provider, Harness, and Model (HTML report)](provider-harness-plan.html)
- [Aave v4 Invariant Case Study](aave-v4-invariant-case-study.md)
- [Monad Bugfinder Context](bugfinder.md)

## Reading The Provider/Harness Pair

The two provider/harness pages are one piece of work in two formats, and they
are read differently:

- **[Provider-agnostic Coding Harness Research](provider-harness-research.md)**
  is the GitHub-readable companion. It renders inline in the GitHub file
  browser and carries the evidence, the capability contract, the numbered
  qualification gates, and the full source list.
- **[Separating Provider, Harness, and Model](provider-harness-plan.html)** is a
  self-contained HTML report. GitHub serves `.html` files as plain text rather
  than rendering them, so **download the file and open it in a browser** (or
  view it from a local checkout) to read it as intended.

The two pages overlap but neither contains the other, so the split is worth
knowing before you pick one:

- **Only in the HTML plan:** **§1 Verdict**; **§7 Risks**, the severity-ranked
  register with its mitigations; **§9 Proposed GitHub issues**, the drafted
  bodies that became
  [#658](https://github.com/monad-developers/ultrafuzz/issues/658)–[#664](https://github.com/monad-developers/ultrafuzz/issues/664);
  the **§2** table of obsolete draft claims and their replacements; the
  Modal-portability evidence row of its **§3.1** dsh table; and the row-by-row
  **§3.1** detail behind findings the Markdown page states in condensed form
  (packaging, retry, maintenance posture).
- **Only in the Markdown research page:** the TOML configuration boundary, the
  TypeScript capability interfaces, the legacy `agent = "…"` forward mapping, the
  five dsh-specific gate items, and the full per-file source list with every
  DeepSeek Harness URL pinned to a commit.
- **On both:** the correction narrative, the candidate comparison and its
  evidence provenance, the pairing policy, the capability-contract vocabulary,
  the credential and state rules, and the numbered qualification gates G1–G10
  that the child issues cite by number.
- **On both in different form:** the HTML plan's **§6 Sequencing** is condensed
  on the Markdown page into its "Next Work" list.

Read the Markdown page for the evidence and the contract; open the HTML plan for
the verdict, the risks, and the issue breakdown.
