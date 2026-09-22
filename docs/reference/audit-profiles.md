# Audit profiles

This reference is generated from `packages/config/audit-profiles.yml`. Run `pnpm docs:audit-profiles` after changing the catalog; `pnpm docs:check` rejects drift.

| Profile | Intended use | Topology |
| --- | --- | --- |
| `smoke` | CI, installation, and integration checks. | `topologies/smoke.yml` |
| `low-cost` | Budget-constrained audits that still require the normal project workflow. | Project topology |
| `default` (default) | General-purpose audits using the editable project topology. | Project topology |
| `exhaustive` | Highest-cost specialist audits; runs the packaged exhaustive topology instead of the editable project topology (a project topology_path or --topology-path still overrides it). | `topologies/exhaustive.yml` |
| `invariant-only` | Focused stateful-invariant campaigns for ScFuzzBench. | `topologies/invariant-only.yml` |

Profile settings:

- `smoke`: `strategy_loops=1`;
  `dynamic_strategies_enumerator=0`;
  `same_agent_attempts=1`;
  `max_parallel_agents=4`;
  `workflow_deadline_seconds=14400`
- `low-cost`: `strategy_loops=1`;
  `dynamic_strategies_enumerator=1`;
  `same_agent_attempts=1`;
  `max_parallel_agents=2`;
  `workflow_deadline_seconds=43200`;
  `triage_quorum=2`;
  `triage_panel_size=3`
- `default`: None
- `exhaustive`: `strategy_loops=3`;
  `property_priority_threshold=medium`;
  `reference_expectation_selection=priority`;
  `invariant_testing_fuzzer_timeout_seconds=14400`;
  `dynamic_strategies_enumerator=unlimited`;
  `same_agent_attempts=5`;
  `max_parallel_agents=8`;
  `workflow_deadline_seconds=86400`
- `invariant-only`: `strategy_loops=3`;
  `property_priority_threshold=high`;
  `reference_expectation_selection=mandatory`;
  `dynamic_strategies_enumerator=0`;
  `max_parallel_agents=4`;
  `workflow_deadline_seconds=86400`;
  `invariant_testing_smoke_timeout_seconds=600`;
  `invariant_testing_fuzzer_timeout_seconds=3600`

Profiles provide coherent defaults. Explicit project configuration and one-run CLI options still win:

`built-in defaults < audit profile < project configuration < CLI/runtime override`

Topology selection is atomic rather than merged:

`.ultrafuzz/topology.yml < profile topology_path < project topology_path < --topology-path`

The `default` profile is reserved for the unmodified project workflow: it has no settings overrides and uses the project topology. Catalogs without `profiles.default` are rejected.

With freshly initialized configuration and the shipped topology, the main profiles allocate work as follows:

| Control | Default | Exhaustive |
| --- | --- | --- |
| Ordinary strategy passes | 2 | 3 |
| Stateful pipeline | All five stages, once each | All five stages, once each |
| Selected invariant properties | High priority | High and medium priority |
| Final Recon fuzzing campaign | 1 hour | 4 hours |

Ordinary strategy passes are separate from failure retries and from the fuzzer's randomized call sequences. Exhaustive also retains its differential and dynamic specialist lanes.

The campaign duration covers one shared suite of selected properties, not a separate campaign per property. Setup, a ten-minute deployment smoke, shutdown, and report finalization take additional time.
Exhaustive gives only the final campaign node a 16,200-second (4h30m) attempt timeout. Its five allowed attempts share the existing 24-hour workflow deadline with all other work; they are not a promise that every retry can finish.

For these normal audit profiles, `reference_expectations` tags link properties to externally expected checks without bypassing the priority threshold. Excluded checks remain visible as unselected in reporting. The benchmark-specific `invariant-only` profile explicitly uses `reference_expectation_selection=mandatory`, so tagged properties remain required there regardless of priority.

Fresh initialization leaves profile-managed priority and campaign settings unset in the project file, so switching profiles inherits the appropriate values. Explicit settings in an existing project still override the selected profile.

Use `ultrafuzz config audit-profiles` for the catalog, `ultrafuzz config audit-profile <name>` for effective project settings, and `ultrafuzz run --audit-profile <name>` for a one-run override.

Ultrafuzz ships `default`, `exhaustive`, `smoke`, and `invariant-only` topology files. Inspect them with `ultrafuzz topology list` and `ultrafuzz topology show <name>`, or safely copy one into a project with `ultrafuzz topology copy <name> <path>`.
