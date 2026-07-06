# How Campaigns Work

An Ultrafuzz campaign is a validated graph of agentic and non-agentic work over
a target Solidity repository. The user-facing campaign state is the root
`ultrafuzz.toml` file plus product-owned files under `.ultrafuzz/**`: topology,
prompts, references, run evidence, workspaces, cache entries, review artifacts,
and reports. Materialization is also product-owned, but selected copies land in
reviewed project files only after explicit operator confirmation.

The workflow engine is an implementation detail. Ultrafuzz owns the product
contract: validate the campaign inputs, render prompts, create durable run
evidence, launch a linked workflow, and leave generated changes reviewable until
the operator explicitly materializes them.

## Campaign Phases

The default scaffold moves through four broad phases.

Setup discovers the project, actors, flows, fuzzing framework, and base test
layout.

Properties generate or collect a property catalog from prompts and pinned
reference material. Reference nodes can provide normalized Markdown handoffs
from `.ultrafuzz/references.yml`, but reference fetching is always an explicit
operator action.

Strategies run independent and looped agents that author tests, explore
invariants, build differential harnesses, or expand coverage. Topology controls
loops and explicit model-profile fan-out so repeated attempts are traceable.

Review deduplicates findings, triages severity, aggregates generated tests, and
writes the final report artifacts. Reports are produced by the final-report
phase; they are evidence to inspect, not an automatic security submission.

## Default Strategy Families

The default scaffold mixes broad discovery with targeted test-generation lanes:

- Property discovery lenses produce the shared property catalog.
- Boundary and accounting tests cover admin/config boundaries, dependency
  boundaries, AMM liquidity, payable fallback accounting, externalized-state
  accounting, batch atomicity, router accounting, rounding direction, market
  exhaustion, order replacement, state-machine behavior, and lifecycle/view
  boundaries.
- Input, round-trip, workflow, time, and coverage-expansion strategies turn the
  property catalog into concrete fuzz tests.
- Stateful invariant and differential campaigns build larger harnesses,
  handlers, oracle plans, reference-model lanes, repair passes, and review
  reports.
- Dynamic strategy generation reviews accumulated artifacts, enumerates
  target-specific candidates, and feeds selected generated tests and findings
  into review.

## Why The Graph Is Persisted

Each run writes product evidence such as `run.json`, `config.resolved.toml`,
`graph.json`, `graph.fingerprint`, `state.json`, `events.jsonl`, `plan.json`,
and per-node artifacts under `.ultrafuzz/runs/<run-id>/`. Those files make the
campaign auditable and restartable. A report can be traced back to the exact
topology, prompt renders, reference revisions, model profiles, attempts, and
artifacts that produced it.

## Why Loops Are Explicit

Looped strategy attempts become concrete nodes in the expanded graph. This keeps
parallel attempts deterministic, gives each attempt a stable artifact path, and
lets prompts split work by attempt index and loop count. Explicit model fan-out
serves the same purpose: provenance stays attached to the model profile and
attempt that produced each finding.

## Why Review Is Separate

Lead generation and adjudication are different jobs. Ultrafuzz keeps
generation, dedupe, triage, severity classification, test aggregation, and final
reporting as separate graph nodes so each handoff is inspectable. Findings stay
as allegations until their evidence, generated tests, and report claims are
reviewed.

## How Campaigns Should Be Evaluated

Campaign quality should be measured across repeated runs, not only one lucky or
unlucky attempt. Evaluation should track true positives, underspecified but
actionable findings, false positives, precision, recall, F1, cost, wall-clock
time, token usage, model profile, strategy, loop count, attempt count, and
cumulative unique valid findings.

For target-repository experiments, use local checked-out repositories pinned to
declared upstream refs, keep sensitive ground truth outside this repository, and
compare topology, prompt, model-profile, and run-input variants across multiple
trials. Plausible unmatched findings should go to human review instead of being
automatically counted as false positives.
