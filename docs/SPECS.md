# Ultrafuzz Specification

This document is the Ultrafuzz product specification. It describes the
behavior the TypeScript implementation is expected to provide, independent
of the workflow engine, process supervisor, UI framework, or package layout used
internally.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## Sources And Scope

This repository is the normative source for this spec. When older Ultrafuzz
documents or implementations disagree with this specification, this
specification wins unless this repository intentionally changes the product
contract.

Ultrafuzz is an agentic campaign orchestrator for Solidity smart contract
fuzzing. It initializes a project with editable campaign inputs, validates those
inputs before launch, compiles a workflow from product state, links that
workflow to durable run evidence, and leaves generated changes reviewable until
the operator explicitly materializes them.

Ultrafuzz is not a proof that a protocol is bug-free, an automatic vulnerability
submission system, an automatic production-code fixer, or a system that should
silently recover from missing graph, prompt, config, reference, or artifact
state.

## Product-Owned Surfaces

A fresh project initialization MUST create or preserve one root product file:

```text
ultrafuzz.toml
```

All other editable or generated Ultrafuzz product surfaces MUST live under
`.ultrafuzz/`:

```text
.ultrafuzz/
  topology.yml
  prompts/
  references.yml
  runs/
  workspaces/
  cache/
```

Initialization MUST preserve existing config, topology, prompts, and reference
catalog files unless the operator explicitly requests replacement. Runtime
execution MUST treat `.ultrafuzz/topology.yml` and `.ultrafuzz/prompts/**` as
canonical inputs.

Generated workflow-engine files MAY exist outside `.ultrafuzz/`, but they are
implementation plumbing and are not a stable user API.

## CLI Surface

The CLI product surface consists of:

| Command                | Required behavior                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `init`                 | Create root config plus `.ultrafuzz/**` product surfaces and workflow plumbing.                                            |
| `validate`             | Validate config, topology, prompts, references, path guards, agent references, and trust posture without launching agents. |
| `json validate`        | Validate one RFC 8259 JSON document against one local strict Draft 2020-12 schema without mutating either file.            |
| `run`                  | Validate, render prompts, build run evidence, compile and launch a linked workflow.                                        |
| `references status`    | Report whether pinned references are present in the local digest-checked cache.                                            |
| `references sync`      | Explicitly fetch pinned references into the local cache.                                                                   |
| `references update`    | Rewrite the project reference catalog to newer pinned commits when requested.                                              |
| `ps`                   | List Ultrafuzz runs and linked workflow status.                                                                            |
| `inspect <run-id>`     | Show product evidence and linked workflow details for a run.                                                               |
| `resume <run-id>`      | Delegate resume for the linked workflow after product checks.                                                              |
| `replay <run-id>`      | Delegate replay for the linked workflow after product checks.                                                              |
| `fork <run-id>`        | Delegate fork for the linked workflow after product checks.                                                                |
| `report <run-id>`      | Show the agent-written final report artifacts.                                                                             |
| `materialize <run-id>` | Copy selected reviewed outputs into the target project after confirmation and path checks.                                 |
| `clean <run-id>`       | Remove selected generated run paths after confirmation and path checks.                                                    |

Commands that support automation SHOULD emit a schema-versioned JSON envelope
with `ok`, `diagnostics`, and `data`.

`ultrafuzz json validate` MUST remain separate from project-wide `ultrafuzz
validate`. Its canonical invocation is:

```bash
ultrafuzz json validate --schema <schema.json> --file <artifact.json>
```

Exit `0` means portable whole-document shape validation succeeded. Exit `1`
means the producer-owned instance is missing, unreadable, invalid UTF-8/JSON,
contains duplicate keys, or violates the schema. Exit `2` means schema,
reference, invocation, resource, or tool setup failed. The CLI and host MUST use
the same strict, offline, worker-bounded parser and Ajv configuration and MUST
NOT coerce, default, remove, normalize, repair, or rewrite either file. Exit `0`
does not replace named host semantic/context gates.

## Configuration

`ultrafuzz.toml` is the operator-controlled runtime settings surface. It MUST
define typed project/run settings, model profiles, permission posture, invariant
defaults, and triage defaults. Strategy execution behavior MUST be selected in
topology, not in TOML.

A compatible config MUST support:

- `schema_version`
- `dynamic_strategies_enumerator`
- `[project] repo`
- `[run] output_dir`, `max_parallel_agents`, `max_parallel_nodes`,
  `keep_workspaces`, `workspace_mode`, `default_timeout_seconds`,
  `workflow_deadline_seconds`, and `controller_lease_seconds`
- `[models] default` plus `[models.<id>] agent`, `model`, and
  `timeout_seconds`
- `[permissions] trust_model`, `prompt_review_required`, and
  `materialize_outputs_as_unstaged`
- `[invariants] property_priority_threshold`,
  `invariant_testing_smoke_timeout`, and
  `invariant_testing_fuzzer_timeout`
- `[triage] quorum` and `panel_size`

`run.workspace_mode` MUST be `git-worktree`. Other workspace modes are outside
the product contract.

Unknown TOML keys MUST fail validation. Model profile IDs and agent references
MUST use safe identifiers. Omitted model selection in topology MUST resolve to
the configured default model profile only; model fan-out MUST be explicit in a
node or group default.

Config resolution SHOULD apply built-in defaults, project TOML, supported
environment overrides, and runtime overrides in deterministic order. The
resolved config MUST be persisted for each run. Persisted config intended for
display or replay SHOULD redact secret-looking values. Redaction placeholder
launch guards MAY be implemented; when implemented they MUST fail before launch
rather than running with literal placeholders.

## Topology

Topology MUST live at `.ultrafuzz/topology.yml`. The topology version specified
here is `2`. Version 1 is unsupported.

Topology is the campaign graph source of truth. It defines logical node IDs,
dependencies, groups, group defaults, node overrides, versioned output
contracts, prompt bindings, reference bindings, loop behavior, timeout
overrides, and explicit model-profile fan-out.

```yaml
version: 2
defaults:
  strategy_loops: 1
groups:
  strategies:
    label: Strategies
    color: "#7c3aed"
    defaults:
      loops: 3
      model_profiles:
        - default
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: boundary-tests
    kind: agentic
    prompt: strategies/boundary-tests.md
    group: strategies
    depends_on:
      - setup
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@2
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
```

Top-level fields:

- `version` MUST be `2`.
- `defaults.strategy_loops` is the global fallback loop count.
- `groups` MAY define labels, colors, and defaults.
- `nodes` MUST be an ordered list of logical nodes.

Group defaults MAY include `loops`, `timeout_seconds`, `max_attempts`, and
`model_profiles`.
Node fields override group defaults. The default scaffold SHOULD use three
loops for normal strategy nodes through the `strategies` group and explicit
`loops: 1` for exception flows such as stateful invariant and differential
groups.

Every node MUST define `id` and `depends_on`. Agentic nodes SHOULD define
`prompt` and `group`, and every executable node MUST define `outputs`. Each
output MUST name a resolvable, versioned contract, and exactly one output MUST
be primary. Meta nodes
MUST use `kind: meta` with `role: start` or `role: finish`. Reference nodes MUST
use `kind: reference` with a catalog `reference` ID and required reference
artifacts.

Validation MUST reject unsupported versions, missing nodes, duplicate IDs,
unsafe IDs, invalid groups, invalid colors, malformed meta/reference nodes,
unknown dependencies, duplicate dependencies, cycles, zero loops, expanded graph
size over implementation limits, missing or duplicate output paths, unresolved
contracts, missing or duplicate primary outputs, unknown topology fields,
invalid prompt paths, missing prompt
files when prompts are required, invalid model profile IDs, and prompt artifact
references to unknown or non-ancestor producers. The runtime-owned
`artifact-manifest.json` path MUST NOT be declared as a node output.

Loop expansion MUST be deterministic:

- `loops: 1` expands to concrete ID `id`.
- `loops: N` expands to `id-0` through `id-(N-1)`.
- `loop_mode: parallel` makes every attempt depend on expanded dependencies.
- `loop_mode: series` chains attempt `i` after attempt `i - 1`.

Concrete IDs MUST NOT collide. Expanded graphs SHOULD preserve graph version,
topology version, groups, logical ID, concrete ID, label, kind, dependencies,
artifact directory, loop metadata, contracted outputs, primary output marker,
timeout, reference revision, and model fan-out provenance.

Every planned JSON output MUST resolve through the checked-in schema registry.
The planned and expanded graph representations MUST persist the schema filename,
fragment-free schema ID, schema SHA-256, package schema-bundle SHA-256, and
validator build identity. Missing or partial bindings MUST fail planning or host
verification. Operators declare the versioned contract in topology; they MUST
NOT supply these trust identities manually in YAML.

## Prompts

Prompts MUST live under `.ultrafuzz/prompts/**` and SHOULD be Markdown or MDX
treated as Markdown-compatible prompt text. Runtime execution MUST prefer
project-owned prompt copies.

Prompt frontmatter MAY include only identity/display metadata:

```md
---
id: boundary-tests
display_name: Boundary Tests
---
```

`id` is execution identity. `display_name` is a label and MUST NOT change
execution identity by itself. Unknown frontmatter fields MUST fail validation.
Prompt frontmatter MUST NOT own execution knobs such as loops, enabled state,
model profiles, or timeouts.

Prompt rendering MUST happen before workflow launch and the rendered prompt
MUST be stored as a node artifact. Unknown template variables MUST fail
validation.

The prompt variable set includes:

- `repo_path`
- `workspace_path`
- `schema_path`
- `artifact_path`
- `artifact_dir`
- `ancestor_artifacts`
- `run_metadata_path`
- `output_findings_path`
- `output_patch_path`
- `strategy`
- `attempt_index`
- `strategy_loop_index`
- `strategy_loop_count`
- `triage_quorum`
- `triage_panel_size`
- `dynamic_strategies_enumerator`
- `invariant_property_priority_threshold`
- `invariant_property_priority_filter`
- `invariant_property_priorities`
- `invariant_testing_smoke_timeout`
- `invariant_testing_fuzzer_timeout`
- `strategy_attempt_test_dir`
- `artifact_path:<logical-node-id>`
- `artifact_handoff:<logical-node-id>`
- `ancestor_artifacts:<logical-node-id>[,<logical-node-id>...]`

Artifact handoff variables MUST resolve only to ancestor nodes. Handoff
producers MUST declare a primary contracted output. Exact artifact paths MUST
resolve to declared producer outputs. Ancestor artifact lists MUST use declared
outputs.

For every agent-authored JSON output, the centrally rendered output contract
MUST include one safely shell-quoted command using the exact resolved paths:

```text
Validation command: `ultrafuzz json validate --schema '<absolute schema path>' --file '<absolute artifact path>'`
```

The shared prompt MUST require the producer to write the canonical document,
run every command after its final write and before returning, correct and rerun
an exit-`1` draft during that same session, rerun after any later change, never
edit the supplied schema, treat exit `2` as a setup failure, and finish only
after every command exits `0`. It MUST say that validation is non-mutating and
that host semantic/context gates still run afterward. No validation receipt or
message-schema extension is required.

A deterministic workflow verification task MUST validate every agent output
before downstream tasks become eligible. Artifact manifests MUST record output
contract identities and digests plus the exact prerequisite manifest digests
consumed by the attempt. Runtime failure evidence MUST distinguish agent,
provider, artifact-contract, and dependency-cascade failures.

The terminal structured report MUST satisfy `ultrafuzz/report@2` before scoring
or publication. Invalid terminal output MUST persist a typed non-publishable
state without persisting raw output or diagnostics.

## References

Reference nodes are a product concept. `.ultrafuzz/references.yml` pins external
reference material to full commits and safe relative paths. Normal runs SHOULD
use only the local digest-checked cache. Fetching or updating references MUST be
an explicit operator action.

Reference materialization MUST write durable artifacts under the reference node
artifact directory, including normalized Markdown and `references/manifest.json`
when declared by topology. Missing cache entries, digest mismatches, unsafe
paths, unknown reference IDs, or missing required reference artifacts MUST fail
before dependent agentic nodes run.

## Execution And Lifecycle

Runtime MUST validate product state, render prompts, create run evidence,
compile workflow tasks, launch a linked workflow, and keep the linked workflow
identity in run metadata. The workflow engine is an implementation choice.

Before model work, a schema-backed producer MUST receive a host-managed
Ultrafuzz launcher ahead of target-controlled `PATH` entries. Local runs MUST
bind the launcher to the planned CLI bytes, validator build, and schema-bundle
digest in run-owned metadata. Modal MUST provide the equivalent root-owned,
read-only entrypoint. Both environments MUST run a real known-valid fixture and
verify the returned schema ID, schema digest, bundle digest, and validator build;
`command -v` alone is insufficient. A missing, tampered, or stale launcher is a
setup failure and MUST NOT be silently repaired on resume.

Before or at launch, each run MUST persist:

- `run.json`
- `source-run.json` when the run derives from another run
- `config.resolved.toml`
- `config.redactions.json`
- `graph.json`
- `graph.fingerprint`
- `state.json`
- `events.jsonl`
- `attempts.jsonl`
- `plan.json`
- `trusted-cli.json` and a run-owned trusted launcher for schema-backed producers
- immutable rendered prompt snapshots under `prompt-snapshots/`
- per-node artifacts under `artifacts/`
- review artifacts under `review/`
- event query indexes under `events.index/`
- workspace metadata under `workspaces/`

Reporting is agentic and lives in final-report artifacts.

Run and node state MUST be explicit. Node statuses MUST include pending,
ready, runnable, running, succeeded, failed, skipped, timed-out,
reused-from-prior-run, and invalidated. Run statuses MUST include pending,
running, paused, succeeded, failed, timed-out, and canceled.

Every nonterminal node MUST persist when its current wait began, a typed wait
reason, and the next action that can make it eligible. Run state MUST persist
the workflow deadline, last state transition, renewable controller-lease
status, requested and effective concurrency, queue depth, active work, and
queued, active, and idle durations. Lost-controller recovery MUST use an atomic
takeover claim and MUST NOT repeat completed work. Workflow deadlines and
recovery decisions MUST be testable with a fake clock.

Current run state MUST use schema version `ultrafuzz.run-state.v4` and schema ID
`urn:ultrafuzz:schema:artifacts:run-state:4`. Older persisted state and graph
versions MAY fail to resume, inspect, or render, but the failure MUST identify
the unsupported version. The runtime MUST NOT add a historical reader that
coerces old state into the current contract.

Run provenance MUST contain the complete sealed workflow binding. Node
provenance, when present, MUST match exactly one closed variant: execution,
pinned reference, or dependency blocker. Execution provenance MUST use the
canonical `output_contracts` field and complete agent/verifier task identities;
generic JSON values, `required_artifacts`, partial identities, and workflow-state
aliases MUST be rejected rather than normalized.

Completed node attempts MUST be appended immutably to `attempts.jsonl` with
stable strategy-attempt, executor-retry, checkpoint-generation,
workflow-execution, and controller-invocation identities. Entries MUST preserve
parent and reuse relationships, lifecycle timestamps, typed outcomes, and input
and output manifest digests. Attempt counts and terminal summaries MUST derive
from the ledger. Failure categories MUST remain separate from raw diagnostics,
and ledger entries MUST NOT persist raw inputs, outputs, or configuration.

`status`, `pause`, `resume`, `replay`, and `fork` operate on the linked workflow run. They SHOULD
perform product checks, delegate to the workflow engine, and persist updated
linked workflow identity or lifecycle evidence.

## Artifacts, Findings, And Reports

Node artifacts are the durable message-passing and evidence system. Required
artifacts MUST match topology declarations. Artifact paths MUST be safe,
project-local relative paths under the node artifact directory.

Artifact manifests MUST use `ultrafuzz.artifact-manifest.v2` and record run,
node, and producer identity; relative file paths, sizes, SHA-256 digests, and
provenance; output contract IDs and digests; exact prerequisite manifest
digests; and the primary marker. Every JSON output entry MUST also record the
complete `schema_file`, `schema_id`, `schema_sha256`,
`schema_bundle_sha256`, and `validator_build` binding. Non-JSON entries MUST
omit those fields. Runtime-owned manifests and verification markers MUST be
generated canonically as `ultrafuzz.artifact-manifest.v2` and
`ultrafuzz.artifact-verification.v2` documents and strictly validated against
their registered schemas. The host MUST NOT upgrade an old manifest or marker
in place.

Each retained agent-authored JSON handoff MUST have exactly one current named
contract, one complete Draft 2020-12 whole-document schema, and one canonical
version spelling. `ultrafuzz/json-object@1`, `ultrafuzz/json-array@1`, old
contract IDs, aliases, coercion readers, and compatibility fallbacks MUST NOT be
available. Where Zod remains useful for typed access, it MUST accept the same
shape as JSON Schema without preprocessing, transforms, defaults, coercion,
property stripping, or normalization. Constraints that JSON Schema cannot
express MUST remain explicit named semantic/context gates.

After the producer returns, every declared agent-owned artifact byte MUST stay
unchanged through host validation, synchronization, reporting, dashboard reads,
publication, and bundling. Missing or invalid output MUST be a terminal
post-agent failure. The runtime MUST NOT invoke a correction turn or full-node
model retry, synthesize an empty artifact or Markdown from a final response,
normalize or convert fields, reseal changed bytes, rebuild from dependencies,
or fall back to a sibling or historical artifact. Exact byte copying and
explicitly runtime-owned sidecars remain permitted.

Event logs MUST redact secret-looking payload values before persistence.
JSON/JSONL plus query indexes are sufficient; SQLite events are not required.

Findings MUST use `ultrafuzz/findings@2` and be arrays in `findings.json`.
Each finding MUST include exact `schema_version` literal
`ultrafuzz.finding.v2`, producer-authored `id`, `title`, canonical `status`,
preliminary `severity_guess`, lowercase `confidence`, and `summary`. Missing IDs
MUST NOT be synthesized.

Finding `status` MUST be one of:

- `candidate`
- `needs-review`
- `duplicate`
- `false-positive`
- `confirmed`
- `fixed`
- `wont-fix`

Other lifecycle strings and earlier schema-version spellings MUST be rejected.

When present, `triage_classification` MUST be one of:

- `true-positive`
- `false-positive`
- `undetermined`
- `incomplete-spec`
- `harness-defect`
- `repair-candidate`
- `spec-gated`
- `defensive-hardening`

Findings SHOULD preserve source node, strategy, attempt index, model profile,
model name, model index, loop index, affected files/functions, evidence,
patch references, notes, and dedupe or family metadata when available.
`evidence` entries MAY be non-empty string references or objects with optional
`kind`, `path`, and additional metadata. When present, object `kind` and `path`
values MUST be non-empty strings, and relative evidence paths MUST remain safe
artifact-relative paths without embedded selectors. A single source span MAY use
positive integer `line` and `end_line` metadata. Disjoint spans MUST use at least
two ordered `line_ranges` objects with a required positive integer `line` and an
optional `end_line` that does not precede it. Independent explanatory `detail`
MUST remain separate from structural range metadata.

Default review flows SHOULD deduplicate findings, classify severity, aggregate
generated tests, and write final report artifacts. `ultrafuzz report` MUST read
agent-written final-report artifacts such as:

```text
artifacts/final-report/report.md
artifacts/final-report/report.json
```

## Materialization And Cleanup

Materialization MUST be explicit, selected, confirmed, and path-safe. The
materialization surface is copy-only. Patch artifacts MAY exist as evidence, but
patch application MUST be rejected until a safe patch applier is implemented.

Materialized files SHOULD be left as ordinary unstaged working-tree changes.
Repository mutation constraints such as no commit, push, pull request, external
submission, staging, or merge are prompt-level trust assumptions and SHOULD be
expressed in prompts. Ultrafuzz does not treat those constraints as deterministic
repository-mutation enforcement.

Cleanup MUST remove only selected generated `.ultrafuzz/**` paths after
confirmation. It MUST reject unsafe paths, symlink escapes, missing selections,
and product state files that are not valid cleanup targets.

## Trust And Safety

Agents run under a trusted local execution model. Ultrafuzz does not maintain a
command allowlist, network allowlist, or sandbox approval policy as product
configuration. The durable product boundary is reviewable prompts before launch,
explicit references sync, durable artifacts, explicit materialization, and
normal repository review tools.

Product file operations MUST reject traversal, absolute-path injection, unsafe
relative paths, and symlink escapes. Run evidence SHOULD redact secret-looking
values before persistence.

## Dashboard And API Expectations

Dashboard/API is a product requirement. The target UX SHOULD match the
original Ultrafuzz direction: a local operator UI for graph inspection, run
status, evidence, prompt editing, topology editing, config review, report
review, materialization, and cleanup.

Dashboard/API servers MUST bind to loopback by default. Mutating APIs MUST use
local request protections and a cryptographically random session token. Path
and run-ID inputs MUST use the same safe-path and safe-ID validation as the CLI.

The dashboard SHOULD show logical topology nodes by default. Expanded attempts
and model fan-out MAY be shown in technical details, but edits SHOULD map back
to logical project files. Editors for prompts, topology, and config MUST
validate changes before accepting them and MUST NOT leave partial writes after a
failed validation.

Dashboard command jobs MUST map only to supported Ultrafuzz product operations.
Destructive or target-repo-mutating jobs such as clean and materialize MUST
require confirmation.

## Evaluation And Benchmarking Guidance

Evaluation SHOULD track true positives, underspecified but actionable findings,
false positives, precision, recall, F1, cost, wall-clock time, token usage,
model profile, strategy, loop count, attempt count, and cumulative unique valid
findings across repeated campaigns.

False positives in evaluation SHOULD be treated as harness defects when the
generated test fails for reasons that do not reflect production behavior.

Repeated campaign behavior SHOULD be evaluated like pass@k: a single campaign
can be useful, but repeated nondeterministic campaigns may reveal different
issue sets. Implementations SHOULD preserve enough provenance to measure which
strategies, attempts, and models found each issue.

Adjudication SHOULD use independent reviewers or model judges under a fixed
rubric. A quorum policy SHOULD determine whether a finding enters benchmark
counts or reports, and disagreements SHOULD remain inspectable.
