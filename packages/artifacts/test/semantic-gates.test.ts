import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ARTIFACT_SCHEMA_METADATA,
  SEMANTIC_GATE_REGISTRY,
  SEMANTIC_GATE_SCOPES,
  artifactContractDefinition,
  executeOfflineSchemaSemanticGates,
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
    positive: { red_candidates: [{ failure_signature: "a" }] },
    negative: { red_candidates: [{ failure_signature: "a" }, { failure_signature: "a" }] }
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
  "property-campaign-failure-id-uniqueness": {
    positive: { failures: [{ id: "a" }] },
    negative: { failures: [{ id: "a" }, { id: "a" }] }
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
    positive: { semantic_reds: [{ stable_failure_hash: "a" }] },
    negative: { semantic_reds: [{ stable_failure_hash: "a" }, { stable_failure_hash: "a" }] }
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
      "campaign-summary-count-coupling": {
        positive: { failure_counts: { pre_deduplication: 1, post_deduplication: 1 } },
        negative: { failure_counts: { pre_deduplication: 2, post_deduplication: 1 } },
        context: { artifactSet: { campaigns: [{ failures: [{}] }], findings: [{}] } }
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
          artifactSet: { propertyLenses: [{ sourceNodeId: "lens", document: { properties: [{ id: "a" }] } }] }
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
