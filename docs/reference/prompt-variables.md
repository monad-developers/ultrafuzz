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

| Variable                                                      | Meaning                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ancestor_artifacts`                                          | Markdown list of required artifact files from direct topology dependencies.    |
| `artifact_path:<logical-node-id>`                             | Absolute artifact directory path for an ancestor producer.                     |
| `artifact_handoff:<logical-node-id>`                          | Absolute path to an ancestor producer's primary contracted output.             |
| `ancestor_artifacts:<logical-node-id>[,<logical-node-id>...]` | Markdown list of required artifact files from selected ancestor producers.     |
| `ancestor_artifacts_by_path:<path>[,<path>...]`               | Markdown list of matching declared outputs from any ancestor producer.         |
| `ancestor_generated_test_manifests`                           | Contract-derived list of generated-test manifests from all ancestor producers. |

Artifact variables may reference only ancestor nodes. Handoff producers must
declare exactly one `outputs` entry with `primary: true`.

`artifact_path` variables may include a safe relative suffix:

```md
Read the setup notes at {{artifact_path:setup-foundry}}/setup/setup-foundry.md.
```

`artifact_handoff` resolves to a file and does not accept a suffix.
`ancestor_artifacts` resolves to declared contracted outputs and does not
accept a suffix.
`ancestor_artifacts_by_path` accepts safe, exact output-relative paths and
renders `None declared by this topology.` when no ancestor declares a match.
This makes optional handoffs explicit without rendering unrelated outputs.

`ancestor_generated_test_manifests` takes no argument. It walks the full
transitive ancestor graph and selects only outputs declared with the exact
`ultrafuzz/generated-tests@3` contract. For each matching logical producer, it
renders the absolute declared output path under every producer artifact
directory represented in the render graph. Paths are sorted; one match renders
as a plain path and multiple matches render as a Markdown bullet list.
Findings-only ancestors and non-ancestor generated-test producers are excluded,
and paths are never inferred from a filename or hardcoded strategy list. When
no ancestor declares a matching output, the variable renders the same
`None declared by this topology.` sentinel as `ancestor_artifacts_by_path`, so
findings-only topologies validate and render. Topology validation still fails
when the variable is used on a node with no ancestor artifact producers at
all.

Looped producers render as a Markdown bullet list of concrete attempt paths.
Use deterministic split-work assignment for looped strategies:

```text
n % {{strategy_loop_count}} == {{strategy_loop_index}}
```

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

After its final write and before returning, the agent must run every displayed
command. Exit `1` means it must correct that draft and rerun the command in the
same session; exit `2` is a tool/setup failure, not successful validation. Any
later edit requires another validation run. Supplied schema files must not be
edited, and neither command modifies the artifact. Contract validation covers
document-local semantics; the host still applies named contextual gates after
the session returns.

The schema filename, fragment-free schema ID, schema SHA-256, schema-bundle
SHA-256, and validator build identity are fixed during planning and persisted
with the output contract. The agent command runs through a trusted launcher that
is preflighted with a real fixture before model work; it must not select a
target-repository shadow binary. Once the session returns, Ultrafuzz does not
repair, normalize, convert, synthesize, or substitute required output and does
not request a correction turn. Missing or invalid post-session output is a
terminal attempt failure even if another file or the final response contains
similar data.
