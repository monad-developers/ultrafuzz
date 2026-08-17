---
skill: "dynamic-js-audit"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# JavaScript Dependency Security Audit Report

## Executive Summary

This report audits commit a634d948038f502e5e677477138dca0c763e2380 for dynamic JavaScript loading, browser script injection, workers, project-loaded executable modules, and JavaScript dependency acquisition. The review found one high-severity controller-code trust-boundary issue and one medium-severity supply-chain reproducibility issue.

The browser dashboard has a strong posture: its two script entries are first-party and same-origin; the server applies default-src 'none', script-src 'self', frame-ancestors 'none', object-src 'none', no-referrer, nosniff, COOP/CORP, and X-Frame-Options DENY. No third-party browser scripts, external script URLs, iframes, service workers, browser postMessage handlers, eval calls, or Function constructors were found in production sources. Subresource Integrity is therefore not applicable to the current browser script inventory.

The highest-risk path is outside the browser. Normal initialization preserves project-owned .smithers JavaScript and dependency-manifest extensions. Validation checks that the agent registry exposes expected factory names, but it does not authenticate the executable module bytes or reject unrelated top-level effects. Those files are copied into the sealed execution closure and imported by the workflow controller while configured credential variables are present. A target repository can therefore carry controller-executed JavaScript unless the operator regenerates and independently reviews all control files. The established trust boundary calls for prompt review, but it does not provide an equivalent explicit trust decision for executable adapter code.

The second issue is that several container build paths resolve executable npm dependency graphs without a committed integrity lock. One EVMBench path also bypasses the repository's existing fixed-time dependency-resolution helper, despite source comments documenting why the cutoff is required.

## Scope and Method

- Snapshot: a634d948038f502e5e677477138dca0c763e2380
- Tracked files reviewed: 866
- Static discovery: git grep and ripgrep searches over all tracked TypeScript, TSX, JavaScript, MJS, HTML, Dockerfile, workflow, and configuration files
- Patterns covered: script tags, script/iframe DOM construction, HTML injection, dynamic import and require, eval and Function, workers, service workers, postMessage, external URL module specifiers, CSP/SRI controls, package-manager installs, runtime module resolution, and generated workflow templates
- Corroboration: package manifests already installed for the snapshot and read-only public npm metadata queries for the exact versions named by build commands
- Repository state remained unchanged; git diff --exit-code succeeded after review

## Discovery Results

| Location | Resource or mechanism | Party/context | Security controls and assessment |
|---|---|---|---|
| packages/dashboard/frontend/index.html:8 | /dashboard/theme-bootstrap.js classic script | First-party, same-origin, synchronous head bootstrap | Served with script-src 'self', nosniff, no-cache; no user-derived URL; SRI not needed for same-origin content covered by the application's deployment integrity |
| packages/dashboard/frontend/index.html:12 and packages/dashboard/frontend/vite.config.ts:7-20 | /src/main.tsx module entry, emitted as /dashboard/assets/dashboard.js | First-party Vite bundle; module loading is deferred by browser semantics | Same restrictive CSP and origin; fixed output name; no remote chunks or CDN imports found |
| packages/dashboard/src/index.ts:174-193, 1780-1802 | Dashboard security headers and static asset server | Local loopback server | default-src 'none'; script-src 'self'; frame-ancestors 'none'; object-src 'none'; no unsafe-eval; no unsafe-inline in script-src; strict content types; path confinement |
| packages/artifacts/src/json-file-validator.ts:647-675, 747-811 | Node Worker loading ./json-validation-worker.js | First-party local file URL | Fixed URL relative to import.meta.url, resource limits, deadlines, termination on timeout, and private MessagePorts; no external worker source |
| packages/artifacts/scripts, packages/config/scripts, packages/dashboard/scripts, packages/evals/scripts, packages/runtime/scripts | Dynamic imports of fixed ../dist/*.js paths | First-party build verification | Literal relative paths only; no request or repository input reaches the specifier |
| packages/runtime/src/clean.ts:102-150 and packages/runtime/src/required-commands.ts:54-85 | import(moduleName) | First-party @ultrafuzz/modal | The variable is assigned a hard-coded package name immediately before import; not attacker-derived |
| packages/runtime/src/templates/smithers/workflows/workflow.tsx:20-87, 428-443 | Dynamic imports of artifacts, runtime, and Modal modules | First-party controller modules | Normal start/resume paths overwrite ambient values with URLs into a verified, sealed execution snapshot; controller-only variables are removed before model child processes |
| packages/runtime/src/templates/smithers/workflows/workflow.tsx:18 and packages/runtime/src/smithers.ts:1377-1385 | Import and snapshot of project .smithers/agents code | Project/target-controlled executable code in controller context | Vulnerable trust transition described in H-01 |
| packages/modal/src/runner.ts:182-310 and 2184-2273 | Generated node -e helpers dynamically import the artifacts module | First-party fixed image path passed as an argv value | Production callers use /opt/ultrafuzz/packages/artifacts/dist/index.js; no target-derived module path found |
| packages/runtime/src/smithers-package.ts:98, 146-158 and packages/modal/scripts/prepare-smithers-seed.mjs:7-16 | Generated Smithers npm installation | Third-party registry dependencies | Exact direct pins, scripts disabled, HTTPS registry, and fixed --before cutoff; installed closure is subsequently sealed |
| benchmarks/evmbench/overlay.Dockerfile:10-12; packages/modal/Dockerfile:20-26; packages/modal/src/runner.ts:1377-1378, 2923-2937 | npm acquisition of executable JavaScript toolchains | Third-party public registry | Some exact direct pins, but no committed transitive integrity lock; EVMBench omits the established cutoff; affected by M-01 |
| Entire tracked browser source set | Iframes, service workers, browser postMessage, remote script/module URLs | None found | Iframe sandboxing, feature policy, origin validation, and SRI are not applicable to the current inventory |

No protocol-relative browser resource URLs or HTTP browser script loads were found. Node-side API URLs and Git repository URLs are data/network endpoints rather than JavaScript module sources and were not treated as script loads.

## Findings

### HIGH — H-01

**Description:** Project-controlled JavaScript and dependency extensions can cross from the audited repository into the workflow controller without trusted provenance.

**Locations:** packages/runtime/src/init.ts:99-188, 244-264, 305-363; packages/runtime/src/agent-registry.ts:17-125; packages/runtime/src/validate.ts:348-387; packages/runtime/src/smithers-package.ts:220-266; packages/runtime/src/smithers.ts:1336-1445, 1481-1590, 3204-3282; packages/runtime/src/templates/smithers/workflows/workflow.tsx:15-21; packages/runtime/src/templates/smithers/agents/index.tsx:1-21.

**Evidence and exploit path:**

1. initProject preserves every existing .smithers/agents file and .smithers/package.json unless --force is used. The normal documented tutorial command does not use --force.
2. The post-init adapter review only warns about a narrow textual case involving ultrafuzz.toml. It does not reject arbitrary imports, top-level statements, or other side effects.
3. inspectAgentRegistry performs bounded static analysis of the agentFactories object shape. It does not constrain the rest of the module. Validation therefore establishes that names exist, not that importing the module is safe. The test at packages/runtime/test/runtime.test.ts:4336-4365 explicitly demonstrates acceptance of customized registry source.
4. smithersExecutionControlFiles walks every regular file below project .smithers/agents and adds it to the sealed execution snapshot. The only source-content rejection in that loop is the mutable-config substring check.
5. The generated workflow imports ../agents/index.ts at module initialization. Imported module top-level code runs in the Smithers controller process, before workflowControlChildEnvironment is used to blank controller-only variables for model processes.
6. start-run intentionally forwards active agent credential variable names to the controller. Arbitrary imported project code can therefore read controller filesystem/environment state, use the network, alter workflow behavior, or tamper with evidence. No credential value was inspected or reproduced during this audit.
7. The dependency manifest compounds the same trust problem. assertSmithersPackageManifest requires the Ultrafuzz pins but deliberately permits extra dependencies, devDependencies, and overrides; packages/runtime/test/smithers-package.test.ts:58-63 locks in that behavior. A preserved target manifest can consequently influence the npm tree that is later loaded and sealed.
8. --force is not a complete provenance boundary unless unexpected files are also rejected or removed. It overwrites known templates but does not establish an exact allowed file set. The stock registry also uses extensionless sibling imports, leaving resolution-shadowing risk from unexpected sibling files.

**Risk:** A malicious repository prepared for audit can obtain arbitrary controller-side JavaScript execution when the operator follows the normal init-and-run workflow. This is outside the model prompt boundary and can occur before child-environment scrubbing. Impact includes access to configured API credential variables, local files available to the controller, workflow/evidence manipulation, and network use. The application documents agents as trusted local execution, but this path makes repository-carried code trusted without an equally explicit operator approval. If maintainers intend all pre-existing .smithers content to be operator-trusted code, that assumption must be made explicit and enforced at repository onboarding; it is not safe to infer it from the target checkout.

#### Proposed Patch

The default path should build agent controls from installed Ultrafuzz templates, not from the target tree. Custom adapters should require an explicit, non-persisted operator approval and a recorded digest. Dependency extensions should be rejected in the default mode. Also use explicit extensions for stock imports and reject unexpected files.

~~~diff
// packages/runtime/src/smithers.ts
- const agentsRoot = path.join(compiled.projectRoot, ".smithers", "agents");
+ // Default controls come from the installed, trusted Ultrafuzz package. A custom
+ // root is accepted only when the CLI supplied an explicit operator approval and
+ // its exact tree digest is recorded in the run plan.
+ const agentsRoot = await trustedAgentControlsForRun({
+   layout,
+   operatorApprovedCustomRoot: compiled.operatorApprovedCustomAgentRoot
+ });
  for (const sourcePath of walkExecutionFiles(agentsRoot)) {
-   const source = fs.readFileSync(sourcePath, "utf8");
-   if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
-     throw new Error(...);
-   }
+   assertAllowedAgentControlFile(agentsRoot, sourcePath);
    add(sourcePath, path.posix.join(".smithers/agents", relativeExecutionPath(agentsRoot, sourcePath)));
  }

// packages/runtime/src/smithers-package.ts
-export function assertSmithersPackageManifest(value: unknown): void {
+export function assertSmithersPackageManifest(
+  value: unknown,
+  options: { allowOperatorApprovedExtensions?: boolean } = {}
+): void {
   ...
   for (const [section, expected] of Object.entries(REQUIRED_SMITHERS_DEPENDENCIES)) {
     const actual = value[section];
     ...
+    if (
+      options.allowOperatorApprovedExtensions !== true &&
+      !hasExactKeys(actual, Object.keys(expected))
+    ) {
+      throw modifiedManifestError();
+    }
   }
 }

// packages/runtime/src/templates/smithers/agents/index.tsx
-import { createClaudeAgent } from "./claude";
-import { createCodexAgent } from "./codex";
+import { createClaudeAgent } from "./claude.ts";
+import { createCodexAgent } from "./codex.ts";
  // Apply the same explicit extension to every stock sibling import/export.
~~~

The helper in this outline must materialize from package-owned templates into the protected execution snapshot and compare an exact allowlist of paths and hashes. Do not use a digest stored only in the target repository as trust evidence, because the repository can modify both content and digest.

**Testing recommendations:**

- A repository containing a syntactically valid registry plus an unrelated top-level side effect must fail validation/start in default mode without executing the effect.
- A repository containing extra codex.tsx, codex.js, nested package metadata, or extra agent files must not affect stock module resolution.
- Extra dependency and override entries must fail by default.
- A custom adapter should run only after a dedicated CLI flag or interactive approval names an external/operator-owned source and the run records its tree digest.
- Start, resume, replay, fork, and cloud handoff must all consume the same authenticated control tree.
- Regression tests should verify that credential variable names are unavailable to any unapproved project module.

**Alternatives:** If project-local customization must remain seamless, separate configuration from code: expose a declarative, schema-validated agent configuration format and keep executable factories package-owned. As an interim control, make init fail closed whenever .smithers already exists and require --force after displaying that executable project controls were found; document that the target checkout must not supply trusted control-plane code.

### MEDIUM — M-01

**Description:** Executable npm dependency graphs are resolved without a committed transitive integrity lock in multiple image-build paths, and the EVMBench seed bypasses the repository's own fixed-time resolution control.

**Locations:** benchmarks/evmbench/overlay.Dockerfile:10-12; packages/modal/Dockerfile:20-26; packages/modal/src/runner.ts:1377-1378 and 2923-2937; packages/runtime/src/smithers-package.ts:75-98 and 135-158.

**Evidence:**

- packages/runtime/src/smithers-package.ts documents that lockless installation re-resolves open transitive ranges, previously broke runs, and can produce different trees over time. smithersDependencyInstallArgs mitigates this specific workspace with --ignore-scripts and a fixed --before=2026-08-13T12:00:00Z.
- packages/modal/scripts/prepare-smithers-seed.mjs correctly calls that shared helper.
- benchmarks/evmbench/overlay.Dockerfile instead reconstructs the manifest and runs raw npm install --package-lock=false without --before. The smthrs 0.34.0 manifest contains numerous caret-ranged runtime and optional dependencies, so identical source commits can produce different executable dependency closures.
- packages/modal/Dockerfile and modalSecurityToolchainCommands use npm install -g with exact top-level versions but no committed package-lock/shrinkwrap for transitive integrity. modalImageBuildCommand separately repeats a global Kimi install before the frozen workspace install.
- Read-only metadata inspection confirmed that at least the exact recon-generate and Kimi versions named by these commands declare open transitive/optional ranges. Exact top-level version pins therefore do not freeze the complete executed graph.
- npm's registry-provided transport integrity protects a fetched tarball against incidental corruption, but without a committed lock or independently pinned image digest the repository does not authenticate which transitive versions should be selected.

**Risk:** A newly published compatible dependency, compromised publisher, or registry-side substitution can change code executed in benchmark and Modal images without a source change. Install scripts are enabled on the global-install paths, so selected package code may execute during an image build; the resulting tools later run in audit workers with target data and agent authentication. The EVMBench path disables scripts but still executes the resolved packages later. Impact can include result manipulation, credential access from the finished image, and irreproducible security evaluations. Likelihood requires a dependency supply-chain event, so this is rated Medium rather than High.

#### Proposed Patch

Use the existing shared Smithers seed installer in EVMBench, and replace ad hoc global installs with a toolchain artifact built from a committed lock and consumed by immutable digest.

~~~diff
// benchmarks/evmbench/overlay.Dockerfile
-RUN mkdir -p /opt/ultrafuzz-smithers && \
-    node --input-type=module -e '...renderSmithersPackageJson...' && \
-    npm install --prefix /opt/ultrafuzz-smithers --ignore-scripts --package-lock=false --no-audit --no-fund --loglevel=error
+RUN node packages/modal/scripts/prepare-smithers-seed.mjs /opt/ultrafuzz-smithers
~~~

~~~diff
// packages/modal/Dockerfile
-RUN ... && npm install -g \
-      pnpm@11.1.1 bun@1.3.14 @openai/codex@0.146.0 \
-      @anthropic-ai/claude-code@2.1.207 @moonshot-ai/kimi-code@0.29.1 \
-      recon-generate@0.0.42
+COPY packages/modal/toolchain/package.json packages/modal/toolchain/package-lock.json /opt/ultrafuzz-toolchain/
+RUN npm ci --prefix /opt/ultrafuzz-toolchain --omit=dev --no-audit --no-fund \
+    && /opt/ultrafuzz-toolchain/scripts/install-verified-bin-links.sh
~~~

The new package-lock.json must be committed and reviewed, and the helper should link only the expected binaries. Use --ignore-scripts if all selected CLIs operate without lifecycle scripts; otherwise isolate the locked build stage, allow only documented required scripts, and verify expected binaries afterward. Publish this toolchain image once, record its OCI digest, and have securityToolchainImage load that digest rather than rebuilding from live npm metadata. Remove the redundant npm install -g Kimi step from modalImageBuildCommand and use the frozen workspace/toolchain binary.

**Testing recommendations:**

- Assert overlay.Dockerfile invokes smithersDependencyInstallArgs indirectly through prepare-smithers-seed.mjs and contains the fixed cutoff.
- Rebuild twice with an empty cache and compare the full dependency-tree/SBOM digest.
- Reject a toolchain build if the committed lock changes or a tarball does not match lock integrity.
- Verify every expected CLI version and binary target after installation.
- Run smoke tests with lifecycle scripts disabled; document any narrowly required exception.
- Pin the final toolchain/base image by OCI digest in the Modal build path.

**Alternatives:** Vendor the verified CLI artifacts in a release asset with signed checksums, or use a private immutable npm proxy snapshot fixed to the release cutoff. A cutoff alone improves determinism but is weaker than a committed integrity lock and immutable image digest.

## Best-Practices Checklist

| Control | Status | Evidence |
|---|---|---|
| Browser CSP script-src | Pass | packages/dashboard/src/index.ts:175-187 uses script-src 'self' with no unsafe-inline or unsafe-eval |
| CSP domain scope | Pass | default-src 'none'; no wildcard or third-party script origin |
| CSP reporting | Not configured | Reasonable for a loopback-only operator UI; add report-to only if a privacy-preserving local collector is intentionally supported |
| Browser SRI | Not applicable | No third-party browser scripts; both script resources are served by the same application origin |
| External script versions | Not applicable in browser | No CDN/analytics/payment/widget scripts found |
| Dynamic import input validation | Mixed | Sealed first-party module URLs are strong; project agent module trust is unsafe under H-01 |
| Iframe sandboxing | Not applicable | No iframes found |
| postMessage origin validation | Not applicable in browser | No browser message handlers found; Node MessagePorts are private worker channels |
| Worker source control | Pass | Fixed same-package file URL plus resource/time limits |
| HTTPS transport | Pass for JavaScript registry endpoints reviewed | npm registry is explicitly HTTPS on the controlled Smithers path; no mixed browser content |
| Dependency immutability | Mixed | Frozen pnpm lock and sealed runtime closure are strong; image build gaps remain under M-01 |
| Failed-load handling | Pass for reviewed dynamic paths | Worker timeouts/errors fail closed; Modal imports are caught or occur during controlled startup; dashboard assets return explicit errors |

## Remediation Roadmap

1. **Immediate:** Remove target-repository .smithers JavaScript and dependency manifests from the default trusted controller path. Generate stock controls from package-owned templates, reject unexpected modules and dependency extensions, use explicit sibling extensions, and require an explicit operator-owned approval for custom executable adapters.
2. **Short term:** Route EVMBench seed creation through prepare-smithers-seed.mjs. Build all Modal/benchmark JavaScript tooling from a committed integrity lock and consume an immutable toolchain image digest.
3. **Long term:** Add a CI-generated dynamic-loading inventory that fails on new HTTP/data module specifiers, browser third-party scripts without SRI, unexpected .smithers execution sources, raw npm install commands outside approved helpers, or extensionless imports in trusted control modules.
4. **Ongoing:** Generate an SBOM for each toolchain and sealed workflow dependency closure, store its digest with run provenance, and alert on dependency or image drift.

## Additional Recommendations

- Preserve the dashboard's current self-only CSP and external-file bootstrap design. Do not add unsafe-inline merely to simplify the theme bootstrap.
- Keep the existing workflow execution snapshot verification and controller-only environment stripping; they are meaningful controls once every input to the snapshot has trusted provenance.
- Extend security documentation to distinguish target data, project configuration, executable adapter code, and operator-approved custom code. Prompt review is not a substitute for approving JavaScript modules.
- Treat any future remote browser script as a new third-party trust decision: pin an exact version, add matching SRI plus crossorigin=anonymous, restrict CSP to the exact origin, and prefer self-hosting.
- Consider checksum/signature verification for externally downloaded non-JavaScript toolchain archives as a separate supply-chain hardening review; that broader binary-download topic was noted but not scored by this JavaScript-focused audit.

## Limitations

The audit was source-static and read-only. Container images and full workflows were not built or launched because those operations create repository/build artifacts and may contact external systems. The built dashboard bundle is not tracked, so the review used its source, Vite configuration, copy verification, and existing security-header regression tests rather than a fresh build. Public npm metadata was used only to corroborate that exact direct versions still expose transitive ranges; registry availability and publisher security were not assumed. These limitations do not prevent the identified trust-flow conclusions, which are established by the committed source paths above.
