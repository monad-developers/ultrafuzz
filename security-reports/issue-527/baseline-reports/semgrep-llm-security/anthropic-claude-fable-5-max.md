---
skill: "semgrep-llm-security"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Ultrafuzz — OWASP Top 10 for LLM Applications (2025) Security Assessment

- **Method:** method-07 — `semgrep-llm-security` (OWASP Top 10 for LLM Applications 2025; also maps to MITRE ATLAS / NIST AI RMF)
- **Target (authorized local checkout):** `/tmp/ultrafuzz-fable-executor/repository`
- **Snapshot commit:** `a634d948038f502e5e677477138dca0c763e2380` — branch `main`, "fix(runtime): reconcile recovered terminal run status (#578) (#603)", 2026-08-15, clean working tree
- **Model:** claude-fable-5, effort max
- **Status:** complete. The checkout was not modified (verified `git status` clean; the only script written was a redaction probe under `/tmp`, outside the checkout, then removed).

---

## 1. System under review

Ultrafuzz is an **agentic orchestrator for smart-contract fuzzing**. It initializes a target repository with editable prompts + topology, then runs specialized LLM coding agents (first-party Codex, Claude, Kimi, DeepSeek adapters, plus an OpenRouter adapter) as child processes, collects generated fuzz tests / findings, and serves a local dashboard + final report. It is a textbook LLM application: prompt rendering, multi-agent tool-use, retrieval of pinned reference material, an LLM-as-judge eval harness, and a cloud (Modal) execution path that publishes public benchmark bundles.

### Threat-model framing (decisive for severity calibration)
`docs/security.md` **explicitly accepts** the excessive-agency posture as a deliberate decision: agents run with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`; there is **no** OS sandbox, command allowlist, or egress allowlist; and "Findings whose mitigation requires an OS sandbox, approval gate, command allowlist, or egress allowlist are accepted threat-model risks." I did **not** report those as novel findings. Instead I assessed:
- (a) the **deterministic boundaries the product does commit to** (relative/non-traversing/non-symlink paths; secret redaction before persistence; explicit+confirmed materialization; clean confined to generated roots; workspace-handoff protection of sensitive roots);
- (b) **credential least-privilege** (does each agent get only what it needs?);
- (c) **output handling on the product's own surfaces** (dashboard, public benchmark bundle, final report);
- (d) **consumption controls** (bounded cost/retry/fan-out/wall-clock).

---

## 2. Methodology

1. Read the full method (`SKILL.md`, `README.md`, `_sections.md`, and all 10 rule files LLM01–LLM10).
2. Mapped each OWASP LLM category onto this TypeScript monorepo (12 packages, ~470 source files).
3. Direct source review of the highest-signal boundaries: `packages/security/*` (redaction, path-policy, materialize-policy), `packages/artifacts/src/safe-paths.ts`, `packages/runtime/src/materialize.ts`, `packages/modal/src/public-bundle.ts`, `packages/config/src/redaction.ts`, `packages/runtime/src/workspace-handoff.ts`, `forge-guard.ts`, `templates/smithers/agents/environment.tsx`, dashboard server binding, supply-chain config, and git hygiene.
4. Three parallel evidence-gathering subagents: dashboard output-handling/XSS (LLM05/07), prompt-injection & template/reference parsing (LLM01/07/09), and agent-adapters/credentials/consumption (LLM02/06/10). Their file:line evidence was cross-checked against my own greps of the assigned checkout (one subagent cited a sibling checkout path `ultrafuzz-issue-527`, but the line numbers match this checkout exactly, so the evidence transfers).
5. A non-destructive probe replicating the exact `sensitive-redaction.ts` regexes against realistic secrets (run in `/tmp`, checkout untouched) to prove the M-02 coverage gap.

---

## 3. Findings summary

| ID | OWASP | Severity | Title |
|----|-------|----------|-------|
| M-01 | LLM02 | Medium | Cross-agent credential over-forwarding in local multi-provider runs |
| M-02 | LLM02 | Medium | Secret-redaction pattern set has coverage gaps and gates public disclosure |
| L-01 | LLM02 | Low | Kimi API key written to disk in cleartext (crash-residue window) |
| L-02 | LLM10 | Low | No enforced cost/token spend ceiling (Denial-of-Wallet) |
| L-03 | LLM07/02 | Low | Raw agent stdout/stderr logs served by dashboard, redaction at rest unconfirmed |
| L-04 | LLM01 | Low | Reference `.md` content inlined un-delimited into agent-consumed artifact |
| I-01 | LLM01/06 | Informational | Indirect injection → command exec/egress is an accepted, documented risk |
| I-02 | LLM09 | Informational | Residual eval LLM-judge sway (integrity-only, mitigated) |

**No Critical or High findings.** This is a genuinely hardened codebase; the two Mediums are least-privilege / defense-in-depth gaps, not exploitable escapes of a hard boundary.

---

## 4. Detailed findings

### M-01 (LLM02) — Cross-agent credential over-forwarding in local multi-provider runs
The run-level env allowlist is built from the api-key env var name of **every** active api-key agent across **all** tasks (`start-run.ts:1315-1341`, invoked with the union of every task's agent chain at `start-run.ts:186-190`). All those names are forwarded into a **single** controller-process environment (`smithers.ts:3745-3761`) that every **local** agent child inherits. The per-child sanitizer (`templates/smithers/agents/environment.tsx:26-45`) strips only controller-internal `SMITHERS_`/`ULTRAFUZZ_` variables — not sibling provider keys. Only OpenRouter blanks the full sibling matrix (`openrouter.tsx:41-52`); Codex blanks its own key only in subscription mode (`codex.tsx:62,66`); DeepSeek blanks only Anthropic/Claude vars (`deepseek.tsx:107-138`); Claude/Kimi blank none. Per-agent credential scoping *exists* but is gated to cloud (`smithers.ts:3988-3997` returns `[]` when `execution.mode!=='cloud'`; default is `local`, `ultrafuzz.toml:22`). The developers clearly intend isolation — `retry-chain.ts:33-40` blocks mixing api-key agents in one retry chain "until every rung has an isolated credential boundary" — but that guard is per-retry-chain, not cross-node.

**Why it matters:** multi-provider topologies are a first-class shipped feature and the default `ultrafuzz.toml` configures three api-key providers. A run that selects >1 api-key profile across nodes puts all their keys in the shared local env; because each agent runs with skip-permissions + network (accepted), a prompt-injected or compromised agent can `echo $DEEPSEEK_API_KEY` (a provider it should never touch) and exfiltrate it. This is credential exposure beyond least-privilege, and is **not** the accepted risk (the accepted risk is that an agent may act; it does not sanction handing every agent every provider's secret). Note the controller env is otherwise **fail-closed** vs the host (`smithers.ts:957-1002` base allowlist; `ULTRAFUZZ_AGENT_ENV_ALLOWLIST` validated and additive at `start-run.ts:1348-1356`). **Fix:** scope credentials per-invocation in `workflowControlChildEnvironment` (blank all non-active provider key names), mirroring the cloud path and OpenRouter's blanking.

### M-02 (LLM02) — Redaction coverage gaps gate public disclosure
`packages/security/src/sensitive-redaction.ts` scrubs secrets using an allowlist of known shapes (`SECRET_PATTERNS`, lines 3-14) plus Bearer / `user:pass@` URL / `key=value` regexes (lines 71-81), with **no generic high-entropy fallback**. A non-destructive probe of the exact patterns confirmed the following are **not** redacted:

| Secret | Redacted? |
|--------|-----------|
| OpenAI `sk-…`, Anthropic `sk-ant-…`, GitHub `ghp_…`, AWS `AKIA…`, Slack `xoxb-…`, `Bearer …`, `api_key=…` | YES |
| **Google/GCP `AIza…` key** | **NO** |
| **Alchemy/Infura RPC URL with key in path** (`https://…/v2/<KEY>`, `https://…/v3/<KEY>`) | **NO** |
| **bare `npm_…` token** | **NO** |
| **generic 40-hex / high-entropy secret** | **NO** |

The web3 RPC-URL gap is domain-relevant: `MAINNET_RPC_URL` is a documented opt-in agent env var (`docs/security.md:53`), and Alchemy/Infura embed the key in the URL path. Crucially, this same function is both the at-rest scrubber (events.ts:1198, state.ts:463, attempt-ledger.ts:454, config redaction, lifecycle-inspection.ts, smithers.ts evidence text) **and the fail-closed publication gate** on public surfaces: `modal/src/public-bundle.ts:143` (`redactSecretsInText(text)!==text` ⇒ refuse to publish) and `runtime/src/final-report-markdown.ts:124,888-891` (`containsUnredactedSecret`). A secret in an unrecognized format therefore survives scrubbing **and** is judged "clean" for public benchmark bundles and shared final reports. Partial mitigation: `public-bundle.ts` also matches exact `forbiddenSecretValues` (lines 78,134-141), catching known operator env keys regardless of shape. **Fix:** add high-entropy + URL-embedded-credential detection, and thread exact-value matching through the at-rest and final-report gates.

### L-01 (LLM02) — Kimi writes the real key to disk
`templates/smithers/agents/kimi.tsx:359-387` serializes `api_key = <real key>` into a `config.toml` (mode `0600`, isolated `mkdtempSync` dir). Cleanup is best-effort in `finally` (`kimi.tsx:1406-1437`); a hard kill leaves a `0600` key file under `os.tmpdir()`. OpenRouter's adapter (`openrouter.tsx:132-146`) demonstrates the correct pattern — write an env-reading command, never the key. **Fix:** adopt the OpenRouter pattern or add a signal/exit cleanup hook.

### L-02 (LLM10) — No spend ceiling
Cost is computed for reporting only (`model-pricing.ts`; `workflow-sync.ts:1190-1201,2461-2490`); no `max_cost`/token budget exists in the config schema. Consumption *is* bounded by enforced ceilings — node timeout (max 86400s), a terminating 24h workflow deadline (`workflow-sync.ts:1039`), bounded retries (`MAX_RETRY_CHAIN_ATTEMPTS=100`, `retry-chain.ts:20-22`), parallelism caps (4 agents / 8 nodes), and 6h/16h sandbox lifetimes — so it is not unbounded, but worst-case dollar spend inside that envelope with the default expensive models is uncapped. **Fix:** add an optional enforced `run.max_cost_usd` that aborts, or document the deliberate omission.

### L-03 (LLM07/LLM02) — Raw stdout/stderr logs served, redaction unconfirmed
The dashboard serves raw `stdout.log`/`stderr.log`/`prompt.rendered.md` (`dashboard/src/index.ts:844-846`) in a React `<pre>`. stdout/stderr projected into evidence/state IS redacted (`smithers.ts:1788-1789` via `redactedEvidenceText`, which also inherits M-02's gaps), but a write-time redactor for the raw log **files** could not be located. Mitigated by loopback-only + Origin-gated dashboard and the trusted-local model. **Fix:** redact these files at write (or read) time and add a regression test. *(Confidence: medium — the raw-log writer's redaction was unconfirmed either way.)*

### L-04 (LLM01) — Un-delimited reference `.md` inlining
`references/index.ts:842-848` inlines `.md` reference bodies raw while fencing non-`.md` files, so a malicious pinned `.md` would appear as un-delimited prose in property-lens prompts — inconsistent with the repo's own untrusted-data labeling (the eval judge labels untrusted data correctly). Strongly mitigated: references are GitHub-only, full-SHA-pinned, and SHA-256 digest-verified (`references/index.ts:531-537,658-668,707-716`). **Fix:** fence/label `.md` reference bodies as untrusted data.

### I-01 (LLM01/LLM06) — Accepted indirect-injection risk
The core LLM01/LLM06 risk (untrusted repo content steering a skip-permissions agent into command execution/egress) is explicitly accepted (`docs/security.md:3-13`). Notably, untrusted content is **not** server-side interpolated into prompts — the `{{var}}` engine interpolates only orchestrator-controlled paths and never re-scans substituted values (`render.ts:985-1020,311-326`), so the injection surface is confined to the agent's own tool loop. Recorded for coverage; no action under the current threat model.

### I-02 (LLM09) — Residual LLM-judge sway
The eval adjudicator embeds untrusted finding/ground-truth JSON but mitigates correctly: untrusted-data labels, strict JSON output, and ground-truth ID aliasing (`adjudicator-prompt.ts:15-22,49-56`; `adjudicator-*.mdx`). Residual sway affects only benchmark score integrity. Accepted-with-mitigations.

---

## 5. OWASP LLM Top 10 — category-by-category verdict

- **LLM01 Prompt Injection:** Direct/template-injection into the control plane is **closed** (allowlisted `{{var}}` engine, no value re-scan, safe YAML via `eemeli/yaml` not `js-yaml`). Indirect injection into the agent tool loop is the accepted risk (**I-01**). One informational delimiting gap in reference inlining (**L-04**).
- **LLM02 Sensitive Information Disclosure:** Redaction is broadly and deliberately applied (incl. public surfaces), but has coverage gaps (**M-02**) and a least-privilege credential-forwarding gap (**M-01**); minor key-on-disk (**L-01**) and raw-log (**L-03**) items. Positive: keys via env not argv; no shell-string execution; fail-closed host env; secrets never in run provenance; git hygiene (`smithers.db*` / runtime dirs gitignored).
- **LLM03 Supply Chain:** **Strong.** No install lifecycle scripts; pinned `pnpm-lock.yaml`; `pnpm allowBuilds` disables native build scripts for most deps (`node-pty`, `koffi`, `@moonshot-ai/kimi-code`, etc.); references pinned to full commit SHAs + digest-verified; OpenRouter route hardcoded. No finding.
- **LLM04 Data/Model Poisoning:** Eval ground truth is SHA-256 fingerprinted with lineage (`evals/src/lineage.ts:43-66`); references digest-verified. No finding.
- **LLM05 Improper Output Handling:** **Strong.** Dashboard is loopback-only (`index.ts:1651`), strict CSP (`default-src 'none'`, `script-src 'self'`), no CORS, Origin/Sec-Fetch/Host gating, timing-safe session-token-gated mutations, and React auto-escaping with zero raw-HTML sinks (no `innerHTML`/`dangerouslySetInnerHTML`/markdown-HTML). No XSS. Path containment for product-written files is rigorous (`safe-paths.ts`: O_NOFOLLOW, symlink/hardlink/TOCTOU checks). No finding.
- **LLM06 Excessive Agency:** Skip-permissions is accepted (**I-01**). Product-committed boundaries verified correct: materialize refuses overwrite unless explicit + confirmed with `COPYFILE_EXCL` (`materialize.ts:114-118,264-300`), clean confined to generated roots, workspace-handoff excludes sensitive roots (`workspace-handoff.ts:13-21`), forge subprocess resource-guarded (`forge-guard.ts`). Codex actually runs sandboxed (`workspace-write`), not bypass.
- **LLM07 System Prompt Leakage:** No secrets/endpoints/security-logic in prompts; security logic lives in code. Only **L-03** residual.
- **LLM08 Vector/Embedding:** No vector DB / RAG embedding store; "retrieval" is SHA-pinned GitHub reference fetch (SSRF closed: GitHub-only host, `execFileSync` no shell, charset/SHA validation). No finding.
- **LLM09 Misinformation:** Findings/reports are schema-validated and evidence/handoff-oriented; eval judge is grounded and delimited (**I-02**).
- **LLM10 Unbounded Consumption:** Retries, parallelism, wall-clock, memory, and sandbox lifetimes are bounded; only a monetary/token spend cap is missing (**L-02**).

---

## 6. Notable strengths (context for the low finding count)

- Path/IO primitives (`safe-paths.ts`, `public-bundle.ts`) use O_NOFOLLOW, symlink-component and hard-link (`nlink`) rejection, TOCTOU inode/mtime re-validation, exclusive durable writes, and symlink-rejecting archive extraction.
- The public benchmark bundle path is heavily defended (base64/sha256/size gates, path allowlist, staged extraction, exact-value + pattern secret gate).
- Fail-closed subprocess environment; no `shell:true`/`execSync`/`exec()` anywhere; credentials only via env; competing provider creds cleared from subprocesses.
- The CHANGELOG shows sustained security work (redacted stderr routing #307, bounded sandbox lifetimes #422, depth-bounded fail-closed enumeration #218, credential-avoiding submodule rewriting #458).

---

## 7. Limitations

- Static/read-only review at commit `a634d948`; no runtime execution of the full pipeline, cloud (Modal) path, or a live agent run.
- The redaction gap was proven by replicating the exact regexes in `/tmp` (not by exercising the built module) — the patterns are copied verbatim from `sensitive-redaction.ts`.
- L-03's raw-log write-path redaction could not be conclusively confirmed in either direction from source; it is reported as an uncertain Low.
- Third-party agent CLIs (Claude Code, Codex, Kimi, DeepSeek) and their upstream `@smthrs/agents` behavior were assessed only at the adapter boundary, not audited internally.
- Interactive MCP connectors were unavailable in this environment; no external network calls were made.
