# Provider-agnostic Coding Harness Research

Status: reviewed research for
[issue #653](https://github.com/monad-developers/ultrafuzz/issues/653),
researched on 2026-08-18 and revised the same day after the issue's "DeepSeek
Code" was corrected to mean
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Last substantively revised 2026-08-19 under review.
The follow-up work is filed as
[#658](https://github.com/monad-developers/ultrafuzz/issues/658)–[#664](https://github.com/monad-developers/ultrafuzz/issues/664),
and this page is published by
[PR #665](https://github.com/monad-developers/ultrafuzz/pull/665). Those issues
name their design source by an earlier path and by section number;
[Where The Retired Section Numbers Land](#where-the-retired-section-numbers-land)
maps every one of those citations onto the heading that now carries it. The
recommendations below are proposals awaiting real-provider qualification, not
shipped defaults.

Ultrafuzz currently names adapters such as `CodexAgent` and `DeepSeekAgent` in
model profiles. That representation mixes three choices which need different
validation and release cadences:

- the coding harness that owns the agent loop and tools;
- the API provider or gateway that receives model requests;
- the provider catalogue model ID.

The current OpenRouter-through-Codex configuration is a supported compatibility
path that is also, by grandfathering, the default the current release ships. It
is not a decision that OpenRouter requires Codex or that Codex should remain the
recommended pairing; see
[Recommended Pairing Policy](#recommended-pairing-policy) for how those two
statuses differ.

## Recommended Plan And Action Items

| Order | Action                                                                                                          | Tracking issue                                                   | Decision guard                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 0     | Add separate provider, harness, and model references plus the binding validator.                                | [#658](https://github.com/monad-developers/ultrafuzz/issues/658) | Preserve every legacy profile and make no default change.                      |
| 1     | Qualify Pi with OpenRouter as the first gateway-neutral candidate.                                              | [#659](https://github.com/monad-developers/ultrafuzz/issues/659) | Proposed default only after a pinned real CLI clears the real-provider gates.  |
| 2a    | Rename the legacy `DeepSeekAgent` binding to the Claude Code + DeepSeek compatibility pairing it actually runs. | [#660](https://github.com/monad-developers/ultrafuzz/issues/660) | Terminology change only; preserve runtime behavior.                            |
| 2b    | Add the first-party DeepSeek Harness (`dsh`) binding for DeepSeek V4.                                           | [#661](https://github.com/monad-developers/ultrafuzz/issues/661) | Final-text-only nodes and a small real-`dsh` smoke profile; no session parser. |
| 3     | Qualify OpenCode as the second OpenRouter option.                                                               | [#662](https://github.com/monad-developers/ultrafuzz/issues/662) | Reuse the proven isolation contract, not ambient user state.                   |
| 4     | Gate every approved harness in the pinned Modal worker image.                                                   | [#663](https://github.com/monad-developers/ultrafuzz/issues/663) | Local and Modal results must agree before default eligibility.                 |
| 5     | Publish migration/operator docs and choose the OpenRouter default from comparable evidence.                     | [#664](https://github.com/monad-developers/ultrafuzz/issues/664) | Until then, Codex remains the grandfathered shipped OpenRouter default.        |

The pairing recommendation is therefore: Codex for OpenAI, Claude Code for
Anthropic, DeepSeek Harness as the proposed first-party DeepSeek V4 harness,
Pi first and OpenCode second for OpenRouter, and existing cross-provider
pairings retained as supported compatibility paths rather than recommended
defaults.

## What "DeepSeek Code" Refers To

The "DeepSeek Code" named in issue #653 is DeepSeek Harness (`dsh`), a real
first-party harness: MIT-licensed, published from `deepseek-ai/deepseek-harness`,
distributed as `@deepseek-ai/dsh` on npm, and listed first under **Agent
Integrations** in DeepSeek's own API documentation — as an outbound link to the
harness's own site, since those docs host no page for it and the "Integrate with
AI Tools" guide still covers only Claude Code, OpenCode, and OpenClaw. Every
DeepSeek claim below is derived from that repository, the published package, and
a real local execution of the installed CLI.

So the name in #653 does resolve to a real first-party harness, and the caution
it raises applies in the opposite direction from the obvious one: the risk is
not that "DeepSeek Code" names nothing, but that the harness and the provider
get treated as a single selection.

Two things remain true and must not be conflated:

- `DeepSeekAgent` as Ultrafuzz ships it today is **not** DeepSeek Harness. It is
  the Claude Code binary pointed at `https://api.deepseek.com/anthropic`
  (`packages/runtime/src/templates/smithers/agents/deepseek.tsx`). That is a
  compatibility pairing between the Anthropic-shaped harness and the DeepSeek
  provider.
- DeepSeek is a provider; DeepSeek Harness is a harness. They are separately
  selectable, and either can be used without the other.

## Comparison Matrix

This matrix distinguishes upstream claims from Ultrafuzz qualification. A
candidate is not supported until a pinned real CLI clears the qualification
gates and credential-isolation checks described below.

The three kinds of evidence collected here are not interchangeable, so every
row names its provenance:

| Provenance         | What it means                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **real run**       | The CLI was installed at an exact recorded version and executed in this environment against a live endpoint. Where no paid credential existed that endpoint was a local deterministic server: routing evidence, never qualification. |
| **CLI inspection** | The real installed binary answered `--version` and `--help`. The capability is advertised by the executable itself but was not exercised end to end.                                                                                 |
| **upstream docs**  | Vendor documentation or source read at a pinned commit. A claim, not a measurement.                                                                                                                                                  |

The `Events`, `Sessions`, and `Isolation` columns are drawn from the
capability-contract vocabulary defined in
[the contract below](#proposed-capability-contract). A cell naming a single
value is exactly the capability a binding would declare. A composite cell such
as `jsonl` + schema names the declared contract value first and then an
advertised extra that is _not_ itself a contract value. Pi's `jsonl` + `rpc`
cell is not that shape: `rpc` _is_ a contract value, and Pi advertises both
modes, so a Pi binding must declare exactly one of them. A Pi binding declaring
`jsonl` therefore does **not** satisfy a node requiring `rpc` — the two event
classes are incomparable under the relation in
[the capability contract](#proposed-capability-contract), so covering both would
take two bindings. The direct provider-API row declares nothing at all, because
it is not a harness binding.

| Candidate                           | Events                      | Sessions                    | Isolation                   | Evidence                                       | Disposition                                            |
| ----------------------------------- | --------------------------- | --------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Codex CLI 0.147.0                   | `jsonl` + schema            | `resume`                    | `native-sandbox`            | real run (PR #654), upstream docs              | First-party for OpenAI; OpenRouter compatibility path  |
| Pi 0.84.2                           | `jsonl` + `rpc`             | `tree`                      | `external-sandbox-required` | CLI inspection, upstream docs                  | Proposed OpenRouter default, pending qualification     |
| OpenCode 1.18.18                    | `jsonl`                     | `tree`                      | `external-sandbox-required` | CLI inspection, upstream docs                  | Proposed second OpenRouter option                      |
| Claude Code 2.1.233                 | `jsonl` + schema            | `resume`                    | `external-sandbox-required` | CLI inspection, upstream docs                  | First-party for Anthropic; compatibility for DeepSeek  |
| DeepSeek Harness (`dsh`) 0.1.0-rc.7 | `final-text-only`           | `none`                      | `native-sandbox`            | real run (local endpoint), source at `99f6f02` | Proposed first-party for DeepSeek V4, final-text nodes |
| Direct provider-API harness         | n/a — not a harness binding | n/a — not a harness binding | n/a — not a harness binding | design only                                    | Fallback; do not implement first                       |

Three dimensions issue #653 asks about are **not** answered for any candidate,
because no row was exercised against a real paid provider: error classification,
preflight behavior, and retry / rate-limit semantics. That includes the two
_real run_ rows — both drove local deterministic endpoints, which return no 401,
no 429, and no rate-limit headers to classify. Nothing in this research provoked
a 401, a 429, a rejected model ID, or a mid-stream disconnect from a real
provider, so how each harness classifies those failures, what it retries, and
whether it surfaces `Retry-After` are all unknown. That is a credential gap
rather than an oversight — see
[Constraints That Block Qualification Today](#constraints-that-block-qualification-today).
[G2](#qualification-gates) is where authenticated preflight behavior gets
recorded, and [G5](#qualification-gates) and [G6](#qualification-gates) are where
the other two do. **For these three dimensions, ownership is explicit for two
of the five harness candidates only**:
[#659](https://github.com/monad-developers/ultrafuzz/issues/659) owns Pi
and [#662](https://github.com/monad-developers/ultrafuzz/issues/662) owns
OpenCode; the pointers for Codex, Claude Code, and dsh are nominations. Which
cells are which, and the rule that decides it, are stated once under
[Measurement Ownership](#measurement-ownership). The only measured retry fact on
this page is internal to dsh: its `dsh-llm-retry` module runs provider retry at
durable agent-step boundaries with the vendored pi-ai SDK's own `maxRetries`
forced to zero, so one stream is one request. That is a composition-dump reading
and none of it is observable from outside the process.

The detail behind each row follows. Each subsection covers the same five
dimensions in the same order: provider and model binding, the reasoning surface,
unattended tools and artifacts, events and telemetry, and isolation and
portability.

### Codex CLI 0.147.0

_Evidence: real run (PR #654), upstream docs._

- **Binding.** Custom `model_provider`, `base_url`, `wire_api`, and `env_key`;
  the model is supplied separately. PR #654 (merged into `release/v0.1.0` on
  2026-08-18, before this re-analysis) validated an OpenRouter Responses route
  against a deterministic Responses-compatible server.
- **Reasoning.** Codex takes a reasoning effort through the
  `model_reasoning_effort` config key, and Ultrafuzz already drives it: the
  existing adapter maps its `reasoningEffort` option onto exactly that key
  (`packages/runtime/src/templates/smithers/agents/codex.tsx`). Provenance is
  upstream docs plus that in-repo adapter, not measurement — PR #654's requests
  went to a deterministic local server, so no level was ever exercised against a
  real provider. A Codex binding therefore declares no `reasoningLevels` until
  the levels are measured at the version the shipped image pins. Owner:
  see [Measurement Ownership](#measurement-ownership).
- **Unattended.** `codex exec` is non-interactive, has filesystem and shell
  tools, and supports a final-response JSON schema.
- **Events.** JSONL events, persisted or ephemeral sessions, `exec resume`, and
  provider-reported usage.
- **Isolation.** Apache-2.0; Node wrapper plus native binaries, with a native
  workspace-write sandbox. The existing adapter already runs in Modal workers.
- **Disposition.** Keep. The natural first-party pairing with OpenAI/Codex, and
  retained as an OpenRouter compatibility path — but not the provider-neutral
  default.

### Pi 0.84.2

_Evidence: CLI inspection (`--version`/`--help` on the real binary via `npx`),
upstream docs. No provider request was made._

- **Binding.** Built-in `openrouter` and `deepseek` providers; the CLI accepts
  `--provider` and an opaque `--model`. Custom OpenAI, Anthropic, Google, and
  Responses-compatible providers are documented.
- **Reasoning.** **Inspected, not exercised**: `--help` on the real 0.84.2
  binary advertises levels through `max`, but no provider request set one, so a
  Pi binding declares no `reasoningLevels` until
  [#659](https://github.com/monad-developers/ultrafuzz/issues/659) measures
  them.
- **Unattended.** Non-interactive print mode has `read`, `write`, `edit`, and
  `bash`; JSON and RPC modes are designed for process integration.
- **Events.** JSON events include tool lifecycle and usage. Sessions are JSONL
  trees with explicit IDs, continue, resume, and fork. The UI reports
  token/cache usage and cost.
- **Isolation.** MIT and Node 22.19+. Pi has no sandbox, so the Ultrafuzz
  worktree and the local/container/Modal boundary must supply isolation.
  Version checks and install telemetry can be disabled. Portability was measured
  locally only — the binary ran here through `npx`, and nothing in this research
  ran Pi inside the pinned Modal image — so a Pi binding records no
  `cloudPortable` value until #663 proves cloud readiness.
- **Disposition.** First gateway-neutral candidate to qualify for OpenRouter.
  Smithers 0.32.0 already exports a `PiAgent`.

### OpenCode 1.18.18

_Evidence: CLI inspection (`run --help` on the real binary via `npx`), upstream
docs. No provider request was made._

- **Binding.** Built-in OpenRouter support, `provider/model` selection, and
  explicit config entries for catalogue models; custom base URLs through AI SDK
  providers.
- **Reasoning.** **Inspected, not exercised**: `run --help` on the real 1.18.18
  binary exposes `--variant`, which it documents as "model variant
  (provider-specific reasoning effort, e.g., high, max, minimal)"; the per-model
  config entries can carry the same control and were not exercised either. No
  request in this research set `--variant` or observed a level reaching a
  provider, so an OpenCode binding declares no `reasoningLevels` until the
  values each OpenRouter route actually accepts are measured. Owner: see
  [Measurement Ownership](#measurement-ownership).
- **Unattended.** `opencode run --format json --auto` is non-interactive; the
  Build agent exposes file, shell, search, and task tools.
- **Events.** Raw JSON events, session IDs, continue/resume/fork, exported
  session JSON, token usage, and cost-bearing step events.
- **Isolation.** MIT. Permissions are an approval policy, not a sandbox.
  Config, data, cache, model refresh, plugins, updates, and sharing all need
  isolated or disabled defaults. Portability was measured locally only — the
  binary ran here through `npx` and never inside the pinned Modal image — so an
  OpenCode binding records no `cloudPortable` value until #663 proves cloud
  readiness, and the isolated state roots above are what that proof has to
  cover.
- **Disposition.** Second gateway-neutral candidate for OpenRouter. Smithers
  0.32.0 exports an `OpenCodeAgent`, but credentials and state roots still need
  an Ultrafuzz-owned wrapper.

### Claude Code 2.1.233

_Evidence: CLI inspection on the real installed binary, upstream docs._

- **Binding.** First-party for Anthropic, and the harness Ultrafuzz's existing
  `DeepSeekAgent` already points at `https://api.deepseek.com/anthropic`.
- **Reasoning.** An `--effort` flag, which Ultrafuzz's DeepSeek pairing already
  drives with `["low", "high", "max"]`
  (`packages/runtime/src/templates/smithers/agents/deepseek.tsx`). Provenance is
  CLI inspection plus that in-repo adapter; no level was exercised against a
  real provider, so a Claude Code binding declares no `reasoningLevels` until
  the levels are measured at the version the shipped image pins. Owner: see
  [Measurement Ownership](#measurement-ownership).
- **Unattended.** Print mode with confirmed schema, tool, effort, session, and
  permission surfaces.
- **Events.** Streaming JSON with a response schema; sessions resume by ID.
- **Isolation.** The one candidate here without an OSI licence: the package
  declares `"license": "SEE LICENSE IN README.md"`, and its `LICENSE.md` reads
  "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
  outlined here", pointing at Anthropic's published legal terms. Distributed as
  the `@anthropic-ai/claude-code` npm package (`claude` binary, Node >=22.0.0);
  the Modal worker image installs the pin recorded under
  [Evidence](#evidence). Permission modes rather than an OS sandbox, so the
  worktree and container boundary carry the isolation.
- **Disposition.** First-party default for Anthropic; the supported,
  non-recommended compatibility pairing for DeepSeek. It is the _shipped_
  default for DeepSeek only by grandfathering — nothing else reaches DeepSeek
  today — in exactly the two-status sense
  [rule 3](#recommended-pairing-policy) sets out for Codex + OpenRouter.

### DeepSeek Harness (`dsh`) 0.1.0-rc.7

_Evidence: real run against a local deterministic endpoint, plus source read at
commit
[`99f6f02`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca)._

- **Binding.** Two LLM adapters. `dsh-llm-deepseek` owns the
  `deepseek-official` route (`https://api.deepseek.com`, `DEEPSEEK_API_KEY`,
  default catalogue `deepseek-v4-flash` / `deepseek-v4-pro`). `dsh-llm-pi-ai`
  wraps `@earendil-works/pi-ai` and can reach 38 catalogue providers including
  `openrouter`, plus hand-declared OpenAI-compatible gateways — but the base
  bundle mounts it **dormant with zero routes**; a route registers only when an
  `llm-pi-ai:` section in `$DSH_HOME/settings.yaml` declares it. dsh's shipped
  composition sets `agent-default-model` to `deepseek-official` /
  `deepseek-v4-flash`, which is dsh's own model selection rather than a hard
  coupling — and not a _shipped default_ in the sense
  [rule 3](#recommended-pairing-policy) defines, which is reserved for Ultrafuzz
  provider and harness selection.
- **Reasoning.** **A surface exists in the adapter config but was never
  exercised.** `dsh-llm-deepseek` declares
  `thinking?: 'enabled' | 'disabled'` and
  `reasoningEffort?: 'off' | 'low' | 'high' | 'max'` on its plugin config at
  `99f6f02`; an omitted `reasoningEffort` resolves to `high`, and
  `thinking: 'disabled'` restricts `reasoningEffort` to `off`. Those are
  settings-document fields, not CLI flags — `dsh --profile headless --help`
  advertises exactly one argument and `-h` — and they are absent from
  `--dump-default-config` because they carry no schema default, not because they
  do not exist. No request in this research set either field and no level was
  observed reaching the provider, so a dsh binding declares no
  `reasoningLevels` **until the surface is measured end to end**. Owner: see
  [Measurement Ownership](#measurement-ownership). Whoever takes it must publish
  the measured levels before the validator accepts a `reasoning` value for dsh;
  the field is unsupported because it is unmeasured, not because DeepSeek
  Harness lacks it.
- **Unattended.** `dsh --profile headless "task"` runs one task unattended and
  prints the final assistant text. 25 model-facing tools, including `bash`,
  `read`, `write`, `edit`, `glob`, `grep`, `str_replace_editor`, `todo_write`,
  `subagent`, `workflow`, and `web_search`.
- **Events.** **No supported machine-readable CLI output.** Headless prints
  prose on stdout; the JSONL event driver is explicitly "test infrastructure,
  not a supported CLI output format". Live machine-readable access exists only
  through the unshipped ACP JSON-RPC plugin or the Python SDK. Sessions persist
  to `$DSH_HOME/sessions/**/session-<uuid>/session.jsonl.zstd`, but headless
  prints no session ID and exposes no resume flag. That log is _not_ opaque —
  plain `zstd -dc` yields typed JSONL with `tool/call`, `tool/result`,
  usage-bearing `assistant/chunk`, and `turn/end` records — but the format is
  undocumented and self-declares `"version": 0` on a prerelease that promises
  breaking changes, so Ultrafuzz does not parse it and no planned work depends
  on it. Usage never reaches stdout; OTel telemetry defaults to `DISABLED`.
- **Isolation.** MIT; Node `^22.19.0 || >=24`. Native OS sandbox
  (`bwrap`/Landlock, Seatbelt, Windows ACL) with `read-only` / `workspace-write`
  (default) / `danger-full-access` modes. `$DSH_HOME` relocates profiles,
  sessions, settings, credentials, and identity. Config carries `apiKeyEnv`
  references, never literals; tool subprocesses receive an environment scrubbed
  by `/KEY|PASSWORD|SECRET|TOKEN/i`. The prebuilt Landlock launcher ships for
  linux-x64 and linux-arm64 as an _optional_ npm dependency. The sandbox fails
  closed with `SANDBOX_UNAVAILABLE` when no runner is usable — but
  `workspace-write` under the Landlock runner leaves all of `/tmp` writable,
  which `bwrap`'s private tmpfs does not.
- **Disposition.** Qualify as the first-party pairing for DeepSeek V4, gated on
  the missing structured-output surface. Do not adopt it as a generic
  OpenRouter harness.

### Direct Provider-API Harness

_Evidence: design analysis only. Nothing was built or measured._

- **Binding.** Full control over OpenRouter model pass-through and credential
  routing.
- **Reasoning.** Whatever each provider's API exposes, passed through directly —
  the one row where Ultrafuzz would own the mapping rather than read it off a
  CLI. Nothing was measured, because nothing was built.
- **Unattended.** Ultrafuzz would own the complete tool loop, cancellation,
  context management, and filesystem/shell policy.
- **Events.** Ultrafuzz would own event normalization, sessions, retries,
  usage, and error classification.
- **Isolation.** Potentially the smallest runtime boundary, but the largest new
  security and maintenance surface.
- **Disposition.** Retain as a design fallback if qualified CLIs cannot meet
  the contract; do not implement first.

## Recommended Pairing Policy

1. **First-party by default.** When an operator selects a provider that ships its
   own harness, that harness is the default: OpenAI is reached through the Codex
   CLI harness, Anthropic through the Claude Code harness, and DeepSeek V4
   through DeepSeek Harness (`deepseek-ai/deepseek-harness`) — the last one
   `final-text-only` and only once it is qualified. First-party pairings track
   their own model features, wire dialects, and reasoning controls without a
   translation layer.
2. **Gateways get a provider-neutral harness.** OpenRouter is a gateway, not a
   model vendor, so its default harness must be one built for arbitrary
   provider routes: Pi first, OpenCode second. Both are _proposed_ defaults
   pending real-provider qualification; until a pinned real CLI clears the
   gates against real OpenRouter, Codex remains the shipped OpenRouter default.
3. **Compatibility pairings stay allowed, never recommended.** Codex +
   OpenRouter and Claude Code + DeepSeek's Anthropic endpoint keep working and
   keep their documented migration path. Neither is the shape this page
   recommends for a new project.

   Both compatibility pairings hold two statuses at once, and the two words are
   not interchangeable. **Shipped default** describes what the current release
   actually launches when an operator selects a provider and names no harness.
   **Recommended default** describes the advice this section gives a new
   project. Codex is the shipped OpenRouter default by grandfathering, because
   it is what already ships and nothing has replaced it, while rule 2 recommends
   a gateway-neutral harness instead; the two converge at Phase 5 of the
   sequencing — the default decision carried by
   [#664](https://github.com/monad-developers/ultrafuzz/issues/664) in
   [Next Work](#next-work). Claude Code is likewise the shipped DeepSeek default
   by grandfathering, because it is the only pairing that reaches DeepSeek today,
   while rule 1 recommends DeepSeek Harness once it is qualified. Neither
   pairing acquires the recommended status before its replacement clears the
   gates, and rule 4 lists both under the _shipped_ sense of the word.

4. **Only evidence promotes a pairing.** This rule governs new and changed
   defaults, not the ones already shipping. Codex + OpenAI, **Codex +
   OpenRouter**, Claude Code + Anthropic, Claude Code + DeepSeek, and Kimi as
   `KimiAgent` remain _shipped_ defaults today without having cleared G1–G10,
   and that qualification debt is stated here rather than implied — no gate run
   exists for any of them, and
   [#664](https://github.com/monad-developers/ultrafuzz/issues/664) records the
   status explicitly. Any new or promoted first-party pairing needs the
   qualification evidence described below, not a vendor claim.

The one pairing this research explicitly declines is DeepSeek Harness as a
general OpenRouter harness. It can reach OpenRouter through its pi-ai route, but
it deliberately sends no OpenRouter app-attribution headers, and Pi — whose
provider layer DeepSeek Harness vendors — offers the same routing with a
supported JSON event stream.

## Proposed Configuration Boundary

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

# `auth` is a two-value discriminant, and `api_key_env` belongs to exactly one
# of them. `auth = "api-key"` requires `api_key_env`; `auth = "subscription"`
# forbids it, because the credential is a persisted session inside the paired
# harness's own state root rather than a value in the child environment. These
# are two researched subscription providers. Kimi is the third shipped
# persisted-session case and is mapped forward below.
[providers.openai-subscription]
kind = "openai"
base_url = "https://api.openai.com/v1"
auth = "subscription"
preflight = "first-request"

[providers.anthropic-subscription]
kind = "anthropic"
base_url = "https://api.anthropic.com"
auth = "subscription"
preflight = "first-request"

[harnesses.pi]
kind = "pi"
version = "0.84.2"
config_seed_dir = ".ultrafuzz/harness/pi"  # seed dir, copied per run

[harnesses.dsh]
kind = "dsh"
version = "0.1.0-rc.7"
# Seed directory only. The launcher copies it into the per-run state root
# .ultrafuzz/runs/<run-id>/harness/dsh/ and exports that path, never this
# literal, as DSH_HOME.
config_seed_dir = ".ultrafuzz/harness/dsh"

# Persisted-credential harnesses declare `state_root` instead of
# `config_seed_dir`: one explicitly named, stable, writable directory outside the
# run scope, exported verbatim, because that directory is where the harness's own
# logged-in session already lives. The two keys are mutually exclusive.
[harnesses.codex-subscription]
kind = "codex"
version = "0.147.0"
state_root = "/absolute/path/to/operator/.codex" # CODEX_HOME; holds auth.json

[harnesses.claude-code-subscription]
kind = "claude-code"
version = "2.1.233"
state_root = "/absolute/path/to/operator/.claude" # CLAUDE_CONFIG_DIR

[models.openrouter-sonnet]
harness = "pi"
provider = "openrouter"
model = "anthropic/claude-sonnet-4"
# No `reasoning` key yet: Pi's `--help` advertises levels through `max`, but no
# real request exercised them, so this binding omits
# `reasoningLevels` until #659 measures them. No binding in this example sets
# `reasoning`, because no candidate has a measured level today.

[models.deepseek-v4-pro]
harness = "dsh"
provider = "deepseek"
model = "deepseek-v4-pro"
# No `reasoning` key yet: dsh exposes `thinking`/`reasoningEffort` in its
# adapter settings, but no run has exercised them, so this binding omits
# `reasoningLevels` until the levels are measured (#661 nominated).

# Two of the three shipped subscription bindings are shown here. Neither
# profile names a credential environment variable, and the validator records
# the persisted-credential exemption of invariant 7 for both. Kimi Code is the
# third shipped binding and is mapped from the legacy configuration below.
[models.codex-subscription]
harness = "codex-subscription"
provider = "openai-subscription"
model = "gpt-5.5"

[models.claude-subscription]
harness = "claude-code-subscription"
provider = "anthropic-subscription"
model = "claude-opus-4-8"
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
6. `config_seed_dir` is a pre-run seed directory, never exported verbatim. The
   composition is fixed per invocation: the launcher creates
   `.ultrafuzz/runs/<run-id>/harness/<harness-id>/<model-profile-id>/<node-id>/<attempt>/`,
   copies the declared `config_seed_dir` in as that root's initial contents,
   and exports _that_ path — never the declared literal — as `DSH_HOME`,
   `CODEX_HOME`, and the like. The identifiers are normalized to filesystem-safe
   path segments. Concurrent nodes using one harness with different providers
   or model profiles therefore never share config, sessions, or caches; no run
   mutates the seed. Both
   surfaces extend the campaign layout documented in
   [docs/index.md](../index.md), which lists `runs/` but no `harness/` entry
   today: `.ultrafuzz/harness/**` for the seeds and
   `.ultrafuzz/runs/<run-id>/harness/**` for the invocation roots. The name is
   deliberately _not_ `config_dir`: `[agents.<id>].config_dir` is already a
   shipped key (`packages/config/src/loader.ts`) that Ultrafuzz exports
   **verbatim** as whichever state-root variable the selected CLI reads —
   `CODEX_HOME` for `CodexAgent`, `CLAUDE_CONFIG_DIR` for `ClaudeAgent` and
   `DeepSeekAgent`, the Kimi Code home for `KimiAgent`
   (`packages/runtime/src/templates/smithers/agents/`, documented in
   [docs/config.md](../config.md)). Seed-copy semantics are the opposite of that,
   so reusing the spelling would silently change what those variables mean for
   every existing profile. Invariant 7 below is what keeps the shipped key
   working.
7. **Persisted-credential harnesses** — those whose credential lives _inside_
   their own state root rather than in the child environment — are a class, not
   a special case, and they are exempt from the per-run state root. The class is
   exactly the bindings whose provider declares `auth = "subscription"`. Two of
   the harnesses this research covers ship in that mode today: Codex, which
   reads `CODEX_HOME/auth.json`, and Claude Code, which uses
   `CLAUDE_CONFIG_DIR` and the logged-in `claude -p` session it holds. (A third
   shipped binding, `KimiAgent`'s Kimi Code, is in the same class and is mapped
   forward below; it is not one of this page's researched candidates.) In each
   case a fresh run-scoped root would contain no session, and the launcher
   cannot recreate one: it is machine- and account-specific state issued by an
   interactive login. Such harnesses instead
   declare one **explicitly named, stable, writable `state_root` outside the run
   scope** — an absolute path to the operator's real Codex, Claude, or Kimi
   state directory — and the validator records the exemption on the binding
   rather than inferring it, so the isolation claim stays true of every binding
   that does not declare one. The alternative, rejecting subscription auth as
   unsupported, is not chosen: it is Ultrafuzz's shipped default for those
   harnesses. API-key bindings normally use the run-scoped root from invariant
   6, but a legacy `config_dir` maps to persistent state to preserve shipped
   behavior; that legal combination receives no persisted-credential exemption.

Existing profiles keep working during migration. All four shipped
`agent = "…"` references map forward to a harness and a provider:

| Legacy reference | Harness       | Provider                                        |
| ---------------- | ------------- | ----------------------------------------------- |
| `CodexAgent`     | `codex`       | `openai`, or `openrouter` for the gateway route |
| `ClaudeAgent`    | `claude-code` | `anthropic`                                     |
| `DeepSeekAgent`  | `claude-code` | `deepseek`                                      |
| `KimiAgent`      | `kimi-code`   | `kimi`                                          |

The three keys the shipped schema already accepts under `[agents.<id>]` —
`auth`, `api_key_env`, and `config_dir` (`AGENT_KEYS` in
`packages/config/src/loader.ts`) — map forward with them. `api_key_env` maps to
`credentialEnv` on the API-key arm of `ProviderAuth`, so it is present exactly
when `auth = "api-key"` and absent from every persisted-credential binding. Each
adapter's real behavior is what the mapping has to preserve:

- **`CodexAgent`** (`agents/codex.tsx`). `auth` defaults to `"subscription"`,
  which reads `CODEX_HOME/auth.json`, so the binding carries the invariant-7
  persisted-credential exemption; `auth = "api-key"` reads `api_key_env`
  (default `OPENAI_API_KEY`). A legacy `config_dir` is exported verbatim as
  `CODEX_HOME`, so it maps to the binding's persistent `state_root`, **not** to
  `config_seed_dir`, and an existing `.ultrafuzz/openrouter-codex` profile is
  unaffected.
- **`ClaudeAgent`** (`agents/claude.tsx`). `auth` also defaults to
  `"subscription"`, which clears `ANTHROPIC_API_KEY` so the logged-in
  `claude -p` session is used — the second persisted-credential case, carrying
  the same exemption; `auth = "api-key"` reads `api_key_env` (default
  `ANTHROPIC_API_KEY`). A legacy `config_dir` becomes an isolated
  `CLAUDE_CONFIG_DIR` for running subscriptions side by side, so it likewise
  maps to `state_root`.
- **`DeepSeekAgent`** (`agents/deepseek.tsx`). The one adapter that defaults to
  `auth = "api-key"` and rejects every other value, so it never takes the
  persisted-credential exemption. It is Claude Code against
  `https://api.deepseek.com/anthropic`, with `config_dir` defaulting to
  `.ultrafuzz/deepseek-claude`. Like every shipped legacy `config_dir`, that
  value is exported verbatim today and therefore maps to persistent
  `state_root`, not `config_seed_dir`; API-key + persistent is legal but carries
  no exemption. The adapter is _not_ silently re-pointed at DeepSeek Harness —
  [#660](https://github.com/monad-developers/ultrafuzz/issues/660) is what makes
  the name say so.
- **`KimiAgent`** (`agents/kimi.tsx`, executable `kimi` per
  `packages/runtime/src/doctor.ts`). `auth` defaults to `"subscription"`, which
  uses the logged-in Kimi Code layout from `KIMI_CODE_HOME`, `KIMI_SHARE_DIR`,
  or `~/.kimi-code` — the third instance of the persisted-credential class;
  `auth = "api-key"` reads `KIMI_API_KEY` with `MOONSHOT_API_KEY` as its
  automatic fallback, against `https://api.moonshot.ai/v1` unless
  `KIMI_BASE_URL` selects another compatible endpoint. `config_dir` becomes the
  Kimi Code home, so it maps to `state_root` too.

`kimi-code` is a **forward mapping of an existing binding, not a researched
candidate**: it appears in no comparison table and no gate row on this page, and
rule 4 of the [pairing policy](#recommended-pairing-policy) already lists
`KimiAgent` among the shipped defaults that carry qualification debt. Mapping it
forward is what keeps the migration complete; it is not a claim that the pairing
has been qualified.

## Proposed Capability Contract

The generic workflow should receive a validated binding, not CLI-specific flags
or provider environment variables:

```ts
type WireProtocol = "openai-responses" | "openai-chat" | "anthropic-messages" | "provider-native";

// The `auth` discriminant of `[providers.<id>]`. `credentialEnv` exists only on
// the API-key arm, so a subscription provider cannot name one and an API-key
// provider cannot omit one.
type ProviderAuth = { auth: "api-key"; credentialEnv: string } | { auth: "subscription" };

type ProviderBinding = {
  id: string;
  kind: string;
  baseUrl: string;
  protocols: readonly WireProtocol[];
  preflight: "openrouter-key" | "authenticated-models" | "first-request";
} & ProviderAuth;

// Invariant 6 versus invariant 7. `run-scoped` copies `configSeedDir` into a
// fresh per-run root; `persistent` exports one explicitly named `stateRoot`
// verbatim, and is the only shape a persisted-credential harness may declare.
type HarnessState = { mode: "run-scoped"; configSeedDir: string } | { mode: "persistent"; stateRoot: string };

interface HarnessCapabilities {
  id: string;
  executable: string;
  version: string;
  state: HarnessState;
  protocols: readonly WireProtocol[];
  unattended: true;
  tools: { filesystem: boolean; shell: boolean };
  events: "jsonl" | "rpc" | "final-text-only";
  sessions: "none" | "resume" | "tree";
  usage: { tokens: boolean; cache: boolean; cost: boolean };
  reasoningLevels?: readonly string[];
  isolation: "native-sandbox" | "external-sandbox-required";
  cloudPortable?: boolean;
}

interface QualifiedHarnessBinding {
  provider: ProviderBinding;
  harness: HarnessCapabilities;
  model: string;
  reasoning?: string;
  childEnv: Record<string, string>;
  // Present only when the validator granted the invariant-7 exemption, which it
  // records rather than infers. It is grantable only for a `subscription`
  // provider paired with a `persistent` harness state, and `childEnv` then
  // carries no provider credential at all.
  persistedCredentialExemption?: { stateRoot: string; reason: string };
}

interface NodeRequirements {
  events?: HarnessCapabilities["events"];
}
```

This is the normative spelling of the contract — normative for
[#658](https://github.com/monad-developers/ultrafuzz/issues/658) and its child
issues until [SPECS.md](../SPECS.md) absorbs it, which is the one carve-out from
the "these pages are not normative" preamble in
[the explanation index](index.md). In this vocabulary, `tools` is
`filesystem` / `shell`, `events` is
`"jsonl" | "rpc" | "final-text-only"`, `sessions` is
`"none" | "resume" | "tree"`, and `isolation` is
`"native-sandbox" | "external-sandbox-required"`. Diagnostics that name a
capability must use these strings, so an operator can match an error back to
this page.

The TOML keys and these fields are the same fields under the two spellings each
language uses: `auth` is `auth`, `api_key_env` is `credentialEnv`,
`config_seed_dir` is `configSeedDir`, and `state_root` is `stateRoot`. Three of
them exist to make invariant 7 representable rather than commented:
`ProviderAuth` is a discriminated union, so `credentialEnv` is present on the
`api-key` arm and absent on the `subscription` arm and there is no shape in
which a subscription provider names a credential variable; `HarnessState` is a
second union, so a harness declares either a seed directory or one explicitly
named persistent `stateRoot` and never both; and
`persistedCredentialExemption` is where the validator _records_ the exemption it
granted. It grants that exemption only for a `subscription` provider paired
with a `persistent` harness state. It rejects a `subscription` provider on a
`run-scoped` harness because that root has no logged-in session. An `api-key`
provider may use either state mode; when paired with a `persistent` root it is
legal but receives no exemption from the isolation claim. For `api-key` auth,
`credentialEnv` must resolve to a non-empty value before launch. For
`subscription` auth, `credentialEnv` is absent and the provider's declared
preflight must validate a usable logged-in session before workflow launch. The
configuration boundary shows two of the three shipped subscription bindings,
Codex and Claude Code; the legacy mapping below identifies Kimi Code as the
third.

Capabilities are only half of the matching. A workflow node declares what it
needs from a harness — a dashboard or telemetry node requires `events: "jsonl"`,
while a node whose contract is "produce an artifact, exit zero" requires only
`events: "final-text-only"` — and the validator matches that requirement against
the binding's declared capability before launch, so a harness whose event class
does not satisfy the node's requirement is rejected rather than scheduled and
discovered mid-run.

The comparison relation is a partial order, not a total one:
`final-text-only` is below `jsonl`, so a harness declaring `jsonl` satisfies a
node requiring `final-text-only` but never the reverse, while `rpc` is
incomparable to both — a node that requires `rpc` is satisfied only by a
harness declaring exactly `rpc`, and a harness declaring `rpc` satisfies only
that requirement. Issue
[#658](https://github.com/monad-developers/ultrafuzz/issues/658) must implement
exactly this relation.

Wherever [#658](https://github.com/monad-developers/ultrafuzz/issues/658) and
this page disagree on a capability spelling — the issue's summary block
abbreviates `tools` as `fs` / `shell` and `isolation` as `native` | `external` —
this page is the contract and the issue text is shorthand, so the implementation
follows the spellings above.

`events: "final-text-only"` is new and exists because DeepSeek Harness needs
it. A harness in that class can still run nodes whose contract is "produce an
artifact, exit zero", but it cannot drive live dashboards, per-tool evidence,
or token accounting until it gains a structured stream.

dsh's durable session log does carry typed tool and usage records, but
Ultrafuzz does not read them: the format is undocumented, self-declares
`"version": 0` on a prerelease, and upstream accepts neither issues nor pull
requests. Observability for a `final-text-only` harness comes instead from a
small smoke profile built on the real installed CLI — headless final text plus
exit status, one filesystem/shell artifact check in a disposable worktree, and
a version pin asserted at preflight. That profile is part of the dsh adapter
work, not a separate parser workstream. There is no session parser anywhere in
this plan.

The binding validator must reject an unsupported protocol, reasoning level,
missing executable/version, unavailable cloud image, missing credential, or an
event class that does not satisfy the node's requirement under the comparison
relation above before workflow launch. A harness that
records no reasoning levels accepts no `reasoning` value at all, so setting one
on such a binding is a validation error rather than a silently ignored field.
`reasoningLevels` is optional for the same reason `cloudPortable` is, and the
two spellings say different things: an **absent** `reasoningLevels` records
that nothing was measured, while an **empty** `reasoningLevels` records that
the surface _was_ measured and the harness accepts no level at all. Both make
the validator reject a `reasoning` value, but only the empty array is a
positive claim, so only a real measurement may write it. **Every harness
candidate on this page omits the field today** — none declares an empty array
either — because no reasoning level anywhere in this research reached a real
provider:

| Harness     | Reasoning surface found                            | Why nothing is declared today                 | Owner            |
| ----------- | -------------------------------------------------- | --------------------------------------------- | ---------------- |
| Codex       | `model_reasoning_effort` config key                | Requests went to a deterministic local server | #663 (nominated) |
| Claude Code | `--effort` (`low`/`high`/`max` in-repo)            | CLI inspection only; no provider request      | #663 (nominated) |
| Pi          | `--help` advertises levels through `max`           | CLI inspection only; no provider request      | #659 (owns)      |
| dsh         | `thinking` / `reasoningEffort` in adapter settings | Settings fields never set by any run          | #661 (nominated) |
| OpenCode    | `--variant` (provider-specific reasoning effort)   | CLI inspection only; no provider request      | #662 (nominated) |

All five harness candidates have a known surface and none has a measured level,
which is why none declares the field at all: only a measured level may be
declared, and writing `[]` instead would assert that the harness accepts none.
Each list appears as soon as its child issue measures real levels. The sixth row
of the [Comparison Matrix](#comparison-matrix), the direct provider-API harness,
declares no capability values whatsoever, so it has no `reasoningLevels` either
way — which is why this table has five rows and not six.

Read the Owner column under the rule in
[Measurement Ownership](#measurement-ownership).

`cloudPortable` sits in the same position: no candidate declares a value here
either, which is why the field is optional rather than a required `boolean`. A
required boolean could only say `true` or `false`, and neither is honest about a
harness nobody has run in the worker image. An absent `cloudPortable` says what
an absent `reasoningLevels` says: nothing was measured. The validator refuses to
schedule such a binding onto a cloud node rather than reading the absence as
`false` or assuming a default. What the subsections record is the _evidence_ for
cloud portability rather than the declared boolean — Codex's existing adapter
already runs in Modal workers, the Modal image installs Claude Code's pin, and
Pi and OpenCode were never run in that image at all. dsh has source-level
portability evidence only: its Node requirement matches the image, its prebuilt
sandbox runners cover Linux x64 and arm64, and a pre-baked profile needs no
first-run package installation. The image still needs a usable runner and a
writable pre-baked `DSH_HOME` or shell tools fail closed. Because the field is
normative,
[#663](https://github.com/monad-developers/ultrafuzz/issues/663) owns the
declared value for all five, and unlike the dimensions above that pointer
already resolves — see [Measurement Ownership](#measurement-ownership).

Generic topology, prompts, and artifact verification never branch on a CLI
name.

### Credential And State Rules

These rules hold for every harness, not just the ones measured here.

- `childEnv` is built from an empty or tightly allowlisted base, never
  inherited wholesale.
- For `auth = "api-key"`, `credentialEnv` resolves to exactly one non-empty
  provider credential, and it matches the endpoint the harness will actually
  call. For `auth = "subscription"`, no provider API-key variable is injected;
  the declared preflight must validate the logged-in session before workflow
  launch.
- Credentials never appear in `argv`. This rules out Smithers' `PiAgent`
  `--api-key` path, which must be left unset in favour of an environment
  variable.
- An API-key binding normally gets a run-scoped state root, so the run does not
  read or write an operator's real home. A legacy `config_dir` may map an
  API-key binding to persistent state to preserve shipped behavior, but that
  legal combination receives no persisted-credential exemption. The carve-out
  is a **class** rather than one harness: **persisted-credential harnesses**,
  whose credential lives inside their own persisted state root instead of the
  child environment. Ultrafuzz ships three under `auth = "subscription"`, the
  default mode for each harness: Codex reads `CODEX_HOME/auth.json`; Claude Code
  uses `CLAUDE_CONFIG_DIR` and its logged-in `claude -p` session; and Kimi Code
  uses its logged-in Kimi home. Those harnesses keep one explicitly named,
  stable, writable `state_root` outside the run scope (invariant 7 of the
  [configuration boundary](#proposed-configuration-boundary)) rather than being
  rejected as unsupported, and each binding declares the exemption — recorded
  by the validator, never inferred — so the isolation claim above stays true of
  everything that does not declare it. A fresh run-scoped root cannot reproduce
  these machine- and account-specific sessions created by interactive login.
- The invocation directory must not carry harness-readable configuration. For
  dsh that means proving no `.env` exists in the target worktree before launch,
  both because an unset name there would be adopted and because a
  bootstrap-only name there aborts the harness.
- The state root does not live inside a region the harness's own sandbox leaves
  writable. dsh's `workspace-write` policy grants all of `/tmp` under the
  Landlock runner, so a `DSH_HOME` under `/tmp` is reachable by the agent's own
  shell — put it beside the worktree instead.
- Assume the child shell sees harness-injected environment. dsh strips ambient
  `DSH_*` and then supplies `DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, and
  `DSH_SESSION_JSONL`; the credential scrub
  (`/KEY|PASSWORD|SECRET|TOKEN/i`) is what keeps the provider key out, not the
  `DSH_*` handling.

## Qualification Gates

Every approved provider/harness binding must use a pinned real CLI run against
the real provider. Fake CLIs are for simple unit tests only — they may stand in
for process output in a unit test, but they never satisfy a gate and never
qualify a pairing.

The gates are numbered, and those numbers are the ones the child issues cite.
They are called _qualification gates_ everywhere; "conformance suite" means
only the test code the child issues add to exercise them, never the gates
themselves.

"Pinned" means the exact version the binding declares and preflight asserts.
For the two harnesses the shipped Modal worker image installs — Codex and
Claude Code — that pin is the image's, and the versions measured for this report
are not it. For Pi, OpenCode, and dsh the image installs nothing today, so the
asserted pin is the only pin they have: the child issues fix an exact version
and assert it at preflight
([#659](https://github.com/monad-developers/ultrafuzz/issues/659) for Pi,
[#662](https://github.com/monad-developers/ultrafuzz/issues/662) for OpenCode,
[#661](https://github.com/monad-developers/ultrafuzz/issues/661) for dsh), and
adding those three to the image is
[#663](https://github.com/monad-developers/ultrafuzz/issues/663)'s work, which
is why the version-reconciliation row in
[Measurement Ownership](#measurement-ownership) records "—" for them. Either
way, evidence gathered against any build other than the asserted pin is
provenance, not qualification — see [Evidence](#evidence) for the gap between the Codex and
Claude Code versions measured here and the ones that image pins today.

- **G1 · Model pass-through.** Run a real provider request with an opaque
  catalogue model ID and confirm the provider observed that exact ID.
- **G2 · Credential isolation and preflight.** Give the child one canary
  provider credential and ambient conflicting endpoints/credentials; prove only
  the selected endpoint receives the canary. Then prove the provider's declared
  `preflight` mode behaves as specified against the real endpoint, including the
  401 path: a missing or rejected credential must fail before the harness is
  launched, not partway through a run. This definition is the normative one, and
  [#659](https://github.com/monad-developers/ultrafuzz/issues/659) inherits it
  through its `G1–G8` reference, so the preflight/401 path is in scope for that
  issue whether or not its own body restates the clause.
- **G3 · Tool execution.** Exercise read, write/edit, and shell tools in a
  disposable worktree.
- **G4 · Artifact contract.** Produce an artifact, then pass the existing
  post-agent artifact contract and retry cleanup paths.
- **G5 · Event parsing.** Parse streaming text, tool events, terminal
  success/failure, tokens, cache fields, cost when available, and rate-limit
  diagnostics.
- **G6 · Session resume.** Persist a session, resume it by explicit ID, and
  verify retry semantics do not accidentally resume an unrelated session.
- **G7 · State isolation.** Give the harness a run-scoped state root, prove
  nothing is written to the operator's real home, and prove no ambient
  configuration is adopted from the invocation directory.
- **G8 · Sandbox boundary.** Name the sandbox runner actually selected, then
  prove the boundary it enforces: a write inside the workspace succeeds, a write
  to the operator's home is denied, and every path the policy leaves writable
  outside the workspace is enumerated and accepted up front, not discovered
  later.
- **G9 · Cloud parity.** Repeat locally and in the pinned Modal image with
  update checks, sharing, third-party plugins/extensions, and unrelated user
  configuration disabled.
- **G10 · Provenance.** Record the CLI version, package integrity, provider
  request evidence, and any capability that remains unknown.

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

### Measurement Ownership

Several dimensions on this page are unmeasured, and this page nominates a child
issue for each of them. **Nomination is not assignment.** The rule, not any
snapshot of the tracker, is what governs:

> An issue owns a measurement this page nominates it for exactly when its own
> acceptance criteria name it, and until they do that dimension is unowned
> rather than assigned.

That keeps this page correct whichever way the issues are edited. This page
defines what the measurements are; each issue decides when it has taken them on.
Read the issues, not this section, for their current state. The snapshot below is
of the bodies filed as read on 2026-08-19.

| Measurement                                                       | Codex          | Claude Code    | Pi            | OpenCode       | dsh            |
| ----------------------------------------------------------------- | -------------- | -------------- | ------------- | -------------- | -------------- |
| Error classification, authenticated preflight, retry (G2, G5, G6) | #663 nominated | #663 nominated | **#659 owns** | **#662 owns**  | #661 nominated |
| Reasoning levels                                                  | #663 nominated | #663 nominated | **#659 owns** | #662 nominated | #661 nominated |
| Version reconciliation against the pins the Modal image installs  | #663 nominated | #663 nominated | —             | —              | —              |
| `cloudPortable` declared value                                    | **#663 owns**  | **#663 owns**  | **#663 owns** | **#663 owns**  | **#663 owns**  |

Three of those pointers already resolve:

- **#659 owns Pi.** Its acceptance criteria enumerate the G1–G8 measurements and
  name the reasoning one in as many words ("Pi's reasoning levels, including
  `max`, are representable").
- **#662 owns OpenCode's** error classification, preflight, and retry, through
  the same enumerated gates.
- **#663 owns the `cloudPortable` declared value** for all five candidates:
  per-harness `ultrafuzz doctor` cloud readiness and local/Modal agreement are
  enumerated acceptance criteria on that issue today.

The remaining cells are nominations, because the filed bodies do not name them:

- **#663** otherwise scopes only the pinned Modal worker image and its
  capability checks — the `dsh` sandbox runner, the Landlock per-arch package,
  pre-baked state roots and offline cold boot, cloud readiness, and local/Modal
  agreement. None of those requires reconciling the Codex and Claude Code
  version pins, producing a 401, 429, rejected-model-ID, or
  mid-stream-disconnect measurement, or exercising a reasoning level.
- **#661** scopes the dsh adapter, its isolation, and the smoke profile. It
  requires a real DeepSeek V4 request but names no 401, 429, rejected-model-ID,
  or mid-stream-disconnect measurement and no reasoning surface, so dsh's error
  classification and authenticated preflight are unowned today.
- **#662** scopes the gates, the isolated state roots, and credential handling,
  and names no reasoning, variant, effort, or thinking measurement, so its
  reasoning cell is a nomination even though its gate cells are not.

## Evidence

Real CLIs were used. Where no paid credential exists, requests were driven
against a local deterministic OpenAI-compatible endpoint; those results are
labelled as routing and isolation evidence, never as provider qualification.

**The two already-shipped harnesses measured in this research were measured at
versions the shipped image does not install.** The Modal worker image pins
`@openai/codex@0.146.0` (the `CODEX_CLI_VERSION` constant in
`packages/modal/src/runner.ts`) and `@anthropic-ai/claude-code@2.1.207` (the
`npm install -g` line in that file's `modalSecurityToolchainCommands()`), while
the versions measured below are `codex-cli 0.147.0` and Claude Code `2.1.233`.
`pnpm docs:check` asserts both pins against every place this page prints them,
so moving a pin without updating each narrative fails the check rather than
leaving one of them stale.
PR #654 also left both pins untouched, so its real-CLI assertions ran against
whatever `codex` was on `PATH`, not against the pinned image build. The Codex and
Claude Code rows are therefore evidence about newer builds than the image ships:
G9 and G10 have to be re-run at the shipped pins — or the pins moved to the
measured versions — before either pairing counts as qualified, and
[#663](https://github.com/monad-developers/ultrafuzz/issues/663) is the issue
that should own that reconciliation — once its body is extended to say so, as
[Measurement Ownership](#measurement-ownership) records.

Installed and executed in this environment:

- `codex-cli 0.147.0` — PR #654 executes it against a deterministic
  Responses-compatible server for both ordinary and alternate valid TOML. Those
  real-CLI assertions are guarded by a `codex --version` probe and are skipped
  when no `codex` binary is on `PATH`; CI installs no `codex`, so the run is
  reproducible locally but is not exercised by CI today;
- Claude Code `2.1.233` — confirmed non-interactive JSON/streaming, schema,
  tool, effort, session, and permission surfaces;
- `@earendil-works/pi-coding-agent 0.84.2` via `npx` — real `--version`/`--help`
  confirmed provider, model, JSON/RPC, tool, session, reasoning,
  config-directory, offline, and telemetry controls;
- `opencode-ai 1.18.18` via `npx` — real `run --help` confirmed JSON events,
  model, session, variant, directory, and unattended approval controls;
- `@deepseek-ai/dsh 0.1.0-rc.7` — installed from npm (532 packages) into a
  throwaway prefix and executed against an isolated `DSH_HOME`.

### DeepSeek Harness, Measured

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
  `sandbox-policy` row defaulting to `workspace-write`. It shows no reasoning
  row, but that is a schema artefact rather than an absent surface: the
  `dsh-llm-deepseek` plugin config at `99f6f02` declares
  `thinking?: 'enabled' | 'disabled'` and
  `reasoningEffort?: 'off' | 'low' | 'high' | 'max'`, neither of which carries a
  schema default, so neither appears in a default dump. Nothing here exercised
  either field, so no reasoning level is measured.
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

### Constraints That Block Qualification Today

- **No `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, or `ANTHROPIC_API_KEY`** exists
  in the research environment, so no candidate has passed a real paid provider
  request, cost telemetry check, or rate-limit diagnostic. That is what leaves
  error classification, authenticated preflight behavior, and retry semantics
  unmeasured for every candidate, including the two _real run_ rows: no 401,
  429, rejected model ID,
  or mid-stream disconnect was ever produced to classify. Which issue owns each
  of those measurements, and which pointers are nominations rather than
  assignments, is recorded once under
  [Measurement Ownership](#measurement-ownership).
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

## Next Work

The work is filed as bounded child issues of
[#653](https://github.com/monad-developers/ultrafuzz/issues/653):

The action table at the top of this page is the sequencing source of truth. The
numbering below restates its phases with implementation detail.

1. [#658](https://github.com/monad-developers/ultrafuzz/issues/658) (Phase 0) —
   implement the provider/harness/model schema and binding validator without
   changing the existing default.
2. [#659](https://github.com/monad-developers/ultrafuzz/issues/659) (Phase 1) —
   qualify and integrate Pi plus OpenRouter using Smithers' pinned `PiAgent`.
3. [#660](https://github.com/monad-developers/ultrafuzz/issues/660) (Phase 2) —
   rename the legacy `DeepSeekAgent` binding to the Claude Code + DeepSeek
   pairing it actually is, without breaking current profiles.
4. [#661](https://github.com/monad-developers/ultrafuzz/issues/661) (Phase 2) —
   add a DeepSeek Harness adapter behind an explicit `harness = "dsh"` binding,
   scoped to final-text nodes. The adapter must write an
   `llm-pi-ai:`/`llm-deepseek:` settings document, not just environment
   variables: the pi-ai adapter ships
   with zero routes. Its evidence comes from a small real-`dsh` smoke profile —
   headless final text and exit status, one filesystem/shell artifact check in a
   disposable worktree, a version pin asserted at preflight, and an explicit
   final-text-only fallback that warns rather than failing the run. This page
   also nominates it for the reasoning measurement and for dsh's error
   classification, preflight, and retry semantics — `dsh-llm-deepseek` declares
   `thinking` and
   `reasoningEffort` (`off`/`low`/`high`/`max`) in settings, so those have to be
   driven through a real request before the binding may declare levels; see
   [Measurement Ownership](#measurement-ownership). Parsing the undocumented
   `session.jsonl.zstd` format is explicitly out of scope.
5. [#662](https://github.com/monad-developers/ultrafuzz/issues/662) (Phase 3) —
   qualify OpenCode plus OpenRouter separately, including fully isolated state
   directories and disabled sharing, plugins, update checks, and model fetching.
   This page also nominates it for the `--variant` reasoning-effort flag and the
   per-model reasoning config entries this research inspected but never
   exercised; see [Measurement Ownership](#measurement-ownership).
6. [#663](https://github.com/monad-developers/ultrafuzz/issues/663) (Phase 4) —
   gate the Modal worker image on per-harness capability checks. This page also
   nominates it for the version reconciliation between the two harnesses
   Ultrafuzz already ships, and with it the error-classification, preflight,
   retry, and reasoning-level measurements for Codex and Claude Code at the pins
   the image installs; see [Measurement Ownership](#measurement-ownership).
7. [#664](https://github.com/monad-developers/ultrafuzz/issues/664) (Phase 5) —
   document the pairing policy and migration paths. This is the phase the
   pairing-policy section above points at. The default decision itself waits on
   comparable real-provider results; until then Codex remains the shipped
   OpenRouter default, stated rather than implied.

## Where The Retired Section Numbers Land

[#653](https://github.com/monad-developers/ultrafuzz/issues/653) and its seven
child issues were filed while this plan was rendered as a standalone HTML page at
`docs/explanation/provider-harness-plan.html`, so each of them cites a design
source by that path and by section number — §2, §4, §5, §5.1, §6, §7, and §8
between them. That rendering is retired in favour of this page, which uses named
headings rather than numbers, so those eight citations need a target. Read the
path as this file and the number as the row below:

| Retired reference                            | Section on this page                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| §1 · Verdict                                 | [Recommended Plan And Action Items](#recommended-plan-and-action-items)                                                               |
| §2 · What "DeepSeek Code" refers to          | [What "DeepSeek Code" Refers To](#what-deepseek-code-refers-to)                                                                       |
| §3 · Evidence table                          | [Comparison Matrix](#comparison-matrix) and [Evidence](#evidence)                                                                     |
| §3.1 · DeepSeek Harness 0.1.0-rc.7, measured | [DeepSeek Harness, Measured](#deepseek-harness-measured)                                                                              |
| §3.2 · Candidate comparison                  | [Comparison Matrix](#comparison-matrix)                                                                                               |
| §4 · Recommended pairing policy              | [Recommended Pairing Policy](#recommended-pairing-policy)                                                                             |
| §5 · Target architecture                     | [Proposed Configuration Boundary](#proposed-configuration-boundary) and [Proposed Capability Contract](#proposed-capability-contract) |
| §5.1 · The `final-text-only` event class     | [Proposed Capability Contract](#proposed-capability-contract)                                                                         |
| §5.2 · Credential and state rules            | [Credential And State Rules](#credential-and-state-rules)                                                                             |
| §6 · Sequencing                              | [Recommended Plan And Action Items](#recommended-plan-and-action-items) and [Next Work](#next-work)                                   |
| §7 · Risks                                   | [Constraints That Block Qualification Today](#constraints-that-block-qualification-today)                                             |
| §8 · Qualification gates                     | [Qualification Gates](#qualification-gates)                                                                                           |
| §9 · Proposed GitHub issues                  | [Next Work](#next-work)                                                                                                               |
| §10 · Sources                                | [Sources](#sources)                                                                                                                   |

Two of those mappings are one-to-many because this page splits what the retired
rendering kept together: its evidence section carried both the candidate
comparison and the DeepSeek measurement, and its target architecture carried both
the configuration boundary and the capability contract. Where a child issue cites
§5 for a configuration key, the
[configuration boundary](#proposed-configuration-boundary) is the half it means;
where it cites §5 for a capability name or the event-class relation, the
[capability contract](#proposed-capability-contract) is.

## Sources

- [Codex 0.147.0 package and source](https://github.com/openai/codex/tree/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a), including [non-interactive execution](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/exec.md) and [sandboxing](https://github.com/openai/codex/blob/4a3e829c56415f8c1e69b18fbe74f4d81eaa926a/docs/sandbox.md).
- [Pi 0.84.2 coding-agent package](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/package.json), [CLI/provider surface](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/README.md), [JSON events](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/json.md), [sessions](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/sessions.md), and [security boundary](https://github.com/earendil-works/pi/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/security.md).
- [OpenCode 1.18.18 package](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/opencode/package.json), [OpenRouter provider setup](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/providers.mdx), [CLI automation/session surface](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/cli.mdx), and [permissions](https://github.com/anomalyco/opencode/blob/0033bb35599a359def31b53d73e885eb4c44d815/packages/web/src/content/docs/permissions.mdx).
- DeepSeek Harness at [`99f6f02`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca) (release [`dsh-v0.1.0-rc.7`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.0-rc.7)): [README](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/README.md), [CONTRIBUTING](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/CONTRIBUTING.md), [CLI app](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/apps/cli), [headless bundle](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/bundle/headless), [`dsh-llm-pi-ai`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/llm/llm-pi-ai), [`dsh-llm-deepseek`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/llm/llm-deepseek) (its [`src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/llm/llm-deepseek/src/index.ts) is where the `thinking`/`reasoningEffort` config surface is declared), [`dsh-credentials-local`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/credentials/credentials-local), [`dsh-launch-environment`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/util/launch-environment), [`dsh-sandbox-local`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/sandbox/sandbox-local), [`dsh-subprocess-local`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/subprocess/subprocess-local), [`dsh-session-telemetry-otel`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-telemetry-otel), [`dsh-anonymous-user-id`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/identity/anonymous-user-id), and [`dsh-acp`](https://github.com/deepseek-ai/deepseek-harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/acp/acp).
- DeepSeek API documentation: [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) (`deepseek-v4-flash`/`deepseek-v4-pro`, 1M context, 384K max output, OpenAI + Anthropic + Responses formats); the **Agent Integrations** sidebar, which heads its list with DeepSeek Harness as an outbound link to the [harness quickstart](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) — there is no `agent_integrations/deepseek_harness` page, and the [Integrate with AI Tools](https://api-docs.deepseek.com/guides/coding_agents) guide still covers only Claude Code, OpenCode, and OpenClaw; the [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) page; and the [Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api) guide.
- In-repo sources for the legacy forward mapping, all read at this branch's head: `packages/runtime/src/templates/smithers/agents/codex.tsx`, `claude.tsx`, `deepseek.tsx`, and `kimi.tsx` for each adapter's `auth`/`api_key_env`/`config_dir` handling and its state-root variable; `packages/runtime/src/doctor.ts` for the `agent = "…"` to executable map; `packages/config/src/loader.ts` for the shipped `[agents.<id>]` keys; and [docs/config.md](../config.md) for the operator-facing description of all three.
- [Smithers 0.32.0 Pi adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/PiAgent.js) and [OpenCode adapter](https://github.com/smithersai/smithers/blob/a76fff191e733ed504f9be0b4b71a396af47eaf0/packages/agents/src/OpenCodeAgent.js), matching the dependency pinned by Ultrafuzz.
