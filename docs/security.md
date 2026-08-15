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

Campaigns default to `private`. Before a private campaign can launch, the
operator must supply `ULTRAFUZZ_DATA_GOVERNANCE_POLICY` as a JSON policy that
names the source and artifact destinations. Each declared destination has an
exact processor, region, retention, training-use, DPA-status, minimization, and
data-handling-basis record. Every effective model provider and cloud service
must be allowlisted. OpenRouter use additionally requires the exact effective
catalogue ID in `openrouter_model_allowlist`; a custom agent is treated as
self-hosted only when the operator names its exact reference in
`local_model_agents`. External custom adapters use a `model:custom-*`
destination namespace and self-hosted adapters use `model:local-*`; distinct
agent references that normalize to the same label are rejected rather than
sharing an ambiguous acknowledgement. `production_source_roots` must exactly
repeat the resolved project production roots. Keeping this classification in
the same operator-owned policy prevents run-local plan edits from downgrading a
source copy into an unsigned non-production copy.
`ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS` is a separate operator-owned JSON
array; each acknowledgement names one destination and binds the exact policy
and effective-input digests printed by a refused launch. Changing the target
identity, graph, resolved configuration, prompt catalog, operator prompt, or
workflow input makes the acknowledgement stale, as does changing the source-run
identity or an operator-supplied reference-expectation catalog.
Private campaigns require a Git target so the acknowledgement can bind its
commit, tree, and tracked/untracked worktree state; a non-Git target is refused
instead of recording an unbound source identity.

The policy is strict JSON. A minimal hosted-provider entry has this shape (the
operator must replace every example term with the reviewed contract facts):

```json
{
  "schema_version": "ultrafuzz.data-governance-policy.v1",
  "sensitivity": "private",
  "source_destinations": ["model:openai"],
  "artifact_destinations": [],
  "destination_policies": [
    {
      "destination": "model:openai",
      "processor": "operator-reviewed processor identity",
      "region": "operator-reviewed processing region",
      "retention_policy": "operator-reviewed retention terms",
      "training_policy": "operator-reviewed training-use terms",
      "dpa_status": "operator-reviewed DPA status",
      "minimization_policy": "task-relevant source context only",
      "data_handling_basis": "operator-approved confidential-source processing"
    }
  ],
  "local_model_agents": [],
  "openrouter_model_allowlist": [],
  "production_source_roots": ["contracts", "src"],
  "review_signoff_keys": []
}
```

The normalized policy, target identity, required destinations, exact digests,
and accepted acknowledgements are recorded in each run's
`data-governance.json`; `run.json` and `plan.json` bind that document by
SHA-256, and the workflow execution snapshot authenticates the same bytes as a
control file before model execution. Classifying data as `public` is itself an
operator-owned policy choice, not a repository assertion.

These controls record, bind, and enforce the operator's disclosure decision and
model/destination selections. A `minimization_policy` is a reviewed requirement,
not an egress filter: YOLO agents still choose the provider context they send.
Ultrafuzz also cannot independently enforce a provider's no-training promise,
deletion schedule, region, DPA, or contractual terms. Review those terms
independently and use an operator-classified local provider when the target's
confidentiality rules prohibit third-party processing.

Publication-sensitive materialization additionally requires an Ed25519 review
key in `review_signoff_keys`. The operator supplies each key as a stable
`key_id` plus its SPKI DER public key encoded with base64. The normalized key
and its SHA-256 fingerprint are sealed into the run plan before model
execution. A reviewer signs the canonical signoff payload returned by a dry
run; that payload binds a clean target commit/tree and clean-worktree digest,
the graph, final report, selected artifact bytes and destinations, trusted
signer set, reviewer, timestamp, and selected key ID. That clean identity must
exactly match the target sealed before model execution; switching to another
clean commit is refused. Dirty targets are refused, and the clean identity is
checked again immediately before the first write. The private key must stay
outside the agent-accessible host/account—prefer an
off-host reviewer or hardware-backed signer—and must never be present while a
YOLO agent can read operator-accessible files. Merely placing the key elsewhere
on the same filesystem is not isolation.

At materialization and report time, the operator must supply the same
`ULTRAFUZZ_DATA_GOVERNANCE_POLICY` again. Its canonical digest and reviewer-key
fingerprints must exactly match the pre-execution provenance, and only the keys
from this newly supplied operator policy verify the signature. A run-local hash
journal is retained evidence, not a trust root against an unrestricted
same-identity process. Human acceptance is reported only after the retained
signature and every binding are reverified against the externally re-anchored
authority.

This signature authenticates the review decision; it does not sandbox agents,
prevent an operator from trusting the wrong reviewer key, or make provider
retention and deletion terms independently enforceable.

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
