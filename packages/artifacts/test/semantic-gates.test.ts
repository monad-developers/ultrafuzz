import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ARTIFACT_SCHEMA_METADATA,
  MAX_SEMANTIC_GATE_DIAGNOSTIC_BYTES,
  MAX_SEMANTIC_GATE_ISSUES,
  SEMANTIC_GATE_REGISTRY,
  SEMANTIC_GATE_SCOPES,
  artifactContractDefinition,
  executeOfflineSchemaSemanticGates,
  executeSchemaSemanticGates,
  executeSemanticGate,
  semanticGateRegistration,
  type SemanticGateContext,
  type SemanticGateName
} from "../src/index.js";

interface GateFixture {
  positive: unknown;
  negative: unknown;
}

const validPlannedOutput = {
  path: "report.md",
  contract: "ultrafuzz/nonempty-markdown@1",
  contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
  primary: true
};

const validPlannedNode = {
  id: "node-a",
  artifact_dir: "artifacts/node-a",
  depends_on: [] as string[],
  outputs: [validPlannedOutput],
  loop: { index: 0, count: 1, attempt_index: 0 },
  model_fanout: [] as unknown[]
};

const validPlannedGraph = { nodes: [validPlannedNode] };

const smithersManifestOutput = {
  path: validPlannedOutput.path,
  contract: validPlannedOutput.contract,
  contractDigest: validPlannedOutput.contract_digest,
  primary: validPlannedOutput.primary
};

const smithersIdentityTask = {
  attemptId: "attempt-a",
  concreteNodeId: "node-a",
  logicalNodeId: "logical-a",
  smithersNodeId: "node:attempt-a",
  verifierSmithersNodeId: "verify:attempt-a",
  agentRef: "agent-a",
  dependencies: [] as string[],
  dependencySmithersNodeIds: [] as string[],
  timeoutMs: 1_000,
  heartbeatTimeoutMs: 500,
  retries: 0,
  artifactDir: "artifacts/node-a",
  execution: { mode: "local", resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 1 } },
  metadata: {
    run: { ultrafuzzRunId: "run-a", smithersWorkflowName: "workflow-a" },
    node: {
      attemptId: "attempt-a",
      concreteNodeId: "node-a",
      logicalNodeId: "logical-a",
      label: "Node A"
    },
    model: { agentRef: "agent-a" },
    dependencies: { attemptIds: [] as string[], smithersNodeIds: [] as string[], concreteNodeIds: [] as string[] },
    timeout: { milliseconds: 1_000, seconds: 1, heartbeatTimeoutMs: 500 },
    retryPolicy: { maxAttempts: 1, smithersRetries: 0 },
    execution: { mode: "local", resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 1 } },
    artifacts: { dir: "artifacts/node-a", outputs: [smithersManifestOutput] },
    loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 }
  }
};

const pinnedSubmoduleExpectation = {
  schema_version: "ultrafuzz.pinned-submodules-expectation.v1",
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  manifest_sha256: "c".repeat(64),
  top_level_roots: ["vendor/dependency"],
  recursive_gitlinks: [{ path: "vendor/dependency", commit: "d".repeat(40), tree: "e".repeat(40) }],
  entry_count: 1,
  file_count: 0,
  total_file_bytes: 0
};

const analysisBundleAccountingGatePositive = {
  run_count: 1,
  accounted_run_count: 1,
  runtime_observed_run_count: 1,
  runtime_seconds: 2,
  input_tokens: 1,
  output_tokens: 2,
  cache_read_tokens: 3,
  cache_write_tokens: 4,
  reasoning_tokens: 5,
  total_tokens: 15,
  partial_pricing: false,
  event_count: 1,
  priced_event_count: 1,
  unpriced_event_count: 0
};

const analysisBundleRecoveryGatePositive = {
  total_generations: 1,
  terminal_generations: 1,
  active_generations: 0,
  progress_generations: 1,
  no_progress_generations: 0,
  unknown_progress_generations: 0,
  model_work_generations: 1,
  no_model_work_generations: 0,
  unknown_model_work_generations: 0,
  genuine_failures: 0,
  rotations: 0,
  resumptions: 0,
  start_reasons: {
    initial: 1,
    "pre-model-retry": 0,
    "post-model-resume": 0,
    "image-rollout": 0,
    "stale-probe-rotation": 0,
    "operator-restart": 0,
    unknown: 0
  },
  terminal_reasons: {
    active: 0,
    succeeded: 1,
    "genuine-worker-failure": 0,
    "operational-failure": 0,
    "image-rollout": 0,
    "stale-probe-rotation": 0,
    "operator-request": 0,
    timeout: 0,
    "resource-termination": 0,
    "recovery-budget-exhausted": 0,
    unknown: 0
  },
  terminal_classes: {
    active: 0,
    succeeded: 1,
    "genuine-worker-failure": 0,
    "operational-failure": 0,
    "controller-rotation": 0,
    timeout: 0,
    "resource-termination": 0,
    "recovery-budget-exhausted": 0,
    unknown: 0
  }
};

const dynamicRecommendationFixture = {
  strategy_id: "strategy-a",
  title: "Strategy A",
  rationale: "Exercise the uncovered transition.",
  coverage_gap: "The transition has no focused test.",
  evidence_paths: ["src/Target.sol"],
  proposed_test_path: "generated-tests/StrategyA.t.sol",
  focused_command: "forge test --match-contract StrategyA",
  priority: "high"
};

const selectedDynamicStrategyFixture = {
  ...dynamicRecommendationFixture,
  enumerator_ids: ["enumerator-a"],
  validation_plan: ["Run the focused command."]
};

const dynamicStrategyArtifactContext: SemanticGateContext = {
  artifactSet: {
    dynamicStrategyArtifacts: {
      strategyPlan: {
        selected_strategy_count: 1,
        selected_strategies: ["strategy-a"],
        rejected_strategies: [{ strategy_id: "strategy-b", reason: "Lower priority." }]
      },
      enumeratorOutputs: {
        enumerators: [
          {
            enumerator_id: "enumerator-a",
            recommendations: [
              dynamicRecommendationFixture,
              { ...dynamicRecommendationFixture, strategy_id: "strategy-b", title: "Strategy B" }
            ]
          }
        ]
      },
      findings: [{ dynamic_strategy_id: "strategy-a", enumerator_id: "enumerator-a" }],
      provenance: { generated_files: [{ strategy_id: "strategy-a" }] }
    }
  }
};

const differentialPlanPath = "artifacts/differential-oracle-planner/differential-plan.json";
const differentialHarnessPath = "artifacts/reference-harness-author/reference-harness.json";
const differentialAuditPath = "artifacts/reference-and-lane-auditor/audited-differential-lanes.json";
const differentialRegistryPath = "semantic-red-registry.json";

function differentialBinding(
  path: string,
  contract: string,
  logicalNodeId: string,
  document: unknown,
  attemptId = `${logicalNodeId}:0`
) {
  return { attemptId, logicalNodeId, attemptIndex: 0, path, contract, document };
}

const emptyDifferentialPlan = {
  planner_attempt_index: 0,
  candidate_surfaces: [],
  assigned_differential_lanes: []
};
const emptyReferenceHarness = {
  harness_author_attempt_index: 0,
  source_plan_artifacts: [differentialPlanPath],
  reference_models: []
};
const emptyAuditedDifferentialLanes = {
  auditor_attempt_index: 0,
  source_plan_artifacts: [differentialPlanPath],
  source_harness_artifacts: [differentialHarnessPath],
  surface_audits: [],
  ready_lanes: [],
  rejected_or_narrowed_lanes: []
};
const emptySemanticRedRegistry = { semantic_reds: [], compile_or_harness_defects: [] };
const emptyNoAssignedLaneResult = {
  lane_id: null,
  attempt_index: 0,
  auditor_attempt_index: 0,
  source_auditor_artifact: differentialAuditPath,
  status: "no_assigned_lane"
};
const emptyTriageA = { pass: "a", classifications: [] };
const emptyTriageB = { pass: "b", classifications: [] };
const emptyRepairSummary = {
  repairs_attempted: [],
  repaired_failures: [],
  preserved_production_or_unknown_reds: [],
  semantic_red_registry_regenerated: false
};
const emptyGapReview = {
  ready_lanes: [],
  lane_results_seen: [],
  missing_lane_work_orders: [],
  incomplete_campaign_work_orders: [],
  green_suite_evidence: [],
  report_blockers: []
};
const noAssignedGapReview = {
  ...emptyGapReview,
  lane_results_seen: [
    {
      lane_id: null,
      attempt_index: 0,
      auditor_attempt_index: 0,
      source_auditor_artifact: differentialAuditPath,
      status: "no_assigned_lane"
    }
  ],
  incomplete_campaign_work_orders: [
    {
      lane_id: null,
      attempt_index: 0,
      auditor_attempt_index: 0,
      source_auditor_artifact: differentialAuditPath,
      summary: "No lane was assigned.",
      evidence_paths: []
    }
  ]
};

const differentialPlanBinding = differentialBinding(
  differentialPlanPath,
  "ultrafuzz/differential-plan@1",
  "differential-oracle-planner",
  emptyDifferentialPlan
);
const differentialHarnessBinding = differentialBinding(
  differentialHarnessPath,
  "ultrafuzz/reference-harness@1",
  "reference-harness-author",
  emptyReferenceHarness
);
const differentialAuditBinding = differentialBinding(
  differentialAuditPath,
  "ultrafuzz/audited-differential-lanes@1",
  "reference-and-lane-auditor",
  emptyAuditedDifferentialLanes
);
const differentialLaneResultBinding = differentialBinding(
  "artifacts/differential-lane-author/lane-result.json",
  "ultrafuzz/differential-lane-result@1",
  "differential-lane-author",
  emptyNoAssignedLaneResult
);
const differentialRegistryBinding = differentialBinding(
  differentialRegistryPath,
  "ultrafuzz/semantic-red-registry@1",
  "differential-red-triage",
  emptySemanticRedRegistry,
  "differential-red-triage:0"
);
const differentialTriageABinding = differentialBinding(
  "triage-a.json",
  "ultrafuzz/differential-red-triage@1",
  "differential-red-triage",
  emptyTriageA,
  "differential-red-triage:0"
);
const differentialTriageBBinding = differentialBinding(
  "triage-b.json",
  "ultrafuzz/differential-red-triage@1",
  "differential-red-triage",
  emptyTriageB,
  "differential-red-triage:0"
);

const validCoverageEvidence = {
  schema_version: "ultrafuzz.coverage-evidence.v1",
  lcov: { path: "echidna/covered.test.lcov", sha256: "a".repeat(64) },
  views: [
    { scope: "selected-range", covered_ranges: 0, total_ranges: 0 },
    { scope: "production-source", covered_ranges: 0, total_ranges: 0 }
  ],
  files: [
    {
      path: "src/Core.sol",
      kind: "production",
      included: false,
      exclusion_reason: "no material declarations",
      covered_ranges: 0,
      total_ranges: 0
    }
  ],
  counted_ranges: [],
  zero_coverage_components: []
};

const fixtures = {
  "admin-config-surface-id-uniqueness": {
    positive: { surfaces: [{ surface_id: "a" }] },
    negative: { surfaces: [{ surface_id: "a" }, { surface_id: "a" }] }
  },
  "admin-config-surface-joins": {
    positive: { surfaces: [{ surface_id: "a" }], coverage_notes: [{ surface_id: "a" }] },
    negative: { surfaces: [{ surface_id: "a" }], coverage_notes: [{ surface_id: "missing" }] }
  },
  "agent-source-proof-ref-uniqueness": {
    positive: { refs: [{ name: "refs/heads/a" }] },
    negative: { refs: [{ name: "refs/heads/a" }, { name: "refs/heads/a" }] }
  },
  "agent-source-proof-dependency-lineage": {
    positive: { commit: "a".repeat(40), tree: "b".repeat(40), dependencies: pinnedSubmoduleExpectation },
    negative: {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      dependencies: { ...pinnedSubmoduleExpectation, source_commit: "f".repeat(40) }
    }
  },
  "aggregation-count-coupling": {
    positive: {
      source_generated_tests: 2,
      copied_generated_tests: 1,
      source_support_files: 2,
      copied_support_files: 1,
      source_bundles: [{ generated_test_count: 2, support_file_count: 2 }],
      files: [{}],
      support_files: [{}]
    },
    negative: {
      source_generated_tests: 3,
      copied_generated_tests: 1,
      source_support_files: 2,
      copied_support_files: 1,
      source_bundles: [{ generated_test_count: 2, support_file_count: 2 }],
      files: [{}],
      support_files: [{}]
    }
  },
  "aggregation-destination-path-uniqueness": {
    positive: {
      files: [{ destination_path: "/w/a", destination_relative_path: "a" }],
      support_files: [{ destination_path: "/w/b", destination_relative_path: "b" }]
    },
    negative: {
      files: [{ destination_path: "/w/a", destination_relative_path: "a" }],
      support_files: [{ destination_path: "/w/a", destination_relative_path: "b" }]
    }
  },
  "aggregation-source-entry-uniqueness": {
    positive: {
      files: [
        {
          source_attempt_id: "attempt-a",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64),
          source_relative_path: "generated-tests/a.t.sol"
        }
      ],
      support_files: [],
      skipped_files: []
    },
    negative: {
      files: [
        {
          source_attempt_id: "attempt-a",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64),
          source_relative_path: "generated-tests/a.t.sol"
        }
      ],
      support_files: [],
      skipped_files: [
        {
          kind: "generated-test",
          source_attempt_id: "attempt-a",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64),
          source_relative_path: "generated-tests/a.t.sol"
        }
      ]
    }
  },
  "aggregation-source-bundle-reconciliation": {
    positive: {
      source_bundles: [
        {
          strategy: "strategy-a",
          node_id: "node-a",
          source_attempt_id: "attempt-a",
          attempt_index: 0,
          source_manifest_path: "/artifacts/attempt-a/generated-tests.json",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64),
          generated_test_count: 1,
          support_file_count: 0,
          disposition: "copied"
        }
      ],
      files: [
        {
          strategy: "strategy-a",
          node_id: "node-a",
          source_attempt_id: "attempt-a",
          attempt_index: 0,
          source_manifest_path: "/artifacts/attempt-a/generated-tests.json",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64)
        }
      ],
      support_files: [],
      skipped_files: []
    },
    negative: {
      source_bundles: [
        {
          strategy: "strategy-a",
          node_id: "node-a",
          source_attempt_id: "attempt-a",
          attempt_index: 0,
          source_manifest_path: "/artifacts/attempt-a/generated-tests.json",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64),
          generated_test_count: 1,
          support_file_count: 0,
          disposition: "skipped"
        }
      ],
      files: [
        {
          strategy: "strategy-a",
          node_id: "node-a",
          source_attempt_id: "attempt-a",
          attempt_index: 0,
          source_manifest_path: "/artifacts/attempt-a/generated-tests.json",
          source_manifest_relative_path: "generated-tests.json",
          source_manifest_sha256: "a".repeat(64)
        }
      ],
      support_files: [],
      skipped_files: []
    }
  },
  "aggregation-resource-bounds": {
    positive: {
      source_bundles: [{ generated_test_count: 1, support_file_count: 0 }],
      files: [{ size_bytes: 1 }],
      support_files: [],
      skipped_files: []
    },
    negative: {
      source_bundles: [{ generated_test_count: 1_024, support_file_count: 1 }],
      files: [],
      support_files: [],
      skipped_files: []
    }
  },
  "analysis-bundle-accounting-reconciliation": {
    positive: analysisBundleAccountingGatePositive,
    negative: { ...analysisBundleAccountingGatePositive, total_tokens: 14 }
  },
  "analysis-bundle-attempt-order": {
    positive: {
      attempts: [{ ordinal: 1, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z" }]
    },
    negative: {
      attempts: [{ ordinal: 2, started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z" }]
    }
  },
  "analysis-bundle-evaluation-count-reconciliation": {
    positive: {
      totals: {
        ground_truth_bug_count: 2,
        finding_count: 3,
        true_positives: 1,
        false_positives: 1,
        missed: 1,
        human_review_queue_count: 0,
        duplicate_count: 1
      }
    },
    negative: {
      totals: {
        ground_truth_bug_count: 2,
        finding_count: 2,
        true_positives: 1,
        false_positives: 1,
        missed: 1,
        human_review_queue_count: 0,
        duplicate_count: 1
      }
    }
  },
  "analysis-bundle-omission-order": {
    positive: { omissions: [{ path: "data/a.json" }, { path: "data/b.json" }] },
    negative: { omissions: [{ path: "data/b.json" }, { path: "data/a.json" }] }
  },
  "analysis-bundle-path-order": {
    positive: { files: [{ kind: "omissions", path: "omissions.json" }] },
    negative: {
      files: [
        { kind: "omissions", path: "omissions.json" },
        { kind: "terminal-status", path: "data/a.json" }
      ]
    }
  },
  "analysis-bundle-recovery-reconciliation": {
    positive: analysisBundleRecoveryGatePositive,
    negative: { ...analysisBundleRecoveryGatePositive, total_generations: 2 }
  },
  "analysis-bundle-terminal-status-reconciliation": {
    positive: {
      terminal: true,
      status: "succeeded",
      run_count: 1,
      status_counts: {
        pending: 0,
        running: 0,
        paused: 0,
        succeeded: 1,
        failed: 0,
        "timed-out": 0,
        canceled: 0,
        unknown: 0
      },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z"
    },
    negative: {
      terminal: true,
      status: "failed",
      run_count: 1,
      status_counts: {
        pending: 0,
        running: 0,
        paused: 0,
        succeeded: 1,
        failed: 0,
        "timed-out": 0,
        canceled: 0,
        unknown: 0
      },
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:00:01Z"
    }
  },
  "artifact-manifest-file-path-uniqueness": {
    positive: { files: [{ path: "a" }] },
    negative: { files: [{ path: "a" }, { path: "a" }] }
  },
  "artifact-manifest-output-path-uniqueness": {
    positive: { output_contracts: [{ path: "a" }] },
    negative: { output_contracts: [{ path: "a" }, { path: "a" }] }
  },
  "artifact-manifest-prerequisite-node-uniqueness": {
    positive: { prerequisite_manifests: [{ node_id: "a" }] },
    negative: { prerequisite_manifests: [{ node_id: "a" }, { node_id: "a" }] }
  },
  "artifact-verification-artifact-path-uniqueness": {
    positive: { artifacts: [{ path: "a" }] },
    negative: { artifacts: [{ path: "a" }, { path: "a" }] }
  },
  "artifact-verification-exactly-one-primary": {
    positive: { artifacts: [{ primary: true }] },
    negative: { artifacts: [{ primary: false }] }
  },
  "artifact-verification-publication-digest-correspondence": {
    positive: { artifacts: [{ path: "a", sha256: "1" }], publications: [{ path: "a", sha256: "1" }] },
    negative: { artifacts: [{ path: "a", sha256: "1" }], publications: [{ path: "a", sha256: "2" }] }
  },
  "artifact-verification-publication-path-uniqueness": {
    positive: { publications: [{ path: "a" }] },
    negative: { publications: [{ path: "a" }, { path: "a" }] }
  },
  "attempt-order": {
    positive: { lifecycle: { started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:00:01Z" } },
    negative: { lifecycle: { started_at: "2026-01-01T00:00:01Z", finished_at: "2026-01-01T00:00:00Z" } }
  },
  "attempt-failure-message-byte-length": {
    positive: { failure_message: "🙂".repeat(250) },
    negative: { failure_message: "🙂".repeat(251) }
  },
  "attempt-outcome-digest-coupling": {
    positive: { outcome: "succeeded", reuse: { status: "executed" }, manifests: { output_sha256: "1" } },
    negative: { outcome: "succeeded", reuse: { status: "reused" }, manifests: { output_sha256: null } }
  },
  "audited-differential-lane-id-uniqueness": {
    positive: { ready_lanes: [{ lane_id: "a" }] },
    negative: { ready_lanes: [{ lane_id: "a" }, { lane_id: "a" }] }
  },
  "boundary-recipe-id-uniqueness": {
    positive: { recipes: [{ id: "a" }], deferred_or_spec_gated: [{ id: "b" }] },
    negative: { recipes: [{ id: "a" }], deferred_or_spec_gated: [{ id: "a" }] }
  },
  "campaign-summary-backend-uniqueness": {
    positive: { backend_results: [{ fuzzer_backend: "a" }] },
    negative: { backend_results: [{ fuzzer_backend: "a" }, { fuzzer_backend: "a" }] }
  },
  "config-redactions-path-key-equality": {
    positive: {
      entries: [{ path: ["models", "profiles", "default", "model"], key: "models.profiles.default.model" }]
    },
    negative: { entries: [{ path: ["models", "profiles", "default", "model"], key: "wrong.path" }] }
  },
  "config-redactions-path-uniqueness": {
    positive: {
      entries: [{ path: ["models", "profiles", "a", "model"] }, { path: ["models", "profiles", "b", "model"] }]
    },
    negative: {
      entries: [{ path: ["models", "profiles", "a", "model"] }, { path: ["models", "profiles", "a", "model"] }]
    }
  },
  "coverage-evidence-reconciliation": {
    positive: validCoverageEvidence,
    negative: {
      schema_version: "ultrafuzz.coverage-evidence.v1",
      lcov: { path: "echidna/covered.test.lcov", sha256: "a".repeat(64) },
      views: [
        { scope: "selected-range", covered_ranges: 0, total_ranges: 0 },
        { scope: "production-source", covered_ranges: 0, total_ranges: 1 }
      ],
      files: [
        {
          path: "src/Core.sol",
          kind: "production",
          included: false,
          exclusion_reason: "not selected",
          covered_ranges: 0,
          total_ranges: 1
        }
      ],
      counted_ranges: [
        {
          file: "src/Core.sol",
          kind: "production",
          start_line: 1,
          line_count: 1,
          selected: true,
          covered: false
        }
      ],
      zero_coverage_components: [{ path: "src/Core.sol", kind: "production", start_line: 1, line_count: 1 }]
    }
  },
  "coverage-goal-reconciliation": {
    positive: {
      schema_version: "ultrafuzz.coverage-goal.v1",
      target: { scope: "selected-range", minimum_percent: 90 },
      current_measurement: { scope: "selected-range", covered_ranges: 1, total_ranges: 1 },
      current_status: "measured",
      planned_commands: [],
      stop_conditions: ["reserve time for finalization"],
      timeout_seconds: 60,
      finalization_reserve_seconds: 10,
      blockers: []
    },
    negative: {
      schema_version: "ultrafuzz.coverage-goal.v1",
      target: { scope: "selected-range", minimum_percent: 90 },
      current_measurement: { scope: "selected-range", covered_ranges: 2, total_ranges: 1 },
      current_status: "measured",
      planned_commands: [],
      stop_conditions: ["reserve time for finalization"],
      timeout_seconds: 60,
      finalization_reserve_seconds: 10,
      blockers: []
    }
  },
  "dependency-id-uniqueness": {
    positive: { dependencies: [{ dependency_id: "a" }] },
    negative: { dependencies: [{ dependency_id: "a" }, { dependency_id: "a" }] }
  },
  "dependency-row-joins": {
    positive: { dependencies: [{ dependency_id: "a" }], coverage_notes: [{ dependency_id: "a" }] },
    negative: { dependencies: [{ dependency_id: "a" }], coverage_notes: [{ dependency_id: "missing" }] }
  },
  "differential-gap-lane-uniqueness": {
    positive: { ready_lanes: [{ lane_id: "a", attempt_index: 0 }] },
    negative: {
      ready_lanes: [
        { lane_id: "a", attempt_index: 0 },
        { lane_id: "a", attempt_index: 0 }
      ]
    }
  },
  "differential-plan-lane-id-uniqueness": {
    positive: { assigned_differential_lanes: [{ lane_id: "a" }], deferred_lane_candidates: [{ lane_id: "b" }] },
    negative: { assigned_differential_lanes: [{ lane_id: "a" }], deferred_lane_candidates: [{ lane_id: "a" }] }
  },
  "differential-plan-surface-id-uniqueness": {
    positive: { candidate_surfaces: [{ surface_id: "a" }], out_of_scope_surfaces: [{ surface_id: "b" }] },
    negative: { candidate_surfaces: [{ surface_id: "a" }], out_of_scope_surfaces: [{ surface_id: "a" }] }
  },
  "differential-repair-failure-hash-uniqueness": {
    positive: { repairs_attempted: [{ stable_failure_hash: "a" }] },
    negative: { repairs_attempted: [{ stable_failure_hash: "a" }, { stable_failure_hash: "a" }] }
  },
  "differential-report-failure-hash-uniqueness": {
    positive: { report_rows_ready: [{ stable_failure_hash: "a" }] },
    negative: { report_rows_ready: [{ stable_failure_hash: "a" }, { stable_failure_hash: "a" }] }
  },
  "differential-result-failure-hash-uniqueness": {
    positive: { red_candidates: [{ stable_failure_hash: "a" }] },
    negative: { red_candidates: [{ stable_failure_hash: "a" }, { stable_failure_hash: "a" }] }
  },
  "differential-result-lane-binding": {
    positive: {
      status: "green",
      lane_id: "lane-a",
      attempt_index: 0,
      auditor_attempt_index: 1,
      source_plan_artifact: "plan.json",
      source_harness_artifact: "harness.json",
      focused_command: "forge test",
      assigned_lane_payload: {
        lane_id: "lane-a",
        attempt_index: 0,
        auditor_attempt_index: 1,
        source_plan_artifact: "plan.json",
        source_harness_artifact: "harness.json",
        focused_command: "forge test"
      }
    },
    negative: {
      status: "green",
      lane_id: "lane-a",
      attempt_index: 0,
      auditor_attempt_index: 1,
      source_plan_artifact: "plan.json",
      source_harness_artifact: "harness.json",
      focused_command: "forge test",
      assigned_lane_payload: {
        lane_id: "lane-b",
        attempt_index: 0,
        auditor_attempt_index: 1,
        source_plan_artifact: "plan.json",
        source_harness_artifact: "harness.json",
        focused_command: "forge test"
      }
    }
  },
  "differential-triage-failure-hash-uniqueness": {
    positive: { classifications: [{ stable_failure_hash: "a" }] },
    negative: { classifications: [{ stable_failure_hash: "a" }, { stable_failure_hash: "a" }] }
  },
  "dynamic-agent-id-uniqueness": {
    positive: { agents: [{ agent_id: "a" }] },
    negative: { agents: [{ agent_id: "a" }, { agent_id: "a" }] }
  },
  "dynamic-enumerator-id-uniqueness": {
    positive: { enumerators: [{ enumerator_id: "a" }] },
    negative: { enumerators: [{ enumerator_id: "a" }, { enumerator_id: "a" }] }
  },
  "dynamic-model-agent-join": {
    positive: { agents: [{ agent_id: "a" }], models: [{ agent_id: "a" }] },
    negative: { agents: [{ agent_id: "a" }], models: [{ agent_id: "missing" }] }
  },
  "dynamic-recommendation-id-uniqueness": {
    positive: { enumerators: [{ recommendations: [{ strategy_id: "a" }] }] },
    negative: { enumerators: [{ recommendations: [{ strategy_id: "a" }, { strategy_id: "a" }] }] }
  },
  "dynamic-strategy-selection-coherence": {
    positive: {
      status: "selected",
      selected_strategy_count: 1,
      selected_strategies: ["a"],
      rejected_strategies: [{ strategy_id: "b" }]
    },
    negative: {
      status: "selected",
      selected_strategy_count: 1,
      selected_strategies: ["a"],
      rejected_strategies: [{ strategy_id: "a" }]
    }
  },
  "externalized-state-id-uniqueness": {
    positive: { state_components: [{ component_id: "a" }] },
    negative: { state_components: [{ component_id: "a" }, { component_id: "a" }] }
  },
  "externalized-state-scenario-joins": {
    positive: { state_components: [{ component_id: "a" }], scenarios: [{ state_component_ids: ["a"] }] },
    negative: { state_components: [{ component_id: "a" }], scenarios: [{ state_component_ids: ["missing"] }] }
  },
  "finding-lifecycle-dedupe-key-uniqueness": {
    positive: { records: [{ dedupe_key: "a" }] },
    negative: { records: [{ dedupe_key: "a" }, { dedupe_key: "a" }] }
  },
  "finding-campaign-provenance-coherence": {
    positive: {
      property_ids: ["property-1"],
      fuzzer_backend: "recon",
      contributing_backend_failures: [
        {
          fuzzer_backend: "recon",
          failure_id: "failure-1",
          raw_result_ref: "recon-fuzzer-results.json"
        }
      ],
      deduplication: { pre_dedup_count: 1 }
    },
    negative: {
      property_ids: ["property-1"],
      fuzzer_backend: "medusa",
      contributing_backend_failures: [
        {
          fuzzer_backend: "recon",
          failure_id: "failure-1",
          raw_result_ref: "recon-fuzzer-results.json"
        }
      ],
      deduplication: { pre_dedup_count: 1 }
    }
  },
  "finding-evidence-span-consistency": {
    positive: {
      evidence: [{ line: 4, end_line: 8 }, { line_ranges: [{ line: 10, end_line: 12 }, { line: 14 }] }]
    },
    negative: { evidence: [{ line: 8, end_line: 4 }] }
  },
  "finding-projected-reference-uniqueness": {
    positive: { family_variants: [{ id: "a", dedupe_key: "a" }] },
    negative: {
      family_variants: [
        { id: "a", dedupe_key: "a" },
        { id: "a", dedupe_key: "b" }
      ]
    }
  },
  "findings-id-uniqueness": {
    positive: [{ id: "a" }],
    negative: [{ id: "a" }, { id: "a" }]
  },
  "findings-campaign-provenance-coherence": {
    positive: [
      {
        property_ids: ["property-1"],
        fuzzer_backend: "recon",
        contributing_backend_failures: [
          {
            fuzzer_backend: "recon",
            failure_id: "failure-1",
            raw_result_ref: "recon-fuzzer-results.json"
          }
        ],
        deduplication: { pre_dedup_count: 1 }
      }
    ],
    negative: [
      {
        property_ids: ["property-1"],
        fuzzer_backends: ["recon", "medusa"],
        contributing_backend_failures: [
          {
            fuzzer_backend: "recon",
            failure_id: "failure-1",
            raw_result_ref: "recon-fuzzer-results.json"
          }
        ],
        deduplication: { pre_dedup_count: 1 }
      }
    ]
  },
  "findings-evidence-span-consistency": {
    positive: [
      {
        evidence: [
          {
            line_ranges: [
              { line: 10, end_line: 12 },
              { line: 13, end_line: 15 }
            ]
          }
        ]
      }
    ],
    negative: [
      {
        evidence: [
          {
            line_ranges: [
              { line: 10, end_line: 12 },
              { line: 12, end_line: 15 }
            ]
          }
        ]
      }
    ]
  },
  "generated-test-bundle-path-uniqueness": {
    positive: { generated_tests: [{ path: "a" }], support_files: [{ path: "b" }] },
    negative: { generated_tests: [{ path: "a" }], support_files: [{ path: "a/b" }] }
  },
  "generated-test-bundle-resource-bounds": {
    positive: { generated_tests: [{ size_bytes: 1 }], support_files: [] },
    negative: {
      generated_tests: Array.from({ length: 5 }, () => ({ size_bytes: 16 * 1024 * 1024 })),
      support_files: []
    }
  },
  "generated-test-support-requires-test": {
    positive: { generated_tests: [{ path: "a" }], support_files: [{ path: "b" }] },
    negative: { generated_tests: [], support_files: [{ path: "b" }] }
  },
  "harness-repair-failure-id-uniqueness": {
    positive: [{ failure_id: "a" }],
    negative: [{ failure_id: "a" }, { failure_id: "a" }]
  },
  "implemented-property-id-uniqueness": {
    positive: { properties: [{ property_id: "a" }] },
    negative: { properties: [{ property_id: "a" }, { property_id: "a" }] }
  },
  "invariant-ledger-id-joins": {
    positive: {
      entries: [{ id: "e", inventory_ids: ["i"] }],
      inventory_rows: [{ id: "i", ledger_ids: ["e"] }]
    },
    negative: {
      entries: [{ id: "e", inventory_ids: ["missing"] }],
      inventory_rows: [{ id: "i", ledger_ids: ["e"] }]
    }
  },
  "invariant-ledger-projected-id-uniqueness": {
    positive: { entries: [{ id: "e", inventory_ids: ["i"] }] },
    negative: { entries: [{ id: "e", inventory_ids: ["i", "i"] }] }
  },
  "invariant-source-proof-path-uniqueness": {
    positive: { files: [{ path: "a" }] },
    negative: { files: [{ path: "a" }, { path: "a" }] }
  },
  "invariant-suite-file-path-uniqueness": {
    positive: { files: [{ path: "a" }] },
    negative: { files: [{ path: "a" }, { path: "a" }] }
  },
  "invariant-suite-file-tombstone-disjointness": {
    positive: { files: [{ path: "a" }], tombstones: ["b"] },
    negative: { files: [{ path: "a" }], tombstones: ["a"] }
  },
  "invariant-suite-tombstone-uniqueness": {
    positive: { tombstones: ["a"] },
    negative: { tombstones: ["a", "a"] }
  },
  "planned-graph-acyclicity": {
    positive: validPlannedGraph,
    negative: {
      nodes: [
        { ...validPlannedNode, id: "a", depends_on: ["b"] },
        { ...validPlannedNode, id: "b", depends_on: ["a"] }
      ]
    }
  },
  "planned-graph-artifact-dir-identity": {
    positive: validPlannedGraph,
    negative: { nodes: [{ ...validPlannedNode, artifact_dir: "artifacts/other" }] }
  },
  "planned-graph-contract-identity": {
    positive: validPlannedGraph,
    negative: {
      nodes: [{ ...validPlannedNode, outputs: [{ ...validPlannedOutput, contract_digest: "0".repeat(64) }] }]
    }
  },
  "planned-graph-dependency-join": {
    positive: validPlannedGraph,
    negative: { nodes: [{ ...validPlannedNode, depends_on: ["missing"] }] }
  },
  "planned-graph-exactly-one-primary": {
    positive: validPlannedGraph,
    negative: { nodes: [{ ...validPlannedNode, outputs: [{ ...validPlannedOutput, primary: false }] }] }
  },
  "planned-graph-loop-coupling": {
    positive: validPlannedGraph,
    negative: { nodes: [{ ...validPlannedNode, loop: { index: 1, count: 1, attempt_index: 1 } }] }
  },
  "planned-graph-model-fanout-uniqueness": {
    positive: validPlannedGraph,
    negative: {
      nodes: [
        {
          ...validPlannedNode,
          model_fanout: [
            { model_profile_id: "m", model_index: 0, loop_index: 0, attempt_index: 0 },
            { model_profile_id: "m", model_index: 0, loop_index: 0, attempt_index: 0 }
          ]
        }
      ]
    }
  },
  "planned-graph-model-loop-coupling": {
    positive: validPlannedGraph,
    negative: {
      nodes: [
        {
          ...validPlannedNode,
          model_fanout: [{ model_profile_id: "m", model_index: 0, loop_index: 1, attempt_index: 0 }]
        }
      ]
    }
  },
  "planned-graph-node-id-uniqueness": {
    positive: validPlannedGraph,
    negative: { nodes: [validPlannedNode, { ...validPlannedNode }] }
  },
  "planned-graph-output-path-uniqueness": {
    positive: validPlannedGraph,
    negative: {
      nodes: [{ ...validPlannedNode, outputs: [validPlannedOutput, { ...validPlannedOutput, primary: false }] }]
    }
  },
  "planned-graph-workflow-node-join": {
    positive: { nodes: [{ ...validPlannedNode, workflow: { node_id: "a", task_node_ids: ["a"] } }] },
    negative: { nodes: [{ ...validPlannedNode, workflow: { node_id: "a", task_node_ids: ["b"] } }] }
  },
  "planned-graph-workflow-task-uniqueness": {
    positive: { nodes: [{ ...validPlannedNode, workflow: { node_id: "a", task_node_ids: ["a"] } }] },
    negative: {
      nodes: [
        { ...validPlannedNode, workflow: { node_id: "a", task_node_ids: ["a"] } },
        { ...validPlannedNode, id: "node-b", workflow: { node_id: "a", task_node_ids: ["a"] } }
      ]
    }
  },
  "property-campaign-coverage-metric-uniqueness": {
    positive: { coverage: { metrics: [{ name: "branches" }] } },
    negative: { coverage: { metrics: [{ name: "branches" }, { name: "branches" }] } }
  },
  "property-campaign-evidence-file-budget": {
    positive: { evidence_files: [{ size_bytes: 64 * 1024 * 1024 }] },
    negative: { evidence_files: [{ size_bytes: 64 * 1024 * 1024 }, { size_bytes: 1 }] }
  },
  "property-campaign-evidence-file-closure": {
    positive: {
      execution: { usable_results: false, started_at: null },
      paths: { log: "run.log", raw_results: "results.json" },
      coverage: { status: "unavailable", metrics: [] },
      property_results: [],
      failures: [],
      evidence_files: []
    },
    negative: {
      execution: { usable_results: true, started_at: "2026-01-01T00:00:00Z" },
      paths: { log: "run.log", raw_results: "results.json" },
      coverage: { status: "reported", metrics: [] },
      property_results: [],
      failures: [],
      evidence_files: [{ path: "run.log" }]
    }
  },
  "property-campaign-failure-id-uniqueness": {
    positive: { failures: [{ id: "a" }] },
    negative: { failures: [{ id: "a" }, { id: "a" }] }
  },
  "property-campaign-property-result-id-uniqueness": {
    positive: { property_results: [{ property_id: "a" }] },
    negative: { property_results: [{ property_id: "a" }, { property_id: "a" }] }
  },
  "property-campaign-document-coherence": {
    positive: {
      execution: {
        status: "complete",
        usable_results: true,
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:01Z",
        deadline: "2026-01-01T00:00:02Z"
      },
      coverage: { metrics: [] },
      property_results: [],
      failures: []
    },
    negative: {
      execution: {
        status: "complete",
        usable_results: true,
        started_at: "2026-01-01T00:00:02Z",
        finished_at: "2026-01-01T00:00:01Z",
        deadline: "2026-01-01T00:00:00Z"
      },
      coverage: { metrics: [] },
      property_results: [],
      failures: []
    }
  },
  "property-id-uniqueness": {
    positive: { properties: [{ id: "a" }] },
    negative: { properties: [{ id: "a" }, { id: "a" }] }
  },
  "property-lens-id-uniqueness": {
    positive: { properties: [{ id: "a" }] },
    negative: { properties: [{ id: "a" }, { id: "a" }] }
  },
  "property-source-projected-uniqueness": {
    positive: { properties: [{ sources: [{ source_node_id: "n", source_property_id: "a" }] }] },
    negative: {
      properties: [
        { sources: [{ source_node_id: "n", source_property_id: "a" }] },
        { sources: [{ source_node_id: "n", source_property_id: "a" }] }
      ]
    }
  },
  "reference-expectation-id-uniqueness": {
    positive: { expectations: [{ id: "a" }] },
    negative: { expectations: [{ id: "a" }, { id: "a" }] }
  },
  "reference-manifest-path-uniqueness": {
    positive: { source_files: [{ path: "a" }], artifacts: [{ path: "b" }] },
    negative: { source_files: [{ path: "a" }], artifacts: [{ path: "a" }] }
  },
  "release-validation-report-reconciliation": {
    positive: { overall_status: "pass", commands: [{ id: "a", status: "passed" }] },
    negative: {
      overall_status: "pass",
      commands: [
        { id: "a", status: "passed" },
        { id: "a", status: "failed" }
      ]
    }
  },
  "report-finding-id-uniqueness": {
    positive: { issues: [{ id: "a" }], non_production_outcomes: [{ id: "b" }] },
    negative: { issues: [{ id: "a" }], non_production_outcomes: [{ id: "a" }] }
  },
  "report-finding-evidence-span-consistency": {
    positive: {
      issues: [{ evidence: [{ line: 1, end_line: 2 }] }],
      non_production_outcomes: [{ evidence: [{ line_ranges: [{ line: 3 }, { line: 5 }] }] }]
    },
    negative: {
      issues: [],
      non_production_outcomes: [{ evidence: [{ line_ranges: [{ line: 5 }, { line: 3 }] }] }]
    }
  },
  "report-finding-report-vocabulary": {
    positive: {
      issues: [
        {
          notes: ["Observed balance=0 after withdrawal."],
          severity_rationale: "reachability=public-entrypoint-trace: reproduced"
        }
      ],
      non_production_outcomes: []
    },
    negative: {
      issues: [],
      non_production_outcomes: [{ notes: ["reachability=renamed-public-trace"] }]
    }
  },
  "report-coverage-evidence-reconciliation": {
    positive: { coverage_evidence: validCoverageEvidence },
    negative: {
      coverage_evidence: {
        ...validCoverageEvidence,
        views: [
          { scope: "selected-range", covered_ranges: 0, total_ranges: 1 },
          { scope: "production-source", covered_ranges: 0, total_ranges: 1 }
        ]
      }
    }
  },
  "run-metadata-accounting-workflow-identity": {
    positive: {
      workflow: { run_id: "workflow-a" },
      accounting: { workflow_run_id: "workflow-a", current: { workflow_run_id: "workflow-a" } }
    },
    negative: {
      workflow: { run_id: "workflow-a" },
      accounting: { workflow_run_id: "workflow-b", current: { workflow_run_id: "workflow-b" } }
    }
  },
  "run-metadata-current-segment-equality": {
    positive: { accounting: { current: { total_tokens: 2 }, segments: [{ total_tokens: 1 }, { total_tokens: 2 }] } },
    negative: { accounting: { current: { total_tokens: 1 }, segments: [{ total_tokens: 1 }, { total_tokens: 2 }] } }
  },
  "run-metadata-workflow-id-equality": {
    positive: { workflow_ids: ["workflow-a"], workflow: { run_id: "workflow-a" } },
    negative: { workflow_ids: ["workflow-b"], workflow: { run_id: "workflow-a" } }
  },
  "run-plan-attempt-id-uniqueness": {
    positive: { rendered_prompts: [{ attempt_id: "a" }, { attempt_id: "b" }] },
    negative: { rendered_prompts: [{ attempt_id: "a" }, { attempt_id: "a" }] }
  },
  "run-state-node-key-equality": {
    positive: { nodes: { a: { node_id: "a" } } },
    negative: { nodes: { a: { node_id: "b" } } }
  },
  "selected-strategy-id-uniqueness": {
    positive: { strategies: [{ strategy_id: "a" }] },
    negative: { strategies: [{ strategy_id: "a" }, { strategy_id: "a" }] }
  },
  "semantic-red-hash-uniqueness": {
    positive: {
      semantic_reds: [{ stable_failure_hash: "a" }],
      compile_or_harness_defects: [{ stable_failure_hash: "b" }]
    },
    negative: {
      semantic_reds: [{ stable_failure_hash: "a" }],
      compile_or_harness_defects: [{ stable_failure_hash: "a" }]
    }
  },
  "severity-finding-id-uniqueness": {
    positive: [{ id: "a" }],
    negative: [{ id: "a" }, { id: "a" }]
  },
  "severity-finding-evidence-span-consistency": {
    positive: [{ family_variants: [{ evidence: [{ line_ranges: [{ line: 3 }, { line: 5 }] }] }] }],
    negative: [{ family_variants: [{ evidence: [{ line_ranges: [{ line: 3, end_line: 2 }, { line: 5 }] }] }] }]
  },
  "severity-classification-matrix": {
    positive: [{ severity: "Medium", impact: "High", likelihood: "Low" }],
    negative: [{ severity: "High", impact: "High", likelihood: "Low" }]
  },
  "smithers-task-attempt-id-uniqueness": {
    positive: { tasks: [{ attemptId: "a" }] },
    negative: { tasks: [{ attemptId: "a" }, { attemptId: "a" }] }
  },
  "smithers-task-workflow-id-uniqueness": {
    positive: { tasks: [{ smithersNodeId: "node:a", verifierSmithersNodeId: "verify:a" }] },
    negative: {
      tasks: [
        { smithersNodeId: "node:a", verifierSmithersNodeId: "verify:a" },
        { smithersNodeId: "node:a", verifierSmithersNodeId: "verify:b" }
      ]
    }
  },
  "smithers-task-document-identity": {
    positive: { run_id: "run-a", workflow_name: "workflow-a", tasks: [smithersIdentityTask] },
    negative: {
      run_id: "run-a",
      workflow_name: "workflow-a",
      tasks: [{ ...smithersIdentityTask, smithersNodeId: "node:wrong" }]
    }
  },
  "smithers-task-pinned-submodule-expectation": {
    positive: { pinned_submodules: pinnedSubmoduleExpectation, tasks: [{ execution: { mode: "cloud" } }] },
    negative: {
      pinned_submodules: { ...pinnedSubmoduleExpectation, file_count: 2 },
      tasks: [{ execution: { mode: "cloud" } }]
    }
  },
  "smithers-task-dependency-join": {
    positive: {
      tasks: [
        { attemptId: "a", verifierSmithersNodeId: "verify:a", dependencies: [], dependencySmithersNodeIds: [] },
        {
          attemptId: "b",
          verifierSmithersNodeId: "verify:b",
          dependencies: ["a"],
          dependencySmithersNodeIds: ["verify:a"]
        }
      ]
    },
    negative: {
      tasks: [
        {
          attemptId: "b",
          verifierSmithersNodeId: "verify:b",
          dependencies: ["missing"],
          dependencySmithersNodeIds: ["verify:missing"]
        }
      ]
    }
  },
  "smithers-task-dependency-acyclicity": {
    positive: {
      tasks: [
        { attemptId: "a", verifierSmithersNodeId: "verify:a", dependencySmithersNodeIds: [] },
        { attemptId: "b", verifierSmithersNodeId: "verify:b", dependencySmithersNodeIds: ["verify:a"] }
      ]
    },
    negative: {
      tasks: [
        { attemptId: "a", verifierSmithersNodeId: "verify:a", dependencySmithersNodeIds: ["verify:b"] },
        { attemptId: "b", verifierSmithersNodeId: "verify:b", dependencySmithersNodeIds: ["verify:a"] }
      ]
    }
  },
  "source-run-not-self": {
    positive: { run_id: "run-new", source_run_id: "run-source" },
    negative: { run_id: "run-same", source_run_id: "run-same" }
  },
  "strategy-detection-dedupe-key-uniqueness": {
    positive: [{ dedupe_key: "a" }],
    negative: [{ dedupe_key: "a" }, { dedupe_key: "a" }]
  },
  "strategy-detection-hit-identity-uniqueness": {
    positive: [
      {
        hits: [
          { strategy: "stateful", attempt_index: 0, model_id: "m", model_index: 0, loop_index: 0 },
          { strategy: "stateful", attempt_index: 1, model_id: "m", model_index: 0, loop_index: 1 }
        ]
      }
    ],
    negative: [
      {
        hits: [
          { strategy: "stateful", attempt_index: 0, model_id: "m", model_index: 0, loop_index: 0 },
          { strategy: "stateful", attempt_index: 0, model_id: "m", model_index: 0, loop_index: 0 }
        ]
      }
    ]
  },
  "severity-finding-report-vocabulary": {
    positive: [{ severity_rationale: "reachability=helper-only: public entrypoints reject the input" }],
    negative: [{ severity_rationale: "reachability=renamed-public-trace" }]
  },
  "triaged-finding-id-uniqueness": {
    positive: [{ id: "a" }],
    negative: [{ id: "a" }, { id: "a" }]
  },
  "triaged-finding-evidence-span-consistency": {
    positive: [{ evidence: [{ line: 3, end_line: 5 }] }],
    negative: [
      {
        evidence: [
          {
            line_ranges: [
              { line: 3, end_line: 6 },
              { line: 5, end_line: 8 }
            ]
          }
        ]
      }
    ]
  },
  "workspace-patch-path-uniqueness": {
    positive: { files: [{ path: "a" }], excluded_files: [{ path: "b" }] },
    negative: { files: [{ path: "a" }], excluded_files: [{ path: "a" }] }
  }
} satisfies Partial<Record<SemanticGateName, GateFixture>>;

test("the exact-name registry matches metadata and declares honest scopes", () => {
  const metadataNames = Object.values(ARTIFACT_SCHEMA_METADATA).flatMap((entry) => entry.semanticGates);
  assert.equal(new Set(metadataNames).size, metadataNames.length, "metadata must not repeat gate names");
  assert.deepEqual(Object.keys(SEMANTIC_GATE_REGISTRY).sort(), [...metadataNames].sort());
  for (const [name, registration] of Object.entries(SEMANTIC_GATE_REGISTRY)) {
    assert.equal(registration.name, name);
    assert.ok(SEMANTIC_GATE_SCOPES.includes(registration.scope));
    assert.equal(registration.scope === "document", registration.requiredContext.length === 0, name);
    assert.deepEqual(semanticGateRegistration(name as SemanticGateName), registration);
  }
});

test("every document-local gate has a passing and failing non-mutating fixture", () => {
  const documentNames = Object.values(SEMANTIC_GATE_REGISTRY)
    .filter((registration) => registration.scope === "document")
    .map((registration) => registration.name);
  assert.deepEqual(Object.keys(fixtures).sort(), documentNames.sort());
  for (const name of documentNames) {
    const fixture = fixtures[name as keyof typeof fixtures]!;
    const positiveBefore = structuredClone(fixture.positive);
    const negativeBefore = structuredClone(fixture.negative);
    assert.equal(executeSemanticGate(name, { document: fixture.positive }).status, "passed", `${name}:positive`);
    assert.equal(executeSemanticGate(name, { document: fixture.negative }).status, "failed", `${name}:negative`);
    assert.deepEqual(fixture.positive, positiveBefore, `${name}:positive mutated`);
    assert.deepEqual(fixture.negative, negativeBefore, `${name}:negative mutated`);
  }
});

test("severity and report vocabulary gates reject renamed reachability tokens at both boundaries", () => {
  const invalid = { severity_rationale: "reachability=renamed-public-trace" };
  const severity = executeSemanticGate("severity-finding-report-vocabulary", { document: [invalid] });
  assert.equal(severity.status, "failed");
  assert.deepEqual(
    severity.issues.map((entry) => entry.path),
    ["$[0].severity_rationale"]
  );

  const report = executeSemanticGate("report-finding-report-vocabulary", {
    document: { issues: [invalid], non_production_outcomes: [{ notes: ["helper_evidence=renamed"] }] }
  });
  assert.equal(report.status, "failed");
  assert.deepEqual(
    report.issues.map((entry) => entry.path),
    ["$.issues[0].severity_rationale", "$.non_production_outcomes[0].notes[0]"]
  );
});

test("property references alone do not claim fuzzer campaign provenance", () => {
  assert.equal(
    executeSemanticGate("finding-campaign-provenance-coherence", {
      document: { property_ids: ["property-1"] }
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("findings-campaign-provenance-coherence", {
      document: [{ property_ids: ["property-1"] }]
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("finding-campaign-provenance-coherence", {
      document: { property_ids: ["property-1"], fuzzer_backend: "recon" }
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("finding-campaign-provenance-coherence", {
      document: { property_ids: ["property-1"], fuzzer_backend: "recon", deduplication: { pre_dedup_count: 1 } }
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("finding-campaign-provenance-coherence", {
      document: {
        property_ids: ["property-1"],
        fuzzer_backend: "recon",
        contributing_backend_failures: [{ fuzzer_backend: "recon", failure_id: "failure-1" }]
      }
    }).status,
    "failed"
  );
});

test("property source joins require exact reverse coverage of every declared lens row", () => {
  const context = {
    artifactSet: {
      propertyLenses: [
        {
          sourceNodeId: "lens",
          projectionRequired: true,
          document: { properties: [{ id: "a" }, { id: "b" }] }
        },
        {
          sourceNodeId: "custom-ledger-producer",
          projectionRequired: false,
          document: { properties: [{ id: "evidence-only" }] }
        }
      ]
    }
  };
  const incomplete = {
    properties: [{ sources: [{ source_node_id: "lens", source_property_id: "a" }] }]
  };

  const rejected = executeSemanticGate("property-source-join", { document: incomplete, context });

  assert.equal(rejected.status, "failed");
  assert.deepEqual(rejected.status === "failed" ? rejected.issues : [], [
    {
      path: "$.properties",
      message: 'Canonical properties omit declared property-lens source ["lens","b"]'
    }
  ]);

  const complete = {
    properties: [
      {
        sources: [
          { source_node_id: "lens", source_property_id: "a" },
          { source_node_id: "lens", source_property_id: "b" }
        ]
      }
    ]
  };
  assert.equal(executeSemanticGate("property-source-join", { document: complete, context }).status, "passed");
});

test("campaign evidence closure derives exact file authority from execution status and typed references", () => {
  const entry = (entryPath: string) => ({ path: entryPath, size_bytes: 1, sha256: "a".repeat(64) });
  const base = {
    execution: { usable_results: false, started_at: null },
    paths: { log: "backends/recon/run.log", raw_results: "backends/recon/results.json" },
    coverage: { status: "unavailable", metrics: [] as unknown[] },
    property_results: [] as unknown[],
    failures: [] as unknown[],
    evidence_files: [] as unknown[]
  };
  const cases: Array<{ label: string; document: unknown; passed: boolean }> = [
    { label: "unavailable-needs-no-operational-file", document: base, passed: true },
    {
      label: "started-failure-needs-only-log",
      document: {
        ...base,
        execution: { usable_results: false, started_at: "2026-01-01T00:00:00Z" },
        evidence_files: [entry(base.paths.log)]
      },
      passed: true
    },
    {
      label: "usable-results-need-log-and-raw-results",
      document: {
        ...base,
        execution: { usable_results: true, started_at: "2026-01-01T00:00:00Z" },
        evidence_files: [entry(base.paths.log), entry(base.paths.raw_results)]
      },
      passed: true
    },
    {
      label: "reported-coverage-needs-source-and-raw-results",
      document: {
        ...base,
        coverage: {
          status: "reported",
          metrics: [{ name: "coverage", source_ref: "backends/recon/coverage.json" }]
        },
        evidence_files: [entry(base.paths.raw_results), entry("backends/recon/coverage.json")]
      },
      passed: true
    },
    {
      label: "failure-needs-raw-and-deterministic-reproducers",
      document: {
        ...base,
        failures: [
          {
            raw_reproducer_ref: "backends/recon/raw.txt",
            deterministic_reproducer_ref: "backends/recon/reproducer.t.sol"
          }
        ],
        evidence_files: [
          entry(base.paths.raw_results),
          entry("backends/recon/raw.txt"),
          entry("backends/recon/reproducer.t.sol")
        ]
      },
      passed: true
    },
    {
      label: "unreferenced-entry-rejected",
      document: { ...base, evidence_files: [entry("backends/recon/extra.txt")] },
      passed: false
    },
    {
      label: "duplicate-entry-rejected",
      document: {
        ...base,
        execution: { usable_results: false, started_at: "2026-01-01T00:00:00Z" },
        evidence_files: [entry(base.paths.log), entry(base.paths.log)]
      },
      passed: false
    }
  ];
  for (const fixture of cases) {
    assert.equal(
      executeSemanticGate("property-campaign-evidence-file-closure", { document: fixture.document }).status,
      fixture.passed ? "passed" : "failed",
      fixture.label
    );
  }
});

test("workspace patch path gate reports exact nonduplicated field diagnostics", () => {
  const cases = [
    {
      document: { files: [{ path: "a" }, { path: "a" }], excluded_files: [] },
      issue: { path: "$.files[1].path", message: 'Duplicate workspace patch path "a"' }
    },
    {
      document: { files: [{ path: "a" }], excluded_files: [{ path: "b" }, { path: "b" }] },
      issue: { path: "$.excluded_files[1].path", message: 'Duplicate excluded workspace patch path "b"' }
    },
    {
      document: { files: [{ path: "a" }], excluded_files: [{ path: "a" }] },
      issue: {
        path: "$.excluded_files[0].path",
        message: 'Workspace patch path is both included and excluded "a"'
      }
    }
  ];

  for (const fixture of cases) {
    const result = executeSemanticGate("workspace-patch-path-uniqueness", { document: fixture.document });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.status === "failed" ? result.issues : [], [fixture.issue]);
  }
});

test("canonical finding span semantics run for every embedding schema", () => {
  const cases = [
    {
      filename: "finding.schema.json",
      gate: "finding-evidence-span-consistency",
      positive: { evidence: [{ line: 3, end_line: 5 }] },
      negative: { evidence: [{ line: 5, end_line: 3 }] },
      path: "$.evidence[0].end_line"
    },
    {
      filename: "findings.schema.json",
      gate: "findings-evidence-span-consistency",
      positive: [{ evidence: [{ line_ranges: [{ line: 3, end_line: 5 }, { line: 6 }] }] }],
      negative: [{ evidence: [{ line_ranges: [{ line: 3, end_line: 5 }, { line: 5 }] }] }],
      path: "$[0].evidence[0].line_ranges[1].line"
    },
    {
      filename: "triaged-findings.schema.json",
      gate: "triaged-finding-evidence-span-consistency",
      positive: [{ evidence: [{ line_ranges: [{ line: 3 }, { line: 5, end_line: 7 }] }] }],
      negative: [{ evidence: [{ line_ranges: [{ line: 5 }, { line: 3 }] }] }],
      path: "$[0].evidence[0].line_ranges[1].line"
    },
    {
      filename: "severity-classified-findings.schema.json",
      gate: "severity-finding-evidence-span-consistency",
      positive: [{ family_variants: [{ evidence: [{ line: 3, end_line: 5 }] }] }],
      negative: [{ family_variants: [{ evidence: [{ line: 5, end_line: 3 }] }] }],
      path: "$[0].family_variants[0].evidence[0].end_line"
    },
    {
      filename: "report.schema.json",
      gate: "report-finding-evidence-span-consistency",
      positive: { issues: [{ evidence: [{ line: 3 }] }], non_production_outcomes: [] },
      negative: {
        issues: [],
        non_production_outcomes: [{ evidence: [{ line_ranges: [{ line: 3, end_line: 6 }, { line: 5 }] }] }]
      },
      path: "$.non_production_outcomes[0].evidence[0].line_ranges[1].line"
    }
  ] as const;

  for (const fixture of cases) {
    assert.ok(ARTIFACT_SCHEMA_METADATA[fixture.filename].semanticGates.includes(fixture.gate));
    const positive = executeOfflineSchemaSemanticGates(fixture.filename, fixture.positive).find(
      (result) => result.gate === fixture.gate
    );
    const negative = executeOfflineSchemaSemanticGates(fixture.filename, fixture.negative).find(
      (result) => result.gate === fixture.gate
    );
    assert.equal(positive?.status, "passed", `${fixture.filename}:positive`);
    assert.equal(negative?.status, "failed", `${fixture.filename}:negative`);
    assert.ok(
      negative?.status === "failed" && negative.issues.some((entry) => entry.path === fixture.path),
      `${fixture.filename}:${fixture.path}`
    );
  }
});

test("offline schema execution never claims contextual gates passed", () => {
  for (const [filename, metadata] of Object.entries(ARTIFACT_SCHEMA_METADATA)) {
    const results = executeOfflineSchemaSemanticGates(filename as keyof typeof ARTIFACT_SCHEMA_METADATA, {});
    assert.deepEqual(
      results.map((result) => result.gate),
      metadata.semanticGates
    );
    for (const result of results) {
      const registration = SEMANTIC_GATE_REGISTRY[result.gate as SemanticGateName];
      if (registration.scope === "document") continue;
      assert.equal(result.status, "requires-context", `${filename}:${result.gate}`);
      if (result.status === "requires-context") {
        assert.deepEqual(result.missingContext, registration.requiredContext);
      }
    }
  }
});

test("report campaign outcome authority distinguishes absent campaigns from untrusted status", () => {
  assert.equal(
    executeSemanticGate("report-campaign-outcome-authority", {
      document: {},
      context: { artifactSet: { campaignSummary: null } }
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("report-campaign-outcome-authority", {
      document: { campaign_outcome: { outcome: "blocked" } },
      context: { artifactSet: { campaignSummary: null } }
    }).status,
    "failed"
  );
  const missingReason = executeSemanticGate("report-campaign-outcome-authority", {
    document: { campaign_outcome: { outcome: "partial" } },
    context: { artifactSet: { campaignSummary: { outcome: "partial", reason: "deadline elapsed" } } }
  });
  assert.equal(missingReason.status, "failed");
  assert.deepEqual(missingReason.status === "failed" ? missingReason.issues : [], [
    { path: "$.campaign_outcome.reason", message: "Report campaign reason does not match the campaign summary" }
  ]);
});

test("generated-test filesystem gate rejects cumulative actual bytes before reading companions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-test-bounds-"));
  try {
    fs.mkdirSync(path.join(root, "generated-tests"));
    const generated_tests = Array.from({ length: 5 }, (_, index) => {
      const relativePath = `generated-tests/Test-${index}.sol`;
      const absolutePath = path.join(root, relativePath);
      fs.writeFileSync(absolutePath, "x", "utf8");
      fs.truncateSync(absolutePath, 16 * 1024 * 1024);
      return { path: relativePath, size_bytes: 1, sha256: "0".repeat(64) };
    });
    const readSync = t.mock.method(fs, "readSync", () => {
      throw new Error("companion content was read before cumulative resource preflight completed");
    });

    const result = executeSemanticGate("generated-test-file-integrity", {
      document: { generated_tests, support_files: [] },
      context: { filesystem: { rootDirectory: root } }
    });
    assert.equal(result.status, "failed");
    assert.ok(
      result.status === "failed" &&
        result.issues.some((entry) => /67108864-byte combined bundle limit/u.test(entry.message))
    );
    assert.equal(readSync.mock.callCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated-test filesystem gate rejects hard-linked companions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-test-hardlinks-"));
  try {
    const generatedTestsDir = path.join(root, "generated-tests");
    fs.mkdirSync(generatedTestsDir);
    const testBytes = Buffer.from("contract Replay {}\n", "utf8");
    const supportBytes = Buffer.from("library InvariantFixture {}\n", "utf8");
    const testPath = path.join(generatedTestsDir, "Replay.t.sol");
    const supportPath = path.join(generatedTestsDir, "InvariantFixture.sol");
    fs.writeFileSync(testPath, testBytes);
    fs.writeFileSync(supportPath, supportBytes);
    fs.linkSync(testPath, path.join(root, "Replay-alias.t.sol"));
    fs.linkSync(supportPath, path.join(root, "InvariantFixture-alias.sol"));

    const result = executeSemanticGate("generated-test-file-integrity", {
      document: {
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-a",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [
          {
            path: "generated-tests/Replay.t.sol",
            size_bytes: testBytes.length,
            sha256: crypto.createHash("sha256").update(testBytes).digest("hex")
          }
        ],
        support_files: [
          {
            path: "generated-tests/InvariantFixture.sol",
            size_bytes: supportBytes.length,
            sha256: crypto.createHash("sha256").update(supportBytes).digest("hex")
          }
        ]
      },
      context: { filesystem: { rootDirectory: root } }
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.status === "failed"
        ? result.issues.map((entry) => ({ path: entry.path, hardLinked: /hard-linked/u.test(entry.message) }))
        : [],
      [
        { path: "$.generated_tests[0].path", hardLinked: true },
        { path: "$.support_files[0].path", hardLinked: true }
      ]
    );
    assert.equal(fs.lstatSync(testPath).nlink, 2);
    assert.equal(fs.lstatSync(supportPath).nlink, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("aggregation schema gates exactly reconcile authenticated atomic bundles and destinations", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-aggregation-gates-"));
  const workspaceRoot = path.join(temporary, "workspace");
  fs.mkdirSync(workspaceRoot);

  type AggregationRow = Readonly<Record<string, unknown>>;
  type TrustedAggregation = NonNullable<SemanticGateContext["aggregation"]>;
  type TrustedBundle = TrustedAggregation["sourceBundles"][number];

  try {
    const generatedBytes = Buffer.from("contract GeneratedTest {}\n", "utf8");
    const supportBytes = Buffer.from("library GeneratedSupport {}\n", "utf8");
    const generatedDigest = crypto.createHash("sha256").update(generatedBytes).digest("hex");
    const supportDigest = crypto.createHash("sha256").update(supportBytes).digest("hex");
    const copiedManifestDigest = "a".repeat(64);
    const emptyManifestDigest = "b".repeat(64);
    const copiedManifestPath = path.join(temporary, "sources", "attempt-a", "generated-tests.json");
    const emptyManifestPath = path.join(temporary, "sources", "attempt-empty", "generated-tests.json");
    const generatedSourcePath = path.join(temporary, "sources", "attempt-a", "generated-tests", "Test.t.sol");
    const supportSourcePath = path.join(temporary, "sources", "attempt-a", "generated-tests", "Support.sol");
    const generatedDestinationPath = path.join(workspaceRoot, "Test.t.sol");
    const supportDestinationPath = path.join(workspaceRoot, "Support.sol");
    fs.writeFileSync(generatedDestinationPath, generatedBytes);
    fs.writeFileSync(supportDestinationPath, supportBytes);

    const generatedEntry = {
      kind: "generated-test" as const,
      sourceArtifactPath: generatedSourcePath,
      sourceRelativePath: "generated-tests/Test.t.sol",
      sizeBytes: generatedBytes.length,
      sha256: generatedDigest,
      bytes: generatedBytes,
      language: "solidity",
      description: "Generated invariant test",
      provenance: { producer_node_id: "strategy-a", run_id: "run-a" }
    };
    const supportEntry = {
      kind: "support-file" as const,
      sourceArtifactPath: supportSourcePath,
      sourceRelativePath: "generated-tests/Support.sol",
      sizeBytes: supportBytes.length,
      sha256: supportDigest,
      bytes: supportBytes,
      language: "solidity",
      description: "Generated invariant support",
      provenance: { producer_node_id: "strategy-a", run_id: "run-a" }
    };
    const copiedTrustedBundle: TrustedBundle = {
      strategy: "strategy-a",
      nodeId: "strategy-a",
      sourceAttemptId: "attempt-a",
      attemptIndex: 0,
      sourceManifestPath: copiedManifestPath,
      sourceManifestRelativePath: "generated-tests.json",
      sourceManifestSha256: copiedManifestDigest,
      sourceRunId: "run-a",
      framework: "foundry",
      entries: [generatedEntry, supportEntry]
    };
    const emptyTrustedBundle: TrustedBundle = {
      strategy: "strategy-empty",
      nodeId: "strategy-empty",
      sourceAttemptId: "attempt-empty",
      attemptIndex: 1,
      sourceManifestPath: emptyManifestPath,
      sourceManifestRelativePath: "generated-tests.json",
      sourceManifestSha256: emptyManifestDigest,
      sourceRunId: "run-a",
      framework: "echidna",
      entries: []
    };
    const contextFor = (
      sourceBundles: readonly TrustedBundle[] = [copiedTrustedBundle, emptyTrustedBundle]
    ): SemanticGateContext => ({ aggregation: { workspaceRoot, sourceBundles } });

    const copiedBundleSummary: AggregationRow = {
      strategy: "strategy-a",
      node_id: "strategy-a",
      source_attempt_id: "attempt-a",
      attempt_index: 0,
      source_manifest_path: copiedManifestPath,
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: copiedManifestDigest,
      source_run_id: "run-a",
      framework: "foundry",
      generated_test_count: 1,
      support_file_count: 1,
      disposition: "copied"
    };
    const emptyBundleSummary: AggregationRow = {
      strategy: "strategy-empty",
      node_id: "strategy-empty",
      source_attempt_id: "attempt-empty",
      attempt_index: 1,
      source_manifest_path: emptyManifestPath,
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: emptyManifestDigest,
      source_run_id: "run-a",
      framework: "echidna",
      generated_test_count: 0,
      support_file_count: 0,
      disposition: "empty"
    };
    const generatedCopiedRow: AggregationRow = {
      strategy: "strategy-a",
      node_id: "strategy-a",
      source_attempt_id: "attempt-a",
      attempt_index: 0,
      source_manifest_path: copiedManifestPath,
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: copiedManifestDigest,
      source_artifact_path: generatedSourcePath,
      source_relative_path: "generated-tests/Test.t.sol",
      destination_path: generatedDestinationPath,
      destination_relative_path: "Test.t.sol",
      size_bytes: generatedBytes.length,
      sha256: generatedDigest,
      language: "solidity",
      description: "Generated invariant test",
      provenance: { producer_node_id: "strategy-a", run_id: "run-a" }
    };
    const supportCopiedRow: AggregationRow = {
      strategy: "strategy-a",
      node_id: "strategy-a",
      source_attempt_id: "attempt-a",
      attempt_index: 0,
      source_manifest_path: copiedManifestPath,
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: copiedManifestDigest,
      source_artifact_path: supportSourcePath,
      source_relative_path: "generated-tests/Support.sol",
      destination_path: supportDestinationPath,
      destination_relative_path: "Support.sol",
      size_bytes: supportBytes.length,
      sha256: supportDigest,
      language: "solidity",
      description: "Generated invariant support",
      provenance: { producer_node_id: "strategy-a", run_id: "run-a" }
    };

    const buildDocument = (
      options: {
        sourceBundles?: readonly AggregationRow[];
        files?: readonly AggregationRow[];
        supportFiles?: readonly AggregationRow[];
        skippedFiles?: readonly AggregationRow[];
      } = {}
    ): unknown => {
      const sourceBundles = options.sourceBundles ?? [copiedBundleSummary, emptyBundleSummary];
      const files = options.files ?? [generatedCopiedRow];
      const supportFiles = options.supportFiles ?? [supportCopiedRow];
      const skippedFiles = options.skippedFiles ?? [];
      const declaredCount = (field: "generated_test_count" | "support_file_count"): number =>
        sourceBundles.reduce((total, bundle) => {
          const count = bundle[field];
          return total + (typeof count === "number" ? count : 0);
        }, 0);
      return {
        schema_version: "ultrafuzz.aggregation-manifest.v1",
        source_generated_tests: declaredCount("generated_test_count"),
        copied_generated_tests: files.length,
        source_support_files: declaredCount("support_file_count"),
        copied_support_files: supportFiles.length,
        source_bundles: sourceBundles,
        files,
        support_files: supportFiles,
        skipped_files: skippedFiles
      };
    };
    const execute = (document: unknown, context: SemanticGateContext = contextFor()) =>
      executeSchemaSemanticGates("aggregation-manifest.schema.json", { document, context });
    const assertPasses = (label: string, document: unknown, context: SemanticGateContext = contextFor()): void => {
      const failures = execute(document, context)
        .filter((result) => result.status !== "passed")
        .map((result) => ({
          gate: result.gate,
          status: result.status,
          detail:
            result.status === "failed"
              ? result.issues.map((entry) => entry.message)
              : result.status === "requires-context"
                ? result.missingContext
                : []
        }));
      assert.deepEqual(failures, [], label);
    };
    const assertFails = (
      label: string,
      document: unknown,
      gate: SemanticGateName,
      message: RegExp,
      context: SemanticGateContext = contextFor()
    ): void => {
      const result = execute(document, context).find((entry) => entry.gate === gate);
      assert.equal(result?.status, "failed", `${label}: ${gate}`);
      assert.match(
        result?.status === "failed" ? result.issues.map((entry) => entry.message).join("\n") : "",
        message,
        label
      );
    };
    const asSkipped = (row: AggregationRow, kind: "generated-test" | "support-file", reason: string) => ({
      ...Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== "destination_path" && key !== "destination_relative_path")
      ),
      kind,
      reason
    });

    const exactDocument = buildDocument();
    assertPasses("an exact copied bundle and exact authenticated empty bundle pass every schema gate", exactDocument);

    const skippedReason = "duplicate atomic bundle";
    const skippedBundleSummary = { ...copiedBundleSummary, disposition: "skipped", reason: skippedReason };
    assertPasses(
      "an entire authenticated bundle may be skipped atomically",
      buildDocument({
        sourceBundles: [skippedBundleSummary, emptyBundleSummary],
        files: [],
        supportFiles: [],
        skippedFiles: [
          asSkipped(generatedCopiedRow, "generated-test", skippedReason),
          asSkipped(supportCopiedRow, "support-file", skippedReason)
        ]
      })
    );

    const fabricatedBundleSummary: AggregationRow = {
      ...emptyBundleSummary,
      strategy: "strategy-fabricated",
      node_id: "strategy-fabricated",
      source_attempt_id: "attempt-fabricated",
      source_manifest_path: path.join(temporary, "sources", "attempt-fabricated", "generated-tests.json"),
      source_manifest_sha256: "c".repeat(64),
      source_run_id: "run-fabricated",
      framework: "medusa"
    };
    const bundleCases: readonly {
      label: string;
      document: unknown;
      gate: SemanticGateName;
      message: RegExp;
    }[] = [
      {
        label: "omitted authenticated empty source bundle",
        document: buildDocument({ sourceBundles: [copiedBundleSummary] }),
        gate: "aggregation-authenticated-source-destination-reconciliation",
        message: /omits authenticated source bundle/u
      },
      {
        label: "fabricated source bundle",
        document: buildDocument({
          sourceBundles: [copiedBundleSummary, emptyBundleSummary, fabricatedBundleSummary]
        }),
        gate: "aggregation-authenticated-source-destination-reconciliation",
        message: /fabricates source bundle/u
      },
      {
        label: "duplicate source bundle",
        document: buildDocument({
          sourceBundles: [copiedBundleSummary, emptyBundleSummary, emptyBundleSummary]
        }),
        gate: "aggregation-authenticated-source-destination-reconciliation",
        message: /repeats source bundle/u
      },
      {
        label: "altered bundle framework",
        document: buildDocument({
          sourceBundles: [{ ...copiedBundleSummary, framework: "hardhat" }, emptyBundleSummary]
        }),
        gate: "aggregation-authenticated-source-destination-reconciliation",
        message: /bundle attribution does not match authority/u
      },
      {
        label: "empty bundle falsely marked copied",
        document: buildDocument({
          sourceBundles: [copiedBundleSummary, { ...emptyBundleSummary, disposition: "copied" }]
        }),
        gate: "aggregation-source-bundle-reconciliation",
        message: /cannot describe an empty bundle/u
      }
    ];
    for (const fixture of bundleCases) {
      assertFails(fixture.label, fixture.document, fixture.gate, fixture.message);
    }

    assertFails(
      "duplicate trusted source bundle",
      exactDocument,
      "aggregation-authenticated-source-destination-reconciliation",
      /Trusted aggregation context repeats source bundle/u,
      contextFor([copiedTrustedBundle, emptyTrustedBundle, emptyTrustedBundle])
    );
    const duplicatedTrustedEntryBundle: TrustedBundle = {
      ...copiedTrustedBundle,
      entries: [generatedEntry, supportEntry, generatedEntry]
    };
    assertFails(
      "duplicate trusted source entry",
      exactDocument,
      "aggregation-authenticated-source-destination-reconciliation",
      /Trusted aggregation context repeats source entry/u,
      contextFor([duplicatedTrustedEntryBundle, emptyTrustedBundle])
    );

    const fabricatedDestinationPath = path.join(workspaceRoot, "Fabricated.t.sol");
    const duplicateDestinationPath = path.join(workspaceRoot, "Duplicate.t.sol");
    fs.writeFileSync(fabricatedDestinationPath, generatedBytes);
    fs.writeFileSync(duplicateDestinationPath, generatedBytes);
    const fabricatedEntryRow: AggregationRow = {
      ...generatedCopiedRow,
      source_artifact_path: path.join(temporary, "sources", "attempt-a", "generated-tests", "Fabricated.t.sol"),
      source_relative_path: "generated-tests/Fabricated.t.sol",
      destination_path: fabricatedDestinationPath,
      destination_relative_path: "Fabricated.t.sol"
    };
    const duplicateEntryRow: AggregationRow = {
      ...generatedCopiedRow,
      destination_path: duplicateDestinationPath,
      destination_relative_path: "Duplicate.t.sol"
    };
    const entryCases: readonly { label: string; document: unknown; message: RegExp }[] = [
      {
        label: "omitted authenticated source entry",
        document: buildDocument({ supportFiles: [] }),
        message: /omits authenticated source entry/u
      },
      {
        label: "fabricated source entry",
        document: buildDocument({ files: [generatedCopiedRow, fabricatedEntryRow] }),
        message: /fabricates source entry/u
      },
      {
        label: "duplicate source entry",
        document: buildDocument({ files: [generatedCopiedRow, duplicateEntryRow] }),
        message: /duplicates authenticated source entry/u
      },
      {
        label: "altered typed kind",
        document: buildDocument({ files: [generatedCopiedRow, supportCopiedRow], supportFiles: [] }),
        message: /wrong typed kind/u
      },
      {
        label: "altered language metadata",
        document: buildDocument({ files: [{ ...generatedCopiedRow, language: "vyper" }] }),
        message: /metadata does not match authority/u
      },
      {
        label: "altered description metadata",
        document: buildDocument({ files: [{ ...generatedCopiedRow, description: "Altered description" }] }),
        message: /metadata does not match authority/u
      },
      {
        label: "altered provenance metadata",
        document: buildDocument({
          files: [
            {
              ...generatedCopiedRow,
              provenance: { producer_node_id: "strategy-fabricated", run_id: "run-a" }
            }
          ]
        }),
        message: /metadata does not match authority/u
      },
      {
        label: "altered companion digest",
        document: buildDocument({ files: [{ ...generatedCopiedRow, sha256: "f".repeat(64) }] }),
        message: /metadata does not match authority/u
      },
      {
        label: "altered companion size",
        document: buildDocument({ files: [{ ...generatedCopiedRow, size_bytes: generatedBytes.length + 1 }] }),
        message: /metadata does not match authority/u
      }
    ];
    for (const fixture of entryCases) {
      assertFails(
        fixture.label,
        fixture.document,
        "aggregation-authenticated-source-destination-reconciliation",
        fixture.message
      );
    }

    const alteredManifestDigest = "d".repeat(64);
    assertFails(
      "altered source-manifest digest throughout the output",
      buildDocument({
        sourceBundles: [{ ...copiedBundleSummary, source_manifest_sha256: alteredManifestDigest }, emptyBundleSummary],
        files: [{ ...generatedCopiedRow, source_manifest_sha256: alteredManifestDigest }],
        supportFiles: [{ ...supportCopiedRow, source_manifest_sha256: alteredManifestDigest }]
      }),
      "aggregation-authenticated-source-destination-reconciliation",
      /bundle attribution does not match authority/u
    );

    const partiallySkippedDocument = buildDocument({
      sourceBundles: [skippedBundleSummary, emptyBundleSummary],
      files: [generatedCopiedRow],
      supportFiles: [],
      skippedFiles: [asSkipped(supportCopiedRow, "support-file", skippedReason)]
    });
    const contextualPartialResult = execute(partiallySkippedDocument).find(
      (entry) => entry.gate === "aggregation-authenticated-source-destination-reconciliation"
    );
    assert.equal(contextualPartialResult?.status, "passed", "partial case must otherwise match authenticated entries");
    assertFails(
      "copied-versus-skipped partial atomic bundle",
      partiallySkippedDocument,
      "aggregation-source-bundle-reconciliation",
      /must skip every member and copy none/u
    );

    const mismatchSentinel = Buffer.from("do not mutate mismatch target\n", "utf8");
    const mismatchTargetPath = path.join(workspaceRoot, "MismatchTarget.t.sol");
    fs.writeFileSync(mismatchTargetPath, mismatchSentinel);
    assertFails(
      "destination absolute/relative path mismatch",
      buildDocument({ files: [{ ...generatedCopiedRow, destination_path: mismatchTargetPath }] }),
      "aggregation-authenticated-source-destination-reconciliation",
      /must exactly resolve from destination_relative_path/u
    );
    assert.deepEqual(fs.readFileSync(mismatchTargetPath), mismatchSentinel);
    assert.deepEqual(fs.readFileSync(generatedDestinationPath), generatedBytes);

    const escapeSentinel = Buffer.from("do not mutate escaped target\n", "utf8");
    const escapedTargetPath = path.join(temporary, "escaped-target.sol");
    fs.writeFileSync(escapedTargetPath, escapeSentinel);
    assertFails(
      "destination path escape",
      buildDocument({
        files: [
          {
            ...generatedCopiedRow,
            destination_path: escapedTargetPath,
            destination_relative_path: "../escaped-target.sol"
          }
        ]
      }),
      "aggregation-authenticated-source-destination-reconciliation",
      /must exactly resolve from destination_relative_path/u
    );
    assert.deepEqual(fs.readFileSync(escapedTargetPath), escapeSentinel);

    const symlinkTargetPath = path.join(temporary, "symlink-target.sol");
    const symlinkDestinationPath = path.join(workspaceRoot, "Symlink.t.sol");
    fs.writeFileSync(symlinkTargetPath, generatedBytes);
    fs.symlinkSync(symlinkTargetPath, symlinkDestinationPath);
    const symlinkTargetBefore = fs.readFileSync(symlinkTargetPath);
    const symlinkValueBefore = fs.readlinkSync(symlinkDestinationPath);
    assertFails(
      "symlinked destination",
      buildDocument({
        files: [
          {
            ...generatedCopiedRow,
            destination_path: symlinkDestinationPath,
            destination_relative_path: "Symlink.t.sol"
          }
        ]
      }),
      "aggregation-authenticated-source-destination-reconciliation",
      /symlink/u
    );
    assert.equal(fs.lstatSync(symlinkDestinationPath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(symlinkDestinationPath), symlinkValueBefore);
    assert.deepEqual(fs.readFileSync(symlinkTargetPath), symlinkTargetBefore);

    const hardLinkTargetPath = path.join(temporary, "hard-link-target.sol");
    const hardLinkDestinationPath = path.join(workspaceRoot, "HardLink.t.sol");
    fs.writeFileSync(hardLinkTargetPath, generatedBytes);
    fs.linkSync(hardLinkTargetPath, hardLinkDestinationPath);
    const hardLinkBytesBefore = fs.readFileSync(hardLinkTargetPath);
    const hardLinkInodeBefore = fs.lstatSync(hardLinkTargetPath).ino;
    assertFails(
      "hard-linked destination",
      buildDocument({
        files: [
          {
            ...generatedCopiedRow,
            destination_path: hardLinkDestinationPath,
            destination_relative_path: "HardLink.t.sol"
          }
        ]
      }),
      "aggregation-authenticated-source-destination-reconciliation",
      /singly linked regular file/u
    );
    assert.equal(fs.lstatSync(hardLinkTargetPath).ino, hardLinkInodeBefore);
    assert.equal(fs.lstatSync(hardLinkDestinationPath).ino, hardLinkInodeBefore);
    assert.equal(fs.lstatSync(hardLinkTargetPath).nlink, 2);
    assert.deepEqual(fs.readFileSync(hardLinkTargetPath), hardLinkBytesBefore);
    assert.deepEqual(fs.readFileSync(hardLinkDestinationPath), hardLinkBytesBefore);

    const driftDestinationPath = path.join(workspaceRoot, "Drift.t.sol");
    const driftBytes = Buffer.alloc(generatedBytes.length, "x");
    fs.writeFileSync(driftDestinationPath, driftBytes);
    assertFails(
      "destination byte drift",
      buildDocument({
        files: [
          {
            ...generatedCopiedRow,
            destination_path: driftDestinationPath,
            destination_relative_path: "Drift.t.sol"
          }
        ]
      }),
      "aggregation-authenticated-source-destination-reconciliation",
      /destination bytes differ from the authenticated source snapshot/u
    );
    assert.deepEqual(fs.readFileSync(driftDestinationPath), driftBytes);

    const driftedTrustedBundle: TrustedBundle = {
      ...copiedTrustedBundle,
      entries: [{ ...generatedEntry, bytes: driftBytes }, supportEntry]
    };
    assertFails(
      "trusted source snapshot byte drift",
      exactDocument,
      "aggregation-authenticated-source-destination-reconciliation",
      /Trusted aggregation source snapshot disagrees with declared bytes/u,
      contextFor([driftedTrustedBundle, emptyTrustedBundle])
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("every contextual registration executes real positive and negative checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-semantic-gates-"));
  try {
    fs.mkdirSync(path.join(root, "generated-tests"));
    fs.writeFileSync(path.join(root, "artifact.json"), "artifact\n");
    fs.writeFileSync(path.join(root, "generated-tests", "test.sol"), "test\n");
    fs.writeFileSync(path.join(root, "generated-tests", "helper.sol"), "helper\n");
    fs.writeFileSync(path.join(root, "generated-tests", "binary.dat"), Buffer.from([0xff]));
    fs.writeFileSync(path.join(root, "copied.sol"), "test\n");
    const digest = crypto.createHash("sha256").update("artifact\n").digest("hex");
    const contentDigest = crypto.createHash("sha256").update("snapshot", "utf8").digest("hex");
    const aggregationSourceBytes = Buffer.from("test\n", "utf8");
    const aggregationSourceDigest = crypto.createHash("sha256").update(aggregationSourceBytes).digest("hex");
    const aggregationManifestDigest = "a".repeat(64);
    const aggregationBundleSummary = {
      strategy: "strategy-a",
      node_id: "strategy-a",
      source_attempt_id: "attempt-a",
      attempt_index: 0,
      source_manifest_path: path.join(root, "source", "generated-tests.json"),
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: aggregationManifestDigest,
      source_run_id: "run-a",
      framework: "foundry",
      generated_test_count: 1,
      support_file_count: 0,
      disposition: "copied"
    };
    const aggregationCopiedRow = {
      strategy: "strategy-a",
      node_id: "strategy-a",
      source_attempt_id: "attempt-a",
      attempt_index: 0,
      source_manifest_path: path.join(root, "source", "generated-tests.json"),
      source_manifest_relative_path: "generated-tests.json",
      source_manifest_sha256: aggregationManifestDigest,
      source_artifact_path: path.join(root, "source", "generated-tests", "test.sol"),
      source_relative_path: "generated-tests/test.sol",
      destination_path: path.join(root, "copied.sol"),
      destination_relative_path: "copied.sol",
      size_bytes: aggregationSourceBytes.length,
      sha256: aggregationSourceDigest
    };
    const campaignEvidenceBytes = Buffer.from("x", "utf8");
    const campaignEvidenceDigest = crypto.createHash("sha256").update(campaignEvidenceBytes).digest("hex");
    const campaignTimeoutCommand =
      "timeout --preserve-status --signal=INT --kill-after=300s 60s recon fuzz . --workers 1 " +
      "--timeout 60 --test-limit 18446744073709551615";
    const campaignTimeoutPlan = {
      configured_fuzzer_timeout_seconds: 60,
      recon_internal_timeout_seconds: 60,
      host_soft_timeout_seconds: 60,
      host_force_kill_grace_seconds: 300,
      artifact_finalization_reserve_seconds: 100,
      finalization_reserve_seconds: 100,
      configured_budget_seconds: 460,
      recon_test_limit: "18446744073709551615",
      backend_started_at: "2026-01-01T00:00:00.000Z",
      fuzzing_deadline_utc: "2026-01-01T00:01:00.000Z",
      force_kill_deadline_utc: "2026-01-01T00:06:00.000Z",
      final_artifact_deadline_utc: "2026-01-01T00:07:40.000Z",
      deadline: "2026-01-01T00:07:40.000Z",
      backend: { exact_shell_escaped_command: campaignTimeoutCommand },
      command_plan: [{ phase: "campaign", command: campaignTimeoutCommand }]
    };
    const campaignTimeoutDocument = {
      configured_timeout_seconds: 60,
      exact_command: campaignTimeoutCommand,
      start_timestamp: "2026-01-01T00:00:00.000Z",
      end_timestamp: "2026-01-01T00:01:00.000Z",
      termination_reason: "configured-timeout",
      campaign_outcome: "complete",
      usable_results: true,
      execution: {
        command: campaignTimeoutCommand,
        usable_results: true,
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:01:00.000Z",
        deadline: "2026-01-01T00:07:40.000Z"
      }
    };
    const contextFixtures: Record<
      Exclude<SemanticGateName, keyof typeof fixtures>,
      { positive: unknown; negative: unknown; context: SemanticGateContext }
    > = {
      "agent-source-proof-commit-binding": {
        positive: { commit: "c", tree: "t", refs: [{ name: "r", object: "o" }] },
        negative: { commit: "wrong", tree: "t", refs: [{ name: "r", object: "o" }] },
        context: { git: { commit: "c", tree: "t", refs: { r: "o" } } }
      },
      "analysis-bundle-file-digest": {
        positive: { files: [{ path: "artifact.json", sha256: digest, size_bytes: 9 }] },
        negative: { files: [{ path: "artifact.json", sha256: "0".repeat(64), size_bytes: 9 }] },
        context: { filesystem: { rootDirectory: root } }
      },
      "analysis-bundle-inclusion-omission-coverage": {
        positive: {
          omissions: [
            { kind: "terminal-status" },
            { kind: "evaluation-metrics" },
            { kind: "accounting-summary" },
            { kind: "attempt-history" },
            { kind: "recovery-summary" }
          ]
        },
        negative: {
          omissions: [
            { kind: "terminal-status" },
            { kind: "evaluation-metrics" },
            { kind: "accounting-summary" },
            { kind: "attempt-history" }
          ]
        },
        context: { analysisBundle: { manifest: { files: [] } } }
      },
      "aggregation-authenticated-source-destination-reconciliation": {
        positive: {
          source_bundles: [aggregationBundleSummary],
          files: [aggregationCopiedRow],
          support_files: [],
          skipped_files: []
        },
        negative: {
          source_bundles: [aggregationBundleSummary],
          files: [{ ...aggregationCopiedRow, strategy: "fabricated-strategy" }],
          support_files: [],
          skipped_files: []
        },
        context: {
          aggregation: {
            workspaceRoot: root,
            sourceBundles: [
              {
                strategy: "strategy-a",
                nodeId: "strategy-a",
                sourceAttemptId: "attempt-a",
                attemptIndex: 0,
                sourceManifestPath: path.join(root, "source", "generated-tests.json"),
                sourceManifestRelativePath: "generated-tests.json",
                sourceManifestSha256: aggregationManifestDigest,
                sourceRunId: "run-a",
                framework: "foundry",
                entries: [
                  {
                    kind: "generated-test",
                    sourceArtifactPath: path.join(root, "source", "generated-tests", "test.sol"),
                    sourceRelativePath: "generated-tests/test.sol",
                    sizeBytes: aggregationSourceBytes.length,
                    sha256: aggregationSourceDigest,
                    bytes: aggregationSourceBytes
                  }
                ]
              }
            ]
          }
        }
      },
      "artifact-manifest-file-digest": {
        positive: { files: [{ path: "artifact.json", sha256: digest, size_bytes: 9 }] },
        negative: { files: [{ path: "missing.json", sha256: digest, size_bytes: 9 }] },
        context: { filesystem: { rootDirectory: root } }
      },
      "artifact-verification-plan-contract-identity": {
        positive: { node_id: "a", artifacts: [{ ...validPlannedOutput }] },
        negative: { node_id: "b", artifacts: [{ ...validPlannedOutput }] },
        context: { plannedGraph: { node: { id: "a", outputs: [{ ...validPlannedOutput }] } } }
      },
      "attempt-reuse-source-link": {
        positive: {
          workflow_run_id: "workflow-current",
          source_event_sequence: 4,
          reuse: { status: "reused", source: { workflow_run_id: "workflow-source", source_event_sequence: 2 } }
        },
        negative: {
          workflow_run_id: "workflow-current",
          source_event_sequence: 4,
          reuse: { status: "reused", source: { workflow_run_id: "workflow-missing", source_event_sequence: 2 } }
        },
        context: {
          attemptLedger: {
            entries: [],
            sourceEntries: [{ workflow_run_id: "workflow-source", source_event_sequence: 2 }]
          }
        }
      },
      "attempt-source-event-join": {
        positive: {
          workflow_run_id: "workflow-a",
          node_id: "project-discovery",
          strategy_attempt_id: "project-discovery__model_0__attempt_0",
          iteration: 0,
          attempt: 1,
          started_event_sequence: 1,
          source_event_sequence: 2,
          lifecycle: { started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z" },
          outcome: "succeeded"
        },
        negative: {
          workflow_run_id: "workflow-a",
          node_id: "project-discovery",
          strategy_attempt_id: "project-discovery__model_0__attempt_0",
          iteration: 0,
          attempt: 1,
          started_event_sequence: 1,
          source_event_sequence: 3,
          lifecycle: { started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:00:01.000Z" },
          outcome: "succeeded"
        },
        context: {
          eventLog: {
            events: [
              {
                workflow_run_id: "workflow-a",
                source_event_sequence: 1,
                timestamp_ms: Date.parse("2026-01-01T00:00:00.000Z"),
                type: "NodeStarted",
                payload: { nodeId: "node:project-discovery__model_0__attempt_0", iteration: 0, attempt: 1 }
              },
              {
                workflow_run_id: "workflow-a",
                source_event_sequence: 2,
                timestamp_ms: Date.parse("2026-01-01T00:00:01.000Z"),
                type: "NodeFinished",
                payload: { nodeId: "node:project-discovery__model_0__attempt_0", iteration: 0, attempt: 1 }
              }
            ]
          }
        }
      },
      "audited-differential-handoff-reconciliation": {
        positive: emptyAuditedDifferentialLanes,
        negative: { ...emptyAuditedDifferentialLanes, source_plan_artifacts: ["lookalike-plan.json"] },
        context: {
          artifactSet: {
            differentialArtifacts: {
              current: differentialAuditBinding,
              plans: [differentialPlanBinding],
              harnesses: [differentialHarnessBinding]
            }
          }
        }
      },
      "differential-gap-review-lane-reconciliation": {
        positive: noAssignedGapReview,
        negative: {
          ...noAssignedGapReview,
          ready_lanes: [
            {
              lane_id: "invented",
              attempt_index: 0,
              auditor_attempt_index: 0,
              source_auditor_artifact: differentialAuditPath
            }
          ]
        },
        context: {
          artifactSet: {
            differentialArtifacts: {
              auditedLanes: [differentialAuditBinding],
              laneResults: [differentialLaneResultBinding]
            }
          }
        }
      },
      "differential-lane-result-handoff-reconciliation": {
        positive: {
          lane_id: null,
          attempt_index: 0,
          auditor_attempt_index: 0,
          source_auditor_artifact: differentialAuditPath,
          status: "no_assigned_lane"
        },
        negative: {
          lane_id: "invented",
          attempt_index: 0,
          auditor_attempt_index: 0,
          source_auditor_artifact: differentialAuditPath,
          status: "green",
          assigned_lane_payload: {}
        },
        context: {
          artifactSet: {
            differentialArtifacts: {
              current: differentialBinding(
                "lane-result.json",
                "ultrafuzz/differential-lane-result@1",
                "differential-lane-author",
                {}
              ),
              auditedLanes: [differentialAuditBinding]
            }
          }
        }
      },
      "differential-red-triage-registry-reconciliation": {
        positive: emptyTriageA,
        negative: { ...emptyTriageA, pass: "b" },
        context: {
          artifactSet: {
            differentialArtifacts: {
              current: differentialTriageABinding,
              registries: [differentialRegistryBinding]
            }
          }
        }
      },
      "differential-repair-summary-triage-reconciliation": {
        positive: emptyRepairSummary,
        negative: {
          ...emptyRepairSummary,
          repairs_attempted: [
            { stable_failure_hash: "a".repeat(64), repair_kind: "harness", summary: "Invented repair." }
          ]
        },
        context: {
          artifactSet: {
            differentialArtifacts: {
              registries: [differentialRegistryBinding],
              triages: [differentialTriageABinding, differentialTriageBBinding]
            }
          }
        }
      },
      "differential-report-review-reconciliation": {
        positive: {
          campaign_status: "complete",
          production_bug_reds: [],
          harness_or_reference_repairs: [],
          missing_or_deferred_lanes: [],
          report_rows_ready: []
        },
        negative: {
          campaign_status: "incomplete",
          production_bug_reds: [],
          harness_or_reference_repairs: [],
          missing_or_deferred_lanes: [],
          report_rows_ready: []
        },
        context: {
          artifactSet: {
            differentialArtifacts: {
              registries: [differentialRegistryBinding],
              triages: [differentialTriageABinding, differentialTriageBBinding],
              repairSummaries: [
                differentialBinding(
                  "repair-summary.json",
                  "ultrafuzz/differential-repair-summary@1",
                  "differential-repair-and-report-review",
                  emptyRepairSummary
                )
              ],
              gapReviews: [
                differentialBinding(
                  "gap-review.json",
                  "ultrafuzz/differential-gap-review@1",
                  "differential-repair-and-report-review",
                  emptyGapReview
                )
              ],
              findings: [
                differentialBinding(
                  "findings.json",
                  "ultrafuzz/findings@2",
                  "differential-repair-and-report-review",
                  []
                )
              ]
            }
          }
        }
      },
      "reference-harness-plan-reconciliation": {
        positive: emptyReferenceHarness,
        negative: { ...emptyReferenceHarness, source_plan_artifacts: ["lookalike-plan.json"] },
        context: {
          artifactSet: {
            differentialArtifacts: {
              current: differentialHarnessBinding,
              plans: [differentialPlanBinding]
            }
          }
        }
      },
      "semantic-red-registry-lane-reconciliation": {
        positive: emptySemanticRedRegistry,
        negative: {
          semantic_reds: [
            {
              stable_failure_hash: "a".repeat(64),
              lane_id: "invented"
            }
          ],
          compile_or_harness_defects: []
        },
        context: {
          artifactSet: { differentialArtifacts: { laneResults: [differentialLaneResultBinding] } }
        }
      },
      "campaign-summary-count-coupling": {
        positive: { failure_counts: { pre_deduplication: 1, post_deduplication: 1 } },
        negative: { failure_counts: { pre_deduplication: 2, post_deduplication: 1 } },
        context: { artifactSet: { campaigns: [{ failures: [{}] }], findings: [{}] } }
      },
      "property-campaign-timeout-evidence": {
        positive: campaignTimeoutDocument,
        negative: { ...campaignTimeoutDocument, configured_timeout_seconds: 59 },
        context: {
          artifactSet: {
            campaignPlan: campaignTimeoutPlan,
            campaignSummary: { outcome: "complete" }
          },
          propertyCampaignTimeout: {
            configuredFuzzerTimeoutSeconds: 60,
            plannedTimeoutSeconds: 600,
            finalizationReserveSeconds: 100
          }
        }
      },
      "property-campaign-context-joins": {
        positive: {
          campaign_plan_ref: "campaign-plan.json",
          implemented_properties_ref: "implemented-properties.json",
          findings_ref: "findings.json",
          campaign_summary_ref: "campaign-summary.json",
          fuzzer_backend: "recon",
          backend_version: null,
          execution: {
            status: "complete",
            usable_results: true,
            command: "recon fuzz .",
            workers: 1,
            deadline: "2026-01-01T00:01:00Z"
          },
          paths: {},
          property_results: [],
          failures: []
        },
        negative: {
          campaign_plan_ref: "campaign-plan.json",
          implemented_properties_ref: "implemented-properties.json",
          findings_ref: "findings.json",
          campaign_summary_ref: "campaign-summary.json",
          fuzzer_backend: "medusa",
          backend_version: null,
          execution: {
            status: "complete",
            usable_results: true,
            command: "recon fuzz .",
            workers: 1,
            deadline: "2026-01-01T00:01:00Z"
          },
          paths: {},
          property_results: [],
          failures: []
        },
        context: {
          artifactIdentity: {
            runId: "run",
            nodeId: "stateful-invariant-campaign",
            artifactPath: "recon-fuzzer-results.json"
          },
          artifactSet: {
            campaignPlanPath: "campaign-plan.json",
            campaignPlan: {
              backend: { name: "recon", version: null },
              workers: 1,
              deadline: "2026-01-01T00:01:00Z",
              command_plan: [{ phase: "campaign", command: "recon fuzz ." }],
              paths: {}
            },
            implementedPropertiesPath: "implemented-properties.json",
            implementedProperties: { properties: [] },
            findingsPath: "findings.json",
            findings: [],
            campaignSummaryPath: "campaign-summary.json",
            campaignSummary: {
              outcome: "complete",
              campaign_plan_ref: "campaign-plan.json",
              implemented_property_suite_refs: ["implemented-properties.json"],
              backend_results: [
                {
                  fuzzer_backend: "recon",
                  status: "complete",
                  result_ref: "recon-fuzzer-results.json"
                }
              ],
              finding_refs: [],
              reproducer_refs: []
            }
          }
        }
      },
      "property-campaign-evidence-integrity": {
        positive: {
          evidence_files: [{ path: "backends/recon/results.json", size_bytes: 1, sha256: campaignEvidenceDigest }]
        },
        negative: {
          evidence_files: [{ path: "backends/recon/results.json", size_bytes: 1, sha256: "0".repeat(64) }]
        },
        context: {
          propertyCampaignEvidence: {
            snapshots: [
              {
                path: "backends/recon/results.json",
                exists: true,
                regularFile: true,
                symbolicLink: false,
                linkCount: 1,
                stableIdentity: true,
                device: "1",
                inode: "2",
                bytes: campaignEvidenceBytes
              }
            ]
          }
        }
      },
      "property-campaign-publication-authority": {
        positive: {
          evidence_files: [{ path: "backends/recon/results.json", size_bytes: 1, sha256: campaignEvidenceDigest }]
        },
        negative: {
          evidence_files: [{ path: "backends/recon/results.json", size_bytes: 1, sha256: "0".repeat(64) }]
        },
        context: {
          artifactIdentity: {
            runId: "run",
            nodeId: "stateful-invariant-campaign",
            attemptId: "campaign-attempt"
          },
          propertyCampaignEvidence: {
            snapshots: [],
            publicationAuthority: {
              markerAttemptId: "campaign-attempt",
              markerNodeId: "stateful-invariant-campaign",
              publications: [{ path: "backends/recon/results.json", sha256: campaignEvidenceDigest }]
            }
          }
        }
      },
      "dynamic-strategy-artifact-reconciliation": {
        positive: { strategies: [selectedDynamicStrategyFixture] },
        negative: { strategies: [{ ...selectedDynamicStrategyFixture, title: "Rewritten title" }] },
        context: dynamicStrategyArtifactContext
      },
      "generated-test-current-identity": {
        positive: { run_id: "run-current", node_id: "strategy-current" },
        negative: { run_id: "run-foreign", node_id: "strategy-foreign" },
        context: { artifactIdentity: { runId: "run-current", nodeId: "strategy-current" } }
      },
      "generated-test-file-integrity": {
        positive: {
          generated_tests: [{ path: "generated-tests/test.sol" }],
          support_files: [{ path: "generated-tests/helper.sol", size_bytes: 7 }]
        },
        negative: {
          generated_tests: [{ path: "generated-tests/test.sol" }],
          support_files: [{ path: "generated-tests/binary.dat" }]
        },
        context: { filesystem: { rootDirectory: root } }
      },
      "implemented-property-selection-join": {
        positive: { selection: { property_ids: ["a"] }, properties: [{ property_id: "a" }] },
        negative: { selection: { property_ids: ["missing"] }, properties: [{ property_id: "missing" }] },
        context: { artifactSet: { propertyCatalog: { properties: [{ id: "a" }] } } }
      },
      "invariant-source-proof-git-binding": {
        positive: { commit: "c", tree: "t", files: [{ content: "snapshot", sha256: contentDigest }] },
        negative: { commit: "wrong", tree: "t", files: [{ content: "snapshot", sha256: contentDigest }] },
        context: { git: { commit: "c", tree: "t" } }
      },
      "finding-lifecycle-review-stage-reconciliation": {
        positive: {
          records: [
            {
              dedupe_key: "root-a",
              source_artifacts: [{ path: "raw/findings.json", finding_id: "raw-a" }],
              stages: [
                { stage: "raw", artifact_path: "raw/findings.json", finding_id: "raw-a" },
                { stage: "deduped", artifact_path: "/artifacts/deduped-findings.json", finding_id: "finding-a" }
              ]
            }
          ]
        },
        negative: {
          records: [
            {
              dedupe_key: "root-a",
              source_artifacts: [{ path: "raw/findings.json", finding_id: "raw-a" }],
              stages: [
                { stage: "raw", artifact_path: "raw/findings.json", finding_id: "raw-a" },
                { stage: "deduped", artifact_path: "/artifacts/rewritten.json", finding_id: "finding-a" }
              ]
            }
          ]
        },
        context: {
          artifactSet: {
            reviewStage: {
              stage: "dedupe",
              findingsArtifactPath: "/artifacts/deduped-findings.json",
              findings: [{ id: "finding-a", dedupe_key: "root-a" }]
            }
          }
        }
      },
      "json-validator-preflight-current-identity": {
        positive: {
          data: {
            schema: {
              id: "schema-id",
              sha256: "a".repeat(64),
              bundle_sha256: "b".repeat(64),
              validator_build: "validator-build"
            },
            artifact_sha256: "c".repeat(64)
          }
        },
        negative: {
          data: {
            schema: {
              id: "wrong-schema-id",
              sha256: "a".repeat(64),
              bundle_sha256: "b".repeat(64),
              validator_build: "validator-build"
            },
            artifact_sha256: "c".repeat(64)
          }
        },
        context: {
          validatorPreflight: {
            schemaId: "schema-id",
            schemaSha256: "a".repeat(64),
            schemaBundleSha256: "b".repeat(64),
            validatorBuild: "validator-build",
            artifactSha256: "c".repeat(64)
          }
        }
      },
      "property-source-join": {
        positive: { properties: [{ sources: [{ source_node_id: "lens", source_property_id: "a" }] }] },
        negative: { properties: [{ sources: [{ source_node_id: "lens", source_property_id: "missing" }] }] },
        context: {
          artifactSet: {
            propertyLenses: [
              { sourceNodeId: "lens", projectionRequired: true, document: { properties: [{ id: "a" }] } }
            ]
          }
        }
      },
      "report-property-provenance-join": {
        positive: {
          issues: [{ id: "finding" }],
          property_provenance: [
            {
              finding_id: "finding",
              property_ids: ["a"],
              sources: [{ source_node_id: "lens", source_property_id: "source" }],
              implementation_paths: ["impl"],
              test_paths: ["test"]
            }
          ]
        },
        negative: {
          issues: [{ id: "finding" }],
          property_provenance: [
            {
              finding_id: "finding",
              property_ids: ["missing"],
              sources: [],
              implementation_paths: [],
              test_paths: []
            }
          ]
        },
        context: {
          artifactSet: {
            propertyCatalog: {
              properties: [{ id: "a", sources: [{ source_node_id: "lens", source_property_id: "source" }] }]
            },
            implementedProperties: {
              properties: [{ property_id: "a", implementation_paths: ["impl"], test_paths: ["test"] }]
            }
          }
        }
      },
      "report-campaign-outcome-authority": {
        positive: {
          campaign_outcome: { outcome: "blocked", reason: "recon was unavailable" }
        },
        negative: {
          campaign_outcome: { outcome: "complete", reason: "recon was unavailable" }
        },
        context: {
          artifactSet: {
            campaignSummary: { outcome: "blocked", reason: "recon was unavailable" }
          }
        }
      },
      "report-severity-classification-preservation": {
        positive: {
          issues: [
            {
              id: "H-01",
              title: "[H-01] - High title",
              severity: "High",
              dedupe_key: "root-b",
              lifecycle: {
                dedupe_key: "root-b",
                final_disposition: "promoted"
              }
            },
            {
              id: "L-01",
              title: "[L-01] - Low title",
              severity: "Low",
              dedupe_key: "root-a",
              lifecycle: {
                dedupe_key: "root-a",
                final_disposition: "promoted"
              }
            }
          ],
          non_production_outcomes: []
        },
        negative: {
          issues: [
            {
              id: "L-01",
              title: "[L-01] - Low title",
              severity: "Low",
              dedupe_key: "root-a",
              lifecycle: {
                dedupe_key: "root-a",
                final_disposition: "promoted"
              }
            },
            {
              id: "H-01",
              title: "[H-01] - High title",
              severity: "High",
              dedupe_key: "root-b",
              lifecycle: {
                dedupe_key: "root-b",
                final_disposition: "promoted"
              }
            }
          ],
          non_production_outcomes: []
        },
        context: {
          artifactSet: {
            severityClassifiedFindings: [
              { id: "finding-a", title: "Low title", severity: "Low", dedupe_key: "root-a" },
              { id: "finding-b", title: "High title", severity: "High", dedupe_key: "root-b" }
            ],
            findingLifecycleLedger: {
              records: [
                { dedupe_key: "root-a", final_disposition: "promoted" },
                { dedupe_key: "root-b", final_disposition: "promoted" }
              ]
            }
          }
        }
      },
      "severity-classification-upstream-preservation": {
        positive: [
          {
            id: "finding-a",
            summary: "Preserved summary",
            severity_guess: "Medium",
            severity: "Low",
            impact: "Medium",
            likelihood: "Low",
            impact_rationale: "Bounded impact.",
            likelihood_rationale: "Narrow state.",
            severity_rationale: "Medium x Low is Low."
          }
        ],
        negative: [
          {
            id: "finding-a",
            summary: "Rewritten summary",
            severity_guess: "Medium",
            severity: "Low",
            impact: "Medium",
            likelihood: "Low",
            impact_rationale: "Bounded impact.",
            likelihood_rationale: "Narrow state.",
            severity_rationale: "Medium x Low is Low."
          }
        ],
        context: {
          artifactSet: {
            triagedFindings: [{ id: "finding-a", summary: "Preserved summary", severity_guess: "Medium" }]
          }
        }
      },
      "strategy-detection-review-stage-reconciliation": {
        positive: [
          {
            dedupe_key: "root-a",
            finding_id: "finding-a",
            title: "Finding A",
            hits: [{ strategy: "boundary" }]
          }
        ],
        negative: [
          {
            dedupe_key: "root-a",
            finding_id: "finding-a",
            title: "Finding A",
            hits: [{ strategy: "rewritten" }]
          }
        ],
        context: {
          artifactSet: {
            reviewStage: {
              stage: "dedupe",
              findingsArtifactPath: "/artifacts/deduped-findings.json",
              findings: [{ id: "finding-a", dedupe_key: "root-a", title: "Finding A" }],
              lifecycleLedger: {
                records: [{ dedupe_key: "root-a", strategy_hits: [{ strategy: "boundary" }] }]
              }
            }
          }
        }
      },
      "triaged-finding-upstream-preservation": {
        positive: [
          {
            id: "finding-a",
            summary: "Preserved summary",
            status: "confirmed",
            notes: ["source=evidence", "triage_reason=reachable production path"],
            triage_classification: "true-positive"
          }
        ],
        negative: [
          {
            id: "finding-a",
            summary: "Rewritten summary",
            status: "confirmed",
            notes: ["triage_reason=reachable production path"],
            triage_classification: "true-positive"
          }
        ],
        context: {
          artifactSet: {
            dedupedFindings: [
              { id: "finding-a", summary: "Preserved summary", status: "confirmed", notes: ["source=evidence"] }
            ]
          }
        }
      },
      "run-state-fingerprint": {
        positive: { graph_fingerprint: "g", config_fingerprint: "c" },
        negative: { graph_fingerprint: "wrong", config_fingerprint: "c" },
        context: { runtimeState: { graphFingerprint: "g", configFingerprint: "c" } }
      },
      "smithers-task-planned-graph-coverage": {
        positive: {
          tasks: [{ attemptId: "node-a", concreteNodeId: "node-a" }]
        },
        negative: { tasks: [] },
        context: {
          plannedGraph: {
            document: {
              nodes: [
                {
                  ...validPlannedNode,
                  logical_id: "logical-a",
                  display_name: "Node A",
                  kind: "agentic"
                }
              ]
            }
          }
        }
      },
      "smithers-task-planned-graph-identity": {
        positive: {
          tasks: [
            {
              attemptId: "node-a",
              concreteNodeId: "node-a",
              logicalNodeId: "logical-a",
              metadata: {
                node: { logicalNodeId: "logical-a", label: "Node A" },
                loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
                artifacts: { outputs: [smithersManifestOutput] }
              }
            }
          ]
        },
        negative: {
          tasks: [
            {
              attemptId: "node-a",
              concreteNodeId: "node-a",
              logicalNodeId: "wrong",
              metadata: {
                node: { logicalNodeId: "wrong", label: "Node A" },
                loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
                artifacts: { outputs: [smithersManifestOutput] }
              }
            }
          ]
        },
        context: {
          plannedGraph: {
            document: {
              nodes: [
                {
                  ...validPlannedNode,
                  logical_id: "logical-a",
                  display_name: "Node A",
                  kind: "agentic",
                  loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 }
                }
              ]
            }
          }
        }
      },
      "smithers-task-planned-graph-dependency-join": {
        positive: {
          tasks: [
            {
              concreteNodeId: "node-a",
              dependencies: ["node-b"],
              dependencySmithersNodeIds: ["verify:node-b"],
              metadata: { dependencies: { concreteNodeIds: ["node-b"] } }
            }
          ]
        },
        negative: {
          tasks: [
            {
              concreteNodeId: "node-a",
              dependencies: [],
              dependencySmithersNodeIds: [],
              metadata: { dependencies: { concreteNodeIds: [] } }
            }
          ]
        },
        context: {
          plannedGraph: {
            document: {
              nodes: [
                { ...validPlannedNode, id: "node-a", depends_on: ["node-b"], kind: "agentic" },
                { ...validPlannedNode, id: "node-b", depends_on: [], kind: "agentic" }
              ]
            }
          }
        }
      },
      "usage-ledger-event-order": {
        positive: { workflow_run_id: "workflow-a", source_event_sequence: 2, control_generation: "a".repeat(64) },
        negative: { workflow_run_id: "workflow-a", source_event_sequence: 0, control_generation: "a".repeat(64) },
        context: {
          usageLedger: {
            entries: [{ workflow_run_id: "workflow-a", source_event_sequence: 1, control_generation: "a".repeat(64) }]
          }
        }
      },
      "usage-ledger-source-event-join": {
        positive: {
          workflow_run_id: "workflow-a",
          source_event_sequence: 2,
          observed_timestamp_ms: 2,
          node_id: "node:a",
          iteration: 0,
          attempt: 1,
          usage: { model: "model", agent: "agent", input_tokens: 1, output_tokens: 2 }
        },
        negative: { workflow_run_id: "workflow-a", source_event_sequence: 3 },
        context: {
          eventLog: {
            events: [
              {
                workflow_run_id: "workflow-a",
                source_event_sequence: 2,
                timestamp_ms: 2,
                type: "TokenUsageReported",
                payload: {
                  nodeId: "node:a",
                  iteration: 0,
                  attempt: 1,
                  model: "model",
                  agent: "agent",
                  inputTokens: 1,
                  outputTokens: 2
                }
              }
            ]
          }
        }
      },
      "workspace-patch-git-binding": {
        positive: { base_commit: "bc", base_tree: "bt", result_tree: "rt", patch_sha256: "p" },
        negative: { base_commit: "wrong", base_tree: "bt", result_tree: "rt", patch_sha256: "p" },
        context: {
          git: {
            commit: "unused",
            tree: "unused",
            baseCommit: "bc",
            baseTree: "bt",
            resultTree: "rt",
            patchSha256: "p"
          }
        }
      }
    };

    const contextualNames = Object.values(SEMANTIC_GATE_REGISTRY)
      .filter((registration) => registration.scope !== "document")
      .map((registration) => registration.name);
    assert.deepEqual(Object.keys(contextFixtures).sort(), contextualNames.sort());
    for (const name of contextualNames) {
      const fixture = contextFixtures[name as keyof typeof contextFixtures];
      assert.equal(
        executeSemanticGate(name, { document: fixture.positive, context: fixture.context }).status,
        "passed",
        `${name}:positive`
      );
      assert.equal(
        executeSemanticGate(name, { document: fixture.negative, context: fixture.context }).status,
        "failed",
        `${name}:negative`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic gate diagnostics are deterministically capped", () => {
  const document = Array.from({ length: MAX_SEMANTIC_GATE_ISSUES + 2 }, () => ({ id: "duplicate" }));
  const result = executeSemanticGate("findings-id-uniqueness", { document });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" ? result.issues.length : 0, MAX_SEMANTIC_GATE_ISSUES);
  assert.match(result.status === "failed" ? (result.issues.at(-1)?.message ?? "") : "", /issue limit reached/u);
  assert.equal(result.status === "failed" ? result.issues[0]?.path : undefined, "$[1]");

  const astralId = "🙂".repeat(200);
  const byteHeavy = executeSemanticGate("findings-id-uniqueness", {
    document: Array.from({ length: 100 }, () => ({ id: astralId }))
  });
  assert.equal(byteHeavy.status, "failed");
  assert.ok(byteHeavy.status === "failed" && byteHeavy.issues.length < 99);
  assert.ok(
    byteHeavy.status === "failed" &&
      Buffer.byteLength(JSON.stringify(byteHeavy.issues), "utf8") <= MAX_SEMANTIC_GATE_DIAGNOSTIC_BYTES
  );
  assert.match(
    byteHeavy.status === "failed" ? (byteHeavy.issues.at(-1)?.message ?? "") : "",
    /UTF-8 diagnostic-byte bounds/u
  );
});

test("differential repair reconciliation forbids semantic-red registry regeneration", () => {
  const result = executeSemanticGate("differential-repair-summary-triage-reconciliation", {
    document: { ...emptyRepairSummary, semantic_red_registry_regenerated: true },
    context: {
      artifactSet: {
        differentialArtifacts: {
          registries: [differentialRegistryBinding],
          triages: [differentialTriageABinding, differentialTriageBBinding]
        }
      }
    }
  });

  assert.equal(result.status, "failed");
  assert.ok(
    result.status === "failed" && result.issues.some((entry) => entry.path === "$.semantic_red_registry_regenerated")
  );
});

test("differential lane selection uses exact current coordinates across every declared auditor artifact", () => {
  const planPath = "artifacts/planner-0/differential-plan.json";
  const harnessPath = "artifacts/harness-0/reference-harness.json";
  const assignedAuditPath = "artifacts/auditor-assigned/audited-differential-lanes.json";
  const emptyAuditPath = "artifacts/auditor-empty/audited-differential-lanes.json";
  const plannedLane = {
    lane_id: "lane-a",
    planner_attempt_index: 0,
    surface_id: "surface-a",
    intended_t_sol_path: "test/foundry/differential/LaneA.t.sol",
    focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
    public_evidence_paths: ["docs/spec.md"],
    observable_equality_assertions: ["returns match"],
    oracle_type: "independent_reference",
    calibration_bucket: "red_seeking_adversarial",
    red_seeking_priority: "high"
  };
  const readyLane = {
    lane_id: plannedLane.lane_id,
    attempt_index: 0,
    auditor_attempt_index: 0,
    planner_attempt_index: plannedLane.planner_attempt_index,
    harness_author_attempt_index: 0,
    source_plan_artifact: planPath,
    source_harness_artifact: harnessPath,
    surface_id: plannedLane.surface_id,
    intended_t_sol_path: plannedLane.intended_t_sol_path,
    focused_command: plannedLane.focused_command,
    public_evidence_paths: plannedLane.public_evidence_paths,
    exact_observable_equality_assertions: plannedLane.observable_equality_assertions,
    oracle_type: plannedLane.oracle_type,
    calibration_bucket: plannedLane.calibration_bucket,
    red_seeking_priority: plannedLane.red_seeking_priority
  };
  const plan = {
    planner_attempt_index: 0,
    candidate_surfaces: [{ surface_id: "surface-a", public_evidence_paths: ["docs/spec.md"] }],
    assigned_differential_lanes: [plannedLane]
  };
  const harness = {
    harness_author_attempt_index: 0,
    source_plan_artifacts: [planPath],
    reference_models: [{ covered_surfaces: ["surface-a"] }],
    validation: { passed: true }
  };
  const assignedAudit = {
    auditor_attempt_index: 0,
    source_plan_artifacts: [planPath],
    source_harness_artifacts: [harnessPath],
    surface_audits: [{ surface_id: "surface-a", public_evidence_paths: ["docs/spec.md"] }],
    ready_lanes: [readyLane],
    rejected_or_narrowed_lanes: []
  };
  const planBinding = differentialBinding(
    planPath,
    "ultrafuzz/differential-plan@1",
    "differential-oracle-planner",
    plan,
    "planner-0"
  );
  const harnessBinding = differentialBinding(
    harnessPath,
    "ultrafuzz/reference-harness@1",
    "reference-harness-author",
    harness,
    "harness-0"
  );
  const assignedAuditBinding = differentialBinding(
    assignedAuditPath,
    "ultrafuzz/audited-differential-lanes@1",
    "reference-and-lane-auditor",
    assignedAudit,
    "auditor-assigned"
  );
  const currentAudit = differentialBinding(
    assignedAuditPath,
    "ultrafuzz/audited-differential-lanes@1",
    "reference-and-lane-auditor",
    {},
    "auditor-assigned"
  );

  assert.equal(
    executeSemanticGate("audited-differential-handoff-reconciliation", {
      document: assignedAudit,
      context: {
        artifactSet: {
          differentialArtifacts: {
            current: currentAudit,
            plans: [planBinding],
            harnesses: [harnessBinding]
          }
        }
      }
    }).status,
    "passed"
  );
  const uncoveredHarness = differentialBinding(
    harnessPath,
    "ultrafuzz/reference-harness@1",
    "reference-harness-author",
    { ...harness, reference_models: [{ covered_surfaces: ["surface-other"] }] },
    "harness-0"
  );
  const uncoveredHarnessResult = executeSemanticGate("audited-differential-handoff-reconciliation", {
    document: assignedAudit,
    context: {
      artifactSet: {
        differentialArtifacts: { current: currentAudit, plans: [planBinding], harnesses: [uncoveredHarness] }
      }
    }
  });
  assert.equal(uncoveredHarnessResult.status, "failed");
  assert.ok(
    uncoveredHarnessResult.status === "failed" &&
      uncoveredHarnessResult.issues.some((entry) => /no declared reference model covering/u.test(entry.message))
  );
  const wrongReadyAttempt = executeSemanticGate("audited-differential-handoff-reconciliation", {
    document: { ...assignedAudit, ready_lanes: [{ ...readyLane, attempt_index: 1 }] },
    context: {
      artifactSet: {
        differentialArtifacts: { current: currentAudit, plans: [planBinding], harnesses: [harnessBinding] }
      }
    }
  });
  assert.equal(wrongReadyAttempt.status, "failed");
  assert.ok(
    wrongReadyAttempt.status === "failed" &&
      wrongReadyAttempt.issues.some((entry) => entry.path === "$.ready_lanes[0].attempt_index")
  );

  const emptyAuditBinding = differentialBinding(
    emptyAuditPath,
    "ultrafuzz/audited-differential-lanes@1",
    "reference-and-lane-auditor",
    { ...assignedAudit, ready_lanes: [], rejected_or_narrowed_lanes: [{ lane_id: "lane-a" }] },
    "auditor-empty"
  );
  const currentLane = differentialBinding(
    "artifacts/lane-0/lane-result.json",
    "ultrafuzz/differential-lane-result@1",
    "differential-lane-author",
    {},
    "lane-0"
  );
  const falseNoAssignment = executeSemanticGate("differential-lane-result-handoff-reconciliation", {
    document: {
      lane_id: null,
      attempt_index: 0,
      auditor_attempt_index: 0,
      source_auditor_artifact: emptyAuditPath,
      status: "no_assigned_lane"
    },
    context: {
      artifactSet: {
        differentialArtifacts: {
          current: currentLane,
          auditedLanes: [emptyAuditBinding, assignedAuditBinding]
        }
      }
    }
  });
  assert.equal(falseNoAssignment.status, "failed");
  assert.ok(
    falseNoAssignment.status === "failed" && falseNoAssignment.issues.some((entry) => entry.path === "$.status")
  );

  const wrongAuditorAttempt = executeSemanticGate("differential-lane-result-handoff-reconciliation", {
    document: {
      lane_id: null,
      attempt_index: 0,
      auditor_attempt_index: 1,
      source_auditor_artifact: emptyAuditPath,
      status: "no_assigned_lane"
    },
    context: {
      artifactSet: {
        differentialArtifacts: { current: currentLane, auditedLanes: [emptyAuditBinding] }
      }
    }
  });
  assert.equal(wrongAuditorAttempt.status, "failed");
  assert.ok(
    wrongAuditorAttempt.status === "failed" &&
      wrongAuditorAttempt.issues.some((entry) => entry.path === "$.auditor_attempt_index")
  );
});

test("audited differential dispositions preserve stable candidate order", () => {
  const planPath = "artifacts/planner-0/differential-plan.json";
  const harnessPath = "artifacts/harness-0/reference-harness.json";
  const auditPath = "artifacts/auditor-0/audited-differential-lanes.json";
  const plannedLane = (laneId: string, surfaceId: string) => ({
    lane_id: laneId,
    planner_attempt_index: 0,
    surface_id: surfaceId,
    intended_t_sol_path: `test/foundry/differential/${laneId}.t.sol`,
    focused_command: `forge test --match-path test/foundry/differential/${laneId}.t.sol`,
    public_evidence_paths: [`docs/${surfaceId}.md`],
    observable_equality_assertions: ["returns match"],
    oracle_type: "independent_reference",
    calibration_bucket: "red_seeking_adversarial",
    red_seeking_priority: "high"
  });
  const plan = {
    planner_attempt_index: 0,
    candidate_surfaces: [
      { surface_id: "surface-a", public_evidence_paths: ["docs/surface-a.md"] },
      { surface_id: "surface-b", public_evidence_paths: ["docs/surface-b.md"] }
    ],
    assigned_differential_lanes: [plannedLane("lane-a", "surface-a"), plannedLane("lane-b", "surface-b")]
  };
  const orderedAudit = {
    auditor_attempt_index: 0,
    source_plan_artifacts: [planPath],
    source_harness_artifacts: [harnessPath],
    surface_audits: [
      { surface_id: "surface-a", public_evidence_paths: ["docs/surface-a.md"] },
      { surface_id: "surface-b", public_evidence_paths: ["docs/surface-b.md"] }
    ],
    ready_lanes: [],
    rejected_or_narrowed_lanes: [
      { lane_id: "lane-a", disposition: "rejected", reason: "Not assigned to this attempt." },
      { lane_id: "lane-b", disposition: "rejected", reason: "Not assigned to this attempt." }
    ]
  };
  const context: SemanticGateContext = {
    artifactSet: {
      differentialArtifacts: {
        current: differentialBinding(
          auditPath,
          "ultrafuzz/audited-differential-lanes@1",
          "reference-and-lane-auditor",
          {},
          "auditor-0"
        ),
        plans: [
          differentialBinding(
            planPath,
            "ultrafuzz/differential-plan@1",
            "differential-oracle-planner",
            plan,
            "planner-0"
          )
        ],
        harnesses: [
          differentialBinding(
            harnessPath,
            "ultrafuzz/reference-harness@1",
            "reference-harness-author",
            { harness_author_attempt_index: 0 },
            "harness-0"
          )
        ]
      }
    }
  };

  assert.equal(
    executeSemanticGate("audited-differential-handoff-reconciliation", { document: orderedAudit, context }).status,
    "passed"
  );
  const reordered = executeSemanticGate("audited-differential-handoff-reconciliation", {
    document: { ...orderedAudit, rejected_or_narrowed_lanes: [...orderedAudit.rejected_or_narrowed_lanes].reverse() },
    context
  });
  assert.equal(reordered.status, "failed");
  assert.ok(
    reordered.status === "failed" && reordered.issues.some((entry) => entry.path === "$.rejected_or_narrowed_lanes")
  );
});

test("non-empty differential registries preserve complete ordered packets and canonical hashes", () => {
  const hashJson = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  const laneId = "lane-a";
  const preRepairFileHash = "c".repeat(64);
  const redPacket = (redCandidateId: string, observed: string) => {
    const packet = {
      red_candidate_id: redCandidateId,
      test_path: "test/foundry/differential/LaneA.t.sol",
      failing_test_name: `test_${redCandidateId}`,
      focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
      failure_signature: `${redCandidateId} mismatch`,
      assertion: "actual == expected",
      observed,
      expected: "2",
      public_oracle_basis: ["docs/spec.md"],
      classification: "untriaged"
    };
    return {
      stable_failure_hash: hashJson([
        "semantic-red-v1",
        laneId,
        packet.red_candidate_id,
        packet.test_path,
        packet.failing_test_name,
        packet.focused_command,
        packet.failure_signature,
        packet.assertion,
        packet.observed,
        packet.expected,
        packet.public_oracle_basis,
        preRepairFileHash
      ]),
      ...packet
    };
  };
  const redA = redPacket("red-a", "0");
  const redB = redPacket("red-b", "1");
  const defectLaneId = "lane-b";
  const defect = {
    category: "compile",
    summary: "Compiler rejected the generated harness.",
    evidence_paths: ["test/foundry/differential/LaneB.t.sol"]
  };
  const defectRow = {
    stable_failure_hash: hashJson([
      "compile-harness-defect-v1",
      defectLaneId,
      defect.category,
      defect.summary,
      defect.evidence_paths
    ]),
    ...defect
  };
  const redResult = {
    lane_id: laneId,
    red_preservation_audit: { pre_repair_file_hash: preRepairFileHash },
    red_candidates: [redA, redB],
    compile_or_harness_defects: []
  };
  const defectResult = {
    lane_id: defectLaneId,
    red_preservation_audit: { pre_repair_file_hash: null },
    red_candidates: [],
    compile_or_harness_defects: [defectRow]
  };
  const registryRed = (row: typeof redA) => ({
    stable_failure_hash: row.stable_failure_hash,
    lane_id: laneId,
    red_candidate_id: row.red_candidate_id,
    test_path: row.test_path,
    failing_test_name: row.failing_test_name,
    focused_command: row.focused_command,
    failure_signature: row.failure_signature,
    assertion: row.assertion,
    observed: row.observed,
    expected: row.expected,
    public_oracle_basis: row.public_oracle_basis,
    classification: row.classification,
    pre_repair_file_hash: preRepairFileHash
  });
  const registry = {
    semantic_reds: [registryRed(redA), registryRed(redB)],
    compile_or_harness_defects: [
      { stable_failure_hash: defectRow.stable_failure_hash, lane_id: defectLaneId, ...defect }
    ]
  };
  const laneBindings = [
    differentialBinding(
      "artifacts/lane-a/lane-result.json",
      "ultrafuzz/differential-lane-result@1",
      "differential-lane-author",
      redResult,
      "lane-a"
    ),
    differentialBinding(
      "artifacts/lane-b/lane-result.json",
      "ultrafuzz/differential-lane-result@1",
      "differential-lane-author",
      defectResult,
      "lane-b"
    )
  ];
  const context: SemanticGateContext = {
    artifactSet: { differentialArtifacts: { laneResults: laneBindings } }
  };

  assert.equal(
    executeSemanticGate("semantic-red-registry-lane-reconciliation", { document: registry, context }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("semantic-red-registry-lane-reconciliation", {
      document: { ...registry, semantic_reds: [...registry.semantic_reds].reverse() },
      context
    }).status,
    "failed"
  );
  assert.equal(
    executeSemanticGate("semantic-red-registry-lane-reconciliation", {
      document: {
        ...registry,
        compile_or_harness_defects: [{ ...registry.compile_or_harness_defects[0], stable_failure_hash: "0".repeat(64) }]
      },
      context
    }).status,
    "failed"
  );

  assert.equal(
    executeSemanticGate("differential-result-failure-hash-uniqueness", { document: redResult }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("differential-result-failure-hash-uniqueness", { document: defectResult }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("differential-result-failure-hash-uniqueness", {
      document: {
        ...redResult,
        red_candidates: [{ ...redA, failure_signature: "rewritten mismatch" }, redB]
      }
    }).status,
    "failed"
  );
  assert.equal(
    executeSemanticGate("differential-result-failure-hash-uniqueness", {
      document: {
        ...defectResult,
        compile_or_harness_defects: [{ ...defectRow, summary: "Rewritten compiler summary." }]
      }
    }).status,
    "failed"
  );
  assert.equal(
    executeSemanticGate("differential-result-failure-hash-uniqueness", {
      document: {
        ...defectResult,
        compile_or_harness_defects: [{ ...defectRow, evidence_paths: [...defectRow.evidence_paths, "stderr.log"] }]
      }
    }).status,
    "failed"
  );
  const rewrittenDefectHash = executeSemanticGate("differential-result-failure-hash-uniqueness", {
    document: {
      ...defectResult,
      compile_or_harness_defects: [{ ...defectRow, stable_failure_hash: "0".repeat(64) }]
    }
  });
  assert.equal(rewrittenDefectHash.status, "failed");
  assert.ok(
    rewrittenDefectHash.status === "failed" &&
      rewrittenDefectHash.issues.some((entry) => entry.path === "$.compile_or_harness_defects[0].stable_failure_hash")
  );
});

test("differential consensus authenticates every same-attempt A/B row before repair", () => {
  const redAHash = "1".repeat(64);
  const redBHash = "2".repeat(64);
  const defectHash = "3".repeat(64);
  const registry = {
    semantic_reds: [
      { stable_failure_hash: redAHash, lane_id: "lane-a" },
      { stable_failure_hash: redBHash, lane_id: "lane-b" }
    ],
    compile_or_harness_defects: [{ stable_failure_hash: defectHash, lane_id: "lane-c" }]
  };
  const classifications = [
    { stable_failure_hash: redAHash, classification: "production_bug", repair_allowed: false },
    { stable_failure_hash: redBHash, classification: "production_bug", repair_allowed: false },
    { stable_failure_hash: defectHash, classification: "compile_harness_defect", repair_allowed: false }
  ];
  const registryBinding = (attemptId: string) =>
    differentialBinding(
      `artifacts/${attemptId}/semantic-red-registry.json`,
      "ultrafuzz/semantic-red-registry@1",
      "differential-red-triage",
      registry,
      attemptId
    );
  const triageBinding = (attemptId: string, pass: "a" | "b", rows = classifications) =>
    differentialBinding(
      `artifacts/${attemptId}/triage-${pass}.json`,
      "ultrafuzz/differential-red-triage@1",
      "differential-red-triage",
      { pass, classifications: rows },
      attemptId
    );
  const registries = [registryBinding("triage-0"), registryBinding("triage-1")];
  const triages = [
    triageBinding("triage-0", "a"),
    triageBinding("triage-0", "b"),
    triageBinding("triage-1", "a"),
    triageBinding("triage-1", "b")
  ];
  const repairSummary = {
    repairs_attempted: [],
    repaired_failures: [],
    preserved_production_or_unknown_reds: [
      { stable_failure_hash: redAHash, classification: "production_bug" },
      { stable_failure_hash: redBHash, classification: "production_bug" }
    ],
    semantic_red_registry_regenerated: false
  };
  const result = (candidateTriages: typeof triages) =>
    executeSemanticGate("differential-repair-summary-triage-reconciliation", {
      document: repairSummary,
      context: { artifactSet: { differentialArtifacts: { registries, triages: candidateTriages } } }
    });

  assert.equal(result(triages).status, "passed");

  const wrongPass = [...triages];
  wrongPass[0] = differentialBinding(
    "artifacts/triage-0/triage-a.json",
    "ultrafuzz/differential-red-triage@1",
    "differential-red-triage",
    { pass: "b", classifications },
    "triage-0"
  );
  assert.equal(result(wrongPass).status, "failed");

  const missingHash = [...triages];
  missingHash[1] = triageBinding("triage-0", "b", classifications.slice(1));
  assert.equal(result(missingHash).status, "failed");

  const reordered = [...triages];
  reordered[2] = triageBinding("triage-1", "a", [classifications[1]!, classifications[0]!, classifications[2]!]);
  assert.equal(result(reordered).status, "failed");

  const rewrittenDefect = [...triages];
  rewrittenDefect[3] = triageBinding("triage-1", "b", [
    classifications[0]!,
    classifications[1]!,
    { stable_failure_hash: defectHash, classification: "production_bug", repair_allowed: false }
  ]);
  assert.equal(result(rewrittenDefect).status, "failed");

  const inconsistentRepairPermission = [...triages];
  inconsistentRepairPermission[0] = triageBinding("triage-0", "a", [
    { ...classifications[0]!, repair_allowed: true },
    classifications[1]!,
    classifications[2]!
  ]);
  assert.equal(result(inconsistentRepairPermission).status, "failed");

  const orphan = [...triages, triageBinding("triage-orphan", "a")];
  assert.equal(result(orphan).status, "failed");

  const vanishedSemanticRed = triages.map((binding) => ({
    ...binding,
    document: {
      pass: (binding.document as { pass: "a" | "b" }).pass,
      classifications: [
        { stable_failure_hash: redAHash, classification: "compile_harness_defect", repair_allowed: false },
        classifications[1]!,
        classifications[2]!
      ]
    }
  }));
  assert.equal(result(vanishedSemanticRed).status, "failed");
});

test("differential report review preserves production-red and final-finding identity order", () => {
  const redAHash = "4".repeat(64);
  const redBHash = "5".repeat(64);
  const attemptId = "triage-0";
  const registry = {
    semantic_reds: [
      { stable_failure_hash: redAHash, lane_id: "lane-a" },
      { stable_failure_hash: redBHash, lane_id: "lane-b" }
    ],
    compile_or_harness_defects: []
  };
  const classifications = [
    { stable_failure_hash: redAHash, classification: "production_bug", repair_allowed: false },
    { stable_failure_hash: redBHash, classification: "production_bug", repair_allowed: false }
  ];
  const registryBinding = differentialBinding(
    `artifacts/${attemptId}/semantic-red-registry.json`,
    "ultrafuzz/semantic-red-registry@1",
    "differential-red-triage",
    registry,
    attemptId
  );
  const triages = (["a", "b"] as const).map((pass) =>
    differentialBinding(
      `artifacts/${attemptId}/triage-${pass}.json`,
      "ultrafuzz/differential-red-triage@1",
      "differential-red-triage",
      { pass, classifications },
      attemptId
    )
  );
  const productionRows = [
    { stable_failure_hash: redAHash, lane_id: "lane-a", summary: "Production red A", evidence_paths: [] },
    { stable_failure_hash: redBHash, lane_id: "lane-b", summary: "Production red B", evidence_paths: [] }
  ];
  const document = {
    campaign_status: "blocked_by_preserved_reds",
    production_bug_reds: productionRows,
    harness_or_reference_repairs: [],
    missing_or_deferred_lanes: [],
    report_rows_ready: productionRows
  };
  const contextForFindings = (findings: unknown[]): SemanticGateContext => ({
    artifactSet: {
      differentialArtifacts: {
        registries: [registryBinding],
        triages,
        repairSummaries: [
          differentialBinding(
            "artifacts/review-0/repair-summary.json",
            "ultrafuzz/differential-repair-summary@1",
            "differential-repair-and-report-review",
            {
              repaired_failures: [],
              preserved_production_or_unknown_reds: [
                { stable_failure_hash: redAHash, classification: "production_bug" },
                { stable_failure_hash: redBHash, classification: "production_bug" }
              ]
            },
            "review-0"
          )
        ],
        gapReviews: [
          differentialBinding(
            "artifacts/review-0/gap-review.json",
            "ultrafuzz/differential-gap-review@1",
            "differential-repair-and-report-review",
            { missing_lane_work_orders: [], incomplete_campaign_work_orders: [], report_blockers: [] },
            "review-0"
          )
        ],
        findings: [
          differentialBinding(
            "artifacts/review-0/findings.json",
            "ultrafuzz/findings@2",
            "differential-repair-and-report-review",
            findings,
            "review-0"
          )
        ]
      }
    }
  });

  assert.equal(
    executeSemanticGate("differential-report-review-reconciliation", {
      document,
      context: contextForFindings([{ id: redAHash }, { id: redBHash }])
    }).status,
    "passed"
  );
  assert.equal(
    executeSemanticGate("differential-report-review-reconciliation", {
      document,
      context: contextForFindings([{ id: redBHash }, { id: redAHash }])
    }).status,
    "failed"
  );
  assert.equal(
    executeSemanticGate("differential-report-review-reconciliation", {
      document: { ...document, production_bug_reds: [...productionRows].reverse() },
      context: contextForFindings([{ id: redAHash }, { id: redBHash }])
    }).status,
    "failed"
  );
});

test("dynamic strategy reconciliation rejects every shape-valid sibling join drift", () => {
  interface MutableDynamicContext {
    artifactSet: {
      dynamicStrategyArtifacts: {
        strategyPlan: {
          selected_strategy_count: number;
          selected_strategies: string[];
          rejected_strategies: Array<{ strategy_id: string; reason: string }>;
        };
        enumeratorOutputs: {
          enumerators: Array<{
            enumerator_id: string;
            recommendations: Array<Record<string, unknown>>;
          }>;
        };
        findings: Array<Record<string, unknown>>;
        provenance: { generated_files: Array<Record<string, unknown>> };
      };
    };
  }

  const cases: Array<{
    name: string;
    mutate: (context: MutableDynamicContext, document: { strategies: Array<Record<string, unknown>> }) => void;
    message: RegExp;
  }> = [
    {
      name: "plan order",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.strategyPlan.selected_strategies = ["strategy-b"];
        context.artifactSet.dynamicStrategyArtifacts.strategyPlan.rejected_strategies = [
          { strategy_id: "strategy-a", reason: "Rejected." }
        ];
      },
      message: /IDs and order/u
    },
    {
      name: "undisposed recommendation",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.strategyPlan.rejected_strategies = [];
      },
      message: /neither selected nor explicitly rejected/u
    },
    {
      name: "invented plan strategy",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.strategyPlan.rejected_strategies.push({
          strategy_id: "strategy-invented",
          reason: "Invented."
        });
      },
      message: /unknown enumerator recommendation/u
    },
    {
      name: "rewritten recommendation",
      mutate: (_context, document) => {
        document.strategies[0]!.rationale = "Rewritten after selection.";
      },
      message: /does not exactly preserve/u
    },
    {
      name: "conflicting enumerators",
      mutate: (context, document) => {
        context.artifactSet.dynamicStrategyArtifacts.enumeratorOutputs.enumerators.push({
          enumerator_id: "enumerator-b",
          recommendations: [{ ...dynamicRecommendationFixture, rationale: "A conflicting rationale." }]
        });
        document.strategies[0]!.enumerator_ids = ["enumerator-a", "enumerator-b"];
      },
      message: /disagree on the canonical recommendation fields/u
    },
    {
      name: "enumerator attribution",
      mutate: (_context, document) => {
        document.strategies[0]!.enumerator_ids = ["enumerator-other"];
      },
      message: /exact recommending enumerators/u
    },
    {
      name: "finding strategy",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.findings[0]!.dynamic_strategy_id = "strategy-b";
      },
      message: /unselected strategy/u
    },
    {
      name: "finding enumerator",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.findings[0]!.enumerator_id = "enumerator-other";
      },
      message: /did not recommend/u
    },
    {
      name: "provenance strategy",
      mutate: (context) => {
        context.artifactSet.dynamicStrategyArtifacts.provenance.generated_files[0]!.strategy_id = "strategy-b";
      },
      message: /generated file.*unselected strategy/u
    }
  ];

  for (const fixture of cases) {
    const context = structuredClone(dynamicStrategyArtifactContext) as MutableDynamicContext;
    const document = { strategies: [structuredClone(selectedDynamicStrategyFixture)] };
    fixture.mutate(context, document);
    const result = executeSemanticGate("dynamic-strategy-artifact-reconciliation", { document, context });
    assert.equal(result.status, "failed", fixture.name);
    assert.ok(
      result.status === "failed" && result.issues.some((entry) => fixture.message.test(entry.message)),
      fixture.name
    );
  }
});

test("attempt source-event joins accept only declared host-side validation failures from NodeFinished", () => {
  const context: SemanticGateContext = {
    eventLog: {
      events: [
        {
          workflow_run_id: "workflow-a",
          source_event_sequence: 1,
          timestamp_ms: Date.parse("2026-01-01T00:00:00.000Z"),
          type: "NodeStarted",
          payload: { nodeId: "node:a", iteration: 0, attempt: 1 }
        },
        {
          workflow_run_id: "workflow-a",
          source_event_sequence: 2,
          timestamp_ms: Date.parse("2026-01-01T00:00:01.000Z"),
          type: "NodeFinished",
          payload: { nodeId: "node:a", iteration: 0, attempt: 1 }
        }
      ]
    }
  };
  const failedAttempt = {
    workflow_run_id: "workflow-a",
    node_id: "planned-a",
    strategy_attempt_id: "a",
    iteration: 0,
    attempt: 1,
    started_event_sequence: 1,
    source_event_sequence: 2,
    lifecycle: {
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z"
    },
    outcome: "failed"
  };

  for (const failureCategory of ["artifact-validation", "invalid-output"]) {
    assert.equal(
      executeSemanticGate("attempt-source-event-join", {
        document: { ...failedAttempt, failure_category: failureCategory },
        context
      }).status,
      "passed",
      failureCategory
    );
  }
  assert.equal(
    executeSemanticGate("attempt-source-event-join", {
      document: { ...failedAttempt, failure_category: "executor-error" },
      context
    }).status,
    "failed"
  );
});
