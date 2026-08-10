import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  layoutForRunRoot,
  sha256Bytes,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ArtifactContractId,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationMarker
} from "@ultrafuzz/artifacts";
import { projectCanonicalFinalReport } from "@ultrafuzz/runtime";

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

export function currentReportIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return currentFinding({
    id: "L-01",
    title: "[L-01] - Fixture finding",
    description: "A caller can reach a state that violates the documented relationship.",
    severity: "Low",
    impact: "Low",
    likelihood: "Low",
    impact_rationale: "The affected state remains bounded.",
    likelihood_rationale: "The transition uses ordinary preconditions.",
    severity_rationale: "Low impact maps to Low severity.",
    proof_of_concept: {
      scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
      language: "solidity",
      code: "function testCanonicalFinding() public {}"
    },
    strategy: "stateful-invariant",
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 1 }]
    },
    lifecycle: {
      dedupe_key: "fixture-dedupe-key",
      source_artifacts: [],
      strategy_hits: []
    },
    ...overrides
  });
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
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    },
    ...overrides
  };
}

export function writeCurrentTerminalReport(
  runRoot: string,
  overrides: { report?: Record<string, unknown>; markdownReport?: Record<string, unknown> } = {}
): string {
  const runId = path.basename(runRoot);
  const baseReport = currentTerminalReport();
  const baseMetadata = baseReport.run_metadata as Record<string, unknown>;
  const report =
    overrides.report ??
    currentTerminalReport({
      run_metadata: { ...baseMetadata, run_id: runId, source_run_id: runId }
    });
  const projection = projectCanonicalFinalReport(overrides.markdownReport ?? report);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(projection.markdown, "utf8");
  const outputs = currentFinalReportOutputs();
  const workflowRunId = "workflow-one";
  const agentTaskId = "node:final-report";
  const verifierTaskId = "verify:final-report";
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  const markdownPath = path.join(runRoot, "artifacts", "final-report", "report.md");
  writeFileDurable(reportPath, reportBytes);
  writeFileDurable(markdownPath, markdownBytes);
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
          outputs,
          prompt_id: "final-report",
          prompt_path: "review/final-report.md",
          loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
          model_fanout: []
        }
      ]
    })}\n`
  );
  const layout = layoutForRunRoot(runRoot, runId);
  writeArtifactManifest({
    layout,
    nodeId: "final-report",
    include: ["report.md", "report.json"],
    outputs,
    provenance: {
      producer_node_id: "final-report",
      logical_node_id: "final-report",
      attempt_index: 0,
      loop_index: 0,
      model_index: 0,
      agent_ref: "CodexAgent",
      workflow_run_id: workflowRunId,
      workflow_task_id: agentTaskId,
      origin: "workflow",
      metadata: { concrete_node_id: "final-report" }
    }
  });
  const artifactManifestSha256 = sha256Bytes(
    fs.readFileSync(path.join(runRoot, "artifacts", "final-report", "artifact-manifest.json"))
  );
  fs.writeFileSync(
    path.join(runRoot, "state.json"),
    `${JSON.stringify(
      currentRunState(
        {
          "final-report": {
            status: "succeeded",
            finished_at: FIXTURE_TIMESTAMP,
            logical_node_id: "final-report",
            artifact_dir: "artifacts/final-report",
            outputs,
            provenance: {
              workflow: {
                run_id: workflowRunId,
                task_id: verifierTaskId,
                agent_task_id: agentTaskId,
                verifier_task_id: verifierTaskId,
                state: "finished",
                attempt: 0
              },
              output_contracts: { ok: true, missing: [], artifact_manifest_sha256: artifactManifestSha256 }
            }
          }
        },
        { run_id: runId }
      )
    )}\n`
  );
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: "final-report",
    node_id: "final-report",
    artifacts: outputs.map((output) => ({
      ...output,
      sha256: sha256Bytes(output.path === "report.json" ? reportBytes : markdownBytes)
    })),
    publications: outputs.map((output) => ({
      path: output.path,
      sha256: sha256Bytes(output.path === "report.json" ? reportBytes : markdownBytes)
    }))
  };
  writeJsonDurable(path.join(runRoot, ".ultrafuzz-verification", "final-report.json"), marker);
  return reportPath;
}

function currentFinalReportOutputs(): ArtifactManifestOutputContract[] {
  return [
    {
      path: "report.md",
      ...currentArtifactBinding("ultrafuzz/nonempty-markdown@1"),
      primary: true
    },
    {
      path: "report.json",
      ...currentArtifactBinding("ultrafuzz/report@2"),
      primary: false
    }
  ];
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
    schema_version: "ultrafuzz.run-state.v5",
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

export function currentGenuineTaskFailureState(attemptId: string): Record<string, unknown> {
  return currentRunState({
    [attemptId]: {
      status: "failed",
      finished_at: "2026-07-20T00:00:00.000Z",
      last_error: "task output did not pass final validation",
      provenance: {
        workflow: {
          run_id: "workflow-one",
          task_id: `verify:${attemptId}`,
          agent_task_id: `node:${attemptId}`,
          verifier_task_id: `verify:${attemptId}`,
          state: "finished"
        },
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) },
        terminal_disposition: {
          schema_version: "ultrafuzz.terminal-disposition.v1",
          kind: "task-output-validation-failure"
        }
      }
    },
    "final-report": {
      status: "succeeded",
      finished_at: "2026-07-20T00:00:00.000Z",
      provenance: {
        workflow: {
          run_id: "workflow-one",
          task_id: "verify:final-report",
          agent_task_id: "node:final-report",
          verifier_task_id: "verify:final-report",
          state: "finished"
        },
        output_contracts: { ok: true, missing: [], artifact_manifest_sha256: "a".repeat(64) }
      }
    }
  });
}

export function writeCurrentSmithersTaskFixture(runRoot: string, attemptId: string): void {
  const taskSpecifications: Array<{
    id: string;
    outputs: Array<{ path: string; contract: ArtifactContractId; primary: boolean }>;
  }> = [
    {
      id: attemptId,
      outputs: [{ path: "result.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true }]
    },
    {
      id: "final-report",
      outputs: [
        { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1", primary: true },
        { path: "report.json", contract: "ultrafuzz/report@2", primary: false }
      ]
    }
  ];
  fs.writeFileSync(
    path.join(runRoot, "graph.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.planned-graph.v3",
      graph_version: "3",
      topology_version: 2,
      groups: {},
      nodes: taskSpecifications.map((task) => ({
        id: task.id,
        logical_id: task.id,
        display_name: task.id,
        kind: "agentic",
        depends_on: [],
        artifact_dir: `artifacts/${task.id}`,
        outputs: task.outputs.map((output) => ({
          path: output.path,
          ...currentArtifactBinding(output.contract),
          primary: output.primary
        })),
        prompt_id: task.id,
        prompt_path: `.ultrafuzz/prompts/${task.id}.md`,
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [
          {
            model_profile_id: "fixture-model",
            agent_ref: "CodexAgent",
            model_name: "gpt-fixture",
            reasoning_effort: "high",
            model_index: 0,
            loop_index: 0,
            attempt_index: 0
          }
        ],
        workflow: { node_id: `node:${task.id}`, task_node_ids: [`node:${task.id}`] }
      }))
    })}\n`
  );
  fs.mkdirSync(path.join(runRoot, "smithers"), { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, "smithers", "tasks.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.smithers.workflow.v3",
      run_id: "fixture-run",
      smithers_run_id: "workflow-one",
      workflow_name: "fixture-workflow",
      pinned_submodules: null,
      tasks: taskSpecifications.map((task) => ({
        attemptId: task.id,
        concreteNodeId: task.id,
        logicalNodeId: task.id,
        preparationSmithersNodeId: `prepare:${task.id}`,
        smithersNodeId: `node:${task.id}`,
        verifierSmithersNodeId: `verify:${task.id}`,
        agentRef: "CodexAgent",
        modelName: "gpt-fixture",
        reasoningEffort: "high",
        dependencies: [],
        dependencySmithersNodeIds: [],
        timeoutMs: 60_000,
        heartbeatTimeoutMs: 60_000,
        retries: 0,
        retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
        workspacePath: `/runs/fixture-run/workspaces/${task.id}`,
        artifactDir: `/runs/fixture-run/artifacts/${task.id}`,
        dependencyArtifactDirs: [],
        renderedPromptPath: `/runs/fixture-run/prompts/${task.id}.md`,
        execution: {
          mode: "local",
          resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 },
          agentCredentialEnv: []
        },
        metadata: {
          schemaVersion: "ultrafuzz.smithers.task.v2",
          run: {
            ultrafuzzRunId: "fixture-run",
            smithersWorkflowName: "fixture-workflow",
            graphVersion: "3",
            topologyVersion: 2
          },
          node: {
            concreteNodeId: task.id,
            logicalNodeId: task.id,
            attemptId: task.id,
            label: task.id,
            kind: "agentic",
            promptPath: `${task.id}.md`
          },
          dependencies: { concreteNodeIds: [], attemptIds: [], smithersNodeIds: [] },
          loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
          model: {
            profileId: "fixture-model",
            agentRef: "CodexAgent",
            modelName: "gpt-fixture",
            reasoningEffort: "high",
            modelIndex: 0,
            attemptIndex: 0
          },
          workspace: {
            primitive: "worktree",
            path: `/runs/fixture-run/workspaces/${task.id}`,
            repoPath: "/repo",
            trustModel: "skip-permissions"
          },
          artifacts: {
            dir: `/runs/fixture-run/artifacts/${task.id}`,
            outputs: task.outputs.map((output) => ({
              path: output.path,
              ...currentTaskOutputBinding(output.contract),
              primary: output.primary
            })),
            manifestPath: `/runs/fixture-run/artifacts/${task.id}/artifact-manifest.json`
          },
          retryPolicy: { maxAttempts: 1, smithersRetries: 0 },
          timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
          execution: {
            mode: "local",
            resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 }
          }
        }
      }))
    })}\n`
  );
}
