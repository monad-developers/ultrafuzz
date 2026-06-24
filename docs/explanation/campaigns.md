# How Campaigns Work

An Ultrafuzz campaign is a typed graph of agentic and non-agentic work over a
target Solidity repository.

## Campaign Phases

The default scaffold moves through four broad phases.

Setup discovers the project, actors, flows, fuzzing framework, and base test
layout.

Properties generate a consolidated property catalog from multiple specification
lenses.

Strategies run independent and looped agents that author tests, explore
invariants, build differential harnesses, or expand coverage.

Review deduplicates findings, triages severity, aggregates generated tests, and
writes the final report.

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

Each run writes `graph.json`, `graph.fingerprint`, `state.json`, event stores,
resolved config, and node artifacts. Those files make the campaign restartable
and reviewable. A report can be traced back to the exact graph and artifacts
that produced it.

## Why Loops Are Explicit

Looped strategy attempts are concrete nodes in the expanded graph. This keeps
parallel attempts deterministic, gives each attempt a stable artifact path, and
lets prompts split work by loop index.

## Why Review Is Separate

Lead generation and adjudication are different jobs. Ultrafuzz keeps generation,
dedupe, triage, severity classification, test aggregation, and final reporting
as separate graph nodes so each handoff is inspectable.
