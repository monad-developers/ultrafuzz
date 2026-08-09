import fs from "node:fs";
import path from "node:path";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  type ArtifactContractId
} from "@ultrafuzz/artifacts";

const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export function currentFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id: "fixture-finding-1",
    title: "Fixture finding",
    status: "confirmed",
    severity_guess: "Low",
    confidence: "high",
    summary: "A fixture finding used to exercise the current artifact contract.",
    ...overrides
  };
}

export function currentTerminalReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: {
      run_id: "fixture-run",
      source_run_id: "fixture-source-run",
      repository: "https://github.com/example/fixture",
      elapsed_time: "0s",
      models_used: ["fixture-model"],
      tokens_used: "0",
      estimated_spend: "0",
      partial_pricing: false,
      strategy_loops: 0
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    ...overrides
  };
}

export function writeCurrentTerminalReport(runRoot: string): string {
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(currentTerminalReport())}\n`);
  fs.writeFileSync(
    path.join(runRoot, "graph.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.planned-graph.v3",
      graph_version: "3",
      topology_version: 2,
      groups: {},
      nodes: [
        {
          id: "final-report",
          logical_id: "final-report",
          display_name: "Final Report",
          kind: "agentic",
          depends_on: [],
          artifact_dir: "artifacts/final-report",
          outputs: [
            {
              path: "report.json",
              ...currentArtifactBinding("ultrafuzz/report@2"),
              primary: true
            }
          ],
          prompt_id: "final-report",
          prompt_path: "review/final-report.md",
          loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
          model_fanout: []
        }
      ]
    })}\n`
  );
  return reportPath;
}

export function currentArtifactBinding<C extends ArtifactContractId>(contract: C) {
  const binding = artifactContractSchemaBinding(contract);
  return {
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(binding ?? {})
  };
}

export function currentTaskOutputBinding<C extends ArtifactContractId>(contract: C) {
  const binding = artifactContractSchemaBinding(contract);
  return {
    contract,
    contractDigest: artifactContractDefinition(contract).digest,
    ...(binding === undefined
      ? {}
      : {
          schemaFile: binding.schema_file,
          schemaId: binding.schema_id,
          schemaSha256: binding.schema_sha256,
          schemaBundleSha256: binding.schema_bundle_sha256,
          validatorBuild: binding.validator_build
        })
  };
}

export function currentRunState(
  nodes: Record<string, Record<string, unknown>>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const terminalStatuses = new Set([
    "succeeded",
    "failed",
    "skipped",
    "timed-out",
    "reused-from-prior-run",
    "invalidated"
  ]);
  const normalizedNodes = Object.fromEntries(
    Object.entries(nodes).map(([nodeId, node]) => {
      const status = typeof node.status === "string" ? node.status : "pending";
      return [
        nodeId,
        {
          node_id: nodeId,
          status,
          retry_count: 0,
          timed_out: false,
          ...(terminalStatuses.has(status)
            ? {}
            : {
                wait_since: FIXTURE_TIMESTAMP,
                wait_reason: "active",
                next_eligible_action: "task-complete"
              }),
          ...node
        }
      ];
    })
  );
  return {
    schema_version: "ultrafuzz.run-state.v3",
    run_id: "fixture-run",
    status: Object.values(nodes).some((node) => node.status === "failed") ? "failed" : "succeeded",
    graph_fingerprint: "a".repeat(64),
    config_fingerprint: "b".repeat(64),
    created_at: FIXTURE_TIMESTAMP,
    last_transition_at: FIXTURE_TIMESTAMP,
    controller_lease: {
      status: "active",
      duration_ms: 30_000,
      renewed_at: FIXTURE_TIMESTAMP,
      expires_at: "2026-01-01T00:00:30.000Z",
      recovery_attempts: 0
    },
    concurrency: {
      requested_concurrency: 1,
      effective_concurrency: 0,
      ready_queue_depth: 0,
      active_work: 0,
      queued_duration_ms: 0,
      active_duration_ms: 0,
      idle_duration_ms: 0,
      observed_at: FIXTURE_TIMESTAMP
    },
    nodes: normalizedNodes,
    ...overrides
  };
}
