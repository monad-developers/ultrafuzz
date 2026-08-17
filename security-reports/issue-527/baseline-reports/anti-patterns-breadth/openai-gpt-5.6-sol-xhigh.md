---
skill: "anti-patterns-breadth"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Private security audit report

## Audit identity

- Skill: `anti-patterns-breadth`
- Target: `monad-developers/ultrafuzz`
- Full snapshot: `a634d948038f502e5e677477138dca0c763e2380`
- Audit date: 2026-08-15
- Result: complete
- Findings: 3 high, 1 low

## Scope and methodology

The assigned AI code security anti-pattern skill was read in full and applied to the complete checked-out snapshot. This was a read-only review of the TypeScript/pnpm monorepo, including the CLI, runtime, dashboard, artifacts, configuration, references, Modal/cloud execution, evaluation, security, topology, and EVM benchmark packages.

Review coverage followed all ten skill families:

1. Secrets and credentials: searched tracked content for credential-like assignments and private-key markers; reviewed credential environment forwarding, diagnostic redaction, and public/private report boundaries. Matches were confined to test fixtures or placeholders; no production credential value is reproduced here.
2. Injection: reviewed every first-party child-process sink, shell-selection option, workflow command construction, template rendering boundary, and external command argument flow. First-party commands generally use argument arrays with `spawn`, `spawnSync`, or `execFile` rather than concatenated shells.
3. Browser security: reviewed dashboard rendering, static assets, CSP, response headers, API serialization, and dangerous DOM APIs. No first-party `innerHTML`, `dangerouslySetInnerHTML`, `document.write`, or runtime code-evaluation sink was found in production source.
4. Authentication and sessions: traced dashboard token creation, disclosure, route guards, browser-origin controls, mutation authorization, and SSE/read endpoints. This produced H-01.
5. Cryptography: reviewed random identifiers, token generation, hashes, constant-time comparisons, executable identities, and integrity seals. Security-sensitive randomness uses `crypto.randomBytes` or `crypto.randomUUID`; SHA-256 is used for integrity. The provenance gap in H-03 is not a weakness in SHA-256 but a missing trusted expected digest.
6. Input validation: reviewed strict JSON parsing, size/depth/item/property budgets, schema validation, identifier validation, remote-body consumption, regexes, and archive parsing. This produced H-02 and L-01.
7. Configuration and deployment: reviewed loopback binding, default ports, headers, error handling, CORS/origin behavior, environment controls, and administrative dashboard exposure.
8. Dependencies and supply chain: reviewed manifests, lockfile resolutions, generated workflow-runner installation, version pinning, registry selection, install-script suppression, integrity assumptions, and production advisories. This produced H-02 and H-03.
9. API security: mapped all dashboard read and mutation routes, body limits, authorization decisions, command capabilities, output bounds, and streaming endpoints. This produced H-01.
10. File handling: reviewed path containment, canonicalization, symlink rejection, durable writes, cleanup confirmation, materialization, ZIP/TAR handling, temporary files, file permissions, and report-bundle processing.

A production dependency scan was run with `pnpm audit --prod --audit-level low`. It reported seven high advisories: one directly reachable adm-zip advisory, five brace-expansion advisory records affecting versions 2.1.1 and 5.0.7 through Oclif/minimatch chains, and one fast-uri 3.1.4 advisory through AJV. The adm-zip advisory is H-02. No concrete application input path to the vulnerable brace-expansion behavior, or security-sensitive cross-parser use of fast-uri's backslash authority interpretation, was established; those six records are retained below as upgrade obligations and limitations rather than overstated exploitable findings.

The final `git status --short`, `git diff --stat`, and `git diff --check` checks were clean. No target file was intentionally edited, no deliverable was written into the checkout, and no repository or GitHub write was performed.

## Findings

### H-01

Category: missing authentication, excessive data exposure, broken authorization boundary. CWE-306, CWE-200, CWE-862.

The dashboard creates a cryptographically strong 64-hex-character session token, but publishes it through unauthenticated `GET /api/session`. The only prerequisite for that request is satisfying a loopback Host check and not presenting a disallowed browser origin. These checks mitigate remote-browser CSRF and DNS-rebinding patterns; they do not identify a native process or operating-system user.

Evidence:

- `packages/dashboard/src/index.ts:166-172` binds by default to `127.0.0.1:3875` and defines `x-ultrafuzz-session` as the mutation header.
- `packages/dashboard/src/index.ts:255` generates the token with `crypto.randomBytes(32)`.
- `packages/dashboard/src/index.ts:294-299` sends every `/api/*` request through `requireLocalRequest`, not an authentication guard.
- `packages/dashboard/src/index.ts:316-318` exposes `GET /api/session` without `requireMutation`.
- `packages/dashboard/src/index.ts:510-515` includes `sessionToken` in that response.
- `packages/dashboard/src/index.ts:1658-1671` checks Host, Origin, and `Sec-Fetch-Site`; a native loopback client can omit Origin and fetch metadata.
- `packages/dashboard/src/index.ts:1673-1679` treats the disclosed token as the credential for mutations.
- `packages/dashboard/src/index.ts:356-474` authorizes configuration, topology, prompt, and command mutations with that token.
- `packages/dashboard/src/index.ts:1275-1457` shows the resulting command authority: validate, campaign launch, resume, replay, fork, reference synchronization/update, materialization, and cleanup.

Impact and exploitability:

A process belonging to another local user, a compromised local development tool, or native malware can connect to the predictable loopback port, retrieve the token, inspect private run artifacts and prompts through unauthenticated GET routes, and perform every token-guarded mutation. Changing prompts/topology and launching a campaign can make agents act under the dashboard process's filesystem and configured provider authority. Materialization and cleanup also mutate project state. Local connectivity is required, which keeps this below critical, but the token does not provide the isolation its mutation guard implies.

Recommendation:

Remove the token from `/api/session` and all other unauthenticated responses. Provision it directly from the launcher to the intended UI using an out-of-band mechanism. Authenticate reads and SSE streams as well as writes. Prefer an owner-permission Unix-domain socket or peer-credential mechanism; otherwise use a high-entropy authenticated URL or bearer token, exact bound-origin checks, scoped short-lived capabilities, and request/concurrency limits.

### H-02

Category: known vulnerable dependency and untrusted archive processing. CWE-400, CWE-789.

The production CLI resolves `adm-zip@0.5.18`, which is affected by GHSA-xcpc-8h2w-3j85. Crafted ZIP metadata can drive a 4 GB allocation. Both relevant CLI features intentionally accept external archive files, and the vulnerable parser is invoked before application-level member-count and expansion checks can reject the data.

Evidence:

- `packages/cli/package.json:42` declares `adm-zip` as a production dependency.
- `pnpm-lock.yaml:102-104,2979-2981` resolves version 0.5.18.
- `packages/cli/src/benchmark-analysis/command.ts:9-20` defines an external finalized handoff ZIP as required input.
- `packages/cli/src/benchmark-analysis/lib/analysis.ts:259-263` constructs `BundleArchive` from that path.
- `packages/cli/src/benchmark-analysis/lib/archive.ts:18-23` invokes `new AdmZip(archivePath)` and obtains entries before enforcing the 10,000-entry limit.
- `packages/cli/src/benchmark-analysis/lib/archive.ts:36-46` later enforces selected-member bounds, too late to protect parser allocation.
- `packages/cli/src/commands/stats.ts:83-104` accepts `--bundle <report-bundle.zip>`.
- `packages/cli/src/commands/stats.ts:183-190` caps the outer file at 256 MiB and then constructs `AdmZip`; forged internal length metadata can still reach the vulnerable allocation behavior.
- `packages/cli/src/commands/stats.ts:267-292` applies per-member and aggregate budgets only during later reads.
- `pnpm audit --prod --audit-level low` identifies the affected range as `<0.6.0` and the fixed range as `>=0.6.0`.

Impact and exploitability:

Opening a malicious benchmark handoff or offline report bundle can exhaust memory and terminate the CLI, its workflow container, or the host process. The input files are explicitly designed for interchange, so an attacker who can supply or replace a bundle has a direct path to the parser.

Recommendation:

Upgrade to adm-zip 0.6.0 or newer immediately and verify the lockfile resolution. A streaming parser with validated arithmetic and cancellation is preferable. Enforce outer compressed bytes, central-directory entry count, canonical unique names, per-entry bytes, aggregate expansion, and compression ratio before allocating output buffers. Keep the existing strict JSON limits after the parser boundary.

### H-03

Category: missing dependency integrity checks and execution of target-controlled code. CWE-494, CWE-829.

Ultrafuzz trusts a preexisting workflow-runner tree located inside the audited project when its self-declared version and filesystem layout look correct. A malicious repository can therefore carry a minimal `.smithers/package.json`, `.smithers/node_modules/smthrs/package.json`, executable `src/bin/smithers.js`, and matching `.bin` shim. The attacker selects all executable bytes and the metadata used to validate them.

Evidence:

- `packages/runtime/src/smithers.ts:3212-3236` validates the repository's generated manifest and prepares the project-local dependency tree.
- `packages/runtime/src/smithers.ts:3241-3249` returns without registry installation when top-level validation and compatibility patching succeed.
- `packages/runtime/src/smithers.ts:3468-3520` validates version `0.34.0`, bin target, regular-file properties, and shim target, but has no trusted digest or registry-integrity comparison.
- `packages/runtime/src/smithers.ts:3309-3319` intentionally treats a tree with none of `@smthrs/cli`, `@smthrs/scheduler`, or `@smthrs/engine` as acceptable.
- `packages/runtime/src/smithers.ts:3191-3201` binds the accepted `smthrs/src/bin/smithers.js` executable.
- `packages/runtime/src/smithers.ts:1887-1900` executes the bound runner for controller commands.
- `packages/runtime/src/smithers-executable-capability.ts:49-62,155-169` records inode, size, and SHA-256 of the already supplied file. This prevents replacement after acceptance but cannot establish provenance without a trusted expected digest.
- `packages/runtime/test/runtime.test.ts:495-520` creates exactly such a minimal arbitrary shell runner with the expected metadata and omits the three implementation packages, confirming the accepted shape.
- `packages/runtime/src/smithers-package.ts:146-158` hardens fresh installs with exact pins, `--ignore-scripts`, a resolution cutoff, and a fixed registry on the local path, but that installation path is skipped for the accepted preexisting tree.

Impact and exploitability:

Running Ultrafuzz against a repository containing the crafted tree executes attacker-selected code as the operator before the workflow can provide meaningful isolation. The runner inherits the operator's filesystem access and can read user-level configuration or credentials available to that account even when sensitive environment variables are filtered. The repository-level `.gitignore` entry for `node_modules` does not help because malicious files can be force-tracked.

Recommendation:

Do not execute dependencies sourced from the target project. Build or download the workflow runner into an operator-controlled cache or sealed execution root, using a lockfile and registry integrity hashes. Authenticate every file in the executable dependency closure against trusted release metadata. Reject or replace any target-local preexisting tree. If project-local storage is unavoidable, verify a complete content manifest rooted in a trusted digest before binding capabilities, and remove the special case that accepts missing implementation packages.

### L-01

Category: resource consumption from an unbounded remote response. CWE-400.

The pricing resolver has a 25 MiB semantic limit, but applies it only after `Response.arrayBuffer()` has consumed the complete body.

Evidence:

- `packages/runtime/src/model-pricing.ts:3-5` defines the default third-party endpoint, five-second timeout, and 25 MiB maximum.
- `packages/runtime/src/model-pricing.ts:84-108` allows an environment-configured URL and starts the fetch.
- `packages/runtime/src/model-pricing.ts:113-115` buffers the whole response before checking its length.
- `packages/runtime/src/model-pricing.ts:120-125` applies strict JSON byte and structural limits after buffering.

Impact and exploitability:

A compromised default catalog service or an operator-configured hostile endpoint can transmit substantially more than 25 MiB during the timeout and create avoidable memory pressure or process termination. Exploitation requires control of a configured endpoint, its HTTPS origin, or its response path, so severity is low.

Recommendation:

Check `Content-Length` when valid, stream the body, maintain a cumulative byte count, and cancel at 25 MiB. Disable redirects or validate every redirect target, retain the strict JSON limits, and consider an HTTPS-origin allowlist.

## Positive controls observed

- Dashboard request bodies are bounded to 1 MiB and parsed with strict JSON depth, item, property, duplicate-key, and UTF-8 controls at `packages/dashboard/src/index.ts:1700-1753`.
- Dashboard responses set restrictive CSP, framing, MIME-sniffing, opener, resource, and referrer policies at `packages/dashboard/src/index.ts:174-193,1780-1784`.
- Dashboard command selection is allowlisted and child-process-like operations use structured argument arrays; the capability surface explicitly reports arbitrary shell execution as unavailable.
- File operations repeatedly use `assertPathInside`, `safeResolveInside`, `assertNoSymlinkComponents`, regular-file snapshots, confirmation gates, and durable writes.
- `packages/modal/src/safe-archive.ts:28-176` streams TAR extraction, rejects traversal, symlinks and special types, enforces entry/per-file/aggregate limits, uses exclusive creation, and assigns restrictive modes.
- The judge-credential HTTP flow uses redirect rejection and bounded streaming response reads at `packages/modal/src/worker.ts:457-501`.
- Workflow-runner fresh installation uses exact direct pins, a fixed historical resolution cutoff, `--ignore-scripts`, and a fixed public registry for the local path.
- Diagnostic and artifact paths contain extensive secret-redaction and output-size controls.

## Scanner observations and limitations

`pnpm audit --prod --audit-level low` reported 0 critical, 7 high, 0 moderate, 0 low, and 0 informational advisory records across 155 production and optional dependencies. Besides H-02, these were:

- `brace-expansion@2.1.1` through `@oclif/core > ejs > jake > filelist > minimatch`: GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, and GHSA-rgw5-rvv9-x895.
- `brace-expansion@5.0.7` through `@oclif/core > minimatch`: GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895.
- `fast-uri@3.1.4` through `packages/artifacts > ajv` and `ajv-formats > ajv`: GHSA-7p8r-x3mc-p8w7.

These packages should be upgraded even though a concrete exploitable first-party input path was not proven during this audit. The absence of a reported finding is not a claim that the advisory is unreachable under every Oclif plugin or custom-schema configuration.

Semgrep, gitleaks, Trivy, and Bandit executables were not available in the environment. Target package test scripts were not executed because their declared build/test flows delete and recreate repository-local `dist` and `dist-test` directories, conflicting with the audit's read-only evidence boundary. Static inspection included the relevant tests as corroborating evidence. Dynamic proof-of-concept archives and malicious runner trees were not created in the target checkout.

This report is anchored only to commit `a634d948038f502e5e677477138dca0c763e2380`; later changes were not assessed.
