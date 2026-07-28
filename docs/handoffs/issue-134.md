# Issue #134 implementation handoff

Last updated: 2026-07-28

## Privacy boundary

This repository is expected to become public. Keep this handoff and all future
updates free of private benchmark data.

Never publish:

- benchmark target identities, repository URLs, revisions, or identifying metadata;
- bugs, findings, reports, code excerpts, or other results from benchmark targets;
- credentials, tokens, secrets, private logs, or machine-specific authentication data;
- raw benchmark artifacts that have not passed the repository's disclosure-safe export checks.

Public updates should be limited to implementation status, aggregate control-plane
evidence, disclosure-safe artifact validation, and cleanup status.

## Published state

- Issue: [#134](https://github.com/monad-developers/ultrafuzz/issues/134)
- Pull request: [#142](https://github.com/monad-developers/ultrafuzz/pull/142)
- Branch: `codex/complete-modal-e2e`
- Base branch: `main`

Resume from a fresh clone:

```bash
git fetch origin codex/complete-modal-e2e
git switch --track origin/codex/complete-modal-e2e
```

## Work completed

The branch implements and tests the remaining cloud-node execution and acceptance
requirements for issue #134.

An initial explicit cloud acceptance run failed before model work because target
preparation validated the cloud execution override against the default topology
instead of the selected, candidate-owned smoke topology. After selecting the
correct topology, validation also needed the smoke coordination model profile that
the eval runner applies at execution time.

The published implementation resolves both preparation mismatches:

1. `ultrafuzz validate` accepts a `--topology` override resolved relative to the
   project root.
2. Public smoke preparation validates against the candidate-owned smoke topology.
3. Prepared smoke configuration declares the coordination profile using the same
   selected model and reasoning policy as execution.
4. Local and Modal-backed smoke preparation use the same valid configuration.
5. CLI and Modal regression coverage protects these paths.

## Verification completed

The following passed before the checkpoint was pushed:

- CLI tests: 18/18;
- Modal tests: 236/236;
- eval tests: 158/158;
- runtime release validation: 153 passed, with one environment-dependent skip;
- formatting and lint;
- workspace build and serial type-check;
- documentation and release validation;
- ordinary benchmark workflow;
- release gates and repository security/review checks.

Recheck the current PR gates with:

```bash
gh pr checks 142 --repo monad-developers/ultrafuzz
```

## Explicit cloud acceptance

An acceptance run was started before the branch privacy rewrite. It does not
validate the privacy-clean published head and must not be used as the merge gate.
Do not publish or copy its raw logs or artifacts.

After the privacy-clean branch checks pass, dispatch exactly one new acceptance run
against the current head:

```bash
gh workflow run eval-benchmarks.yml \
  --repo monad-developers/ultrafuzz \
  --ref codex/complete-modal-e2e \
  -f cloud_node_e2e=true
```

Record the new run ID and exact head SHA in a disclosure-safe PR update.

## Next steps

### If the privacy-clean acceptance run succeeds

1. Allow all cleanup jobs to finish.
2. Download artifacts into a private, temporary location.
3. Validate only aggregate acceptance properties:
   - every expected logical workflow node has cloud execution evidence;
   - configured default and per-node resource policies were honored;
   - direct, fan-in, and transitive dependency handoffs are evidenced;
   - stop, resume, and replacement recovery paths have durable evidence;
   - disclosure-safe public bundles pass their schema and privacy checks;
   - cleanup reports no live resources or cleanup failures.
4. Do not publish target identities, target findings, raw target output, or private
   artifact contents.
5. Add the successful run link and a disclosure-safe aggregate result to PR #142.
6. Recheck that all PR checks apply to the exact head SHA.
7. Mark the PR ready, merge it, and verify issue #134 closes through
   `Closes #134`.

### If the privacy-clean acceptance run fails

1. Allow cleanup and diagnostic artifact upload to finish.
2. Inspect artifacts privately.
3. Report only a sanitized failure category and implementation-level cause.
4. Never paste target identity, target code, bugs/findings, raw logs, or secrets into
   the repository, PR, issue, or agent handoff.
5. Fix the evidenced implementation cause on the existing branch.
6. Run focused tests and `pnpm run ci`.
7. Commit and push the fix.
8. Dispatch one replacement acceptance run against the new exact SHA.

Do not merge or close issue #134 on a failed, incomplete, or merely in-progress
cloud acceptance run.

## Current decision

PR #142 is intentionally a draft checkpoint. The implementation and ordinary
gates are published, but real cloud acceptance is still pending. The next agent
should continue from the published branch and existing Actions run without
depending on the original workstation.
