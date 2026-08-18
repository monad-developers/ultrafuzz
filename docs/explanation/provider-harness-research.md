# Provider-agnostic coding harness research

Status: working draft for [issue #653](https://github.com/monad-developers/ultrafuzz/issues/653), researched on 2026-08-18.

Ultrafuzz currently names adapters such as `CodexAgent` and `DeepSeekAgent` in
model profiles. That representation mixes three choices which need different
validation and release cadences:

- the coding harness that owns the agent loop and tools;
- the API provider or gateway that receives model requests;
- the provider catalogue model ID.

The current OpenRouter-through-Codex configuration is a supported compatibility
path, not a decision that OpenRouter requires Codex or that Codex should remain
the default. Likewise, `DeepSeekAgent` currently means the Claude Code harness
bound to DeepSeek's Anthropic-compatible API; DeepSeek is the provider, not the
harness.

## Initial comparison

This matrix distinguishes upstream claims from Ultrafuzz qualification. A
candidate is not supported until a pinned real CLI passes the conformance and
credential-isolation tests described below.

| Candidate                   | Provider and model binding                                                                                                                                                                             | Unattended tools and artifacts                                                                                                                                                                         | Events, sessions, and telemetry                                                                                                                                                     | Isolation and portability                                                                                                                                                                    | Initial disposition                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.147.0           | Custom `model_provider`, `base_url`, `wire_api`, and `env_key`; the model is supplied separately. PR #654 validates an OpenRouter Responses route.                                                     | `codex exec` is non-interactive, has filesystem and shell tools, supports a final-response JSON schema, and has a native workspace-write sandbox.                                                      | JSONL events, persisted or ephemeral sessions, `exec resume`, and provider-reported usage are available.                                                                            | Apache-2.0; Node wrapper and native binaries. The sandbox is useful locally and the existing adapter runs in Modal workers.                                                                  | Keep as one compatibility option. Do not select it as the provider-agnostic default yet.                                                                                    |
| Pi 0.84.2                   | Built-in `openrouter` and `deepseek` providers; CLI accepts `--provider` and an opaque `--model` pattern/ID. Custom OpenAI, Anthropic, Google, and Responses-compatible providers are also documented. | Non-interactive print mode has `read`, `write`, `edit`, and `bash`; JSON and RPC modes are designed for process integration. Artifact compliance can continue to use Ultrafuzz's post-agent contracts. | JSON events include tool lifecycle and usage. Sessions are JSONL trees with explicit session IDs, continue, resume, and fork operations. The UI reports token/cache usage and cost. | MIT and Node 22.19+. Pi explicitly has no sandbox, so the Ultrafuzz worktree and local/container/Modal boundary must supply isolation. Version checks and install telemetry can be disabled. | First non-Codex candidate to qualify. Smithers 0.32.0 already contains a `PiAgent` process adapter and event interpreter.                                                   |
| OpenCode 1.18.18            | Built-in OpenRouter support, `provider/model` selection, and explicit config entries for catalogue models. It also supports custom base URLs through AI SDK providers.                                 | `opencode run --format json --auto` is non-interactive and the Build agent exposes file, shell, search, and task tools.                                                                                | Raw JSON events, session IDs, continue/resume/fork, exported session JSON, token usage, and cost-bearing step events are available.                                                 | MIT. Permissions are an approval policy, not a sandbox. Config, data, cache, model refresh, plugins, updates, and sharing all need isolated/disabled defaults for unattended runs.           | Second candidate to qualify. Smithers 0.32.0 already contains an `OpenCodeAgent`, but provider credentials and all state directories still need an Ultrafuzz-owned wrapper. |
| “DeepSeek Code”             | No official standalone coding CLI was found in the `deepseek-ai` GitHub organization. DeepSeek documents OpenAI-compatible APIs and a Claude Code integration.                                         | The current Ultrafuzz adapter uses real Claude Code tools and unattended print mode.                                                                                                                   | Claude Code supplies structured streaming, sessions/resume, usage, reasoning controls, and JSON-schema output.                                                                      | Claude Code is separately distributed with its own license and state/auth surfaces. DeepSeek is only the provider in this pairing.                                                           | Model as `harness = "claude-code"` plus `provider = "deepseek"`. Do not invent or bless an unrelated community CLI under the name “DeepSeek Code.”                          |
| Direct provider-API harness | Full control over OpenRouter model pass-through and credential routing.                                                                                                                                | Ultrafuzz would have to own the complete tool loop, cancellation, context management, and filesystem/shell policy.                                                                                     | Ultrafuzz would also own event normalization, sessions, retries, usage, and error classification.                                                                                   | Potentially the smallest runtime boundary, but the largest new security and maintenance surface.                                                                                             | Retain as a design fallback if qualified CLIs cannot meet the contract; do not implement first.                                                                             |

Pi is the provisional first implementation target because its upstream CLI
already separates provider and model flags, its JSON/RPC protocols expose the
data Smithers needs, and the pinned Smithers dependency already implements the
process and event layer. This is a priority for qualification, not final
approval or a default decision.

## Proposed configuration boundary

Provider, harness, and model should be explicit references. Credential values
remain process environment only and never enter resolved config, snapshots, or
artifacts.

```toml
[providers.openrouter]
kind = "openrouter"
base_url = "https://openrouter.ai/api/v1"
auth = "api-key"
api_key_env = "OPENROUTER_API_KEY"
preflight = "openrouter-key"

[harnesses.pi]
kind = "pi"
version = "0.84.2"
config_dir = ".ultrafuzz/pi"

[models.openrouter-sonnet]
harness = "pi"
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
reasoning = "high"
```

The exact field names remain subject to schema implementation review. The
important invariants are:

1. A model profile references one harness and one provider independently.
2. `model` remains an opaque non-empty provider catalogue ID. There is no
   Ultrafuzz model allowlist.
3. The provider owns endpoint, authentication source, and authenticated
   preflight behavior.
4. The harness owns executable/version, state directories, tool/event/session
   capabilities, and reasoning translation.
5. A validated binding chooses a mutually supported wire protocol before any
   child is launched.

Existing profiles keep working during migration. A legacy `agent =
"CodexAgent"` profile maps to the Codex harness and its existing first-party or
Codex-configured provider binding. The documented Codex/OpenRouter path gains
an explicit migration example once the new schema is implemented; it is not
silently reinterpreted.

## Proposed capability contract

The generic workflow should receive a validated binding, not CLI-specific
flags or provider environment variables:

```ts
type WireProtocol = "openai-responses" | "openai-chat" | "anthropic-messages" | "provider-native";

interface ProviderBinding {
  id: string;
  kind: string;
  baseUrl: string;
  credentialEnv: string;
  protocols: readonly WireProtocol[];
  preflight: "openrouter-key" | "authenticated-models" | "first-request";
}

interface HarnessCapabilities {
  id: string;
  executable: string;
  version: string;
  protocols: readonly WireProtocol[];
  unattended: true;
  tools: { filesystem: boolean; shell: boolean };
  events: "jsonl" | "rpc";
  sessions: "none" | "resume" | "tree";
  usage: { tokens: boolean; cache: boolean; cost: boolean };
  reasoningLevels: readonly string[];
  isolation: "native-sandbox" | "external-sandbox-required";
  cloudPortable: boolean;
}

interface QualifiedHarnessBinding {
  provider: ProviderBinding;
  harness: HarnessCapabilities;
  model: string;
  reasoning?: string;
  childEnv: Record<string, string>;
}
```

The binding validator must reject an unsupported protocol, reasoning level,
missing executable/version, unavailable cloud image, or missing credential
before workflow launch. `childEnv` is built from an empty or tightly allowlisted
base and contains only the selected provider credential and harness controls.
Generic topology, prompts, and artifact verification never branch on a CLI
name.

## Conformance gate

Every approved provider/harness binding must use a pinned real CLI. Small unit
tests may fake process output, but fakes cannot satisfy qualification.

- Run a real provider request with an opaque catalogue model ID and confirm the
  provider observed that exact ID.
- Give the child one canary provider credential and ambient conflicting
  endpoints/credentials; prove only the selected endpoint receives the canary.
- Exercise read, write/edit, and shell tools in a disposable worktree.
- Produce an artifact, then pass the existing post-agent artifact contract and
  retry cleanup paths.
- Parse streaming text, tool events, terminal success/failure, tokens, cache
  fields, cost when available, and rate-limit diagnostics.
- Persist a session, resume it by explicit ID, and verify retry semantics do not
  accidentally resume an unrelated session.
- Repeat locally and in the pinned Modal image with update checks, sharing,
  third-party plugins/extensions, and unrelated user configuration disabled.
- Record the CLI version, package integrity, provider request evidence, and any
  capability that remains unknown.

## Evidence and open work

Real CLIs were used for the initial surface check:

- installed `codex-cli 0.147.0`; PR #654 executes it against a deterministic
  Responses-compatible server for both ordinary and alternate valid TOML;
- `@earendil-works/pi-coding-agent 0.84.2` was installed through `npx`, and its
  real `--version`/`--help` confirmed provider, model, JSON/RPC, tool, session,
  reasoning, config-directory, offline, and telemetry controls;
- `opencode-ai 1.18.18` was installed through `npx`, and its real `run --help`
  confirmed JSON events, model, session, variant, directory, and unattended
  approval controls;
- installed Claude Code 2.1.233 confirmed non-interactive JSON/streaming,
  schema, tool, effort, session, and permission surfaces.

There is no `OPENROUTER_API_KEY` in the research environment. Consequently Pi
and OpenCode have not passed a real OpenRouter model request, credential
isolation, artifact, telemetry, or resume smoke test. Pi's isolated offline
catalogue reported no models without authentication, and OpenCode's isolated
catalogue could not resolve OpenRouter with remote model fetching disabled.
Those results are useful preflight constraints, not qualification evidence.

The existing Smithers adapters are a transport starting point, not a complete
security boundary. Its Pi adapter maps the `apiKey` option to a `--api-key`
argument, which would expose the credential through process arguments; an
Ultrafuzz wrapper must leave that option unset, disable inherited environment,
and supply only `OPENROUTER_API_KEY` in the child environment. The adapter's
typed Pi reasoning surface also stops at `xhigh` although the real 0.84.2 CLI
advertises `max`. The OpenCode adapter supplies JSON event parsing and session
flags, but does not isolate the provider credential or OpenCode's config, data,
and cache roots. These are qualification gaps to fix, not reasons to duplicate
the process interpreters.

The next bounded work items are:

1. implement the provider/harness schema and binding validator without changing
   the existing default;
2. qualify and integrate Pi plus OpenRouter using Smithers' pinned `PiAgent`;
3. qualify OpenCode plus OpenRouter separately, including fully isolated state
   directories and disabled sharing/plugins/update/model-fetch surprises;
4. migrate the existing DeepSeek adapter terminology to an explicit Claude
   Code/DeepSeek binding without breaking current profiles;
5. decide the default only after comparable real-provider results exist.

Separate implementation issues should be opened for approved items after the
qualification evidence fixes their exact scope.

## Sources

- [Codex 0.147.0 package and source](https://github.com/openai/codex/tree/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a), including [non-interactive execution](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/exec.md) and [sandboxing](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/sandbox.md).
- [Pi 0.84.2 coding-agent package](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/package.json), [CLI/provider surface](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/README.md), [JSON events](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/json.md), [sessions](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/sessions.md), and [security boundary](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/security.md).
- [OpenCode 1.18.18 package](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/opencode/package.json), [OpenRouter provider setup](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/providers.mdx), [CLI automation/session surface](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/cli.mdx), and [permissions](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/permissions.mdx).
- [Smithers 0.32.0 Pi adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/PiAgent.js) and [OpenCode adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/OpenCodeAgent.js), matching the dependency pinned by Ultrafuzz.
- DeepSeek's [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code), [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api), and [official GitHub organization](https://github.com/orgs/deepseek-ai/repositories).
