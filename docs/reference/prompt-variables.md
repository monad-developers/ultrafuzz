# Prompt Variables

Prompts live under:

```text
.ultrafuzz/prompts/**
```

Markdown and MDX files are treated as Markdown-compatible prompt text with YAML
frontmatter and `{{variable}}` placeholders. MDX imports, exports, and JSX are
not evaluated.

Ultrafuzz renders prompts before workflow launch and writes each rendered prompt
to the node or attempt artifact directory as:

```text
prompt.rendered.md
```

Unknown template variables fail validation.

Runtime-generated topology nodes additionally receive item-scoped variables.
Scalar planner fields render as `{{item.<field>}}`; namespaced replacement keys
such as `{{liquidation:overdue}}` come from the item's `replacements` object.
Replacement values may reference other item-scoped variables recursively, with
cycle and depth checks. They cannot override built-in variables. See
[Runtime Dynamic Expansion](topology-yaml.md#runtime-dynamic-expansion).

## Frontmatter

Prompt frontmatter may contain only:

```md
---
id: boundary-tests
display_name: Boundary Tests
---
```

| Field          | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `id`           | Optional execution identity for the prompt catalog entry.                    |
| `display_name` | Optional label. Changing only this field does not change execution identity. |

Unknown frontmatter fields fail validation. Prompt frontmatter must not contain
execution knobs such as loops, enabled state, model profiles, categories,
timeouts, backend settings, or artifact requirements.

## Core Variables

| Variable                    | Meaning                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `repo_path`                 | Absolute path to the target repository being fuzzed.                               |
| `workspace_path`            | Absolute path to this node attempt workspace.                                      |
| `schema_path`               | Absolute path to the task-local checked-in JSON schema bundle.                     |
| `artifact_path`             | Absolute path to this node attempt artifact directory.                             |
| `artifact_dir`              | Alias for `artifact_path`.                                                         |
| `run_metadata_path`         | Absolute path to this run's `run.json`.                                            |
| `output_findings_path`      | Absolute path of this node's sole topology-declared `ultrafuzz/findings@2` output. |
| `output_patch_path`         | Absolute path reserved for a patch evidence file.                                  |
| `strategy`                  | Current logical topology node ID.                                                  |
| `attempt_index`             | Zero-based attempt index for this concrete attempt.                                |
| `strategy_loop_index`       | Zero-based loop index for this logical node.                                       |
| `strategy_loop_count`       | Total loop count for this logical node.                                            |
| `strategy_attempt_test_dir` | Absolute workspace path for generated Foundry tests from this attempt.             |

`output_findings_path` is topology authority, not a configurable filename.
Rendering fails unless the current node declares exactly one
`ultrafuzz/findings@2` output, and callers cannot override the variable through
prompt variables. Change the topology output declaration when a different path
is required.

## Triage And Invariant Variables

| Variable                                | Meaning                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `triage_quorum`                         | Resolved triage quorum.                                                        |
| `triage_panel_size`                     | Resolved triage panel size.                                                    |
| `dynamic_strategies_enumerator`         | Resolved dynamic strategy enumerator count.                                    |
| `invariant_property_priority_threshold` | Resolved invariant property priority threshold.                                |
| `invariant_property_priority_filter`    | Human-readable inclusive invariant priority filter derived from the threshold. |
| `invariant_property_priorities`         | Comma-separated invariant priority values selected by the inclusive threshold. |
| `invariant_testing_smoke_timeout`       | Configured bounded Recon deployment/compile smoke timeout.                     |
| `invariant_testing_fuzzer_timeout`      | Resolved invariant testing fuzzer timeout.                                     |

## Artifact Variables

| Variable                                              | Meaning                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `artifact_path:<logical-node-id>`                     | Absolute artifact directory path for an ancestor producer.         |
| `artifact_handoff:<logical-node-id>`                  | Absolute path to an ancestor producer's primary contracted output. |
| `ancestor_contract_artifact_authority:<contract>`     | Bounded task-local JSON selector for typed ancestor outputs.       |
| `ancestor_artifact_path_authority:<path>[,<path>...]` | Bounded task-local JSON selector for exact ancestor output paths.  |

Artifact variables may reference only ancestor nodes. Handoff producers must
declare exactly one `outputs` entry with `primary: true`.

`artifact_path` variables may include a safe relative suffix:

```md
Read the setup notes at {{artifact_path:setup-foundry}}/setup/setup-foundry.md.
```

`artifact_handoff` resolves to a file and does not accept a suffix.

The legacy collection helpers `ancestor_artifacts`,
`ancestor_artifacts_by_path`, `ancestor_generated_test_manifests`, and
`ancestor_generated_test_manifest_authorities` are rejected. Migrate them to a
compact contract or exact-path authority; generated-test intake normally uses
`ancestor_contract_artifact_authority:ultrafuzz/generated-tests@3`.

`ancestor_contract_artifact_authority:<contract>` selects transitive ancestor
outputs by an exact registered artifact contract, but does not render their
paths or a source-authority table into the prompt. It renders a bounded pointer
to `.ultrafuzz/authorities/<attemptId>.json` inside the current task workspace,
the exact current `attemptId`, and the requested contract. Unknown contracts
fail prompt validation.

`ancestor_artifact_path_authority:<path,...>` provides the same bounded sealed
JSON pointer while selecting transitive ancestor outputs by exact declared
output paths. It is appropriate when a consumer needs a fixed set of filenames
whose contracts are shared with unrelated outputs, such as final-report
fallback intake. It records the matching logical producers, canonically ordered
path group, and deterministic SHA-256 selector ID in the run plan. Prompt prose
contains only that fixed-size ID; the authenticated sidecar's matching
`selectors[]` entry carries the paths. Missing and duplicate path arguments
fail prompt validation.

Compact authority selectors are only for agentic task producers. If the exact
contract or path selector matches any `kind: reference` ancestor, rendering
fails closed, even when it also matches agentic ancestors. A consumer of a
fixed reference node must name it explicitly with
`artifact_path:<logical-node-id>` or `artifact_handoff:<logical-node-id>`.
Selectors with no matching ancestor remain valid and produce an empty authority.

The runtime generates that JSON immediately before each model attempt. It
reparses the controller-only sealed task manifest, authenticates the exact
required and marker-admitted optional dependency set, relocates it to the
current execution root, and projects only outputs matched by the current
prompt's compact selectors. The shared `controls/tasks.json` file is never
added to agent filesystem access.

The authority document contains its schema version, run and attempt IDs,
`artifact_path_base`, canonical selectors, and a `producers` array. Each
producer exposes only `attempt_id`, `logical_node_id`, a portable
`artifacts/<attemptId>` directory, and selected output `path`/`contract` pairs.
Resolve `artifact_dir` beneath `artifact_path_base` and append the output path;
reject absolute or escaping paths. An empty `producers` array means no matching
ancestor was admitted. Controller paths, source and workspace identity, model
metadata, unrelated tasks, and unselected outputs are absent. Exact authority
bytes are restored before retries and checked after every model call, so agent
mutation fails verification. Serialization is capped at 32 MiB and fails before
the runtime writes the task-local sidecar.

These compact authorities are used for findings lifecycle intake, property
lenses, boundary recipes, final-report machine handoffs, and differential
plan, reference-harness, lane-result, triage, and audited-lane coordinates.
Their rendered size is constant regardless of the number of looped or
model-fanout producers or the number of paths in an exact-path group. The
renderer still records the exact matching logical ancestor IDs and contract or
path filter in the run plan so topology validation and host semantic gates
share the same sealed-declaration selection. Filenames and hard-coded strategy
IDs are never producer authority.

Use deterministic split-work assignment for looped strategies:

```text
n % {{strategy_loop_count}} == {{strategy_loop_index}}
```

Dynamic topology items additionally expose scalar `item.*` values and a
bounded, item-scoped `replacements` map. Namespaced keys such as
`{{class:liquidation:fixed-term-before-overdue}}` and
`{{liquidation:overdue}}` resolve only from that item. A value such as
`{{item.goal_prompt}}` may retain those placeholders for the bounded nested
replacement pass; unresolved, cyclic, non-scalar, or non-item references fail.

## Output Contract

For every executable topology node, Ultrafuzz appends its declared output paths,
contract identities, shape requirements, primary artifact, and valid-empty
forms to the rendered prompt. The same registry drives runtime validation.

Agents should write durable cross-node handoff files under `{{artifact_path}}`
and list those files in topology `outputs` with a named contract.

Every agent-authored JSON output also receives safely shell-quoted schema and
contract validation commands of these forms:

```bash
ultrafuzz json validate --schema '<trusted absolute schema path>' --file '<absolute artifact path>'
ultrafuzz artifact validate '<contract-id>' '<absolute artifact path>'
```

For generated-test outputs, Ultrafuzz also appends an exact task-context
validation command whose `--run-id`, `--logical-node-id`, and `--artifact-root`
arguments come from the sealed task authority.

After its final write and before returning, the agent must run every displayed
command. Exit `1` means it must correct that draft and rerun the command in the
same session; exit `2` is a tool/setup failure, not successful validation. Any
later edit requires another validation run. Supplied schema files must not be
edited, and no validation command modifies the artifact. Ordinary contract
validation covers document-local semantics; generated-test task-context
validation also checks companion files plus the sealed run and logical
producer. The host still applies named contextual gates after the session
returns.

The schema filename, fragment-free schema ID, schema SHA-256, schema-bundle
SHA-256, and validator build identity are fixed during planning and persisted
with the output contract. The agent command runs through a trusted launcher that
is preflighted with a real fixture before model work; it must not select a
target-repository shadow binary. Once the session returns, Ultrafuzz does not
repair, normalize, convert, synthesize, or substitute required output and does
not request a correction turn. Missing or invalid post-session output is a
terminal attempt failure even if another file or the final response contains
similar data.
