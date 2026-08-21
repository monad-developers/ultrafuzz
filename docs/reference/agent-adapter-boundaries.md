# Agent adapter boundaries

Ultrafuzz agent adapters should map configuration onto Smithers constructor
options. Token accounting, output interpretation, session lifecycle, command
construction, and filesystem discovery belong upstream. Local code may enforce
Ultrafuzz credential and data-governance policy, but it must not silently grow
a second orchestration layer.

The release-hardening audit in [#700](https://github.com/monad-developers/ultrafuzz/issues/700)
originally measured `release/v0.1.0`. This policy deliberately targets `main`,
whose inventory at the reviewed `fe0922ea` baseline differs from that release
branch: `main` registers OpenRouter, while the current release branch registers
OpenCode and Pi instead. This page does not classify the release-branch
inventory. For this main-target gate, the checked-out registry is authoritative,
and the gate requires an explicit policy for every adapter actually registered
in `agentFactories`, including a factory imported under an alias or registered
without a matching re-export.

| Adapter          | Baseline | Classification                                                                                                                                                                                                                                        | Existing option or missing surface                                                                                                                                   | Upstream dependency                                                                                                                      |
| ---------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `claude.tsx`     |       86 | Thin mapping. Its override applies Ultrafuzz's child-environment policy but does not rebuild an orchestrator responsibility.                                                                                                                          | Uses `model`, `extraArgs`, `addDir`, `permissionMode`, `settingSources`, `apiKey`, `configDir`, and `env`.                                                           | None.                                                                                                                                    |
| `codex.tsx`      |      162 | Partly avoidable. The local argv rewrite and resume awareness exist because a working constructor option is serialized incorrectly upstream. Provider-home inspection and child-environment filtering are local policy.                               | `addDir` exists, but multiple values become one `--add-dir` occurrence.                                                                                              | [smithers#1622](https://github.com/smithersai/smithers/issues/1622)                                                                      |
| `deepseek.tsx`   |      336 | Inherent with the current dependency. Route and auth are already a thin mapping; result parsing and token normalization have no typed upstream surface.                                                                                               | Uses `model`, `extraArgs`, `addDir`, `permissionMode`, `settingSources`, `env`, and `configDir`; a custom-provider usage normalizer is missing.                      | [smithers#1624](https://github.com/smithersai/smithers/issues/1624)                                                                      |
| `kimi.tsx`       |    1,520 | Inherent with the current dependency except for Ultrafuzz-specific bounded-I/O and credential-governance checks. Usage discovery, actual-session recovery, argv compatibility, and runtime-home isolation cannot be expressed by constructor options. | `model`, `extraArgs`, `env`, `configDir`, and `session` exist; invocation-local usage, actual-session resolution, and separate credential/runtime homes are missing. | [smithers#1623](https://github.com/smithersai/smithers/issues/1623)                                                                      |
| `openrouter.tsx` |    1,234 | Inherent with the current dependency except for local credential/config materialization. Provider-output quarantine and exact-session retry are orchestration responsibilities; the inherited Codex argv workaround is separately avoidable.          | `config`, `configDir`, `env`, `model`, and `addDir` cover the route; a bounded provider-recovery policy is missing.                                                  | [smithers#1622](https://github.com/smithersai/smithers/issues/1622), [smithers#1625](https://github.com/smithersai/smithers/issues/1625) |

The line ceilings deliberately allow only a small formatting margin: Claude
100, Codex 175, DeepSeek 350, Kimi 1,525, and OpenRouter 1,250 lines. The listed
responsibilities are explicit review declarations, not conclusions inferred
from identifier names. Alongside line ceilings, the gate records a reviewed
purpose, TypeScript syntax-node ceiling, and exact SHA-256 source fingerprint
for every `.ts` and `.tsx` source under the adapter tree. The syntax count uses
the workspace-pinned TypeScript parser; the fingerprint ensures that an
equal-size or smaller behavior replacement still fails until the source policy
and responsibility classification receive explicit review. This is an
auditable source freeze, not a claim that CI can infer semantics.

The inventory walk is recursive. A new helper, either `.ts` or `.tsx`, fails
until it receives an explicit purpose and structural ceiling; moving code into
an existing helper changes that helper's reviewed fingerprint. Any policy
update must classify a changed adapter responsibility in the same reviewed
pull request.

The gate is `packages/runtime/test/agent-adapter-boundaries.test.ts`. It scans
every TypeScript source file in the adapter directory, derives shipped adapters
from `agentFactories`, and runs in both the required pull-request runtime smoke
path and the full runtime supporting-test shard.
