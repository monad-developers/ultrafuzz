# Run the paid target smoke workflow

The `Target Repository E2E` workflow runs one real Ultrafuzz campaign against
each immutable target in `scripts/ci/target-e2e-manifest.json`. It uses the
normal production discovery, property, strategy, review, and final-report
phases with a single strategy loop. Stateful invariant, differential, and
dynamic-strategy lanes are excluded from this smoke policy.

This check makes paid model calls and bug-finding results are nondeterministic.
It is intentionally not a required branch-protection check. A missing model
credential, incompatible target build, unhealthy workflow, timeout, missing
report, invalid evidence, or empty final finding set makes only the affected
matrix job fail. The matrix does not cancel the other targets.

## Rerun or override a result

To rerun a failed target, open the failed workflow run in GitHub Actions and
choose **Re-run failed jobs**. Use **Run workflow** on the workflow page to run
the complete pinned matrix manually.

Maintainers may use the repository's normal branch-protection override when a
nondeterministic target result should not block a merge. Do not add an offline
replacement or a generated success result; keep the red job and its evidence
visible for review.

## Inspect evidence

Every target uploads a 30-day artifact named with its manifest ID. Successful
artifacts contain root-level `report.md`, `report.json`, `findings.json`,
`target.json`, and `run-summary.json`. The workflow also renders `report.md` in
the job summary. Failed jobs upload whatever bounded, redacted diagnostics were
available.

The manifest's public known-vulnerability references justify each immutable
snapshot. They are evidence about target selection only and are never copied
into target prompts or generated findings.
