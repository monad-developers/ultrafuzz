# Audit profiles

This reference is generated from `packages/config/audit-profiles.yml`. Run `pnpm docs:audit-profiles` after changing the catalog; `pnpm docs:check` rejects drift.

| Profile | Intended use | Topology | Profile settings |
| --- | --- | --- | --- |
| `smoke` | CI, installation, and integration checks. | `topologies/smoke.yml` | `strategy_loops=1`; `dynamic_strategies_enumerator=0`; `max_parallel_agents=4`; `max_parallel_nodes=4`; `workflow_deadline_seconds=14400` |
| `low-cost` | Budget-constrained audits that still require the normal project workflow. | Project topology | `strategy_loops=1`; `dynamic_strategies_enumerator=1`; `max_parallel_agents=2`; `max_parallel_nodes=4`; `workflow_deadline_seconds=43200`; `triage_quorum=2`; `triage_panel_size=3` |
| `default` (default) | General-purpose audits using the editable project topology. | Project topology | None |
| `fuzz-only` | Benchmark comparisons and audits that only need the established fuzzing workflow. | `topologies/fuzz-only.yml` | None |
| `thorough` | High-assurance audits with additional strategy and dynamic-goal breadth. | Project topology | `strategy_loops=3`; `dynamic_strategies_enumerator=5`; `max_parallel_agents=4`; `max_parallel_nodes=8`; `workflow_deadline_seconds=86400` |
| `exhaustive` | Highest-cost release or critical-system investigations. | Project topology | `strategy_loops=5`; `dynamic_strategies_enumerator=unlimited`; `max_parallel_agents=8`; `max_parallel_nodes=16`; `workflow_deadline_seconds=86400` |
| `invariant-only` | Focused stateful-invariant campaigns for ScFuzzBench. | `topologies/invariant-only.yml` | `strategy_loops=3`; `dynamic_strategies_enumerator=0`; `max_parallel_agents=4`; `max_parallel_nodes=8`; `workflow_deadline_seconds=86400`; `invariant_testing_smoke_timeout_seconds=600`; `invariant_testing_fuzzer_timeout_seconds=3600` |

Profiles provide coherent defaults. Explicit project configuration and one-run CLI options still win:

`built-in defaults < audit profile < project configuration < CLI/runtime override`

Topology selection is atomic rather than merged:

`.ultrafuzz/topology.yml < profile topology_path < project topology_path < --topology-path`

The `default` profile is reserved for the unmodified project workflow: it has no settings overrides and uses the project topology. Catalogs without `profiles.default` are rejected.

Use `ultrafuzz config audit-profiles` for the catalog, `ultrafuzz config audit-profile <name>` for effective project settings, and `ultrafuzz run --audit-profile <name>` for a one-run override.

Ultrafuzz ships `full`, `fuzz-only`, `smoke`, and `invariant-only` topology files. Inspect them with `ultrafuzz topology list` and `ultrafuzz topology show <name>`, or safely copy one into a project with `ultrafuzz topology copy <name> <path>`.
