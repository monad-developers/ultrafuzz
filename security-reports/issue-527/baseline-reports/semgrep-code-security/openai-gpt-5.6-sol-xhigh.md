---
skill: "semgrep-code-security"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Private Semgrep Code Security Audit

## Scope and snapshot

- Repository: `monad-developers/ultrafuzz`
- Audited commit: `a634d948038f502e5e677477138dca0c763e2380`
- Skill: `semgrep-code-security`
- Audit status: complete for this snapshot
- Publication boundary: private report only; no tracked target-source or GitHub writes were made

The review applied the repository's documented trusted-local-execution model. Unrestricted model-agent command and network access, and same-UID host access, are explicitly accepted in `docs/security.md:3-13` and `docs/security.md:25-34`. The audit therefore concentrated on unintended failures in deterministic file handling, archive extraction, credential routing, network clients, dashboard exposure, publication workflows, dependency handling, and image provenance.

## Executive summary

Two security weaknesses were confirmed: one medium-severity supply-chain integrity gap in the Modal toolchain image and one low-severity remote-response memory-bound defect in live model-pricing retrieval. No critical or high-severity vulnerability was confirmed. In particular, manual tracing did not confirm command injection, archive traversal, XSS, dashboard cross-site mutation, credential redirect leakage, or a reachable exploit for the production dependency advisories reported by `pnpm audit`.

## M-01 — Medium

### Description

The Modal security toolchain is reconstructed from mutable or merely name/version-addressed upstream inputs without independent integrity verification. The standalone Dockerfile starts from `ubuntu:24.04` rather than a digest. It downloads Node.js, Foundry, and Recon release archives and extracts them without checking a committed checksum or signature. It also performs global npm and pip installs without a committed, hash-locked transitive dependency closure. The production Modal builder independently duplicates the same pattern and publishes the result under a `:latest` name.

This is materially security-sensitive because the resulting image is subsequently used for sandboxes that receive selected agent/provider credentials. A compromised registry, release asset, package account, or mutable tag can therefore introduce code that reads those credentials and private benchmark material. The repository pins candidate source and later binds launches to a Modal image ID, which prevents post-build drift, but it does not authenticate the upstream bytes at build time or make two builds of the same source commit reproducible.

### Evidence

- `packages/modal/Dockerfile:1` uses `FROM ubuntu:24.04` without an image digest.
- `packages/modal/Dockerfile:20-39` downloads and immediately extracts three executable archives and performs npm/pip installation without checksum/signature verification or hash-locked transitive dependencies.
- `packages/modal/src/runner.ts:2923-2937` builds the production toolchain from the same mutable base tag and unverified downloads/installations.
- `packages/modal/src/runner.ts:1377-1378` performs a further global Kimi CLI installation without a committed transitive lock before building the candidate image.
- `packages/modal/src/runner.ts:393-395` builds and publishes the toolchain as `ultrafuzz-security-toolchain:latest`.
- `packages/modal/src/node-provider.ts:283-296` creates a secret from selected agent credential values and attaches it to a sandbox running the configured image; benchmark launches likewise attach a secret at `packages/modal/src/runner.ts:838-846`.

### Impact and likelihood

Successful upstream substitution yields arbitrary code execution inside credential-bearing Modal sandboxes, with possible provider-credential theft, private-source disclosure, result tampering, and unauthorized spend. Exploitation requires control or compromise of an upstream distribution channel or package release, so the likelihood is lower than an input-driven code-execution flaw; medium severity reflects that prerequisite and the high downstream impact.

### Mitigation

Pin the Ubuntu base by immutable digest. Store expected SHA-256 values or verified signatures for Node.js, Foundry, and Recon artifacts in the repository and verify them before extraction. Build npm tooling from a committed lockfile with integrity metadata and use a hash-locked Python requirements file, such as `pip --require-hashes`, including transitive packages. Use an immutable apt snapshot or a separately attested base/toolchain image. Publish and consume toolchains by immutable image digest, include the complete upstream-material manifest in the source/image fingerprint, and fail closed on any digest mismatch. Add a release test that rejects un-digested bases, unchecked executable downloads, and unlocked package installation in both image definitions.

## L-01 — Low

### Description

The live model-pricing client applies its 25 MiB limit only after `Response.arrayBuffer()` has buffered the entire remote response. A server can therefore force allocation well beyond the stated limit before the code notices and rejects the body. The five-second timeout bounds time, not bytes, and does not prevent a fast oversized or high-throughput streamed response from creating substantial memory pressure.

The default endpoint is a third-party HTTPS catalog and the override is operator-controlled; the request carries no credential. Those constraints make this primarily a local availability weakness rather than a confidentiality or code-execution issue.

### Evidence

- `packages/runtime/src/model-pricing.ts:3-5` selects a remote default catalog and declares `MAX_CATALOG_BYTES` as 25 MiB.
- `packages/runtime/src/model-pricing.ts:97-109` chooses the default or environment override and fetches it.
- `packages/runtime/src/model-pricing.ts:113` calls `await response.arrayBuffer()`, consuming the complete response.
- Only afterward, at `packages/runtime/src/model-pricing.ts:114-116`, is the 25 MiB limit enforced.

### Impact and likelihood

A faulty or malicious catalog endpoint can cause excessive memory use and potentially terminate the CLI/runtime process, interrupting synchronization or accounting work. Exploitation requires control of the configured catalog or compromise or misbehavior of the default service, and the fetch is time-limited, so severity is low.

### Mitigation

Reject a numeric `Content-Length` above the limit before reading, then consume `response.body` incrementally with `getReader()`, tracking bytes and cancelling immediately once the total exceeds `MAX_CATALOG_BYTES`. Preserve the existing timeout and strict JSON limits. Also validate configured catalog schemes and consider `redirect: "error"` so a trusted endpoint cannot silently transfer the request to a different origin. Add tests for oversized declared, chunked, and no-length responses.

## Semgrep and manual methodology

The assigned skill and its required rule index, SQL-injection guidance, and XSS guidance were read and applied. The skill references `rules/command-injection.md`, but that file was absent from the assigned skill directory; equivalent sink tracing was performed manually.

Semgrep OSS 1.173.0 was run with `p/default` and `p/security-audit`, metrics disabled, over 705 Git-tracked files. It selected 279 applicable rules and produced 28 findings. Findings covering dynamic regular expressions, prototype-pollution heuristics, hand-written XML escaping, and pnpm supply-chain settings were manually traced. The dynamic expressions use fixed internal fragments or prevalidated identifiers; the flagged object traversals do not provide a confirmed global-prototype write primitive; and the SVG/XML emitters escape all XML metacharacters. Those scanner results were not promoted to issues.

Semgrep reported taint fixpoint timeouts in several large dashboard, runtime, Modal, eval, and generated-workflow files. Manual review therefore traced child-process calls, shell invocations, URL/credential clients, filesystem publications, archive readers, and generated-workflow control paths in those areas.

Manual review also covered:

- SQL/code injection: no database layer, dynamic `eval` of untrusted data, or `new Function` sink was found.
- Command execution: production subprocesses predominantly use executable/argument arrays. Inspected `bash -lc` uses were static or applied the dedicated single-quote encoder to every dynamic value.
- XSS: React rendering does not use raw-HTML APIs; generated SVG/chart text uses complete XML escaping.
- Dashboard: loopback-only binding, Host/Origin and cross-site request checks, mutation session tokens compared timing-safely, bounded bodies, strict JSON schemas, and CSP/frame/referrer/content-type headers were present.
- Paths and archives: Modal tar extraction rejects traversal, links, special types, duplicates, size overruns, symlinked destination components, and size mismatches. Public bundle extraction uses canonical allowlisted paths, exclusive no-follow staging, strict tree verification, and guarded replacement.
- GitHub Actions: third-party actions are pinned to full commit SHAs. Privileged `workflow_run` paths validate repository/event lineage and keep trusted default-branch tooling separate from candidate checkouts. User-selectable values are generally passed through environment variables.
- Secrets: pattern scanning found synthetic fixtures, not a production credential. No credential value is reproduced in this report.

## Dependency audit and reachability

`pnpm audit --prod --json` reported seven high-severity advisory entries: `adm-zip` 0.5.18, `brace-expansion` 2.1.1 and 5.0.7, and `fast-uri` 3.1.4.

These were not promoted as separate exploitable findings after reachability analysis:

- The current `adm-zip` advisory concerns allocation from the central-directory uncompressed size. `packages/cli/src/benchmark-analysis/lib/archive.ts:36-46` checks that declared size against the caller's bound before `getData()` and checks the observed length afterward.
- Both `brace-expansion` versions are transitive through Oclif/minimatch, and EJS/Jake/FileList for 2.x. No production call was found that passes an untrusted brace expression to those libraries.
- `fast-uri` is transitive through AJV. Security-sensitive repository/HTTPS values use stricter lexical patterns or manual `URL` checks. The unpatterned URI field in the public result bundle is lineage-bound data and is not used as a request authority.

The packages should nevertheless be upgraded promptly to reduce future reachability risk: `adm-zip >=0.6.0`, patched `brace-expansion` releases through parent dependency updates or overrides, and `fast-uri >=3.1.5`.

## Verification performed

A focused security regression selection was built and run from an isolated temporary copy. Six Modal suites passed: public worker, strict Modal documents, runtime-only auth, benchmark config, public bundle, and node-worker preflight. Result: 132 tests passed across 6 files.

The target worktree was clean at final verification, and the audited commit remained `a634d948038f502e5e677477138dca0c763e2380`.

## Limitations

Semgrep OSS did not provide Pro interfile analysis and reported fixpoint timeouts, so scanner completeness cannot be claimed; manual sink tracing was used to compensate. No live Modal sandbox, paid provider, private target, GitHub publication workflow, or external credential endpoint was exercised because that would require credentials or external state beyond this read-only audit. The Docker/toolchain supply chain was reviewed statically; upstream artifacts were not rebuilt or independently attested during this audit.
