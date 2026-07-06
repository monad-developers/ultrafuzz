# Monad Bugfinder Context

Ultrafuzz is related to the broader Monad Bugfinder direction: use agentic
systems to generate leads, preserve evidence, and force validation before
humans act on a security claim.

The background write-up is the
[Monad Bugfinder blog post](https://blog.monad.xyz/blog/monad-bugfinder).

## What Carries Over

Ultrafuzz keeps several design lessons visible in a Solidity fuzzing workflow:

- Separate discovery from validation and reporting.
- Preserve run artifacts so claims can be audited later.
- Treat generated reports as allegations until evidence is reviewed.
- Prefer explicit validation gates and handoff files over loose prose-only
  coordination.
- Keep human reviewers in control of submissions and repository changes.
- Evaluate repeated campaigns with a fixed rubric instead of trusting a single
  run outcome.

## What Is Different In Beta

Ultrafuzz Beta is repository-local and product-surface-first. The editable
campaign state is root `ultrafuzz.toml` plus `.ultrafuzz/**`; generated workflow
files are implementation plumbing. Topology owns graph semantics, prompts own
agent instructions, references own pinned external context, and artifacts own
handoffs.

The product does not claim to prove a protocol bug-free, automatically submit a
vulnerability, or silently fix production code. It produces reviewable evidence:
findings, generated tests, final-report artifacts, run metadata, and selected
outputs that the operator can explicitly materialize.

Evaluation follows the same principle. Ground truth should be reproducible and
kept outside the source repository when sensitive, unknown plausible findings
should be routed to human review, and metrics should preserve enough provenance
to explain which strategy, attempt, model profile, and run found each issue.
