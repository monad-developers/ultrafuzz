---
skill: "input-validation-audit"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Security Audit Report — Input Validation Assessment

**Target:** Ultrafuzz (agentic orchestrator for smart-contract fuzzing)
**Repository snapshot (commit):** `a634d948038f502e5e677477138dca0c763e2380` (branch `main`, clean working tree)
**Method:** method-04 — `input-validation-audit` (XSS, SQLi, command injection, path traversal, SSRF, deserialization, SSTI, encoding)
**Date:** 2026-08-15
**Auditor:** Automated ReviewExecutor (skill method-04, model claude-fable-5, effort max)
**Classification:** Private review material — not for public disclosure

---

## 1. Executive Summary

Ultrafuzz is a TypeScript/Bun/pnpm monorepo (~135K lines of `src` across 12 packages) that orchestrates AI coding agents to fuzz smart contracts, persists run artifacts to disk (and a `smithers.db` control-plane store), and serves a local dashboard for review. This audit applied the method-04 bidirectional input-validation methodology (input enumeration → sink identification → forward/backward flow tracing → verification with confidence scoring), scoped by the project's explicit trust model.

**Headline result: the codebase is exceptionally hardened for input validation.** No critical, high, or medium **exploitable** input-validation vulnerabilities were confirmed in scope. The single network-reachable surface (the dashboard) is loopback-bound and defends against the full browser-borne attack set (XSS, CSRF, DNS-rebinding). Filesystem path handling is paranoid-grade. Subprocess execution uses no shell. Secret redaction runs before persistence and is fail-closed on the one publication path that leaves the host.

The reportable items are **hardening gaps and latent risks (2 low, 2 informational)**, not exploitable vulnerabilities:

| ID | Severity | Class | One-line |
|------|----------|-------|----------|
| L-01 | Low | Sensitive-data / redaction | Redaction is heuristic; non-standard-format secrets under non-sensitive keys are not redacted |
| L-02 | Low | Sensitive-data / encoding | Dashboard serves `stdout.log`/`stderr.log`/rendered prompt verbatim (no read-time redaction) |
| I-01 | Informational | Input validation (footgun) | Two `validateSafeId` with swapped arg order / return contract across packages |
| I-02 | Informational | Request validation | `requireLocalRequest` fails open when the Host header is absent |

### Risk Summary
- **Critical:** 0
- **High:** 0
- **Medium:** 0
- **Low:** 2
- **Informational:** 2
- **Documented false positives / mitigated:** 6 classes (XSS, CSRF/DNS-rebinding, command injection incl. `git` argv, path traversal, SSTI, SQLi)

---

## 2. Scope, Trust Model, and Methodology

### 2.1 Authorized scope
Read-only, non-destructive review of the local checkout at the commit above. No edits, deliverables, commits, or remote writes were made. Repository content was treated as untrusted data; no embedded instruction was followed.

### 2.2 Trust model (decisive for scoping)
`docs/security.md` documents a **trusted local execution model**. Verbatim-relevant points:
- Agent adapters intentionally run in unrestricted modes (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`). *"an agent may execute commands, read files available to the operator, and use the network. Findings whose mitigation requires an OS sandbox, approval gate, command allowlist, or egress allowlist are accepted threat-model risks."*
- The product **does** enforce deterministic boundaries around files it writes itself: project paths must be relative/non-traversing/non-symlink; run artifacts redact secret-looking values before persistence; materialization requires explicit selected copies + confirmation and rejects patches; clean removes only generated `.ultrafuzz/**` selections.

Consequently, this audit does **not** report agent-driven command execution, arbitrary file reads, or SSRF as vulnerabilities — those are explicitly accepted. It audits (a) the product's **own claimed guarantees** (path safety, redaction, materialize/clean scoping) and (b) the **loopback dashboard** as the only remotely-addressable surface. This is the correct application of the method's "unless documentation explicitly designates specific inputs as trusted, apply broad interpretation" rule: here the documentation *does* designate the trust model, so the boundary shifts to the product's promises.

### 2.3 Methodology executed
- **Codebase discovery & architecture mapping** (Section 3).
- **Input enumeration** (Section 4) and **sink identification** (Section 5), including running the method's `scripts/find_sinks.py` over `packages/` (6,784 raw pattern hits; triaged — overwhelmingly `path.join`/`JSON.parse` false positives).
- **Forward analysis** (input → sink) and **backward analysis** (sink → input) on the dashboard HTTP handlers, the `@ultrafuzz/security` primitives, the redaction pipeline, and all `child_process` call sites.
- **Verification with confidence scoring** (Section 7): each candidate was manually traced end-to-end and checked against framework protections. (The method's "sub-agent validation" step was performed as independent manual re-verification passes within this executor; no separate agents were spawned.)

---

## 3. Architecture Overview

Operator-driven CLI/dashboard orchestrator. The operator runs Ultrafuzz against a **target repository** (potentially untrusted third-party smart-contract code) and reviews results. AI **agents** execute in worktrees with permissions bypassed (accepted). Artifacts persist under `.ultrafuzz/runs/**` and a `smithers.db` control-plane store. A **loopback dashboard** renders run state and findings to the operator's browser.

### 3.1 Data-flow diagram
```mermaid
graph LR
  OP[Operator browser] -->|HTTP loopback 127.0.0.1:3875| DASH[Dashboard HTTP server]
  TR[Untrusted target repo] -->|files, git| RT[Runtime / plan-run]
  AG[AI agents skip-permissions] -->|artifacts, evidence, stdout| FS[(.ultrafuzz/runs artifacts + smithers.db)]
  RT --> FS
  FS -->|read + schema-validate| DASH
  DASH -->|redact events/state, JSON, React-escaped| OP
  RT -->|execFile git, no shell| GIT[git]
  MOD[modal cloud workers] -->|fail-closed redaction| PUB[Public benchmark bundle]
```

### 3.2 Trust-boundary diagram
```mermaid
graph TB
  subgraph Untrusted
    U1[Remote web pages in operator browser]
    U2[Target repository content]
    U3[Agent-produced artifacts/findings]
  end
  subgraph Accepted-risk trusted-local
    A1[Agents: commands, FS, network]
  end
  subgraph Product-enforced boundary
    P1[Path policy: no traversal / no symlink]
    P2[Redaction before persistence]
    P3[Materialize/clean scoping]
    P4[Dashboard: loopback + CSP + session token]
  end
  U1 -.CSRF/DNS-rebinding.-> P4
  U2 -.path handling.-> P1
  U3 -.render / disclosure.-> P4
  U3 -.disclosure.-> P2
  A1 --> P1
```

### 3.3 Attack-surface map
| Entry point | Reachability | Primary risk classes | Posture |
|---|---|---|---|
| Dashboard `/api/*` (GET) | Loopback only | Info disclosure, CSRF, DNS-rebinding | Hardened |
| Dashboard `/api/*` (PUT/POST mutations) | Loopback + session token | CSRF, path traversal, unsafe writes | Hardened |
| Dashboard static `/dashboard/*` | Loopback | Path traversal | Hardened |
| Runtime path/artifact I/O | Local + target-influenced | Traversal, symlink escape, TOCTOU | Paranoid-grade |
| `child_process` (git etc.) | Local | Command / argument injection | No shell; argv arrays |
| Redaction pipeline | Pre-persistence | Secret disclosure | Broad; fail-closed on public path |

---

## 4. Input Inventory (abridged)
- **Dashboard HTTP:** URL path segments, query, method, `Host`/`Origin`/`Sec-Fetch-Site`/`x-ultrafuzz-session` headers, JSON bodies (config TOML, topology YAML, prompt markdown, command args, materialize copy selections, clean selections). All body parsing via `parseStrictJsonBytes` with depth/item/property caps and a 1 MiB limit.
- **Filesystem inputs:** run IDs, node IDs, artifact relative paths, prompt relative paths, target-repo file contents, benchmark repository URLs.
- **Persisted-then-served:** events, run state, findings/report artifacts, `stdout.log`/`stderr.log`, `prompt.rendered.md`.

## 5. Sink Inventory (triaged)
- **HTML/DOM (XSS):** React 19 JSX interpolation only; **no** `innerHTML`/`outerHTML`/`dangerouslySetInnerHTML`/`document.write`/`v-html` in the dashboard tree. `MarkdownPreview` (`frontend/src/main.tsx:2876`) renders line-by-line into escaped React elements.
- **SQL:** persistence is JSON files + Effect-SQL/SQLite via the vendored smithers control plane; no string-concatenated SQL observed on product-controlled input paths.
- **Command:** `execFileSync`/`spawn`/`spawnSync`/`execFile` with argument arrays across artifacts/evals/evmbench/modal — **no shell**.
- **Path:** `assertPathInside`, `assertNoSymlinkComponents`, `safeResolveInside`, `normalizeSafeRelativePath`, `listSafeFiles`, `writeFileDurable`/`createFileDurableExclusive` (`O_NOFOLLOW`, hard-link/inode rechecks).
- **Template:** prompt rendering = regex substitution (`packages/prompts/src/render.ts:471`), fixed variable allowlist.

---

## 6. High-Confidence Findings (confidence ≥ 80, exploitable)

**None.** No input reaches a dangerous sink without adequate framework/product protection in the audited scope.

---

## 7. Findings and Verification Detail

### L-01 — Heuristic redaction does not fully satisfy the "redact secret-looking values before persistence" claim (Low; confidence ~70 that the gap is real)
**Class:** CWE-312/CWE-532 (sensitive data at rest / in logs).
**Location:** `packages/security/src/sensitive-redaction.ts`.
**Trace:** `redactSecretsInValue` (lines 83-98) redacts a string only if its **key name** matches `isSensitiveKeyName` (16-36, fixed substring vocabulary) **or** its **value** matches `isSensitiveSecretValue` (38-56). Value matching relies on `SECRET_PATTERNS` (3-14) — a fixed set of vendor-prefixed token shapes (`sk-`, `sk-ant-`, `gh[opusr]_`, `github_pat_`, `glpat-`, `hf_`, `xox[baprs]-`, `AKIA/ASIA`, a JWT shape, and PEM blocks) plus `Bearer`/`url://user:pass@`/`key=` inline forms. A secret that (a) is not under a sensitive key name and (b) does not match a known shape — e.g. a 40-hex-char database password stored as an array element or under a key like `value`/`note`, a bespoke vendor token, or a seed phrase not in PEM form — passes through unredacted.
**Measured against:** `docs/security.md:18-22` — "Run artifacts redact secret-looking values before persistence." This reads as a guarantee; the implementation is best-effort.
**Why not higher:** Under the trust model, persisted artifacts live locally; the operator already has host access. The genuine cross-boundary path (public benchmark publication) is **fail-closed**: `packages/modal/src/public-bundle.ts:143` throws if `redactSecretsInText(text) !== text`. So real disclosure risk is contained.
**PoC (illustrative):** persist `{ "reproducer": "db=postgres://svc:9f83b1c4e77a4d2f@10.0.0.5/app" }` — the `url://user:pass@` rule redacts the password; but `{ "reproducer": "9f83b1c4e77a4d2f0aa12bd6" }` (a bare 24-hex-char token under a non-sensitive key) is persisted verbatim.
**Recommendation:** Document the heuristic limits in `docs/security.md`; prefer field-allowlisting for persisted structures; extend the fail-closed model to any artifact that can leave the host; optionally add entropy-based detection.

### L-02 — Dashboard serves stdout/stderr/rendered-prompt verbatim without read-time redaction (Low; confidence ~60)
**Class:** CWE-532 (information exposure through logs).
**Location:** `packages/dashboard/src/index.ts:844-846` (reads `stdout.log`/`stderr.log`/`prompt.rendered.md`) and `:795-796` (returned as node-detail `stdout`/`stderr`/`rendered_prompt`).
**Trace:** `artifactEntriesForAttempts` reads these files with `readTextIfExists` and returns them without `redactSecretsInText`. By contrast, agent evidence stdout is wrapped in `redactedEvidenceText` (`packages/runtime/src/smithers.ts:1788,2233`), and events/state are redacted (`events.ts:1198`, `state.ts:463`). No product source writes these `.log` files (they originate from the agent/control-plane), so they are outside the redaction pipeline.
**Why low:** Endpoint is loopback-only and CSRF-guarded (`requireLocalRequest`), so exposure is to the operator, who already has filesystem access. Impact is a **consistency gap** with the stated posture, not a cross-boundary leak.
**Recommendation:** Apply `redactSecretsInText()` on read for these fields, or explicitly document them as raw operator-only content; route through fail-closed redaction if ever materialized/shared.

### I-01 — Two `validateSafeId` functions with swapped argument order and different return contracts (Informational)
**Location:** `packages/security/src/path-policy.ts:16` — `validateSafeId(label, id): PolicyResult<string>` (never throws; caller must inspect diagnostics). `packages/artifacts/src/safe-paths.ts:22` — `validateSafeId(value, label='id'): string` (throws on invalid).
**Risk:** All present call sites are consistent (consumers use the artifacts variant with `(value, label)`; the security variant is used only in `materialize-policy.ts` with `(label, id)`). But the identical name + inverted convention is a latent validation-bypass footgun: a future caller importing the security variant but passing `(value, label)` would validate the constant label, ignore the real id, and — since the result is a `PolicyResult` that must be checked rather than thrown — could proceed with an unvalidated id into path building.
**Recommendation:** Rename one (e.g. `validateSafeIdOrThrow`), and/or consolidate to a single implementation; lint against discarding the `PolicyResult`.

### I-02 — `requireLocalRequest` fails open on a missing Host header (Informational)
**Location:** `packages/dashboard/src/index.ts:1658-1662` — `if (host && !isLoopbackAuthority(host))`. A request omitting Host bypasses that check.
**Risk:** Not remotely exploitable — browsers always send Host (DNS-rebinding requests therefore carry the attacker domain and are rejected), Origin (1663-1666) and Sec-Fetch-Site (1667-1670) checks still apply, and non-browser local clients are already trusted. Robustness note only.
**Recommendation:** Fail closed by rejecting API requests without a present loopback Host header.

---

## 8. Documented False Positives / Verified Mitigations (confidence < 20 of being vulnerable)

1. **XSS (dashboard) — Protected.** React 19 auto-escaping; no dangerous DOM sinks (grep across dashboard tree returns none); `MarkdownPreview` renders untrusted markdown as escaped React text (`frontend/src/main.tsx:2876-2900`). Strict CSP (`index.ts:174-193`): `default-src 'none'`, `script-src 'self'`, `object-src 'none'`, no `unsafe-inline` for scripts (`style-src-attr 'unsafe-inline'` permits only style attributes). Defense-in-depth even if a sink were introduced.
2. **CSRF / DNS-rebinding (dashboard) — Protected.** Loopback bind enforced (`validateLoopbackHost`, 1651-1656). `requireLocalRequest` (1658-1671) rejects non-loopback `Host`, non-loopback `Origin`, and `Sec-Fetch-Site: cross-site`. Mutations additionally require a 32-byte session token compared in constant time (`requireMutation`/`constantTimeEqual`, 1673-1698), obtainable only over loopback. DNS-rebinding is defeated by the Host-header loopback check.
3. **Command injection — Protected.** All subprocess calls use `execFileSync`/`spawn`(`Sync`)/`execFile` with argument arrays (no shell) — e.g. `packages/artifacts/src/invariant-source-pin.ts`, `packages/evals/src/lineage.ts`, `packages/evmbench/src/runner.ts`, `packages/modal/src/*worker*.ts`. Git calls that take user/target-influenced paths correctly use `--` separators (`ls-files --error-unmatch -- <path>`, `diff --quiet HEAD -- <path>`). The one call lacking `--` (`git ls-remote <repository> HEAD`, `packages/evmbench/src/definition.ts:124`) is protected by `evmbenchPublicSnapshotRepositorySchema` (`contracts.ts:38-42`: `^https://github\.com/evmbench-org/[A-Za-z0-9_.-]+\.git$`), which forbids any leading `-`, so `--upload-pack=`-style argument injection is unreachable.
4. **Path traversal / symlink escape — Protected (strongest area).** `packages/artifacts/src/safe-paths.ts` and `packages/security/src/path-policy.ts` implement lexical relative-path validation, `assertPathInside`, `assertNoSymlinkComponents` (per-component `lstat` symlink walk), `safeResolveInside`, `listSafeFiles` (rejects any symlink), and durable writes with `O_NOFOLLOW` + inode/dev/size/mtime + hard-link rechecks (`readSinglyLinkedRegularFileSnapshotInside`). Dashboard static serving rejects `..`/`\` and re-checks `assertPathInside` (`index.ts:1786-1803`). Materialize/clean policies (`packages/security/src/materialize-policy.ts`) restrict sources/destinations to allowed roots, reject globs, `.git`, `.env`/`secrets`/`.ssh`/`.aws`, and `.ultrafuzz` destinations, reject patches, and require confirmation.
5. **SSTI / template injection — Protected.** Prompt rendering is `replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, ...)` against a fixed `SUPPORTED_TEMPLATE_VARIABLES` allowlist (`packages/prompts/src/render.ts`); no `eval`/`Function`/`vm`/template-engine evaluation.
6. **SQL injection — No evidence in scope.** Product state/artifacts are JSON with strict parsing; the `smithers.db` store is accessed through the vendored Effect-SQL control plane, not string-built queries on product input paths. (See Limitations.)

---

## 9. Validation Coverage Matrix
| Input | Reaches sink? | Protection verified |
|---|---|---|
| Dashboard JSON body | schema-validated write / RPC | `parseStrictJsonBytes` caps + `assertDashboardHttpDocument` + session token |
| runId / nodeId | filesystem path build | `validateSafeId` (artifacts) + `assertPathInside`/`assertNoSymlinkComponents` |
| prompt relative path | file write | `normalizePromptRelativePath` + `safeResolveInside` + `assertPathInside` |
| target repo file paths | artifact listing/read | `listSafeFiles` symlink rejection + `O_NOFOLLOW` reads |
| benchmark repository URL | `git ls-remote` argv | strict `https://github.com/evmbench-org/*.git` schema |
| findings/report/markdown | dashboard render | React auto-escape + CSP |
| events/state/config/report | persistence | `redactSecretsInValue`/`redactSecretsInText` (heuristic — see L-01) |
| stdout.log/stderr.log | dashboard node-detail | **none at read time — see L-02** |

---

## 10. Recommendations
**Short-term (low effort):** (I-01) rename/consolidate `validateSafeId`; (I-02) reject API requests lacking a loopback Host; (L-02) redact stdout/stderr/rendered-prompt on read or document as raw.
**Medium-term:** (L-01) document redaction as best-effort in `docs/security.md`, move persisted structures toward field-allowlisting, and consider entropy-based secret detection; extend the fail-closed publication check to any artifact that can leave the host.
**Keep doing:** the loopback+CSP+session-token dashboard model, the `O_NOFOLLOW`/inode-recheck path layer, no-shell subprocess execution, and fail-closed public-bundle redaction are exemplary — preserve them under refactors (add regression tests asserting the CSP header set and the Host/Origin/Sec-Fetch-Site checks).

---

## 11. Limitations
- Static analysis at a single commit; no runtime/dynamic testing was performed (read-only, non-destructive mandate).
- The vendored **smithers** control plane and its `smithers.db` Effect-SQL access, and the full **modal** cloud-worker package (~20.7K LOC), were surveyed but not exhaustively line-audited; a dedicated review of every Effect-SQL statement is advisable to fully close the SQLi question.
- The writer of dashboard-served `stdout.log`/`stderr.log` was not located in product source; L-02 is framed conditionally (impact holds *if* those files can contain secrets).
- Redaction bypasses (L-01) are demonstrated by construction, not by locating a specific in-repo secret leak.
- "Sub-agent validation" from the method was performed as manual re-verification within this executor rather than as spawned agents.
