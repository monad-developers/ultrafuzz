---
skill: "owasp-asvs-audit"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# OWASP ASVS v5.0.0 Audit Report

**Project:** monad-developers/ultrafuzz  
**Snapshot:** `a634d948038f502e5e677477138dca0c763e2380`  
**Audit date:** 2026-08-15  
**Target:** ASVS Level 3 (cumulative)  
**Method:** Static source/configuration/dependency review using the `owasp-asvs-audit` methodology

## Executive summary

All 345 ASVS v5.0.0 requirements were assigned a disposition. Of 143 requirements considered applicable to this local CLI/dashboard/cloud-worker product, 85 passed static review, 32 failed, and 26 require deployment or dynamic verification. The remaining 202 are not applicable, principally because Ultrafuzz has no end-user account system, cookie session, authorization hierarchy, JWT/SAML resource server, GraphQL, WebSocket, WebRTC, database, or public Internet-facing web application.

- Total: 345
- PASS: 85
- FAIL: 32
- MANUAL_REVIEW: 26
- N/A: 202
- Applicable static pass rate: 85/143 (59.4%); MANUAL_REVIEW is not counted as passing
- L1: 21 PASS, 3 FAIL, 2 MANUAL_REVIEW, 44 N/A; 21/26 applicable passed (80.8%)
- L2: 45 PASS, 19 FAIL, 13 MANUAL_REVIEW, 106 N/A; 45/77 applicable passed (58.4%)
- L3: 19 PASS, 10 FAIL, 11 MANUAL_REVIEW, 52 N/A; 19/40 applicable passed (47.5%)

No critical issue was confirmed. Three medium, two low, and one informational issue are reported. The strongest implemented controls are the loopback-only dashboard, a 256-bit mutation capability checked in constant time, strict bounded JSON parsing, restrictive browser headers, path/symlink guards, explicit materialization confirmation, safe TAR extraction, credential environment minimization, and redirect rejection on most credential-bearing external requests.

## Scope and architecture

Ultrafuzz is a Node.js 22+/TypeScript pnpm monorepo. It provides an Oclif CLI, a local React/Vite dashboard backed by a Node HTTP API, filesystem/JSON/JSONL/YAML/TOML persistence, Modal cloud workers, and outbound calls to GitHub and model/evaluation providers. The dashboard is a local operator surface and rejects non-loopback binds. There is no product database or end-user identity/session system. A random dashboard capability is returned to the local frontend and required for mutations; it is not a user authentication session.

Product source under `packages/**`, root manifests and lockfile, Docker and GitHub Actions configuration, tests, and security/architecture documentation were reviewed. Audit-orchestration material was treated as audit methodology rather than target product code. The worktree remained unchanged.

## Findings

### M-01

**Severity:** Medium  
**ASVS:** V5.2.1 (L1), V15.2.1 (L1), V15.2.2 (L2)  
**Confidence:** 0.96

`BundleArchive` passes an operator-supplied benchmark handoff path directly to `new AdmZip(archivePath)` at `packages/cli/src/benchmark-analysis/lib/archive.ts:18-20`. AdmZip synchronously reads the entire outer archive before `analyzeArchive` obtains its size at `packages/cli/src/benchmark-analysis/lib/analysis.ts:259-260,340`; there is no outer compressed-byte ceiling on this path. A sufficiently large untrusted handoff can therefore exhaust the local process before member controls run.

The production lock also resolves `adm-zip@0.5.18` (`packages/cli/package.json:42`; `pnpm-lock.yaml:2979,9842`). The read-only `pnpm audit --prod --json` run reported seven high advisories across 155 production/optional dependencies: GHSA-xcpc-8h2w-3j85 for adm-zip, several brace-expansion denial-of-service advisories through Oclif, and GHSA-7p8r-x3mc-p8w7 for fast-uri through Ajv. The selected-member paths do compare declared uncompressed sizes before calling `getData`/`readFile` (`archive.ts:36-47`; `packages/cli/src/commands/stats.ts:267-292`), so the known adm-zip 4 GiB allocation vector is not claimed to bypass those checks; the confirmed application flaw is the unbounded outer-file read, while the advisory set remains component risk requiring upgrade and reachability review.

**Remediation:** Stat and open the outer archive as a regular file before construction, reject it above a documented compressed-size limit, avoid TOCTOU by reading from the validated descriptor with a bounded/streaming parser, and retain the existing member/count/uncompressed budgets. Upgrade adm-zip to `>=0.6.0`, refresh Oclif/Ajv transitives to patched brace-expansion and fast-uri versions, rerun the production audit, and add malicious archive regression cases without allocating attacker-declared sizes.

### M-02

**Severity:** Medium  
**ASVS:** V10.1.1 (L2), V14.2.3 (L2), V15.3.2 (L2)  
**Confidence:** 0.95

The Kimi refresh flow posts a refresh credential at `packages/modal/src/auth.ts:123-140` using Fetch's default redirect policy. Fetch follows redirects; a 307 or 308 preserves the POST method and body, so a redirect response can forward the credential to another origin. `kimiOAuthHost` validates only the initial URL as HTTPS (`auth.ts:459-477`). This contrasts with the explicit `redirect: "error"` on other credential-bearing requests in `packages/evals/src/reporters/braintrust.ts:423-432`, `packages/evals/src/scoring.ts:985-990`, and `packages/modal/src/worker.ts:462-470`. Exploitation requires a redirect from the configured/trusted OAuth origin (or its intermediary), which limits likelihood but not credential impact.

**Remediation:** Set `redirect: "error"` on the refresh request. If a redirect is operationally required, handle it manually, allowlist an exact HTTPS origin and path, strip credentials before any origin change, and add 301/302/303/307/308 tests proving the refresh value is never forwarded.

### M-03

**Severity:** Medium  
**ASVS:** V15.1.2 (L2), V15.2.4 (L3)  
**Confidence:** 0.96

The Modal worker image begins from mutable `ubuntu:24.04` and downloads Node, Foundry, and Recon release archives over HTTPS without checking a digest or signature (`packages/modal/Dockerfile:1,20-34`). It also performs global npm and pip installations in the image without a resolved lock artifact for their transitive graphs (`Dockerfile:23-39`). Direct package versions and one Git commit are pinned, which helps reproducibility, but the accepted bytes and base image are not bound to immutable identities. A registry/CDN/release compromise or mutable-tag drift can therefore alter a worker that handles source code and credentials.

**Remediation:** Pin the base image by digest; fetch release checksums/signatures from independently authenticated metadata and verify before extraction; install npm and Python dependencies from checked-in lock/SBOM artifacts with integrity hashes; constrain registries explicitly; generate and attest an SBOM and provenance record; and verify the resulting image digest before deployment.

### L-01

**Severity:** Low  
**ASVS:** V15.2.2 (L2)  
**Confidence:** 0.99

The pricing client declares a 25 MiB limit but calls `response.arrayBuffer()` before checking it (`packages/runtime/src/model-pricing.ts:3-5,106-115`). A compromised default catalog or operator-configured endpoint can make the process buffer an arbitrarily large body within the timeout. The five-second default limits exposure duration but is not a byte bound; this is a local availability issue rather than a remotely exposed service compromise.

**Remediation:** Stream `response.body`, count bytes while reading, cancel immediately above the cap, reject an oversized `Content-Length` early, reject redirects unless explicitly intended, and validate configured catalog URLs against an HTTPS origin policy.

### L-02

**Severity:** Low  
**ASVS:** V16.5.1 (L2)  
**Confidence:** 0.98

The dashboard's catch-all passes `errorMessage(error)` to the JSON consumer for every error, including unhandled 500 responses (`packages/dashboard/src/index.ts:222-225,1771-1777`). Filesystem and parser exceptions can therefore disclose absolute paths or internal diagnostics to a browser client. The loopback bind, Host/Origin/Sec-Fetch checks, and mutation token substantially constrain exposure, but ASVS requires a generic external message.

**Remediation:** Return a stable generic message and correlation identifier for unexpected or security-sensitive errors; log the detailed exception through the redacted internal event channel. Preserve specific messages only for an allowlisted set of safe validation errors.

### I-01

**Severity:** Informational  
**ASVS:** V3.1.1, V3.4.3, V3.4.7, V3.7.5, V5.1.1, V11.1.1-V11.1.4, V13.1.4, V13.2.4-V13.2.5, V14.1.1-V14.1.2, V14.2.7, V15.1.1, V15.1.4, V15.2.5, V16.1.1, V16.2.3, V16.2.5, V16.3.4, V16.4.3  
**Confidence:** 0.90

The repository does not contain the complete Level 3 governance set: browser capability/fallback and CSP reporting documentation; a per-response nonce/hash CSP; a complete file-intake limits table; cryptographic lifecycle/inventory/discovery/PQC migration material; secret rotation schedules; data classification/protection/retention rules; risk-based component remediation and risky-component records; or a complete logging inventory/retention/access/export policy. The static CSP is otherwise restrictive (`packages/dashboard/src/index.ts:174-193`).

The product also deliberately accepts unrestricted trusted-agent execution and no command/network/egress allowlist (`docs/security.md:3-13,25-34`), so V13.2.4/V13.2.5 and the Level 3 dangerous-function isolation goal are not met under ASVS even though the risk is prominently documented. Runtime text redaction uses named-assignment and finite token patterns (`packages/security/src/sensitive-redaction.ts:3-14,71-80`); arbitrary operator-allowlisted secret values that do not match a pattern can survive if a trusted agent prints them, so V16.2.5 is not fully demonstrated. These are target-level gaps and accepted trust-model risks, not claims that the documented local-operator boundary has been bypassed.

**Remediation:** Add versioned security inventories and policies with owners/review cadence; document every file surface and limit; add CSP reporting and, if Level 3 browser assurance is required, per-response nonces/hashes and compatibility behavior; define dependency SLAs and risky-component controls; maintain crypto/PQC and data-classification inventories; document log destinations, access, retention and security events; redact exact injected secret values in addition to patterns; and either implement OS/worktree/network isolation for untrusted campaigns or explicitly declare ASVS V13/V15 exclusions in the formal risk acceptance.

## Detailed requirement matrix

Each ID appears exactly once below. Confidence is 0.85-0.99 for source-backed PASS/FAIL groups, 0.99 for feature-absence N/A groups, and 1.00 that MANUAL_REVIEW needs runtime/deployment evidence. Finding-specific confidence is stated above.

### V1: Encoding and Sanitization

- PASS: V1.1.1 (L2), V1.1.2 (L2), V1.2.1 (L1), V1.2.2 (L1), V1.2.3 (L1), V1.2.5 (L1), V1.2.9 (L2), V1.3.2 (L1), V1.3.3 (L2), V1.3.5 (L2), V1.3.6 (L2), V1.3.7 (L2), V1.3.10 (L2), V1.3.12 (L3), V1.4.2 (L2), V1.5.2 (L2).
- MANUAL_REVIEW: V1.5.3 (L3).
- N/A: V1.2.4 (L1), V1.2.6 (L2), V1.2.7 (L2), V1.2.8 (L2), V1.2.10 (L3), V1.3.1 (L1), V1.3.4 (L2), V1.3.8 (L2), V1.3.9 (L2), V1.3.11 (L2), V1.4.1 (L2), V1.4.3 (L2), V1.5.1 (L1).
- Basis: React/text rendering, URL constructors, argv-based child processes, strict JSON and contextual validation support PASS. There is no database, LDAP, XPath, LaTeX, spreadsheet export, WYSIWYG HTML, JNDI, memcache, mail, native pointer code, or XML parser. Differential parser behavior needs fuzzing.

### V2: Validation and Business Logic

- PASS: V2.1.1 (L1), V2.1.2 (L2), V2.1.3 (L2), V2.2.1 (L1), V2.2.2 (L1), V2.2.3 (L2), V2.3.2 (L2), V2.4.1 (L2).
- N/A: V2.3.1 (L1), V2.3.3 (L2), V2.3.4 (L2), V2.3.5 (L3), V2.4.2 (L3).
- Basis: Registered schemas, strict runtime assertions, server-side validation, concurrency limits, budgets, and documented configuration limits support PASS. There are no per-user transactional, scarce-inventory, multi-approver, or human-timing flows.

### V3: Web Frontend Security

- PASS: V3.2.1 (L1), V3.2.2 (L1), V3.2.3 (L3), V3.4.2 (L1), V3.4.4 (L2), V3.4.5 (L2), V3.4.6 (L2), V3.4.8 (L3), V3.5.1 (L1), V3.5.3 (L1), V3.5.6 (L3), V3.7.1 (L2), V3.7.2 (L2).
- FAIL: V3.1.1 (L3), V3.4.3 (L2 at a Level 3 target), V3.4.7 (L3), V3.7.5 (L3).
- N/A: V3.3.1 (L1), V3.3.2 (L2), V3.3.3 (L2), V3.3.4 (L2), V3.3.5 (L3), V3.4.1 (L1), V3.5.2 (L1), V3.5.4 (L2), V3.5.5 (L2), V3.5.7 (L3), V3.5.8 (L3), V3.6.1 (L3), V3.7.3 (L3), V3.7.4 (L3).
- Basis: `packages/dashboard/src/index.ts:174-193,1651-1698` applies CSP, COOP, CORP, no-referrer, nosniff, frame denial and local anti-forgery controls. The dashboard uses no cookies, postMessage, JSONP data, externally hosted assets, authenticated resources, external redirects, or public HSTS domain. The static CSP meets the L2 global-policy minimum but not the requirement's Level 3 per-response nonce/hash clause; reporting and browser fallback documentation are absent.

### V4: API and Web Services

- PASS: V4.1.1 (L1), V4.1.4 (L3), V4.2.5 (L3).
- MANUAL_REVIEW: V4.2.1 (L2).
- N/A: V4.1.2 (L2), V4.1.3 (L2), V4.1.5 (L3), V4.2.2 (L3), V4.2.3 (L3), V4.2.4 (L3), V4.3.1 (L2), V4.3.2 (L2), V4.4.1 (L1), V4.4.2 (L2), V4.4.3 (L2), V4.4.4 (L2).
- Basis: Responses use explicit types/charsets, route/method definitions are closed, and constructed outbound requests are bounded/validated. There is no reverse proxy contract, HTTP/2/3 implementation, GraphQL, WebSocket, or high-sensitivity signed transaction protocol. Request-smuggling resistance across any production intermediary must be tested.

### V5: File Processing

- PASS: V5.2.2 (L1), V5.2.3 (L2), V5.2.5 (L3), V5.3.2 (L1), V5.3.3 (L3).
- FAIL: V5.1.1 (L2), V5.2.1 (L1).
- N/A: V5.2.4 (L3), V5.2.6 (L3), V5.3.1 (L1), V5.4.1 (L2), V5.4.2 (L2), V5.4.3 (L2).
- Basis: `packages/modal/src/safe-archive.ts:28-176` rejects traversal, symlinks/non-files, duplicates, overwrites and excess entry/file/total sizes; selected ZIP/TAR members are bounded before extraction. The benchmark analysis outer ZIP lacks a compressed-size bound (M-01), and documentation does not consolidate permitted types/extensions/packed and unpacked limits. There is no per-user upload store, image processor, public upload directory, file-serving header, or download service.

### V6: Authentication

- N/A: V6.1.1 (L1), V6.1.2 (L2), V6.1.3 (L2), V6.2.1 (L1), V6.2.2 (L1), V6.2.3 (L1), V6.2.4 (L1), V6.2.5 (L1), V6.2.6 (L1), V6.2.7 (L1), V6.2.8 (L1), V6.2.9 (L2), V6.2.10 (L2), V6.2.11 (L2), V6.2.12 (L2), V6.3.1 (L1), V6.3.2 (L1), V6.3.3 (L2), V6.3.4 (L2), V6.3.5 (L3), V6.3.6 (L3), V6.3.7 (L3), V6.3.8 (L3), V6.4.1 (L1), V6.4.2 (L1), V6.4.3 (L2), V6.4.4 (L2), V6.4.5 (L3), V6.4.6 (L3), V6.5.1 (L2), V6.5.2 (L2), V6.5.3 (L2), V6.5.4 (L2), V6.5.5 (L2), V6.5.6 (L3), V6.5.7 (L3), V6.5.8 (L3), V6.6.1 (L2), V6.6.2 (L2), V6.6.3 (L2), V6.6.4 (L3), V6.7.1 (L3), V6.7.2 (L3), V6.8.1 (L2), V6.8.2 (L2), V6.8.3 (L2), V6.8.4 (L2).
- Basis: No end-user accounts, password login, MFA, recovery, or identity proofing. External provider credentials authenticate the operator's outbound integrations, not users of an Ultrafuzz authentication service.

### V7: Session Management

- N/A: V7.1.1 (L2), V7.1.2 (L2), V7.1.3 (L2), V7.2.1 (L1), V7.2.2 (L1), V7.2.3 (L1), V7.2.4 (L1), V7.3.1 (L2), V7.3.2 (L2), V7.4.1 (L1), V7.4.2 (L1), V7.4.3 (L2), V7.4.4 (L2), V7.4.5 (L2), V7.5.1 (L2), V7.5.2 (L2), V7.5.3 (L3), V7.6.1 (L2), V7.6.2 (L2).
- Basis: No end-user login session exists. The random loopback dashboard capability is an anti-forgery/command capability, not an identity-bearing session.

### V8: Authorization

- N/A: V8.1.1 (L1), V8.1.2 (L2), V8.1.3 (L3), V8.1.4 (L3), V8.2.1 (L1), V8.2.2 (L1), V8.2.3 (L2), V8.2.4 (L3), V8.3.1 (L1), V8.3.2 (L3), V8.3.3 (L3), V8.4.1 (L2), V8.4.2 (L3).
- Basis: No multi-user, role, tenant or object authorization model exists; access is the local OS/operator boundary.

### V9: Self-contained Tokens

- N/A: V9.1.1 (L1), V9.1.2 (L1), V9.1.3 (L1), V9.2.1 (L1), V9.2.2 (L2), V9.2.3 (L2), V9.2.4 (L2).
- Basis: Ultrafuzz does not issue or validate JWT, SAML, or other self-contained authorization tokens.

### V10: OAuth and OIDC

- FAIL: V10.1.1 (L2).
- N/A: V10.1.2 (L2), V10.2.1 (L2), V10.2.2 (L2), V10.2.3 (L3), V10.3.1 (L2), V10.3.2 (L2), V10.3.3 (L2), V10.3.4 (L2), V10.3.5 (L3), V10.4.1 (L1), V10.4.2 (L1), V10.4.3 (L1), V10.4.4 (L1), V10.4.5 (L1), V10.4.6 (L2), V10.4.7 (L2), V10.4.8 (L2), V10.4.9 (L2), V10.4.10 (L2), V10.4.11 (L2), V10.4.12 (L3), V10.4.13 (L3), V10.4.14 (L3), V10.4.15 (L3), V10.4.16 (L3), V10.5.1 (L2), V10.5.2 (L2), V10.5.3 (L2), V10.5.4 (L2), V10.5.5 (L2), V10.6.1 (L2), V10.6.2 (L2), V10.7.1 (L2), V10.7.2 (L2), V10.7.3 (L2).
- Basis: The only implemented OAuth operation is refreshing an imported Kimi subscription credential; M-02 applies. Ultrafuzz is not an authorization server, resource server, OIDC provider/relying party, dynamic client, browser code-flow handler, or consent service.

### V11: Cryptography

- PASS: V11.2.1 (L2), V11.2.3 (L2), V11.2.4 (L3), V11.2.5 (L3), V11.4.1 (L1), V11.4.3 (L2), V11.5.1 (L2), V11.7.2 (L3).
- FAIL: V11.1.1 (L2), V11.1.2 (L2), V11.1.3 (L3), V11.1.4 (L3).
- MANUAL_REVIEW: V11.2.2 (L2), V11.5.2 (L3), V11.7.1 (L3).
- N/A: V11.3.1 (L1), V11.3.2 (L1), V11.3.3 (L2), V11.3.4 (L3), V11.3.5 (L3), V11.4.2 (L2), V11.4.4 (L2), V11.6.1 (L2), V11.6.2 (L3).
- Basis: Code uses Node crypto, SHA-256, `randomBytes(32)`, and `timingSafeEqual`; no custom encryption, password storage/KDF, key generation, signatures or key exchange is implemented. Governance inventories are absent; agility, demand behavior, and full-memory protection need operational evidence.

### V12: Secure Communication

- PASS: V12.2.1 (L1), V12.2.2 (L1), V12.3.2 (L2).
- MANUAL_REVIEW: V12.1.1 (L1), V12.1.2 (L2), V12.1.4 (L3), V12.1.5 (L3), V12.3.1 (L2).
- N/A: V12.1.3 (L2), V12.3.3 (L2), V12.3.4 (L2), V12.3.5 (L3).
- Basis: Default remote endpoints are HTTPS and Node/Fetch performs certificate validation; the dashboard is intentionally loopback HTTP. Actual protocol/cipher/OCSP/ECH posture and operator-configured endpoint policy require runtime inspection. There is no mTLS identity or internal microservice network.

### V13: Configuration

- PASS: V13.1.1 (L2), V13.2.3 (L2), V13.4.2 (L2), V13.4.3 (L2), V13.4.4 (L2), V13.4.5 (L2), V13.4.6 (L3), V13.4.7 (L3).
- FAIL: V13.1.4 (L3), V13.2.4 (L2), V13.2.5 (L2).
- MANUAL_REVIEW: V13.1.2 (L3), V13.1.3 (L3), V13.2.1 (L2), V13.2.2 (L2), V13.2.6 (L3), V13.3.1 (L2), V13.3.2 (L2), V13.3.3 (L3), V13.3.4 (L3), V13.4.1 (L1).
- Basis: Communication surfaces and local-server constraints are documented, no default credentials were found, and the static server uses a fixed asset set without directory listing/TRACE/version detail. No egress allowlist or secret rotation schedule exists by design. Deployment connection pools, account privilege, vault/HSM use, rotation and exclusion of VCS metadata require environment evidence.

### V14: Data Protection

- PASS: V14.2.1 (L1), V14.2.2 (L2), V14.2.5 (L3), V14.2.6 (L3), V14.3.2 (L2), V14.3.3 (L2).
- FAIL: V14.1.1 (L2), V14.1.2 (L2), V14.2.3 (L2), V14.2.7 (L3).
- MANUAL_REVIEW: V14.2.4 (L2).
- N/A: V14.2.8 (L3), V14.3.1 (L1).
- Basis: Sensitive request data uses headers/bodies; dashboard JSON is `no-store`; no sensitive browser storage was found; fixed routes return 404 for missing assets. M-02 can forward a refresh credential, and complete classification/protection/retention rules are absent. No authenticated browser teardown or user media metadata pipeline exists.

### V15: Secure Coding and Architecture

- PASS: V15.1.5 (L3), V15.3.1 (L1), V15.3.3 (L2), V15.3.5 (L2), V15.3.6 (L2), V15.3.7 (L2), V15.4.2 (L3), V15.4.3 (L3).
- FAIL: V15.1.1 (L1), V15.1.2 (L2), V15.1.4 (L3), V15.2.1 (L1), V15.2.2 (L2), V15.2.4 (L3), V15.2.5 (L3), V15.3.2 (L2).
- MANUAL_REVIEW: V15.1.3 (L2), V15.2.3 (L2), V15.4.4 (L3).
- N/A: V15.3.4 (L2), V15.4.1 (L3).
- Basis: Strict schemas, explicit response documents, type checks, prototype-key rejection, path-safe atomic create/locks, and documented dangerous agent execution support PASS. M-01, M-02, M-03 and L-01 drive component, availability, provenance and redirect failures. Remediation SLAs/risky-component records are absent, and the accepted trusted-agent model is not Level 3 isolation. Production minimization and scheduler fairness need runtime verification; no client-IP proxy decisions or shared-memory threads exist.

### V16: Security Logging and Error Handling

- PASS: V16.2.1 (L2), V16.2.4 (L2), V16.3.3 (L2), V16.4.1 (L2), V16.5.2 (L2), V16.5.3 (L2), V16.5.4 (L3).
- FAIL: V16.1.1 (L2), V16.2.3 (L2), V16.2.5 (L2), V16.3.4 (L2), V16.4.3 (L2), V16.5.1 (L2).
- MANUAL_REVIEW: V16.2.2 (L2), V16.4.2 (L2).
- N/A: V16.3.1 (L2), V16.3.2 (L2).
- Basis: Structured JSONL events carry identifiers/timestamps, JSON encoding prevents injection, control failures are represented, external failures degrade safely, and the dashboard has a final request catch. Logging inventory/destination/access/retention and separate export are incomplete; exact-value redaction is not universal; dashboard exceptions are returned but not recorded through an internal detailed error channel; L-02 applies. OS clock synchronization and deployed log permissions need verification. There are no user authentication/authorization decisions to log.

### V17: WebRTC

- N/A: V17.1.1 (L2), V17.1.2 (L3), V17.2.1 (L2), V17.2.2 (L2), V17.2.3 (L2), V17.2.4 (L2), V17.2.5 (L3), V17.2.6 (L3), V17.2.7 (L3), V17.2.8 (L3), V17.3.1 (L2), V17.3.2 (L2).
- Basis: No WebRTC, TURN, DTLS-SRTP, media server or signaling server exists.

## Manual review checklist

1. Exercise the deployed HTTP stack and any proxy for request smuggling and method normalization (V4.2.1).
2. Enumerate negotiated TLS versions/ciphers, public trust, OCSP/ECH, and every operator-configured outbound endpoint (V12.1.1, V12.1.2, V12.1.4, V12.1.5, V12.3.1).
3. Verify production service-account scope, connection/retry limits, secret vault/HSM backing, expiration/rotation, and removal/inaccessibility of VCS metadata (V13 manual items).
4. Fuzz duplicate keys, Unicode, URL/path and archive parser differentials (V1.5.3), including ZIP64 and malformed central/local header disagreement.
5. Verify production image minimization, scheduler fairness, OS UTC synchronization, filesystem permissions, immutable log export and retention (V15/V16 manual items).
6. Dynamically test dashboard origin/Host/Sec-Fetch and capability enforcement, CSP behavior, error disclosure, static path handling, oversized/chunked bodies, and disconnect races.

## Methodology and limitations

The audit used the official OWASP ASVS v5.0.0 chapter material and 345-row English CSV, reviewed the full target at the stated commit, traced source to sinks, inspected manifests/lockfile/CI/container configuration and security documentation, searched for dangerous execution and browser sinks, and ran `pnpm audit --prod --json` read-only. GitHub Actions dependencies observed were commit-SHA pinned; child-process calls generally use argv-based `execFile`/`spawn`, with the located shell invocation using a static command. React escaping and a text-only Markdown preview avoid raw HTML injection.

This was static analysis, not a penetration test. No credentials, cloud deployment, TLS endpoint, HSM/vault, centralized log store, production image attestation, or browser session was available. Tests/DAST that could create target artifacts or require external state were not run under the read-only evidence boundary. MANUAL_REVIEW is therefore not a pass. N/A decisions are architectural, not assertions about controls that would be required if those features are later introduced.
