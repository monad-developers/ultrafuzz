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

| Variable                    | Meaning                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `repo_path`                 | Absolute path to the target repository being fuzzed.                   |
| `workspace_path`            | Absolute path to this node attempt workspace.                          |
| `artifact_path`             | Absolute path to this node attempt artifact directory.                 |
| `artifact_dir`              | Alias for `artifact_path`.                                             |
| `run_metadata_path`         | Absolute path to this run's `run.json`.                                |
| `output_findings_path`      | Absolute path where the agent should write `findings.json`.            |
| `output_patch_path`         | Absolute path reserved for a patch evidence file.                      |
| `strategy`                  | Current logical topology node ID.                                      |
| `attempt_index`             | Zero-based attempt index for this concrete attempt.                    |
| `strategy_loop_index`       | Zero-based loop index for this logical node.                           |
| `strategy_loop_count`       | Total loop count for this logical node.                                |
| `strategy_attempt_test_dir` | Absolute workspace path for generated Foundry tests from this attempt. |

## Triage And Invariant Variables

| Variable                                | Meaning                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `triage_quorum`                         | Resolved triage quorum.                                                   |
| `triage_panel_size`                     | Resolved triage panel size.                                               |
| `dynamic_strategies_enumerator`         | Resolved dynamic strategy enumerator count.                               |
| `invariant_property_priority_threshold` | Resolved invariant property priority threshold.                           |
| `invariant_property_priority_filter`    | Human-readable invariant priority filter, when provided by the renderer.  |
| `invariant_property_priorities`         | Comma-separated invariant priority values, when provided by the renderer. |
| `invariant_testing_fuzzer_timeout`      | Resolved invariant testing fuzzer timeout.                                |

## Artifact Variables

| Variable                                                      | Meaning                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ancestor_artifacts`                                          | Markdown list of required artifact files from direct topology dependencies. |
| `artifact_path:<logical-node-id>`                             | Absolute artifact directory path for an ancestor producer.                  |
| `artifact_handoff:<logical-node-id>`                          | Absolute path to an ancestor producer's primary contracted output.          |
| `ancestor_artifacts:<logical-node-id>[,<logical-node-id>...]` | Markdown list of required artifact files from selected ancestor producers.  |

Artifact variables may reference only ancestor nodes. Handoff producers must
declare exactly one `outputs` entry with `primary: true`.

`artifact_path` variables may include a safe relative suffix:

```md
Read the setup notes at {{artifact_path:setup-foundry}}/setup/setup-foundry.md.
```

`artifact_handoff` resolves to a file and does not accept a suffix.
`ancestor_artifacts` resolves to declared contracted outputs and does not
accept a suffix.

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
