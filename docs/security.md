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
- Run-state diagnostics, events, and attempt-ledger failures redact known and
  secret-looking values before persistence. This is a best-effort,
  defense-in-depth control, not a guarantee that every possible secret format
  will be recognized.
- Canonical agent outputs and their companion publications are scanned against
  maintained secret patterns and exact in-memory run credentials before they
  are published. A match fails artifact verification without rewriting the
  agent's immutable bytes; the output must be regenerated without the secret.
  Exact-value substring matching ignores credentials shorter than eight
  characters to avoid rejecting unrelated content on collision-prone values.
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

## Campaign data governance

Campaigns default to `private`. Set `ULTRAFUZZ_DATA_GOVERNANCE_POLICY` to strict JSON with one complete policy row per declared destination, for example: `{"schema_version":"ultrafuzz.data-governance-policy.v1","sensitivity":"private","source_destinations":["model:openai"],"artifact_destinations":[],"destination_policies":[{"destination":"model:openai","processor":"OpenAI","region":"operator-approved","retention_policy":"operator-approved","training_policy":"operator-approved","dpa_status":"operator-approved","minimization_policy":"required inputs only","data_handling_basis":"operator-approved"}],"openrouter_model_allowlist":[]}`. Each row requires exactly `destination`, `processor`, `region`, `retention_policy`, `training_policy`, `dpa_status`, `minimization_policy`, and `data_handling_basis`. The first failed private launch reports the exact route IDs plus policy/input digests. Put reviewed records in `ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS`, for example: `[{"schema_version":"ultrafuzz.data-disclosure-acknowledgement.v1","destination":"model:openai","policy_digest":"<64 lowercase hex>","input_digest":"<64 lowercase hex>","acknowledged_by":"reviewer@example.com","acknowledged_at":"2026-08-17T00:00:00.000Z"}]`. Acknowledgements bind policy, effective inputs, prompt, routes, and Git/worktree identity; any change makes them stale. Credential values are never persisted. Private standalone Modal evals remain fail-closed pending the separate R-26 disclosure authorization. Public Modal runs record `cloud:modal`. These controls are not a sandbox or egress filter: YOLO agents remain unrestricted.

## Production dependency advisories

CI and release validation run `pnpm security:dependency-advisories`. The gate
enumerates the installed production graph with the repository-pinned pnpm,
requires exact package versions resolved from `registry.npmjs.org`, and posts
that bounded inventory directly to the fixed npm advisory bulk endpoint. It
does not honor a configurable package-registry URL for security decisions. The
raw response is size-bounded and parsed with the repository's strict JSON
reader before validating every package, advisory ID, GitHub advisory URL,
severity, range, CWE, and CVSS field. Aliased dependencies are audited under
their registry package names. Invalid UTF-8 and unknown, missing, duplicate,
partial, or error-bearing fields fail closed instead of relying on pnpm
normalization, which can discard malformed registry records.

The gate blocks every High or Critical production advisory unless
`.github/dependency-advisory-exceptions.json` contains a current exception for
that exact GHSA and package. Enumeration, registry, HTTP, response-size, schema,
and JSON failures are blocking; an unavailable or malformed registry response
is never treated as a clean audit. CI and release validation also run the policy
fixture suite that exercises these fail-closed cases.

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

The workflow controller receives only the active agents' configured API-key
variables, normal process essentials, and a named allowlist of controller
variables. There is no wildcard `SMITHERS_*` forwarding. Before each model
process starts, the generated adapter blanks every inactive built-in or
dynamically configured provider credential and provider home, then restores
only that invocation's credential and home. Other host variables are not
inherited automatically.

`HOME` remains a normal process essential and is intentionally forwarded.
Subscription-backed CLIs may keep credential-rich state beneath it, and a
same-UID YOLO agent can read files available to the operator regardless of
environment filtering. Per-child credential scoping reduces accidental and
cross-provider disclosure; it is not an OS isolation boundary or a promise that
subscription credentials are inaccessible to an unrestricted local agent.

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
