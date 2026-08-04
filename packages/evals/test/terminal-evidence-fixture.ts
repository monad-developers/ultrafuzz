import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { fingerprintGraph } from "../../topology/src/fingerprint.js";
import type { ExpandedGraph } from "../../topology/src/types.js";

export interface TerminalTaskFixture {
  attemptId: string;
  concreteNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
}

export function writeTerminalEvidenceFixture(input: {
  runRoot: string;
  runtimeRunId: string;
  workflowRunId: string;
  state: Record<string, unknown> & { nodes: Record<string, unknown> };
  tasks: TerminalTaskFixture[];
  groups?: ExpandedGraph["groups"];
  graphNodeMetadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}): { graphFingerprint: string; configFingerprint: string } {
  const smithersRoot = path.join(input.runRoot, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  const stateNodeIds = Object.keys(input.state.nodes);
  const expandedGraph: ExpandedGraph = {
    graphVersion: "2",
    topologyVersion: 2,
    groups: input.groups ?? {},
    nodes: stateNodeIds.map((id) => {
      const group = input.graphNodeMetadata?.[id]?.group;
      return {
        id,
        logicalId: id,
        label: id,
        kind: "agentic",
        ...(typeof group === "string" ? { group } : {}),
        dependsOn: [],
        artifactDir: `artifacts/${id}`,
        retryPolicy: { maxAttempts: 1 },
        loop: { index: 0, count: 1, mode: "series", attemptIndex: 0 },
        outputs: [],
        modelFanout: []
      };
    })
  };
  const graphFingerprint = fingerprintGraph(expandedGraph);
  const configBytes = Buffer.from('{"fixture":true}\n', "utf8");
  const configFingerprint = digest(configBytes);
  const graph = {
    schema_version: "1.0",
    ...(input.groups === undefined ? {} : { groups: input.groups }),
    nodes: stateNodeIds.map((id) => {
      const taskNodeIds = input.tasks.filter((task) => task.concreteNodeId === id).map((task) => task.smithersNodeId);
      return {
        ...input.graphNodeMetadata?.[id],
        id,
        ...(taskNodeIds.length === 0 ? {} : { workflow: { task_node_ids: taskNodeIds } })
      };
    })
  };
  const state = {
    ...input.state,
    run_id: input.runtimeRunId,
    graph_fingerprint: graphFingerprint,
    config_fingerprint: configFingerprint
  };
  const tasks = {
    run_id: input.runtimeRunId,
    smithers_run_id: input.workflowRunId,
    tasks: input.tasks
  };
  const graphBytes = jsonBytes(graph);
  const expandedGraphBytes = jsonBytes(expandedGraph);
  const stateBytes = jsonBytes(state);
  const tasksBytes = jsonBytes(tasks);
  const graphFingerprintBytes = Buffer.from(`${graphFingerprint}\n`, "utf8");
  const emptyBytes = Buffer.alloc(0);
  const files = {
    graph: seal(graphBytes),
    expanded_graph: seal(expandedGraphBytes),
    graph_fingerprint: seal(graphFingerprintBytes),
    config: seal(configBytes),
    tasks: seal(tasksBytes),
    input: seal(emptyBytes),
    workflow: seal(emptyBytes),
    evidence_workflow: seal(emptyBytes)
  };
  const control = {
    schema_version: "ultrafuzz.workflow-control-integrity.v2",
    run_id: input.runtimeRunId,
    files,
    execution_files: [],
    bindings: {
      run_id: input.runtimeRunId,
      graph_fingerprint: graphFingerprint,
      config_fingerprint: configFingerprint,
      expected_state_node_ids: [...stateNodeIds].sort(),
      expected_task_attempt_ids: input.tasks.map((task) => task.attemptId).sort(),
      expected_task_node_ids: input.tasks.flatMap((task) => [task.smithersNodeId, task.verifierSmithersNodeId]).sort()
    }
  };
  fs.writeFileSync(path.join(input.runRoot, "state.json"), stateBytes);
  fs.writeFileSync(path.join(input.runRoot, "graph.json"), graphBytes);
  fs.writeFileSync(path.join(smithersRoot, "expanded-graph.json"), expandedGraphBytes);
  fs.writeFileSync(path.join(smithersRoot, "config.fingerprint-input"), configBytes);
  fs.writeFileSync(path.join(smithersRoot, "tasks.json"), tasksBytes);
  fs.writeFileSync(path.join(smithersRoot, "control-integrity.json"), jsonBytes(control));
  const runMetadataPath = path.join(input.runRoot, "run.json");
  if (!fs.existsSync(runMetadataPath)) fs.writeFileSync(runMetadataPath, jsonBytes({ run_id: input.runtimeRunId }));
  const usageLedgerPath = path.join(input.runRoot, "usage.jsonl");
  if (!fs.existsSync(usageLedgerPath)) fs.writeFileSync(usageLedgerPath, "");
  return { graphFingerprint, configFingerprint };
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function seal(value: Buffer): { sha256: string; size_bytes: number } {
  return { sha256: digest(value), size_bytes: value.byteLength };
}
