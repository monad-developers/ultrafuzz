Closes #614

Related to #527.

## Prioritized scope

This draft implements the four secret-safety recommendations retained after review:

- **R-02:** fail closed before publishing canonical artifacts containing secrets.
- **R-05:** expand secret detection and apply exact in-memory run credentials to at-rest checks.
- **R-18:** stop persisting the Kimi API key in cleartext configuration.
- **R-28:** ignore common local environment, key, and credential files.

Exact reviewed head: `d4f73bcec97278bb17cd18ec4ccee47e7f2bcfcb`.

## What changed

- Canonical agent outputs and companion artifacts pass one immutable pre-publication secret gate covering maintained patterns, BIP-39 mnemonics, high-entropy values, exact active credentials, and printable content in binary evidence.
- Failure-ledger replay binds redacted values to explicit normalized span boundaries. Literal `<redacted>` input cannot forge provenance, and surrounding-context drift is rejected.
- Redaction inference is fail closed and bounded by source length, placeholder count, and probe count. Long-message truncation carries explicit provenance.
- Credential values are snapshotted before hostile error getters can execute. Error fields are read once under guards; fresh errors discard raw causes, stacks, and unknown metadata while preserving required retry, quota, checkpoint, session, and abort controls.
- Kimi API-key mode supplies the key only through the child environment; transient configuration contains no key and is removed during cleanup.
- `.gitignore` and the security documentation cover common local secret files and describe redaction as defense in depth rather than a completeness guarantee.

## Validation

- Independent local security review found no blocker.
- Security package: **17/17** tests passed.
- Artifacts package: **257/257** tests passed.
- Generated-agent regressions: **5/5** passed.
- Credential-rotation integration: **1/1** passed.
- Runtime typecheck, workspace lint, Prettier, diff checks, and schema parity passed.
- The exact aggregate containing this head passed a frozen install, production dependency audit, full workspace build, and local Modal suite (**561/561**). The remaining sharded exact-head release lanes are in progress; their merged report and SHA-256 will replace this sentence when complete.

No remote Modal workload was dispatched as part of this local validation; corrected-head GitHub CI is reported separately in the review response.

## Aggregate assurance

This head is included in prioritized aggregate `8c6a7985df4cc38404a577a0977f85e9f3e629a2` (tree `356c46c0f5afad4b052e5ff33a7150a44f2fc333`), based on `e0b872e387307128cc6fbf049e7623b031c5ff22`.

The aggregate's all-inclusive delta is **25 files, +1,831/−167 = 1,998 changed lines**, including dependency manifest and lockfile changes. ARI is assessed only on that aggregate candidate; this grouped PR makes no standalone ARI claim.

## YOLO invariant

Agent YOLO / bypass-permissions execution is unchanged. This PR adds no agent sandbox, command or egress allowlist, mediated filesystem reads, or in-run approval prompts. D-01–D-04 remain **Not Applied**.

This PR must remain a draft. #527 remains open.
