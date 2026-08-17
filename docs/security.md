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

## Production dependency advisories

CI and release validation run `pnpm security:dependency-advisories`. The gate
executes `pnpm audit --prod --json` and blocks every High or Critical production
advisory unless `.github/dependency-advisory-exceptions.json` contains a current
exception for that exact GHSA and package. Audit command, output-schema, JSON,
metadata-count, and production-finding failures are blocking errors; the gate
does not treat an unavailable registry or malformed response as a clean audit.

Exceptions are temporary dispositions, not permanent suppressions. Each entry
must record the severity, status, review date, expiry, accountable GitHub owner,
tracking issue, reachability analysis, and rationale. An exception may last at
most 30 days from `reviewed_on` and is valid through its `expires` date in UTC.
CI rejects future-dated reviews, expired or overlong exceptions, severity
mismatches, duplicate entries, unknown fields, and entries for advisories that
no longer appear. Remove a stale entry in the same change that remediates its
advisory.

Allowed statuses are `not-reachable`, `remediation-in-progress`, and
`risk-accepted`. A renewal requires a new review date and updated evidence in
the tracking issue. Security owners should fix Critical advisories within seven
days and High advisories within 30 days; use an exception only when the tracking
issue documents why that target cannot be met and what compensating controls
apply.

The committed exception file starts empty. A complete entry has this shape:

```json
{
  "advisory": "GHSA-2345-6789-cfgh",
  "package": "example-package",
  "severity": "high",
  "status": "not-reachable",
  "reviewed_on": "2026-08-17",
  "expires": "2026-09-16",
  "owner": "@security-owner",
  "tracking_issue": "#123",
  "reachability": "The vulnerable parser is not called by production inputs.",
  "rationale": "Retained while the tracked upstream upgrade is validated."
}
```

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
