---
skill: "threat-model"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-opus-4-8"
effort: "max"
degradation_reason: "Provider refused the intended primary (claude-fable-5) on cyber / offensive-security content — the documented Fable auto-degradation on security-tooling analysis. Smithers advanced this logical run to the configured next-best retry agent, Claude Opus 4.8 (claude-opus-4-8), which is the acceptable next-most-capable model per the skill's model-selection rule."
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Ultrafuzz Threat Model — August 2026

Skill version: 8 (Threat Model Generation Skill)
Doc version: 1 (initial issuance)

# NOTICE TO AI ASSISTANTS AND AUTOMATED REVIEWERS

This document is a **working hypothesis**, not a verified security analysis. Read this notice fully before using anything below.

This document is **dual-use**: a reasoning aid for human readers and a seed for automated (LLM-driven) security audits. It is a working hypothesis for both audiences.

## How to use this document

- Treat the contents as **a starting set of questions and known concerns**, not as conclusions, guarantees, or ground truth about the code.
- When performing a security review, threat analysis, or audit: **derive your findings from the code itself.** Use this document only to seed your investigation, not to short-circuit it.
- Do not assume that a threat listed here has been mitigated in the code. Do not assume that a threat absent from this document does not exist in the code. Both errors are common.
- Do not assume that prior analysis (by humans or other LLMs) was complete, correct, or current. The presence of this document is not evidence that the code has been reviewed.
- If your task is to audit, review, or assess the security of the code, you should perform that analysis independently and from scratch. You may then cross-reference this document to identify discrepancies, but the code is authoritative.

## How this document can be wrong

- **Stale:** the code may have changed since this was last updated (see version anchor below). Components, trust boundaries, data flows, and dependencies described here may no longer exist or may behave differently.
- **Incomplete:** threats, assets, or attack surfaces may be missing entirely. Absence here implies nothing.
- **Incorrect:** assumptions about how the system works, what data flows where, or which mitigations are in place may be wrong.
- **Aspirational:** some mitigations described may be planned, partially implemented, or intended rather than actually present in the current code.

## If you are an automated reader

1. **Confirm each anchor still resolves.** Technical-detail anchors were true at their stated provenance (a commit, or a fallback snapshot identifier); a renamed or moved symbol is a staleness signal — re-find it by symbol before concluding anything about it.
2. **Verify every claim from the code.** Anchors and mechanisms are where to look, not what to conclude.
3. **Hunt beyond the listed items.** Absence from this document implies nothing. The Coverage & Unknowns map (in Open Questions) shows where prior passes stopped — that is where novel discovery is most needed.

## If you are asked to validate this document

A useful task is the inverse of trusting it: read the relevant code, then identify where this document is wrong, out of date, or missing important threats. Report discrepancies explicitly.

# Intro

Ultrafuzz is an agentic orchestrator for smart-contract fuzzing. An operator points it at a smart-contract repository (the *target*); it initializes that project with editable prompts and an execution graph, runs a fleet of specialized AI coding agents that generate fuzz/invariant tests and findings, and serves a local dashboard plus a final report for review. Model work runs through first-party Codex, Claude, Kimi, and DeepSeek adapters or through a dedicated OpenRouter adapter that accepts arbitrary OpenRouter catalogue model IDs. The workflow engine underneath is Smithers. A separate cloud path runs a benchmark matrix on Modal and publishes longitudinal eval-history metrics to the public repository.

Ultrafuzz is a shipped, actively-developed product, not a pre-launch prototype, and it makes an explicit, unusual design choice that dominates its threat surface: agents run in a *trusted local execution* model with permission checks bypassed (skip-permissions), giving each agent unattended filesystem and shell access and unrestricted network. The product does not attempt to sandbox agents; instead it enforces deterministic boundaries only around the files it writes itself, and relies on human prompt review before a run and human artifact review before anything is copied back into the target. Readers should hold both facts at once: the deterministic boundaries are unusually well-engineered and fail-closed, while the surrounding execution model is intentionally unsandboxed and accepts a class of risks outright.

## Details

The system is a pnpm/TypeScript monorepo (~256k lines across twelve workspace packages: artifacts, cli, config, dashboard, evals, evmbench, modal, prompts, references, runtime, security, topology). Node >= 22.19. It runs locally on the operator's host by default; the cloud benchmark path runs on Modal serverless sandboxes (Ubuntu 24.04 image, Foundry/Slither/Recon toolchain). Configuration lives in `ultrafuzz.toml`; the agent execution graph in `.ultrafuzz/topology.yml`; editable agent prompts in `.ultrafuzz/prompts/`; and third-party property-framework references in `.ultrafuzz/references.yml`. Run state persists to a local SQLite store (`smithers.db`).

**Attack surface categories:** (1) an *instruction-grade* boundary where untrusted target-repository content and upstream model output become agent context (indirect prompt injection); (2) agent subprocess execution with skip-permissions; (3) a loopback HTTP dashboard with read endpoints, config/topology/prompt mutation endpoints, and an in-process command endpoint that can launch runs; (4) the agent process environment, which necessarily carries the active model provider's API key; (5) the supply chain (SHA-pinned GitHub references, npm dependencies, the Modal base image and toolchain downloads); (6) the public publication path (eval-history metrics and benchmark bundle); and (7) Modal cloud credential staging and egress. **Data sensitivity:** model provider API keys, Modal cloud tokens, subscription OAuth tokens, a Braintrust key and an eval-history publisher GitHub App key, and — most notably for a security-audit tool — the *confidentiality of the target's source code*, which is transmitted to third-party model providers. No end-user PII is processed.

**Codebase snapshot used for this analysis.** This threat model was produced against commit `a634d948038f502e5e677477138dca0c763e2380` on branch `main` (2026-08-15), local checkout. Future updates should re-anchor to the then-current commit hash and record the date of the refresh.

Source code: local checkout (repository `ultrafuzz`, owner Antonio Viggiano).
Working notes: none (single-pass model).

## Risk Index and Grading

This threat model uses the Aggregate Risk Index, spec v1.1 (https://github.com/kristovatlas/ari), applied via the Threat Model Generation Skill v8. ARI is a normalized 0–100 coverage index; **lower is safer**.

**Current score: ARI = 28.4 / 100, Grade C** (Risk Mass 7.95 / Risk Capacity 28). Capped at C by one fully-relevant open High threat (T1, gap 0.50 ≥ 0.50 triggers the no-better-than-C gate).

Breakdown:
- RC = 28 (weights: two High ×5 = 10; five Medium ×3 = 15; three Low ×1 = 3). The residual mass concentrates in four threats: T1 (credentialed execution over untrusted code, 2.5), and T3/T4/T7 (redaction gap, third-party data handling, supply-chain integrity, 1.5 each). The remaining threats are layered or near the floor. ARI = 100 × 7.95 / 28 = 28.4, Grade C.

The grade is held at C by the accepted no-sandbox execution model (T1). The most efficient single move is a sandbox network egress allowlist: it drops T1's gap from ~0.50 to ~0.10 and clears the severity-gate cap, moving the grade C→B. Redacting artifact bodies and adding blockchain-key patterns (T3) is the highest-value low-effort fix.

## Prioritized Remediation Backlog

| **Rank** | **Fix (Countermeasure)** | **Closes** | **Max Severity** | **Status** | **Residual Mass** | **ΔARI if Fixed** | **Effort** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | (C13) Sandbox network egress allowlist; hold the active provider credential outside the agent-reachable environment | • (T1) Credentialed execution over untrusted code | High | ⬜ Not Applied | 2.5 | ≈ −7.1 (clears C cap → Grade B) | L |
| 2 | (C6) Redact persisted artifact bodies; add 0x-64-hex private-key and BIP-39 mnemonic patterns | • (T3) Secret leakage via artifacts | Medium | ⚠️ Partial | 1.5 | ≈ −4.3 | S–M |
| 3 | (C14) Data-handling policy / DPA; local-model profile; optional OpenRouter model-ID allowlist | • (T4) Target-code confidentiality to third parties | Medium | ⬜ Not Applied | 1.5 | ≈ −4.3 | M |
| 4 | (C11/C15) Digest-pin base image + checksum toolchain downloads; explicit git protocol lockdown for submodules | • (T7) Supply-chain integrity | Medium | ⚠️ Partial | 1.5 | ≈ −4.3 | M |
| 5 | (C12) Tighten cost/run-launch controls (confirmation on run; per-run spend ceilings) | • (T9) Resource / cost exhaustion | Low | ✅ Applied (partial residual) | 0.20 | ≈ −0.6 | S |

**Quick win:** Rank 2 (C6) is low-effort, domain-critical, and independent of the accepted-risk debate. **Grade-mover:** Rank 1 (C13) is the only fix that clears the severity-gate cap (C→B). Threats below `gap = 0.20` (T2, T5, T6, T8, T10) are layered or near the floor and are omitted from the backlog.

## UI

Ultrafuzz has two human interfaces. The **command-line interface** (`ultrafuzz`) is the primary control surface: `init`, `validate`, `run`, `resume`, `replay`, `fork`, `ps`, `inspect`, `report`, `materialize`, `clean`, `references`, `dashboard`, `doctor`, and `eval`. The operator is the sole trusted user. The **local dashboard** (`ultrafuzz dashboard`) serves a React single-page app on `127.0.0.1:3875` that visualizes the run graph, node stdout/stderr, findings, and the report, and exposes editors for the config, topology, and prompts plus a command launcher. There is no multi-user role model — both interfaces assume a single operator on a trusted host. Consumers of published output (the eval-history metrics and charts committed to the public repository, and the public benchmark bundle) are an anonymous read-only audience with no interactive surface.

## Trust Boundaries

| **ID** | **Boundary** | **Direction of Trust** | **Notes** |
| --- | --- | --- | --- |
| TB1 | Untrusted target / ground-truth repository content and upstream model output ↔ agent instruction context | Ultrafuzz trusts that files an agent is told to read contain data, not instructions | The instruction-grade boundary. The prompt renderer passes *paths*, but agents are directed to read artifacts whose bytes come from earlier agents, third-party references, and the target repo. This is where the most severe threats concentrate. |
| TB2 | Ultrafuzz controller ↔ untrusted agent subprocess | Controller trusts the agent to stay within its worktree and honor prompt instructions | Agent runs with skip-permissions: unrestricted local shell, filesystem, network. Deterministic file-write guards apply only to what the product itself writes back. |
| TB3 | Local browser / co-resident local process ↔ dashboard HTTP API | Dashboard trusts loopback callers, and mutations trust the session-token holder | Loopback-bind enforced; Host/Origin/sec-fetch-site checks and a per-process session token defend against browser-origin attackers; a same-host process is not defended (equivalent to CLI access). |
| TB4 | Host / configuration ↔ agent process environment | Host trusts that only needed variables reach the child | Two-layer env allowlist. The active provider key must be present for the agent to work, so it is always reachable by that agent. |
| TB5 | Supply chain (GitHub references, npm, Modal base image, toolchain) ↔ executed / prompt-embedded artifacts | Ultrafuzz trusts pinned upstream content and downloaded toolchains | References are SHA-pinned and integrity-checked; the container base is a mutable tag and toolchain tarballs are unverified. |
| TB6 | Ultrafuzz / CI ↔ public publication (eval-history, benchmark bundle) | The public trusts that published content is metrics from a verified commit and secret-free | Publication is path-allowlisted, secret-scrubbed, gated to same-repo default-branch producers, and pushed with a short-lived scoped token. |
| TB7 | Operator host ↔ Modal cloud sandbox | Operator trusts Modal to run the pinned image and hold staged credentials | Provider keys injected as a Modal Secret; operator launches also stage OAuth token files; no egress restriction. |

TB1 Technical detail — Anchors: prompt render in `packages/prompts/src/render.ts` (`buildVariableContext`, `renderArtifactProducer`); reference inlining in `packages/references/src/index.ts` (`normalizedReferenceMarkdown`). Provenance: observed at `a634d948`.

## Threat Actors

| **ID** | **Actor** | **Capability** | **Primary Boundary → Assets** |
| --- | --- | --- | --- |
| TA1 | Malicious target / ground-truth repository author | Controls the code Ultrafuzz is pointed at; can embed injection text in source/README and place build hooks (foundry.toml, npm scripts) that execute during build/fuzz | TB1, TB2, TB4, TB7 → A1, A3, A5, A6, A8 |
| TA2 | Malicious prompt / topology / references contributor | Can get a change merged into `.ultrafuzz/prompts/`, `topology.yml`, or `references.yml`, or edit them in a shared dev container | TB1 → A6, A8 |
| TA3 | Co-resident local process / local user on the operator host | Can make loopback HTTP requests and read local files | TB3 → A10, A11 |
| TA4 | Compromised upstream dependency, base image, or reference repo | Controls an upstream artifact that Ultrafuzz downloads or embeds | TB5 → A5, A8 |
| TA5 | Malicious website in the operator's browser | Can attempt cross-origin / DNS-rebind requests to the loopback dashboard | TB3 → A6, A10 |
| TA6 | Third-party model provider / on-path network observer | Receives target code as part of model requests; sees egress traffic | TB1, TB6 → A7, A12, A13 |
| TA7 | Malicious fork-PR author against Ultrafuzz's own CI | Can open a pull request to the Ultrafuzz repository | TB6 → A2, A4, A9 |

## Proposed Changes and Redesigns

No proposed changes are currently under consideration by the operator. The recommendations in the Prioritized Remediation Backlog (notably a sandbox egress allowlist, C13) are analyst suggestions, not committed redesigns; their projected ARI impact is stated in the backlog for planning.

# Assets

Assets are rated Low/Medium/High/Critical by the harm their compromise causes (see the skill's Calibration Anchors). Intangible assets (user trust, regulatory/contractual standing) are included where confidentiality or reputational harm is material and distinct.

| **Identifier** | **Title** | **Value** |
| --- | --- | --- |
| A1 | Model provider API keys (present in agent env) | High |
| A2 | Modal cloud tokens | High |
| A3 | Subscription OAuth tokens | High |
| A4 | Braintrust key and eval-history publisher GitHub App key | Medium |
| A5 | Operator host and filesystem (local code-execution surface) | High |
| A6 | Target repository production-source integrity | High |
| A7 | Target repository source confidentiality | High |
| A8 | Generated artifacts and findings integrity | Medium |
| A9 | Published eval-history / benchmark integrity (public) | Medium |
| A10 | Dashboard session token | Medium |
| A11 | Local run-state store | Medium |
| A12 | Intangible — user trust in Ultrafuzz's confidentiality and safety claims | High |
| A13 | Intangible — regulatory / contractual standing for third-party code sharing | Medium |

## (A1) Model provider API keys (present in agent env)

**Plain-language:** The keys that pay for and authenticate model calls (OpenAI, Anthropic, OpenRouter, DeepSeek, Kimi/Moonshot). The active run's key must be inside the agent's own process so the agent can call its model, which means any code the agent runs can read it. Theft enables billed abuse and, for some providers, access to other data under the account.

As a live, directly-usable credential handed to an unsandboxed process, the value is rated **High**.

**Technical detail:** Anchors: `packages/runtime/src/start-run.ts` (`agentEnvironmentVariableNames`); env-var names per `ultrafuzz.toml` (`api_key_env`). Mechanism: at `a634d948`, only the active run's agent key(s) are forwarded (sibling keys are dropped and hard-cleared per adapter), but the active key is necessarily readable by the agent. Provenance: observed at `a634d948`. Verification: read `start-run.ts` env construction and `packages/runtime/src/templates/smithers/agents/environment.tsx`.

## (A2) Modal cloud tokens

**Plain-language:** The credentials that let the controller create and drive Modal cloud sandboxes. Compromise lets an attacker run arbitrary cloud workloads on the account and incur cost.

As a cloud-control credential bounded to one platform account, the value is rated **High**.

**Technical detail:** Anchors: `packages/modal/src/runner.ts` (`modalClient`, reads `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`); CI `secrets.MODAL_TOKEN_ID/SECRET`. Mechanism: at `a634d948`, these authenticate the controller/CI only and are not placed in the sandbox. Provenance: observed at `a634d948`. Verification: grep `MODAL_TOKEN` across `packages/modal` and `.github/workflows`.

## (A3) Subscription OAuth tokens

**Plain-language:** When the operator uses subscription auth, the login tokens for the Codex/Claude/Kimi CLIs are copied into the Modal sandbox as files. These are long-lived and, if stolen, grant the attacker the operator's model subscription and any linked access.

As long-lived personal credentials staged into an unsandboxed execution environment, the value is rated **High**.

**Technical detail:** Anchors: `packages/modal/src/auth.ts` (`subscriptionAuthCopy`), `packages/modal/src/runner.ts` (`stageSubscriptionAuthEntry`). Mechanism: at `a634d948`, files land under `/run/ultrafuzz-auth/*` mode 600 owned by `ubuntu`; only operator (`workflow_dispatch`) launches stage them, not scheduled CI. Provenance: observed at `a634d948`. Verification: read `auth.ts` and the entrypoint staging in `runner.ts`.

## (A4) Braintrust key and eval-history publisher GitHub App key

**Plain-language:** Credentials for optional eval scoring (Braintrust) and for the bot that publishes eval history to the repository. Compromise enables unauthorized publication or use of the scoring service.

As scoped service credentials with limited blast radius (the publisher token is short-lived and single-repo), the value is rated **Medium**.

**Technical detail:** Anchors: `.github/workflows/eval-history-publication.yml` (`create-github-app-token`, `skip-token-revoke: false`); `ultrafuzz.toml` `eval.providers.braintrust.api_key_env`. Mechanism: at `a634d948`, the publisher token is minted per-run, contents-write, single-repo, and revoked after use. Provenance: observed at `a634d948`. Verification: read the publication workflow token step.

## (A5) Operator host and filesystem

**Plain-language:** The developer machine (or CI runner) that runs Ultrafuzz. Because agents have unrestricted local shell, a hijacked agent's actions are the operator's actions — read any file the operator can read, run any command, reach the network.

As the root of local trust with a large blast radius, the value is rated **High**.

## (A6) Target repository production-source integrity

**Plain-language:** The target's real production source (its `src/` and `contracts/` directories). Ultrafuzz's job is to add tests, not to change production code; a silent edit to production source could introduce a vulnerability or mask one.

As the integrity of the code under audit, the value is rated **High**.

**Technical detail:** Anchors: `packages/config` `production_source_roots` (default `["src","contracts"]`); guard in `packages/runtime/src/workspace-handoff.ts` (`assertProductionSourcePreserved`). Provenance: observed at `a634d948`.

## (A7) Target repository source confidentiality

**Plain-language:** The target's source code, which may be proprietary or a client's pre-disclosure audit code. Running Ultrafuzz sends this code to third-party model providers. Its exposure could breach a client NDA or leak an unfixed vulnerability.

As potentially confidential client material leaving the operator's control, the value is rated **High**.

## (A8) Generated artifacts and findings integrity

**Plain-language:** The fuzz tests, findings, and reports Ultrafuzz produces. If tampered with (by injection or a malicious prompt), they could hide real bugs or assert false ones, undermining the audit.

As decision-bearing output whose corruption misleads the operator, the value is rated **Medium**.

## (A9) Published eval-history / benchmark integrity (public)

**Plain-language:** The longitudinal benchmark metrics and charts committed to the public repository. If falsified, they would misrepresent tool quality to the public.

As public reputational data with a strong publication gate, the value is rated **Medium**.

## (A10) Dashboard session token

**Plain-language:** The random token that authorizes state-changing dashboard requests. Whoever holds it can rewrite config/prompts and launch runs on the operator's machine.

As a local capability token (readable by any loopback caller), the value is rated **Medium**.

**Technical detail:** Anchors: `packages/dashboard/src/index.ts` (`sessionToken`, `requireMutation`, `session()`). Mechanism: at `a634d948`, `GET /api/session` returns the token to any loopback caller without the token. Provenance: observed at `a634d948`.

## (A11) Local run-state store

**Plain-language:** The local database that records the full run (prompts, agent output, state). It stays on the operator's host and is excluded from version control, but it aggregates potentially sensitive run data subject to the same redaction gaps as artifacts.

As locally-retained run data, the value is rated **Medium**.

**Technical detail:** Anchors: `smithers.db*` in `.gitignore`. Mechanism: at `a634d948`, the store is present in the working tree but not tracked. Provenance: observed at `a634d948`.

## (A12) Intangible — user trust in Ultrafuzz's confidentiality and safety claims

**Plain-language:** Operators adopt a security tool partly on the belief that it will not leak their code or credentials and will not damage their repository. A public incident — a leaked key, exfiltrated client code, or a corrupted target — would erode that trust and adoption regardless of the direct technical loss.

As reputational capital central to a security product, the value is rated **High**.

## (A13) Intangible — regulatory / contractual standing for third-party code sharing

**Plain-language:** Sending a client's or employer's source code to external model providers may breach confidentiality clauses or internal data-handling policy. The harm is legal/contractual exposure, distinct from the technical confidentiality loss.

As contractual/compliance exposure whose severity depends on the specific engagement, the value is rated **Medium**.

# Threats

Every threat names the trust boundary it crosses (TB#) and the actor(s) able to execute it (TA#). Severity is Likelihood × Impact, calibrated conservatively.

| **ID** | **Description** | **Boundary · Actor(s)** | **Assets at Risk** | **Likelihood** | **Impact** | **Severity** |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Untrusted target/ground-truth code hijacks the skip-permissions agent (injection or build hook) → arbitrary local exec + credential exfiltration over open egress | TB1, TB2, TB4, TB7 · TA1 | • (A1)<br>• (A3)<br>• (A5)<br>• (A12) | Medium | High | High |
| T2 | Malicious committed prompt / topology / references change directs agents to write unauthorized content or misbehave | TB1 · TA2 | • (A6)<br>• (A8) | Low | High | Medium |
| T3 | Secret leaks via un-redacted artifact bodies and missing blockchain-key/mnemonic patterns | TB6 · TA1, TA6 | • (A1)<br>• (A8)<br>• (A11) | Medium | Medium | Medium |
| T4 | Proprietary target code sent to third-party providers (arbitrary OpenRouter routing; no data-handling control) | TB1, TB6 · TA6 | • (A7)<br>• (A12)<br>• (A13) | High | Medium | Medium |
| T5 | Agent escapes the product file-write boundary to corrupt production source or plant a persistent change | TB2 · TA1 | • (A6) | Low | High | Medium |
| T6 | Dashboard CSRF / DNS-rebind or co-resident local process drives mutation or launches runs | TB3 · TA5, TA3 | • (A6)<br>• (A10) | Low | Medium | Low |
| T7 | Supply-chain compromise: mutable base image, unverified toolchain downloads, unpinned references, loose submodule protocols | TB5 · TA4 | • (A5)<br>• (A8) | Low | High | Medium |
| T8 | Publication of manipulated benchmark results to the public repository | TB6 · TA1, TA7 | • (A9) | Low | Medium | Low |
| T9 | Resource / cost exhaustion: oversized topology/suite, expensive endpoints, runaway agent spend | TB2, TB3 · TA1, TA2, TA3 | • (A5) | Medium | Low | Low |
| T10 | Provider/Modal secrets exposed to Ultrafuzz CI from untrusted fork PRs | TB6 · TA7 | • (A1)<br>• (A2)<br>• (A4) | Low | High | High |

## (T1) Credentialed execution over untrusted code

**Plain-language:** Ultrafuzz points an autonomous coding agent at code the operator does not control and lets it run with full local shell, filesystem, and network access. Malicious instructions hidden in the target's source or README, or a build hook that fires when the agent compiles or fuzzes the project, can take over the agent's actions and read the model provider API key that must be present in the agent's own environment (and, in the cloud path, the operator's subscription login files), then send those secrets to an attacker over the unrestricted network. This is the central, largely-accepted risk of the design.

Crosses: (TB1) instruction-grade boundary, (TB2) controller↔agent, (TB4) host↔agent env, (TB7) host↔Modal sandbox
Actor(s): (TA1) malicious target/ground-truth repository author

Assets Impacted:
- (A1) Model provider API keys
- (A3) Subscription OAuth tokens
- (A5) Operator host and filesystem
- (A12) User trust

**Technical detail:** Anchors: `packages/runtime/src/templates/smithers/agents/claude.tsx` / `codex.tsx` / `deepseek.tsx` (`permissionMode: "bypassPermissions"`, Codex `sandbox: "workspace-write"`, `skipGitRepoCheck`); `packages/modal/src/defaults.ts` (`MODAL_BENCHMARK_SANDBOX_RESOURCES` — cpu/memory only, no egress control); `packages/modal/src/worker.ts` (`prepareWorkspace`, `configureTarget` writing an `AGENTS.md` prompt-level instruction); `docs/security.md`. Mechanism: at `a634d948`, the trust model is fixed to skip-permissions, the active provider key is required in the child env, OAuth files are staged readable by `ubuntu`, and no network egress allowlist exists; the only barriers are human prompt review and a prompt-level instruction. Provenance: observed at `a634d948`. Verification: read the adapter templates, `MODAL_BENCHMARK_SANDBOX_RESOURCES`, and `docs/security.md`; confirm no `block_network`/CIDR usage in `packages/modal`.

## (T2) Malicious committed prompt / topology / references change

**Plain-language:** The prompts, execution graph, and reference list are editable files. Someone who can get a change merged into them (or who edits them in a shared development environment) can steer agents to write content the operator did not intend or to behave adversarially. Human prompt review before launch is the intended gate, and the production-source guard blocks the most damaging writes.

Crosses: (TB1) instruction-grade boundary
Actor(s): (TA2) malicious prompt/topology/references contributor

Assets Impacted:
- (A6) Target production-source integrity
- (A8) Generated artifacts and findings integrity

**Technical detail:** Anchors: `.ultrafuzz/prompts/`, `.ultrafuzz/topology.yml`, `.ultrafuzz/references.yml`; `ultrafuzz.toml` `prompt_review_required = true`; topology validation in `packages/topology/src/validate.ts`. Mechanism: at `a634d948`, topology is strictly schema-validated (unknown keys rejected, required_commands are bare executable names, node/loop caps enforced) and the production-source handoff guard blocks `src`/`contracts` writes, so a malicious prompt's blast radius is bounded but non-zero (test/report content). Provenance: observed at `a634d948`. Verification: read `validate.ts` and `assertProductionSourcePreserved`.

## (T3) Secret leakage via artifacts

**Plain-language:** Ultrafuzz scrubs secrets from logs and diagnostics, but it does not scrub the agent's main outputs (the report, findings, and generated tests) before saving them, and its scrubber has no rule for the exact kind of secret a smart-contract agent is most likely to encounter — a raw blockchain private key or a wallet seed phrase. A key or mnemonic that an agent copies into a report or test could therefore be persisted and later surfaced or copied out.

Crosses: (TB6) publication / persistence boundary
Actor(s): (TA1) malicious target author, (TA6) third-party observer of leaked output

Assets Impacted:
- (A1) Model provider API keys
- (A8) Generated artifacts and findings integrity
- (A11) Local run-state store

**Technical detail:** Anchors: `packages/security/src/sensitive-redaction.ts` (`SECRET_PATTERNS`, `redactSecretsInValue`); applied in `packages/runtime/src/smithers.ts`, `packages/artifacts/src/{events.ts,state.ts}`, `packages/config/src/redaction.ts`; absent in `packages/runtime/src/{verified-output.ts,materialize.ts,run-documents.ts}`. Mechanism: at `a634d948`, redaction covers logs/events/diagnostics but not persisted artifact bodies, `SECRET_PATTERNS` has no `0x`-64-hex or BIP-39 rule, and the public-bundle scrubber reuses the same regexes (shared failure mode). Provenance: observed at `a634d948`. Verification: read the redaction module and grep the artifact-write paths for `redactSecrets`.

## (T4) Target-code confidentiality to third parties

**Plain-language:** Running Ultrafuzz means sending the target's source code to external model providers. With the OpenRouter adapter, the operator can name any model in OpenRouter's catalogue, so code can be routed to an unvetted model. There is no built-in policy, agreement record, or local-model option governing this, so confidential or client code can leave the operator's control with no documented basis. This is both a confidentiality loss and a trust/contractual harm.

Crosses: (TB1) instruction-grade boundary, (TB6) data-egress boundary
Actor(s): (TA6) third-party model provider

Assets Impacted:
- (A7) Target repository source confidentiality
- (A12) User trust
- (A13) Regulatory / contractual standing

**Technical detail:** Anchors: `packages/config/src/model-profiles.ts` (`validateProviderModelProfiles`, `OPENROUTER_MODEL_ID_PATTERN`); `packages/runtime/src/templates/smithers/agents/openrouter.tsx` (hardcoded `OPENROUTER_API_BASE_URL`). Mechanism: at `a634d948`, OpenRouter model IDs are accepted with only a whitespace/length check (no allowlist); the base URL is fixed to openrouter.ai and the key is never written to disk, so this is a data-routing/confidentiality concern, not host SSRF or key theft. Provenance: observed at `a634d948`. Verification: read `model-profiles.ts` and `openrouter.tsx`; confirm no local-model-only path or data-handling policy in config.

## (T5) File-write boundary escape

**Plain-language:** An agent could try to slip a change into the target's production source, or write outside its workspace, by using a traversal path, a symlink, or a file swap. Ultrafuzz's handoff and path machinery is built specifically to stop this and to fail closed if it detects an attempt.

Crosses: (TB2) controller↔agent
Actor(s): (TA1) malicious target author (via a hijacked agent)

Assets Impacted:
- (A6) Target production-source integrity

**Technical detail:** Anchors: `packages/runtime/src/workspace-handoff.ts` (`captureWorkspacePatch`, `assertProductionSourcePreserved`, `applyWorkspacePatch`); `packages/artifacts/src/{workspace-patch.ts,safe-paths.ts}` (`normalizeWorkspacePatchPath`, `assertNoSymlinkComponents`, `readSinglyLinkedRegularFileSnapshotInside`). Mechanism: at `a634d948`, changes are diffed against a baseline git tree in a temporary index; any change inside a protected root throws, symlink/gitlink modes are rejected, and reads use `O_NOFOLLOW` with nlink/dev/ino/mtime stability checks. Residual: protected-root matching is case-sensitive (see L-03), relevant only on case-insensitive filesystems. Provenance: observed at `a634d948`. Verification: read the handoff and safe-paths modules.

## (T6) Dashboard CSRF / DNS-rebind / local-process drive

**Plain-language:** The dashboard runs a web server on the operator's machine that can change config and launch runs. A malicious website in the operator's browser, or another program on the same machine, could try to send it commands. Browser-based attacks are strongly blocked; a same-host program is not blocked, though it could already run the CLI directly.

Crosses: (TB3) local↔dashboard
Actor(s): (TA5) malicious website, (TA3) co-resident local process

Assets Impacted:
- (A6) Target production-source integrity
- (A10) Dashboard session token

**Technical detail:** Anchors: `packages/dashboard/src/index.ts` (`validateLoopbackHost`, `requireLocalRequest`, `requireMutation`, `SECURITY_HEADERS`, `readBodyObject`). Mechanism: at `a634d948`, the server binds loopback (non-loopback host throws), checks Host/Origin/`sec-fetch-site`, requires a constant-time-compared `x-ultrafuzz-session` token on mutations, sets a strict CSP and `X-Frame-Options: DENY`, and caps bodies at 1 MiB; `GET /api/session` returns the token to any loopback caller and `run` has no confirmation gate. Provenance: observed at `a634d948`. Verification: read the helper functions and route dispatch.

## (T7) Supply-chain compromise

**Plain-language:** Ultrafuzz downloads a toolchain and builds a cloud image, and it can pull the latest version of third-party reference material. If an upstream is compromised — a mutable image tag, an unverified download, or an unpinned reference — malicious code or content could be executed or fed to agents. Reference content is tightly pinned; the container base and toolchain downloads are not integrity-verified.

Crosses: (TB5) supply chain↔executed artifacts
Actor(s): (TA4) compromised upstream dependency / base image / reference repo

Assets Impacted:
- (A5) Operator host and filesystem
- (A8) Generated artifacts and findings integrity

**Technical detail:** Anchors: `packages/modal/Dockerfile` (`FROM ubuntu:24.04`, curl downloads of Node/Foundry/Recon without checksum); `packages/modal/src/pinned-source.ts` (submodule hydration, `GITHUB_HTTPS_SUBMODULE_CONFIG`); `packages/references/src/index.ts` (SHA-pinned fetch, sha256/size verification); dashboard `references-update --latest`. Mechanism: at `a634d948`, references are SHA-pinned and verified and submodule content is sealed, but the base image is a mutable tag, toolchain tarballs are unverified, and submodule protocol lockdown relies on git defaults. Provenance: observed at `a634d948`. Verification: read the Dockerfile and `pinned-source.ts`.

## (T8) Public publication integrity

**Plain-language:** The public benchmark numbers could in principle be manipulated by a malicious target trying to look good, or by an untrusted contributor. In practice the publication pipeline only accepts results from a trusted producer run on the main branch, allowlists exactly which files are published, re-scrubs them for secrets, and requires the report to match a canonical projection.

Crosses: (TB6) publication boundary
Actor(s): (TA1) malicious target author, (TA7) fork-PR author

Assets Impacted:
- (A9) Published eval-history / benchmark integrity

**Technical detail:** Anchors: `scripts/ci/qualify-modal-benchmark-publication.mjs`, `scripts/ci/classify-modal-benchmark-publication.mjs`, `packages/modal/src/public-bundle.ts` (`parsePublicBenchmarkBundle`, `isAllowedBundlePath`), `scripts/ci/publish-eval-history-cas.mjs` (`HISTORY_PATHS`, `stageExactPublication`). Mechanism: at `a634d948`, publication requires a same-repo default-branch successful producer, an allowlisted path set, secret scrubbing, and canonical-report equality; a malicious target can influence only its own numeric findings, subject to an independent judge and ground truth. Provenance: observed at `a634d948`. Verification: read the qualify/classify scripts and `public-bundle.ts`.

## (T9) Resource / cost exhaustion

**Plain-language:** A very large or cyclic execution graph, an oversized test suite, an expensive dashboard request, or a runaway agent could consume excessive compute or model spend. Ultrafuzz bounds most of these, but the cost of a legitimately expensive run is inherent to the tool.

Crosses: (TB2) controller↔agent, (TB3) local↔dashboard
Actor(s): (TA1) malicious target, (TA2) malicious contributor, (TA3) local process

Assets Impacted:
- (A5) Operator host and filesystem (compute/cost)

**Technical detail:** Anchors: `packages/topology/src/types.ts` (`MAX_TOPOLOGY_NODES=4096`, `MAX_LOOPS=256`); suite enumeration depth bound (#218); `packages/dashboard/src/index.ts` (`MAX_REQUEST_BODY_BYTES`, `MAX_COMMAND_JOBS`); `ultrafuzz.toml` (`workflow_deadline_seconds`, `max_parallel_*`); Modal sandbox lifetime bounds (#422). Mechanism: at `a634d948`, graph/suite/body/job sizes and run lifetime are bounded; the residual is intended cost. Provenance: observed at `a634d948`. Verification: read the topology caps and dashboard constants.

## (T10) CI fork-PR secret exposure

**Plain-language:** Ultrafuzz's own CI holds real cloud and provider secrets to run benchmarks. A classic mistake would be to expose those secrets to a pull request from an untrusted fork. Ultrafuzz avoids this: the secret-bearing workflow never runs on fork pull requests, secrets are only wired on manual dispatch or main-branch pushes, and there is no `pull_request_target`.

Crosses: (TB6) publication / CI boundary
Actor(s): (TA7) malicious fork-PR author

Assets Impacted:
- (A1) Model provider API keys
- (A2) Modal cloud tokens
- (A4) Braintrust / publisher keys

**Technical detail:** Anchors: `.github/workflows/eval-benchmarks.yml` (`on: push:[main] + workflow_dispatch`; provider keys gated on `github.event_name == 'workflow_dispatch'`), `ci.yml` (`permissions: contents: read`). Mechanism: at `a634d948`, fork PRs receive no provider/Modal secrets and cannot become a publication producer; no workflow uses `pull_request_target`. Provenance: observed at `a634d948`. Verification: read the workflow `on:`/`permissions:` blocks and secret expressions.

# Countermeasures

A countermeasure is marked Applied only where concrete code evidence was found. Statuses are the ARI effectiveness anchors.

| **ID** | **Title** | **Threats Mitigated** | **Status** |
| --- | --- | --- | --- |
| C1 | Human prompt review before launch | • (T1)<br>• (T2) | ⚠️ Partial |
| C2 | Explicit artifact materialization (selected copies, confirmation, patch rejection, sensitive-destination block) | • (T3)<br>• (T5) | ✅ Applied |
| C3 | Production-source fail-closed workspace handoff | • (T2)<br>• (T5) | ✅ Applied |
| C4 | Canonical path policy + symlink/TOCTOU hardening | • (T5) | ✅ Applied |
| C5 | Two-layer agent env allowlist + controller-capability withholding | • (T1) | ✅ Applied |
| C6 | Secret redaction (logs/events/diagnostics) | • (T3) | ⚠️ Partial |
| C7 | Dashboard loopback bind + CSRF/DNS-rebind checks + session token + CSP + body limits | • (T6) | ✅ Applied |
| C8 | Strict versioned JSON contracts + prototype-safe strict parser | • (T3)<br>• (T9) | ✅ Applied |
| C9 | SHA-pinned references + sealed content-addressed controls + offline submodule hydration | • (T2)<br>• (T7) | ✅ Applied |
| C10 | Least-privilege CI + producer gate + publication path allowlist + secret scrub + scoped short-lived publisher token | • (T8)<br>• (T10) | ✅ Applied |
| C11 | Non-root pinned container + Modal Secrets at runtime + TTL-scoped judge credential | • (T7) | ⚠️ Partial |
| C12 | Resource bounds (topology caps, suite depth-bound, sandbox lifetime, dashboard job/body caps, deadlines) | • (T9) | ✅ Applied |
| C13 | Sandbox network egress allowlist / hold active credential outside agent env | • (T1) | ⬜ Not Applied |
| C14 | Third-party data-handling policy / DPA / local-model or OpenRouter allowlist | • (T4) | ⬜ Not Applied |
| C15 | Explicit git protocol lockdown for untrusted submodule hydration | • (T7) | ⬜ Not Applied |

## (C1) Human prompt review before launch

**Status**: ⚠️ Partial · e = 50% — reviews the checked-in prompts, but cannot catch adversarial instructions the agent reads from the target repo or upstream artifacts during the run.

**Plain-language:** Ultrafuzz requires the operator to review prompts before a campaign starts, so obviously-malicious static prompts can be caught. It does not, and cannot, review the untrusted content an agent encounters while running (target source, READMEs, reference material), which is where indirect injection actually enters.

**Technical detail:** Anchors: `ultrafuzz.toml` `[permissions] prompt_review_required = true`; enforcement in `packages/runtime/src/validate.ts`. Mechanism: at `a634d948`, launch requires acknowledgement of prompt review; it is a process gate, not a runtime content filter. Provenance: observed at `a634d948`. Verification: grep `prompt_review_required`.

Threats Mitigated:
- (T1) Credentialed execution over untrusted code
- (T2) Malicious committed prompt/topology

## (C2) Explicit artifact materialization

**Status**: ✅ Applied

**Plain-language:** Nothing an agent generates is copied back into the operator's repository automatically. Copying requires explicitly selected files and an explicit confirmation, patch application is rejected outright, copies land as ordinary unstaged changes, and destinations that look like secret files (dotenv, keys, `secrets/`, `.ssh`, `.aws`) or product/git surfaces are refused.

**Technical detail:** Anchors: `packages/security/src/materialize-policy.ts` (`validateMaterializePolicy`, `isSensitiveMaterializeDestination`, `SENSITIVE_MATERIALIZE_ROOTS`). Mechanism: at `a634d948`, materialization requires `confirmed`, rejects patches, restricts sources to run-output roots, and blocks sensitive/product/git destinations. Provenance: observed at `a634d948`. Verification: read `materialize-policy.ts`.

Threats Mitigated:
- (T3) Secret leakage via artifacts
- (T5) File-write boundary escape

## (C3) Production-source fail-closed workspace handoff

**Status**: ✅ Applied

**Plain-language:** Ultrafuzz refuses to accept any agent change that touches the target's production-source directories, and it detects such a change by comparing against a trusted baseline rather than trusting the agent. If it sees one, the handoff fails.

**Technical detail:** Anchors: `packages/runtime/src/workspace-handoff.ts` (`captureWorkspacePatch`, `assertProductionSourcePreserved`, `applyWorkspacePatch`, `normalizeProductionSourceRoots`). Mechanism: at `a634d948`, changed files are computed from a git-tree diff in a temporary index and any change inside `src`/`contracts` throws; symlink/gitlink modes are rejected and the consuming side re-verifies the protected-roots manifest and the excluded-file set. Provenance: observed at `a634d948`. Verification: read the handoff module. Note: matching is case-sensitive (see L-03).

Threats Mitigated:
- (T2) Malicious committed prompt/topology
- (T5) File-write boundary escape

## (C4) Canonical path policy + symlink/TOCTOU hardening

**Status**: ✅ Applied

**Plain-language:** Every path the product handles must be a plain, relative, non-traversing name, and file reads/writes verify they stay inside the intended directory and are not being redirected through symlinks or swapped files mid-operation.

**Technical detail:** Anchors: `packages/security/src/path-policy.ts` (`resolvePathInside`, `validateSafeRelativePath`); `packages/artifacts/src/{workspace-patch.ts,safe-paths.ts}` (`normalizeWorkspacePatchPath`, `assertNoSymlinkComponents`, `readSinglyLinkedRegularFileSnapshotInside`). Mechanism: at `a634d948`, paths use a strict segment grammar, `realpath` containment checks, `O_NOFOLLOW`, and nlink/dev/ino/mtime stability across reads. Provenance: observed at `a634d948`. Verification: read the path modules.

Threats Mitigated:
- (T5) File-write boundary escape

## (C5) Two-layer agent env allowlist + controller-capability withholding

**Status**: ✅ Applied · e = 80% — strips sibling secrets and controller capabilities, but by necessity leaves the active provider key reachable by the agent.

**Plain-language:** When Ultrafuzz starts an agent, it does not hand over the whole environment. It forwards only a curated set (essentials, the active run's provider key, framework variables) and strips the control-plane pointers that would let an agent impersonate the controller. It cannot remove the one key the agent needs to call its model.

**Technical detail:** Anchors: `packages/runtime/src/smithers.ts` (`smithersCommandEnv`), `packages/runtime/src/start-run.ts` (`agentEnvironmentVariableNames`), `packages/runtime/src/templates/smithers/agents/environment.tsx` (`workflowControlChildEnvironment`); sealed controls (#165, #413). Mechanism: at `a634d948`, the Smithers boundary is a positive allowlist, only active-agent keys are forwarded, and controller-only vars/execution-root pointers are blanked before the model subprocess. Provenance: observed at `a634d948`. Verification: read `smithersCommandEnv` and `environment.tsx`.

Threats Mitigated:
- (T1) Credentialed execution over untrusted code

## (C6) Secret redaction

**Status**: ⚠️ Partial · e = 50% — covers logs/events/diagnostics with a pattern set that omits persisted artifact bodies and blockchain-key/mnemonic formats.

**Plain-language:** Ultrafuzz scrubs recognizable secrets from its logs, event stream, error messages, and config diagnostics. It does not scrub the agent's primary saved outputs, and its pattern list does not recognize a raw blockchain private key or a wallet seed phrase — the secrets a smart-contract agent is most likely to touch.

**Technical detail:** Anchors: `packages/security/src/sensitive-redaction.ts` (`SECRET_PATTERNS`, `redactSecretsInText`, `redactSecretsInValue`); applied in `packages/runtime/src/smithers.ts`, `packages/artifacts/src/{events.ts,state.ts}`, `packages/config/src/redaction.ts`; not applied in the artifact-write paths. Mechanism: at `a634d948`, redaction is a logging/eventing control; `report.md`/`findings.json`/tests are persisted verbatim, and no `0x`-64-hex or BIP-39 rule exists. Provenance: observed at `a634d948`. Verification: read the module and grep artifact writers for `redactSecrets`.

Threats Mitigated:
- (T3) Secret leakage via artifacts

## (C7) Dashboard loopback + CSRF/DNS-rebind + session token + CSP + body limits

**Status**: ✅ Applied

**Plain-language:** The local dashboard is locked to the loopback interface, rejects requests whose Host/Origin are not loopback or that browsers mark cross-site, requires a per-session random token for any change, sends a strict content-security policy and anti-framing headers, and caps request bodies. Together these defeat malicious-website and DNS-rebinding attacks against it.

**Technical detail:** Anchors: `packages/dashboard/src/index.ts` (`validateLoopbackHost`, `requireLocalRequest`, `requireMutation`, `constantTimeEqual`, `SECURITY_HEADERS`, `readBodyObject`). Mechanism: at `a634d948`, loopback bind is enforced; Host/Origin/`sec-fetch-site` are checked; mutations require a constant-time-compared token; CSP is `default-src 'none'` with `script-src 'self'`; bodies cap at 1 MiB via both Content-Length and streamed counting. Provenance: observed at `a634d948`. Verification: read the helpers and `applySecurityHeaders`.

Threats Mitigated:
- (T6) Dashboard CSRF / DNS-rebind / local-process drive

## (C8) Strict versioned JSON contracts + prototype-safe parser

**Status**: ✅ Applied

**Plain-language:** All data exchanged between the controller and agents uses closed, versioned schemas; invalid output fails the run rather than being repaired, and the parser is hardened against depth/size abuse and prototype-pollution tricks.

**Technical detail:** Anchors: `packages/artifacts/src/strict-json.ts` (`parseStrictJson`, `Object.defineProperty` assignment, `maxBytes/maxDepth/maxItems/maxProperties`, duplicate-key rejection); closed contracts (#439). Mechanism: at `a634d948`, `__proto__` becomes an own data property (no prototype pollution), and agent artifacts additionally pass zod + JSON-schema validation before feeding control flow. Provenance: observed at `a634d948`. Verification: read `strict-json.ts`.

Threats Mitigated:
- (T3) Secret leakage via artifacts (bounds injected content)
- (T9) Resource / cost exhaustion

## (C9) SHA-pinned references + sealed controls + offline submodule hydration

**Status**: ✅ Applied

**Plain-language:** Third-party reference material is fetched only from GitHub at exact pinned commits, verified by content hash and size, and workflow controls and pinned target sources are sealed to their exact committed bytes with network configuration removed. This tightly bounds what external content can enter a run.

**Technical detail:** Anchors: `packages/references/src/index.ts` (`fetchReference`, `cachedReferenceOk`, `isFullSha`, github-only `execFileSync`); sealed controls and offline submodule hydration (#165, #413, #458, #469, #492). Mechanism: at `a634d948`, references require 40-hex commits, constrained owner/repo, traversal-blocked paths, and sha256/size verification; submodules hydrate offline without retained remotes. Provenance: observed at `a634d948`. Verification: read `references/src/index.ts` and `packages/modal/src/pinned-source.ts`.

Threats Mitigated:
- (T2) Malicious committed prompt/topology
- (T7) Supply-chain compromise

## (C10) Least-privilege CI + publication gate + scoped token

**Status**: ✅ Applied

**Plain-language:** Ultrafuzz's CI grants read-only repository permission by default, never exposes secrets to fork pull requests, only publishes results from a trusted main-branch producer through a fixed file allowlist after re-scrubbing for secrets, and pushes with a single-repo token that is created for the job and revoked afterward.

**Technical detail:** Anchors: `.github/workflows/{ci,eval-benchmarks,eval-history-publication}.yml`; `scripts/ci/{qualify,classify}-modal-benchmark-publication.mjs`; `scripts/ci/publish-eval-history-cas.mjs` (`HISTORY_PATHS`, `stageExactPublication`); `packages/modal/src/public-bundle.ts`. Mechanism: at `a634d948`, `permissions: contents: read`; no `pull_request_target`; provider/Modal secrets gated to dispatch/push-main; publication requires same-repo default-branch producer, path allowlist, secret scrub, and canonical-report equality; publisher token is scoped and auto-revoked. Provenance: observed at `a634d948`. Verification: read the workflow `on:`/`permissions:` blocks and the publication scripts.

Threats Mitigated:
- (T8) Public publication integrity
- (T10) CI fork-PR secret exposure

## (C11) Non-root pinned container + Modal Secrets + TTL-scoped judge credential

**Status**: ⚠️ Partial · e = 50% — non-root and version-pinned, but the base image is a mutable tag and toolchain downloads lack integrity verification.

**Plain-language:** The cloud image runs as a non-root user, bakes in no secrets, pins tool versions, and injects credentials only at runtime, with the scoring credential reduced to a short-lived token. It does not verify the integrity of its base image or downloaded toolchains, so an upstream compromise could taint it.

**Technical detail:** Anchors: `packages/modal/Dockerfile` (`USER ubuntu`, version pins, curl downloads without checksum, `FROM ubuntu:24.04`); `packages/modal/src/{runner.ts,worker.ts}` (`secrets.fromObject`, `ephemeralJudgeCredential`). Mechanism: at `a634d948`, no credentials/source are COPYed in and the judge key is TTL-scoped, but base and tarballs are not digest/checksum-pinned. Provenance: observed at `a634d948`. Verification: read the Dockerfile and runner secret staging.

Threats Mitigated:
- (T7) Supply-chain compromise

## (C12) Resource bounds

**Status**: ✅ Applied · e = 80% — bounds graph/suite/body/job sizes and run lifetime; cannot bound the cost of an intentionally expensive legitimate run.

**Plain-language:** Execution graphs, test-suite enumeration, request bodies, concurrent jobs, sandbox lifetimes, and overall run deadlines are all capped, so a malformed or oversized input fails closed before consuming unbounded resources.

**Technical detail:** Anchors: `packages/topology/src/types.ts` (`MAX_TOPOLOGY_NODES`, `MAX_LOOPS`), suite depth bound (#218), `packages/dashboard/src/index.ts` (`MAX_REQUEST_BODY_BYTES`, `MAX_COMMAND_JOBS`), `ultrafuzz.toml` deadlines/concurrency, sandbox lifetime bounds (#422). Mechanism: at `a634d948`, size and lifetime caps are enforced pre-expansion. Provenance: observed at `a634d948`. Verification: read the topology caps and dashboard constants.

Threats Mitigated:
- (T9) Resource / cost exhaustion

## (C13) Sandbox network egress allowlist / hold credential outside agent env

**Status**: ⬜ Not Applied

**Plain-language:** The single most effective missing control: restrict the agent sandbox's outbound network to only the hosts it needs (model, judge, git), and, where possible, keep the active provider credential out of the agent's reach by injecting authentication from a separate process. This would turn credential exfiltration from a one-request action into a blocked one. `docs/security.md` records this as an accepted risk today.

**Technical detail:** Anchors: `packages/modal/src/defaults.ts` (`MODAL_BENCHMARK_SANDBOX_RESOURCES` — no `block_network`/CIDR); `docs/security.md` (egress allowlist listed as an accepted risk). Mechanism: at `a634d948`, no egress restriction exists on either the local or Modal execution path. Provenance: observed at `a634d948`. Verification: grep `packages/modal` for network-policy usage; read `docs/security.md`.

Threats Mitigated:
- (T1) Credentialed execution over untrusted code

Reference:
- Modal network-policy / egress controls documentation.

## (C14) Third-party data-handling policy / local-model or OpenRouter allowlist

**Status**: ⬜ Not Applied

**Plain-language:** There is no in-product control governing that target code is sent to external providers — no documented data-processing basis, no option to require a local/self-hosted model for confidential work, and no allowlist limiting which OpenRouter models code can be routed to. Adding these would let operators run confidential audits without their code leaving controlled infrastructure.

**Technical detail:** Anchors: `packages/config/src/model-profiles.ts` (`OPENROUTER_MODEL_ID_PATTERN`, no allowlist); absence of a local-model-only or data-policy gate in `packages/config`. Mechanism: at `a634d948`, model selection has no confidentiality-oriented control. Provenance: observed at `a634d948`. Verification: read `model-profiles.ts`; confirm no data-handling policy surface in config.

Threats Mitigated:
- (T4) Target-code confidentiality to third parties

## (C15) Explicit git protocol lockdown for untrusted submodule hydration

**Status**: ⬜ Not Applied

**Plain-language:** When Ultrafuzz initializes submodules from an untrusted target's configuration, it should explicitly forbid dangerous git transports (local-file and command-execution transports) rather than relying on git's default behavior.

**Technical detail:** Anchors: `packages/modal/src/pinned-source.ts` (`materializePinnedSource`, `GITHUB_HTTPS_SUBMODULE_CONFIG`). Mechanism: at `a634d948`, submodule hydration rewrites GitHub SSH URLs to HTTPS but does not set `protocol.ext.allow=never`/`protocol.file.allow=never`, relying on git defaults. Provenance: observed at `a634d948`. Verification: read `pinned-source.ts` and grep for `protocol.*.allow`/`GIT_ALLOW_PROTOCOL`.

Threats Mitigated:
- (T7) Supply-chain compromise

# Appendix: STRIDE and LINDDUN Brainstorming

These analyses are brainstorming scaffolding, not the deliverable. Every bullet carries a disposition tag.

## Top-Level STRIDE Analysis

- **Spoofing**
    - A malicious website tries to pose as the operator to the loopback dashboard (CSRF/DNS-rebind). `[→ T6]`
    - A hijacked agent tries to impersonate the controller via leaked control-plane env pointers. `[→ T1]` (mitigated by C5)
- **Tampering**
    - Agent alters the target's production source (`src`/`contracts`). `[→ T5]`
    - Malicious committed prompt/topology/references steer agent output. `[→ T2]`
    - Manipulated benchmark output attempts to skew published metrics. `[→ T8]`
- **Repudiation**
    - Run state, event journal, and attempt ledger record actions durably with redacted diagnostics; no significant repudiation gap observed for a single-operator local tool. `[N/A — durable append-only run journals; single trusted operator]`
- **Information Disclosure**
    - Provider keys / OAuth tokens exfiltrated by a hijacked agent over open egress. `[→ T1]`
    - Secrets persisted in un-redacted artifacts (esp. blockchain keys/mnemonics). `[→ T3]`
    - Target source disclosed to third-party model providers. `[→ T4]`
    - Full config readable over the token-free dashboard read endpoint. `[→ T6]`
- **Denial of Service**
    - Oversized/cyclic topology or suite; expensive dashboard endpoints; runaway spend. `[→ T9]`
- **Elevation of Privilege**
    - Untrusted code → operator-level local execution via skip-permissions. `[→ T1]`
    - Supply-chain compromise → code execution in the build/run image. `[→ T7]`
    - Co-resident local process reads the dashboard token and launches runs. `[→ T6]`

## Top-Level LINDDUN Analysis

Ultrafuzz processes source code and operator credentials, not end-user personal data, so most LINDDUN categories resolve to N/A; the material privacy/confidentiality concern is third-party transmission of potentially confidential code.

- **Linkability**
    - No end-user identities are processed; benchmark cohorts key on models/targets, not people. `[N/A — no personal data subjects]`
- **Identifiability**
    - Published eval history contains model/target metadata, not personal data. `[N/A — no PII published]`
- **Non-repudiation (Privacy Context)**
    - No user actions are logged that would harm an individual's privacy. `[N/A — no end users]`
- **Detectability**
    - Public eval history reveals which targets were benchmarked, which is intended disclosure. `[N/A — intended public benchmark]`
- **Disclosure of Information (Privacy Context)**
    - Confidential/client source code transmitted to external model providers without a documented basis. `[→ T4]`
- **Unawareness**
    - Operators may not realize target code leaves their control or that literal secrets in config are readable locally; needs an explicit data-handling notice. `[→ OQ1]`
- **Non-compliance**
    - Transmitting client code to sub-processors may breach NDAs/DPAs depending on the engagement and jurisdiction. `[→ T4]` (intangible A13; jurisdiction unresolved → `[→ OQ1]`)

# Maintenance Guidance for Future Agents

This document is intended to be refreshed iteratively. Before substantive edits: (1) re-anchor the Codebase Snapshot to the then-current commit and date; (2) re-compute the ARI and record the delta with its `Δ_scope / Δ_controls` decomposition; (3) re-rank the backlog from updated residual masses; (4) re-check trust boundaries and actors as new integrations land (a new model provider, a new dashboard endpoint, or a hosted deployment would add boundaries/actors); (5) re-tag every STRIDE/LINDDUN bullet; (6) add `(New — Month Year)` markers and strike through (never delete) retired entries; (7) evaluate any redesign's ARI impact (a sandbox egress allowlist would be the headline change); (8) run Cross-Reference Validation; (9) bump the doc version; (10) re-verify Technical-detail anchors against the new snapshot (several are in generated-template `.tsx` files that materialize into gitignored `.smithers/agents/*` — re-find by symbol); (11) refresh the Coverage & Unknowns map. Watch especially for a hosted/multi-tenant deployment of the dashboard (would invalidate the local-trust assumption behind T6) and for any change that binds the dashboard off-loopback.

# Open Questions for the Team

1. What is the intended data-handling basis for transmitting target/client source to third-party model providers (retention, no-train guarantees, DPAs), and which jurisdiction/contract regime applies? This determines the true severity of T4/A13 and cannot be derived from code.
2. Is the accepted no-sandbox model (no egress/command allowlist) a permanent product stance, or is a hardened/sandboxed execution mode planned for confidential engagements? This gates whether C13 should be treated as a roadmap item.
3. Are operators ever expected to run the dashboard anywhere other than a single trusted host? Any non-loopback or shared-host use would materially change T6.
4. Is there an operational key-rotation and incident-response procedure for the provider/Modal/OAuth credentials that a hijacked agent (T1) could exfiltrate?

## Coverage & Unknowns

- **Examined (at `a634d948`):** the security package (path/materialize/redaction policy); the dashboard HTTP server end-to-end; the agent-adapter templates and env-construction (`smithers.ts`, `start-run.ts`, `environment.tsx`); the workspace-handoff and path-safety machinery; the config/prompt/topology/references loading and validation; the Modal package (Dockerfile, runner/worker/auth/pinned-source, public-bundle) and the CI workflows and publication scripts; the strict-JSON parser; and a repo-wide committed-secret scan (only test fixtures with synthetic values found).
- **Not examined:** the full contents of the local run-state store (`smithers.db`) and its schema; the `evals`/`evmbench` scoring internals beyond publication gating; the complete `pnpm-lock.yaml` transitive dependency set (npm supply-chain depth); the generated `.smithers/agents/*` files on a live install (gitignored — analyzed via their source templates instead); the frontend build/bundling pipeline in depth; runtime behavior of the Modal platform's own isolation guarantees.
- **Could not verify from code alone:** the model providers' actual data retention/training policies (T4); whether an egress restriction exists at the Modal-platform or network layer outside this repo (T1/C13 assessed on in-repo config, which shows none); operational credential rotation/incident practice (OQ4); the jurisdiction/contract regime for client code (T4/OQ1); and the exploitability (versus mere possibility) of indirect prompt injection against the specific agent CLIs, which depends on model behavior not present in this repository.

# Change Log

| **Date** | **Author / Trigger** | **ARI Δ** | **Summary of Changes** |
| --- | --- | --- | --- |
| August 2026 | Initial issuance (authorized defensive review, method-08) | — → 28.4 (Grade C) | Created model at commit `a634d948`. Enumerated A1–A13, TB1–TB7, TA1–TA7, T1–T10, C1–C15. Dominant residual: accepted no-sandbox execution (T1). ARI 28.4/100, Grade C, capped at C by T1 (gap 0.50). |

# Model and Methodology

- Skill: Threat Model Generation Skill v8
- ARI spec: v1.1 — https://github.com/kristovatlas/ari
- Model used: claude-opus-4-8 (actual runtime model for this run)
- Model degradation: Intended claude-fable-5 (effort max) but ran on claude-opus-4-8 because the provider refused the intended primary on cyber / offensive-security (security-tooling) content — the documented Fable auto-degradation — and the orchestrator advanced to the configured next-best retry agent (Opus 4.8), which is the acceptable next-most-capable model per the skill's model-selection rule.
- Generated / refreshed: August 2026
- Initial issuance: August 2026
