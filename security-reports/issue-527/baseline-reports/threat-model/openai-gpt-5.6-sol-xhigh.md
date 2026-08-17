---
skill: "threat-model"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Ultrafuzz Threat Model August 2026

Skill version: 8
Doc version: 1.0

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

Ultrafuzz is a command-line and local-dashboard product that orchestrates large-language-model agents to discover smart-contract properties, generate fuzz tests, triage findings, and produce reviewable reports. It can execute locally through Codex, Claude, Kimi, DeepSeek, or OpenRouter adapters, or place individual attempts in Modal cloud sandboxes. Its users are smart-contract developers, security engineers, and evaluation operators working with source code and often unpublished vulnerability information.

The product deliberately adopts a trusted local execution model. Agent commands are unattended, target content is treated as untrusted in the generated prompt, and deterministic controls concentrate on path safety, artifact contracts, provenance, reporting, and explicit materialization. This makes the deployment context decisive: running Ultrafuzz on an ordinary developer workstation has a materially different risk profile from running it inside a disposable, credential-minimized security environment.

## Details

Ultrafuzz is a Node.js and TypeScript monorepo distributed as a command-line interface. Configuration and topology are read from project-local files; prompts and references live under the product directory; workflow execution is delegated to Smithers; durable run state, journals, manifests, reports, and artifacts are stored locally. A React dashboard exposes a loopback-only HTTP and server-sent-events interface for viewing runs, editing prompts and topology, launching commands, and selecting materialization actions. There is no application account database or remote multi-user API in the reviewed source.

The principal attack surfaces are project configuration, editable prompt and topology files, arbitrary target repository content, pinned external references, unrestricted agent shell and file tools, model-provider requests, Modal project archives and secrets, local dashboard mutations, report and benchmark ZIP imports, dependency and GitHub Actions supply chains, evaluation reporters, and the materialization boundary back into a target checkout. Sensitive data may include developer credentials, private target source, unpublished findings, generated proofs of concept, provider tokens, cloud credentials, and private evaluation ground truth.

**Codebase snapshot used for this analysis.** This threat model was produced against commit `a634d948038f502e5e677477138dca0c763e2380` on branch `main` dated 2026-08-15. Future updates should re-anchor to the then-current commit hash and record the date of the refresh.

Source code: https://github.com/monad-developers/ultrafuzz
Working notes: None; this private workflow returned the model in-band and made no repository changes.

## Risk Index and Grading

This threat model uses the Aggregate Risk Index, spec v1.1 (https://github.com/kristovatlas/ari), applied via the Threat Model Generation Skill v8. ARI is a normalized 0–100 coverage index; **lower is safer**. The external specification was checked on 2026-08-15 and remained v1.1.

**Current score: ARI = 33.8 / 100, Grade D** (Risk Mass 16.57 / Risk Capacity 49). The numerical band is C, but the grade is capped at D because four High-severity threats have a coverage gap of at least 0.50: T2, T3, T4, and T6.

Breakdown:

- High threats contribute 13.45 residual mass: T2, T3, T4, and T6 contribute 2.50 each; T1 contributes 1.25; T9 and T10 contribute 1.00 each; T5 contributes 0.20.
- Medium threats contribute 3.12 residual mass: T8 and T11 contribute 1.50 each, while the layered dashboard controls leave T7 at 0.12.
- `ARI = 100 × 16.57 / 49 = 33.8`. No threat was treated as eliminated, and no Critical tier was needed.

The largest improvement comes from converting the repository-controlled credential boundary, provider-data governance, raw-artifact secret handling, and semantic signoff from partial to layered controls. Those four changes would also remove the current D-grade severity gate.

## Prioritized Remediation Backlog

| **Rank** | **Fix (Countermeasure)** | **Closes** | **Max Severity** | **Status** | **Residual Mass** | **ΔARI if Fixed** | **Effort** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | (C3) Make credentials and provider homes operator-owned | (T2) Configuration-driven credential or host-path abuse | High | ⚠️ Partial | 2.50 | about −4.1 | M · quick win |
| 2 | (C4) Add campaign-wide provider data policy and minimization | (T3) Provider or cloud disclosure | High | ⚠️ Partial | 2.50 | about −4.1 | L |
| 3 | (C5) Gate every canonical artifact for active and secret-like values | (T4) Secret persistence in raw artifacts | High | ⚠️ Partial | 2.50 | about −4.1 | M |
| 4 | (C8) Require digest-bound human semantic signoff | (T6) Schema-valid but wrong audit conclusions | High | ⚠️ Partial | 2.50 | about −4.1 | M |
| 5 | (C11, C17) Add whole-process isolation and spend controls | (T8) Local resource and cost exhaustion | Medium | ⚠️ Partial / ⬜ Not Applied | 1.50 | about −2.4 | L |
| 6 | (C18) Upgrade or replace the vulnerable ZIP parser | (T11) Crafted archive memory exhaustion | Medium | ⬜ Not Applied | 1.50 | about −2.4 with a second independent bound | S · quick win |
| 7 | (C17) Sandbox untrusted local agent execution | (T1) Prompt-driven host compromise | High | ⬜ Not Applied | 1.25 | about −2.0 | L |
| 8 | (C13) Enforce production dependency auditing | (T9) Supply-chain compromise | High | ⬜ Not Applied | 1.00 | about −1.6 | S · quick win |
| 9 | (C16) Require operator approval for private payload upload | (T10) Private evaluation disclosure | High | ⬜ Not Applied | 1.00 | about −1.6 | S · quick win |

The easiest high-value work is upgrading the archive parser, adding a production audit gate, and moving credential selectors behind operator-owned policy. Resolving T2, T3, T4, and T6 below a 0.50 gap clears the Grade D cap; bringing every High below 0.50 would leave the numerical Grade C.

## UI

Most operators use the command-line interface to initialize a project, validate configuration, synchronize references, start or resume runs, inspect state, render reports, and explicitly materialize selected outputs. The local dashboard provides the same core workflows through a browser and can edit configuration, topology, and prompts. It binds only to loopback, exposes a generated session token to its own frontend, requires that token for mutations, checks browser request context, and records edits in an audit journal. There is no remote end-user role model; the effective privileged role is the local operating-system user.

## Trust Boundaries

| **ID** | **Boundary** | **Direction of Trust** | **Notes** |
| --- | --- | --- | --- |
| TB1 | Target content and external references → orchestration instructions | Ultrafuzz expects agents to treat source, dependencies, prompts, references, and prior artifacts as data, but these inputs are attacker-influenceable | This is the main conversion point from untrusted content to an agent capable of action. |
| TB2 | Agent process ↔ developer host and worktree | The controller trusts agents to obey prompts; agents receive shell, filesystem, provider access, and selected environment values | Worktrees isolate Git state but are not an operating-system sandbox. |
| TB3 | Local controller ↔ model and cloud providers | Source, prompts, artifacts, credentials, and metadata cross to externally operated services | HTTPS and fixed origins protect transport but not provider-side use, retention, or compromise. |
| TB4 | Agent or imported artifact → verifier, report, and materializer | The product trusts schema, provenance, and digest gates before downstream consumption | Structural validity is not the same as semantic truth or secret safety. |
| TB5 | Browser or local process → privileged dashboard | Local clients can read run data and request project mutations and executions | Loopback, browser-context checks, and a session token are the main controls. |
| TB6 | Package, action, tool, and reference supply chain → executable product | Upstream bytes become code, prompts, schemas, or CI authority | Locks, commit pins, digests, and restricted install scripts reduce substitution risk. |
| TB7 | Private evaluation data → judges, reporters, and public benchmark publication | Private source and ground truth must remain separate from public results | Evaluation-specific controls are stronger than the ordinary campaign data boundary. |

Technical detail:

- **TB1 — Anchors:** `.ultrafuzz/topology.yml`, `.ultrafuzz/prompts/**`, `.ultrafuzz/references.yml`, and `packages/runtime/src/templates/smithers/workflows/workflow.tsx` — `untrustedContentBoundary`. **Provenance:** observed at `a634d948038f502e5e677477138dca0c763e2380`. **Verification:** inspect prompt construction and how target and reference artifacts reach each task.
- **TB2 — Anchors:** generated agent adapters under `packages/runtime/src/templates/smithers/agents/**`; `docs/security.md`. **Provenance:** observed at `a634d948038f502e5e677477138dca0c763e2380`. **Verification:** inspect command construction, permission modes, child environments, added directories, and network posture.
- **TB3/TB7 — Anchors:** `packages/modal/src/node-provider.ts`, `packages/evals/src/scoring.ts`, `packages/evals/src/node-telemetry.ts`, and `packages/evals/src/reporters/braintrust.ts`. **Provenance:** observed at `a634d948038f502e5e677477138dca0c763e2380`. **Verification:** trace project archives, secrets, judge requests, artifact upload policy, and publication bundles.
- **TB4/TB5/TB6 — Anchors:** `packages/runtime/src/templates/smithers/workflows/workflow.tsx`, `packages/runtime/src/materialize.ts`, `packages/dashboard/src/index.ts`, `pnpm-lock.yaml`, and `.github/workflows/**`. **Provenance:** observed at `a634d948038f502e5e677477138dca0c763e2380`. **Verification:** inspect artifact capture, materialization, dashboard request enforcement, dependency locks, and action references.

## Threat Actors

| **ID** | **Actor** | **Capability** | **Primary Boundary → Assets** |
| --- | --- | --- | --- |
| TA1 | Malicious target contributor | Can commit source, configuration, prompts, topology, test scripts, or project metadata that an operator later audits | TB1 → A1, A2, A3, A4, A5 |
| TA2 | Compromised or misdirected agent | Can issue permitted tool calls, write schema-valid output, invoke local commands, and use network access | TB2, TB4 → A1, A3, A4, A5 |
| TA3 | Compromised provider, cloud worker, or provider insider | Can observe data delivered to a provider or misuse provider-side execution and retention | TB3, TB7 → A1, A2, A4, A8 |
| TA4 | Malicious local browser context or process | Can attempt requests to the loopback dashboard and consume local resources | TB5 → A3, A4, A5 |
| TA5 | Compromised upstream maintainer or origin | Can publish malicious package, action, reference, model CLI, or dependency bytes | TB1, TB6 → A1, A3, A6, A7 |
| TA6 | Mistaken or malicious operator | Can approve risky configuration, upload, materialization, or publication choices | TB3, TB4, TB7 → A2, A3, A4, A6, A8 |
| TA7 | Crafted-bundle sender or benchmark producer | Can provide a malicious ZIP archive for offline statistics or analysis | TB4 → A5 |

## Proposed Changes and Redesigns

No proposed changes were supplied with this audit. The backlog describes recommended redesigns; projected point reductions assume the named new control is independent of the current partial or applied layer.

# Assets

Values reflect the plausible incident impact to an Ultrafuzz operator or maintainer, not the value of every target protocol Ultrafuzz may audit.

| **Identifier** | **Title** | **Value** |
| --- | --- | --- |
| A1 | Developer credentials and account authority | Critical |
| A2 | Private target source and unpublished findings | High |
| A3 | Target repository and generated-code integrity | High |
| A4 | Audit evidence, provenance, and conclusions | High |
| A5 | Host availability and provider spending budget | High |
| A6 | Release and benchmark-publication trust | High |
| A7 | Dependency, reference, and toolchain integrity | High |
| A8 | User trust and data-governance standing | Medium |

## (A1) Developer credentials and account authority

**Plain-language:** Agents execute in the operator's security context and may be near model, cloud, source-control, signing, or deployment credentials. Loss can authorize external writes, consume paid services, expose other projects, or compromise a developer identity. Because the blast radius may extend well beyond one audit, the value is **Critical**.

**Technical detail:**
- Anchors: agent configuration and child-environment construction; subscription homes; provider API-key environment settings.
- Mechanism: at `a634d948038f502e5e677477138dca0c763e2380`, active provider credentials and selected extra variables were available to workflow execution, while local agents were not separated from all same-user host files.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect `packages/runtime/src/start-run.ts`, the generated agent adapters, and `packages/modal/src/auth.ts` without printing credential values.

## (A2) Private target source and unpublished findings

**Plain-language:** Audit targets may be proprietary contracts, unreleased protocol designs, or code whose vulnerabilities have not been disclosed. Premature disclosure can create exploit opportunity, contractual liability, and loss of customer confidence. The value is **High**.

**Technical detail:**
- Anchors: task worktrees, prompt context, run artifacts, Modal project archives, eval target sensitivity.
- Mechanism: at the snapshot, model agents and cloud workers could read target source and generated evidence as required by the audit workflow.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: trace task input assembly and cloud archive creation; inspect which reporter modes include payload bytes.

## (A3) Target repository and generated-code integrity

**Plain-language:** Ultrafuzz deliberately produces tests and may prepare workspace changes. Unauthorized changes can weaken production code, poison later testing, or be published under the operator's identity. The value is **High**.

**Technical detail:**
- Anchors: task worktrees, workspace patch manifests, production-source-root policy, materialization copy selections.
- Mechanism: at the snapshot, agent changes occurred in generated worktrees and explicit copies could cross back into the project after confirmation; direct external Git actions remained prompt-governed.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect workspace handoff and materialization code, then grep task prompts for repository-mutation restrictions.

## (A4) Audit evidence, provenance, and conclusions

**Plain-language:** Users rely on findings, reproduction evidence, source pins, and final reports to decide whether a contract is safe. Tampered, stale, fabricated, or omitted evidence can create false assurance or waste remediation effort. The value is **High**.

**Technical detail:**
- Anchors: artifact contracts, attempt ledgers, source proofs, final-report projection, graph fingerprints, verification markers.
- Mechanism: at the snapshot, extensive schema and semantic gates authenticated structure and lineage, but the security meaning of free-form model conclusions remained judgment-dependent.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect artifact finalization, semantic joins, final-report canonicalization, and the reviewer workflow.

## (A5) Host availability and provider spending budget

**Plain-language:** Campaigns can run many expensive agents and fuzzers for long periods. Resource exhaustion can interrupt other work, make a workstation unusable, or incur unexpected model and cloud charges. The value is **High** for production-scale operators.

**Technical detail:**
- Anchors: concurrency, timeout, retry, workflow deadline, Forge guard, Modal resource settings, ZIP analysis commands.
- Mechanism: at the snapshot, normal tasks were bounded at the scheduler and Forge levels, while general local child processes were not placed in product-managed operating-system resource containers.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect runtime budget construction, process termination behavior, and archive parser allocation paths.

## (A6) Release and benchmark-publication trust

**Plain-language:** Users need confidence that released code and published benchmark results came from the claimed commit and passed the intended gates. Compromise could distribute unsafe orchestration code or misrepresent model quality. The value is **High**.

**Technical detail:**
- Anchors: GitHub Actions workflows, release validation, immutable benchmark plans, publication qualification, narrow publisher token.
- Mechanism: at the snapshot, actions were commit-pinned and publication tooling revalidated candidate identity and artifact generation before a narrowly scoped write.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect `.github/workflows/**` and the benchmark publication scripts.

## (A7) Dependency, reference, and toolchain integrity

**Plain-language:** Ultrafuzz installs and executes a large package graph, model command-line tools, a workflow engine, fuzzers, and external reference material. A compromised component inherits powerful execution or can poison model context. The value is **High**.

**Technical detail:**
- Anchors: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, package manifests, reference cache manifests, schema bundle digests, trusted launcher preflight.
- Mechanism: at the snapshot, packages and references were pinned and verified in several places, but trusted upstream code still executed with the authority required by the product.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect lock resolutions, allowed build scripts, reference fetch and digest checks, and workflow dependency snapshots.

## (A8) User trust and data-governance standing

**Plain-language:** Users expect private code, findings, and credentials to be sent only to approved processors and retained appropriately. Undisclosed provider transfer or secret persistence can damage trust and create contractual or regulatory exposure. The value is **Medium** because applicable data and legal regimes depend on each target.

# Threats

Threats use conservative likelihood and impact judgments grounded in the reviewed product. Every threat names the boundary crossed and capable actors.

| **ID** | **Description** | **Boundary · Actor(s)** | **Assets at Risk** | **Likelihood** | **Impact** | **Severity** |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Target content drives an unrestricted agent into host compromise or external action | TB1 · TA1, TA2, TA5 | A1, A2, A3, A5, A8 | High | High | High |
| T2 | Project configuration selects unrelated credentials or unsafe provider homes | TB1, TB2 · TA1, TA6 | A1, A3, A5 | Medium | High | High |
| T3 | Model or cloud providers disclose or retain private campaign data | TB3 · TA3, TA6 | A1, A2, A4, A8 | High | High | High |
| T4 | Secret-bearing agent output persists in raw run artifacts | TB4 · TA1, TA2 | A1, A2, A4, A8 | Medium | High | High |
| T5 | Mutable handoffs or artifacts alter downstream or materialized bytes | TB4 · TA2, TA6 | A3, A4 | Medium | High | High |
| T6 | Schema-valid but incorrect audit conclusions create false assurance | TB4 · TA2, TA6 | A2, A4, A6, A8 | High | High | High |
| T7 | A local requester abuses the dashboard's privileged mutation API | TB5 · TA4 | A3, A4, A5 | Low | High | Medium |
| T8 | Agent commands exhaust local resources or paid-provider budgets | TB2 · TA1, TA2 | A1, A5 | High | Medium | Medium |
| T9 | Compromised dependencies, actions, tools, or references subvert execution | TB6 · TA5 | A1, A3, A6, A7 | Medium | High | High |
| T10 | Private evaluation data reaches judges, reporters, or public output improperly | TB7 · TA3, TA6 | A2, A4, A6, A8 | Medium | High | High |
| T11 | A crafted ZIP archive triggers memory exhaustion before limits protect the process | TB4 · TA7 | A5 | Medium | Medium | Medium |

## (T1) Prompt-driven host compromise or external action

**Plain-language:** A malicious target contributor or compromised reference can place persuasive instructions in files an agent must inspect. If an agent follows those instructions, it can read host data, alter repositories, contact external services, or spend provider credentials under the operator's identity. The product warns the agent not to do this, but intentionally treats local execution as trusted.

Crosses: (TB1) Target content and external references → orchestration instructions
Actor(s): (TA1) Malicious target contributor; (TA2) Compromised or misdirected agent; (TA5) Compromised upstream maintainer or origin

Assets Impacted: A1, A2, A3, A5, A8

**Technical detail:**
- Anchors: `docs/security.md`; `packages/runtime/src/templates/smithers/workflows/workflow.tsx` — `untrustedContentBoundary`; generated Claude and DeepSeek factories; editable prompt and reference surfaces.
- Mechanism: at `a634d948038f502e5e677477138dca0c763e2380`, the workflow prepended an untrusted-data instruction, while the product documented no deterministic command, egress, or external repository-write policy and selected bypassed permission checks for some adapters.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect effective agent commands and run a disposable canary test that attempts denied host, network, and Git operations without exposing real credentials.

## (T2) Configuration-driven credential or host-path abuse

**Plain-language:** A malicious project can name an unrelated host environment value as the credential for an enabled model adapter or choose a provider home outside the project. If the operator launches that profile, an unrelated secret may be sent to a provider as authentication or host configuration may be replaced.

Crosses: (TB1) Target content and external references → orchestration instructions; (TB2) Agent process ↔ developer host and worktree
Actor(s): (TA1) Malicious target contributor; (TA6) Mistaken or malicious operator

Assets Impacted: A1, A3, A5

**Technical detail:**
- Anchors: `packages/config/src/agents.ts` — agent schemas; `packages/runtime/src/start-run.ts` — environment-name collection; generated adapter `requiredEnv` helpers; `packages/runtime/src/templates/smithers/agents/openrouter.tsx` — provider-home materialization.
- Mechanism: at the snapshot, credential names were constrained by syntax and controller-only exclusions rather than provider-specific or operator-owned allowlists; provider configuration paths accepted non-empty absolute paths, and the OpenRouter adapter replaced its configuration file in the resolved directory.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: test malicious credential names and absolute or symlinked configuration roots in a disposable environment and confirm no host value or file leaves the approved root.

## (T3) Provider or cloud disclosure

**Plain-language:** Ordinary campaigns may send source, prompts, findings, metadata, and credentials to externally operated model or cloud services. A provider compromise, insider, retention practice, or mistaken provider choice can expose private audit material even when transport security works correctly.

Crosses: (TB3) Local controller ↔ model and cloud providers
Actor(s): (TA3) Compromised provider, cloud worker, or provider insider; (TA6) Mistaken or malicious operator

Assets Impacted: A1, A2, A4, A8

**Technical detail:**
- Anchors: generated model adapters; cloud `<Sandbox>` construction in the workflow template; `packages/modal/src/node-provider.ts`; evaluation sensitivity controls.
- Mechanism: at the snapshot, cloud tasks allowed network access, transferred a project archive, and injected selected secrets; general campaigns had no target-sensitivity or processor-retention contract comparable to the evaluation-specific privacy controls.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: enumerate bytes and metadata sent to every provider for local and cloud modes; compare with operator approvals and provider retention settings.

## (T4) Secret persistence in raw artifacts

**Plain-language:** An agent can copy a credential, private path, or sensitive source fragment into a finding, evidence field, Markdown handoff, or generated companion. Selected public and diagnostic paths redact secret-looking content, but a schema-valid raw artifact can survive and propagate to later agents or bundles.

Crosses: (TB4) Agent or imported artifact → verifier, report, and materializer
Actor(s): (TA1) Malicious target contributor; (TA2) Compromised or misdirected agent

Assets Impacted: A1, A2, A4, A8

**Technical detail:**
- Anchors: `packages/security/src/sensitive-redaction.ts`; artifact event and final-report redaction call sites; generated workflow functions `finalizeAndVerifyArtifacts` and `publishVerifiedArtifacts`; free-form finding fields.
- Mechanism: at the snapshot, canonical publication wrote verified agent bytes exactly, and general artifact validation did not reject all exact active-secret values or every heuristic secret pattern.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inject synthetic canaries into each free-form artifact type in an isolated test and inventory all persisted, downstream, bundle, dashboard, and reporter copies.

## (T5) Mutable handoff or artifact tampering

**Plain-language:** A malicious agent or concurrent local process may try to replace an artifact after validation, swap a symlink, alter a dependency handoff, or make materialization copy bytes different from what the operator reviewed. Ultrafuzz invests heavily in exact snapshots, digests, source pins, verification markers, and path checks to prevent this.

Crosses: (TB4) Agent or imported artifact → verifier, report, and materializer
Actor(s): (TA2) Compromised or misdirected agent; (TA6) Mistaken or malicious operator

Assets Impacted: A3, A4

**Technical detail:**
- Anchors: generated workflow artifact capture and publication; `packages/runtime/src/verified-output.ts`; artifact manifests and source proofs; `packages/runtime/src/materialize.ts`; safe-path primitives.
- Mechanism: at the snapshot, verifier-owned exact-byte snapshots, exclusive publications, digests, symlink checks, and explicit materialization substantially narrowed post-validation substitution. Residual risk remained from shared-user concurrency and implementation defects.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: run the existing race and symlink tests in a writable clone and add adversarial mutation between review, planning, and copy.

## (T6) Schema-valid but wrong audit conclusions

**Plain-language:** A finding can satisfy every JSON shape and provenance rule yet misunderstand contract behavior, omit a vulnerability, or present an invalid reproduction. Model agreement helps, but models may share training, prompts, blind spots, or manipulated evidence. An operator who treats structural verification as security verification may receive false assurance.

Crosses: (TB4) Agent or imported artifact → verifier, report, and materializer
Actor(s): (TA2) Compromised or misdirected agent; (TA6) Mistaken or malicious operator

Assets Impacted: A2, A4, A6, A8

**Technical detail:**
- Anchors: topology strategy fan-out, triage, severity classification, artifact semantic gates, final-report projection, materialization confirmation.
- Mechanism: at the snapshot, quorum and evidence requirements were themselves produced and interpreted by agent stages, and no durable human security approval bound to the final report digest was required.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: trace one finding from independent discovery through executable reproduction, triage, classification, final report, and operator acceptance; distinguish deterministic checks from model judgments.

## (T7) Dashboard control abuse

**Plain-language:** The dashboard can edit project instructions, start expensive work, materialize files, and clean generated state. A malicious website or local process could attempt to invoke those privileges, but the service is restricted to loopback and mutations require a random per-process token plus browser-context checks.

Crosses: (TB5) Browser or local process → privileged dashboard
Actor(s): (TA4) Malicious local browser context or process

Assets Impacted: A3, A4, A5

**Technical detail:**
- Anchors: `packages/dashboard/src/index.ts` — host validation, `requireLocalRequest`, `requireMutation`, request parsing, command dispatch; dashboard audit journal.
- Mechanism: at the snapshot, the server rejected non-loopback binds, non-loopback Host and Origin values, cross-site fetch metadata, and tokenless mutations; requests and responses were schema-checked and body-bounded.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: exercise DNS rebinding, alternate loopback authorities, missing browser headers, cross-site requests, token comparison, oversized bodies, and symlinked edit targets.

## (T8) Local resource and cost exhaustion

**Plain-language:** An agent can run expensive or persistent commands, create many child processes, transfer large data, or repeatedly call paid services. Scheduler limits and the Forge wrapper constrain ordinary work but do not provide whole-agent containment on a local host.

Crosses: (TB2) Agent process ↔ developer host and worktree
Actor(s): (TA1) Malicious target contributor; (TA2) Compromised or misdirected agent

Assets Impacted: A1, A5

**Technical detail:**
- Anchors: run concurrency and timeout configuration; retry expansion; Forge guard; Smithers task timeouts; cloud sandbox resources.
- Mechanism: at the snapshot, Forge received a virtual-memory and worker-thread guard and tasks received deadlines, while other local executables lacked product-owned process-count, memory, disk, and egress quotas.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: in a disposable environment, test detached descendants, process-group termination, non-Forge memory pressure, disk filling, network transfer, and provider-call budgets.

## (T9) Supply-chain compromise

**Plain-language:** A malicious package, model command-line tool, workflow engine, GitHub Action, or external reference can execute with substantial authority or poison audit context. Commit and digest pins make unnoticed substitution harder, but they cannot make a pinned malicious release safe.

Crosses: (TB6) Package, action, tool, and reference supply chain → executable product
Actor(s): (TA5) Compromised upstream maintainer or origin

Assets Impacted: A1, A3, A6, A7

**Technical detail:**
- Anchors: `pnpm-lock.yaml`; `pnpm-workspace.yaml` build allowances; package manifests; `.github/workflows/**`; reference fetch, manifests, and digest validation; trusted launcher and schema preflight.
- Mechanism: at the snapshot, package and action versions, reference commits, schema bundles, and workflow execution dependencies were pinned or fingerprinted. The production dependency audit nevertheless reported seven High advisories, and no mandatory audit gate was found in CI.
- Provenance: observed and scanned at `a634d948038f502e5e677477138dca0c763e2380` on 2026-08-15.
- Verification: reproduce the lockfile audit, generate a software bill of materials, review allowed install scripts, and confirm release provenance and branch protections outside the repository.

## (T10) Private evaluation disclosure

**Plain-language:** Evaluation workflows may combine private target source, external ground truth, model judges, reporters, and public benchmark artifacts. A mistaken sensitivity declaration or explicit upload setting can disclose material that the default manifest-only path would have kept private.

Crosses: (TB7) Private evaluation data → judges, reporters, and public benchmark publication
Actor(s): (TA3) Compromised provider, cloud worker, or provider insider; (TA6) Mistaken or malicious operator

Assets Impacted: A2, A4, A6, A8

**Technical detail:**
- Anchors: private target sensitivity in eval suites; external ground-truth-root validation; private-data judge acknowledgement; telemetry artifact mode; Modal public bundle secret scanning; trusted publication workflows.
- Mechanism: at the snapshot, private targets defaulted to manifest-only reporting and private judge transfer required an acknowledgement, while an explicitly configured upload mode could override the artifact default without a separate operator-owned approval.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: trace every private byte through runner, judge, reporter, cloud result collection, public bundle, and GitHub publication under default and explicit upload modes.

## (T11) Crafted archive memory exhaustion

**Plain-language:** A report or benchmark ZIP supplied by another party can contain forged size metadata that drives the parser into a very large allocation. The process may crash or pressure the host before Ultrafuzz's later per-entry checks reject the archive.

Crosses: (TB4) Agent or imported artifact → verifier, report, and materializer
Actor(s): (TA7) Crafted-bundle sender or benchmark producer

Assets Impacted: A5

**Technical detail:**
- Anchors: `packages/cli/src/commands/stats.ts` — bundle loading; `packages/cli/src/benchmark-analysis/lib/archive.ts` — `BundleArchive`; direct dependency `adm-zip` in `packages/cli/package.json`.
- Mechanism: at the snapshot, production resolved `adm-zip` 0.5.18, which the package audit identified as vulnerable to a crafted ZIP triggering a large allocation. Object construction and entry enumeration occurred before all application limits could validate actual data.
- Provenance: observed and scanned at `a634d948038f502e5e677477138dca0c763e2380` on 2026-08-15.
- Verification: confirm the advisory against the resolved lock entry and run a non-destructive crafted-header regression under a strict external memory limit.

# Countermeasures

| **ID** | **Title** | **Threats Mitigated** | **Status** |
| --- | --- | --- | --- |
| C1 | Untrusted-content framing and prompt review posture | T1 | ⚠️ Partial |
| C2 | Worktree and controller-environment separation | T1 | ⚠️ Partial |
| C3 | Operator-owned credential and provider-home policy | T2 | ⚠️ Partial |
| C4 | Campaign-wide provider data governance | T3 | ⚠️ Partial |
| C5 | Secret-safe canonical artifact publication | T4 | ⚠️ Partial |
| C6 | Authenticated artifact and provenance chain | T5 | ✅ Applied |
| C7 | Explicit path-safe materialization | T5 | ✅ Applied |
| C8 | Semantic review and human signoff | T6 | ⚠️ Partial |
| C9 | Dashboard loopback and mutation authentication | T7 | ✅ Applied |
| C10 | Dashboard schemas, limits, and edit audit | T7 | ✅ Applied |
| C11 | Scheduler and Forge resource bounds | T8 | ⚠️ Partial |
| C12 | Supply-chain pinning and digest verification | T9 | ✅ Applied |
| C13 | Continuous production dependency advisory gate | T9, T11 | ⬜ Not Applied |
| C14 | Private evaluation and publication safeguards | T10 | ✅ Applied |
| C15 | Archive input limits | T11 | ⚠️ Partial |
| C16 | Separate approval for private artifact upload | T10 | ⬜ Not Applied |
| C17 | Operating-system agent sandbox and credential broker | T1, T8 | ⬜ Not Applied |
| C18 | Patched or replaced ZIP parser | T11 | ⬜ Not Applied |

## (C1) Untrusted-content framing and prompt review posture

**Status**: ⚠️ Partial

**Plain-language:** Every generated task is told that target files, dependencies, references, and prior artifacts are untrusted data, and operators are told to review prompts. The warning is useful, but review is not enforced and a prompt cannot contain a command-capable process.

**Technical detail:**
- Anchors: generated workflow `untrustedContentBoundary`; configuration key for required prompt review; project validation trust posture.
- Mechanism: at the snapshot, the boundary text was prepended to tasks, while the required-review boolean had no launch-time approval consumer in production code.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: grep promptReviewRequired consumers and inspect the exact prompt supplied to every adapter.

Threats Mitigated: T1

## (C2) Worktree and controller-environment separation

**Status**: ⚠️ Partial

**Plain-language:** Agents work in generated Git worktrees, controller-only environment capabilities are cleared, and only active credentials plus operator-allowed variables are forwarded. These measures reduce accidental cross-run access but do not stop the same operating-system user from reading other accessible files or using the network.

**Technical detail:**
- Anchors: generated `<Worktree>` tasks; `workflowControlChildEnvironment`; linked workflow environment-name collection.
- Mechanism: at the snapshot, controller-only variable names and paths were cleared, but local execution was not a host isolation boundary.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect child process environments and filesystem permissions from a disposable local task.

Threats Mitigated: T1

## (C3) Operator-owned credential and provider-home policy

**Status**: ⚠️ Partial

**Plain-language:** Configuration validates credential-name syntax, blocks controller-only names, fixes several provider origins, and isolates some generated provider homes. It should additionally prevent repository authors from choosing unrelated host variables or arbitrary host paths.

**Technical detail:**
- Anchors: agent configuration schema; start-run credential name collection; adapter path resolvers and provider configuration writers.
- Mechanism: at the snapshot, syntax and a narrow denylist were enforced, while canonical per-provider names, approved roots, and separate operator acknowledgement were absent.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: enumerate every config-controlled environment name and filesystem root that reaches an adapter.

Threats Mitigated: T2

## (C4) Campaign-wide provider data governance

**Status**: ⚠️ Partial

**Plain-language:** Provider endpoints are protected by HTTPS, several adapters fix their official origins, and private evaluations have explicit safeguards. Ordinary campaigns still need sensitivity, retention, region, processor, and minimization policy that follows data across every provider.

**Technical detail:**
- Anchors: adapter endpoint construction; Modal sandbox provider; eval sensitivity and judge acknowledgement.
- Mechanism: at the snapshot, transport and eval-specific controls existed, but no general campaign sensitivity contract governed all source and artifact transfer.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: grep sensitivity handling outside the eval packages and trace outbound request payloads.

Threats Mitigated: T3

## (C5) Secret-safe canonical artifact publication

**Status**: ⚠️ Partial

**Plain-language:** Events, errors, selected reports, and public bundles redact or reject secret-looking values. The same protection should apply to every raw agent artifact before it becomes canonical or is handed to another agent.

**Technical detail:**
- Anchors: sensitive-redaction helpers; event, report, and public-bundle call sites; workflow publication of verified bytes.
- Mechanism: at the snapshot, redaction coverage depended on the output path, and canonical general artifact publication lacked a universal secret gate.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: build an artifact-type coverage table and test synthetic canaries without real credentials.

Threats Mitigated: T4

## (C6) Authenticated artifact and provenance chain

**Status**: ✅ Applied

**Plain-language:** Declared outputs are captured as bounded regular-file snapshots, checked against exact schemas and semantic joins, tied to source and task provenance, and published with verification evidence. Downstream tasks consume authenticated snapshots rather than silently falling back to similar files.

**Technical detail:**
- Anchors: generated workflow `finalizeAndVerifyArtifacts`; runtime artifact gates; verification markers; source proofs; dependency handoff fingerprints.
- Mechanism: at the snapshot, exact bytes were validated and recorded before downstream use, with race, source-pin, and cross-artifact consistency checks.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect output capture, publication, marker generation, and downstream snapshot authentication.

Threats Mitigated: T5

## (C7) Explicit path-safe materialization

**Status**: ✅ Applied

**Plain-language:** Moving output into the target requires explicit file selections and confirmation. Patches, staging, commits, pushes, Git metadata, product state, sensitive destinations, traversal, and symlink escapes are rejected; copied changes remain ordinary unstaged files.

**Technical detail:**
- Anchors: `packages/security/src/materialize-policy.ts`; `packages/runtime/src/materialize.ts`; materialization audit journal.
- Mechanism: at the snapshot, selected copy sources and destinations were resolved inside their roots and rechecked before copy; unsupported publication modes and patch application failed closed.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: run path, overwrite, race, symlink, and sensitive-destination cases in a temporary project.

Threats Mitigated: T5

## (C8) Semantic review and human signoff

**Status**: ⚠️ Partial

**Plain-language:** Multiple strategy agents, triage, severity classification, reproduction evidence, and a quorum reduce single-model error. A human review decision should be a distinct durable gate before a report is treated as accepted or production-relevant output is copied.

**Technical detail:**
- Anchors: default topology review stages; triage configuration; finding lifecycle; materialization confirmation.
- Mechanism: at the snapshot, review stages remained model tasks and materialization confirmation was not a digest-bound security acceptance record.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: trace whether any runtime state requires a human principal and cryptographically binds the decision to final evidence.

Threats Mitigated: T6

## (C9) Dashboard loopback and mutation authentication

**Status**: ✅ Applied

**Plain-language:** The dashboard binds only to local addresses, rejects suspicious browser request context, and requires a random session token for every mutation. This substantially reduces drive-by browser attacks.

**Technical detail:**
- Anchors: dashboard host validation, local-request checks, mutation token comparison, and security headers.
- Mechanism: at the snapshot, non-loopback binds and authorities failed; cross-site browser requests failed; mutation tokens were compared in constant time.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: exercise request-context and token cases against the loopback server.

Threats Mitigated: T7

## (C10) Dashboard schemas, limits, and edit audit

**Status**: ✅ Applied

**Plain-language:** Dashboard documents are schema-validated, request bodies and command output are bounded, edited paths are checked, invalid changes are rolled back, and prompt, topology, and configuration edits are journaled by hash.

**Technical detail:**
- Anchors: dashboard HTTP schemas; bounded request reader; save and rollback methods; dashboard audit journal.
- Mechanism: at the snapshot, malformed or oversized documents failed before mutation and accepted edits produced durable audit records.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect all mutating routes and confirm each calls both mutation authentication and schema validation.

Threats Mitigated: T7

## (C11) Scheduler and Forge resource bounds

**Status**: ⚠️ Partial

**Plain-language:** Runs cap parallelism, retries, per-task duration, whole-workflow duration, and cloud resources. Forge receives a memory and worker-thread wrapper. Other local commands and descendants need equivalent containment.

**Technical detail:**
- Anchors: resolved run configuration; topology expansion budgets; Forge guard; Smithers task timeouts; Modal resource objects.
- Mechanism: at the snapshot, scheduling bounds applied to managed tasks and Forge, not to every local process, filesystem allocation, network transfer, or provider call initiated by an agent.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: test timeout cleanup and resource exhaustion with non-Forge commands in an isolated host.

Threats Mitigated: T8

## (C12) Supply-chain pinning and digest verification

**Status**: ✅ Applied

**Plain-language:** Dependencies use a frozen lockfile, sensitive native install scripts are explicitly allowed or denied, GitHub Actions use immutable commit references, external references use full commits and file digests, and generated workflow dependencies and schemas are fingerprinted.

**Technical detail:**
- Anchors: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.github/workflows/**`, reference cache manifests, trusted launcher and schema preflight.
- Mechanism: at the snapshot, substitution of expected package, action, reference, and contract bytes was constrained by immutable identifiers and digest validation.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: reproduce installs with the frozen lockfile and verify action, reference, schema, and workflow dependency identities.

Threats Mitigated: T9

## (C13) Continuous production dependency advisory gate

**Status**: ⬜ Not Applied

**Plain-language:** Continuous integration should fail or require a documented exception when a reachable production dependency has an actionable High or Critical advisory. The current snapshot has known High advisories and no mandatory audit gate was found.

**Technical detail:**
- Anchors: root CI workflow, package manifests, lockfile, release validation scripts.
- Mechanism: at the snapshot, read-only `pnpm audit --prod` reported seven High advisories; CI installed with a frozen lock but did not run a dependency-advisory policy gate.
- Provenance: observed and scanned at `a634d948038f502e5e677477138dca0c763e2380` on 2026-08-15.
- Verification: run the production audit and map each advisory to a reachable code path before accepting or fixing it.

Threats Mitigated: T9, T11

## (C14) Private evaluation and publication safeguards

**Status**: ✅ Applied

**Plain-language:** Private ground truth must live outside the repository and bind to the expected subject. Private targets default to metadata-only artifact reporting, private judge transfer requires acknowledgement, public bundles reject known or secret-like values, and trusted-main publication tooling validates candidate and generation identity.

**Technical detail:**
- Anchors: eval suite and ground-truth validation; scoring private-data acknowledgement; node telemetry; Modal public bundle; benchmark publication workflows.
- Mechanism: at the snapshot, default private paths reduced payload disclosure and public publication was separated from candidate-controlled workflow execution.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: run privacy-mode matrix tests and inspect exact public bundle members and publication permissions.

Threats Mitigated: T10

## (C15) Archive input limits

**Status**: ⚠️ Partial

**Plain-language:** Report and benchmark readers cap selected bytes, expanded data, member counts, path shapes, and JSON complexity. Those checks reduce ordinary archive bombs but rely on a parser with a currently reported pre-check allocation weakness.

**Technical detail:**
- Anchors: offline statistics ZIP budgets; benchmark `BundleArchive`; nested tar expansion budgets.
- Mechanism: at the snapshot, application limits were often evaluated after archive construction or entry parsing had begun.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: test forged header sizes and parser allocation under an external memory limit.

Threats Mitigated: T11

## (C16) Separate approval for private artifact upload

**Status**: ⬜ Not Applied

**Plain-language:** A repository-level request to upload private artifact payloads should not be sufficient. Require a separate operator-owned acknowledgement naming the destination, target, included files, and retention policy.

**Technical detail:**
- Anchors: eval reporting artifact mode and target sensitivity resolution.
- Mechanism: at the snapshot, an explicit suite upload mode could enable private payload upload without an independent environment or interactive approval comparable to private judge transfer.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: inspect mode resolution and attempt private upload without operator-owned acknowledgement.

Threats Mitigated: T10

## (C17) Operating-system agent sandbox and credential broker

**Status**: ⬜ Not Applied

**Plain-language:** Local agents should run in disposable operating-system isolation with a narrow write root, no host credential filesystem, resource quotas, and controlled network destinations. Provider credentials should be delivered through a broker that does not expose them to general shell children.

**Technical detail:**
- Anchors: local worktree task construction, generated agent commands, child environment, documented trust model.
- Mechanism: at the snapshot, local worktrees and environment filtering did not establish same-user filesystem, process, or network isolation.
- Provenance: observed at `a634d948038f502e5e677477138dca0c763e2380`.
- Verification: run host-read, descendant-process, network, and credential-canary probes in a disposable environment.

Threats Mitigated: T1, T8

## (C18) Patched or replaced ZIP parser

**Status**: ⬜ Not Applied

**Plain-language:** The archive reader should use a release not affected by the crafted large-allocation advisory, with regression tests that prove limits apply before memory is committed.

**Technical detail:**
- Anchors: CLI dependency on `adm-zip`; statistics and benchmark archive readers.
- Mechanism: at the snapshot, the lock resolved the affected 0.5.18 release and the audit identified 0.6.0 as the patched boundary.
- Provenance: observed and scanned at `a634d948038f502e5e677477138dca0c763e2380` on 2026-08-15.
- Verification: confirm the replacement lock entry, advisory status, and crafted-header regression behavior.

Threats Mitigated: T11

# Appendix: STRIDE and LINDDUN Brainstorming

These analyses are brainstorming scaffolding, not the deliverable. Their actionable output lives above in Assets, Threats, Countermeasures, and Open Questions. Every bullet below carries a disposition tag.

## Top-Level STRIDE Analysis

- **Spoofing**
  - A project can name an unrelated environment variable as though it were the selected provider credential. `[→ T2]`
  - A malicious browser context can attempt to impersonate the dashboard frontend, but loopback and session controls substantially constrain it. `[→ T7]`
- **Tampering**
  - Target content can influence an unrestricted agent to alter a worktree or perform an external Git action. `[→ T1]`
  - A process can attempt to replace a handoff or materialization source after review. `[→ T5]`
  - A model can emit schema-valid but misleading evidence that survives structural validation. `[→ T6]`
- **Repudiation**
  - Agent shell and network effects are not all represented by a deterministic product audit log; prompt rules can be violated without a complete external-action ledger. `[→ T1]`
  - Dashboard edits and materialization are journaled, but human semantic acceptance is not a distinct durable decision. `[→ T6]`
- **Information Disclosure**
  - Providers and cloud workers receive private source and campaign context. `[→ T3]`
  - Agent-authored raw artifacts can persist a credential or private fragment outside the covered redaction paths. `[→ T4]`
  - Private evaluation upload or judge configuration can expose private material. `[→ T10]`
- **Denial of Service**
  - Unrestricted local tools can exhaust general host or provider resources outside the Forge-specific guard. `[→ T8]`
  - A crafted ZIP can trigger vulnerable parser allocation. `[→ T11]`
  - A malicious dependency can disable or corrupt build and release operations. `[→ T9]`
- **Elevation of Privilege**
  - Untrusted repository prose can cross into a command-capable agent running as the operator. `[→ T1]`
  - Repository configuration can cross from data into selection of host credentials and external filesystem roots. `[→ T2]`

## Top-Level LINDDUN Analysis

LINDDUN is a privacy-focused threat modeling framework that complements STRIDE's security focus.

- **Linkability**
  - Provider telemetry can link target repository identity, commit, model selection, run metadata, and unpublished findings across campaigns. `[→ T3]`
  - Public benchmark provenance intentionally links results to a candidate and provider; private payload separation must remain intact. `[→ T10]`
- **Identifiability**
  - Source paths, repository metadata, report content, and provider account context may identify an organization or audit target. `[→ T3]`
- **Non-repudiation (Privacy Context)**
  - Durable run and publication provenance can permanently associate an operator or target with an audit; the acceptable retention and access policy is not derivable from code. `[→ OQ2]`
- **Detectability**
  - Manifest-only reporting still reveals artifact names, sizes, digests, model use, and timing, which may disclose that a private target or finding class exists. `[→ T10]`
- **Disclosure of Information (Privacy Context)**
  - General model and cloud execution transfers private source without a campaign-wide data-governance contract. `[→ T3]`
  - Raw schema-valid artifacts can retain secret or personal content. `[→ T4]`
- **Unawareness**
  - The repository does not establish what notices, processor terms, retention periods, or regional promises operators give target owners. `[→ OQ2]`
- **Non-compliance**
  - Applicable jurisdictions, contractual processor duties, deletion obligations, and breach-notification procedures cannot be determined from code. `[→ OQ2]`

# Maintenance Guidance for Future Agents

1. Re-anchor to the current commit and date.
2. Check the ARI specification for changes, recompute all gaps, and report `Δ_scope` and `Δ_controls` separately.
3. Re-rank the backlog by residual mass.
4. Re-check every trust boundary and actor, especially new provider, dashboard, artifact, or publication paths.
5. Re-tag every STRIDE and LINDDUN bullet.
6. Add dated markers to new elements and retain retired threats as closed entries.
7. Re-evaluate any redesign against current and projected ARI.
8. Validate all cross-references and control independence.
9. Bump the document version.
10. Re-resolve every Technical-detail anchor and re-stamp provenance.
11. Refresh the Coverage & Unknowns map.

# Open Questions for the Team

1. Are all audited repositories trusted to supply Ultrafuzz configuration, or must hostile pre-existing configuration be safe before initialization and launch?
2. Which model and cloud provider retention, training, regional, processor, deletion, and breach-notification terms are contractually approved for private source and findings?
3. Is local mode expected to run only inside a disposable dedicated environment, or is an ordinary credential-bearing developer workstation supported?
4. Should adapter credential names and configuration roots be operator-owned, and which exceptions are required for enterprise gateways or multiple subscriptions?
5. Is human security signoff mandatory before a final report is relied on, shared, or used to materialize production-relevant files?
6. What operational process detects artifact secret exposure and rotates affected credentials?
7. From which parties may operators accept offline report or benchmark archives?
8. What is the remediation or exception service level for High production dependency advisories?

## Coverage & Unknowns

- **Examined:** root and package manifests; lock and workspace policy; architecture and security documentation; configuration, topology, prompts, and reference catalog; local and cloud agent adapters; workflow construction and artifact finalization; path and materialization policy; secret-redaction call sites; dashboard request and mutation controls; Modal source, credential, result, and public-bundle flows; evaluation sensitivity, judging, reporting, and publication; GitHub Actions; archive import paths; relevant schemas and tests as supporting evidence. The ARI v1.1 upstream specification was checked at remote commit `847f5e300d1977be9a437ead50826ddd5930a01d`.
- **Read-only checks:** ESLint completed successfully. `pnpm audit` reported 21 advisories across all dependencies and seven High advisories in production dependencies. The confirmed reachable issue modeled here is the `adm-zip` archive allocation threat. Other production advisories involved `brace-expansion` and `fast-uri`; exploitability in Ultrafuzz's concrete use was not established in this pass. A credential-pattern location scan found matches only in test fixtures and no candidate value was reproduced.
- **Not examined:** live provider accounts, external provider implementations, Modal account policy and network isolation, branch protection and repository organization settings, published package signing or distribution infrastructure, actual customer targets, runtime behavior of installed model command-line tools, and dynamic browser testing. Full unit and integration suites were not run because their package scripts delete and create build outputs inside the read-only target checkout; conclusions use source, existing tests, ESLint, and read-only dependency scanning instead.
- **Could not verify from code alone:** actual prompt-review practice; host hardening; operator credential hygiene; provider retention and legal terms; applicable personal-data regimes; cloud identity and access policy; whether uploaded private artifacts are operationally approved; human acceptance policy; external archive provenance; whether the non-archive dependency advisories are reachable; release branch protection; incident response and credential-rotation procedures.

# Change Log

| **Date** | **Author / Trigger** | **ARI Δ** | **Summary of Changes** |
| --- | --- | --- | --- |
| August 2026 | Initial private threat-model audit | N/A → 33.8; initial issuance, delta decomposition not applicable | Added A1–A8, TB1–TB7, TA1–TA7, T1–T11, and C1–C18. Established ARI v1.1 baseline and remediation backlog. |

# Model and Methodology

- Skill: Threat Model Generation Skill v8
- ARI spec: v1.1 — https://github.com/kristovatlas/ari
- Model used: gpt-5.6-sol at xhigh effort
- Model degradation: None — ran on the required model and effort.
- Generated / refreshed: August 2026
- Initial issuance: August 2026
