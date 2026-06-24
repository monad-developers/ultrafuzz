# Prompt Variables

Ultrafuzz renders topology prompts before handing them to an agent backend. The
rendered prompt is written to the node's `prompt.rendered.md` artifact.

Unknown variables fail validation.

| Variable | Meaning |
| --- | --- |
| `repo_path` | Absolute path to the target repository being fuzzed. |
| `workspace_path` | Absolute path to this node's isolated attempt workspace. Agents should do code and test work here. |
| `artifact_path` | Absolute path to this node's durable artifact directory. |
| `artifact_dir` | Alias for `artifact_path`. |
| `artifact_path:<logical-node-id>` | Absolute path to an ancestor node's artifact directory. Looped ancestors render as a Markdown bullet list of concrete attempt paths. |
| `ancestor_artifacts` | Markdown bullet list of required artifact files from direct topology dependencies. |
| `ancestor_artifacts:<logical-node-id>[,<logical-node-id>...]` | Markdown bullet list of required artifact files from selected ancestor producers. |
| `artifact_handoff:<logical-node-id>` | Absolute path to an ancestor node's `primary_artifact`. Looped producers render as a Markdown bullet list. |
| `run_artifacts_path` | Absolute path to the current run's artifact root. |
| `run_artifacts_dir` | Alias for `run_artifacts_path`. |
| `output_findings_path` | Absolute artifact path where the agent must write the findings JSON array. |
| `output_patch_path` | Absolute artifact path reserved for a patch file. |
| `output_metadata_path` | Absolute artifact path where backend metadata should be written. |
| `run_id` | Current Ultrafuzz run ID. |
| `node_id` | Current concrete graph node ID. |
| `strategy` | Current logical strategy or topology node ID. |
| `strategy_display_name` | Human-readable strategy display name when available. |
| `strategy_source` | Strategy prompt source, such as `built-in`, `topology`, or `project:<path>`. |
| `attempt_index` | Zero-based concrete attempt index for the current strategy or topology node. |
| `strategy_loop_index` | Zero-based loop index used for deterministic split-work assignment. |
| `strategy_loop_count` | Total resolved loop attempts for the current strategy or topology node. |
| `triage_quorum` | Resolved number of agreeing triage votes required for consensus. |
| `triage_panel_size` | Resolved number of independent triage passes in the arbiter panel. |
| `dynamic_strategies_enumerator` | Resolved max-reasoning enumerator count for the Dynamic strategy generator. |
| `invariant_property_priority_threshold` | Resolved invariant property implementation threshold. |
| `invariant_property_priority_filter` | Human-readable description of selected invariant priorities. |
| `invariant_property_priorities` | Comma-separated selected priority values, such as `high, medium`. |
| `invariant_testing_fuzzer_timeout` | Resolved invariant testing campaign timeout. |
| `strategy_attempt_test_dir` | Absolute workspace path where strategy attempts should write generated Foundry tests. |
| `aggregation_destination_dir` | Absolute target-repository path where generated tests from this attempt are aggregated. |
| `backend_kind` | Backend kind selected for this attempt. |

## Handoff Guidance

Write durable cross-node handoff files under `{{artifact_path}}/...` and list
them in topology `required_artifacts`.

Prefer `{{artifact_handoff:<logical-node-id>}}` when a producer has a
meaningful primary artifact. Use `{{ancestor_artifacts}}` when a node should
read all required artifacts from its direct topology dependencies.

Pinned reference nodes also expose their normalized markdown through
`artifact_handoff`. For example, a property prompt can read a cached GitHub
reference with:

```md
{{artifact_handoff:reference-properties-montyly-rounding}}
```

For looped strategies, split work deterministically with a stable zero-based
item list and assign item `n` to the attempt where:

```text
n % {{strategy_loop_count}} == {{strategy_loop_index}}
```
