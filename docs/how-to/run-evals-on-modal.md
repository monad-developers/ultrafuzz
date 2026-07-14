# Run evals on Modal

Ultrafuzz can run long evaluation rows in Modal sandboxes while reporting live
telemetry and scores to Braintrust. The runner uses the Modal TypeScript SDK;
Python is not required.

## Security and storage boundaries

Keep the benchmark config under an ignored path such as
`.ultrafuzz/modal/benchmark.json`, or outside the repository entirely. The
config contains the target and ground-truth locations and must not be
committed.

At launch time the runner copies the config to `/run/ultrafuzz-config` inside
the sandbox. Subscription credentials are copied directly from the host to
`/run/ultrafuzz-auth`; they are never placed in a Modal Secret, image,
environment variable, persistent volume, launch-state file, or log.

Non-secret run state is stored under `/data/<run-id>/<model>/workspace` on a
private Modal Volume. This preserves Ultrafuzz state, generated tests, reports,
and Smithers workspaces when a sandbox exits. Each sandbox has a 16-hour
timeout; eval watching uses 15 hours so scoring and publishing have one hour to
finish.

## Authenticate locally

For subscription auth, log in before launching:

```bash
codex login
claude auth login
```

By default the runner reads `CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`) and `CLAUDE_CONFIG_DIR/.credentials.json` (normally
`~/.claude/.credentials.json`). API-key auth is also supported per model; only
the named host environment variable is forwarded through a Modal Secret.

## Create a private runtime config

The six-model matrix is built in, so `models` may be omitted. The default is
one run each for GPT-5.5, GPT-5.6 Sol/Terra/Luna, Claude Fable 5, and Claude
Opus 4.8, with `loops` fixed to `1`.

```json
{
  "schema_version": "ultrafuzz.modal.benchmark.v1",
  "run_id": "example-run",
  "target": {
    "repo": "https://example.invalid/private-target.git",
    "ref": "full-commit-sha"
  },
  "ground_truth": {
    "repo": "https://example.invalid/private-ground-truth.git",
    "ref": "full-commit-sha",
    "file": "findings.yml"
  },
  "braintrust": {
    "project": "private-evals",
    "api_key_env": "BRAINTRUST_API_KEY"
  }
}
```

The ground-truth file must use the format accepted by `ultrafuzz eval score`.
The config schema intentionally accepts credential environment-variable names,
not inline credential values.

Audit reports with bracketed issue headings can set `ground_truth.format` to
`audit-markdown` and provide `ground_truth.expected_findings`. Conversion runs
inside the sandbox, and a count mismatch fails before evaluation starts.

For judges that require short-lived credentials, configure an HTTPS
`braintrust.judge_credential_endpoint`. The worker requests a model-scoped
credential in memory immediately before scoring and never persists it.

## Build and launch

```bash
pnpm install
pnpm --filter @ultrafuzz/modal build
pnpm exec ultrafuzz-modal build --repo-root .
pnpm exec ultrafuzz-modal launch --config .ultrafuzz/modal/benchmark.json
```

Image staging includes Git-tracked files only. Commit the runner changes you
intend to build; ignored and untracked benchmark material cannot enter the
image archive.

To canary one model first, repeat `--model` as needed:

```bash
pnpm exec ultrafuzz-modal launch \
  --config .ultrafuzz/modal/benchmark.json \
  --model gpt-5-6-sol
```

The launch command writes an ignored, sanitized launch-state file under
`.ultrafuzz/modal/<run-id>/launch-state.json`. Use that file for status and
collection:

```bash
pnpm exec ultrafuzz-modal status --state .ultrafuzz/modal/example-run/launch-state.json
pnpm exec ultrafuzz-modal collect \
  --state .ultrafuzz/modal/example-run/launch-state.json \
  --output .ultrafuzz/modal/results
```

The Modal entrypoint stages mounts and runtime-only credentials as root, then
changes ownership of only those run-scoped paths and executes the worker as the
image's non-root `ubuntu` user. This is required for unattended Claude Code
runs because its skip-permissions mode cannot run with root privileges.

## Toolchain image

The runner image includes Foundry (`forge`, `cast`, and `anvil`), Recon,
`recon-generate`, Echidna, Slither, and `covg-eval`. The equivalent standalone
image definition is in `packages/modal/Dockerfile`.
