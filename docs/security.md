# Ultrafuzz Security Posture

## Before You Run

> **Security note**
>
> We strongly recommend running Ultrafuzz only on ephemeral, isolated virtual
> machines that can be safely discarded after use. Agents run in an
> unrestricted, skip-permissions workflow, which means they may unintentionally
> install or access dangerous tooling or sensitive credentials. Prompts, model
> choices, and target behavior can influence the actions agents take on the host
> and may result in unintended or destructive consequences. Do not run Ultrafuzz
> on a developer workstation, persistent environment, or any machine containing
> valuable data or credentials. Ultrafuzz is still under active development and
> has not necessarily undergone a complete security audit. Its implementation may
> contain unknown or undiscovered vulnerabilities.

The rest of this page describes what Ultrafuzz does and does not enforce
once it is running. None of it substitutes for the host being disposable.

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

Campaigns default to `private`. Set `ULTRAFUZZ_DATA_GOVERNANCE_POLICY`
to a complete strict JSON document that matches the canonical
[data-governance policy schema](../packages/runtime/schema/data-governance-policy.schema.json).
The policy needs one `destination_policies` row for every declared source or
artifact destination. The first failed private launch reports the exact route
IDs and the policy and input digests.

The schema validates the portable document shape. Runtime semantic gates also
require unique destination-policy rows, exact coverage of the declared
destination union, and ascending array order. Text values cannot have leading
or trailing whitespace. Ultrafuzz rejects noncanonical input instead of
silently trimming or reordering it.

Put reviewed acknowledgement records in
`ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS` as an array that matches the
canonical
[data-disclosure acknowledgements schema](../packages/runtime/schema/data-disclosure-acknowledgements.schema.json).
Acknowledgements bind the policy, effective inputs, prompt, routes, and
Git/worktree identity. A runtime semantic gate rejects more than one
acknowledgement for the same destination. Any change makes an acknowledgement
stale. Credential values are never persisted. Private standalone Modal evals
remain fail-closed pending the separate R-26 disclosure authorization. Public
Modal runs record `cloud:modal`. These controls are not a sandbox or egress
filter: YOLO agents remain unrestricted.

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

The committed exception file starts empty. Its canonical field contract and a
complete example are maintained in the checked-in
[dependency-advisory exceptions schema](../.github/dependency-advisory-exceptions.schema.json).
Keep the file's `$schema` reference so editors and reviewers use the same
contract that the CI policy validates.

The inventory also opens installed packages that declare bundled dependencies,
validates their bounded no-symlink package trees, and submits every exact bundled
version to the same advisory endpoint. This matters for the private workflow
controller's pinned npm: pnpm otherwise reports npm as one opaque package and
omits the packages npm ships inside itself. The lockfile-bound npm patch mirrors
the green npm v11 upstream fixes in `npm/cli#9842` and `npm/cli#9872`: bundled
`brace-expansion` 5.0.9, `ip-address` 10.5.0, `tar` 7.5.22, and `undici` 6.28.0.
The patch can be removed when an upstream npm release carries those versions;
the operator npm closure digest and advisory inventory both fail if that
composition drifts. Pnpm's generated `node_modules/.bin` shims are excluded from
the private snapshot because they embed installation-specific absolute paths and
the controller invokes npm's pinned CLI directly; the snapshot test also proves
that no such shim directory is copied. Socket's duplicate obfuscated-code
warnings refer to npm's official bundled/minified distribution; no warning is
suppressed, and registry integrity plus the closure digest cover those bytes.

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
target-controlled `PATH` entries. The CLI and its complete transitive package
closure are copied into a run-owned content-addressed, read-only generation;
the launcher verifies that closure before every invocation, removes ambient Node
loader/search injection, and rejects ESM or CommonJS modules resolved outside
it. Module confinement does not prevent the validator from reading the artifact
or schema paths it was asked to check. Its pinned CLI, schema-bundle, and
validator identity are preflighted with a real fixture before model work, and
every registered schema path is checked against its pinned digest. This keeps
the producer and host on the same contract; it does not turn same-UID local
agent execution into an OS security boundary.

The workflow engine is installed by the controller rather than from the target
repository. Ultrafuzz verifies the complete closure of its exact npm dependency,
copies that closure into the target-specific private controller directory, and
makes every copied directory and file read-only. It checks the closure before
and after the script-disabled, registry-pinned install and again before cache
reuse. The runner toolcache npm and `ULTRAFUZZ_TRUSTED_BIN` are not npm authority;
the latter remains only the run-owned validator launcher directory.

Workflows that intentionally need additional variables can opt in explicitly:

```sh
ULTRAFUZZ_AGENT_ENV_ALLOWLIST=FOUNDRY_PROFILE ultrafuzz run
```

The allowlist is operator-owned environment configuration, not project TOML.
It is global only for ordinary workflow inputs. Credential-like names (for
example, names containing `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `PASSWORD`,
`PASSWD`, `SECRET`, or `TOKEN`) and values matching maintained secret formats,
including credential-bearing RPC URLs, are blanked from unrelated model
children and omitted from unrelated Modal task secrets. A recognized
provider-route prefix such as `AWS_` scopes the value to that route. Arbitrary
unrecognized credentials are not supported and reach no model task. Stock
agent API keys use their validated canonical `api_key_env`; the active adapter
restores only its own key. Use only a credential-free RPC endpoint when an RPC
URL must remain a global input.
Do not add unrelated credentials merely to make them available to prompts.
