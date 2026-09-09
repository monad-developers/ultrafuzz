import assert from "node:assert/strict";
import test from "node:test";

import {
  PLANNED_GRAPH_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  artifactContractDefinition,
  createInitialRunState,
  createNodeState,
  type ExecutionNodeProvenance,
  type NodeStatus,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type RunState,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

import { deriveTerminalReportCompletion } from "../src/terminal-report-completion.js";
import type { VerifiedRunOutputAuthoritySnapshot } from "../src/verified-output.js";

const ROOT = "/runs/example-run";
const WORKFLOW_ID = "workflow-current";
const TIME = "2026-01-01T00:00:00.000Z";

interface Fixture {
  graph: PlannedGraphDocument;
  tasks: SmithersTaskManifestDocument;
  state: RunState;
}

test("terminal census counts sealed slots once, including report, without changing state or counting retries and aggregates", () => {
  const fixture = makeFixture(["analysis", "report"]);
  required(fixture.state.nodes.analysis).retry_count = 17;
  fixture.state.nodes.summary = createNodeState({ id: "summary", status: "succeeded" });
  fixture.state.nodes.summary.provenance = {
    workflow: { run_id: WORKFLOW_ID, aggregate_attempt_statuses: ["succeeded", "succeeded"] }
  };
  const authority = snapshot(fixture);
  const before = Buffer.from(authority.state.bytes);
  const completion = deriveTerminalReportCompletion(authority);
  assert.equal(completion.outcome, "complete");
  assert.deepEqual(completion.counts, {
    planned: 2,
    succeeded: 2,
    failed: 0,
    timed_out: 0,
    skipped: 0,
    cancelled: 0,
    unverified: 0
  });
  assert.deepEqual(completion.incomplete_nodes, []);
  assert.equal(completion.incomplete_nodes_omitted, 0);
  assert.deepEqual(authority.state.bytes, before);
});

test("terminal census distinguishes task failure, dependency gaps, timeout, cancellation, and unexplained pending work", () => {
  const fixture = makeFixture(["failed", "dependent", "waiting", "timeout", "cancelled", "report"]);
  setOutcome(fixture, "failed", "failed");
  setOutcome(fixture, "timeout", "timed-out");
  setOutcome(fixture, "cancelled", "failed");
  workflow(fixture, "cancelled").state = "cancelled";
  setOutcome(fixture, "dependent", "pending");
  setOutcome(fixture, "waiting", "pending");
  dependOn(fixture, "dependent", "failed");
  fixture.state.status = "failed";
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.outcome, "partial");
  assert.deepEqual(completion.counts, {
    planned: 6,
    succeeded: 1,
    failed: 1,
    timed_out: 1,
    skipped: 1,
    cancelled: 1,
    unverified: 1
  });
  assert.deepEqual(
    completion.incomplete_nodes.map((node) => [node.node_id, node.outcome]),
    [
      ["cancelled", "cancelled"],
      ["dependent", "skipped"],
      ["failed", "failed"],
      ["timeout", "timed_out"],
      ["waiting", "unverified"]
    ]
  );
});

test("model fanout counts each planned execution slot without counting its concrete aggregate", () => {
  const fixture = makeFixture(["analysis", "report"]);
  const analysis = required(fixture.graph.nodes[0]);
  analysis.model_fanout = [0, 1].map((index) => ({
    attempt_id: `analysis__model_${index}__attempt_0`,
    model_profile_id: "default",
    agent_ref: "CodexAgent",
    model_index: index,
    loop_index: 0,
    attempt_index: 0
  }));
  const attempts = analysis.model_fanout.map((model) => required(model.attempt_id));
  analysis.workflow = { node_id: `node:${required(attempts[0])}`, task_node_ids: attempts.map((id) => `node:${id}`) };
  fixture.tasks.tasks = [...attempts.map((id) => taskForNode(analysis, id)), required(fixture.tasks.tasks[1])];
  for (const id of attempts) fixture.state.nodes[id] = createNodeState({ id, status: "succeeded" });
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.planned, 3);
  assert.equal(completion.counts.succeeded, 3);
});

test("typed provider timeout evidence remains authoritative when the event omits workflow state", () => {
  const fixture = makeFixture(["timeout", "report"]);
  fixture.state.status = "timed-out";
  setOutcome(fixture, "timeout", "timed-out");
  delete workflow(fixture, "timeout").state;
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.timed_out, 1);
  assert.equal(completion.outcome, "partial");
  required(provenance(fixture, "timeout").failure).causal_task_id = "prepare:timeout";
  assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /cannot downgrade controller task/u);
});

test("failed, timed-out, and canceled runs cannot produce complete census without an attributable gap", () => {
  for (const status of ["failed", "timed-out", "canceled"] as const) {
    const fixture = makeFixture(["report"]);
    fixture.state.status = status;
    assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /without incomplete task evidence/u);
  }
});

test("explicit skipped provenance requires a matching failed ancestor, including transitive dependency chains", () => {
  const fixture = makeFixture(["producer", "middle", "consumer"]);
  setOutcome(fixture, "producer", "failed");
  setOutcome(fixture, "middle", "pending");
  setOutcome(fixture, "consumer", "skipped");
  dependOn(fixture, "middle", "producer");
  dependOn(fixture, "consumer", "middle");
  required(provenance(fixture, "consumer").failure).causal_task_id = "node:producer";
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.skipped, 2);
  required(provenance(fixture, "consumer").failure).causal_task_id = "node:unknown";
  assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /lacks a failed dependency/u);
});

test("pending tasks in canceled runs remain cancelled without inventing executions", () => {
  const fixture = makeFixture(["not-started", "report"]);
  fixture.state.status = "canceled";
  setOutcome(fixture, "not-started", "pending");
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.cancelled, 1);
  assert.equal(completion.counts.succeeded, 1);
});

test("an unexpanded dynamic scope remains visible, while expanded group aggregates are not counted", () => {
  const fixture = makeFixture(["enumerator", "report"]);
  addDynamicGroup(fixture, "pending-scope", "pending");
  addDynamicGroup(fixture, "empty-scope", "expanded");
  setOutcome(fixture, "enumerator", "failed");
  fixture.state.status = "failed";
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.planned, 3);
  assert.equal(completion.counts.skipped, 1);
  assert.ok(completion.incomplete_nodes.some((node) => node.node_id === "pending-scope"));
  assert.ok(completion.incomplete_nodes.every((node) => node.node_id !== "empty-scope"));
});

test("materialized dynamic tasks are counted individually and their expanded scope is omitted", () => {
  const fixture = makeFixture(["enumerator", "item-one", "report"]);
  addDynamicGroup(fixture, "expanded-scope", "expanded");
  const scope = required(fixture.graph.nodes.find((node) => node.id === "expanded-scope"));
  required(scope.dynamic).generated_node_ids = ["item-one"];
  const generated = required(fixture.graph.nodes.find((node) => node.id === "item-one"));
  generated.dynamic_generated = {
    group_node_id: "expanded-scope",
    source_node_id: "enumerator",
    source_attempt_id: "enumerator",
    expansion_key: "one",
    item_sha256: "c".repeat(64),
    storage_id: "item-one",
    manifest_path: "smithers/expansions/expanded-scope.json"
  };
  generated.model_fanout = [
    {
      attempt_id: "item-one",
      model_profile_id: "default",
      agent_ref: "CodexAgent",
      model_index: 0,
      loop_index: 0,
      attempt_index: 0
    }
  ];
  generated.artifact_dirs = ["artifacts/item-one"];
  setOutcome(fixture, "item-one", "failed");
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.planned, 3);
  assert.equal(completion.counts.failed, 1);
  assert.deepEqual(
    completion.incomplete_nodes.map((node) => node.node_id),
    ["item-one"]
  );
});

test("bounded identities have stable ordering and exact omitted counts", () => {
  const ids = Array.from({ length: 270 }, (_, index) => `task-${String(269 - index).padStart(3, "0")}`);
  const fixture = makeFixture(ids);
  fixture.state.status = "failed";
  for (const id of ids) setOutcome(fixture, id, "failed");
  const completion = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(completion.counts.planned, 270);
  assert.equal(completion.counts.failed, 270);
  assert.equal(completion.incomplete_nodes.length, 256);
  assert.equal(completion.incomplete_nodes_omitted, 14);
  assert.equal(completion.incomplete_nodes[0]?.node_id, "task-000");
  assert.equal(completion.incomplete_nodes.at(-1)?.node_id, "task-255");
});

test("terminal census rejects live runs, active nodes, invalidation, reuse, and missing verified success", () => {
  for (const runStatus of ["pending", "running", "paused"] as const) {
    const fixture = makeFixture(["report"]);
    fixture.state.status = runStatus;
    assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /requires a terminal run/u);
  }
  for (const status of ["running", "invalidated", "reused-from-prior-run"] as const) {
    const fixture = makeFixture(["report"]);
    setOutcome(fixture, "report", status);
    assert.throws(
      () => deriveTerminalReportCompletion(snapshot(fixture)),
      /unresolved|invalidated|cannot classify|lacks matching/u
    );
  }
  const fixture = makeFixture(["report"]);
  const authority = snapshot(fixture);
  assert.throws(() => deriveTerminalReportCompletion({ ...authority, outputs: [] }), /lacks verified outputs/u);
  assert.throws(
    () => deriveTerminalReportCompletion({ ...authority, outputs: [...authority.outputs, ...authority.outputs] }),
    /contradictory verified output/u
  );
});

test("artifact and controller failures remain blocking even with an invalid-output terminal disposition", () => {
  for (const category of ["artifact-contract", "dependency-cascade"] as const) {
    const fixture = makeFixture(["failed"]);
    setOutcome(fixture, "failed", "failed");
    provenance(fixture, "failed").failure = {
      category,
      causal_task_id: "verify:failed",
      causal_failure_category: "artifact-contract",
      dependent_task_ids: []
    };
    provenance(fixture, "failed").terminal_disposition = {
      schema_version: "ultrafuzz.terminal-disposition.v1",
      kind: "task-output-validation-failure"
    };
    assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /cannot downgrade artifact authority/u);
  }
  const fixture = makeFixture(["failed"]);
  setOutcome(fixture, "failed", "failed");
  workflow(fixture, "failed").task_id = "prepare:failed";
  assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /cannot downgrade controller task/u);
});

test("failure identity mismatches and missing sealed task state fail closed without inferring refusal from error text", () => {
  const fixture = makeFixture(["failed"]);
  setOutcome(fixture, "failed", "failed");
  required(fixture.state.nodes.failed).last_error = "Request refused";
  const result = deriveTerminalReportCompletion(snapshot(fixture));
  assert.equal(result.incomplete_nodes[0]?.failure_category, "task-failure");
  for (const field of ["run_id", "task_id", "agent_task_id", "verifier_task_id"] as const) {
    const changed = structuredClone(fixture);
    workflow(changed, "failed")[field] = "other";
    assert.throws(() => deriveTerminalReportCompletion(snapshot(changed)), /lacks matching workflow authority/u);
  }
  delete fixture.state.nodes.failed;
  assert.throws(() => deriveTerminalReportCompletion(snapshot(fixture)), /missing sealed task state/u);
});

function makeFixture(ids: string[]): Fixture {
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: {},
    nodes: ids.map(graphNode)
  };
  const state = createInitialRunState({
    runId: "example-run",
    createdAt: TIME,
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    nodes: ids.map((id) => ({ id, status: "succeeded" as const })),
    provenance: {
      workflow: {
        inspection: { runId: WORKFLOW_ID },
        runId: WORKFLOW_ID,
        compiledRunId: WORKFLOW_ID,
        name: WORKFLOW_ID,
        controlGeneration: "a".repeat(64),
        linkId: "11111111-1111-4111-8111-111111111111",
        executionSnapshot: `smithers/execution-snapshots/${"a".repeat(64)}`
      }
    }
  });
  state.status = "succeeded";
  state.finished_at = TIME;
  return {
    graph,
    state,
    tasks: {
      schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
      run_id: state.run_id,
      smithers_run_id: WORKFLOW_ID,
      workflow_name: WORKFLOW_ID,
      pinned_submodules: null,
      tasks: graph.nodes.map((node) => taskForNode(node))
    }
  };
}

function graphNode(id: string): PlannedGraphNodeDocument {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: [],
    artifact_dir: `artifacts/${id}`,
    outputs: [
      {
        path: "output.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
        primary: true
      }
    ],
    prompt_id: id,
    prompt_path: `review/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: [],
    workflow: { node_id: `node:${id}`, task_node_ids: [`node:${id}`] }
  };
}

function taskForNode(node: PlannedGraphNodeDocument, id = node.id): SmithersTaskManifestTask {
  const artifactDir = `${ROOT}/artifacts/${id}`;
  const workspacePath = `${ROOT}/workspaces/${id}`;
  const agentChain = [{ profileId: "default", agentRef: "CodexAgent", role: "primary" as const }];
  const execution = {
    mode: "local" as const,
    resources: { cpu: 2, memoryMiB: 1024, timeoutSeconds: 60 },
    agentCredentialEnv: []
  };
  return {
    attemptId: id,
    concreteNodeId: node.id,
    logicalNodeId: node.logical_id,
    preparationSmithersNodeId: `prepare:${id}`,
    smithersNodeId: `node:${id}`,
    verifierSmithersNodeId: `verify:${id}`,
    agentRef: "CodexAgent",
    agentChain,
    dependencies: [],
    dependencySmithersNodeIds: [],
    timeoutMs: 60000,
    heartbeatTimeoutMs: 60000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs: [],
    execution,
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: { ultrafuzzRunId: "example-run", smithersWorkflowName: WORKFLOW_ID, graphVersion: "4", topologyVersion: 2 },
      node: {
        concreteNodeId: node.id,
        logicalNodeId: node.logical_id,
        attemptId: id,
        label: node.display_name,
        kind: "agentic",
        promptPath: node.prompt_path
      },
      dependencies: { concreteNodeIds: [], attemptIds: [], smithersNodeIds: [] },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      model: {
        profileId: "default",
        agentRef: "CodexAgent",
        modelIndex: node.model_fanout.find((model) => model.attempt_id === id)?.model_index ?? 0,
        attemptIndex: 0,
        agentChain
      },
      workspace: { primitive: "worktree", path: workspacePath, repoPath: "/repo", trustModel: "skip-permissions" },
      artifacts: {
        dir: artifactDir,
        outputs: node.outputs.map((output) => ({
          path: output.path,
          contract: output.contract,
          contractDigest: output.contract_digest,
          primary: output.primary
        })),
        manifestPath: `${artifactDir}/artifact-manifest.json`
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60000, seconds: 60, heartbeatTimeoutMs: 60000 },
      execution: { mode: execution.mode, resources: execution.resources }
    }
  };
}

function setOutcome(fixture: Fixture, id: string, status: NodeStatus): void {
  const node = createNodeState({ id, status, waitSince: TIME });
  fixture.state.nodes[id] = node;
  if (status !== "failed" && status !== "timed-out" && status !== "skipped") return;
  const category =
    status === "timed-out" ? "provider-interruption" : status === "skipped" ? "dependency-cascade" : "agent-failure";
  node.timed_out = status === "timed-out";
  node.provenance = {
    workflow: {
      run_id: WORKFLOW_ID,
      task_id: `node:${id}`,
      agent_task_id: `node:${id}`,
      verifier_task_id: `verify:${id}`,
      state: status === "skipped" ? "skipped" : "failed",
      attempt: 1
    },
    failure: {
      category,
      causal_task_id: `node:${id}`,
      causal_failure_category: status === "timed-out" ? "provider-interruption" : "agent-failure",
      dependent_task_ids: []
    }
  };
}

function provenance(fixture: Fixture, id: string): ExecutionNodeProvenance {
  return required(required(fixture.state.nodes[id]).provenance) as ExecutionNodeProvenance;
}

function workflow(fixture: Fixture, id: string) {
  const result = required(provenance(fixture, id).workflow);
  assert.ok("task_id" in result);
  return result;
}

function dependOn(fixture: Fixture, id: string, dependency: string): void {
  required(fixture.graph.nodes.find((node) => node.id === id)).depends_on.push(dependency);
  const task = required(fixture.tasks.tasks.find((candidate) => candidate.attemptId === id));
  task.dependencies.push(dependency);
  task.dependencySmithersNodeIds.push(`verify:${dependency}`);
  task.metadata.dependencies.concreteNodeIds.push(dependency);
  task.metadata.dependencies.attemptIds.push(dependency);
  task.metadata.dependencies.smithersNodeIds.push(`verify:${dependency}`);
  task.dependencyArtifactDirs.push(`${ROOT}/artifacts/${dependency}`);
}

function addDynamicGroup(fixture: Fixture, id: string, status: "pending" | "expanded"): void {
  const node = graphNode(id);
  delete node.workflow;
  node.dynamic = {
    from: { node: "enumerator", path: "items.json" },
    key: "id",
    node_id: "item-{id}",
    status,
    ...(status === "expanded" ? { generated_node_ids: [] } : {})
  };
  fixture.graph.nodes.push(node);
  fixture.state.nodes[id] = createNodeState({
    id,
    status: status === "expanded" ? "succeeded" : "pending",
    waitSince: TIME
  });
}

function snapshot(fixture: Fixture): VerifiedRunOutputAuthoritySnapshot {
  const file = (name: string, value: unknown) => ({
    path: `${ROOT}/${name}`,
    bytes: Buffer.from(JSON.stringify(value))
  });
  return {
    run_root: ROOT,
    state: file("state.json", fixture.state),
    graph: file("graph.json", fixture.graph),
    workflow_tasks: file("smithers/tasks.json", fixture.tasks),
    graph_fingerprint: file("graph-fingerprint.json", {}),
    workflow_control_seal: file("smithers/control-integrity.json", {}),
    artifact_manifests: [],
    outputs: fixture.tasks.tasks
      .filter((task) => fixture.state.nodes[task.attemptId]?.status === "succeeded")
      .map((task) => ({
        run_root: ROOT,
        attempt_id: task.attemptId,
        logical_node_id: task.logicalNodeId,
        artifact_dir: task.artifactDir,
        outputs: [],
        publications: []
      }))
  };
}

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
