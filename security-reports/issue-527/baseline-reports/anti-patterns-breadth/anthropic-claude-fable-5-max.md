---
skill: "anti-patterns-breadth"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Ultrafuzz — Defensive Security Review (method-01: AI Code Security Anti-Patterns, Breadth)

**Snapshot commit:** `a634d948038f502e5e677477138dca0c763e2380` (branch `main`; subject: `fix(runtime): reconcile recovered terminal run status (#578) (#603)`)

**Target:** `/tmp/ultrafuzz-fable-executor/repository` — Ultrafuzz, an agentic orchestrator for smart-contract fuzzing. TypeScript / pnpm monorepo, 12 workspace packages (security, references, config, prompts, topology, artifacts, runtime, evals, dashboard, evmbench, modal, cli), 866 git-tracked files (468 .ts, 208 .json, 12 .tsx).

**Method applied:** method-01 — a 10-domain AI-code security anti-pattern catalog: (1) Secrets/Credentials, (2) Injection (SQL/Command/LDAP/XPath/NoSQL/Template), (3) XSS, (4) Auth/Session, (5) Cryptographic failures, (6) Input validation, (7) Config/Deployment, (8) Dependencies/Supply-chain, (9) API security, (10) File handling — plus the pre-generation checklist. The method document is a language-agnostic BAD/GOOD anti-pattern reference; I mapped each domain to the actual codebase. The method's related links ([[ANTI_PATTERNS_DEPTH]], [[Ranking-Matrix]], [[Pseudocode-Examples]]) are knowledge-base cross-references and are not present as files in this checkout.

**Intended model:** claude-fable-5 (Anthropic), effort max. No provider refusal occurred; no degradation.

**Constraints honored:** read-only review; no edits, commits, pushes, issues, PRs, or remote writes; no credential values reproduced; repository content treated as untrusted data.

---

## Overall verdict

Ultrafuzz is a **strongly and deliberately hardened codebase**. Across all 10 anti-pattern domains I found **no critical, high, or medium issues**. The dominant AI-code anti-patterns method-01 targets — hardcoded secrets, SQL/command/template injection, XSS, weak crypto/randomness, path traversal, unpinned dependencies, install lifecycle scripts — are **systematically absent or defended by purpose-built controls**. Residual findings are **4 Low + 4 Informational**, all defense-in-depth or hygiene.

Evidence highlights of the security engineering:
- A dedicated `@ultrafuzz/security` package: realpath-canonicalizing path policy, centralized secret redaction, and a materialize/clean write-boundary policy.
- A loopback-only dashboard with a strict `Content-Security-Policy` (`default-src 'none'`), a `crypto.randomBytes(32)` session token compared in constant time, and Origin/Host anti-DNS-rebinding checks.
- Arg-array-only process spawning: zero `child_process.exec`/`execSync`, zero `shell:true`; the few `bash -lc` strings are static or POSIX-single-quote-escaped.
- Strict JSON-schema validation everywhere with explicit depth/size/item DoS bounds.
- A committed + `--frozen-lockfile` pnpm install; risky native builds disabled by default; no install lifecycle scripts.

## Threat-model context (severity anchor)

`docs/security.md` documents an explicit, deliberate posture: Ultrafuzz is a **trusted local-execution tool**. Agents intentionally run with `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`, and *findings whose mitigation requires an OS sandbox, approval gate, command allowlist, or egress allowlist are accepted threat-model risks*. Agent process environments are minimized to the configured API-key variables + essentials + `SMITHERS_*`. The product enforces **deterministic boundaries only around files it writes itself** (relative/non-traversing/non-symlink paths; secret redaction before persistence; confirmation-gated materialization; clean limited to generated `.ultrafuzz/**`). Findings reachable only by an already-trusted local agent are scored against this model rather than as remote-attacker vulnerabilities.

---

## Domain-by-domain assessment

| # | Method domain | Result | Key evidence |
|---|---------------|--------|--------------|
| 1 | Secrets / Credentials | **Strong** | Keys read from `process.env` only; config stores env-var *names* not values (config/src/loader.ts:59-77); no hardcoded secrets (only test fixtures + a redaction test asserting `AKIA...` is stripped); no `.env`/`.pem`/`.key`/`.npmrc`/`smithers.db` tracked; env minimization (docs/security.md:36-57). Gap: `.env` not in `.gitignore` (**L-01**). |
| 2 | Injection | **Strong** | No SQL string-building anywhere (all `.exec(` hits are `RegExp`/SDK, not SQL; SQLite goes through Effect SQL). No SSTI: prompt rendering is validated `{{variable}}` data-substitution, no `eval`/`Function` (packages/prompts/src/render.ts). Command injection: none exploitable (see domain summary + **L-03/L-04**). LDAP/XPath/NoSQL: not applicable. |
| 3 | XSS | **Strong** | No `innerHTML`/`dangerouslySetInnerHTML`/`document.write`/`insertAdjacentHTML` in any package. Frontend renders JSON via React (auto-escaped). Strict CSP `default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` applied to every response (dashboard/src/index.ts:174-193,223). |
| 4 | Auth / Session | **Strong (scoped)** | No multi-user auth system (single local operator). Dashboard mutations require a `crypto.randomBytes(32)` session token via `x-ultrafuzz-session`, constant-time compared (index.ts:255,1675-1678); loopback + Origin/Host checks on all `/api/` (index.ts:297,1651-1691). Session token is not a cookie -> strong CSRF posture. |
| 5 | Cryptographic failures | **Strong** | Session token + job ids use `crypto.randomBytes`; content fingerprints use SHA-256. No MD5/SHA-1-for-security, no DES/ECB, no `Math.random()` for tokens (grep clean). |
| 6 | Input validation | **Strong** | Strict JSON schemas across artifacts/runtime; `validateSafeId` (path-policy.ts:16-36); request bodies capped at 1 MiB with Content-Length validation, streamed-size enforcement, and `parseStrictJsonBytes` maxDepth=128/maxItems=100k/maxProperties=100k (index.ts:1700-1741). ReDoS surfaces reviewed and bounded (**I-02**). |
| 7 | Config / Deployment | **Strong** | No debug-mode-in-production concept; dashboard returns `error.message` only, never stack traces (**I-03**); comprehensive security headers (nosniff, X-Frame-Options DENY, COOP/CORP same-origin, referrer no-referrer). |
| 8 | Dependencies / Supply chain | **Strong** | Committed pnpm-lock.yaml (v9), all external deps from npm with sha512 integrity, `--frozen-lockfile` in CI + cloud build; no preinstall/install/postinstall scripts; `allowBuilds` disables risky native builds (kimi-code, parcel/watcher, jj binaries, koffi, msgpackr-extract, node-pty) leaving only esbuild/protobufjs/cbor-extract; Effect ecosystem pinned via overrides. Notes: **L-02** (cloud global installs), **I-04** (offline provenance limit). |
| 9 | API security | **Strong (scoped)** | Single loopback listener; all APIs Origin/Host-gated; mutations token-gated; command allowlist (`SUPPORTED_COMMANDS`); job/output/body caps (MAX_COMMAND_JOBS=20, 32 KiB output, 1 MiB body). Commands execute **in-process** (startRun/resumeRun/...), not via shell. IDOR/multi-user authz not applicable. |
| 10 | File handling | **Strong** | `resolvePathInside` canonicalizes root+candidate via `realpathSync.native` and rejects escapes (defeats traversal + symlink, CWE-22/CWE-59); temp files use `mkdtemp` + `mode:0o600` + `flag:'wx'` (exclusive create) + `0o700` dirs, no world-writable modes; materialize/clean policy blocks writes to `.git`/`.ultrafuzz`/`.env*`/`secrets.*`/`*.pem`/`*.key`/`.ssh`/`.aws`/`.gcloud`/`.azure` and rejects patch application entirely (security/src/materialize-policy.ts); no file-upload feature. |

### Command execution (domain 2 detail)

A full spawn-site inventory (Modal, runtime, evmbench, evals, config, artifacts) found **no exploitable OS command injection (CWE-78)**:
- No `child_process.exec`/`execSync` imported anywhere; no `shell:true` anywhere. Every spawn uses an arg-array API (`execFile`/`execFileSync`/`spawn`/`spawnSync`).
- The only shell interpreters invoked are explicit `bash -lc <string>` calls and a few generated `#!/bin/sh` wrappers. In each case the string is fully static (e.g. modal/src/pinned-source.ts:494 `git fsck | awk`; runner.ts:412 image build; forge-guard.ts / trusted-cli.ts wrappers; modal/scripts/ultrafuzz-launcher), built from fixed-union enum values, or escaped through a correct POSIX `shellQuote()` helper (runner.ts:1089-1110).
- Modal `sandbox.exec(...)` / `inspector.exec(...)` and sandbox `command:` fields take argv arrays (execv-style), and run inside disposable cloud sandboxes.
- git is always arg-array; the only residual is theoretical argument-injection (a `-`-leading value misparsed as a flag), mitigated by constant refs (`refs/heads/ultrafuzz-pinned`), 40-hex revision validation (pinned-source.ts:81), `--` separators, and operator-trusted source URLs.
- forge/foundry is version-probed with `['--version']` and wrapped by a static `#!/bin/sh` shim applying `ulimit`/thread env (integers, quoted) then `exec "$REAL_FORGE" "$@"`; contract paths are forwarded as `"$@"` argv inside the sandbox, never concatenated into a shell string by this repo.

Two defense-in-depth spots remain (**L-03** smoke-harness interpolation, **L-04** evmbench Dockerfile `RUN` templating) — safe at this commit but type-/allowlist-dependent.

### Network surface

Exactly one network listener (the loopback dashboard). Outbound fetches are self-origin (frontend), the Modal API (cloud worker), and an operator-configurable model-pricing URL (runtime/src/model-pricing.ts:97-116) that defaults to `models.dev` and is bounded by a timeout (`AbortSignal.timeout`) and a max response size — not attacker-controlled, so **no SSRF**. GitHub Actions workflows contain no `${{ github.event.* }}` script-injection sinks.

### Corroborating history

The CHANGELOG shows an actively security-conscious posture: #307/#361 route raw worker stderr through the redactor before persistence; #218 makes invariant-suite source enumeration depth-bounded and fail-closed to prevent write-amplification DoS; error diagnostics are consistently bounded and redacted.

---

## Findings

All findings are Low or Informational. Titles are opaque per the reporting contract.

### L-01 — `.env`/`.env.*` absent from `.gitignore` (CWE-200)
`.gitignore` ignores product runtime dirs and `smithers.db*` but has no `.env`/`.env.*` rule. The app never creates a `.env` (reads `process.env` directly; no dotenv loader) and blocks `.env` from its own write surfaces (materialize-policy.ts:163; workspace-patch.ts:57; workspace-handoff.ts:927), so nothing leaks automatically. The risk is human git hygiene: an operator creating a local `.env` for API keys could commit it. **Fix:** add `.env`, `.env.*`, `.envrc` to `.gitignore`.

### L-02 — Modal cloud-image global CLIs version-pinned but not integrity-pinned (CWE-1357/CWE-494)
The Modal sandbox image build runs `npm install -g` outside the lockfile: runner.ts:1378 (`@moonshot-ai/kimi-code@0.29.1`) and runner.ts:2934 (`pnpm@11.1.1 bun@1.3.14 @openai/codex@0.146.0 @anthropic-ai/claude-code@2.1.207 recon-generate@0.0.42`). Global installs bypass sha512 integrity guarantees. Impact is confined to the disposable per-run sandbox; version pins block latest-tag drift. **Fix:** integrity-pin (expected shasums / pinned manifest via `npm ci` in a scratch dir).

### L-03 — Latent shell interpolation in the Modal smoke harness (CWE-78, defense-in-depth)
modal/src/smoke.ts:75 interpolates `provider`/`phase` into a `bash -lc` string inside single quotes, unlike the sibling site (runner.ts:1089-1110) that uses `shellQuote()`. Safe at this commit — both are fixed TS unions, `phase` is always an internal literal, and there is no CLI/network wiring (no `smoke` subcommand in packages/cli). Because TS types erase at runtime, safety depends on no caller passing an unvalidated string cast to `ModelProvider`; a single-quote-bearing value would break out. **Fix:** route through `shellQuote()` or pass an argv array.

### L-04 — evmbench pinned-audit Dockerfile `RUN` interpolation (CWE-78, defense-in-depth)
evmbench/src/definition.ts (`buildPinnedAuditDockerfile`, ~line 132) templates `repository`/`commit`/`baseImage` into `RUN git ...` lines (shell context at docker-build time), guarded by strict allowlists with no shell metacharacters: repository `^https://github\.com/evmbench-org/[A-Za-z0-9_.-]+\.git$`, commit `^[0-9a-f]{40}$`, base image `^[A-Za-z0-9][A-Za-z0-9./:@_-]+$` (contracts.ts:17,38-41; definition.ts:140). Not currently injectable. **Fix:** keep the allowlists tight as a security boundary; prefer ARG/COPY over RUN interpolation where practical.

### I-01 — Secret redaction is heuristic; some token formats rely on key-name/exact-value matching (CWE-200, defended)
sensitive-redaction.ts redacts by sensitive key names and value formats (sk-/sk-ant-/gh*_/github_pat_/glpat-/hf_/xox*-/AKIA|ASIA/JWT/PEM/Bearer/basic-auth/key=value). Formats outside this set rely on the key-name layer or exact-value matching. Mitigated in depth: keys live only in env; event payloads redacted centrally before write (events.ts:1100); attempt ledger + all public surfaces exact-match real credential strings and refuse to publish if any remain (attempt-ledger.ts:446-454; public-eval-diagnostics.ts:198-207; recovery-lifecycle.ts:340-349; worker-diagnostics.ts:31-34). **Fix:** add known provider token prefixes to `SECRET_PATTERNS`; keep exact-value redaction as the primary guarantee.

### I-02 — ReDoS surfaces reviewed; bounded, no user-supplied patterns (CWE-1333)
All regex scanning uses static developer-authored patterns over bounded inputs (redaction JWT-triple sensitive-redaction.ts:12; finding-note rules findings-schema.ts:687-694). No regex is sourced from config/agent/network; character classes are non-overlapping without nested quantifiers (polynomial, not exponential worst case). No action required; documented as reviewed.

### I-03 — Dashboard echoes `error.message` to the loopback client (CWE-209)
index.ts:2544 returns `error.message` (never `.stack`); callers surface validation/parse text that can include internal paths. Loopback-only + Origin/Host-gated + single operator, so the recipient is the operator; no stack traces or secrets exposed. **Fix:** none for the local model; if ever exposed beyond loopback, use generic client messages + server-side detail.

### I-04 — Offline limitation: live npm provenance/typosquat check not performed
All external deps resolve from npm with sha512 integrity (no git/tarball/non-registry sources); unusual scoped names (smthrs@0.34.0, modal@0.9.0, @moonshot-ai/kimi-code@0.29.1, recon-generate@0.0.42) match documented integrations. Live publisher-ownership verification needs network access unavailable here. **Fix:** periodic live `npm view`/provenance check on those packages.

---

## What is explicitly NOT an issue (verified)

- No hardcoded secrets, no committed credential files, `smithers.db*` correctly gitignored/untracked.
- No SQL string concatenation (no SQL-injection surface); no SSTI (validated data-substitution templating).
- No XSS DOM sinks; strict CSP backstop even against future sink introduction.
- No weak crypto or `Math.random()` security tokens.
- No exploitable command injection; no `shell:true`; no `exec`/`execSync`.
- No SSRF (outbound fetches are self-origin, Modal API, or bounded operator-config pricing URL).
- No install lifecycle scripts; risky native builds disabled; lockfile committed and frozen.
- Strong path-traversal/symlink defense and temp-file permission hygiene.
- Agent arbitrary command execution is an **accepted, documented** trust-model property, not a defect.

## Limitations

1. Live npm registry provenance/typosquat verification could not be run offline (**I-04**).
2. Review is static; no runtime/dynamic exploitation was attempted (consistent with the read-only, non-destructive mandate).
3. The large local `smithers.db` (~35 MB runtime SQLite store, untracked) was not deep-inspected; Ultrafuzz redacts its own event log and the Smithers input document before handoff (smithers.ts:1285), and the file is gitignored.

## Conclusion

At commit `a634d948`, Ultrafuzz demonstrates mature, defense-in-depth security engineering that avoids the method-01 anti-patterns by design. There are **no critical/high/medium findings**. Recommended actions, in priority order: (1) add `.env*` to `.gitignore` (**L-01**); (2) integrity-pin the Modal cloud-image global CLIs (**L-02**); (3) route the smoke-harness `bash -lc` values through `shellQuote()` (**L-03**); (4) keep the evmbench Dockerfile allowlists tight (**L-04**); (5) extend redaction patterns and run periodic dependency-provenance checks (**I-01/I-04**).
