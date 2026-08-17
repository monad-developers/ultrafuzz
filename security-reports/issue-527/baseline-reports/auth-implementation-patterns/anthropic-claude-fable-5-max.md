---
skill: "auth-implementation-patterns"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Authentication & Authorization Implementation-Patterns Review (method-02)

- **Repository (local checkout):** ultrafuzz monorepo
- **Snapshot commit:** `a634d948038f502e5e677477138dca0c763e2380` (branch `main`, working tree clean)
- **Method:** method-02 — `auth-implementation-patterns-review` (SKILL.md)
- **Focus area:** none specified → broad authentication/authorization/credential review
- **Assessment type:** static (source + docs + non-destructive `git`/`grep`); no live server exercised
- **Intended model / effort:** claude-fable-5 / max (no provider refusal; intended primary executed)

---

## 1. Scope, method application, and limitations

Method-02 is a compliance review of authentication/authorization code against the JWT, session, OAuth2, RBAC, password, and secret-handling patterns and the 'Best Practices'/'Common Pitfalls' checklists embedded in `SKILL.md`.

**Important limitation — method assets absent.** The `method-02/` directory contains only `SKILL.md`. The resources it references (`references/jwt-best-practices.md`, `references/oauth2-flows.md`, `references/session-security.md`, `assets/auth-security-checklist.md`, `assets/password-policy-template.md`, `scripts/token-validator.ts`) are **not present**. I therefore applied the complete inline methodology from `SKILL.md` (patterns 1–3 for JWT/session/OAuth, RBAC/permission/ownership authorization, password/rate-limit security, the 10 Best Practices, and the 7 Common Pitfalls) and could not consult the ancillary deep-dive files.

**Nature of the target.** This repository is a CLI/agent-orchestration and smart-contract-fuzzing tool (packages: `artifacts`, `cli`, `config`, `dashboard`, `evals`, `evmbench`, `modal`, `prompts`, `references`, `runtime`, `security`, `topology`). It is **not** a multi-user web application: there is no user database, login/registration, password hashing, JWT issuance, or RBAC role model. Method patterns that presuppose those (Pattern 1 JWT login, Pattern 2 refresh-token store, session login/logout, OAuth callback token-in-URL, password schema/bcrypt, RBAC/permission middleware) have **no corresponding surface** and are marked N/A below. The applicable subset — session management, OAuth/provider-token handling, secret storage & redaction, CSRF, access-control/authorization, and input validation — was applied to the real surfaces.

**Other limitations.** No dashboard server was launched for live request/response testing; conclusions about CSRF/loopback behavior are derived from static reading of the request-handling code and its co-located tests. The test suite was not executed. Repository content was treated as untrusted data.

---

## 2. Authentication / authorization surface inventory

| # | Surface | File(s) | Role |
|---|---------|---------|------|
| 1 | Dashboard HTTP server | `packages/dashboard/src/index.ts` | Loopback control UI; session-token + CSRF gating; command execution |
| 2 | Provider OAuth / API-key auth | `packages/modal/src/auth.ts` | Copies/refreshes subscription OAuth tokens & API keys for cloud workers |
| 3 | Ephemeral judge-credential broker | `packages/modal/src/judge-credential.ts` | Parses a one-shot LLM-judge key; never persisted |
| 4 | Secret detection & redaction | `packages/security/src/sensitive-redaction.ts` | Redacts credentials before artifact/log persistence |
| 5 | Path-policy authorization | `packages/security/src/path-policy.ts` | Filesystem access control (symlink/traversal containment) |
| 6 | Agent-environment credential scoping | `packages/runtime/src/start-run.ts` | Allowlists which env vars (incl. API keys) reach agent subprocesses |
| 7 | Config credential indirection | `packages/config/src/{loader,agents,resolve}.ts` | Config stores env-var *names* (`api_key_env`), not key values |
| 8 | Eval reporter provider auth | `packages/evals/src/reporters/{braintrust,http}.ts` | Bearer-token calls with an endpoint-trust allowlist |

---

## 3. Findings

All findings are consistent with the explicitly documented **trusted-local-execution** threat model (`docs/security.md`). No critical, high, or medium issues were identified.

### L-01 (Low) — Dashboard session token is a CSRF control, not a same-host authentication boundary
The dashboard binds loopback only (`DEFAULT_HOST = '127.0.0.1'`, `validateLoopbackHost` ~L1651) and gates `/api/*` on `requireLocalRequest` (~L297/L1658 — Host/Origin/`sec-fetch-site` checks that also defeat DNS-rebinding). Mutations additionally require the 256-bit session token via `requireMutation` (~L1673) compared with `crypto.timingSafeEqual` (~L1694). **However**, `GET /api/session` returns the token to any caller that clears the loopback check (`session()` ~L510-517), and all read endpoints require no token. On a shared/multi-user host, any local HTTP client can read another operator's run data and, after fetching the token, `POST /api/commands/run` (→ `startRun`, ~L1325-L1350) to launch unrestricted agents, or `clean`/`materialize` (~L1393-L1411) to mutate the tree. Origin/CORS only blocks browser cross-site abuse, not direct local clients. This matches `docs/security.md` ('trusted local execution, not an isolation boundary') but is a genuine deviation from the method's 'authenticate every principal server-side' principle. **Mitigation:** keep the loopback bind; document the shared-host exposure; for multi-user support, authenticate read endpoints and replace the unauthenticated token GET with a filesystem-permissioned (0600, per-user) handshake or a unix-domain socket with ACLs.

### I-01 (Informational) — Unrestricted agent execution is an intentional, documented posture
`docs/security.md` states agents intentionally run with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`, and that OS-sandbox/command-allowlist/egress-allowlist gaps are **accepted** risks. Deterministic boundaries are still enforced around product-written files (path policy, secret redaction, materialize/clean confirmation). Surfaced only so the reader knows this is by-design, not an oversight. **Mitigation:** none required; keep the posture prominent and off shared/multi-tenant hosts.

### I-02 (Informational) — Session token has no expiry/rotation
`sessionToken` is minted once (`crypto.randomBytes(32)`, ~L255) and never expires/rotates for the process lifetime (method pitfall 'No Token Expiration'). Minimal risk (loopback, ephemeral, 256-bit, constant-time compare) but a token disclosed once (e.g., via the unauthenticated `/api/session`) stays valid until exit. **Mitigation:** optionally rotate/expire with silent refresh for long-lived sessions; low priority.

### I-03 (Informational) — Loopback-model deltas from two web-app best practices
Plaintext HTTP over loopback (`http.createServer` ~L222; method 'Use HTTPS') and no rate limiting (method 'Rate Limit Auth Endpoints'). Neither is exploitable in the loopback + 256-bit-token model. **Mitigation:** none for loopback; if ever proxied/exposed, terminate TLS and rate-limit at the proxy.

---

## 4. Strengths observed (method-checklist compliance)

A faithful review must record that the applicable controls are implemented well:

- **Session management (dashboard).** 256-bit `crypto.randomBytes` token; `crypto.timingSafeEqual` constant-time comparison (defeats timing attacks — method-relevant); mutation-only token gating; loopback bind + Host/Origin/`sec-fetch-site` checks (CSRF + DNS-rebinding); `MAX_REQUEST_BODY_BYTES` (1 MiB) with both Content-Length and streaming enforcement (DoS); strict bounded-JSON body parsing; strong CSP (`default-src 'none'`, `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`) + `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `no-store`; static-asset path-traversal guards (`..`/`\\` reject + `assertPathInside`). The frontend keeps the token in memory (React state, `useManagedPromptEditor.ts`), **not** localStorage (avoids the method's XSS/localStorage pitfall); only the UI theme uses localStorage.
- **Command authorization.** Dashboard commands are a fixed whitelist executed **in-process** (no shell); `argv` is display-only; `arbitraryShell: false`; `materialize`/`clean` require explicit confirmation. No `shell: true` anywhere in the repo; all `spawn`/`execFile` calls use argument arrays.
- **OAuth / provider-token handling (`modal/src/auth.ts`).** Credential files written `0o600`, dirs `0o700`; atomic write-then-fsync-then-rename; OAuth host validated as HTTPS-only with no embedded credentials/query/fragment (SSRF/exfil guard); refresh guarded by a `proper-lockfile` lock with a near-expiry threshold; bounded JSON (64 KiB) parsing; refresh token sent in the POST body over HTTPS; opaque-credential shape validation. The Kimi `client_id` is a public OAuth client identifier (not a secret).
- **Ephemeral credential broker (`judge-credential.ts`).** One-key response, strict-bounded (64 KiB, depth 2), 'never normalized or persisted'.
- **Secret storage & redaction.** Config references env-var *names* (`api_key_env`), never key values (`config/src/loader.ts` L494/L678; `agents.ts`); `sensitive-redaction.ts` covers OpenAI/Anthropic `sk-*`, GitHub `gh*_`/`github_pat_`, GitLab, HuggingFace, Slack `xox*`, AWS `AKIA/ASIA`, JWT-shaped, PEM private keys, `Bearer`, URL userinfo, and sensitive key names; artifacts are redacted before persistence.
- **Credential scoping to agents (`runtime/src/start-run.ts`).** `agentEnvironmentVariableNames` builds an allowlist (active agents' `apiKeyEnv`, cloud provider creds, operator `ULTRAFUZZ_AGENT_ENV_ALLOWLIST`) validated against `^[A-Za-z_][A-Za-z0-9_]*$`; `assertCredentialEnvironmentVariableName` blocks `WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES` (e.g., `SMITHERS_BIN`, `ULTRAFUZZ_CONFIG_PATH`, module/schema/validator identities, snapshot descriptors) from ever reaching agents — strong privilege separation. Agents receive a filtered env, not full `process.env`, matching `docs/security.md`. Credentials flow via `env`, never `argv` (no process-listing leakage).
- **Authorization / access control (`security/src/path-policy.ts`).** `validateSafeId` (length, traversal, unsafe chars, shape) and `resolvePathInside` using `realpathSync.native` to canonicalize and enforce inside-root containment (defeats symlink escape). Every dashboard file read is guarded (`nodeDetail` → `validateSafeId` ~L762; artifact dirs → `assertPathInside` ~L830; config/topology/prompt → `safeResolveInside`/`assertPathInside`; run state → `assertRegularFileInside`). No path-traversal/arbitrary-file-read bypass found.
- **Outbound provider auth (`evals/src/reporters/http.ts`).** `trustedProviderOrigin` enforces HTTPS and that the endpoint equals the canonical origin or an operator-trusted origin, else `EVAL_PROVIDER_ENDPOINT_UNTRUSTED` — prevents Bearer-token exfiltration to attacker-controlled endpoints.
- **Hygiene.** No committed secrets in tracked source (multiple targeted sweeps empty); `.gitignore` excludes `smithers.db*`, `.env`-adjacent, `.claude/`, `.smithers/`, and runtime `.ultrafuzz/*` dirs; `smithers.db*` and `.audit-orchestration/` exist only as ignored working-tree artifacts. No `Math.random()` in security paths; 40 crypto-grade `randomBytes`/`randomUUID` uses. Mutating dashboard operations are audit-logged (`appendAudit`/`preflightDashboardAudit`).

---

## 5. Method pattern → repository mapping

| Method pattern / checklist item | Status in repo |
|---|---|
| JWT login / verify / middleware (Pattern 1) | N/A — no JWT auth |
| Refresh-token store/rotate/revoke (Pattern 2) | Partial analogue: provider OAuth refresh in `modal/src/auth.ts` (hashed-lookup DB store N/A; provider tokens refreshed with lock + atomic write) |
| Session-based login/logout (Session Pattern 1) | Adapted: loopback dashboard session token (CSRF-scoped), no user login |
| OAuth2 social login + callback (OAuth Pattern 1) | N/A for user login; provider-side OAuth token refresh present and hardened |
| RBAC / permission / ownership middleware | N/A — no roles; authorization is filesystem/path + loopback + command whitelist |
| Password hashing/validation (bcrypt/zod) | N/A — no passwords |
| Rate limiting | Absent (I-03) — acceptable for loopback |
| Never store plain passwords | N/A |
| Use HTTPS | Loopback plaintext (I-03); outbound provider calls are HTTPS-enforced |
| Short-lived access tokens / expiration | Session token non-expiring (I-02); provider tokens have expiry + refresh |
| Secure cookies (httpOnly/secure/sameSite) | N/A — custom header, not cookies (stronger for this model) |
| Validate all input | Strong — strict bounded JSON, schema validation, safe-id/path validation throughout |
| CSRF protection | Strong — token + Origin/Host/`sec-fetch-site` |
| Rotate secrets | Provider tokens rotate on refresh; dashboard token does not (I-02) |
| Log security events | Present — dashboard audit journal + runtime event journal |
| MFA | N/A |
| JWT in localStorage pitfall | Avoided — token in memory + strict CSP |
| Client-side-only auth pitfall | Avoided — all checks server-side |
| Trusting client data pitfall | Avoided — pervasive server-side validation |

---

## 6. Conclusion

Against the applicable portions of method-02, the repository is **strongly compliant** and, in several areas (constant-time token comparison, DNS-rebinding-resistant CSRF, env credential scoping with controller-only blocklist, realpath containment, provider-origin trust allowlist, comprehensive redaction), exceeds the method's baseline. The single low-severity item (L-01) and three informational items are all deliberate consequences of the documented trusted-local-execution model rather than defects. Recommended priorities: (1) keep the dashboard loopback-only and document the shared-host exposure of L-01; (2) optionally add token expiry/rotation (I-02) if long-lived sessions become common. No critical/high/medium remediation is warranted at this commit.
