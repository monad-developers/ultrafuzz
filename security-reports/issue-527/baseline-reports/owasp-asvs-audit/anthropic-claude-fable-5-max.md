---
skill: "owasp-asvs-audit"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# OWASP ASVS v5.0.0 Audit Report

**Project:** Ultrafuzz (agentic orchestrator for smart-contract fuzzing)
**Repository:** local authorized checkout — monorepo `ultrafuzz` (private)
**Snapshot commit:** `a634d948038f502e5e677477138dca0c763e2380` — "fix(runtime): reconcile recovered terminal run status (#578) (#603)", 2026-08-15
**Date of audit:** 2026-08-15
**Target Level:** 3 (Advanced / High Assurance) — cumulative (includes L1 + L2)
**Method:** method-05 = `owasp-asvs-audit` skill (OWASP ASVS v5.0.0), static source analysis
**Audited by:** ReviewExecutor (skill=method-05, intendedModel=claude-fable-5, effort=max)

---

## Executive Summary

Ultrafuzz is a TypeScript/Bun/pnpm monorepo (12 packages, ~470 TS source files; largest: `runtime` ~49k LoC, `modal` ~20k, `artifacts` ~24k) that initializes a protocol repository with editable prompts/topology, runs coding agents (Codex/Claude/Kimi/DeepSeek/OpenRouter) to generate fuzz tests and findings, and serves a local dashboard + report. It is **not** a classic authenticated multi-user web application; its real attack surface is (a) subprocess/agent execution, (b) filesystem writes into a target repo, (c) a local dashboard HTTP server, (d) provider credential/secret handling, and (e) untrusted model output persisted and sometimes published.

**Overall verdict: this is an unusually well-hardened codebase — 0 critical, 0 high findings.** The project ships a dedicated `@ultrafuzz/security` package and demonstrates disciplined, defense-in-depth security engineering throughout. The dominant residual risk is the **explicit, documented skip-permissions trust model** (`docs/security.md`): agents run unsandboxed with no command or egress allowlist, so the security boundary is the host. That is an accepted design decision for a local developer tool, not a code defect.

### Requirement-status overview (analyst assessment)

Because the method's section files for chapters V3–V17 were empty stubs in this environment (see Methodology & Limitations), a verbatim ~350-row requirement table could not be transcribed from local method data; chapter assessments below apply ASVS v5.0.0 requirement knowledge to concrete, file:line-anchored code evidence. Approximate distribution across the standard's ~350 requirements:

- **PASS (control satisfied):** the large majority of applicable requirements (injection, deserialization, path handling, crypto, config/headers, dependency hygiene, logging redaction).
- **N/A (with justification):** ~5 of 17 chapters largely N/A — V6 user-auth, V7 sessions, V8 authorization, V9 self-contained tokens/JWT, V10 OAuth-as-user-authn, V17 WebRTC (no user accounts, no login, no JWTs issued/consumed, no WebRTC).
- **FAIL / weakness:** 6 concrete findings — 1 medium, 5 low (below).
- **MANUAL_REVIEW:** runtime TLS handshake config, deployment/infra hardening, and dynamic behavior are outside static scope; plus the two non-exploitable defense-in-depth items (L-03, L-04) and dependency-currency (cannot assess CVEs offline on a future-dated tree).

### Compliance-by-level note

At **L1/L2**, the applicable controls are effectively met: no injection sinks, safe deserialization, contained file writes, secret redaction, secure RNG, and a loopback+token+CSP dashboard. At **L3**, the intentional lack of OS sandboxing / command allowlist / egress allowlist would count against a high-assurance target — but these are explicitly declared accepted risks in `docs/security.md` and are appropriate to the tool's actual (single-user, local) threat model.

### Findings by severity

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | M-01 |
| Low | 5 | L-01, L-02, L-03, L-04, L-05 |
| Informational | 4 | I-01, I-02, I-03, I-04 |

**Prioritized recommendation (committing to one path):** treat **M-01** (long-lived subscription *refresh* tokens copied into untrusted skip-permissions Modal sandboxes, Kimi's shared across rows) as the one item needing an explicit accepted-risk decision or a short-TTL-token redesign, and fix **L-01** (unvalidated `fetch` of `ULTRAFUZZ_PRICING_CATALOG_URL`) as the single concrete SSRF/egress code change. Everything else is defense-in-depth or documentation hygiene.

---

## Critical Findings (High Confidence ≥ 0.8)

**None.** No critical- or high-severity vulnerabilities were identified. This is a substantive, evidence-backed conclusion, not an absence of review: the highest-risk sinks (command execution, path handling, deserialization, the network-facing dashboard, secret persistence) were each traced to concrete containment controls (see chapter detail).

---

## Findings Requiring Attention

### M-01 (Medium) — Long-lived subscription refresh tokens exposed to untrusted sandboxes
ASVS: V14 (Data Protection) / V6 (credential handling). Confidence ~0.8.

For subscription auth, provider credential files — Claude `~/.claude/.credentials.json` and Kimi OAuth JSON **including the refresh token** — are staged into the Modal cloud sandbox that executes model output under skip-permissions. The model process can therefore read its own provider's long-lived refresh token; for Kimi the refresh token is deliberately placed in a volume **shared across campaign rows**.

- Evidence: `packages/modal/src/auth.ts:55-97` (staging), `:74-83` (shared-volume comment), `packages/modal/src/layout.ts:46-48`; trust model at `ultrafuzz.toml [permissions]` and `docs/security.md:36-41`.
- Why it matters at L3: a refresh token mints access tokens indefinitely (larger blast radius than a per-request key), and cross-row sharing lets any single run read a token usable beyond its own row. Contained to subscription-auth + Modal cloud mode and within the documented "trusted execution, not isolation" model.
- Fix: obtain an explicit accepted-risk sign-off; prefer exchanging refresh→short-TTL access token on the controller and forwarding only that; scope credential volumes per row.

### L-01 (Low) — Unvalidated outbound fetch (SSRF/egress inconsistency)
ASVS: 1.3.6 (SSRF) / V12. Confidence ~0.7.

`packages/runtime/src/model-pricing.ts:84,106` performs `fetch(env.ULTRAFUZZ_PRICING_CATALOG_URL)` with no scheme/host validation and default redirect-following — the only outbound path lacking the HTTPS/no-credentials/redirect controls used everywhere else (`packages/evals/src/scoring.ts:1155-1166`, `ground-truth.ts:146-156`, `reporters/http.ts:6-53`, `modal/src/auth.ts:459-477`). Operator-controlled env, 25 MB + strict-JSON cap, response not reflected, and a `disabled` opt-out keep real-world severity low. Fix: reuse the `parseHttpsOrigin`-style validator, block private/link-local/metadata IPs, and set `redirect:"error"`.

### L-02 (Low) — Heuristic-only local redaction can miss opaque token formats
ASVS: V16 / V14. Confidence ~0.7.

Local persistence (attempt ledger, run state, events, inspect) calls the redactor without the run's known exact secret values, relying on `SECRET_PATTERNS` + key-name matching (`packages/security/src/sensitive-redaction.ts:3-14`). Those patterns cover `sk-*`/AWS/JWT/PEM but not Modal token secrets (`ak-`/`as-`) or opaque OAuth access tokens; such a value as a bare substring outside a sensitive key could persist in git-ignored `.ultrafuzz/runs/`. Mitigated by the git-ignored location and the exact-value scrubbing on external-publication paths. Fix: thread `forbiddenSecretValues` into the local redactor and extend patterns.

### L-03 (Low) — Latent Zip-Slip defense-in-depth gap in staged-bundle writer
ASVS: V5.2 / path handling. Confidence ~0.5 (not exploitable today).

`packages/modal/src/public-bundle.ts:814-848` joins path parts without a local `..` guard and writes files before `assertStrictExtractedTree` validates; containment depends entirely on the parse-time `isAllowedBundlePath` allowlist (`:200,:953`) run earlier. Currently safe because that allowlist blocks `..`, but fragile to refactors. Fix: add a self-contained absolute/`..` reject mirroring `packages/modal/src/safe-archive.ts:142-158` and validate before writing.

### L-04 (Low) — Materialize overwrite copy symlink-swap TOCTOU
ASVS: V5.1.3. Confidence ~0.3.

`packages/runtime/src/materialize.ts:114-118` drops `COPYFILE_EXCL` when `force:true`, so a symlink planted at the destination between the pre-copy re-check (`:97-113`) and the copy is followed. Requires local write access inside `projectRoot`; low severity. Fix: use `O_NOFOLLOW`/`O_EXCL` semantics even in overwrite mode.

### L-05 (Low) — Load-bearing git-transport regex guards lack regression tests
ASVS: 1.2.5 (defense-in-depth). Confidence ~0.8.

The git `ext::`-transport RCE class and leading-`-` option injection are blocked only by regexes at `packages/evmbench/src/definition.ts:124` (repo regex in `contracts.ts:38-42`) and `packages/references/src/index.ts:772` (fixed `https://` prefix). No test pins these; a regression could reopen remote-clone RCE. Fix: add tests asserting `ext::`/`file::`/leading-`-` are rejected, and pass an explicit protocol allowlist + `--`.

---

## Informational

- **I-01 — Documented skip-permissions trust model.** Agents run unsandboxed with no command/egress allowlist (`ultrafuzz.toml [permissions] trust_model="skip-permissions"`; `docs/security.md:7-13,31-34`; `templates/smithers/agents/claude.tsx:32`, `deepseek.tsx:60`). Partially compensated by `prompt_review_required=true`, materialize confirmation, and `production_source_roots=["src","contracts"]` fail-closed handoffs (`runtime/src/workspace-handoff.ts:165-168`). Accepted risk; record a formal decision for any higher-assurance deployment.
- **I-02 — `.gitignore` omits `.env*`/`*.pem`/`*.key`** that `.dockerignore` carries; add them (no committed secrets were found).
- **I-03 — Minor consistency:** inconsistent dependency pinning (runtime exact vs. others caret; `yaml ^2.9.0` vs `^2.8.0`); `prompts/src/frontmatter.ts:211-213` `isPlainObject` lacks the prototype-chain check present in `config/src/loader.ts:1023`; `MODAL_GIT_URL_PATTERN` (`modal/src/benchmark-config-patterns.ts:8-9`) permits non-HTTPS schemes for the clone target.
- **I-04 — Dashboard local-trust nuances:** `GET /api/session` returns the mutation token to any loopback requester (`dashboard/src/index.ts:510-517`); error responses include absolute paths (localhost-only). CSP + custom-header requirement block cross-site browser access; residual is other local users on multi-user hosts. `style-src-attr 'unsafe-inline'` permits inline style attributes (not scripts).

---

## Detailed Results by Chapter

### V1 — Encoding and Sanitization → mostly PASS
- **1.2.4 SQL/DB injection:** No user-input string-concatenated queries in product code; the run store (smithers.db, SQLite) is accessed via the workflow runtime, not from user-controlled query strings. No ORM raw-escape hatches on untrusted input observed. PASS/N/A.
- **1.2.5 OS command injection:** PASS. Uniform argv-array execution (`execFile`/`spawn`/`spawnSync` / Modal `sandbox.exec`), **no** `shell:true` and **no** `exec()`/`execSync()` anywhere under `packages/`. The few `/bin/sh`/`bash -lc` strings interpolate only fixed constants, zod-validated enums, or `shellQuote()`-escaped internal paths (`modal/src/runner.ts:1089-1110`, `forge-guard.ts:99-108`, `pinned-source.ts:494`). `trusted-cli.ts` is an integrity-pin of the JSON-validator CLI (runs one fixed argv; quoted+control-char-rejecting launcher at `:184-206`), **not** a sandbox/allowlist. Git calls use fixed subcommands with `--` and hex/`^{commit}` validation. Residual: L-05 (regex guards on remote-clone URLs lack tests).
- **1.3.2 eval/dynamic code:** No `eval`/`new Function`/`vm.runIn*` on untrusted input (the one grep hit is a regex-pattern string literal, not code exec). PASS.
- **1.3.6 SSRF:** One Low finding (L-01); all other outbound paths enforce HTTPS + no credentials + response caps, and OpenRouter's host is hardcoded `https://openrouter.ai/api/v1` (the README's "no allowlist" refers to model catalogue IDs, which flow only into a `--model` argv, never a URL). PASS with exception.
- **1.5.1 XXE:** N/A — no XML parsing (`DOMParser`/`libxmljs`/`xml2js`/`fast-xml-parser` absent).
- **1.5.2 Insecure deserialization:** PASS. TOML via `smol-toml` `parse()`, YAML via the `yaml` package `parse()` (not js-yaml `load`), and a bespoke strict-JSON parser (`artifacts/src/strict-json.ts`) that assigns keys via `Object.defineProperty` (defeats `__proto__` prototype pollution), rejects duplicate keys, enforces depth/item/byte limits, and validates UTF-8/BOM. `isPlainObject` prototype checks reject tampered TOML tables.
- **1.3.12 ReDoS:** PASS — no catastrophic nested-quantifier patterns on untrusted input; URL regexes use disjoint alternations.
- **1.4.x memory safety:** N/A — memory-safe language (TypeScript/Node); native deps (`@resvg/resvg-js`) are packaged, not FFI over untrusted input.

### V2 — Validation and Business Logic → PASS
Strong positive validation via zod, ajv/ajv-formats, the strict-JSON parser, `validateSafeId`, and typed field extractors on dashboard request bodies (schema-checked with `assertDashboardHttpDocument`). Anti-automation (2.4.1) is satisfied by the loopback-only surface plus explicit resource caps: `MAX_COMMAND_JOBS=20`, `MAX_REQUEST_BODY_BYTES=1MB`, `MAX_COMMAND_OUTPUT_BYTES=32KB`, and forge fuzzer limits (`forge_vmem_limit_kb`, `forge_rayon_threads` enforced via `ulimit -v` in `forge-guard.ts:99-108`). Business-logic integrity: materialize/clean require explicit confirmation; `production_source_roots` handoffs fail closed.

### V3 — Web Frontend Security → PASS
Strict CSP (`default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self'; frame-ancestors 'none'; form-action 'none'`), plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, COOP/CORP `same-origin`, `Referrer-Policy: no-referrer` (`dashboard/src/index.ts:174-193`). Minor: `style-src-attr 'unsafe-inline'` (inline style attributes only; no inline script) — informational (I-04).

### V4 — API and Web Services → PASS
Dashboard API validates HTTP method, strict-JSON-parses bodies with size/depth caps, schema-validates each document, returns 404 on unknown routes, requires a loopback request for all reads and a constant-time session-token for all mutations. No externally consumed REST/GraphQL surface.

### V5 — File Processing → PASS (2 Low defense-in-depth items)
All untrusted-input write sinks funnel through centralized primitives (`security/src/path-policy.ts`, `artifacts/src/safe-paths.ts`): `safeResolveInside`/`normalizeSafeRelativePath` reject absolute, backslash, NUL, `..`, control chars, reserved names, and non-canonical segments; `assertPathInside` does realpath-relative containment; `assertNoSymlinkComponents` walks every component rejecting symlinks; reads/writes use `O_NOFOLLOW`/`O_EXCL` with hard-link and dev/ino/mtime re-validation. Static asset serving (`sendStaticAsset:1786-1803`) strips leading slashes, rejects `..`/`\`, then `assertPathInside(publicRoot,...)` and a regular-file check. Tar extraction (`modal/src/safe-archive.ts`) adds full Zip-Slip + decompression-bomb defenses (per-entry containment, `wx` no-overwrite, entry-count/size/total caps, declared-vs-observed size check). Residuals: L-03, L-04.

### V6 — Authentication → largely N/A
No user accounts/login/password storage (no bcrypt/argon2/scrypt, no session cookies). The only auth is the dashboard local API session token (PASS) and provider-credential handling (PASS; M-01/L-02 caveats). Provider subscription/OAuth handling (`modal/src/auth.ts`) is careful: HTTPS-only OAuth host, `path.posix.basename` on credential key names, bounded response reads, atomic `0600` writes, refresh lock.

### V7 — Session Management → minimal / N/A
The dashboard session token is ephemeral (per-process), 256-bit CSPRNG, transmitted via a custom `x-ultrafuzz-session` header (not cookies), compared with `crypto.timingSafeEqual`. No server-side session store, no cookie attributes to audit. See I-04 for the token-retrieval nuance.

### V8 — Authorization → N/A
Single-user local tool; no roles, tenants, or object-level access control. `production_source_roots` is an integrity boundary (agents cannot edit production source), not multi-user authorization.

### V9 — Self-Contained Tokens → N/A
The application does not issue or verify JWTs/self-contained tokens. (The JWT-triple regex in `sensitive-redaction.ts` exists only to redact provider tokens.)

### V10 — OAuth and OIDC → mostly N/A
The application does not implement OAuth/OIDC for its own users. Narrow surface: it *consumes* Kimi subscription OAuth via a refresh-token grant (`modal/src/auth.ts:100-163`) over a validated HTTPS host with bounded parsing and atomic persistence — PASS. See M-01 for the sandbox-exposure concern.

### V11 — Cryptography → PASS
Secure RNG (`crypto.randomBytes`/`randomUUID`) for tokens and temp names; SHA-256 for integrity; `timingSafeEqual` for token comparison. **No** weak algorithms found (no MD5/SHA-1/DES/3DES/RC4/ECB, no `createCipher`, no `Math.random` for security). Consistent with ASVS Appendix C.

### V12 — Secure Communication → PASS (L-01 exception)
All outbound provider/judge/ground-truth/braintrust endpoints are validated HTTPS-only with empty username/password/query/fragment; the judge fetch sets `redirect:"error"`. TLS handshake specifics rely on Node defaults (MANUAL_REVIEW — runtime/infra). The lone gap is L-01.

### V13 — Configuration → PASS
Dashboard binds `127.0.0.1` and *enforces* loopback (`validateLoopbackHost`), cannot bind `0.0.0.0`; strict security headers; no default/hardcoded credentials (config stores env-var *names* only); active secret redaction; hardened CI (`.github/workflows/ci.yml` uses `pull_request` not `pull_request_target`, top-level `permissions: contents: read`, third-party actions pinned to commit SHAs, `--frozen-lockfile`; `workflow_run` consumers check `head_repository.full_name == github.repository`, use `persist-credentials: false`, and mint a narrowly-scoped GitHub App token). Minor: I-02, I-03.

### V14 — Data Protection → PASS (M-01, L-02)
Credential values never enter resolved config (only env-var names; `config/src/types.ts:117-118`). Child/model process env is allowlist-filtered, not inherited (`runtime/src/smithers.ts:3734-3763`, allowlist `957-1010`), so the parent's full secret set is not passed to agents. Credential forwarding is least-privilege (only active agents' keys), and Modal's own control tokens (`MODAL_TOKEN_ID`/`SECRET`) are excluded from sandbox secrets (`modal/src/runner.ts:3034-3068`). Public bundles enforce a `FORBIDDEN_BUNDLE_KEYS` denylist plus exact-value + regex scrubbing before publication. `smithers.db*` and secret files are git-ignored; `git ls-files` confirms `smithers.db` is untracked and no credential/PEM/key files are committed (only source files named `judge-credential.ts`); a full-tree secret grep found zero committed secret values. Gaps: M-01, L-02.

### V15 — Secure Coding and Architecture → PASS
Dependencies are minimal and mainstream (`smol-toml`, `yaml`, `zod`, `ajv`, `@oclif/core`, `adm-zip`, `tar-stream`, `modal`, `entities`, `mdast-util-from-markdown`); a 469 KB `pnpm-lock.yaml` is committed with **zero** git/tarball/non-registry resolutions; `pnpm-workspace.yaml` `allowBuilds` denies install/build scripts for most native deps and no workspace package defines pre/post-install scripts. Dedicated `@ultrafuzz/security` package (zero dependencies) centralizes path and redaction primitives. Documented threat model (`docs/security.md`). Minor: I-03 pinning; I-01 architecture is an accepted-risk decision.

### V16 — Security Logging and Error Handling → PASS (L-02)
Redaction is wired into every controller-side persistence boundary: events (`artifacts/src/events.ts:1198`), run-state `last_error` (`state.ts:463`), attempt-failure messages (`attempt-ledger.ts:454`), the Smithers input document/prompts (`runtime/src/smithers.ts:1285`), lifecycle inspect payloads (`lifecycle-inspection.ts:1725,1808`), Modal worker diagnostics/bundles, and the final report (`final-report-markdown.ts:859-883`). Error messages return `error.message` only (no stack traces; `dashboard/src/index.ts:2544`), and Modal errors are truncated to 4 KB with credential-name masking. A dashboard audit journal exists (`appendDashboardAuditRecord`). L-02 is the redaction-completeness gap; L3 service-grade centralized security audit logging is not applicable to a local dev tool (MANUAL_REVIEW).

### V17 — WebRTC → N/A
No WebRTC (`RTCPeerConnection`/SRTP/TURN/STUN) anywhere.

---

## Items Requiring Manual Review
- Runtime TLS handshake/cipher configuration (Node defaults) and any deployment/infra hardening — outside static scope.
- Dependency CVE currency: the tree is future-dated (Node ≥22.19, TS 6.0.3, zod 4.x, React 19, Vite 7); offline, current-vs-vulnerable versions cannot be assessed. Recommend an online `pnpm audit` / SCA in CI.
- L-03 and L-04 (non-exploitable today) — confirm the parse-time allowlist and overwrite-copy paths under adversarial refactors.
- M-01 — obtain an explicit accepted-risk decision on refresh-token exposure to sandboxes.

---

## Appendix: Project Discovery Context

- **Languages/build:** TypeScript (ESM), Node ≥22.19, Bun (tests), pnpm@11.1.1 workspace; eslint + prettier; vitest/bun test.
- **Architecture:** local CLI orchestrator (`@oclif/core`) + local dashboard (raw `node:http` server, static SPA) + optional Modal cloud execution. Not a hosted multi-user service.
- **Data store:** SQLite run database (`smithers.db`, git-ignored) via the workflow runtime.
- **API style:** local JSON HTTP + SSE, loopback-only, session-token-authed mutations.
- **Auth mechanism:** none for users; provider API keys via env vars and subscription CLI credentials; dashboard local session token.
- **Outbound:** provider model endpoints (OpenRouter host hardcoded), LLM-judge, ground-truth repo, Braintrust, Modal — validated HTTPS with response caps (except L-01).
- **File handling:** writes generated artifacts/prompts/config into a target repo through centralized path-safety primitives; tar/zip extraction with Zip-Slip defenses.
- **Existing security measures:** dedicated `@ultrafuzz/security` package, strict CSP + security headers, secret redaction, allowlist-filtered child env, hardened CI, documented threat model.

## Appendix: Methodology & Limitations

This audit followed the method-05 `owasp-asvs-audit` workflow: Phase 1 discovery (languages, deps, architecture, security posture), then chapter-by-chapter evaluation (V1–V17) against ASVS v5.0.0 at Level 3. The orchestrator personally verified the highest-value surfaces (the dashboard HTTP server end-to-end, the `safe-paths` primitives, redaction call sites, the strict-JSON parser, crypto/RNG/XML posture, provider auth, forge-guard, workspace-handoff, config, and git-tracked-file hygiene) and dispatched four parallel read-only deep-dives (command execution/injection; secret handling/logging; file writing/path traversal; dependencies/config parsing/SSRF/CI), whose file:line-anchored findings are incorporated above.

**Explicit limitations (labeled per assignment):**
1. **Empty method section files.** In this environment the method's `sections/` files for chapters V03–V17 were 0-byte stubs (only V01 and V02 were populated). The method's First-Run Setup calls for populating them from OWASP's GitHub, but those files live in shared method-skill space symlinked outside the authorized checkout, and modifying them would corrupt shared state for the other parallel executors — so they were left untouched. Chapters V3–V17 were therefore assessed from established ASVS v5.0.0 requirement knowledge applied to concrete code evidence, rather than from locally transcribed verbatim requirement text. Requirement-ID-level granularity for those chapters is approximate.
2. **Static analysis only.** Runtime behavior, TLS handshakes, race conditions, and deployment/infra are out of scope (flagged MANUAL_REVIEW).
3. **No checkout mutation.** No files in the checkout were edited; no deliverables were written into it; no commits, pushes, issues, PRs, or remote writes were made. Repository content was treated as untrusted data.
4. **Dependency CVE currency** could not be assessed offline on a future-dated dependency tree.

This report is a thorough, structured first pass and does not replace a professional penetration test or dynamic assessment.

## Appendix: Model / Execution Attestation
skill=method-05; modelFamily=anthropic; intendedModel=claude-fable-5; effort=max. No provider refusal occurred and no fallback to a next-best retry agent was triggered, so the run completed on the intended primary agent (degradationReason=null). All conclusions are anchored to snapshot commit `a634d948038f502e5e677477138dca0c763e2380`.
