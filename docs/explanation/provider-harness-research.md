# Provider-agnostic coding harness research

Status: working draft for [issue #653](https://github.com/monad-developers/ultrafuzz/issues/653),
researched on 2026-08-18. Revised the same day after the issue's "DeepSeek Code"
was corrected to mean [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).

Ultrafuzz currently names adapters such as `CodexAgent` and `DeepSeekAgent` in
model profiles. That representation mixes three choices which need different
validation and release cadences:

- the coding harness that owns the agent loop and tools;
- the API provider or gateway that receives model requests;
- the provider catalogue model ID.

The current OpenRouter-through-Codex configuration is a supported compatibility
path, not a decision that OpenRouter requires Codex or that Codex should remain
the default.

## Terminology correction

The earlier revision of this page concluded that no first-party DeepSeek coding
CLI existed and that "DeepSeek Code" should not be blessed. That conclusion is
withdrawn. DeepSeek Harness (`dsh`) is a real first-party harness: MIT-licensed,
published from `deepseek-ai/deepseek-harness`, distributed as `@deepseek-ai/dsh`
on npm, and listed first under **Agent Integrations** in DeepSeek's own API
documentation — as an outbound link to the harness's own site, since those docs
host no page for it and the "Integrate with AI Tools" guide still covers only
Claude Code, OpenCode, and OpenClaw. Every DeepSeek claim below is re-derived
from that repository, the published package, and a real local execution of the
installed CLI.

Two things remain true and must not be conflated:

- `DeepSeekAgent` as Ultrafuzz ships it today is **not** DeepSeek Harness. It is
  the Claude Code binary pointed at `https://api.deepseek.com/anthropic`
  (`packages/runtime/src/templates/smithers/agents/deepseek.tsx`). That is a
  compatibility pairing between the Anthropic-shaped harness and the DeepSeek
  provider.
- DeepSeek is a provider; DeepSeek Harness is a harness. They are separately
  selectable, and either can be used without the other.

## Comparison matrix

This matrix distinguishes upstream claims from Ultrafuzz qualification. A
candidate is not supported until a pinned real CLI passes the conformance and
credential-isolation tests described below.

| Candidate                           | Provider and model binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unattended tools and artifacts                                                                                                                                                                                                                                                                                                                                                                         | Events, sessions, and telemetry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Isolation and portability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Disposition                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.147.0                   | Custom `model_provider`, `base_url`, `wire_api`, and `env_key`; the model is supplied separately. PR #654 (merged into `release/v0.1.0` on 2026-08-18, before this re-analysis) validated an OpenRouter Responses route.                                                                                                                                                                                                                                                                                                                                                                                                               | `codex exec` is non-interactive, has filesystem and shell tools, supports a final-response JSON schema, and has a native workspace-write sandbox.                                                                                                                                                                                                                                                      | JSONL events, persisted or ephemeral sessions, `exec resume`, and provider-reported usage are available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Apache-2.0; Node wrapper and native binaries. The sandbox is useful locally and the existing adapter runs in Modal workers.                                                                                                                                                                                                                                                                                                                                                                                                                              | Keep. Natural first-party pairing with OpenAI/Codex; retained as an OpenRouter compatibility path but not the provider-neutral default.                             |
| Pi 0.84.2                           | Built-in `openrouter` and `deepseek` providers; CLI accepts `--provider` and an opaque `--model`. Custom OpenAI, Anthropic, Google, and Responses-compatible providers are documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Non-interactive print mode has `read`, `write`, `edit`, and `bash`; JSON and RPC modes are designed for process integration.                                                                                                                                                                                                                                                                           | JSON events include tool lifecycle and usage. Sessions are JSONL trees with explicit IDs, continue, resume, and fork. The UI reports token/cache usage and cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | MIT and Node 22.19+. Pi has no sandbox, so the Ultrafuzz worktree and the local/container/Modal boundary must supply isolation. Version checks and install telemetry can be disabled.                                                                                                                                                                                                                                                                                                                                                                    | First gateway-neutral candidate to qualify for OpenRouter. Smithers 0.32.0 already exports a `PiAgent`.                                                             |
| OpenCode 1.18.18                    | Built-in OpenRouter support, `provider/model` selection, and explicit config entries for catalogue models; custom base URLs through AI SDK providers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `opencode run --format json --auto` is non-interactive; the Build agent exposes file, shell, search, and task tools.                                                                                                                                                                                                                                                                                   | Raw JSON events, session IDs, continue/resume/fork, exported session JSON, token usage, and cost-bearing step events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | MIT. Permissions are an approval policy, not a sandbox. Config, data, cache, model refresh, plugins, updates, and sharing all need isolated or disabled defaults.                                                                                                                                                                                                                                                                                                                                                                                        | Second gateway-neutral candidate for OpenRouter. Smithers 0.32.0 exports an `OpenCodeAgent`, but credentials and state roots still need an Ultrafuzz-owned wrapper. |
| DeepSeek Harness (`dsh`) 0.1.0-rc.7 | Two LLM adapters. `dsh-llm-deepseek` owns the `deepseek-official` route (`https://api.deepseek.com`, `DEEPSEEK_API_KEY`, default catalogue `deepseek-v4-flash` / `deepseek-v4-pro`). `dsh-llm-pi-ai` wraps `@earendil-works/pi-ai` and can reach 38 catalogue providers including `openrouter`, plus hand-declared OpenAI-compatible gateways — but the base bundle mounts it **dormant with zero routes**; a route registers only when an `llm-pi-ai:` section in `$DSH_HOME/settings.yaml` declares it. DeepSeek V4 is the shipped default (`agent-default-model` = `deepseek-official` / `deepseek-v4-flash`), not a hard coupling. | `dsh --profile headless "task"` runs one task unattended and prints the final assistant text. 25 model-facing tools, including `bash`, `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `todo_write`, `subagent`, `workflow`, and `web_search`. Native OS sandbox (`bwrap`/Landlock, Seatbelt, Windows ACL) with `read-only` / `workspace-write` (default) / `danger-full-access` modes. | **No supported machine-readable CLI output.** Headless prints prose on stdout; the JSONL event driver is explicitly "test infrastructure, not a supported CLI output format". Live machine-readable access exists only through the unshipped ACP JSON-RPC plugin or the Python SDK. Sessions persist to `$DSH_HOME/sessions/**/session-<uuid>/session.jsonl.zstd`, but headless prints no session ID and exposes no resume flag. That log is **not opaque** — plain `zstd -dc` yields typed JSONL with `tool/call`, `tool/result`, usage-bearing `assistant/chunk`, and `turn/end` records — but the format is undocumented and self-declares `"version": 0` on a prerelease that promises breaking changes, so Ultrafuzz does not parse it and no planned work depends on it. Usage never reaches stdout; OTel telemetry defaults to `DISABLED`. | MIT; Node `^22.19.0 \|\| >=24`. `$DSH_HOME` relocates profiles, sessions, settings, credentials, and identity. Config carries `apiKeyEnv` references, never literals; tool subprocesses receive an environment scrubbed by `/KEY\|PASSWORD\|SECRET\|TOKEN/i`. Prebuilt Landlock launcher for linux-x64 and linux-arm64 (an _optional_ npm dependency). Sandbox fails closed with `SANDBOX_UNAVAILABLE` when no runner is usable — but `workspace-write` under the Landlock runner leaves all of `/tmp` writable, which `bwrap`'s private tmpfs does not. | Qualify as the first-party pairing for DeepSeek V4, gated on the missing structured-output surface. Do not adopt it as a generic OpenRouter harness.                |
| Direct provider-API harness         | Full control over OpenRouter model pass-through and credential routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Ultrafuzz would own the complete tool loop, cancellation, context management, and filesystem/shell policy.                                                                                                                                                                                                                                                                                             | Ultrafuzz would own event normalization, sessions, retries, usage, and error classification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Potentially the smallest runtime boundary, but the largest new security and maintenance surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Retain as a design fallback if qualified CLIs cannot meet the contract; do not implement first.                                                                     |

## Recommended pairing policy

1. **First-party by default.** When an operator selects a provider that ships its
   own harness, that harness is the default: OpenAI is reached through the Codex
   CLI harness, Anthropic through the Claude Code harness, and DeepSeek V4
   through DeepSeek Harness (`deepseek-ai/deepseek-harness`) — the last one
   `final-text-only` and only once it is qualified. First-party pairings track
   their own model features, wire dialects, and reasoning controls without a
   translation layer.
2. **Gateways get a provider-neutral harness.** OpenRouter is a gateway, not a
   model vendor, so its default harness must be one built for arbitrary
   provider routes: Pi first, OpenCode second.
3. **Compatibility pairings stay allowed, never default.** Codex + OpenRouter
   and Claude Code + DeepSeek's Anthropic endpoint keep working and keep their
   documented migration path. Neither becomes the recommended shape for a new
   project.
4. **Only evidence promotes a pairing.** Kimi already ships as `KimiAgent`; any
   further first-party pairing needs the same conformance evidence as the ones
   above, not a vendor claim.

The one pairing this research explicitly declines is DeepSeek Harness as a
general OpenRouter harness. It can reach OpenRouter through its pi-ai route, but
it deliberately sends no OpenRouter app-attribution headers, and Pi — whose
provider layer DeepSeek Harness vendors — offers the same routing with a
supported JSON event stream.

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

[providers.deepseek]
kind = "deepseek"
base_url = "https://api.deepseek.com"
auth = "api-key"
api_key_env = "DEEPSEEK_API_KEY"
preflight = "authenticated-models"

[harnesses.pi]
kind = "pi"
version = "0.84.2"
config_dir = ".ultrafuzz/pi"

[harnesses.deepseek-harness]
kind = "dsh"
version = "0.1.0-rc.7"
config_dir = ".ultrafuzz/dsh"   # exported as DSH_HOME

[models.openrouter-sonnet]
harness = "pi"
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
reasoning = "high"

[models.deepseek-v4-pro]
harness = "deepseek-harness"
provider = "deepseek"
model = "deepseek-v4-pro"
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

Existing profiles keep working during migration. A legacy `agent = "CodexAgent"`
profile maps to the Codex harness and its existing provider binding. Legacy
`agent = "DeepSeekAgent"` maps to `harness = "claude-code"` plus
`provider = "deepseek"` — the compatibility pairing it already is — and is _not_
silently re-pointed at DeepSeek Harness.

## Proposed capability contract

The generic workflow should receive a validated binding, not CLI-specific flags
or provider environment variables:

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
  events: "jsonl" | "rpc" | "final-text-only";
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

`events: "final-text-only"` is new and exists because DeepSeek Harness needs it.
A harness in that class can still run nodes whose contract is "produce an
artifact, exit zero", but it cannot drive live dashboards, per-tool evidence, or
token accounting until it gains a structured stream. dsh's durable session log does carry typed tool and usage
records, but Ultrafuzz does not read them: the format is undocumented,
self-declares `"version": 0` on a prerelease, and upstream accepts neither issues
nor pull requests. Observability for a `final-text-only` harness comes instead
from a small smoke profile built on the real installed CLI — headless final text
plus exit status, one filesystem/shell artifact check in a disposable worktree,
and a version pin asserted at preflight. That profile is part of the dsh adapter
work, not a separate parser workstream.

The binding validator must reject an unsupported protocol, reasoning level,
missing executable/version, unavailable cloud image, or missing credential
before workflow launch. `childEnv` is built from an empty or tightly allowlisted
base and contains only the selected provider credential and harness controls.
Generic topology, prompts, and artifact verification never branch on a CLI name.

## Conformance gate

Every approved provider/harness binding must use a pinned real CLI run against
the real provider. Fake CLIs are for simple unit tests only — they may stand in
for process output in a unit test, but they never satisfy a gate and never
qualify a pairing.

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

DeepSeek Harness adds five gate items of its own:

- Prove which sandbox runner the Modal image selects, not merely that one exists.
  `dsh-sandbox-local` prefers `bwrap`, then Landlock, and fails closed with
  `SANDBOX_UNAVAILABLE` only when neither is usable. Measured here: in an
  unprivileged container the `bwrap` probe failed
  (`setting up uid map: Permission denied`) and Landlock carried the whole suite,
  so "unprivileged" does not imply "sandbox-less". The packaging is the real
  exposure — the Landlock launcher ships as _optional_ per-arch npm dependencies.
- Enumerate what `workspace-write` actually grants. Under Landlock the writable
  set is `/dev/null`, **all of `/tmp`**, and the workspace root; a write to
  `/tmp` outside the workspace succeeded. Under `bwrap` the same policy mounts a
  private `--tmpfs /tmp`. Two hosts with one policy string enforce different
  boundaries, so no run-scoped secret, `DSH_HOME`, or sibling worktree may sit
  under a shared `/tmp`.
- Point `DSH_HOME` at a run-scoped directory and prove no write lands in `~/.dsh`.
- Prove the invoking directory contains no `.env`, and say which failure is being
  prevented. `loadLayeredEnv` reads `<cwd>/.env` then `$DSH_HOME/.env` and
  materializes accepted values into `process.env`, but an inherited value always
  wins — so a repo `.env` cannot override a credential Ultrafuzz already set. The
  two live risks are a repo `.env` supplying a name Ultrafuzz left unset, and a
  repo `.env` declaring any bootstrap-only name (every `DSH_*`/`XDG_*` prefix,
  `DEEPSEEK_BASE_URL`, `PATH`, `HOME`, `NODE_OPTIONS`, the proxy variables, the
  git command hooks), which aborts the harness outright.
- Prove which route is selected. The `deepseek-official` route adds a stable
  `x-deepseek-harness-user-id` header to every request, including to a
  configured gateway, and `DSH_TELEMETRY_DISABLED` does not suppress it.

## Evidence

Real CLIs were used. Where no paid credential exists, requests were driven
against a local deterministic OpenAI-compatible endpoint; those results are
labelled as routing and isolation evidence, never as provider qualification.

Installed and executed in this environment:

- `codex-cli 0.147.0` — PR #654 executes it against a deterministic
  Responses-compatible server for both ordinary and alternate valid TOML;
- Claude Code `2.1.233` — confirmed non-interactive JSON/streaming, schema,
  tool, effort, session, and permission surfaces;
- `@earendil-works/pi-coding-agent 0.84.2` via `npx` — real `--version`/`--help`
  confirmed provider, model, JSON/RPC, tool, session, reasoning,
  config-directory, offline, and telemetry controls;
- `opencode-ai 1.18.18` via `npx` — real `run --help` confirmed JSON events,
  model, session, variant, directory, and unattended approval controls;
- `@deepseek-ai/dsh 0.1.0-rc.7` — installed from npm (532 packages) into a
  throwaway prefix and executed against an isolated `DSH_HOME`.

### DeepSeek Harness, measured

- `dsh --version` reports `0.1.0-rc.7`. The repository's only tag and release is
  the prerelease `dsh-v0.1.0-rc.7` (2026-08-17); npm shows seven versions
  published between 2026-08-10 and 2026-08-17. The README states the project is
  in developer preview and that "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."
- `dsh --profile headless --help` advertises exactly one argument and `-h`.
  There is no JSON, stream, session, or resume flag.
- `dsh --profile headless --dump-default-config` shows the shipped composition,
  including `agent-default-model` = `deepseek-official` / `deepseek-v4-flash`,
  both LLM adapters, JSONL session persistence under `dshHomePath('sessions')`,
  a `session-telemetry-otel` row whose `mode` defaults to `DISABLED`, and a
  `sandbox-policy` row defaulting to `workspace-write`.
- A real headless run against a local OpenAI-compatible endpoint printed the
  assistant text on stdout, wrote nothing to stderr, and exited 0. The endpoint
  received `Authorization: Bearer <canary>` and
  `User-Agent: deepseek-harness/0.1.0-rc.7 (+https://github.com/deepseek-ai/deepseek-harness)`,
  and the request advertised 25 tools.
- Credential isolation held in that run. `DEEPSEEK_API_KEY` and
  `DEEPSEEK_BASE_URL` were set to a _different_ local decoy endpoint; the decoy
  received zero requests and never saw the selected canary.
- Two provider requests were made for one task: the conversation request plus a
  tool-less session-title request. Any cost model must count that second call —
  or suppress it: a `--patch` overlay disabling the `session-title-llm` row took
  the same task down to one request with identical stdout and exit 0.
- A scripted tool call proved unattended execution: with the default
  `workspace-write` policy and no approval UI, `bash` created a file inside the
  workspace. A command targeting a path outside the workspace and outside `/tmp`
  was denied by the OS sandbox with
  `[sandbox: file access denied under workspace-write mode]` and an escalation
  hint that headless has no way to answer.
- The same policy is looser than its name suggests. `landlockProfileArgs` grants
  read-write on `/dev/null`, `/tmp`, and the workspace root, and a write under
  `/tmp` outside the workspace succeeded; the `bwrap` rung instead mounts a
  private `--tmpfs /tmp`. `bwrap` was unusable in this unprivileged container, so
  the wider Landlock boundary is the one that applied.
- An `env` dump through the real `bash` tool showed the credential scrub working:
  the canary key and decoy `*_TOKEN`/`*_PASSWORD` variables were absent while an
  unrelated plain variable survived (`SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`).
  Ambient `DSH_*` values are discarded, but the executor then injects a curated
  set — `DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_SESSION_JSONL` — so the
  child shell is not `DSH_*`-free.
- Sessions landed at
  `$DSH_HOME/sessions/--tmp-dshprobe2-work--/session-<uuid>/session.jsonl.zstd`.
  Nothing on stdout identifies which session a run produced.
- That session log is readable. `zstd -dc` yielded typed JSONL: `tool/call` with
  name and arguments, `tool/result` carrying the sandbox denial text,
  `assistant/chunk` records holding
  `{"type":"usage","usage":{"inputTokens":…,"outputTokens":…}}`,
  `turn/start`/`turn/end` with a completion reason, `step/start`/`step/end`,
  `sandbox/mode`, and `request/header`. The header declares `"version":0`.
  This is recorded as a measurement only — the format is undocumented and
  Ultrafuzz reads nothing from it.
- `@earendil-works/pi-ai@0.82.1` as installed by `dsh` reports 38 catalogue
  providers, including `openrouter`, `anthropic`, `openai`, `deepseek`,
  `openai-codex`, `google-vertex`, and `xai`.

### Constraints that block qualification today

- **No `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `ANTHROPIC_API_KEY`** exists
  in the research environment, so no candidate has passed a real paid provider
  request, cost telemetry check, or rate-limit diagnostic.
- **DeepSeek Harness has no supported machine-readable output.** The repository
  states the JSONL event driver is test infrastructure. `@deepseek-ai/dsh-acp`
  publishes an ACP JSON-RPC stdio server, but it is not a dependency of the
  published CLI (verified absent after install) and requires a custom Cordis
  composition. The Python SDK is the supported programmatic path and is the
  wrong runtime for Smithers. The durable session log carries similar
  evidence after the run, but reading it would mean depending on an undocumented
  `version: 0` format that upstream promises to break, so it is out of scope.
  `final-text-only` is the declared capability, and a small real-CLI smoke
  profile — not a session parser — supplies what evidence a dsh node can offer.
- **`smithers-orchestrator@0.32.0` ships no DeepSeek Harness adapter.** Its
  agent exports are `AnthropicAgent`, `OpenAIAgent`, `HermesAgent`,
  `HermesCliAgent`, `OpenClawAgent`, `AmpAgent`, `AntigravityAgent`,
  `ClaudeCodeAgent`, `CodexAgent`, `CursorAgent`, `GeminiAgent`, `PiAgent`,
  `OmpAgent`, `KimiAgent`, `ForgeAgent`, `VibeAgent`, `OpenCodeAgent`, and
  `PoolAgent`. Any dsh integration is new Ultrafuzz code.
- **Upstream has no issue or pull-request channel.** GitHub Issues are disabled
  on `deepseek-ai/deepseek-harness`, and CONTRIBUTING.md states external pull
  requests cannot be accepted at the moment; feedback goes to Discussions.
- The existing Smithers Pi adapter maps `apiKey` to a `--api-key` argument,
  which would expose the credential through process arguments; an Ultrafuzz
  wrapper must leave that option unset, disable inherited environment, and
  supply only the selected credential. Its typed Pi reasoning surface stops at
  `xhigh` although the real 0.84.2 CLI advertises `max`. The OpenCode adapter
  parses JSON events and session flags but isolates neither the provider
  credential nor OpenCode's config, data, and cache roots.

## Next work

The work is filed as bounded child issues of
[#653](https://github.com/monad-developers/ultrafuzz/issues/653):

1. [#658](https://github.com/monad-developers/ultrafuzz/issues/658) — implement
   the provider/harness/model schema and binding validator without changing the
   existing default.
2. [#659](https://github.com/monad-developers/ultrafuzz/issues/659) — qualify and
   integrate Pi plus OpenRouter using Smithers' pinned `PiAgent`.
3. [#660](https://github.com/monad-developers/ultrafuzz/issues/660) — rename the
   legacy `DeepSeekAgent` binding to the Claude Code + DeepSeek pairing it
   actually is, without breaking current profiles.
4. [#661](https://github.com/monad-developers/ultrafuzz/issues/661) — add a
   DeepSeek Harness adapter behind an explicit `harness = "dsh"` binding, scoped
   to final-text nodes. The adapter must write an `llm-pi-ai:`/`llm-deepseek:`
   settings document, not just environment variables: the pi-ai adapter ships
   with zero routes. Its evidence comes from a small real-`dsh` smoke profile —
   headless final text and exit status, one filesystem/shell artifact check in a
   disposable worktree, a version pin asserted at preflight, and an explicit
   final-text-only fallback that warns rather than failing the run. Parsing the
   undocumented `session.jsonl.zstd` format is explicitly out of scope.
5. [#662](https://github.com/monad-developers/ultrafuzz/issues/662) — qualify
   OpenCode plus OpenRouter separately, including fully isolated state
   directories and disabled sharing, plugins, update checks, and model fetching.
6. [#663](https://github.com/monad-developers/ultrafuzz/issues/663) — gate the
   Modal worker image on per-harness capability checks.
7. [#664](https://github.com/monad-developers/ultrafuzz/issues/664) — document
   the pairing policy and migration paths. The default decision itself waits on
   comparable real-provider results; until then Codex remains the shipped
   OpenRouter default, stated rather than implied.

The architecture, sequencing, risks, gates, and bounded issue proposals are in
[provider-harness-plan.html](provider-harness-plan.html).

## Sources

- [Codex 0.147.0 package and source](https://github.com/openai/codex/tree/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a), including [non-interactive execution](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/exec.md) and [sandboxing](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/sandbox.md).
- [Pi 0.84.2 coding-agent package](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/package.json), [CLI/provider surface](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/README.md), [JSON events](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/json.md), [sessions](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/sessions.md), and [security boundary](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/security.md).
- [OpenCode 1.18.18 package](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/opencode/package.json), [OpenRouter provider setup](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/providers.mdx), [CLI automation/session surface](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/cli.mdx), and [permissions](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/permissions.mdx).
- DeepSeek Harness at [`99f6f02`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca) (release [`dsh-v0.1.0-rc.7`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)): [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md), [CONTRIBUTING](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md), [CLI app](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli), [headless bundle](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/bundle/headless), [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai), [`dsh-llm-deepseek`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek), [`dsh-credentials-local`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials-local), [`dsh-launch-environment`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/util/launch-environment), [`dsh-sandbox-local`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sandbox/sandbox-local), [`dsh-subprocess-local`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subprocess/subprocess-local), [`dsh-session-telemetry-otel`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-telemetry-otel), [`dsh-anonymous-user-id`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/identity/anonymous-user-id), and [`dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp).
- DeepSeek API documentation: [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (`deepseek-v4-flash`/`deepseek-v4-pro`, 1M context, 384K max output, OpenAI + Anthropic + Responses formats); the **Agent Integrations** sidebar, which heads its list with DeepSeek Harness as an outbound link to the [harness quickstart](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) — there is no `agent_integrations/deepseek_harness` page, and the [Integrate with AI Tools](https://api-docs.deepseek.com/guides/coding_agents) guide still covers only Claude Code, OpenCode, and OpenClaw; the [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) page; and the [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api) guide.
- [Smithers 0.32.0 Pi adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/PiAgent.js) and [OpenCode adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/OpenCodeAgent.js), matching the dependency pinned by Ultrafuzz.
