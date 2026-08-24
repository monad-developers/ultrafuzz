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

Strategies run independent and looped agents that investigate concrete,
source-backed production bugs. Their primary security output is typed findings;
they may also author a focused test or reproducer when execution is useful to
confirm the result. Topology controls loops and explicit model-profile fan-out
so repeated attempts are traceable.

Review deduplicates findings, triages severity, aggregates generated tests, and
writes the final report artifacts. Reports are produced by the final-report
phase; they are evidence to inspect, not an automatic security submission.

## Default Strategy Families

The default scaffold is the direct bug-finding workflow:

- Eight property-discovery lenses produce the shared property catalog and may
  publish concrete findings discovered while deriving properties.
- Twenty direct strategies investigate boundary, accounting, input,
  round-trip, workflow, time, state-machine, dependency, parity, lifecycle, and
  coverage-expansion hypotheses.
- Every direct strategy writes `findings@2` as its primary result. Focused tests,
  PoCs, and generated-test bundles are supporting evidence and may be empty
  when source-complete or already-executed evidence adequately confirms the
  result.
- Review reconciles every raw finding, then deduplicates, triages, classifies,
  aggregates any authored test evidence, and produces the final report.

The `exhaustive` audit profile explicitly opts into the higher-cost specialist
lanes in addition to that direct workflow, and raises repetition and
concurrency settings to their maximums. Those lanes add a five-stage stateful
invariant campaign, the deep differential oracle/harness/review pipeline, and
one dynamic strategy coordinator. They are not part of the default scaffold.

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

Ultrafuzz ships this methodology as a product surface: eval suites run a
target × variant × trial matrix against ground-truth bugs, score precision,
recall, and F1 locally, and optionally mirror node telemetry to an eval cloud
provider. See [Eval Suites](../reference/evals.md) and
[Run Eval Suites](../how-to/run-evals.md).
