# Ultrafuzz Security Posture

Ultrafuzz uses a trusted local execution model. Agents run as the project
configures them, and the product boundary is prompt review before launch plus
explicit artifact review before materialization.

Agent adapters are intentionally allowed to use their unrestricted execution
modes, including `--dangerously-skip-permissions` and
`--dangerously-bypass-approvals-and-sandbox`. Ultrafuzz does not try to turn
those modes into a sandbox: an agent may execute commands, read files available
to the operator, and use the network. Findings whose mitigation requires an OS
sandbox, approval gate, command allowlist, or egress allowlist are accepted
threat-model risks.

The product still enforces deterministic boundaries around files it writes
itself:

- Project paths must be relative, non-traversing, and non-symlink escapes.
- Run artifacts redact secret-looking values before persistence.
- Materialization requires explicit selected copies and confirmation. Patch
  artifacts are rejected until safe patch application is implemented, and
  materialized copies are left as ordinary unstaged working-tree changes.
- Clean removes only generated `.ultrafuzz/**` selections.

Ultrafuzz does not enforce a deterministic repository mutation policy across
agent behavior. Instructions not to commit, push, open pull requests, submit
external findings, stage changes, or merge are expressed in agent prompts and
depend on user acknowledgement plus the trusted local execution model. Review
prompts before launch, review artifacts before materialization, and use normal
repository review tools such as `git status` before publishing.

Ultrafuzz does not maintain an agent command allowlist, network allowlist, or
sandbox approval flow. Treat agent execution as trusted local execution, not as
an isolation boundary.

## Controller-owned Git operations

Git operations performed by Ultrafuzz controllers use an explicit transport
policy: the default, `ext`, and `file` protocols are denied and credential-free
HTTPS is allowed. Target-controlled remotes and refs are validated before they
become Git operands, and option separators are used where Git supports them.
Recursive submodule hydration uses the same protocol policy.

This policy is intentionally limited to controller fetch, clone, and submodule
helpers. It is not an agent command allowlist or network allowlist and does not
change the unrestricted execution modes described above.

## Dependency supply-chain policy

Every external direct dependency in a workspace manifest is pinned to one exact
registry version. Internal workspace packages use `workspace:*`. The committed
`pnpm-lock.yaml` and its integrity hashes remain the primary reproducibility
control; exact manifest pins make the intended update boundary unambiguous when
that lockfile is regenerated.

Run `pnpm security:dependencies` after changing a manifest or lockfile. CI and
release validation run the same gate. It executes `pnpm audit --prod --json`
and blocks High or Critical production advisories unless they have a current
entry in `.github/dependency-advisory-exceptions.json`. An exception must name
the GHSA and package, severity, accountable GitHub owner, tracking issue,
reachability analysis, rationale, disposition, and expiry. Exceptions expire
within 90 days, fail closed when stale, and must be removed when the advisory no
longer appears.

Security owners triage new High or Critical advisories within two business
days. Critical findings target remediation within seven days and High findings
within 30 days. When that is not possible, the tracking issue records the
reason, compensating controls, and a time-bounded renewal decision; exceptions
are never a permanent suppression mechanism.

Benchmark ZIP input is parsed with `adm-zip` 0.6.0 or newer through a bounded,
regular-file snapshot. The 256 MiB compressed-input ceiling matches the existing
report ZIP and public benchmark bundle compatibility envelope while staying far
below Node's maximum `Buffer` allocation. Canonical-member, duplicate/alias,
entry-count, selected-entry expansion, and strict JSON limits remain layered
behind the patched parser.

The weekly Package Provenance Drift workflow separately observes publisher,
maintainer, repository, integrity, signing-key, and SLSA provenance metadata
for the four security-sensitive packages recorded in
`.github/package-provenance-baseline.json`. Its report is retained as a workflow
artifact and drift fails only the standalone scheduled workflow, so it does not
become a pull-request merge gate. Review drift against the package's official
repository and npm ownership history; update the baseline only in a reviewed
pull request after the ownership or release change is independently verified.

## Agent process environment

Workflow processes receive the active agents' configured API-key variables,
normal process essentials, and `SMITHERS_*` variables. Other host variables are
not inherited automatically. This reduces accidental credential disclosure but
does not isolate an unrestricted agent from the host.

Schema-backed tasks also receive a host-managed `ultrafuzz` launcher before
target-controlled `PATH` entries. Its pinned CLI, schema-bundle, and validator
identity are preflighted with a real fixture before model work, and every
registered schema path is checked against its pinned digest. This keeps the
producer and host on the same contract; it does not turn same-UID local agent
execution into an OS security boundary.

Workflows that intentionally need additional variables can opt in explicitly:

```sh
ULTRAFUZZ_AGENT_ENV_ALLOWLIST=FOUNDRY_PROFILE,MAINNET_RPC_URL ultrafuzz run
```

The allowlist is operator-owned environment configuration, not project TOML.
Do not add unrelated credentials merely to make them available to prompts.
