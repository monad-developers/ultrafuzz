---
skill: "semgrep-llm-security"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Semgrep LLM Security Audit

## Snapshot and scope

- Repository: monad-developers/ultrafuzz
- Commit: a634d948038f502e5e677477138dca0c763e2380
- Skill: semgrep-llm-security, applying OWASP LLM01 through LLM10
- Status: complete

The review followed data from project-owned configuration, prompts, references, source files, and generated artifacts into the rendered model prompt; through the Codex, Claude, Kimi, DeepSeek, and OpenRouter adapters; and back through artifact verification, report rendering, the dashboard, and materialization. The target checkout remained clean.

## Findings

### C-01

Severity: critical  
OWASP mapping: LLM03 Supply Chain; also relevant to LLM06 Excessive Agency

A target repository can supply executable Smithers agent adapter code that Ultrafuzz preserves and later imports with the operator's privileges. This is a direct code-execution path and does not depend on persuading a model.

Evidence:

- packages/runtime/src/init.ts:106-189 creates the generated workflow files with writeProjectFile, while packages/runtime/src/init.ts:403-416 preserves any existing target-owned file unless force is true. This includes .smithers/agents/index.ts and every adapter.
- packages/runtime/src/init.ts:305-352 performs only narrow post-init diagnostics. A normal single-link malicious adapter that avoids the legacy mutable-config substring receives no generic integrity warning.
- packages/runtime/src/agent-registry.ts:128-159 treats methods and essentially any non-null expression as a usable factory; it establishes that a name exists, not that its implementation matches a trusted adapter.
- packages/runtime/src/validate.ts:352-384 checks only whether configured factory names are registered.
- packages/runtime/src/templates/smithers/workflows/workflow.tsx:15-18 imports ../agents/index.ts. Import evaluation runs target-supplied top-level TypeScript.
- packages/runtime/src/smithers.ts:1377-1386 walks every project .smithers/agents file, applies only a mutable-config substring check, and admits the file into the sealed execution snapshot without comparing it to a packaged digest.

Exploit scenario: an attacker commits a syntactically valid .smithers/agents/index.ts and adapter into a protocol repository. The victim runs the normal non-force initialization and then starts a campaign. Initialization preserves the files, validation sees the advertised factory, and workflow loading evaluates attacker code before any LLM output or artifact gate. The code can read same-UID files and active credentials, modify repositories, or use the network.

Mitigation:

- Never import agent implementation code from the target repository by default. Generate and load adapters from an immutable, package-owned directory or a controller-owned run snapshot outside the target tree.
- Authenticate every adapter and registry byte against a versioned manifest of packaged SHA-256 digests before workflow loading.
- Make non-force initialization fail closed when pre-existing .smithers executable files are present. If custom adapters are necessary, require a separate explicit unsafe-mode acknowledgement that names the reviewed digest.
- Execute approved custom adapters in a credential-minimized OS sandbox or fresh VM with restricted filesystem and egress.

### H-01

Severity: high  
OWASP mapping: LLM01 Prompt Injection and LLM06 Excessive Agency

Project-owned prompt files are promoted to trusted task instructions without an enforced review acknowledgement, while model agents run with command, filesystem, and network authority. A malicious repository can therefore place instructions in .ultrafuzz/prompts that are followed as first-class workflow instructions.

Evidence:

- packages/prompts/src/catalog.ts:60-82 reads project .ultrafuzz/prompts files and lets project entries replace built-in entries with the same ID.
- packages/prompts/src/scaffold.ts:31-40 preserves pre-existing project prompts unless replace is explicitly requested; packages/runtime/src/init.ts:202-229 uses this non-replacing behavior by default.
- packages/runtime/src/templates/smithers/workflows/workflow.tsx:445-456 labels Ultrafuzz task instructions as trusted, and lines 6504-6522 append promptForTask directly to that trusted task prompt.
- prompt_review_required is only parsed, normalized, typed, serialized, or placed in cloud config. A production-source search found no launch gate, acknowledgement record, or verified prompt-digest approval that consumes the value: packages/config/src/loader.ts:525-528, packages/config/src/defaults.ts:251-260, packages/config/src/resolved-config-schema.ts:294-301, and packages/config/src/resolve.ts:196-200.
- packages/runtime/src/templates/smithers/agents/claude.tsx:20-35 and deepseek.tsx:54-63 select bypassPermissions. docs/security.md:7-13 states that agents may execute commands, read operator-accessible files, and use the network.
- A read-only command-construction probe against the pinned smthrs 0.34.0 dependency showed the Codex adapter arguments include both --sandbox workspace-write and --dangerously-bypass-approvals-and-sandbox. No provider call was made.

The generic repository-content warning at workflow.tsx:445-446 is useful against instructions embedded in ordinary source files, but it does not protect the separate project-prompt channel because those bytes are intentionally appended as trusted task instructions. Schema and artifact gates limit which outputs become authenticated artifacts; they do not undo commands, reads, writes, or network requests performed during the attempt.

Mitigation:

- Load built-in prompts from package-owned immutable bytes. Treat target-provided prompt overrides as untrusted until an operator explicitly approves an exact diff and digest outside the target repository.
- Enforce prompt_review_required as a real pre-launch gate. Persist the approved prompt-set digest and fail if any rendered source differs.
- Default agents to read-only, no-network execution. Grant workspace writes only to narrowly scoped nodes and require approval for commands, network access, external writes, credential access, commits, and publication.
- Place local attempts in an OS-level sandbox or isolated VM with a minimal filesystem, no host credential stores, and destination-constrained egress.
- Add adversarial tests where both ordinary source files and project prompt overrides request secret reads, network exfiltration, publication, or mutation; the run must block them independently of model behavior.

### M-01

Severity: medium  
OWASP mapping: LLM02 Sensitive Information Disclosure

Repository secret material can reach a remote model provider before Ultrafuzz's persistence redaction runs. The model process is allowed to read the target worktree, and no preflight scanner, sensitive-path exclusion, or redacting file-read boundary mediates content returned by CLI tools to the provider.

Evidence:

- docs/security.md:7-13 acknowledges unrestricted reads and network use. Lines 38-41 state that active agent API-key variables are present in workflow processes.
- The adapters provide active credentials to the model CLI: packages/runtime/src/templates/smithers/agents/codex.tsx:57-63, deepseek.tsx:96-109, openrouter.tsx:36-53, and kimi.tsx:348-383.
- packages/security/src/sensitive-redaction.ts:3-97 provides pattern-based redaction for values after they are available to Ultrafuzz.
- One concrete persistence application is packages/runtime/src/smithers.ts:1281-1289, which redacts the stored workflow input. That does not intercept source-file contents included in provider tool-call context, nor a shell command's access to credential-bearing process state.
- A path-only secret-pattern scan of tracked files found candidates only in test fixtures; no production credential value was observed or reproduced. The issue concerns the missing boundary for repositories audited in the future.

Normal security review often requires sending source to the selected provider, so this is not a claim that private code transmission is unintended. The weakness is the absence of a separate control for credential files and secret-looking values that need not enter model context.

Mitigation:

- Before launch, scan the exact worktree snapshot for secret types and sensitive filenames. Block by default or require explicit per-file consent.
- Construct a model-visible source snapshot that excludes credential stores, private keys, environment files, cloud configuration, wallet material, and operator-defined sensitive paths.
- Mediate file reads through a redacting, size-bounded service where the backend permits it; do not rely on downstream artifact redaction.
- Keep provider authentication outside the model's shell/tool environment through a broker or credential helper, and use short-lived, least-privilege credentials.
- Document provider retention and private-code handling and require explicit confirmation when a remote provider will receive repository contents.

### M-02

Severity: medium  
OWASP mapping: LLM10 Unbounded Consumption

Execution is bounded by concurrency and wall-clock time, but there is no prompt-byte limit, token cap, per-run token budget, or monetary stop condition. Target-controlled prompts can be read in full and a campaign can keep many expensive agents active until timeouts expire.

Evidence:

- packages/prompts/src/catalog.ts:63-66 uses readFileSync on every project prompt with no file-size bound.
- packages/runtime/src/templates/smithers/workflows/workflow.tsx:114-118 accepts task prompt strings without a maximum; line 180 accepts operator_prompt without a maximum.
- packages/runtime/src/templates/smithers/workflows/workflow.tsx:1181-1195 passes only model, reasoning effort, and artifact directories to agent factories. The adapters do not set a maximum output token count.
- The default snapshot declares 61 topology nodes in .ultrafuzz/topology.yml. ultrafuzz.toml:10-18 permits four parallel agents, eight parallel nodes, 1,800-second default task timeouts, and an 86,400-second workflow deadline.
- Repository-wide production-source searches found pricing and usage accounting plus timeout and concurrency controls, but no token-budget, request-budget, spend-limit, or hard cost-controller configuration.

Timeouts limit the maximum duration, so severity is medium rather than high. They can still allow a malicious or accidental prompt to consume substantial tokens and cost across a large graph.

Mitigation:

- Bound every project prompt, operator prompt, source file, reference, and aggregate context by bytes and tokenizer-estimated tokens before model invocation.
- Set provider-side maximum output tokens and maximum tool/model turns for every adapter.
- Add atomic per-attempt and per-run input-token, output-token, request, and monetary budgets. Refuse scheduling when the remaining budget cannot cover the next attempt.
- Stop the workflow on budget exhaustion, unusual token amplification, repeated near-timeout attempts, or anomalous per-node cost, and require explicit approval to raise a budget.
- Surface a deterministic pre-run worst-case estimate based on expanded topology, retries, model pricing, and context ceilings.

## Positive controls observed

- workflow.tsx:445-456 places a clear untrusted-content and authorized-defensive-use instruction before each task.
- packages/runtime/src/templates/smithers/agents/environment.tsx removes controller-only capability variables from child environments.
- workflow.tsx:5845-5915 captures declared outputs, enforces schema and semantic gates, verifies companions and hashes, and publishes a controller-owned verification boundary.
- packages/security/src/path-policy.ts and materialization policy reject traversal, symlink escapes, sensitive destinations, implicit bulk selection, and patch application.
- packages/dashboard/frontend/src/main.tsx:2876-2900 renders Markdown as React text nodes; no raw HTML sink was found in production dashboard, CLI, or runtime sources.
- Timeouts, concurrency limits, output byte caps, strict JSON parsing, retry reset behavior, and multi-agent triage reduce several LLM09 and LLM10 risks.

These controls materially protect artifacts and product-managed writes. They do not close the pre-model executable adapter boundary, establish a prompt-review gate, isolate unrestricted agents, redact provider-bound source content, or enforce token/cost budgets.

## Methodology and limitations

The assigned SKILL.md and all ten detailed OWASP rule files plus the section index were read in full. The repository was inventoried across runtime, prompts, security, configuration, dashboard, CLI, references, artifacts, and documentation. Targeted searches covered model/provider calls, prompt construction, process execution, environment/credential handling, redaction, HTML rendering, RAG/vector/training surfaces, resource limits, and output validation. Relevant source files were reviewed line by line, a local no-network agent-argument probe was run, and targeted ESLint checks passed.

The semgrep executable was not installed, so there is no Semgrep engine result to report; pattern searches and manual data-flow review were used instead. Live adversarial model tests were not run because they would require external provider calls and credentials and were unnecessary to establish the static trust-boundary defects. No repository file was modified, no external publication was made, and git status was clean at completion.
