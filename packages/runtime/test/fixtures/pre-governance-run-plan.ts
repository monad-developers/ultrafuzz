// Archived canonical run-plan v2 fixture from commit 22bde92f^ (before governance in #635).
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

export function preGovernanceRunPlan() {
  return {
    schema_version: "ultrafuzz.run-plan.v2",
    run_id: "run-child",
    mode: "run",
    graph_fingerprint: DIGEST_A,
    config_fingerprint: DIGEST_B,
    redacted_config_fingerprint: DIGEST_A,
    prompt_digest: DIGEST_B,
    execution: {
      mode: "local",
      retentionDays: 30,
      resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 300 },
      nodes: { node_a: { resources: { memoryMiB: 1_024 } } },
      providers: {}
    },
    topology: { path: "topology.json", logical_nodes: 1, expanded_nodes: 1, required_commands: [] },
    audit_profile: {
      id: "full",
      catalog_digest: DIGEST_A,
      effective_topology_path: "topology.json",
      topology_path_origin: "audit-profile",
      topology_digest: DIGEST_B,
      prompt_digest: DIGEST_B,
      expanded_graph_fingerprint: DIGEST_A,
      effective_settings: {},
      setting_origins: {},
      overridden_settings: [],
      topology_overridden: false
    },
    rendered_prompts: [
      {
        node_id: "node-a-0",
        logical_node_id: "node-a",
        attempt_id: "attempt-a-0",
        prompt_id: "prompt-a",
        prompt_path: "prompts/prompt-a.md",
        rendered_prompt_path: "rendered/node-a-0.md",
        rendered_prompt_digest: DIGEST_B,
        rendered_prompt_snapshot_path: "snapshots/node-a-0.md",
        variables_used: ["run_id"],
        artifact_references: [
          { kind: "artifact_path", logicalId: "node-a", suffix: "result.json" },
          { kind: "ancestor_artifacts", logicalIds: "direct" },
          {
            kind: "ancestor_artifacts_by_path",
            logicalIds: [],
            relativePaths: ["optional/context.md"]
          }
        ]
      }
    ],
    policy_posture: {
      config: "pass",
      topology: "pass",
      prompts: "pass",
      paths: "pass",
      agents: "pass",
      trust: "pass"
    }
  };
}
