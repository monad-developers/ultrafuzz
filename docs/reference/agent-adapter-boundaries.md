# Agent adapter boundaries

Ultrafuzz agent adapters should map configuration onto Smithers constructor
options. Token accounting, output interpretation, session lifecycle, command
construction, and filesystem discovery belong upstream. Local code may enforce
Ultrafuzz credential and environment policy, but it must not silently grow
a second orchestration layer.

The release-hardening audit in [#700](https://github.com/monad-developers/ultrafuzz/issues/700)
originally measured `release/v0.1.0`. This policy deliberately targets `unstable`,
whose inventory at the reviewed `fe0922ea` baseline differs from that release
branch: `unstable` registers OpenRouter, while the current release branch registers
OpenCode and Pi instead. This page does not classify the release-branch
inventory. For this `unstable`-target gate, the checked-out registry is authoritative,
and the gate requires an explicit policy for every adapter actually registered
in `agentFactories`, including a factory imported under an alias or registered
without a matching re-export.

## Command invocation admission

The shared runtime command registry addresses the Codex/OpenRouter incident
path in [#1317](https://github.com/monad-developers/ultrafuzz/issues/1317).
`CompatibleCodexAgent` maps task context onto `PreToolUse` and `PostToolUse`
configuration. The provider owns shell execution; Smithers' output callbacks
observe a command after launch and cannot safely enforce admission themselves.

On Linux, the qualified `@openai/codex@0.146.0` path reserves an invocation
before a Bash or unified-exec command starts. A reservation is scoped to the
run, node, iteration and attempt, plus exact command text and the hook's session
working directory. Exclusive file creation admits only one concurrent caller.
A duplicate receives the existing invocation, provider session and tool-call
identities, a coalescing diagnostic, and `ultrafuzz command-hook --status HANDLE`.
Use the original `write_stdin` handle to retrieve command output. A matching
terminal `PostToolUse`, including completion delivered through `write_stdin`,
permits a subsequent execution. Stream hook messages identify reservations,
coalescing and completion without copying shell commands or output into the
registry. Replaying the same completed provider tool-call identity remains
coalesced; a subsequent execution must have a new native call identity.
Completion finds the original durable reservation by its session/tool-call
identity, not by post-hook command text: existing trusted hooks may rewrite
that text. Ambiguous native identities do not release any reservation.

For intentional concurrent executions, add a unique first-line comment such
as `# ultrafuzz-command-key: second-check`. Different commands and attempts
are independent. The hook does not expose all execution options (notably a
unified-exec workdir override), so the same command text with different hidden
options also needs an explicit key. Shell syntax is not normalized.

Reservations and completion receipts live in the task workspace's
`.ultrafuzz/command-invocations` directory. They survive provider/controller
restarts on that workspace. No elapsed-time lease releases a reservation:
records with a dead controller, corrupt or incomplete records report `completion_unknown` and remain
coalesced, because a child may have outlived its provider. Poll the original
session or confirm that work stopped before deliberately choosing a new key.
`active` means the reserving controller is alive, not independently verified
shell liveness; a missing completion receipt never grants a relaunch.
This is an accidental-duplication guard, not a boundary against an agent that
changes commands or edits its own workspace.

The guard trusts only its exact session-configured Codex hook identities; it
does not use the global hook-trust bypass or change provider-home settings.
Existing user/project hook sources retain their own trust state. Versions not
explicitly qualified, missing task/trusted-CLI context, unsupported platforms,
and operational hook failures report `command guard inactive` and fail open.
Claude/DeepSeek background-completion and settings-composition contracts remain
unqualified, as do direct Kimi/Pi/OpenCode command paths. Their diagnostics make
this limitation explicit. Complete provider-independent enforcement still
requires a managed command runner or equivalent upstream admission surface;
this change does not close #1317.

`command-invocations.test.ts` covers independent-process admission races,
poll/relaunch, distinct keys, completion replay, orphan/PID-reuse and torn-record
handling. Set `ULTRAFUZZ_TEST_CODEX` to the pinned binary to run the deterministic
local Responses-server qualification after building the CLI. It exercises the
real hook CLI through fresh and resumed Codex sessions and verifies that an
unrelated untrusted hook remains disabled. A trusted rewriting hook also proves
that terminal completion permits a later distinct call while completed-call
replays stay coalesced. No paid provider request is made.

| Adapter          | Classification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Existing option or missing surface                                                                                                                                                                       | Upstream dependency                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude.tsx`     | Thin mapping plus one stated-failure hook in `StatedFailureClaudeCodeAgent`, which `deepseek.tsx` shares. Smithers reports a failed result without an `error` field as `Claude run failed` and drops Claude Code's `result` text, so the `createOutputInterpreter` override keeps that text and the `generate` override, which forgets it when each generation starts, attaches it to that generation's thrown error as `details.agentStatedFailure`. The thrown message is unchanged, because Smithers classifies it. | Uses `model`, `extraArgs`, `addDir`, `permissionMode`, `settingSources`, `apiKey`, `configDir`, and `env`.                                                                                               | [#1084](https://github.com/monad-developers/ultrafuzz/issues/1084): `@smthrs/agents` `src/ClaudeCodeAgent.js` builds a failed result's error as `limitBannerText \|\| resultError \|\| "Claude run failed"` and drops `payload.result`. |
| `codex.tsx`      | Partly avoidable. The local argv rewrite and resume awareness exist because a working constructor option is serialized incorrectly upstream. Provider-home inspection and child-environment filtering are local policy.                                                                                                                                                                                                                                                                                                | `addDir` exists, but multiple values become one `--add-dir` occurrence.                                                                                                                                  | [smithers#1622](https://github.com/smithersai/smithers/issues/1622)                                                                                                                                                                     |
| `deepseek.tsx`   | Thin mapping plus the stated-failure hook it inherits from `claude.tsx`'s `StatedFailureClaudeCodeAgent`. Route, auth, and effort map onto constructor options, and Claude Code reports usage under Anthropic field names that Smithers already reads.                                                                                                                                                                                                                                                                 | Uses `model`, first-class `effort`, `addDir`, `permissionMode`, `settingSources`, `env`, and `configDir`.                                                                                                | [#1084](https://github.com/monad-developers/ultrafuzz/issues/1084): the same upstream gap as `claude.tsx`.                                                                                                                              |
| `kimi.tsx`       | Inherent with the current dependency except for Ultrafuzz-specific bounded-I/O and credential-governance checks. Usage discovery, actual-session recovery, argv compatibility, and runtime-home isolation cannot be expressed by constructor options.                                                                                                                                                                                                                                                                  | `model`, `extraArgs`, `env`, `configDir`, and `session` exist; invocation-local usage, actual-session resolution, separate credential/runtime homes, and a Kimi Code 0.29.x command dialect are missing. | [smithers#1623](https://github.com/smithersai/smithers/issues/1623), [smithers#1626](https://github.com/smithersai/smithers/issues/1626)                                                                                                |
| `openrouter.tsx` | Inherent with the current dependency except for local credential/config materialization. Provider-output quarantine and exact-session retry are orchestration responsibilities; the inherited Codex argv workaround is separately avoidable.                                                                                                                                                                                                                                                                           | `config`, `configDir`, `env`, `model`, and `addDir` cover the route; a bounded provider-recovery policy is missing.                                                                                      | [smithers#1622](https://github.com/smithersai/smithers/issues/1622), [smithers#1625](https://github.com/smithersai/smithers/issues/1625)                                                                                                |

The listed responsibilities are explicit review declarations, not conclusions
inferred from comments or prose. The gate supplements them with a conservative
AST lower bound over executable source: static or dynamic filesystem-walking
imports, command `args` access and CLI-looking argument arrays,
output-interpreter hooks and JSON parsing of line-oriented output, common
session-continuation fields, and common token-usage fields. Every detected category must be declared;
declarations may include additional inherited or semantically reviewed
responsibilities that the detector cannot infer. Type-only declarations,
comments, strings outside argument arrays, and simple values or literal option
arrays passed by a `create*Agent` factory into its returned `*Agent`
constructor, named config-file reads, and empty diagnostic argv are deliberately
excluded.

Every `.ts` and `.tsx` source under the adapter tree has one policy record: its
reviewed purpose, its declared responsibilities, and the upstream links that
justify them. The gate does not pin source bytes, line counts, or syntax-node
counts, so a comment edit or a one-line fix needs no policy change; a change
that adds a detected responsibility still fails until the policy declares it.
This is a conservative static lower bound, not a claim that CI can infer every
semantic behavior.

The inventory walk is recursive. A new helper, either `.ts` or `.tsx`, fails
until it receives an explicit policy. Non-adapter helpers must attest an empty
responsibility set and may not contain any of the lower-bound orchestration
signals, so moving such code out of a registered adapter cannot bypass the
review. A future shared inherent workaround must add explicit adapter ownership
rather than weakening that default. Any policy update must classify a changed
adapter responsibility in the same reviewed pull request.

The gate is `packages/runtime/test/agent-adapter-boundaries.test.ts`. It scans
every TypeScript source file in the adapter directory, derives shipped adapters
from `agentFactories`, and runs in the runtime supporting-test lane, which pull
requests require.
