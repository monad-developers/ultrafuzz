# Agent Backends and Safety

Ultrafuzz runs agents through existing CLI backends instead of embedding a
provider-specific agent runtime.

## Backend Boundary

Backend configuration selects the command, model profile, arguments, and
environment passed to the external CLI. Ultrafuzz records backend provenance in
run state and artifacts so reviewers can see which models and settings
contributed to a result.

By default, the command must match the backend kind: `codex-cli` launches
`codex` and `claude-code-cli` launches `claude`. Custom backend command paths
or names require `permissions.allow_dangerous_bypass = true`.

Config-supplied backend and model environment keys are treated as part of the
backend trust boundary. Loader, shell-startup, path, git, and backend
configuration-directory variables are rejected by default because they can
change the process before backend sandbox assumptions hold.

## Workspace Boundary

Agent attempts run in isolated workspaces. Prompts receive both:

- `repo_path`: the target repository.
- `workspace_path`: the isolated attempt workspace where code and test work
  should happen.

Durable handoff files go under `artifact_path`, not only inside the temporary
workspace.

## Permission Boundary

The default permission policy denies common sensitive files and secret
locations. Before launch, Ultrafuzz checks the backend-visible workspace,
artifact, and extra context roots and rejects the attempt if a denied path is
present. If a configured read or write policy cannot be enforced, execution
fails closed.

Read-deny checks follow symlink targets that remain inside a backend-visible
root and reject symlinks that escape that root, because Ultrafuzz cannot bound
the target contents before launch. Codex extra context directories are exposed
through `--add-dir`, which is writable in workspace-write mode, so they require
an explicit `extra-context` entry in `permissions.write_allow` when used.

Dangerous sandbox and backend bypass arguments are rejected unless a config
explicitly opts into dangerous bypass mode. Codex `-c` / `--config` entries are
also inspected, and sandbox, network, permission, or approval overrides are
rejected by default, including web search overrides and bypass aliases such as
`--search`, `--profile`, and `--yolo`.

## Product Boundary

Ultrafuzz is conservative about target repository changes:

- It does not auto-commit.
- It does not auto-push.
- It does not auto-submit findings.
- It does not auto-merge target repository code.

Generated tests and materialized patches remain reviewable working-tree changes.
