---
skill: "semgrep-code-security"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Defensive Security Review — Ultrafuzz

**Method:** method-06 (`semgrep-code-security` — 28-category Semgrep code-security guidance, v0.1.0)
**Target:** authorized local checkout `/tmp/ultrafuzz-fable-executor/repository`
**Repository:** `ultrafuzz` (private monorepo) — an agentic orchestrator for smart-contract fuzzing, built on the Smithers durable control plane.
**Snapshot:** commit `a634d948038f502e5e677477138dca0c763e2380`, branch `main`, working tree clean.
**Status:** complete

> Publication boundary honored: this is private review material. No files in the checkout were edited; no deliverables were written into it; no commit, push, issue, PR, or remote write was performed. Repository content was treated as untrusted data.

---

## 1. Scope, method, and how it was applied

I read the method in full — `SKILL.md`, `AGENTS.md`, `metadata.json`, `rules/_sections.md`, `rules/_template.md`, and the individual rule files — and applied its 28 vulnerability categories to the checkout. Two packaging issues in the method bundle were worked around (see I-03): `rules/command-injection.md` is referenced by the index but absent, and `insecure-transport.md` ships misspelled as `nsecure-transport.md`; both categories were applied from `_sections.md` plus standard CWE definitions.

The repository is a TypeScript/Node (pnpm, Node ≥ 22.19) monorepo of 12 workspaces under `packages/` (artifacts, cli, config, dashboard, evals, evmbench, modal, prompts, references, runtime, security, topology). Coverage combined (a) whole-tree pattern sweeps across every package for each dangerous primitive (child_process/shell, eval/Function/vm, HTTP servers, SQL, fs path use, crypto, TLS, YAML/JSON deserialization, dynamic RegExp, token/auth, secrets) and (b) deep line-level reads of every non-trivial attack surface reached that way. Non-destructive checks only (`git`, `grep`, `git grep`, file reads).

### 1.1 Threat-model calibration (decisive for this repo)

`docs/security.md` documents an explicit, internally consistent **trusted-local execution model**, and the review is calibrated to it:

- **Accepted risks (NOT reported):** agents run unrestricted (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`); an agent may execute commands, read operator-readable files, and use the network. The doc states plainly (lines 7-13, 32-34): "Findings whose mitigation requires an OS sandbox, approval gate, command allowlist, or egress allowlist are accepted threat-model risks." Flagging these would be a false positive against the stated design.
- **Enforced boundaries (TESTED):** (1) project paths must be relative, non-traversing, non-symlink-escaping; (2) run artifacts redact secret-looking values before persistence; (3) materialization requires explicit selected copies and confirmation; (4) clean touches only generated `.ultrafuzz/**`.

The substantive finding below (L-01) is measured against boundary (2), an advertised control.

---

## 2. Verdict

**No critical, high, or medium code-security defects were found.** This is a deliberately and unusually hardened codebase; multiple subsystems implement textbook or better-than-textbook defenses. Residuals are **1 low** and **3 informational**.

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 1 | L-01 |
| Informational | 3 | I-01, I-02, I-03 |

---

## 3. Findings

### L-01 — Secret-redaction value heuristic misses some credential formats (low)

**Category:** hardcoded-secrets / data leakage (defense-in-depth control gap). **File:** `packages/security/src/sensitive-redaction.ts`.

The redaction control has two layers. Object **key-name** redaction (`isSensitiveKeyName`, lines 16-36) is broad and reliably masks structured secrets (any key containing token/secret/password/api_key/credential/authorization/etc.). The **value** layer (`isSensitiveSecretValue` 38-56, `redactSecretsInText` 71-81) only redacts a string when it matches the fixed `SECRET_PATTERNS` list (lines 3-14: `sk-`, `sk-ant-`, `gh*_`, `github_pat_`, `glpat-`, `hf_`, `xox*`, AWS `AKIA/ASIA`, a JWT-shaped triplet, PEM private keys), a `Bearer ` prefix, a URL userinfo credential, or a `key=value` where the key literally contains `api_key|token|password|secret|credential|auth|authorization`. The gate at lines 94-96 returns any other string unchanged.

**Concrete failure scenario:** a Google API key surfaced as a URL query — e.g. `https://maps.googleapis.com/maps/api/...&key=AIzaSy<28 chars>` — matches no `SECRET_PATTERN`, and a bare `key=` is deliberately excluded from the alias list, so the value is written verbatim into a persisted (and potentially published) run artifact whenever it appears under an innocuous JSON key or inside free-form agent/log text. Generic high-entropy hex/base64 tokens under non-sensitive keys are similarly missed.

**Why low (not higher):** it is a defense-in-depth heuristic layered on top of env-var scoping, broad key-name redaction, and mandatory pre-materialization artifact review; the doc advertises "redact secret-looking values," not a guarantee. But it is a real, demonstrable gap in an advertised control with concrete consequence (credential persisted into a shareable artifact), so it earns a low rather than informational.

**Mitigation:** broaden the value net (Google `AIza`, other provider prefixes, an entropy-based fallback for long opaque strings), treat any `key=`/`?key=`/`&key=` query parameter as sensitive, and document the residual so operators keep relying on artifact review.

### I-01 — Configured pricing-catalog URL not scheme-validated (informational)

**Category:** insecure-transport / SSRF hardening. **File:** `packages/runtime/src/model-pricing.ts:97-109`.

`sourceUrl` is taken from operator config (`configuredUrl`, default the https models.dev catalog) and fetched directly. Unlike `KIMI_BASE_URL`, which is strictly validated at `packages/modal/src/runner.ts:3081-3089` (must be `https:`, empty username/password/search/hash), the configured catalog URL is not re-checked for scheme or embedded credentials. Existing mitigations: `AbortSignal.timeout` (105), `response.ok` (110-111), `MAX_CATALOG_BYTES` cap (114-115). Operator-owned/trusted config → informational.

**Mitigation:** apply the KIMI_BASE_URL validation to the configured catalog URL (require https, reject credentials, optionally allowlist).

### I-02 — Container images fetch toolchain without checksum pinning (informational)

**Category:** docker / supply-chain. **Files:** `packages/modal/Dockerfile:20-34`; `benchmarks/evmbench/overlay.Dockerfile`.

The Modal agent image downloads Node/Foundry/Recon tarballs via `curl -fsSL <url> | tar` with pinned version ARGs but no SHA-256 verification, so a compromised release asset/mirror could substitute binaries (TLS protects transport only). It is otherwise **compliant with the method's Docker rules**: pinned base `FROM ubuntu:24.04` (line 1), non-root `USER ubuntu` (line 44), no privileged mode, no docker-socket mount. Separately, `overlay.Dockerfile`'s final stage sets no explicit `USER` (line 14+), inheriting from `${BASE_IMAGE}` (the Modal image, which ends as `USER ubuntu`).

**Mitigation:** pin/verify SHA-256 checksums (or use signed artifacts) before extraction; set an explicit non-root `USER` in the overlay final stage.

### I-03 — Method applicability and packaging notes (informational)

**Not applicable to this repo (with evidence):** SQL injection (no `*.sql`, no SQL builders in `packages/**`; the SQLite `smithers.db` is owned by the upstream Smithers dependency, not this source); XXE (no XML parser — no xml2js/fast-xml/DOMParser/sax); memory-safety and unsafe-functions (pure TypeScript, no C/C++/Rust); Terraform AWS/Azure/GCP (no `*.tf`); Kubernetes (no manifests); JWT auth (the dashboard uses an opaque `crypto.randomBytes(32)` session token compared with `crypto.timingSafeEqual`, not JWTs). **Method-bundle gaps worked around:** `rules/command-injection.md` is missing though referenced by `_sections.md`/`SKILL.md`, and `insecure-transport.md` ships misspelled as `nsecure-transport.md`. No repository action required.

---

## 4. Positive security observations (evidence that the categories were exercised)

These are not findings; they document the checks and why the applicable categories came back clean.

- **Path traversal / race conditions (CRITICAL/MEDIUM) — the product's stated boundary #1, exemplary.** `packages/artifacts/src/safe-paths.ts`: `validateSafeId` (22) strict allowlist rejecting `.`/`..`; `normalizeSafeRelativePath` (35) rejects empty, NUL, absolute (posix+win32), backslashes, and any `..`/leading-`/`/unsafe segment; `assertPathInside` (71) uses the correct `path.relative` idiom; `assertNoSymlinkComponents` (81) walks every component with `lstatSync().isSymbolicLink()` and rejects a symlink root; `readSinglyLinkedRegularFileSnapshotInside` (143) is TOCTOU-hardened with dev/ino/size/mtime/ctime/nlink and `realpath` re-checks; durable writes use `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` at mode `0600`, fsync, atomic rename, and crypto-random temp suffixes. The dashboard applies `assertPathInside`/`assertNoSymlinkComponents`/`safeResolveInside` on every FS access.
- **Dashboard web surface (XSS/CSRF/Path) — hardened.** `packages/dashboard/src/index.ts`: binds `127.0.0.1` by default and `validateLoopbackHost` (1651) refuses non-loopback binds; `requireLocalRequest` (1658) enforces a loopback `Host`, a loopback `Origin` when present, and rejects `sec-fetch-site: cross-site` (blocks DNS-rebinding and cross-site browser calls); `requireMutation` (1673) additionally requires the session token via `constantTimeEqual`→`crypto.timingSafeEqual` (1694-1698) on every state-changing route (362/377/418/428/444/467); strict CSP `default-src 'none'; script-src 'self'; frame-ancestors 'none'; form-action 'none'; object-src 'none'` plus nosniff/`X-Frame-Options: DENY` (174-193); request bodies go through a strict-JSON parser with size/depth/item caps (1700-1741); static serving (1786-1796) strips leading slashes, rejects `..`/backslashes, then `assertPathInside` + `isFile()`.
- **Insecure crypto (HIGH) — clean.** Every `createHash` uses `sha256` (30+ sites); no MD5/SHA1/DES/RC4/`createCipher`. No `Math.random` anywhere; all identifiers/tokens use `crypto.randomBytes`/`randomUUID`.
- **Insecure deserialization + prototype pollution (CRITICAL/HIGH) — safe by construction.** All YAML uses the `yaml` library's `parse`/`parseDocument`, which yields plain data and does not instantiate arbitrary types. The strict-JSON parser (`packages/artifacts/src/strict-json.ts`) builds objects with `Object.defineProperty(output, key, ...)` (142) and rejects duplicate keys (126-128), so a `__proto__` key becomes a harmless own property — prototype pollution is not reachable through it. No `node-serialize`/`unserialize`/pickle-equivalents.
- **Code/command injection (CRITICAL) — no host-side injection.** No `eval`/`new Function`/`node:vm` in source (the sole `exec(` hits are `RegExp.prototype.exec`). Process spawns use `execFileSync`/`spawn`/`spawnSync` with argument arrays and no `shell: true`; unrestricted agent command execution is the documented accepted risk, not a host-side shell-injection defect.
- **Insecure transport / SSRF (HIGH) — constrained where it matters.** `KIMI_BASE_URL` must be `https:` with no credentials/query/fragment (`packages/modal/src/runner.ts:3081-3089`); the pricing fetch is size- and timeout-bounded (`model-pricing.ts` 105-115). No `http://` literals to external hosts, no `rejectUnauthorized:false`/`NODE_TLS_REJECT_UNAUTHORIZED`.
- **GitHub Actions (HIGH) — strong.** All third-party actions are pinned to full 40-char commit SHAs (`pnpm/action-setup`, `oven-sh/setup-bun`, `actions/*`, `actions/create-github-app-token`). `ci.yml` uses `push`/`pull_request` (no `pull_request_target`). The `workflow_run` publication (`eval-history-publication.yml`) is least-privilege (`contents: read`), checks out **main** tooling rather than the untrusted producer head, obtains `contents: write` only through a per-repo, auto-revoked GitHub App token created solely when `ready == 'true'`, and requires the candidate commit to be reachable from main (`compare/...` must be `ahead`/`identical`, lines 149-155). `eval-benchmark-recovery.yml` guards on `head_repository.full_name == github.repository`. All interpolated `github.event.*` values are structured (run IDs, attempts, SHAs, event name), passed via `env:` — no injectable free-text (`pull_request.title`/`body`/`head_ref`).
- **Hardcoded secrets (CRITICAL) — none committed.** `git grep` for common credential shapes across tracked non-test files returned nothing; no `.env`/`.pem`/`*.key` files are tracked. API keys are read from environment (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, etc.).
- **Regex DoS (MEDIUM) — reviewed, no PoC.** The regex-dense `packages/artifacts/src/findings-schema.ts` (applied to model-produced finding notes) was inspected; the recurring wrapper construct `(?:<char-class>[ \t]*)*` consumes a mandatory character per iteration (linear, not the catastrophic `(a+)+` shape), and spans are bounded (`[^\n]{0,160}`). No catastrophic-backtracking pattern with unbounded external input was identified, so no ReDoS finding is asserted.

---

## 5. Limitations

- The review is source-level and static; it did not execute the app, drive the dashboard at runtime, or dynamically fuzz the finding-note regex battery. Conclusions rest on read + non-destructive checks.
- The upstream Smithers control-plane code (which owns the SQLite `smithers.db`) lives in dependencies, outside this checkout, and was out of scope; SQL-injection analysis therefore covers only this repository's source (which contains no SQL).
- Not every one of the repo's ~800 source files was read line-by-line; coverage was achieved by exhaustive per-category pattern sweeps across all packages followed by deep reads of every surface those sweeps reached. I judge this sufficient to support each stated conclusion, but a bug in a file with no matching primitive would not have been surfaced.
- Findings are calibrated to the documented trusted-local threat model (docs/security.md); readers who reject that model (e.g., who require an OS sandbox or egress allowlist for agents) would additionally treat those accepted risks as gaps.

## 6. Runtime metadata

- skill: method-06; modelFamily: anthropic; intendedModel: claude-fable-5; model: claude-fable-5; effort: max.
- degradationReason: null — the run executed on the intended primary model; no provider refusal or next-best-retry degradation occurred.
- snapshotCommit: `a634d948038f502e5e677477138dca0c763e2380` (HEAD of `main`, clean tree).
