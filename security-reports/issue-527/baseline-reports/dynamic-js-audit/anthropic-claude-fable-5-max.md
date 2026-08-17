---
skill: "dynamic-js-audit"
model_family: "anthropic"
intended_model: "claude-fable-5"
model: "claude-fable-5"
effort: "max"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# JavaScript Dependency & Dynamic Loading Security Audit Report

**Method:** method-03 (`dynamic-js-audit`) — JavaScript Dependency & Dynamic Loading Security Audit
**Target:** Ultrafuzz (local authorized checkout)
**Snapshot commit:** `a634d948038f502e5e677477138dca0c763e2380` (main — "fix(runtime): reconcile recovered terminal run status (#578) (#603)")
**Reviewer run:** independent ReviewExecutor, intended model claude-fable-5 (effort max)

---

## Executive Summary

Ultrafuzz is an agentic orchestrator for smart-contract fuzzing, implemented as a Node/TypeScript **pnpm monorepo** (12 packages). The method-03 checklist targets *dynamically loaded JavaScript in a web application*; in this repository the **only browser-facing web surface** is `packages/dashboard` — a loopback-bound Node `http` server (`packages/dashboard/src/index.ts`) that serves a **Vite-built React SPA** (`@xyflow/react` graph UI, `packages/dashboard/frontend`). There is exactly one tracked HTML file (`packages/dashboard/frontend/index.html`) and all `.tsx` lives in the dashboard.

**Bottom line: the dynamic-JavaScript attack surface is minimal and genuinely well-hardened. No Critical, High, or Medium issues were found.** The audit surfaced only four *informational* hardening notes, each mapped to a specific method-03 checklist item.

Key positives verified by direct inspection:

- **No third-party / CDN / analytics / ad / widget / payment scripts** load in the browser. Every browser script is **first-party, same-origin**, and Vite-bundled.
- **No iframes, no browser Web Workers, no Service Workers, no `window.postMessage`** handlers. (The `new Worker`/`postMessage`/`import()` hits in the repo are all **server-side Node** — `worker_threads` JSON validation and build/runtime ESM module loading.)
- **No raw-HTML sinks** anywhere in the frontend: no `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `insertAdjacentHTML`, `createElement('script')`, `eval`, or `new Function`. React auto-escaping applies throughout; the hand-rolled `MarkdownPreview` renders text as escaped React children and there is **no markdown library**.
- A **strict Content-Security-Policy** and a full complement of security headers are applied to **every** response.
- **SRI is not applicable** here (there are no cross-origin scripts) — this is a correct posture, not a gap.

---

## Discovery Results (method-03 Phase 1)

| # | Mechanism searched | Result in browser context | Evidence |
|---|---|---|---|
| 1 | `<script src>` tags | 2 first-party same-origin scripts only | index.html:8 (`/dashboard/theme-bootstrap.js`), :12 (`/src/main.tsx` → built `assets/dashboard.js`) |
| 2 | Inline `<script>` / event handlers | None | index.html (no inline JS); CSP forbids it (`script-src 'self'`) |
| 3 | `document.createElement('script')` | None | grep across 512 tracked src files: 0 hits |
| 4 | `innerHTML` / `outerHTML` / `document.write` / `insertAdjacentHTML` | None | grep: 0 hits |
| 5 | `dangerouslySetInnerHTML` | None | grep across full `main.tsx` + all frontend src: 0 hits |
| 6 | Dynamic `import()` (browser) | None in browser; all matches are server/build-time Node | e.g. runtime/src/templates/smithers/workflows/workflow.tsx:432; modal/src/runner.ts:242 |
| 7 | `eval` / `new Function` (browser) | None; matches are test-only or a regex string | runtime/test/*; runtime/src/artifact-gates.ts:8234 is a RegExp literal containing the substring "eval" |
| 8 | CDN / external script hosts | None in browser | only server-side fetch: runtime/src/model-pricing.ts:3 (`https://models.dev/api.json`, JSON, not a script) |
| 9 | `<iframe>` / dynamic iframes / `srcdoc` | None | grep: 0 hits |
| 10 | Web / Service / Shared Workers | None in browser | `new Worker` at artifacts/src/json-file-validator.ts:649/757/787 is **Node worker_threads** (`parentPort`) |
| 11 | `postMessage` / `message` listeners | None cross-origin | only Node MessagePort in artifacts/src/json-validation-worker.ts:79/206 |
| 12 | Outbound navigation sinks (`window.open`, `location=`, `.href=`, `javascript:`, `target=_blank`) | None | grep across frontend src: 0 hits |

**Data loading in the SPA** uses `fetch` (JSON APIs) and `EventSource` (SSE) exclusively (main.tsx:940, :1027), both same-origin (`/api/...`), constrained by CSP `connect-src 'self'`.

---

## Security Posture Assessment (method-03 Phases 2–3)

### A. Supply-chain risks
- **SRI:** Not applicable — there are zero cross-origin `<script>`/`<link>` resources; all assets are same-origin and Vite-bundled. Flagging "missing SRI" would be incorrect here.
- **Version pinning:** Dependencies are pinned via `pnpm-lock.yaml`; no `latest`/unpinned CDN references exist in browser code.
- **Self-hosting:** Already fully self-hosted (no external runtime scripts).
- **Build integrity (positive control):** `packages/dashboard/scripts/copy-assets.mjs` rejects a symlinked bundle, caps it at 16 MiB, and **asserts the shipped browser bundle contains no `require(` call** — a solid supply-chain/bundle-integrity guard.

### B. XSS vectors
- No HTML-injection sinks (see Discovery #3–#5). React escapes all interpolated values.
- `MarkdownPreview` (main.tsx:2876-2900) splits input into lines and emits `<h2>/<h3>/<br>/<p>` with the text passed as **React children** (`{line.slice(2)}`, `{line}`) — auto-escaped. Even agent-generated/config content routed through this preview cannot inject markup. `DiffView` (main.tsx:2902) behaves the same way.
- No `eval`/`new Function` in browser code.

### C. Iframe security
- Not applicable (no iframes). Defense-in-depth against the dashboard *being framed* is present: `X-Frame-Options: DENY` (index.ts:192) and CSP `frame-ancestors 'none'` (index.ts:181).

### D. Protocol & transport
- The server binds **loopback only** (`DEFAULT_HOST=127.0.0.1`, index.ts:166; `validateLoopbackHost`, index.ts:1651-1656). HTTPS/HSTS is N/A for `127.0.0.1`. No protocol-relative (`//host`) URLs in browser code.

### E. Data exposure / request-forgery
- All `/api/*` routes call `requireLocalRequest` (index.ts:1658-1671): loopback **Host** required, non-loopback **Origin** rejected, and `Sec-Fetch-Site: cross-site` rejected — this defeats both classic CSRF and **DNS-rebinding** reads of sensitive endpoints (findings/stdout/stderr/reports).
- Mutations additionally require a 256-bit session token compared in constant time (`requireMutation`, index.ts:1673-1679; `constantTimeEqual`, index.ts:1694-1698).
- Request bodies are size-capped (1 MiB) and strict-JSON parsed with depth/item limits (index.ts:1700-1739).
- The `/api/report` endpoint returns **JSON** (index.ts:344-346), rendered by React — not server-rendered HTML. Run artifacts are exposed only as **capped JSON text previews**; there is no raw file-download endpoint that streams agent content as `text/html`/`text/javascript`. The only `createReadStream().pipe()` is `sendStaticAsset` (index.ts:1786-1803), which serves solely the bundled `public/` directory behind a `..`/`\\` rejection (line 1789), an `assertPathInside` check (line 1793), an `isFile()` check (line 1794), and a fixed content-type map (index.ts:211-218).

### Content-Security-Policy (delivered on every response)

```
default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self';
form-action 'none'; frame-ancestors 'none'; img-src 'self' data:;
object-src 'none'; script-src 'self'; style-src 'self';
style-src-attr 'unsafe-inline'
```
(`packages/dashboard/src/index.ts:174-193`) plus `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. `applySecurityHeaders` (index.ts:1780-1784) runs via `setHeader` **before** every `writeHead`, and is invoked in the `createServer` callback prior to `app.handle` (index.ts:222-225), so the headers persist on HTML, JSON, SSE, static, and error responses alike. This is a strong, restrictive policy: no `unsafe-inline`/`unsafe-eval` for scripts, all fetch directives locked to `'none'`/`'self'`.

---

## Findings

All findings are **Informational** hardening notes. None is an exploitable dynamic-JS vulnerability.

### [Informational] I-01: `style-src-attr 'unsafe-inline'` allowance
**Location:** `packages/dashboard/src/index.ts:186` (uses `packages/dashboard/frontend/src/main.tsx:508,519`)
**Description:** The CSP permits inline style *attributes*. This is required by ReactFlow, which positions Handles via inline `style={{ top: ... }}`.
**Risk:** Very low. It does not affect script execution (`script-src 'self'`). CSS-level style injection would additionally require an HTML-injection primitive, which does not exist here.

#### Optional patch (only if inline styles are refactored away):
```diff
// File: packages/dashboard/src/index.ts (SECURITY_HEADERS)
    "script-src 'self'",
    "style-src 'self'",
-    "style-src-attr 'unsafe-inline'"
```
#### Explanation:
Dropping the directive is only safe after migrating dynamic inline styles to CSS classes / CSS custom properties; otherwise ReactFlow node/handle positioning breaks. Recommended action: **accept and document**. Never relax `script-src`.

### [Informational] I-02: `img-src 'self' data:`
**Location:** `packages/dashboard/src/index.ts:182`
**Description:** `data:` image URIs are permitted although the app's imagery is same-origin SVG (`favicon.svg`).
**Risk:** Negligible — `data:` images cannot execute script under this CSP.
#### Optional patch:
```diff
-    "img-src 'self' data:",
+    "img-src 'self'",
```
#### Explanation:
Verify ReactFlow/theme assets do not emit `data:` images before tightening. Low priority.

### [Informational] I-03: No CSP violation reporting
**Location:** `packages/dashboard/src/index.ts:174-193`
**Description:** No `report-uri`/`report-to` directive (method-03 Phase 3 lists this).
**Risk:** None to end users; reduces observability of CSP regressions during development.
#### Alternative (compensating control):
Add a `report-to` endpoint + `Reporting-Endpoints` header in dev/CI to catch policy regressions. Optional; low value for a localhost-only tool.

### [Informational] I-04: No-op `vite-ignore` attribute and dev entry in index.html
**Location:** `packages/dashboard/frontend/index.html:8` (and :12)
**Description:** `<script vite-ignore ...>` uses a non-standard attribute that has no browser effect (Vite's real hint is the `/* @vite-ignore */` comment on dynamic imports). The `/src/main.tsx` dev entry is rewritten to the built bundle by `vite build` + `copy-assets.mjs`.
**Risk:** None (cosmetic/misleading).
#### Optional patch:
```diff
-    <script vite-ignore src="/dashboard/theme-bootstrap.js"></script>
+    <script src="/dashboard/theme-bootstrap.js"></script>
```

---

## Remediation Roadmap (method-03 Phase 5)

1. **Immediate (Critical/High):** None. No RCE, data-exfiltration, XSS, or missing-SRI-on-external-script issues exist.
2. **Short-term (Medium):** None. CSP is already strict; iframe sandboxing is N/A; transport is loopback-only.
3. **Long-term (Low/Info):** Consider I-01–I-04 as optional hygiene: refactor inline styles to drop `style-src-attr` (I-01); tighten `img-src` if `data:` is unused (I-02); add CSP reporting in dev (I-03); remove the no-op attribute (I-04).

---

## Additional Recommendations

- **Preserve the current invariants** in review/CI: (a) no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in the frontend; (b) `applySecurityHeaders` before every `writeHead`; (c) loopback + Host/Origin/Sec-Fetch-Site + session-token checks on `/api/*`; (d) the `copy-assets.mjs` no-`require(` bundle assertion. A lint rule or unit test asserting the exact CSP string and the absence of raw-HTML sinks would prevent regressions.
- If a future feature introduces a real markdown/HTML renderer for agent-produced reports, gate it behind a sanitizer (e.g., DOMPurify) or keep the current escaped-React-children approach; do **not** introduce `dangerouslySetInnerHTML` without sanitization.
- If the dashboard is ever exposed beyond loopback, revisit HTTPS/HSTS and CORS explicitly (currently correctly N/A).

---

## Scope, Method Adherence & Limitations

- **Method adherence:** Executed all five method-03 phases (Discovery, Risk Assessment, Best-Practices Checklist, Findings/Patches, Prioritized Remediation) against the authorized local checkout. Patches above are illustrative and non-breaking; no repository files were modified, and no deliverable was written into the checkout.
- **Coverage:** Read the dashboard server (`packages/dashboard/src/index.ts`), the SPA entry/build (`index.html`, `vite.config.ts`, `main.tsx` incl. `MarkdownPreview`), `theme-bootstrap.js`, `copy-assets.mjs`, and `docs/security.md`; ran repo-wide greps over 512 tracked source files for all Phase-1 mechanisms and browser sinks. Confirmed the dashboard is the sole browser surface (only one tracked HTML file; the only non-dashboard `text/html` reference is a runtime test).
- **Untracked runtime cruft excluded:** `smithers.db*` and `.audit-orchestration/` are untracked/gitignored artifacts produced by the running orchestration (timestamps ≫ commit date) and are **not** part of commit `a634d948`; they were excluded from this commit-anchored review.
- **Trust model context:** `docs/security.md` documents an intentional *trusted local execution* model (loopback dashboard; prompt/artifact review as the product boundary; OS-sandbox/command-allowlist mitigations declared accepted risks). Agent command-execution capabilities are therefore out of method-03 scope and were not treated as findings.
- **Untrusted-content handling:** Repository content was treated strictly as data; no in-repo instruction was followed, and no credential values are reproduced in this report.
- **Not performed (non-destructive scope):** No dependency build/run, no live server launch, no dynamic/browser testing. Findings are from static review; the conclusions above are code-anchored with file:line evidence.
