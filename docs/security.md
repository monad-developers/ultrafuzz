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
