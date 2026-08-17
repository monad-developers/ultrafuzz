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
