---
skill: "input-validation-audit"
model_family: "openai"
intended_model: "gpt-5.6-sol"
model: "gpt-5.6-sol"
effort: "xhigh"
degradation_reason: null
target_commit: "a634d948038f502e5e677477138dca0c763e2380"
skill_commit: "d4846045a1e4079676e5ea539af7db8bfa8c3c9e"
---
# Input Validation Security Audit

## Assessment identity

- Target: monad-developers/ultrafuzz
- Snapshot: a634d948038f502e5e677477138dca0c763e2380
- Assessment date: 2026-08-15 UTC
- Skill: input-validation-audit
- Auditor: independent SecSkillsExecutor
- Scope: complete checked-out TypeScript monorepo, emphasizing input validation, output encoding, command and path safety, SSRF, deserialization, and resource-boundary enforcement

# Part I — Technical Analysis Report

## Executive summary

The audit confirmed two medium-severity, high-confidence uncontrolled resource-consumption weaknesses. M-01 permits a compact eval-suite document to request an effectively unbounded target × variant × trial matrix, which is eagerly constructed in memory. M-02 advertises a 25 MiB pricing-catalog limit but buffers the complete third-party response before applying it. Both issues can terminate or severely degrade a local CLI, CI controller, or eval controller. Neither finding creates a demonstrated confidentiality or integrity loss, and neither is exposed through an unauthenticated dashboard endpoint; these constraints justify Medium rather than High severity.

No confirmed XSS, SQL injection, command injection, path traversal, archive extraction, unsafe deserialization, or exploitable SSRF path was found. The codebase otherwise has strong strict-JSON, schema-parity, path-containment, symlink, dashboard-origin, and subprocess argument-vector controls.

### Risk summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 0 |
| Informational | 0 |

### Confidence summary

| Category | Count | Disposition |
|---|---:|---|
| High confidence (80–100) | 2 | Primary findings M-01 and M-02 |
| Medium confidence (50–79) | 0 | None |
| Low confidence (20–49) | 0 | None retained |
| False positive (0–19) | 7 classes | Documented below |

## Architecture overview

Ultrafuzz is a TypeScript/Node.js monorepo for initializing project-local audit configuration, expanding topologies and prompts, launching model-backed workflows locally or through Modal, collecting artifacts, planning and scoring eval suites, and serving a loopback React dashboard. Principal trust boundaries are repository-authored project files, generated model/workflow output, dashboard HTTP input, Git/archive content, and remote service responses.

### Data-flow diagram

~~~mermaid
graph LR
    U[Operator or CI] -->|CLI flags and environment| CLI[Oclif CLI]
    R[Project repository] -->|TOML YAML prompts catalogs| CFG[Config and schema loaders]
    CLI --> CFG
    CFG --> TOP[Topology and prompt expansion]
    CFG --> EVAL[Eval suite planner]
    EVAL -->|M-01 eager unbounded matrix| MEM[(Controller heap and CPU)]
    TOP --> RUN[Runtime and Smithers orchestration]
    RUN --> ART[Strict artifacts JSON JSONL reports]
    ART --> DASH[Loopback dashboard API]
    B[Browser] -->|bounded authenticated mutations| DASH
    DASH -->|React JSX text rendering| B
    P[Model and reporting providers] -->|bounded responses| RUN
    MD[models.dev or configured pricing catalog] -->|M-02 fully buffered response| MEM
    G[Git repositories and archives] -->|validated paths refs extraction| RUN
    RUN --> FS[(Workspace and run filesystem)]
~~~

### Trust-boundary diagram

~~~mermaid
graph TB
    subgraph Untrusted["Untrusted or externally controlled"]
      REPO[Checked-out repository content]
      MODEL[Model and workflow output]
      REMOTE[Third-party HTTP responses]
      HTTP[Dashboard HTTP headers paths and bodies]
      ARCH[Archives and public bundles]
    end

    subgraph App["Ultrafuzz application"]
      PARSE[Strict JSON YAML TOML and Zod/Ajv validation]
      POLICY[Path URL ID origin and semantic gates]
      PLAN[Topology eval and run planners]
      UI[React dashboard]
    end

    subgraph TrustedHost["Trusted host and operator boundary"]
      ENV[CLI flags environment and explicit endpoint trust]
      DISK[(Run roots caches and target workspace)]
      PROC[Git tar npm Smithers and model adapters]
    end

    REPO -->|schema and containment checks| PARSE
    MODEL -->|contract and byte checks| PARSE
    REMOTE -->|usually HTTPS redirect and byte controls| POLICY
    HTTP -->|loopback origin token and 1 MiB body cap| POLICY
    ARCH -->|entry path type count and size checks| POLICY
    ENV --> PLAN
    PARSE --> PLAN
    POLICY --> PLAN
    PLAN --> DISK
    PLAN --> PROC
    PARSE --> UI
~~~

### Attack-surface map

~~~mermaid
graph LR
    A1[CLI flags and env] --> S1[Path URL and process sinks]
    A2[Project TOML YAML eval suites] --> V1[Ajv Zod semantic gates]
    V1 --> S2[Planning and allocation]
    A3[Generated artifacts and logs] --> V2[Strict JSON schemas and safe paths]
    V2 --> S3[Persistence dashboard and reports]
    A4[Dashboard requests] --> V3[Loopback origin session token and body limits]
    V3 --> S4[Prompt and topology mutations]
    A5[Git archives and bundles] --> V4[Allowlisted paths no-follow and extraction limits]
    V4 --> S5[Filesystem writes and subprocesses]
    A6[Provider responses] --> V5[HTTPS redirects disabled and streaming limits]
    V5 --> S6[Scoring and reporting]
    A2 -->|M-01 missing total-work budget| F1[Heap and CPU exhaustion]
    A7[Pricing response] -->|M-02 limit after arrayBuffer| F2[Heap exhaustion]
    classDef finding fill:#ffd6d6,stroke:#a00,stroke-width:2px
    class F1,F2 finding
~~~

## High-confidence findings

### M-01

- Vulnerability type: uncontrolled resource consumption
- CWE: CWE-400
- Severity: Medium
- Confidence: 98/100
- Location: packages/evals/src/suite.ts:58, 197-210, 401-464; packages/evals/schema/eval-common.schema.json:25-28, 403-422; packages/evals/src/runner.ts:122-168
- Input source: an operator-, CI-, environment-, or repository-selected eval suite consumed by eval plan or eval run
- Affected assets: local CLI/controller process, CI job capacity, and eval orchestration availability

#### Description

The canonical JSON Schema and retained Zod parser accept trials_per_variant up to 9,007,199,254,740,991. The targets and variants arrays require at least one element but have no maximum. planEvalSuite eagerly creates one in-memory row for every target × variant × trial combination. There is no overflow-safe total-row calculation, documented work budget, or streaming plan. A small suite can therefore request work that cannot finish and will exhaust the process heap.

#### Source-to-sink trace

1. packages/cli/src/commands/eval/plan.ts:38-60 and packages/cli/src/commands/eval/run.ts:34-63 select a suite from a CLI flag, environment/config, or default project path.
2. packages/evals/src/suite.ts:278-311 parses and validates the suite.
3. packages/evals/src/suite.ts:58 and 203-210 accept a safe integer but no operationally safe trial or array bound.
4. packages/evals/src/suite.ts:423-455 enters three nested loops and pushes every row into one matrix array.
5. packages/evals/src/runner.ts:123 plans before creating the eval run; lines 152-168 subsequently serialize and schedule the complete matrix.

#### Relevant code

~~~typescript
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// ...
targets: z.array(targetSchema).min(1),
variants: z.array(variantSchema).min(1),
// ...
for (const target of targets) {
  for (const variant of variants) {
    for (let trial = 1; trial <= loaded.suite.run.trials_per_variant; trial += 1) {
      matrix.push(/* full row */);
    }
  }
}
~~~

#### Controlled validation

A valid temporary suite with one target, one variant, and 100,000 trials was accepted and produced exactly 100,000 rows. Planning completed in approximately 309 ms with a maximum resident set of 168,620 KiB. The one-row control used 139,404 KiB, so 99,999 additional rows added approximately 29 MiB in this bounded experiment; growth is linear and continues until failure.

The supplied validate_finding.py framework scored the path 80/100 before dynamic evidence. An independent validation agent confirmed CWE-400, Medium severity, and 97/100 confidence. Dynamic confirmation raises final confidence to 98/100.

#### Exploit scenario

A contributor commits or supplies an otherwise valid eval suite containing one target, one variant, and a very large trials_per_variant value. An operator or CI task runs eval plan with target validation skipped, or eval run with a valid target/ref. Schema validation succeeds, after which the controller consumes CPU and heap constructing rows until V8 terminates for out-of-memory or the job is killed.

#### Impact assessment

- Confidentiality: None demonstrated.
- Integrity: None demonstrated; planning occurs before durable run creation in the primary path.
- Availability: High for the affected local process or CI job.
- Business impact: stalled benchmark pipelines, wasted controller capacity, and denial of eval service where suite changes cross a repository/CI trust boundary.
- Scope constraint: an operator or CI system must explicitly process the suite; this is not an unauthenticated network request.

#### Recommended fix

Define a documented absolute MAX_EVAL_MATRIX_ROWS and enforce it before resolving targets, allocating the matrix, or iterating. Use BigInt or division guards so multiplication cannot overflow. Add per-field limits to the JSON Schema and Zod definition, including maxItems for targets and variants and a realistic maximum for trials_per_variant. Cap parallelism fields as well. Streaming output can reduce peak memory but must not replace an absolute work budget.

~~~typescript
const MAX_EVAL_MATRIX_ROWS = 10_000n;
const rowCount =
  BigInt(suite.targets.length) *
  BigInt(suite.variants.length) *
  BigInt(suite.run.trials_per_variant);

if (rowCount > MAX_EVAL_MATRIX_ROWS) {
  throw new EvalError("EVAL_MATRIX_TOO_LARGE", "eval matrix exceeds the row budget", {
    maxRows: Number(MAX_EVAL_MATRIX_ROWS)
  });
}
~~~

#### Verification after remediation

Test one row, exactly the documented maximum, maximum plus one, each individual cardinality cap, and multiplicative combinations that exceed the total despite individually valid fields. Assert failure occurs before target resolution, allocation, run-root creation, or output writes. Preserve Ajv/Zod parity tests at every boundary.

### M-02

- Vulnerability type: uncontrolled resource consumption from an unbounded remote response
- CWE: CWE-400 / CWE-770
- Severity: Medium
- Confidence: 94/100
- Location: packages/runtime/src/model-pricing.ts:3-5, 84-125; packages/runtime/src/workflow-sync.ts:1182-1209; packages/cli/src/commands/stats.ts:125-143; packages/evals/src/runner.ts:506-564, 650-661
- Input source: the default third-party models.dev response or a response from an explicitly configured pricing-catalog URL
- Affected assets: local stats, workflow synchronization, eval watch/controller processes, and CI availability

#### Description

resolveLiveModelPricing defines a 25 MiB maximum but calls response.arrayBuffer() and then Buffer.from() before checking bytes.byteLength. The transport can therefore stream and allocate an arbitrarily large response, potentially with an additional Buffer copy, before the limit or strict-JSON parser runs. The five-second default timeout bounds time but not bytes; a fast server can send much more than 25 MiB in that interval. Catching an exception does not reliably recover from fatal heap exhaustion.

#### Source-to-sink trace

1. Workflow accounting finds a non-empty usage ledger with an unpriced model at packages/runtime/src/workflow-sync.ts:1182-1209.
2. resolveLiveModelPricing selects the fixed HTTPS models.dev URL or operator-configured catalog at packages/runtime/src/model-pricing.ts:84-103.
3. fetch begins with a timeout but no redirect rejection, Content-Length preflight, or streaming byte counter at lines 104-109.
4. response.arrayBuffer() consumes the complete body and Buffer.from() materializes it at line 113.
5. The 25 MiB check at lines 114-115 and strict JSON limits at lines 120-125 run only after allocation.
6. CLI stats and eval polling reach synchronization; unavailable pricing may be retried.

#### Relevant code

~~~typescript
const response = await fetch(sourceUrl, {
  headers: { accept: "application/json" },
  signal: input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal])
});
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.byteLength > MAX_CATALOG_BYTES) {
  throw new Error("pricing catalog exceeded the maximum response size");
}
~~~

#### Controlled validation

A substituted Response with a no-Content-Length ReadableStream emitted thirty 1 MiB chunks. The production function pulled all 30 chunks (31,457,280 bytes), never invoked stream cancellation, and only then returned pricing status unavailable. Maximum resident set was 163,952 KiB. Independent validation repeated stream and local-HTTP variants and observed complete-body consumption, no early close, and approximately 183 MiB maximum RSS for the HTTP variant.

The supplied validate_finding.py framework scored the path 80/100. Independent validation assigned 94/100 confidence and confirmed that existing timeouts and post-read strict-JSON limits do not close the transport-allocation gap.

#### Exploit scenario

A compromised pricing service, hostile configured catalog, or redirected endpoint responds quickly with an oversized or endless body when stats or eval synchronization needs prices for an unpriced model. The controller buffers data until the response ends, timeout aborts, or the process runs out of memory. Repeated eval polling can retry unavailable pricing.

#### Impact assessment

- Confidentiality: None demonstrated.
- Integrity: None demonstrated.
- Availability: High for the affected local synchronization/controller process.
- Business impact: failed stats collection, disrupted eval monitoring, controller restarts, and repeated capacity consumption.
- Scope constraint: an attacker must control or compromise the pricing origin, or an origin explicitly configured by an operator; the fixed default uses HTTPS.

#### Recommended fix

Read the response as a bounded stream. Reject a valid Content-Length above the limit before reading, count bytes safely while reading chunked bodies, cancel immediately when the cumulative total exceeds 25 MiB, and concatenate only after bounded completion. packages/modal/src/bounded-response.ts demonstrates the desired pattern. Retain timeout and strict-JSON limits, set redirect: "error" or validate every redirect target, and consider backoff or caching for unavailable catalogs.

#### Verification after remediation

Test exact-limit acceptance, one-byte-over rejection, oversized declared Content-Length, no-length chunked overflow, lying Content-Length, cancellation/connection closure, timeout behavior, and repeated unavailable synchronization. Assert the reader does not retain or pull chunks after the cap is crossed.

## Medium-confidence findings

None.

## Low-confidence findings

None retained. Remaining suspicious patterns were traced to explicit trust decisions or controls that reduce them below the reporting threshold.

## Checked false positives

| Class | Confidence | Evidence and disposition |
|---|---:|---|
| XSS | 5/100 | Dashboard content is rendered through React JSX. MarkdownPreview constructs h2, h3, p, and br nodes from strings at packages/dashboard/frontend/src/main.tsx:2876-2899. No dangerous HTML sink was found. Restrictive CSP/security headers are configured in packages/dashboard/src/index.ts. |
| SQL injection | 0/100 | No application database/query layer or SQL execution sink was identified. Scanner matches were generic method-name false positives. |
| Command injection | 10/100 | Production subprocesses predominantly use execFile/spawn argument arrays. Observed bash -lc calls use fixed generated literals, while GitHub components, full SHAs, paths, topology commands, and benchmark repositories are constrained before use. |
| Path traversal and Zip Slip | 8/100 | safeResolveInside/assertPathInside, no-follow snapshots, allowlisted bundle paths, duplicate rejection, archive entry/type/count/size limits, symlink rejection, and strict extracted-tree verification protect reviewed paths. |
| SSRF | 15/100 | Provider clients require HTTPS and canonical or explicitly trusted origins, reject redirects, and bound response bytes. Custom broker/provider/catalog URLs are operator trust decisions. If untrusted tenants can set process environment, this conclusion must be revisited. M-02 separately covers pricing-response size enforcement. |
| Unsafe deserialization | 5/100 | JSON uses duplicate-key-safe strict parsers and registered schemas; YAML is parsed as data and followed by closed Zod/Ajv validation. No eval, Function, pickle-like, or executable YAML deserializer was found. |
| Dashboard CSRF/path abuse | 5/100 | The server binds only to loopback, validates Host/Origin/Sec-Fetch-Site, requires a random session token for mutations, caps request bodies at 1 MiB while streaming, uses strict JSON, and constrains static assets. |

## Complete input inventory

| Input source | Trust | Principal consumers | Validation/encoding |
|---|---|---|---|
| CLI flags and positional arguments | Operator-controlled | CLI commands, path selection, concurrency, run/eval IDs | Oclif typing/minima, safe-ID validators, path policies; some values intentionally express operator trust |
| Environment variables | Semi-trusted/operator | Provider endpoints, credentials, eval config, pricing, model adapters | Provider-specific parsing, HTTPS/origin gates, enums/numeric bounds; custom pricing URL is an explicit trust seam |
| Project TOML/YAML | Repository-controlled | Config, topology, audit profiles, eval suites | TOML/YAML parsing followed by closed schemas and semantic gates; M-01 lacks an operational total-work cap |
| Prompt and reference Markdown/catalogs | Repository/external reference | Topology expansion and model prompts | Safe relative paths, reference owner/repo/SHA/path validation, digest manifests |
| Dashboard method/path/headers/body | Local browser/client | Dashboard APIs and mutations | Loopback Host/Origin checks, session token, strict schemas, 1 MiB streaming body cap |
| Dashboard API/SSE responses and persisted artifacts | Semi-trusted/generated | React frontend | Current schemas, bounded readers, duplicate-key rejection, JSX text rendering |
| Generated model/workflow output and logs | Untrusted | Artifact verification, reports, dashboard, eval scoring | Strict JSON/JSONL, registered contracts, semantic joins, byte/depth/item/property bounds, output-context encoding |
| Target repository files and Git metadata | Repository-controlled | Materialization, pinning, workspace handoff | Containment, no-follow/symlink checks, digest and ref verification, argument-vector Git calls |
| Tar archives and public benchmark bundles | Untrusted | Cloud handoff and publication extraction | Traversal/type/duplicate/overwrite checks, entry and byte limits, canonical base64/digests, staging and strict-tree checks |
| Ground truth, eval history, matrices, run documents | Private/semi-trusted | Planning, scoring, comparison, reporting | Regular-file/containment checks, current strict schemas, semantic identity/lineage gates, byte limits except M-01 work factor |
| Model judge, Braintrust, credential-broker responses | Third-party | Scoring, reporting, authentication | HTTPS, redirects disabled, timeout, streaming byte caps, strict JSON and response schemas |
| Pricing catalog response | Third-party | Accounting during sync/stats/eval watch | Timeout and strict JSON exist, but M-02 shows the byte cap is post-buffer |
| Modal inputs/results and cloud worker state | External boundary | Public/private workers and node provider | Strict Modal contracts, canonical trusted roots, archive/result verification, bounded credential responses |
| CI script arguments and Git refs | CI-controlled | Release/eval-history scripts | Fixed command arrays and constrained paths; outside ordinary unauthenticated runtime exposure |

## Sink inventory

| Sink | Reviewed locations | Result |
|---|---|---|
| Browser HTML/DOM rendering | Dashboard frontend | React text encoding; no unsafe HTML execution sink found |
| Shell/subprocess execution | Runtime, references, Modal, scripts | Argument-vector APIs dominate; fixed shell snippets and validated dynamic arguments |
| Filesystem read/write/delete | Artifacts, runtime, dashboard, Modal, evals | Strong containment, no-follow, symlink, inode, and atomic publication controls |
| Archive creation/extraction | Modal and public bundles | Safe tar extraction and strict staged bundle extraction |
| HTTP fetch | Eval reporters/judge, runtime pricing, Modal broker | Most are bounded and redirect-safe; M-02 is the confirmed exception |
| JSON/YAML/TOML parsing | All core packages | Strict JSON plus schemas and semantic gates; data-only YAML/TOML parsing |
| In-memory expansion/allocation | Topology and eval planner | Topology caps at 4,096 nodes and 256 loops; M-01 eval matrix is uncapped |
| Persistence/logging | JSON/JSONL artifacts, reports, audit journals | Current schemas, duplicate-key rejection, redaction, bounded diagnostics |
| SQL/LDAP/XML/email headers | None identified | No relevant production sink found |

## Validation coverage map

| Boundary | Type/shape | Length/cardinality | Semantic/containment | Output/sink protection | Status |
|---|---|---|---|---|---|
| Dashboard body | Yes | 1 MiB, depth/items/properties | Host/origin/token and registered schemas | React JSX/CSP | Covered |
| Eval suite | Yes | Safe-integer only; no total matrix cap | IDs/profiles/paths | Eager allocation | M-01 |
| Pricing response | Strict JSON after read | Nominal 25 MiB after allocation | Timeout only | Accounting parser | M-02 |
| Other provider responses | Yes | Streaming response caps | HTTPS/origin/redirect controls | Schema normalization | Covered |
| Topology | Yes | 4,096 logical/expanded nodes; 256 loops | Graph and prompt-path semantics | Bounded expansion | Covered |
| Ground truth/history | Yes | 1 MiB/64 MiB and list limits | Lineage/subject/regular-file gates | Deterministic scoring | Covered |
| Artifacts/JSONL | Yes | Contract-specific limits | Identity, ordering, semantic joins | Atomic durable writes | Covered |
| Archives/bundles | Yes | Entry, file, total-byte limits | Traversal/symlink/duplicate/tree gates | Staged exclusive writes | Covered |
| Git/reference inputs | Yes | Full SHA and safe component/path rules | Pin/digest/ref verification | execFile arrays | Covered |
| Dashboard display data | Current wire schemas | Bounded HTTP/SSE readers | Authority snapshots | JSX text nodes | Covered |

## Testing and validation performed

All build and test activity that could create outputs was run against a temporary mirror of the anchored snapshot; the target's tracked worktree remained clean.

- Read the assigned SKILL.md in full, plus vulnerability-patterns.md, secure-coding-practices.md, encoding-reference.md, security-audit-guide.md, find_sinks.py, trace_dataflow.py, and validate_finding.py. The referenced report-templates.md is absent from the supplied skill directory.
- The supplied sink scanner produced 6,784 raw heuristic matches across package trees, including tests and linked dependency code: 6,107 path, 467 deserialization, 70 command, 61 XSS, 54 SSRF, and 25 SQL. These are candidates, not vulnerabilities; first-party production paths were manually traced in both directions.
- 161 targeted eval, Modal-document/public-bundle, and topology assertions passed.
- The official artifacts suite passed 250/250 assertions.
- The official dashboard suite passed 35/35 assertions.
- The official references suite passed 9/9 assertions.
- The runtime materialization suite passed 5/5 assertions.
- Total relevant passing assertions: 460.
- M-01 and M-02 were run through validate_finding.py and independently validated by separate agents.
- Controlled runtime tests confirmed both resource-boundary failures without contacting production services or destabilizing the host.

## Methodology

The assessment used broad input classification, repository and package discovery, architecture and trust diagrams, complete input and sink inventories, forward input-to-sink tracing, backward sink-to-origin tracing, heuristic sink scanning, framework-protection review, independent validation, confidence scoring, controlled dynamic reproduction, and targeted tests. Findings below 50 confidence were excluded from the primary list and documented as checked false positives.

## Limitations

- No production, private provider, Modal cloud, or GitHub mutation was performed.
- Network conclusions are based on source tracing, controlled Response substitutes, and existing tests rather than production traffic.
- Static analysis cannot prove the absence of every environment-specific misconfiguration.
- The regex scanner over-reports common method names; reported issues rely on manual data-flow evidence rather than scanner counts.
- The skill's referenced report-templates.md was unavailable; the complete structure in SKILL.md and the available guide were used instead.

## Recommendations

### Immediate and short term

1. For M-01, add a fail-early absolute eval-matrix row budget and schema-level per-dimension caps. Target: next patch release; effort: low to medium.
2. For M-02, replace arrayBuffer with a streaming bounded reader, cancel on overflow, reject redirects, and add adversarial stream tests. Target: next patch release; effort: low.
3. Add regression assertions that every stated network byte limit is enforced before complete body materialization.

### Long term

1. Centralize operational budgets for bytes, collection cardinality, multiplicative work, concurrency, and retries.
2. Add property-based boundary tests at maximum, maximum plus one, integer overflow, missing Content-Length, and chunked transport seams.
3. Document which custom endpoints are operator trust decisions and apply consistent HTTPS, origin, and redirect policies.
4. Preserve existing schema parity, strict JSON, no-follow filesystem, and dashboard-origin controls as mandatory review gates.

# Part II — Audit-Ready Report

## Executive summary

At commit a634d948038f502e5e677477138dca0c763e2380, this assessment found two high-confidence Medium availability weaknesses and no Critical or High findings. One allows repository/operator eval input to request an unbounded in-memory matrix; the other buffers an untrusted pricing response before applying its documented size limit. Both should be addressed in the next patch release.

## Formal findings

### M-01

A valid compact eval suite can select an effectively unbounded number of matrix rows because trials_per_variant accepts Number.MAX_SAFE_INTEGER, target and variant arrays have no maxima, and the planner eagerly pushes every Cartesian-product row into memory. Confidence is 98/100. The impact is local or CI controller denial of service. Enforce an overflow-safe total-row budget before planning, add JSON Schema/Zod cardinality caps, and test exact boundaries.

### M-02

The pricing catalog's 25 MiB maximum is checked only after response.arrayBuffer() and Buffer.from() consume the complete third-party body. Confidence is 94/100. A compromised or explicitly configured hostile catalog can exhaust a stats or eval controller. Stream with a cumulative byte counter, preflight Content-Length, cancel on overflow, reject redirects, and retain strict JSON validation after the bounded read.

## Remediation tracking

| Finding | Severity | Priority | Suggested owner | Target | Verification |
|---|---|---|---|---|---|
| M-01 | Medium | P1 | Evals maintainers | Next patch | Maximum/maximum-plus-one and multiplicative boundary tests |
| M-02 | Medium | P1 | Runtime maintainers | Next patch | Chunked overflow, cancellation, and redirect tests |

## Independent verification guide

For M-01, create a temporary valid suite with one target and variant and a value just above the new total budget. Run eval plan with target validation disabled. The fixed version must return a typed size diagnostic before allocating rows or creating run output. Repeat with multiple targets and variants whose product crosses the cap.

For M-02, inject a ReadableStream response without Content-Length and chunks totaling one byte above 25 MiB. The fixed reader must cancel on the crossing chunk, return unavailable pricing without retaining the complete body, and keep memory bounded. Repeat with an oversized declared Content-Length and a redirect.

## Final conclusion

The repository's validation baseline is strong, particularly around strict JSON, schema parity, filesystem containment, archives, dashboard request isolation, and safe subprocess APIs. Closing M-01 and M-02 will align resource validation with those existing fail-closed controls.
