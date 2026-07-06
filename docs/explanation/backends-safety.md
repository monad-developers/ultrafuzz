# Agents, Workflow Boundary, and Safety

Ultrafuzz Beta delegates agent execution to the configured workflow layer, but
does not make that layer the product API. The stable user-facing surfaces are
`ultrafuzz.toml`, `.ultrafuzz/topology.yml`, `.ultrafuzz/prompts/**`,
`.ultrafuzz/references.yml`, run evidence, report artifacts, and explicit
materialization.

## Agent Selection

`ultrafuzz.toml` defines model profiles with project agent references, model
names, and timeouts. Topology nodes or group defaults choose model profiles when
they need something other than the configured default. Model fan-out is explicit
so reviewers can see which agent/model attempt produced an artifact or finding.

Agent references are validated before launch. The generated project agent
registry and any workflow adapter files are implementation plumbing, not a
configuration surface for campaign strategy.

## Workflow Boundary

Runtime validates product state, renders prompts, writes run evidence, compiles
workflow tasks, and launches a linked workflow. `resume`, `replay`, and `fork`
operate on that linked workflow after product checks. The linked workflow ID is
evidence for lifecycle operations, not a separate product API that users should
script against directly.

Dashboard/API is a beta product target: a local operator surface for topology,
prompt, config, run evidence, reports, materialization, and cleanup. The current
implementation remains CLI-first until the dashboard/API work tracked in #16
lands.

## Workspace Boundary

Agent attempts work in run-associated workspaces, and prompts receive both the
target `repo_path` and attempt `workspace_path`. Durable handoff files belong in
the node artifact directory, not only in a temporary workspace.

Ultrafuzz records workspace metadata and run evidence so reviewers can inspect
what happened after the workflow completes. It does not promise that a workspace
is a security isolation boundary.

## Trust Model

Agents run under a trusted local execution model. Ultrafuzz does not maintain a
command allowlist, network allowlist, sandbox policy, or approval-flow
configuration as product behavior.

The durable product boundary is:

- review prompts before launch;
- fetch references only through explicit `references sync` or update actions;
- persist graph, prompt, config, event, workspace, and artifact evidence;
- review findings and reports before acting on them;
- materialize selected outputs only after confirmation and path checks;
- use normal repository review tools before publishing changes.

Repository mutation limits such as no commit, push, pull request, external
submission, staging, or merge are prompt instructions and trust-model
assumptions. They are not deterministic enforcement by Ultrafuzz.

## Materialization Boundary

Materialization is explicit and copy-only in beta. Patch artifacts may exist as
evidence, but patch application is rejected until a safe patch applier exists.
Materialized files are left as ordinary unstaged working-tree changes so the
operator can review them with the usual repository tools.
