---
skill: "auth-implementation-patterns"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Authentication and Authorization Security Review

## Snapshot

- Repository: `monad-developers/ultrafuzz`
- Commit: `a634d948038f502e5e677477138dca0c763e2380`
- Skill: `auth-implementation-patterns`
- Result: one high-severity finding

## Scope and approach

The review traced authentication credentials, request admission, authorization checks, session handling, OAuth refresh behavior, provider bearer-token delivery, credential-environment selection, and privilege-bearing dashboard operations across the dashboard, runtime, configuration, eval, Modal, and security packages. Searches covered the complete TypeScript/TSX source set and relevant schemas, tests, documentation, and package manifests.

This application does not implement user registration, passwords, JWT access or refresh tokens, OpenID Connect, or role-based application accounts. Consequently, password policy, JWT claim validation, refresh-token revocation, MFA, and RBAC hierarchy checks are not applicable to this snapshot. The principal in-repository request-authentication surface is the local dashboard. External model, telemetry, judge, and Modal services use API keys, subscription credential files, or OAuth tokens supplied by their respective platforms.

## H-01

Severity: high

The dashboard's session token is not an effective authorization boundary because any client that can connect to the loopback port can retrieve it.

`DashboardApp` generates a strong 256-bit random token, but `GET /api/session` is handled before any token check and returns the token in its JSON body. The only preceding control is `requireLocalRequest`, which checks header claims rather than a principal: a non-browser client can use a loopback Host value and omit Origin and Sec-Fetch-Site. It can then replay the returned value through `x-ultrafuzz-session`, satisfying every mutation check.

Loopback binding prevents direct connections from another host, but it does not distinguish operating-system users on the same host. On a shared development server, another unprivileged user can connect to the victim's loopback listener despite being unable to read the victim's repository or credential files. A response-capable SSRF into localhost has the same capability. Port forwarding or a local proxy can also accidentally extend this boundary.

The impact is broader than dashboard vandalism. Without the token, the same client can already read run reports, findings, rendered prompts, stdout/stderr, event history, configuration, and topology. After retrieving the token, it can overwrite validated configuration, topology, and prompt files; synchronize references; materialize or clean generated data when supplying the documented confirmation flag; and start, resume, replay, or fork workflows. Workflow launch runs under the dashboard owner's environment and provider authentication. Prompt modification followed by workflow launch creates a credible path to costly provider use and execution of model-directed commands with the victim's privileges.

### Evidence

- `packages/dashboard/src/index.ts:255` creates one random token for the server lifetime.
- `packages/dashboard/src/index.ts:294-299` applies only local-header checks before routing any API request.
- `packages/dashboard/src/index.ts:316-318` serves `GET /api/session` without a preexisting credential.
- `packages/dashboard/src/index.ts:510-516` places `sessionToken` in that response.
- `packages/dashboard/src/index.ts:1658-1670` accepts a loopback Host and permits absent Origin and Sec-Fetch-Site headers.
- `packages/dashboard/src/index.ts:1673-1678` makes the disclosed token the sole mutation credential.
- `packages/dashboard/src/index.ts:937-952`, `1006-1020`, and `1133-1202` perform project writes after that check.
- `packages/dashboard/src/index.ts:1275-1414` exposes privileged command jobs, including workflow launch and lifecycle operations.

A direct static request trace is sufficient to demonstrate the bypass: request the session document with a loopback Host, extract its token, and supply that token to any mutation. No guessing, race, cryptographic weakness, or victim browser interaction is required.

### Remediation

Use the token as an unguessable, out-of-band capability. A suitable browser flow is to include it in the URL fragment printed by the CLI, have the frontend consume and remove that fragment immediately, and attach it as a header to every API and streamed request. Fragments are not transmitted in the HTTP request or Referer. `GET /api/session` should require the capability and must not return it.

Require authorization for read APIs as well as mutations because they expose private repository-review material. Retain the random generation, constant-time comparison, no-store responses, and browser-origin protections as defense in depth. Exact Host and Origin comparisons should include the bound port, and missing Host should fail closed. For multi-user environments, an owner-restricted Unix socket or another OS-authenticated transport provides a stronger boundary than loopback TCP.

Regression tests should establish that an unauthenticated loopback client receives 401 for session bootstrap, read APIs, mutation APIs, and SSE streams; that the authenticated session document omits the token; and that the operator-delivered capability continues to authorize normal frontend behavior.

## Positive controls observed

- The dashboard token uses `crypto.randomBytes(32)` and comparison uses `crypto.timingSafeEqual`.
- Dashboard binding rejects configured non-loopback hosts and applies restrictive CSP, framing, resource, referrer, and cache headers.
- Eval and reporting bearer requests require HTTPS, reject credential-bearing URLs, and disable redirects; Braintrust custom origins require separate operator trust configuration.
- Kimi OAuth credentials are parsed as bounded strict JSON, refreshed under a lock, and atomically persisted with restrictive file modes.
- Workflow startup filters the environment to active agent credentials and explicitly selected variables rather than forwarding the entire host environment.
- API-key and subscription modes are type-checked, and unsupported provider/authentication combinations fail validation.

These controls do not remedy H-01 because the random dashboard capability is disclosed before authentication.

## Validation and limitations

`pnpm -w lint` completed successfully. A source-mode attempt to run the focused Modal authentication and judge-credential tests with Bun failed before any test body executed because the workspace alias `@ultrafuzz/artifacts` was unavailable without building packages. Building was not performed because the checkout was required to remain read-only. The failure does not affect the dashboard request trace underlying H-01.

The assigned skill directory contained only `SKILL.md`; the listed auxiliary references, assets, and token-validator script were absent. The complete methodology present in `SKILL.md` was applied directly. No credentials were used, and no credential values are included here. The checkout remained unmodified.
