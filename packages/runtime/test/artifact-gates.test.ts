import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaDirectory,
  createInitialRunState,
  createRunLayout,
  derivePropertyImplementationCoverage,
  getNodeArtifactDir,
  readRunState,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  updateNodeState,
  validateRegisteredJsonFileSync,
  writeArtifact as writeArtifactFile,
  writeArtifactManifest,
  writeJsonDurable,
  writeRunState,
  type ArtifactVerificationMarker,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { loadBuiltInPromptAssets } from "@ultrafuzz/prompts";

import {
  captureWorkspacePatch,
  captureWorkspaceTree,
  dependencyGateForNode,
  verifyRequiredArtifactsForAttempt as verifyRuntimeRequiredArtifactsForAttempt,
  type AuthenticatedArtifactGateSnapshots,
  type ArtifactGateAttemptAuthority,
  type PlannedGraphNode
} from "../src/index.js";
import { WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION } from "../src/runtime-contracts.js";

const CAMPAIGN_EVIDENCE_BYTES = Buffer.from("x", "utf8");
const CAMPAIGN_EVIDENCE_SHA256 = createHash("sha256").update(CAMPAIGN_EVIDENCE_BYTES).digest("hex");

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-gates-"));
}

function writeCoverageLcov(
  workspace: string,
  sources: Readonly<Record<string, Readonly<Record<number, number>>>>,
  relativePath = "coverage-input.lcov"
): { path: string; sha256: string } {
  const lcovPath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(lcovPath), { recursive: true });
  const lines = Object.entries(sources).flatMap(([source, hits]) => [
    `SF:${source}`,
    ...Object.entries(hits).map(([line, count]) => `DA:${line},${count}`),
    "end_of_record"
  ]);
  const bytes = Buffer.from(lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  fs.writeFileSync(lcovPath, bytes);
  return { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function writeReconCoverageSelection(workspace: string, selection: unknown): { path: string; sha256: string } {
  const contents = JSON.stringify(selection);
  const selectionPath = path.join(workspace, "magic/recon-coverage.json");
  fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
  fs.writeFileSync(selectionPath, contents);
  return {
    path: "recon-coverage.json",
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

const FIXTURE_WORKFLOW_RUN_ID = "workflow-artifact-gates";
const FIXTURE_AGENT_TASK_ID = "agent-artifact-gates";
const FIXTURE_VERIFIER_TASK_ID = "verifier-artifact-gates";

/**
 * Real planned runs record every logical producer in state before any artifact
 * gate executes. These focused fixtures write producer artifacts directly, so
 * keep the state index in sync instead of relying on the removed historical
 * artifact-directory fallback.
 */
function registerArtifactNode(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  outputs: readonly PlannedGraphNode["outputs"][number][] = []
): void {
  const state = readRunState(layout);
  const node = (state.nodes[nodeId] ??= {
    node_id: nodeId,
    logical_node_id: nodeId,
    status: "succeeded",
    retry_count: 0,
    timed_out: false
  });
  const declared = [...(node.outputs ?? [])];
  for (const output of outputs) {
    if (declared.some((candidate) => candidate.path === output.path && candidate.contract === output.contract))
      continue;
    declared.push(output);
  }
  if (declared.length > 0) node.outputs = declared;
  writeRunState(layout, state);
}

function writeArtifact(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  artifactPath: string,
  contents: string,
  contractOverride?: PlannedGraphNode["outputs"][number]["contract"]
): string {
  const contract = contractOverride ?? fixtureDeclaredContract(artifactPath);
  const existingOutputs = readRunState(layout).nodes[nodeId]?.outputs ?? [];
  const declaredOutputs =
    contract === undefined
      ? []
      : [
          boundOutput(artifactPath, contract, !existingOutputs.some((output) => output.primary === true)),
          ...(contract === "ultrafuzz/invariant-ledger@1"
            ? [boundOutput("setup/project-discovery.md", "ultrafuzz/nonempty-markdown@1", false)]
            : contract === "ultrafuzz/properties@2"
              ? [boundOutput("properties.md", "ultrafuzz/nonempty-markdown@1", false)]
              : [])
        ];
  registerArtifactNode(layout, nodeId, declaredOutputs);
  const written = writeArtifactFile(layout, nodeId, artifactPath, contents);
  if (contract === "ultrafuzz/invariant-ledger@1") {
    const markdownPath = path.join(getNodeArtifactDir(layout, nodeId), "setup/project-discovery.md");
    if (!fs.existsSync(markdownPath)) {
      writeArtifactFile(layout, nodeId, "setup/project-discovery.md", fixtureInvariantLedgerMarkdown(contents));
    }
  } else if (contract === "ultrafuzz/properties@2") {
    const markdownPath = path.join(getNodeArtifactDir(layout, nodeId), "properties.md");
    if (!fs.existsSync(markdownPath)) {
      writeArtifactFile(layout, nodeId, "properties.md", fixtureCanonicalPropertiesMarkdown(contents));
    }
  }
  materializeFixtureCampaignEvidence(layout, nodeId, contents);
  if (declaredOutputs.length > 0) {
    const registeredOutputs = readRunState(layout).nodes[nodeId]?.outputs ?? declaredOutputs;
    const availableOutputs = registeredOutputs.filter((output) =>
      fs.existsSync(path.join(getNodeArtifactDir(layout, nodeId), output.path))
    );
    finalizeArtifactNode(
      layout,
      nodeId,
      availableOutputs,
      {},
      declaredFixtureCampaignEvidencePaths(layout, nodeId, availableOutputs)
    );
  }
  return written;
}

function fixtureCanonicalPropertiesMarkdown(contents: string): string {
  const document = JSON.parse(contents) as {
    properties: Array<{
      id: string;
      description: string;
      category: string;
      priority: string;
      sources: Array<{ source_node_id: string; source_property_id: string }>;
      ledger_ids?: string[];
      reference_expectations?: string[];
    }>;
  };
  return document.properties
    .flatMap((property) => [
      `### Canonical property: ${JSON.stringify(property.id)}`,
      `description: ${JSON.stringify(property.description)}`,
      `category: ${JSON.stringify(property.category)}`,
      `priority: ${JSON.stringify(property.priority)}`,
      `sources: ${JSON.stringify(property.sources)}`,
      ...((property.ledger_ids?.length ?? 0) === 0 ? [] : [`ledger_ids: ${JSON.stringify(property.ledger_ids)}`]),
      ...((property.reference_expectations?.length ?? 0) === 0
        ? []
        : [`reference_expectations: ${JSON.stringify(property.reference_expectations)}`]),
      `### End canonical property: ${JSON.stringify(property.id)}`
    ])
    .join("\n");
}

function fixtureInvariantLedgerMarkdown(contents: string): string {
  const document = JSON.parse(contents) as {
    entries: Array<{
      id: string;
      source_path: string;
      source_location: string;
      kind: string;
      verbatim: string;
      inventory_ids: string[];
    }>;
    inventory_rows?: Array<{ id: string; description: string; ledger_ids: string[] }>;
  };
  const lines = ["# Discovery"];
  for (const entry of document.entries) {
    lines.push(
      `### Ledger entry: ${JSON.stringify(entry.id)}`,
      `source_path: ${JSON.stringify(entry.source_path)}`,
      `source_location: ${JSON.stringify(entry.source_location)}`,
      `kind: ${JSON.stringify(entry.kind)}`,
      `verbatim: ${JSON.stringify(entry.verbatim)}`,
      `inventory_ids: ${JSON.stringify(entry.inventory_ids)}`,
      `### End ledger entry: ${JSON.stringify(entry.id)}`
    );
  }
  for (const row of document.inventory_rows ?? []) {
    lines.push(
      `### Inventory row: ${JSON.stringify(row.id)}`,
      `description: ${JSON.stringify(row.description)}`,
      `ledger_ids: ${JSON.stringify(row.ledger_ids)}`,
      `### End inventory row: ${JSON.stringify(row.id)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function materializeFixtureCampaignEvidence(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  contents: string
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  // Campaign fixtures declare exact evidence bytes. Materialize those
  // companions alongside the document so ordinary host-gate fixtures model
  // the generated verifier's publication boundary.
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { schema_version?: unknown }).schema_version === "ultrafuzz.property-campaign.v3"
  ) {
    const evidenceFiles = (parsed as { evidence_files?: unknown }).evidence_files;
    const materialized: string[] = [];
    if (Array.isArray(evidenceFiles)) {
      for (const entry of evidenceFiles) {
        if (typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string") {
          const evidencePath = (entry as { path: string }).path;
          writeArtifactFile(layout, nodeId, evidencePath, CAMPAIGN_EVIDENCE_BYTES);
          materialized.push(evidencePath);
        }
      }
    }
    return materialized;
  }
  return [];
}

function declaredFixtureCampaignEvidencePaths(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  outputs: readonly PlannedGraphNode["outputs"][number][]
): string[] {
  const artifactDir = getNodeArtifactDir(layout, nodeId);
  const evidencePaths = outputs.flatMap((output) => {
    if (output.contract !== "ultrafuzz/property-campaign@3") return [];
    const document = JSON.parse(fs.readFileSync(path.join(artifactDir, output.path), "utf8")) as {
      evidence_files?: Array<{ path?: unknown }>;
    };
    return (document.evidence_files ?? []).flatMap((entry) => (typeof entry.path === "string" ? [entry.path] : []));
  });
  return [...new Set(evidencePaths)];
}

function fixtureDeclaredContract(artifactPath: string): PlannedGraphNode["outputs"][number]["contract"] | undefined {
  if (artifactPath === "setup/invariant-evidence-ledger.json") return "ultrafuzz/invariant-ledger@1";
  if (artifactPath === "properties.json") return "ultrafuzz/properties@2";
  if (artifactPath === "implemented-properties.json") return "ultrafuzz/implemented-properties@3";
  if (["recon-fuzzer-results.json", "echidna-results.json", "medusa-results.json"].includes(artifactPath)) {
    return "ultrafuzz/property-campaign@3";
  }
  if (artifactPath === "campaign-plan.json") return "ultrafuzz/invariant-campaign-plan@2";
  if (artifactPath === "campaign-summary.json") return "ultrafuzz/campaign-summary@2";
  if (artifactPath === "coverage-goal.json") return "ultrafuzz/coverage-goal@2";
  if (artifactPath === "coverage-evidence.json") return "ultrafuzz/coverage-evidence@1";
  if (artifactPath === "findings.json") return "ultrafuzz/findings@2";
  if (artifactPath === "triaged-findings.json") return "ultrafuzz/triaged-findings@1";
  if (artifactPath === "report.json") return "ultrafuzz/report@3";
  return undefined;
}

function writePropertyLens(
  layout: ReturnType<typeof createRunLayout>,
  logicalNodeId: string,
  propertyIds: readonly string[]
): void {
  const lensName = logicalNodeId.replace(/^property-specification-/u, "");
  const lensPath = `properties/${lensName}.json`;
  writeDeclaredPropertyLens(
    layout,
    logicalNodeId,
    lensPath,
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: propertyIds.map((id) => ({
        id,
        description: `Source property ${id}`,
        category: "accounting",
        priority: "high"
      }))
    })
  );
}

function writeDeclaredPropertyLens(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  artifactPath: string,
  contents: string
): string {
  const outputs = [boundOutput(artifactPath, "ultrafuzz/property-lens@2", true)];
  registerArtifactNode(layout, nodeId, outputs);
  const written = writeArtifactFile(layout, nodeId, artifactPath, contents);
  finalizeArtifactNode(layout, nodeId, outputs);
  return written;
}

function writeDeclaredArtifactNode(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  outputs: readonly PlannedGraphNode["outputs"][number][],
  contents: Readonly<Record<string, string>>
): void {
  registerArtifactNode(layout, nodeId, outputs);
  const campaignEvidencePaths: string[] = [];
  for (const output of outputs) {
    const value = contents[output.path];
    if (value === undefined) throw new Error(`missing fixture contents for ${output.path}`);
    writeArtifactFile(layout, nodeId, output.path, value);
    campaignEvidencePaths.push(...materializeFixtureCampaignEvidence(layout, nodeId, value));
  }
  finalizeArtifactNode(layout, nodeId, outputs, {}, [
    ...new Set([...campaignEvidencePaths, ...declaredFixtureCampaignEvidencePaths(layout, nodeId, outputs)])
  ]);
}

function writeMeasuredCoverageArtifacts(
  layout: ReturnType<typeof createRunLayout>,
  node: PlannedGraphNode,
  workspace: string,
  artifacts: { goal?: unknown; markdown: string; evidence: unknown }
): void {
  const lcovPath = node.outputs.find(
    (output) => output.contract === "ultrafuzz/text@1" && /\.lcov$/iu.test(output.path)
  )?.path;
  if (lcovPath === undefined) throw new Error("coverage fixture requires one declared LCOV text output");
  const contents: Record<string, string> = {
    "coverage-report.md": artifacts.markdown,
    "coverage-evidence.json": JSON.stringify(artifacts.evidence),
    [lcovPath]: fs.readFileSync(path.join(workspace, lcovPath), "utf8"),
    "recon-coverage.json": fs.readFileSync(path.join(workspace, "magic/recon-coverage.json"), "utf8")
  };
  if (artifacts.goal !== undefined) contents["coverage-goal.json"] = JSON.stringify(artifacts.goal);
  writeDeclaredArtifactNode(layout, node.id, node.outputs, contents);
}

function writeMinimalPropertyFaninFixture(
  layout: ReturnType<typeof createRunLayout>,
  options: {
    sourceNodeId?: string;
    sourcePropertyId?: string;
    dependsOn?: readonly string[];
    referenceExpectation?: string;
  } = {}
): PlannedGraphNode {
  const sourceNodeId = options.sourceNodeId ?? "property-specification-recon";
  const sourcePropertyId = options.sourcePropertyId ?? "recon-1";
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-1",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-1"]
        }
      ],
      inventory_rows: [
        { id: "inventory-1", description: "Supply accounting remains consistent.", ledger_ids: ["evidence-1"] }
      ],
      scan_probes: []
    })
  );
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-1",
        description: "Supply accounting remains consistent.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: sourceNodeId, source_property_id: sourcePropertyId }],
        ledger_ids: ["evidence-1"],
        ...(options.referenceExpectation === undefined
          ? {}
          : { reference_expectations: [options.referenceExpectation] })
      }
    ]
  });
  writeArtifact(layout, "property-specification-fanin", "properties.json", catalog);
  writeArtifact(layout, "property-specification-fanin", "properties.md", fixtureCanonicalPropertiesMarkdown(catalog));
  return {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: [...(options.dependsOn ?? ["property-specification-recon"])]
  };
}

function writePlannedGraph(layout: ReturnType<typeof createRunLayout>, nodes: readonly PlannedGraphNode[]): void {
  fs.writeFileSync(
    layout.graphPath,
    JSON.stringify({
      schema_version: "ultrafuzz.planned-graph.v4",
      graph_version: "4",
      topology_version: 2,
      groups: {},
      nodes
    }),
    "utf8"
  );
}

function inferredFixtureDependencies(
  graph: { nodes: PlannedGraphNode[] },
  outputs: readonly PlannedGraphNode["outputs"][number][],
  explicitDependencies: readonly string[] = []
): string[] {
  const contracts = new Set(outputs.map((output) => output.contract));
  const requiredContracts = new Set<PlannedGraphNode["outputs"][number]["contract"]>();
  if (contracts.has("ultrafuzz/property-lens@2")) requiredContracts.add("ultrafuzz/invariant-ledger@1");
  if (contracts.has("ultrafuzz/properties@2")) {
    if (explicitDependencies.length === 0) requiredContracts.add("ultrafuzz/property-lens@2");
    requiredContracts.add("ultrafuzz/invariant-ledger@1");
  }
  if (contracts.has("ultrafuzz/implemented-properties@3")) requiredContracts.add("ultrafuzz/properties@2");
  if (contracts.has("ultrafuzz/property-campaign@3")) {
    requiredContracts.add("ultrafuzz/implemented-properties@3");
  }
  if (contracts.has("ultrafuzz/report@3")) {
    requiredContracts.add("ultrafuzz/properties@2");
    requiredContracts.add("ultrafuzz/implemented-properties@3");
    requiredContracts.add("ultrafuzz/property-campaign@3");
    requiredContracts.add("ultrafuzz/triaged-findings@1");
  }
  if (contracts.has("ultrafuzz/severity-classified-findings@1")) {
    requiredContracts.add("ultrafuzz/triaged-findings@1");
  }
  return graph.nodes
    .filter((candidate) => candidate.outputs.some((output) => requiredContracts.has(output.contract)))
    .map((candidate) => candidate.id);
}

function registerMissingFixtureDependencies(
  layout: ReturnType<typeof createRunLayout>,
  graph: { nodes: PlannedGraphNode[] },
  dependencyIds: readonly string[],
  consumerOutputs: readonly PlannedGraphNode["outputs"][number][]
): void {
  const state = readRunState(layout);
  for (const dependencyId of dependencyIds) {
    if (graph.nodes.some((candidate) => candidate.id === dependencyId)) continue;
    const nodeState = state.nodes[dependencyId];
    const stateOutputs = nodeState?.outputs ?? [];
    const outputs =
      stateOutputs.length > 0
        ? stateOutputs.map((output, index) => boundOutput(output.path, output.contract, index === 0))
        : consumerOutputs.some((output) => output.contract === "ultrafuzz/properties@2")
          ? [boundOutput(`properties/${dependencyId}.json`, "ultrafuzz/property-lens@2", true)]
          : [boundOutput("fixture.md", "ultrafuzz/nonempty-markdown@1", true)];
    graph.nodes.push({
      ...plannedNode([]),
      id: dependencyId,
      logical_id: nodeState?.logical_node_id ?? dependencyId,
      display_name: nodeState?.logical_node_id ?? dependencyId,
      artifact_dir: `artifacts/${dependencyId}`,
      depends_on: inferredFixtureDependencies(graph, outputs),
      outputs
    });
  }
}

function verifyRequiredArtifactsForAttempt(
  layout: ReturnType<typeof createRunLayout>,
  node: PlannedGraphNode,
  attemptId: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: Parameters<typeof verifyRuntimeRequiredArtifactsForAttempt>[4]
): ReturnType<typeof verifyRuntimeRequiredArtifactsForAttempt> {
  const graph = JSON.parse(fs.readFileSync(layout.graphPath, "utf8")) as {
    schema_version: string;
    graph_version: string;
    topology_version: number;
    groups: Record<string, unknown>;
    nodes: PlannedGraphNode[];
  };
  const existing = graph.nodes.find((candidate) => candidate.id === node.id);
  const explicitDependencies = [...new Set([...(existing?.depends_on ?? []), ...node.depends_on])].filter(
    (dependency) => dependency !== node.id
  );
  registerMissingFixtureDependencies(layout, graph, explicitDependencies, node.outputs);
  const planned = {
    ...node,
    artifact_dir: `artifacts/${node.id}`,
    depends_on: [
      ...new Set([
        ...(existing?.depends_on ?? []),
        ...node.depends_on,
        ...inferredFixtureDependencies(graph, node.outputs, node.depends_on)
      ])
    ].filter((dependency) => dependency !== node.id)
  };
  const existingIndex = graph.nodes.findIndex((candidate) => candidate.id === node.id);
  if (existingIndex === -1) graph.nodes.push(planned);
  else graph.nodes[existingIndex] = planned;
  fs.writeFileSync(layout.graphPath, JSON.stringify(graph), "utf8");
  writeSealedFixtureTaskAuthority(layout, graph.nodes, attemptAuthority?.tasks);
  return verifyRuntimeRequiredArtifactsForAttempt(layout, planned, attemptId, attemptAuthority, authenticated);
}

function fixtureAttemptIds(node: PlannedGraphNode): string[] {
  const workflowAttempts = node.workflow?.task_node_ids.map((taskNodeId) => taskNodeId.replace(/^node:/u, ""));
  if (workflowAttempts !== undefined && workflowAttempts.length > 0) return workflowAttempts;
  if (node.model_fanout.length <= 1) return [node.id];
  return node.model_fanout.map((model) => `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`);
}

function syntheticFixtureTasks(
  layout: ReturnType<typeof createRunLayout>,
  nodes: readonly PlannedGraphNode[]
): SmithersTaskManifestTask[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node] as const));
  const ancestorIds = (node: PlannedGraphNode): Set<string> => {
    const ancestors = new Set<string>();
    const pending = [...node.depends_on];
    while (pending.length > 0) {
      const dependencyId = pending.pop()!;
      if (ancestors.has(dependencyId)) continue;
      ancestors.add(dependencyId);
      pending.push(...(nodesById.get(dependencyId)?.depends_on ?? []));
    }
    return ancestors;
  };
  return nodes
    .filter((node) => node.kind === "agentic")
    .flatMap((node) => {
      const attempts = fixtureAttemptIds(node);
      const dependencies = node.depends_on.flatMap((dependencyId) => {
        const dependency = nodesById.get(dependencyId);
        return dependency === undefined || dependency.kind === "reference"
          ? [dependencyId]
          : fixtureAttemptIds(dependency);
      });
      const dependencyArtifactDirs = nodes
        .filter((candidate) => ancestorIds(node).has(candidate.id))
        .flatMap((candidate) => fixtureAttemptIds(candidate))
        .map((ancestorAttemptId) => getNodeArtifactDir(layout, ancestorAttemptId, { create: true }));
      const dependencySmithersNodeIds = node.depends_on.flatMap((dependencyId) => {
        const dependency = nodesById.get(dependencyId);
        return dependency?.kind === "agentic"
          ? fixtureAttemptIds(dependency).map((dependencyAttemptId) => `verify:${dependencyAttemptId}`)
          : [];
      });
      return attempts.map((attemptId, modelIndex) => {
        const task = smithersTaskForNode({
          layout,
          node,
          attemptId,
          dependencies,
          dependencyArtifactDirs,
          modelIndex
        });
        return {
          ...task,
          dependencySmithersNodeIds,
          metadata: {
            ...task.metadata,
            dependencies: { ...task.metadata.dependencies, smithersNodeIds: dependencySmithersNodeIds }
          }
        };
      });
    });
}

function writeSealedFixtureTaskAuthority(
  layout: ReturnType<typeof createRunLayout>,
  nodes: readonly PlannedGraphNode[],
  suppliedTasks?: readonly SmithersTaskManifestTask[]
): void {
  const sealedNodes = nodes.map((node) => {
    if (node.kind !== "agentic" || node.workflow !== undefined) return node;
    const attempts = fixtureAttemptIds(node);
    return {
      ...node,
      workflow: { node_id: `node:${attempts[0]!}`, task_node_ids: attempts.map((attemptId) => `node:${attemptId}`) }
    };
  });
  const graphDocument = JSON.parse(fs.readFileSync(layout.graphPath, "utf8")) as {
    schema_version: string;
    graph_version: string;
    topology_version: number;
    groups: Record<string, unknown>;
    nodes: PlannedGraphNode[];
  };
  graphDocument.nodes = sealedNodes;
  fs.writeFileSync(layout.graphPath, JSON.stringify(graphDocument), "utf8");
  const tasks = suppliedTasks === undefined ? syntheticFixtureTasks(layout, sealedNodes) : [...suppliedTasks];
  const smithersRoot = path.join(layout.root, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  const tasksPath = path.join(smithersRoot, "tasks.json");
  const document: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: layout.runId,
    smithers_run_id: `ultrafuzz-${layout.runId}`,
    workflow_name: FIXTURE_WORKFLOW_RUN_ID,
    pinned_submodules: null,
    tasks
  };
  writeJsonDurable(tasksPath, document);
  const graphBytes = fs.readFileSync(layout.graphPath);
  const taskBytes = fs.readFileSync(tasksPath);
  const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const emptyFile = { sha256: digest(Buffer.alloc(0)), size_bytes: 0 };
  const state = readRunState(layout);
  if (!/^[a-f0-9]{64}$/u.test(state.graph_fingerprint)) state.graph_fingerprint = "f".repeat(64);
  if (!/^[a-f0-9]{64}$/u.test(state.config_fingerprint)) state.config_fingerprint = "e".repeat(64);
  writeRunState(layout, state);
  writeJsonDurable(path.join(smithersRoot, "control-integrity.json"), {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: layout.runId,
    files: {
      graph: { sha256: digest(graphBytes), size_bytes: graphBytes.byteLength },
      expanded_graph: emptyFile,
      graph_fingerprint: emptyFile,
      config: emptyFile,
      tasks: { sha256: digest(taskBytes), size_bytes: taskBytes.byteLength },
      input: emptyFile,
      workflow: emptyFile,
      evidence_workflow: emptyFile
    },
    execution_files: [],
    bindings: {
      run_id: layout.runId,
      graph_fingerprint: state.graph_fingerprint,
      config_fingerprint: state.config_fingerprint,
      expected_state_node_ids: sealedNodes.map((candidate) => candidate.id).sort(),
      expected_task_attempt_ids: tasks.map((task) => task.attemptId).sort(),
      expected_task_node_ids: tasks
        .flatMap((task) => [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId])
        .sort()
    }
  });
}

function boundOutput(
  artifactPath: string,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  primary = false
): PlannedGraphNode["outputs"][number] {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary
  };
}

function smithersTaskForNode(input: {
  layout: ReturnType<typeof createRunLayout>;
  node: PlannedGraphNode;
  attemptId: string;
  dependencies?: string[];
  dependencyArtifactDirs?: string[];
  modelIndex?: number;
}): SmithersTaskManifestTask {
  const dependencies = input.dependencies ?? [];
  const dependencyArtifactDirs = input.dependencyArtifactDirs ?? [];
  const outputs = input.node.outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    ...(output.schema_file === undefined ? {} : { schemaFile: output.schema_file }),
    ...(output.schema_id === undefined ? {} : { schemaId: output.schema_id }),
    ...(output.schema_sha256 === undefined ? {} : { schemaSha256: output.schema_sha256 }),
    ...(output.schema_bundle_sha256 === undefined ? {} : { schemaBundleSha256: output.schema_bundle_sha256 }),
    ...(output.validator_build === undefined ? {} : { validatorBuild: output.validator_build }),
    primary: output.primary
  }));
  const artifactDir = getNodeArtifactDir(input.layout, input.attemptId, { create: true });
  const workspacePath = path.join(input.layout.workspacesDir, input.attemptId);
  const model = input.node.model_fanout.find((candidate) => candidate.model_index === (input.modelIndex ?? 0));
  const agentRef = model?.agent_ref ?? "CodexAgent";
  const modelName = model?.model_name ?? "gpt-test";
  const reasoningEffort = model?.reasoning_effort ?? "high";
  const agentChain = [
    {
      profileId: model?.model_profile_id ?? "default",
      agentRef,
      modelName,
      reasoningEffort,
      role: "primary" as const
    }
  ];
  return {
    attemptId: input.attemptId,
    concreteNodeId: input.node.id,
    logicalNodeId: input.node.logical_id,
    preparationSmithersNodeId: `prepare:${input.attemptId}`,
    smithersNodeId: `node:${input.attemptId}`,
    verifierSmithersNodeId: `verify:${input.attemptId}`,
    agentRef,
    agentChain,
    modelName,
    reasoningEffort,
    dependencies,
    dependencySmithersNodeIds: dependencies.map((dependency) => `verify:${dependency}`),
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    renderedPromptPath: path.join(input.layout.root, "prompts", `${input.attemptId}.md`),
    execution: {
      mode: "local",
      resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 },
      agentCredentialEnv: []
    },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: input.layout.runId,
        smithersWorkflowName: "workflow-artifact-gates",
        graphVersion: "4",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: input.node.id,
        logicalNodeId: input.node.logical_id,
        attemptId: input.attemptId,
        label: input.node.display_name,
        kind: "agentic",
        promptPath: input.node.prompt_path
      },
      dependencies: {
        concreteNodeIds: [...input.node.depends_on],
        attemptIds: dependencies,
        smithersNodeIds: dependencies.map((dependency) => `verify:${dependency}`)
      },
      loop: {
        index: input.node.loop.index,
        count: input.node.loop.count,
        mode: input.node.loop.mode,
        attemptIndex: input.node.loop.attempt_index
      },
      model: {
        profileId: model?.model_profile_id ?? "default",
        agentRef,
        modelName,
        reasoningEffort,
        modelIndex: model?.model_index ?? input.modelIndex ?? 0,
        attemptIndex: model?.attempt_index ?? input.node.loop.attempt_index,
        agentChain
      },
      workspace: {
        primitive: "worktree",
        path: workspacePath,
        repoPath: "/repo",
        trustModel: "skip-permissions"
      },
      artifacts: {
        dir: artifactDir,
        outputs,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 } }
    }
  };
}

function sealedTaskForNode(
  layout: ReturnType<typeof createRunLayout>,
  node: PlannedGraphNode,
  dependencies: readonly SmithersTaskManifestTask[] = []
): SmithersTaskManifestTask {
  const dependencyArtifactDirs = [
    ...new Set(dependencies.flatMap((dependency) => [...dependency.dependencyArtifactDirs, dependency.artifactDir]))
  ];
  return smithersTaskForNode({
    layout,
    node,
    attemptId: node.id,
    dependencies: dependencies.map((dependency) => dependency.attemptId),
    dependencyArtifactDirs
  });
}

function authenticatedSnapshotsForNode(
  layout: ReturnType<typeof createRunLayout>,
  node: PlannedGraphNode,
  attemptId = node.id
): AuthenticatedArtifactGateSnapshots {
  const artifactDir = getNodeArtifactDir(layout, attemptId);
  const snapshots = node.outputs.flatMap((output) => {
    const absolutePath = path.join(artifactDir, output.path);
    if (!fs.existsSync(absolutePath)) return [];
    return [[output.path, { absolutePath, bytes: fs.readFileSync(absolutePath) }] as const];
  });
  return {
    outputs: new Map(snapshots),
    publications: new Map(snapshots.map(([artifactPath, snapshot]) => [artifactPath, Buffer.from(snapshot.bytes)]))
  };
}

function finalizeArtifactNode(
  layout: ReturnType<typeof createRunLayout>,
  nodeId: string,
  outputs: readonly PlannedGraphNode["outputs"][number][],
  identity: { concreteNodeId?: string; logicalNodeId?: string; modelIndex?: number } = {},
  additionalPublicationPaths: readonly string[] = []
): void {
  const state = readRunState(layout);
  const concreteNodeId = identity.concreteNodeId ?? nodeId;
  const logicalNodeId = identity.logicalNodeId ?? state.nodes[nodeId]?.logical_node_id ?? nodeId;
  if (state.nodes[nodeId] !== undefined) {
    state.nodes[nodeId]!.logical_node_id = logicalNodeId;
    state.nodes[nodeId]!.outputs = [...outputs];
    writeRunState(layout, state);
  }
  const graph = JSON.parse(fs.readFileSync(layout.graphPath, "utf8")) as {
    schema_version: string;
    graph_version: string;
    topology_version: number;
    groups: Record<string, unknown>;
    nodes: PlannedGraphNode[];
  };
  const existingIndex = graph.nodes.findIndex((node) => node.id === concreteNodeId);
  const existing = existingIndex === -1 ? undefined : graph.nodes[existingIndex];
  const planned: PlannedGraphNode = {
    ...(existing ?? plannedNode([])),
    id: concreteNodeId,
    logical_id: logicalNodeId,
    display_name: existing?.display_name ?? logicalNodeId,
    artifact_dir: `artifacts/${concreteNodeId}`,
    depends_on:
      existing === undefined
        ? inferredFixtureDependencies(graph, outputs).filter((dependency) => dependency !== concreteNodeId)
        : existing.depends_on,
    outputs: [...outputs]
  };
  if (existingIndex === -1) graph.nodes.push(planned);
  else graph.nodes[existingIndex] = planned;
  fs.writeFileSync(layout.graphPath, JSON.stringify(graph), "utf8");

  const publicationPaths = [...new Set([...outputs.map((output) => output.path), ...additionalPublicationPaths])];
  const publicationBytes = new Map(
    publicationPaths.map((publicationPath) => [
      publicationPath,
      fs.readFileSync(path.join(getNodeArtifactDir(layout, nodeId), publicationPath))
    ])
  );
  writeArtifactManifest({
    layout,
    nodeId,
    include: publicationPaths,
    outputs: [...outputs],
    prerequisiteNodeIds: planned.depends_on,
    provenance: {
      producer_node_id: nodeId,
      logical_node_id: logicalNodeId,
      attempt_index: 0,
      loop_index: 0,
      model_index: identity.modelIndex ?? 0,
      agent_ref: "Codex",
      workflow_run_id: FIXTURE_WORKFLOW_RUN_ID,
      workflow_task_id: FIXTURE_AGENT_TASK_ID,
      origin: "workflow",
      metadata: { concrete_node_id: concreteNodeId }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: nodeId,
    node_id: logicalNodeId,
    artifacts: outputs.map((output) => ({
      ...output,
      sha256: createHash("sha256").update(publicationBytes.get(output.path)!).digest("hex")
    })),
    publications: publicationPaths.map((publicationPath) => ({
      path: publicationPath,
      sha256: createHash("sha256").update(publicationBytes.get(publicationPath)!).digest("hex")
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${nodeId}.json`), marker);
  updateNodeState(layout, nodeId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    provenance: {
      workflow: {
        run_id: FIXTURE_WORKFLOW_RUN_ID,
        task_id: FIXTURE_VERIFIER_TASK_ID,
        agent_task_id: FIXTURE_AGENT_TASK_ID,
        verifier_task_id: FIXTURE_VERIFIER_TASK_ID,
        state: "finished",
        attempt: 0
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: createHash("sha256")
          .update(fs.readFileSync(path.join(getNodeArtifactDir(layout, nodeId), "artifact-manifest.json")))
          .digest("hex")
      }
    }
  });
}

function currentFinding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id,
    title: "Property failure",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "The property failed.",
    ...overrides
  };
}

function currentReport(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: {
      run_id: runId,
      source_run_id: runId,
      repository: ".",
      elapsed_time: "0s",
      models_used: [],
      tokens_used: "0",
      estimated_spend: "$0",
      partial_pricing: false,
      strategy_loops: 1,
      audit_profile: "full",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_digest: "b".repeat(64),
      prompt_digest: "c".repeat(64),
      expanded_graph_fingerprint: "d".repeat(64)
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

function currentNonProductionOutcome(id: string, sourceFindingId: string): Record<string, unknown> {
  return currentFinding(id, {
    title: "Non-production outcome",
    triage_classification: "undetermined",
    recommended_next_action: "Review the campaign evidence.",
    lifecycle: {
      dedupe_key: `dedupe-${id}`,
      source_artifacts: [
        {
          path: "findings.json",
          node_id: "stateful-invariant-campaign",
          finding_id: sourceFindingId,
          title: "Property failure",
          relationship: "primary"
        }
      ],
      strategy_hits: []
    }
  });
}

function currentImplementedCoverage(propertyIds: string[]): Record<string, unknown> {
  return {
    priority_threshold: "high",
    priorities: ["high"],
    selected_property_ids: propertyIds,
    implemented_property_ids: propertyIds,
    blocked_property_ids: [],
    pending_property_ids: [],
    deferred_property_ids: [],
    reference_expected_property_ids: [],
    reference_expectation_ids: [],
    blocker_summaries: []
  };
}

function reportCoverageMarkdown(coverage: Record<string, unknown>): string {
  const count = (field: string): number => (Array.isArray(coverage[field]) ? coverage[field].length : 0);
  const priorities = Array.isArray(coverage.priorities) ? coverage.priorities.join("<br>") : "unavailable";
  const blockers = Array.isArray(coverage.blocker_summaries)
    ? coverage.blocker_summaries.map((summary) => `- ${String(summary)}`)
    : [];
  return [
    "# Ultrafuzz report",
    "",
    "## Property implementation coverage",
    "",
    `- Priority threshold: \`${String(coverage.priority_threshold ?? "unavailable")}\``,
    `- Included priorities: \`${priorities}\``,
    `- Selected properties: \`${count("selected_property_ids")}\``,
    `- Implemented properties: \`${count("implemented_property_ids")}\``,
    `- Blocked properties: \`${count("blocked_property_ids")}\``,
    `- Pending properties: \`${count("pending_property_ids")}\``,
    `- Deferred properties: \`${count("deferred_property_ids")}\``,
    `- Reference expectation properties: \`${count("reference_expected_property_ids")}\``,
    ...(blockers.length === 0 ? [] : ["", "Blocker summaries:", ...blockers]),
    ""
  ].join("\n");
}

// A discovery workspace as a benchmark run sees it: a Git worktree whose pinned branch exists and
// whose tracked sources match it exactly.
function pinnedDiscoveryWorkspace(layout: ReturnType<typeof createRunLayout>): string {
  const workspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "Counter.sol"), "contract Counter {}\n");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: workspace, stdio: ["ignore", "ignore", "ignore"] });
  };
  git(["init", "--quiet", "--initial-branch=ultrafuzz-pinned"]);
  git(["config", "user.name", "Ultrafuzz test"]);
  git(["config", "user.email", "ultrafuzz@example.invalid"]);
  git(["add", "src/Counter.sol"]);
  git(["commit", "--quiet", "-m", "pinned"]);
  return workspace;
}

function invariantProbeLedger(probes: readonly Record<string, string>[]): string {
  return JSON.stringify({
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    // This fixture exercises scan-probe containment only, so it carries no
    // invariant entries and must say why (#292).
    no_invariants_justification:
      "the pinned scan probe fixture exercises probe containment only and declares no invariant",
    inventory_rows: [],
    scan_probes: probes
  });
}

function plannedNode(paths: string[]): PlannedGraphNode {
  return {
    id: "strategy-a",
    logical_id: "strategy-a",
    display_name: "Strategy A",
    kind: "agentic",
    depends_on: [],
    artifact_dir: "artifacts/strategy-a",
    outputs: paths.map((outputPath, index) => {
      const contract =
        outputPath === "workspace-patch.json"
          ? "ultrafuzz/workspace-patch@1"
          : outputPath === "generated-tests.json"
            ? "ultrafuzz/generated-tests@3"
            : outputPath === "findings.json"
              ? "ultrafuzz/findings@2"
              : outputPath === "properties.json"
                ? "ultrafuzz/properties@2"
                : outputPath === "implemented-properties.json"
                  ? "ultrafuzz/implemented-properties@3"
                  : outputPath === "setup/invariant-evidence-ledger.json"
                    ? "ultrafuzz/invariant-ledger@1"
                    : outputPath.startsWith("properties/") && outputPath.endsWith(".json")
                      ? "ultrafuzz/property-lens@2"
                      : ["echidna-results.json", "medusa-results.json", "recon-fuzzer-results.json"].includes(
                            outputPath
                          )
                        ? "ultrafuzz/property-campaign@3"
                        : outputPath === "campaign-plan.json"
                          ? "ultrafuzz/invariant-campaign-plan@2"
                          : outputPath === "campaign-summary.json"
                            ? "ultrafuzz/campaign-summary@2"
                            : outputPath === "coverage-goal.json"
                              ? "ultrafuzz/coverage-goal@2"
                              : outputPath === "coverage-evidence.json"
                                ? "ultrafuzz/coverage-evidence@1"
                                : outputPath === "report.json"
                                  ? "ultrafuzz/report@3"
                                  : "ultrafuzz/nonempty-markdown@1";
      return boundOutput(outputPath, contract, index === 0);
    }),
    prompt_id: "strategy-a",
    prompt_path: "strategies/strategy-a.md",
    loop: {
      index: 0,
      count: 1,
      mode: "parallel",
      attempt_index: 0
    },
    model_fanout: []
  };
}

function plannedMeasuredCoverageNode(
  paths: string[] = ["coverage-goal.json", "coverage-report.md", "coverage-evidence.json"]
): PlannedGraphNode {
  const rawPaths = ["coverage-input.lcov", "recon-coverage.json"];
  const node = plannedNode([...paths, ...rawPaths.filter((artifactPath) => !paths.includes(artifactPath))]);
  return {
    ...node,
    outputs: node.outputs.map((output) =>
      rawPaths.includes(output.path) ? boundOutput(output.path, "ultrafuzz/text@1", false) : output
    )
  };
}

function differentialNode(
  id: string,
  outputs: ReadonlyArray<readonly [string, PlannedGraphNode["outputs"][number]["contract"], boolean?]>,
  dependencies: readonly string[] = []
): PlannedGraphNode {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: [...dependencies],
    artifact_dir: `artifacts/${id}`,
    outputs: outputs.map(([artifactPath, contract, primary = false]) => boundOutput(artifactPath, contract, primary)),
    prompt_id: id,
    prompt_path: `strategies/differential/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function differentialTask(
  layout: ReturnType<typeof createRunLayout>,
  node: PlannedGraphNode,
  dependencies: readonly SmithersTaskManifestTask[]
): SmithersTaskManifestTask {
  return sealedTaskForNode(layout, node, dependencies);
}

function runArtifactPath(attemptId: string, artifactPath: string): string {
  return path.posix.join("artifacts", attemptId, artifactPath);
}

test("runtime differential gates consume only exact sealed ancestor and sibling declarations", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-differential-handoff" });
  const artifactPaths = {
    plan: "differential/planning/current.json",
    harness: "differential/harness/current.json",
    audit: "differential/audit/current.json",
    lane: "differential/lane/current.json",
    registry: "differential/triage/registry.json",
    triageA: "differential/triage/triage-a.json",
    triageB: "differential/triage/triage-b.json",
    repair: "differential/review/repair.json",
    gap: "differential/review/gaps.json",
    reportReview: "differential/review/report.json",
    findings: "differential/review/findings.json"
  } as const;
  const planNode = differentialNode("diff-plan-attempt", [[artifactPaths.plan, "ultrafuzz/differential-plan@1", true]]);
  const harnessNode = differentialNode(
    "diff-harness-attempt",
    [[artifactPaths.harness, "ultrafuzz/reference-harness@1", true]],
    [planNode.id]
  );
  const auditNode = differentialNode(
    "diff-audit-attempt",
    [[artifactPaths.audit, "ultrafuzz/audited-differential-lanes@1", true]],
    [harnessNode.id]
  );
  const laneNode = differentialNode(
    "diff-lane-attempt",
    [[artifactPaths.lane, "ultrafuzz/differential-lane-result@1", true]],
    [auditNode.id]
  );
  const triageNode = differentialNode(
    "diff-triage-attempt",
    [
      [artifactPaths.registry, "ultrafuzz/semantic-red-registry@1", true],
      [artifactPaths.triageA, "ultrafuzz/differential-red-triage@1"],
      [artifactPaths.triageB, "ultrafuzz/differential-red-triage@1"]
    ],
    [laneNode.id]
  );
  const reviewNode = differentialNode(
    "diff-review-attempt",
    [
      [artifactPaths.repair, "ultrafuzz/differential-repair-summary@1", true],
      [artifactPaths.gap, "ultrafuzz/differential-gap-review@1"],
      [artifactPaths.reportReview, "ultrafuzz/differential-report-review@1"],
      [artifactPaths.findings, "ultrafuzz/findings@2"]
    ],
    [triageNode.id]
  );
  const nodes = [planNode, harnessNode, auditNode, laneNode, triageNode, reviewNode];
  writePlannedGraph(layout, nodes);
  const planTask = differentialTask(layout, planNode, []);
  const harnessTask = differentialTask(layout, harnessNode, [planTask]);
  const auditTask = differentialTask(layout, auditNode, [harnessTask]);
  const laneTask = differentialTask(layout, laneNode, [auditTask]);
  const triageTask = differentialTask(layout, triageNode, [laneTask]);
  const reviewTask = differentialTask(layout, reviewNode, [triageTask]);
  const tasks = [planTask, harnessTask, auditTask, laneTask, triageTask, reviewTask];

  const planPath = runArtifactPath(planTask.attemptId, artifactPaths.plan);
  const harnessPath = runArtifactPath(harnessTask.attemptId, artifactPaths.harness);
  const auditPath = runArtifactPath(auditTask.attemptId, artifactPaths.audit);
  const plan = {
    schema_version: "ultrafuzz.differential-plan.v1",
    planner_attempt_index: 0,
    candidate_surfaces: [],
    reference_model_rules: {
      allowed_structures: ["independent test-only models"],
      forbidden_sources: ["production implementation internals"]
    },
    deployment_assumptions: [],
    phase_priorities: [],
    assigned_differential_lanes: [],
    deferred_lane_candidates: [],
    out_of_scope_surfaces: []
  };
  const harness = {
    schema_version: "ultrafuzz.reference-harness.v1",
    harness_author_attempt_index: 0,
    source_plan_artifacts: [planPath],
    authored_paths: [],
    reference_models: [],
    validation: { commands: [], passed: false, compiler_errors: [], notes: [] },
    lane_readiness_notes: []
  };
  const audited = {
    schema_version: "ultrafuzz.audited-differential-lanes.v1",
    auditor_attempt_index: 0,
    source_plan_artifacts: [planPath],
    source_harness_artifacts: [harnessPath],
    surface_audits: [],
    ready_lanes: [] as unknown[],
    rejected_or_narrowed_lanes: [],
    reference_gap_work_orders: [],
    ambiguous_spec_work_orders: []
  };
  const laneResult = {
    schema_version: "ultrafuzz.differential-lane-result.v1",
    lane_id: null,
    attempt_index: 0,
    auditor_attempt_index: 0,
    source_auditor_artifact: auditPath,
    source_plan_artifact: null,
    source_harness_artifact: null,
    assigned_lane_payload: null,
    authored_paths: [],
    focused_command: null,
    focused_command_ran: false,
    matched_test_count: 0,
    status: "no_assigned_lane",
    red_preservation_audit: {
      result: "not_applicable",
      pre_repair_file_hash: null,
      assertion_predicate: null
    },
    red_candidates: [],
    compile_or_harness_defects: [],
    public_evidence_paths: [],
    notes: []
  };
  const registry = {
    schema_version: "ultrafuzz.semantic-red-registry.v1",
    semantic_reds: [],
    compile_or_harness_defects: []
  };
  const triageA = {
    schema_version: "ultrafuzz.differential-red-triage.v1",
    pass: "a",
    classifications: []
  };
  const triageB = { ...triageA, pass: "b" };
  const repair = {
    schema_version: "ultrafuzz.differential-repair-summary.v1",
    repairs_attempted: [],
    repaired_failures: [],
    preserved_production_or_unknown_reds: [],
    commands: [],
    semantic_red_registry_regenerated: false,
    notes: []
  };
  const noAssignmentWorkOrder = {
    lane_id: null,
    attempt_index: 0,
    auditor_attempt_index: 0,
    source_auditor_artifact: auditPath,
    summary: "No audited lane was assigned to this attempt.",
    evidence_paths: []
  };
  const gap = {
    schema_version: "ultrafuzz.differential-gap-review.v1",
    ready_lanes: [],
    lane_results_seen: [
      {
        lane_id: null,
        attempt_index: 0,
        auditor_attempt_index: 0,
        source_auditor_artifact: auditPath,
        status: "no_assigned_lane"
      }
    ],
    missing_lane_work_orders: [],
    incomplete_campaign_work_orders: [noAssignmentWorkOrder],
    green_suite_evidence: [],
    report_blockers: []
  };
  const reportReview = {
    schema_version: "ultrafuzz.differential-report-review.v1",
    campaign_status: "incomplete",
    production_bug_reds: [],
    harness_or_reference_repairs: [],
    missing_or_deferred_lanes: [noAssignmentWorkOrder],
    report_rows_ready: [],
    notes: []
  };

  writeDeclaredArtifactNode(layout, planTask.attemptId, planNode.outputs, {
    [artifactPaths.plan]: JSON.stringify(plan)
  });
  writeDeclaredArtifactNode(layout, harnessTask.attemptId, harnessNode.outputs, {
    [artifactPaths.harness]: JSON.stringify(harness)
  });
  writeDeclaredArtifactNode(layout, auditTask.attemptId, auditNode.outputs, {
    [artifactPaths.audit]: JSON.stringify(audited)
  });
  writeDeclaredArtifactNode(layout, laneTask.attemptId, laneNode.outputs, {
    [artifactPaths.lane]: JSON.stringify(laneResult)
  });
  writeDeclaredArtifactNode(layout, triageTask.attemptId, triageNode.outputs, {
    [artifactPaths.registry]: JSON.stringify(registry),
    [artifactPaths.triageA]: JSON.stringify(triageA),
    [artifactPaths.triageB]: JSON.stringify(triageB)
  });
  writeDeclaredArtifactNode(layout, reviewTask.attemptId, reviewNode.outputs, {
    [artifactPaths.repair]: JSON.stringify(repair),
    [artifactPaths.gap]: JSON.stringify(gap),
    [artifactPaths.reportReview]: JSON.stringify(reportReview),
    [artifactPaths.findings]: JSON.stringify([])
  });

  for (const [node, task] of [
    [planNode, planTask],
    [harnessNode, harnessTask],
    [auditNode, auditTask],
    [laneNode, laneTask],
    [triageNode, triageTask],
    [reviewNode, reviewTask]
  ] as const) {
    const result = verifyRequiredArtifactsForAttempt(
      layout,
      node,
      task.attemptId,
      { task, tasks },
      authenticatedSnapshotsForNode(layout, node, task.attemptId)
    );
    assert.equal(
      result.ok,
      true,
      `${task.attemptId}: ${result.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`
    );
  }

  const lookalikePlanPath = runArtifactPath("lookalike-planner", artifactPaths.plan);
  writeArtifactFile(layout, "lookalike-planner", artifactPaths.plan, JSON.stringify(plan));
  fs.writeFileSync(
    path.join(harnessTask.artifactDir, artifactPaths.harness),
    JSON.stringify({ ...harness, source_plan_artifacts: [lookalikePlanPath] }),
    "utf8"
  );
  const lookalike = verifyRequiredArtifactsForAttempt(
    layout,
    harnessNode,
    harnessTask.attemptId,
    { task: harnessTask, tasks },
    authenticatedSnapshotsForNode(layout, harnessNode, harnessTask.attemptId)
  );
  assert.equal(lookalike.ok, false);
  assert.ok(
    lookalike.diagnostics.some(
      (diagnostic) =>
        diagnostic.details?.gate === "reference-harness-plan-reconciliation" &&
        /exactly preserve declared plan paths/u.test(diagnostic.message)
    )
  );

  const readyLane = {
    lane_id: "lane-a",
    attempt_index: 0,
    auditor_attempt_index: 0,
    planner_attempt_index: 0,
    harness_author_attempt_index: 0,
    source_plan_artifact: planPath,
    source_harness_artifact: harnessPath,
    surface_id: "surface-a",
    intended_t_sol_path: "test/foundry/differential/LaneA.t.sol",
    focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
    public_evidence_paths: ["docs/spec.md"],
    exact_observable_equality_assertions: ["returns match"],
    oracle_type: "independent_reference",
    calibration_bucket: "red_seeking_adversarial",
    red_seeking_priority: "high"
  };
  const nonEmptyPlan = {
    ...plan,
    candidate_surfaces: [
      {
        surface_id: "surface-a",
        public_entrypoints: ["compare(uint256)"],
        public_evidence_paths: ["docs/spec.md"],
        oracle_basis: ["Public return values must agree."],
        in_scope_behavior: ["Public return value"],
        out_of_scope_behavior: [],
        ambiguities: [],
        priority: "high"
      }
    ],
    assigned_differential_lanes: [
      {
        lane_id: readyLane.lane_id,
        planner_attempt_index: readyLane.planner_attempt_index,
        surface_id: readyLane.surface_id,
        intended_t_sol_path: readyLane.intended_t_sol_path,
        focused_command: readyLane.focused_command,
        public_evidence_paths: readyLane.public_evidence_paths,
        observable_equality_assertions: readyLane.exact_observable_equality_assertions,
        oracle_type: readyLane.oracle_type,
        calibration_bucket: readyLane.calibration_bucket,
        red_seeking_priority: readyLane.red_seeking_priority
      }
    ]
  };
  const nonEmptyHarness = {
    ...harness,
    authored_paths: ["test/foundry/differential/ReferenceA.sol"],
    reference_models: [
      {
        model_id: "reference-a",
        covered_surfaces: ["surface-a"],
        public_evidence_paths: ["docs/spec.md"],
        implementation_rules_applied: ["Direct public-value comparison"],
        known_gaps: [],
        deployment_helpers: []
      }
    ],
    validation: { commands: [readyLane.focused_command], passed: true, compiler_errors: [], notes: [] }
  };
  const nonEmptyAudit = {
    ...audited,
    surface_audits: [
      {
        surface_id: "surface-a",
        status: "ready",
        public_evidence_paths: ["docs/spec.md"],
        audit_notes: ["Reference model covers the public surface."],
        required_narrowing: []
      }
    ],
    ready_lanes: [readyLane]
  };
  const preRepairFileHash = "a".repeat(64);
  const redCandidateWithoutHash = {
    red_candidate_id: "red-a",
    test_path: readyLane.intended_t_sol_path,
    failing_test_name: "test_lane_a",
    focused_command: readyLane.focused_command,
    failure_signature: "public return mismatch",
    assertion: "actual == expected",
    observed: "1",
    expected: "2",
    public_oracle_basis: ["docs/spec.md"],
    classification: "untriaged"
  };
  const stableFailureHash = createHash("sha256")
    .update(
      JSON.stringify([
        "semantic-red-v1",
        readyLane.lane_id,
        redCandidateWithoutHash.red_candidate_id,
        redCandidateWithoutHash.test_path,
        redCandidateWithoutHash.failing_test_name,
        redCandidateWithoutHash.focused_command,
        redCandidateWithoutHash.failure_signature,
        redCandidateWithoutHash.assertion,
        redCandidateWithoutHash.observed,
        redCandidateWithoutHash.expected,
        redCandidateWithoutHash.public_oracle_basis,
        preRepairFileHash
      ]),
      "utf8"
    )
    .digest("hex");
  const redCandidate = { stable_failure_hash: stableFailureHash, ...redCandidateWithoutHash };
  const nonEmptyLaneResult = {
    schema_version: "ultrafuzz.differential-lane-result.v1",
    lane_id: readyLane.lane_id,
    attempt_index: 0,
    auditor_attempt_index: 0,
    source_auditor_artifact: auditPath,
    source_plan_artifact: planPath,
    source_harness_artifact: harnessPath,
    assigned_lane_payload: readyLane,
    authored_paths: [readyLane.intended_t_sol_path],
    focused_command: readyLane.focused_command,
    focused_command_ran: true,
    matched_test_count: 1,
    status: "semantic_red_frozen",
    red_preservation_audit: {
      result: "semantic_red_frozen",
      pre_repair_file_hash: preRepairFileHash,
      assertion_predicate: redCandidate.assertion
    },
    red_candidates: [redCandidate],
    compile_or_harness_defects: [],
    public_evidence_paths: ["docs/spec.md"],
    notes: []
  };
  const registryRed = {
    stable_failure_hash: stableFailureHash,
    lane_id: readyLane.lane_id,
    red_candidate_id: redCandidate.red_candidate_id,
    test_path: redCandidate.test_path,
    failing_test_name: redCandidate.failing_test_name,
    focused_command: redCandidate.focused_command,
    failure_signature: redCandidate.failure_signature,
    assertion: redCandidate.assertion,
    observed: redCandidate.observed,
    expected: redCandidate.expected,
    public_oracle_basis: redCandidate.public_oracle_basis,
    classification: redCandidate.classification,
    pre_repair_file_hash: preRepairFileHash
  };
  const nonEmptyRegistry = { ...registry, semantic_reds: [registryRed] };
  const productionClassification = {
    stable_failure_hash: stableFailureHash,
    classification: "production_bug",
    rationale: "Public reference behavior disagrees with production.",
    public_evidence_paths: ["docs/spec.md"],
    repair_allowed: false
  };
  const nonEmptyTriageA = { ...triageA, classifications: [productionClassification] };
  const nonEmptyTriageB = { ...triageB, classifications: [productionClassification] };
  const nonEmptyRepair = {
    ...repair,
    preserved_production_or_unknown_reds: [
      {
        stable_failure_hash: stableFailureHash,
        classification: "production_bug",
        reason: "Production red remains unchanged."
      }
    ]
  };
  const readyCoordinate = {
    lane_id: readyLane.lane_id,
    attempt_index: 0,
    auditor_attempt_index: 0,
    source_auditor_artifact: auditPath
  };
  const nonEmptyGap = {
    ...gap,
    ready_lanes: [readyCoordinate],
    lane_results_seen: [{ ...readyCoordinate, status: "semantic_red_frozen" }],
    incomplete_campaign_work_orders: []
  };
  const productionRow = {
    stable_failure_hash: stableFailureHash,
    lane_id: readyLane.lane_id,
    summary: "Public reference behavior disagrees with production.",
    evidence_paths: [readyLane.intended_t_sol_path]
  };
  const nonEmptyReportReview = {
    ...reportReview,
    campaign_status: "blocked_by_preserved_reds",
    production_bug_reds: [productionRow],
    missing_or_deferred_lanes: [],
    report_rows_ready: [productionRow]
  };

  writeDeclaredArtifactNode(layout, planTask.attemptId, planNode.outputs, {
    [artifactPaths.plan]: JSON.stringify(nonEmptyPlan)
  });
  writeDeclaredArtifactNode(layout, harnessTask.attemptId, harnessNode.outputs, {
    [artifactPaths.harness]: JSON.stringify(nonEmptyHarness)
  });
  writeDeclaredArtifactNode(layout, auditTask.attemptId, auditNode.outputs, {
    [artifactPaths.audit]: JSON.stringify(nonEmptyAudit)
  });
  writeDeclaredArtifactNode(layout, laneTask.attemptId, laneNode.outputs, {
    [artifactPaths.lane]: JSON.stringify(nonEmptyLaneResult)
  });
  writeDeclaredArtifactNode(layout, triageTask.attemptId, triageNode.outputs, {
    [artifactPaths.registry]: JSON.stringify(nonEmptyRegistry),
    [artifactPaths.triageA]: JSON.stringify(nonEmptyTriageA),
    [artifactPaths.triageB]: JSON.stringify(nonEmptyTriageB)
  });
  writeDeclaredArtifactNode(layout, reviewTask.attemptId, reviewNode.outputs, {
    [artifactPaths.repair]: JSON.stringify(nonEmptyRepair),
    [artifactPaths.gap]: JSON.stringify(nonEmptyGap),
    [artifactPaths.reportReview]: JSON.stringify(nonEmptyReportReview),
    [artifactPaths.findings]: JSON.stringify([currentFinding(stableFailureHash)])
  });
  for (const [node, task] of [
    [planNode, planTask],
    [harnessNode, harnessTask],
    [auditNode, auditTask],
    [laneNode, laneTask],
    [triageNode, triageTask],
    [reviewNode, reviewTask]
  ] as const) {
    const result = verifyRequiredArtifactsForAttempt(
      layout,
      node,
      task.attemptId,
      { task, tasks },
      authenticatedSnapshotsForNode(layout, node, task.attemptId)
    );
    assert.equal(
      result.ok,
      true,
      `non-empty ${task.attemptId}: ${result.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`
    );
  }

  fs.writeFileSync(path.join(laneTask.artifactDir, artifactPaths.lane), JSON.stringify(laneResult), "utf8");
  const falseNoAssignment = verifyRequiredArtifactsForAttempt(
    layout,
    laneNode,
    laneTask.attemptId,
    { task: laneTask, tasks },
    authenticatedSnapshotsForNode(layout, laneNode, laneTask.attemptId)
  );
  assert.equal(falseNoAssignment.ok, false);
  assert.ok(
    falseNoAssignment.diagnostics.some(
      (diagnostic) =>
        diagnostic.details?.gate === "differential-lane-result-handoff-reconciliation" &&
        /allowed only when no exact declared ready lane exists/u.test(diagnostic.message)
    )
  );
});

test("required artifact gate validates generated-test manifest shape and listed files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const manifestPath = path.join(artifactDir, "generated-tests.json");
  const node = plannedNode(["generated-tests.json"]);
  const generatedContents = "contract InvariantTest {}\n";
  const manifestEntry = (entryPath: string, contents: string | Buffer) => ({
    path: entryPath,
    size_bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex")
  });
  const generatedEntry = manifestEntry("generated-tests/Invariant.t.sol", generatedContents);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-1",
      node_id: "strategy-a",
      framework: "foundry",
      support_files: [],
      test_files: [{ path: "generated-tests/Invariant.t.sol" }]
    }),
    "utf8"
  );

  const legacy = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  const supportEntry = manifestEntry("generated-tests/InvariantFixture.sol", "library InvariantFixture {}\n");
  for (const [name, invalidManifest] of [
    [
      "support-without-test",
      {
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-1",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [],
        support_files: [supportEntry]
      }
    ],
    [
      "duplicate-generated-test",
      {
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-1",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [generatedEntry, structuredClone(generatedEntry)],
        support_files: []
      }
    ],
    [
      "duplicate-support-file",
      {
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-1",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [generatedEntry],
        support_files: [supportEntry, structuredClone(supportEntry)]
      }
    ]
  ] as const) {
    const bytes = Buffer.from(JSON.stringify(invalidManifest), "utf8");
    fs.writeFileSync(manifestPath, bytes);
    const invalid = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
    assert.equal(invalid.ok, false, name);
    assert.ok(
      invalid.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"),
      `${name}: ${JSON.stringify(invalid.diagnostics)}`
    );
    assert.deepEqual(fs.readFileSync(manifestPath), bytes, `${name}: host validation must not rewrite the manifest`);
  }

  const oversizedDeclaredManifest = {
    schema_version: "ultrafuzz.generated-tests.v3",
    run_id: "run-1",
    node_id: "strategy-a",
    framework: "foundry",
    generated_tests: Array.from({ length: 5 }, (_, index) => ({
      path: `generated-tests/Oversized-${index}.sol`,
      size_bytes: 16 * 1024 * 1024,
      sha256: index.toString(16).padStart(64, "0")
    })),
    support_files: []
  };
  const oversizedDeclaredBytes = Buffer.from(JSON.stringify(oversizedDeclaredManifest), "utf8");
  fs.writeFileSync(manifestPath, oversizedDeclaredBytes);
  const oversizedDeclared = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(oversizedDeclared.ok, false);
  assert.ok(
    oversizedDeclared.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "generated-test-bundle-resource-bounds"
    )
  );
  assert.deepEqual(fs.readFileSync(manifestPath), oversizedDeclaredBytes);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-1",
      node_id: "strategy-a",
      framework: "foundry",
      generated_tests: [generatedEntry],
      support_files: []
    }),
    "utf8"
  );

  const missingFile = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(missingFile.ok, false);
  assert.ok(missingFile.diagnostics.some((diagnostic) => diagnostic.code === "GENERATED_TEST_FILE_MISSING"));
  assert.ok(
    missingFile.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "generated-test-file-integrity"
    )
  );

  fs.mkdirSync(path.join(artifactDir, "generated-tests"), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "generated-tests", "Invariant.t.sol"), "", "utf8");

  const emptyFile = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(emptyFile.ok, false);
  assert.ok(emptyFile.diagnostics.some((diagnostic) => diagnostic.code === "GENERATED_TEST_FILE_EMPTY"));

  fs.writeFileSync(path.join(artifactDir, "generated-tests", "Invariant.t.sol"), generatedContents, "utf8");

  for (const generated_tests of [
    [{ ...generatedEntry, size_bytes: generatedEntry.size_bytes + 1 }],
    [{ ...generatedEntry, sha256: "0".repeat(64) }]
  ]) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-1",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests,
        support_files: []
      }),
      "utf8"
    );
    const mismatchedIntegrity = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
    assert.equal(mismatchedIntegrity.ok, false);
    assert.ok(
      mismatchedIntegrity.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          diagnostic.details?.gate === "generated-test-file-integrity"
      )
    );
  }

  for (const [field, value] of [
    ["run_id", "run-foreign"],
    ["node_id", "strategy-foreign"]
  ] as const) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-1",
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [generatedEntry],
        support_files: [],
        [field]: value
      }),
      "utf8"
    );
    const mismatchedIdentity = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
    assert.equal(mismatchedIdentity.ok, false, field);
    assert.ok(
      mismatchedIdentity.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          diagnostic.details?.gate === "generated-test-current-identity"
      ),
      field
    );
  }

  const supportPath = path.join(artifactDir, "generated-tests", "InvariantFixture.sol");
  const binarySupportContents = Buffer.from([0xff]);
  fs.writeFileSync(supportPath, binarySupportContents);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-1",
      node_id: "strategy-a",
      framework: "foundry",
      generated_tests: [generatedEntry],
      support_files: [manifestEntry("generated-tests/InvariantFixture.sol", binarySupportContents)]
    }),
    "utf8"
  );
  const binarySupport = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(binarySupport.ok, false);
  assert.ok(
    binarySupport.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "generated-test-file-integrity"
    )
  );
  const supportContents = "library InvariantFixture {}\n";
  fs.writeFileSync(supportPath, supportContents, "utf8");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-1",
      node_id: "strategy-a",
      framework: "foundry",
      generated_tests: [generatedEntry],
      support_files: [manifestEntry("generated-tests/InvariantFixture.sol", supportContents)]
    }),
    "utf8"
  );

  const valid = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.deepEqual(valid.diagnostics, []);
  assert.equal(valid.ok, true);
});

test("required artifact gate rejects hard-linked generated-test manifests and companions without mutation", async (t) => {
  const createFixture = (runId: string) => {
    const projectRoot = tempProject();
    const layout = createRunLayout({ projectRoot, runId });
    const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
    const generatedTestsDirectory = path.join(artifactDir, "generated-tests");
    fs.mkdirSync(generatedTestsDirectory);
    const companionContents = Buffer.from("contract InvariantTest {}\n", "utf8");
    const companionPath = path.join(generatedTestsDirectory, "Invariant.t.sol");
    fs.writeFileSync(companionPath, companionContents);
    const manifestPath = path.join(artifactDir, "generated-tests.json");
    const manifestBytes = Buffer.from(
      `${JSON.stringify({
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: runId,
        node_id: "strategy-a",
        framework: "foundry",
        generated_tests: [
          {
            path: "generated-tests/Invariant.t.sol",
            size_bytes: companionContents.byteLength,
            sha256: createHash("sha256").update(companionContents).digest("hex")
          }
        ],
        support_files: []
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(manifestPath, manifestBytes);
    return {
      projectRoot,
      layout,
      node: plannedNode(["generated-tests.json"]),
      manifestPath,
      manifestBytes,
      companionPath,
      companionContents
    };
  };

  await t.test("manifest", () => {
    const fixture = createFixture("run-hardlinked-generated-manifest");
    const aliasPath = path.join(fixture.projectRoot, "generated-tests.alias.json");
    fs.linkSync(fixture.manifestPath, aliasPath);
    const inode = fs.lstatSync(fixture.manifestPath).ino;

    const result = verifyRequiredArtifactsForAttempt(fixture.layout, fixture.node, "strategy-a");

    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "hard-link" && /singly linked regular file/u.test(diagnostic.message)
      ),
      JSON.stringify(result.diagnostics)
    );
    assert.deepEqual(fs.readFileSync(fixture.manifestPath), fixture.manifestBytes);
    assert.deepEqual(fs.readFileSync(aliasPath), fixture.manifestBytes);
    assert.equal(fs.lstatSync(fixture.manifestPath).ino, inode);
    assert.equal(fs.lstatSync(fixture.manifestPath).nlink, 2);
  });

  await t.test("companion", () => {
    const fixture = createFixture("run-hardlinked-generated-companion");
    const aliasPath = path.join(fixture.projectRoot, "Invariant.alias.t.sol");
    fs.linkSync(fixture.companionPath, aliasPath);
    const inode = fs.lstatSync(fixture.companionPath).ino;

    const result = verifyRequiredArtifactsForAttempt(fixture.layout, fixture.node, "strategy-a");

    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          diagnostic.details?.gate === "generated-test-file-integrity" &&
          /hard-linked/u.test(diagnostic.message)
      )
    );
    assert.deepEqual(fs.readFileSync(fixture.companionPath), fixture.companionContents);
    assert.deepEqual(fs.readFileSync(aliasPath), fixture.companionContents);
    assert.equal(fs.lstatSync(fixture.companionPath).ino, inode);
    assert.equal(fs.lstatSync(fixture.companionPath).nlink, 2);
  });
});

test("workspace patch exclusions pass the contract gate but surface a durable warning", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-workspace-exclusion" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["workspace-patch.json"]);
  const workspace = path.join(layout.workspacesDir, "strategy-a");
  fs.mkdirSync(workspace, { recursive: true });
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Ultrafuzz test"]);
  git(["config", "user.email", "ultrafuzz@example.invalid"]);
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "test", "Handlers.t.sol"), "contract Handlers {}\n");
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "baseline"]);
  const baselineTree = captureWorkspaceTree(workspace);
  fs.writeFileSync(path.join(workspace, "test", "Handlers.t.sol"), "contract Handlers { uint256 changed; }\n");
  const capture = captureWorkspacePatch(workspace, baselineTree);
  fs.writeFileSync(path.join(artifactDir, "workspace.patch"), capture.patch, "utf8");
  fs.writeFileSync(
    path.join(artifactDir, "workspace-patch-baseline.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.workspace-patch-baseline.v1",
      attempt_id: "strategy-a",
      baseline_tree: baselineTree
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(artifactDir, "workspace-patch.json"),
    JSON.stringify({
      ...capture.manifest,
      excluded_files: [
        {
          path: "test/recon/corpus-deep/seed.bin",
          diff_bytes_at_least: 33_865_139,
          reason: "git-diff-overflow"
        }
      ]
    }),
    "utf8"
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(result.ok, true);
  const warning = result.diagnostics.find((entry) => entry.code === "WORKSPACE_PATCH_FILES_EXCLUDED");
  assert.equal(warning?.severity, "warning");
  assert.match(warning?.message ?? "", /test\/recon\/corpus-deep\/seed\.bin/u);
  assert.deepEqual(warning?.details?.excluded_files, [
    {
      path: "test/recon/corpus-deep/seed.bin",
      diff_bytes_at_least: 33_865_139,
      reason: "git-diff-overflow"
    }
  ]);
});

test("contextual semantic gates fail closed when trusted host facts are unavailable", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-workspace-context-missing" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["workspace-patch.json"]);
  fs.writeFileSync(
    path.join(artifactDir, "workspace-patch.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.workspace-patch.v1",
      base_commit: "a".repeat(40),
      base_tree: "b".repeat(40),
      result_tree: "c".repeat(40),
      patch_sha256: "d".repeat(64),
      source_snapshot: { status: "preserved", protected_roots: ["contracts", "src"] },
      files: []
    }),
    "utf8"
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(result.ok, false);
  const unavailable = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "ARTIFACT_SEMANTIC_GATE_CONTEXT_UNAVAILABLE"
  );
  assert.equal(unavailable?.details?.gate, "workspace-patch-git-binding");
  assert.deepEqual(unavailable?.details?.missing_context, [
    "git.baseCommit",
    "git.baseTree",
    "git.resultTree",
    "git.patchSha256"
  ]);
});

test("host artifact validation executes document semantic gates without rewriting the input", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-semantic-finding-ids" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const artifactPath = path.join(artifactDir, "findings.json");
  const node = plannedNode(["findings.json"]);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify([currentFinding("finding-duplicate"), currentFinding("finding-duplicate")]),
    "utf8"
  );
  const before = fs.readFileSync(artifactPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" && diagnostic.details?.gate === "findings-id-uniqueness"
    )
  );
  assert.deepEqual(fs.readFileSync(artifactPath), before);
});

test("severity classification gates preserve triaged fields and enforce the final matrix", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-severity-preservation" });
  const upstream = currentFinding("finding-severity", {
    triage_classification: "true-positive",
    notes: ["triage_reason=production path is reachable"]
  });
  writeArtifact(layout, "triage", "triaged-findings.json", JSON.stringify([upstream]));

  const classified = {
    ...upstream,
    severity: "Medium",
    impact: "High",
    likelihood: "Low",
    impact_rationale: "The reachable path can lock assets.",
    likelihood_rationale: "The path requires narrow timing.",
    severity_rationale: "High impact x Low likelihood maps to Medium."
  };
  const classifiedPath = writeArtifact(
    layout,
    "severity-classification",
    "severity-classified-findings.json",
    JSON.stringify([classified])
  );
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "severity-classification",
    logical_id: "severity-classification",
    depends_on: ["triage"],
    artifact_dir: "artifacts/severity-classification",
    outputs: [boundOutput("severity-classified-findings.json", "ultrafuzz/severity-classified-findings@1", true)]
  };

  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  fs.writeFileSync(classifiedPath, JSON.stringify([{ ...classified, summary: "Rewritten downstream summary" }]));
  const rewritten = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(rewritten.ok, false);
  assert.ok(
    rewritten.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "severity-classification-upstream-preservation"
    ),
    JSON.stringify(rewritten.diagnostics)
  );

  fs.writeFileSync(classifiedPath, JSON.stringify([{ ...classified, severity: "High" }]));
  const wrongMatrix = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(wrongMatrix.ok, false);
  assert.ok(
    wrongMatrix.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "severity-classification-matrix"
    ),
    JSON.stringify(wrongMatrix.diagnostics)
  );
});

test("triage gates preserve every deduped finding and upstream note", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-triage-preservation" });
  const dedupeNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "review-dedupe-attempt",
    logical_id: "review-dedupe-attempt",
    artifact_dir: "artifacts/review-dedupe-attempt",
    outputs: [boundOutput("review/deduped.json", "ultrafuzz/findings@2", true)]
  };
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "review-triage-attempt",
    logical_id: "review-triage-attempt",
    depends_on: [dedupeNode.id],
    artifact_dir: "artifacts/review-triage-attempt",
    outputs: [boundOutput("review/triaged.json", "ultrafuzz/triaged-findings@1", true)]
  };
  writePlannedGraph(layout, [dedupeNode, node]);
  const dedupeTask = sealedTaskForNode(layout, dedupeNode);
  const triageTask = sealedTaskForNode(layout, node, [dedupeTask]);
  const tasks = [dedupeTask, triageTask];
  const upstream = currentFinding("finding-triage", {
    dedupe_key: "root-triage",
    notes: ["stateful_failure_classification=production-bug"]
  });
  writeDeclaredArtifactNode(layout, dedupeTask.attemptId, dedupeNode.outputs, {
    "review/deduped.json": JSON.stringify([upstream])
  });

  const triaged = {
    ...upstream,
    triage_classification: "true-positive",
    notes: [...(upstream.notes as string[]), "triage_reason=public path is reachable"]
  };
  writeDeclaredArtifactNode(layout, triageTask.attemptId, node.outputs, {
    "review/triaged.json": JSON.stringify([triaged])
  });
  const triagedPath = path.join(triageTask.artifactDir, "review/triaged.json");

  const valid = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    triageTask.attemptId,
    { task: triageTask, tasks },
    authenticatedSnapshotsForNode(layout, node, triageTask.attemptId)
  );
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  fs.writeFileSync(
    triagedPath,
    JSON.stringify([
      { ...triaged, summary: "Rewritten during triage", notes: ["triage_reason=public path is reachable"] }
    ])
  );
  const rewritten = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    triageTask.attemptId,
    { task: triageTask, tasks },
    authenticatedSnapshotsForNode(layout, node, triageTask.attemptId)
  );
  assert.equal(rewritten.ok, false);
  assert.ok(
    rewritten.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "triaged-finding-upstream-preservation"
    ),
    JSON.stringify(rewritten.diagnostics)
  );
});

test("dynamic strategy sibling artifacts reconcile only through exact declared outputs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-dynamic-strategy-reconciliation" });
  const artifactPaths = {
    plan: "dynamic/strategy-plan.current.json",
    enumerators: "dynamic/enumerator-outputs.current.json",
    selected: "dynamic/selected-strategies.current.json",
    findings: "dynamic/findings.current.json",
    provenance: "dynamic/provenance.current.json"
  } as const;
  const excludedContext = {
    sibling_runs: "excluded",
    previous_reports: "excluded",
    host_global_paths: "excluded",
    network_resources: "excluded",
    extra_target_context: "excluded"
  };
  const recommendationA = {
    strategy_id: "strategy-a",
    title: "Strategy A",
    rationale: "Exercise the uncovered transition.",
    coverage_gap: "The transition has no focused test.",
    evidence_paths: ["src/Target.sol"],
    proposed_test_path: "generated-tests/StrategyA.t.sol",
    focused_command: "forge test --match-contract StrategyA",
    priority: "high"
  };
  const recommendationB = { ...recommendationA, strategy_id: "strategy-b", title: "Strategy B" };
  const strategyPlan = {
    schema_version: "ultrafuzz.dynamic-strategy-plan.v1",
    dynamic_strategies_enumerator: 1,
    status: "selected",
    selected_strategy_count: 1,
    selected_strategies: ["strategy-a"],
    rejected_strategies: [{ strategy_id: "strategy-b", reason: "Lower priority." }],
    current_run_artifacts_considered: [],
    excluded_context: excludedContext,
    timeout_seconds: null,
    finalization_reserve_seconds: null
  };
  const enumeratorOutputs = {
    schema_version: "ultrafuzz.dynamic-enumerator-outputs.v1",
    enumerators: [
      {
        enumerator_id: "enumerator-a",
        agent_label: "Enumerator A",
        status: "complete",
        diagnostics: [],
        recommendations: [recommendationA, recommendationB]
      }
    ]
  };
  const selectedStrategies = {
    schema_version: "ultrafuzz.selected-strategies.v1",
    strategies: [
      {
        ...recommendationA,
        enumerator_ids: ["enumerator-a"],
        validation_plan: ["Run the focused command."]
      }
    ]
  };
  const findings = [
    currentFinding("dynamic-finding", {
      strategy: "dynamic-strategy-generator",
      dynamic_strategy_id: "strategy-a",
      enumerator_id: "enumerator-a",
      attempt_index: 0
    })
  ];
  const provenance = {
    schema_version: "ultrafuzz.dynamic-strategy-provenance.v1",
    current_run_artifacts: [],
    agents: [{ agent_id: "enumerator-a", label: "Enumerator A", role: "strategy-enumerator" }],
    models: [],
    commands: [],
    generated_files: [
      {
        strategy_id: "strategy-a",
        source_path: "generated-tests/StrategyA.t.sol",
        destination_intent: "Focused dynamic regression test"
      }
    ],
    validation: [],
    excluded_context: excludedContext
  };
  const baseline = {
    [artifactPaths.plan]: strategyPlan,
    [artifactPaths.enumerators]: enumeratorOutputs,
    [artifactPaths.selected]: selectedStrategies,
    [artifactPaths.findings]: findings,
    [artifactPaths.provenance]: provenance
  };
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "dynamic-strategy-attempt",
    logical_id: "dynamic-strategy-attempt",
    artifact_dir: "artifacts/dynamic-strategy-attempt",
    outputs: [
      boundOutput(artifactPaths.plan, "ultrafuzz/dynamic-strategy-plan@1", true),
      boundOutput(artifactPaths.enumerators, "ultrafuzz/dynamic-enumerator-outputs@1"),
      boundOutput(artifactPaths.selected, "ultrafuzz/selected-strategies@1"),
      boundOutput(artifactPaths.findings, "ultrafuzz/findings@2"),
      boundOutput(artifactPaths.provenance, "ultrafuzz/dynamic-strategy-provenance@1")
    ]
  };
  writePlannedGraph(layout, [node]);
  const task = sealedTaskForNode(layout, node);
  const tasks = [task];
  const artifactDir = task.artifactDir;
  const writeBaseline = (): void => {
    for (const [fileName, value] of Object.entries(baseline)) {
      fs.mkdirSync(path.dirname(path.join(artifactDir, fileName)), { recursive: true });
      fs.writeFileSync(path.join(artifactDir, fileName), JSON.stringify(value), "utf8");
    }
  };
  const assertReconciliationFailure = (fileName: keyof typeof baseline, value: unknown, expected: RegExp): void => {
    writeBaseline();
    fs.writeFileSync(path.join(artifactDir, fileName), JSON.stringify(value), "utf8");
    const result = verifyRequiredArtifactsForAttempt(
      layout,
      node,
      task.attemptId,
      { task, tasks },
      authenticatedSnapshotsForNode(layout, node, task.attemptId)
    );
    assert.equal(result.ok, false, fileName);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          diagnostic.details?.gate === "dynamic-strategy-artifact-reconciliation" &&
          expected.test(diagnostic.message)
      ),
      `${fileName}: ${JSON.stringify(result.diagnostics)}`
    );
  };

  writeDeclaredArtifactNode(
    layout,
    task.attemptId,
    node.outputs,
    Object.fromEntries(Object.entries(baseline).map(([fileName, value]) => [fileName, JSON.stringify(value)]))
  );
  const valid = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    task.attemptId,
    { task, tasks },
    authenticatedSnapshotsForNode(layout, node, task.attemptId)
  );
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  assertReconciliationFailure(
    artifactPaths.plan,
    { ...strategyPlan, rejected_strategies: [] },
    /neither selected nor explicitly rejected/u
  );
  assertReconciliationFailure(
    artifactPaths.selected,
    {
      ...selectedStrategies,
      strategies: [{ ...selectedStrategies.strategies[0]!, rationale: "Rewritten after enumeration." }]
    },
    /does not exactly preserve/u
  );
  assertReconciliationFailure(
    artifactPaths.selected,
    {
      ...selectedStrategies,
      strategies: [{ ...selectedStrategies.strategies[0]!, enumerator_ids: ["enumerator-other"] }]
    },
    /exact recommending enumerators/u
  );
  assertReconciliationFailure(
    artifactPaths.findings,
    [{ ...findings[0]!, dynamic_strategy_id: "strategy-b" }],
    /unselected strategy/u
  );
  assertReconciliationFailure(
    artifactPaths.findings,
    [{ ...findings[0]!, enumerator_id: "enumerator-other" }],
    /did not recommend/u
  );
  assertReconciliationFailure(
    artifactPaths.provenance,
    { ...provenance, generated_files: [{ ...provenance.generated_files[0]!, strategy_id: "strategy-b" }] },
    /generated file.*unselected strategy/u
  );

  writeBaseline();
  fs.rmSync(path.join(artifactDir, artifactPaths.provenance));
  fs.writeFileSync(path.join(artifactDir, "provenance.json"), JSON.stringify(provenance), "utf8");
  const undeclaredLookalike = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    task.attemptId,
    { task, tasks },
    authenticatedSnapshotsForNode(layout, node, task.attemptId)
  );
  assert.equal(undeclaredLookalike.ok, false);
  assert.ok(
    undeclaredLookalike.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "REQUIRED_ARTIFACT_MISSING" &&
        diagnostic.path === runArtifactPath(task.attemptId, artifactPaths.provenance)
    ) &&
      undeclaredLookalike.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "REQUIRED_ARTIFACT_INVALID" &&
          diagnostic.message.includes("dynamic strategy provenance semantic context is unavailable")
      ),
    JSON.stringify(undeclaredLookalike.diagnostics)
  );
});

test("final report gates preserve severity records and ledger dispositions under canonical presentation IDs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-report-stage-preservation" });
  const severityPaths = {
    findings: "classified/current-findings.json",
    lifecycle: "classified/current-lifecycle.json"
  } as const;
  const reportArtifactPath = "deliverables/final-report.json";
  const reportMarkdownPath = "deliverables/final-report.md";
  const severityNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "classified-review-attempt",
    logical_id: "classified-review-attempt",
    artifact_dir: "artifacts/classified-review-attempt",
    outputs: [
      boundOutput(severityPaths.findings, "ultrafuzz/severity-classified-findings@1", true),
      boundOutput(severityPaths.lifecycle, "ultrafuzz/finding-lifecycle-ledger@1")
    ]
  };
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "report-review-attempt",
    logical_id: "report-review-attempt",
    depends_on: [severityNode.id],
    artifact_dir: "artifacts/report-review-attempt",
    outputs: [
      boundOutput(reportArtifactPath, "ultrafuzz/report@3", true),
      boundOutput(reportMarkdownPath, "ultrafuzz/nonempty-markdown@1")
    ]
  };
  writePlannedGraph(layout, [severityNode, node]);
  const severityTask = sealedTaskForNode(layout, severityNode);
  const reportTask = sealedTaskForNode(layout, node, [severityTask]);
  const tasks = [severityTask, reportTask];
  const classified = currentFinding("finding-report", {
    dedupe_key: "root-report",
    triage_classification: "true-positive",
    notes: ["triage_reason=public path is reachable"],
    severity: "Medium",
    impact: "High",
    likelihood: "Low",
    impact_rationale: "The reachable path can lock assets.",
    likelihood_rationale: "The path requires narrow timing.",
    severity_rationale: "High impact x Low likelihood maps to Medium."
  });
  const lifecycle = {
    dedupe_key: "root-report",
    source_artifacts: [],
    strategy_hits: [],
    triage_classification: "true-positive",
    triage_reason: "public path is reachable",
    canonical_severity: "Medium",
    final_disposition: "promoted",
    stages: [
      {
        stage: "severity-classified",
        artifact_path: severityPaths.findings,
        finding_id: "finding-report"
      }
    ]
  };
  writeDeclaredArtifactNode(layout, severityTask.attemptId, severityNode.outputs, {
    [severityPaths.findings]: JSON.stringify([classified]),
    [severityPaths.lifecycle]: JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [lifecycle]
    })
  });

  const reportIssue = {
    ...classified,
    id: "M-01",
    title: "[M-01] - Property failure",
    description: "The public path can lock user assets.",
    proof_of_concept: {
      scenario: ["Call the public path in the affected state."],
      language: "solidity",
      code: "assertTrue(locked);"
    },
    lifecycle
  };
  writeDeclaredArtifactNode(layout, reportTask.attemptId, node.outputs, {
    [reportArtifactPath]: JSON.stringify(currentReport(layout.runId, { issues: [reportIssue] })),
    [reportMarkdownPath]: "# Final report\n"
  });
  const reportPath = path.join(reportTask.artifactDir, reportArtifactPath);

  const valid = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    reportTask.attemptId,
    { task: reportTask, tasks },
    authenticatedSnapshotsForNode(layout, node, reportTask.attemptId)
  );
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      currentReport(layout.runId, { issues: [{ ...reportIssue, id: "finding-report", title: "Property failure" }] })
    )
  );
  const rewritten = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    reportTask.attemptId,
    { task: reportTask, tasks },
    authenticatedSnapshotsForNode(layout, node, reportTask.attemptId)
  );
  assert.equal(rewritten.ok, false);
  assert.ok(
    rewritten.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "report-severity-classification-preservation"
    ),
    JSON.stringify(rewritten.diagnostics)
  );
});

test("review lifecycle and strategy gates authenticate every dedupe, triage, and severity transition", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-review-lifecycle" });
  const artifactPaths = {
    dedupedFindings: "review-one/deduped.json",
    dedupeStrategies: "review-one/strategies.json",
    dedupeLifecycle: "review-one/lifecycle.json",
    triagedFindings: "review-two/triaged.json",
    triageLifecycle: "review-two/lifecycle.json",
    classifiedFindings: "review-three/classified.json",
    severityStrategies: "review-three/strategies.json",
    severityLifecycle: "review-three/lifecycle.json"
  } as const;
  const dedupeNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "review-stage-one-attempt",
    logical_id: "review-stage-one-attempt",
    artifact_dir: "artifacts/review-stage-one-attempt",
    outputs: [
      boundOutput(artifactPaths.dedupedFindings, "ultrafuzz/findings@2", true),
      boundOutput(artifactPaths.dedupeStrategies, "ultrafuzz/strategy-detections@1"),
      boundOutput(artifactPaths.dedupeLifecycle, "ultrafuzz/finding-lifecycle-ledger@1")
    ]
  };
  const triageNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "review-stage-two-attempt",
    logical_id: "review-stage-two-attempt",
    depends_on: [dedupeNode.id],
    artifact_dir: "artifacts/review-stage-two-attempt",
    outputs: [
      boundOutput(artifactPaths.triagedFindings, "ultrafuzz/triaged-findings@1", true),
      boundOutput(artifactPaths.triageLifecycle, "ultrafuzz/finding-lifecycle-ledger@1")
    ]
  };
  const severityNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "review-stage-three-attempt",
    logical_id: "review-stage-three-attempt",
    depends_on: [triageNode.id],
    artifact_dir: "artifacts/review-stage-three-attempt",
    outputs: [
      boundOutput(artifactPaths.classifiedFindings, "ultrafuzz/severity-classified-findings@1", true),
      boundOutput(artifactPaths.severityStrategies, "ultrafuzz/strategy-detections@1"),
      boundOutput(artifactPaths.severityLifecycle, "ultrafuzz/finding-lifecycle-ledger@1")
    ]
  };
  writePlannedGraph(layout, [dedupeNode, triageNode, severityNode]);
  const dedupeTask = sealedTaskForNode(layout, dedupeNode);
  const triageTask = sealedTaskForNode(layout, triageNode, [dedupeTask]);
  const severityTask = sealedTaskForNode(layout, severityNode, [triageTask]);
  const tasks = [dedupeTask, triageTask, severityTask];
  const dedupedFinding = currentFinding("finding-lifecycle", {
    dedupe_key: "root-lifecycle",
    strategy: "boundary-tests"
  });
  const dedupedPath = artifactPaths.dedupedFindings;
  const strategyDetections = [
    {
      dedupe_key: "root-lifecycle",
      finding_id: "finding-lifecycle",
      title: "Property failure",
      hits: [{ strategy: "boundary-tests", attempt_index: 0 }]
    }
  ];
  const sourceArtifact = {
    path: "artifacts/boundary-tests/findings.json",
    node_id: "boundary-tests",
    finding_id: "raw-finding",
    title: "Property failure",
    relationship: "primary"
  };
  const dedupeRecord = {
    dedupe_key: "root-lifecycle",
    source_artifacts: [sourceArtifact],
    strategy_hits: strategyDetections[0]!.hits,
    stages: [
      { stage: "raw", artifact_path: sourceArtifact.path, finding_id: sourceArtifact.finding_id },
      { stage: "deduped", artifact_path: dedupedPath, finding_id: "finding-lifecycle" }
    ]
  };
  writeDeclaredArtifactNode(layout, dedupeTask.attemptId, dedupeNode.outputs, {
    [artifactPaths.dedupedFindings]: JSON.stringify([dedupedFinding]),
    [artifactPaths.dedupeStrategies]: JSON.stringify(strategyDetections),
    [artifactPaths.dedupeLifecycle]: JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [dedupeRecord]
    })
  });
  const validDedupe = verifyRequiredArtifactsForAttempt(
    layout,
    dedupeNode,
    dedupeTask.attemptId,
    { task: dedupeTask, tasks },
    authenticatedSnapshotsForNode(layout, dedupeNode, dedupeTask.attemptId)
  );
  assert.equal(validDedupe.ok, true, JSON.stringify(validDedupe.diagnostics));

  const triagedFinding = {
    ...dedupedFinding,
    triage_classification: "true-positive",
    notes: ["triage_reason=public path is reachable"]
  };
  const triagedPath = artifactPaths.triagedFindings;
  const triageRecord = {
    ...dedupeRecord,
    triage_classification: "true-positive",
    triage_reason: "public path is reachable",
    stages: [...dedupeRecord.stages, { stage: "triaged", artifact_path: triagedPath, finding_id: "finding-lifecycle" }]
  };
  writeDeclaredArtifactNode(layout, triageTask.attemptId, triageNode.outputs, {
    [artifactPaths.triagedFindings]: JSON.stringify([triagedFinding]),
    [artifactPaths.triageLifecycle]: JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [triageRecord]
    })
  });
  const triageLedgerPath = path.join(triageTask.artifactDir, artifactPaths.triageLifecycle);
  const validTriage = verifyRequiredArtifactsForAttempt(
    layout,
    triageNode,
    triageTask.attemptId,
    { task: triageTask, tasks },
    authenticatedSnapshotsForNode(layout, triageNode, triageTask.attemptId)
  );
  assert.equal(validTriage.ok, true, JSON.stringify(validTriage.diagnostics));

  fs.writeFileSync(
    triageLedgerPath,
    JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [{ ...triageRecord, source_artifacts: [{ ...sourceArtifact, path: "rewritten/findings.json" }] }]
    })
  );
  const rewrittenTriage = verifyRequiredArtifactsForAttempt(
    layout,
    triageNode,
    triageTask.attemptId,
    { task: triageTask, tasks },
    authenticatedSnapshotsForNode(layout, triageNode, triageTask.attemptId)
  );
  assert.equal(rewrittenTriage.ok, false);
  assert.ok(
    rewrittenTriage.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "finding-lifecycle-review-stage-reconciliation"
    ),
    JSON.stringify(rewrittenTriage.diagnostics)
  );
  fs.writeFileSync(
    triageLedgerPath,
    JSON.stringify({ schema_version: "ultrafuzz.finding-lifecycle-ledger.v1", records: [triageRecord] })
  );

  const classifiedFinding = {
    ...triagedFinding,
    severity: "Medium",
    impact: "High",
    likelihood: "Low",
    impact_rationale: "The reachable path can lock assets.",
    likelihood_rationale: "The path requires narrow timing.",
    severity_rationale: "High impact x Low likelihood maps to Medium."
  };
  const classifiedPath = artifactPaths.classifiedFindings;
  const severityRecord = {
    ...triageRecord,
    canonical_severity: "Medium",
    final_disposition: "promoted",
    stages: [
      ...triageRecord.stages,
      { stage: "severity-classified", artifact_path: classifiedPath, finding_id: "finding-lifecycle" }
    ]
  };
  writeDeclaredArtifactNode(layout, severityTask.attemptId, severityNode.outputs, {
    [artifactPaths.classifiedFindings]: JSON.stringify([classifiedFinding]),
    [artifactPaths.severityStrategies]: JSON.stringify(strategyDetections),
    [artifactPaths.severityLifecycle]: JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [severityRecord]
    })
  });
  const severityStrategyPath = path.join(severityTask.artifactDir, artifactPaths.severityStrategies);
  const severityLedgerPath = path.join(severityTask.artifactDir, artifactPaths.severityLifecycle);
  const validSeverity = verifyRequiredArtifactsForAttempt(
    layout,
    severityNode,
    severityTask.attemptId,
    { task: severityTask, tasks },
    authenticatedSnapshotsForNode(layout, severityNode, severityTask.attemptId)
  );
  assert.equal(validSeverity.ok, true, JSON.stringify(validSeverity.diagnostics));

  fs.writeFileSync(
    severityStrategyPath,
    JSON.stringify([{ ...strategyDetections[0], hits: [{ strategy: "rewritten", attempt_index: 0 }] }])
  );
  const rewrittenStrategy = verifyRequiredArtifactsForAttempt(
    layout,
    severityNode,
    severityTask.attemptId,
    { task: severityTask, tasks },
    authenticatedSnapshotsForNode(layout, severityNode, severityTask.attemptId)
  );
  assert.equal(rewrittenStrategy.ok, false);
  assert.ok(
    rewrittenStrategy.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "strategy-detection-review-stage-reconciliation"
    ),
    JSON.stringify(rewrittenStrategy.diagnostics)
  );
  fs.writeFileSync(severityStrategyPath, JSON.stringify(strategyDetections));

  fs.writeFileSync(
    severityLedgerPath,
    JSON.stringify({
      schema_version: "ultrafuzz.finding-lifecycle-ledger.v1",
      records: [{ ...severityRecord, canonical_severity: "High" }]
    })
  );
  const rewrittenSeverity = verifyRequiredArtifactsForAttempt(
    layout,
    severityNode,
    severityTask.attemptId,
    { task: severityTask, tasks },
    authenticatedSnapshotsForNode(layout, severityNode, severityTask.attemptId)
  );
  assert.equal(rewrittenSeverity.ok, false);
  assert.ok(
    rewrittenSeverity.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "finding-lifecycle-review-stage-reconciliation"
    ),
    JSON.stringify(rewrittenSeverity.diagnostics)
  );
});

test("sealed planned graph ignores unrelated producers but rejects a missing planned producer", () => {
  const absentLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-no-property-track" });
  const reportNode = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report",
    artifact_dir: "artifacts/final-report"
  };
  writePlannedGraph(absentLayout, [reportNode]);
  writeArtifact(absentLayout, reportNode.id, "report.md", "# Report\n");
  writeArtifact(absentLayout, reportNode.id, "report.json", JSON.stringify(currentReport(absentLayout.runId)));
  const absent = verifyRequiredArtifactsForAttempt(absentLayout, reportNode, reportNode.id);
  assert.equal(absent.ok, true, JSON.stringify(absent.diagnostics));

  const outsideLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-property-producer-outside-closure" });
  const outsideCatalogNode = {
    ...plannedNode(["properties.json"]),
    id: "unrelated-property-catalog",
    logical_id: "unrelated-property-catalog",
    artifact_dir: "artifacts/unrelated-property-catalog"
  };
  writePlannedGraph(outsideLayout, [outsideCatalogNode, reportNode]);
  writeArtifact(outsideLayout, reportNode.id, "report.md", "# Report\n");
  writeArtifact(outsideLayout, reportNode.id, "report.json", JSON.stringify(currentReport(outsideLayout.runId)));
  const outside = verifyRuntimeRequiredArtifactsForAttempt(outsideLayout, reportNode, reportNode.id);
  assert.equal(outside.ok, true, JSON.stringify(outside.diagnostics));

  const missingLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-missing-property-producer" });
  const catalogNode = {
    ...plannedNode(["properties.json"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    artifact_dir: "artifacts/property-specification-fanin"
  };
  const implementationNode = {
    ...plannedNode(["implemented-properties.json"]),
    id: "stateful-invariant-implement-properties",
    logical_id: "stateful-invariant-implement-properties",
    artifact_dir: "artifacts/stateful-invariant-implement-properties",
    depends_on: [catalogNode.id]
  };
  const plannedReportNode = { ...reportNode, depends_on: [implementationNode.id] };
  writePlannedGraph(missingLayout, [catalogNode, implementationNode, plannedReportNode]);
  // This branch deliberately leaves a planned prerequisite unfinalized. Write
  // the current output without manufacturing a contradictory success manifest.
  writeArtifactFile(missingLayout, reportNode.id, "report.json", JSON.stringify(currentReport(missingLayout.runId)));
  const missing = verifyRequiredArtifactsForAttempt(missingLayout, plannedReportNode, plannedReportNode.id);
  assert.equal(missing.ok, false);
  assert.ok(
    missing.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "REQUIRED_ARTIFACT_INVALID" && /finalized .* authority/u.test(diagnostic.message)
    ),
    JSON.stringify(missing.diagnostics)
  );

  const malformedCatalogPath = writeArtifact(
    missingLayout,
    catalogNode.id,
    "properties.json",
    JSON.stringify({ schema_version: "ultrafuzz.properties.v1", properties: [] })
  );
  const malformedCatalogBytes = fs.readFileSync(malformedCatalogPath);
  const malformedCatalog = verifyRequiredArtifactsForAttempt(missingLayout, plannedReportNode, plannedReportNode.id);
  assert.equal(malformedCatalog.ok, false);
  assert.ok(
    malformedCatalog.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "REQUIRED_ARTIFACT_INVALID" && /failed .* validation/u.test(diagnostic.message)
    ),
    JSON.stringify(malformedCatalog.diagnostics)
  );
  assert.deepEqual(fs.readFileSync(malformedCatalogPath), malformedCatalogBytes);

  writeArtifact(
    missingLayout,
    catalogNode.id,
    "properties.json",
    JSON.stringify({ schema_version: "ultrafuzz.properties.v2", properties: [] })
  );
  const malformedImplementationPath = writeArtifact(
    missingLayout,
    implementationNode.id,
    "implemented-properties.json",
    JSON.stringify({ schema_version: "ultrafuzz.implemented-properties.v2", properties: [] })
  );
  const malformedImplementationBytes = fs.readFileSync(malformedImplementationPath);
  const malformedImplementation = verifyRequiredArtifactsForAttempt(
    missingLayout,
    plannedReportNode,
    plannedReportNode.id
  );
  assert.equal(malformedImplementation.ok, false);
  assert.ok(
    malformedImplementation.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "REQUIRED_ARTIFACT_INVALID" && /failed .* validation/u.test(diagnostic.message)
    ),
    JSON.stringify(malformedImplementation.diagnostics)
  );
  assert.deepEqual(fs.readFileSync(malformedImplementationPath), malformedImplementationBytes);
});

test("renamed report producers gate their exact declared JSON and Markdown paths", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-custom-report-paths",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const coverage = currentImplementedCoverage(["property-1"]);
  writeArtifact(
    layout,
    "custom-property-catalog",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "custom-lens", source_property_id: "source-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "custom-implementation",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/Properties.sol"],
          test_paths: ["test/Property1.t.sol"]
        }
      ]
    })
  );
  const reportOutput = boundOutput("custom/final/document.json", "ultrafuzz/report@3");
  const markdownOutput = boundOutput("rendered/security-review.md", "ultrafuzz/nonempty-markdown@1", true);
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "terminal-export-attempt",
    logical_id: "renamed-terminal-export",
    display_name: "Renamed terminal export",
    artifact_dir: "artifacts/terminal-export-attempt",
    depends_on: ["custom-implementation"],
    outputs: [markdownOutput, reportOutput]
  };
  writeArtifactFile(
    layout,
    node.id,
    reportOutput.path,
    JSON.stringify(currentReport(layout.runId, { property_implementation_coverage: coverage }))
  );
  writeArtifactFile(layout, node.id, markdownOutput.path, "# Report without declared coverage\n");
  const decoy = writeArtifactFile(layout, node.id, "report.json", "{ intentionally invalid undeclared decoy");
  const decoyBytes = fs.readFileSync(decoy);

  const missingCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingCoverage.ok, false);
  assert.ok(
    missingCoverage.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISSING" &&
        diagnostic.path?.endsWith(markdownOutput.path)
    ),
    JSON.stringify(missingCoverage.diagnostics)
  );

  writeArtifactFile(layout, node.id, markdownOutput.path, reportCoverageMarkdown(coverage));
  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));
  assert.deepEqual(fs.readFileSync(decoy), decoyBytes);
});

test("required artifact gate rejects contract-invalid empty files and final-component symlinks", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const artifactPath = path.join(artifactDir, "output.json");
  const node = plannedNode(["output.json"]);

  fs.writeFileSync(artifactPath, "", "utf8");
  const empty = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, []);
  assert.ok(empty.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MARKDOWN_EMPTY"));

  fs.rmSync(artifactPath);
  const outside = path.join(tempProject(), "outside.json");
  fs.writeFileSync(outside, "outside\n", "utf8");
  fs.symlinkSync(outside, artifactPath);
  const symlink = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(symlink.ok, false);
  assert.ok(symlink.diagnostics.some((diagnostic) => diagnostic.code === "symlink-escape"));
});

test("artifact contracts reject malformed outputs and accept canonical empty outputs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-contracts" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["findings.json", "notes.md"]);

  fs.writeFileSync(path.join(artifactDir, "findings.json"), "{}", "utf8");
  fs.writeFileSync(path.join(artifactDir, "notes.md"), "", "utf8");
  const malformed = verifyRequiredArtifactsForAttempt(layout, node, "strategy-a");
  assert.equal(malformed.ok, false);
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_MARKDOWN_EMPTY"));

  fs.writeFileSync(path.join(artifactDir, "findings.json"), "[]", "utf8");
  fs.writeFileSync(path.join(artifactDir, "notes.md"), "# No findings\n", "utf8");
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, "strategy-a").ok, true);
});

test("project discovery gate accepts custom exact typed paths under a noncanonical logical ID", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-renamed-discovery-contract" });
  const nodeId = "renamed-discovery-attempt";
  const ledgerOutput = boundOutput("custom/evidence-ledger.json", "ultrafuzz/invariant-ledger@1", true);
  const markdownOutput = boundOutput("custom/discovery-handoff.md", "ultrafuzz/nonempty-markdown@1", false);
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: nodeId,
    logical_id: "noncanonical-discovery-role",
    display_name: "Renamed discovery",
    artifact_dir: `artifacts/${nodeId}`,
    outputs: [ledgerOutput, markdownOutput]
  };
  fs.mkdirSync(path.join(layout.workspacesDir, nodeId), { recursive: true });
  writeArtifactFile(
    layout,
    nodeId,
    ledgerOutput.path,
    invariantProbeLedger([
      { id: "probe-root", source_path: ".", query: "repository invariant scan", result: "Scanned repository" }
    ])
  );
  writeArtifactFile(layout, nodeId, markdownOutput.path, "# Custom discovery handoff\n");

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("project discovery gate rejects wrong-contract lookalikes and ambiguous typed ledgers", () => {
  const wrongLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-wrong-discovery-contract" });
  const wrongNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "renamed-discovery",
    logical_id: "noncanonical-discovery-role",
    artifact_dir: "artifacts/renamed-discovery",
    outputs: [
      boundOutput("setup/invariant-evidence-ledger.json", "ultrafuzz/text@1", true),
      boundOutput("setup/project-discovery.md", "ultrafuzz/nonempty-markdown@1", false)
    ]
  };
  writeArtifactFile(wrongLayout, wrongNode.id, "setup/invariant-evidence-ledger.json", "lookalike\n");
  writeArtifactFile(wrongLayout, wrongNode.id, "setup/project-discovery.md", "# Discovery\n");
  const wrong = verifyRequiredArtifactsForAttempt(wrongLayout, wrongNode, wrongNode.id);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_DECLARATION_WRONG_CONTRACT"));

  const wrongMarkdownLayout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-wrong-discovery-markdown-contract"
  });
  const wrongMarkdownNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "renamed-discovery",
    logical_id: "noncanonical-discovery-role",
    artifact_dir: "artifacts/renamed-discovery",
    outputs: [
      boundOutput("custom/ledger.json", "ultrafuzz/invariant-ledger@1", true),
      boundOutput("setup/project-discovery.md", "ultrafuzz/text@1", false)
    ]
  };
  writeArtifactFile(wrongMarkdownLayout, wrongMarkdownNode.id, "custom/ledger.json", invariantProbeLedger([]));
  writeArtifactFile(wrongMarkdownLayout, wrongMarkdownNode.id, "setup/project-discovery.md", "lookalike\n");
  const wrongMarkdown = verifyRequiredArtifactsForAttempt(wrongMarkdownLayout, wrongMarkdownNode, wrongMarkdownNode.id);
  assert.equal(wrongMarkdown.ok, false);
  assert.ok(
    wrongMarkdown.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "INVARIANT_LEDGER_DECLARATION_WRONG_CONTRACT" &&
        diagnostic.path === "setup/project-discovery.md"
    )
  );

  const ambiguousLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-ambiguous-discovery-contract" });
  const ambiguousNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "renamed-discovery",
    logical_id: "noncanonical-discovery-role",
    artifact_dir: "artifacts/renamed-discovery",
    outputs: [
      boundOutput("custom/a.json", "ultrafuzz/invariant-ledger@1", true),
      boundOutput("custom/b.json", "ultrafuzz/invariant-ledger@1", false),
      boundOutput("custom/discovery.md", "ultrafuzz/nonempty-markdown@1", false)
    ]
  };
  const ledger = invariantProbeLedger([
    { id: "probe-root", source_path: ".", query: "repository invariant scan", result: "Scanned repository" }
  ]);
  writeArtifactFile(ambiguousLayout, ambiguousNode.id, "custom/a.json", ledger);
  writeArtifactFile(ambiguousLayout, ambiguousNode.id, "custom/b.json", ledger);
  writeArtifactFile(ambiguousLayout, ambiguousNode.id, "custom/discovery.md", "# Discovery\n");
  const ambiguous = verifyRequiredArtifactsForAttempt(ambiguousLayout, ambiguousNode, ambiguousNode.id);
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_DECLARATION_AMBIGUOUS"));
});

test("canonical property gate accepts one custom typed JSON/Markdown pair under a noncanonical logical ID", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-renamed-canonical-pair" });
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      { id: "probe-root", source_path: ".", query: "repository invariant scan", result: "Scanned repository" }
    ])
  );
  writePropertyLens(layout, "renamed-property-lens", ["lens-one"]);
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "renamed-property-lens", source_property_id: "lens-one" }]
      }
    ]
  });
  const nodeId = "renamed-canonicalizer-attempt";
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: nodeId,
    logical_id: "noncanonical-canonicalizer-role",
    display_name: "Renamed canonicalizer",
    artifact_dir: `artifacts/${nodeId}`,
    depends_on: ["renamed-property-lens"],
    outputs: [
      boundOutput("custom/catalog.json", "ultrafuzz/properties@2", true),
      boundOutput("custom/catalog.md", "ultrafuzz/nonempty-markdown@1", false)
    ]
  };
  writeArtifactFile(layout, nodeId, "custom/catalog.json", catalog);
  writeArtifactFile(layout, nodeId, "custom/catalog.md", fixtureCanonicalPropertiesMarkdown(catalog));

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("host gate validates invariant-ledger and canonical-properties roles independently on one producer", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-composed-property-roles" });
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      { id: "probe-root", source_path: ".", query: "repository invariant scan", result: "Scanned repository" }
    ])
  );
  writePropertyLens(layout, "composed-property-lens", ["lens-one"]);

  const nodeId = "composed-property-producer";
  const currentLedger = invariantProbeLedger([
    { id: "probe-current", source_path: ".", query: "current invariant scan", result: "Scanned repository" }
  ]);
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "composed-property-lens", source_property_id: "lens-one" }]
      }
    ]
  });
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: nodeId,
    logical_id: nodeId,
    artifact_dir: `artifacts/${nodeId}`,
    depends_on: ["composed-property-lens"],
    outputs: [
      boundOutput("custom/ledger.json", "ultrafuzz/invariant-ledger@1", true),
      boundOutput("custom/catalog.json", "ultrafuzz/properties@2", false),
      boundOutput("custom/handoff.md", "ultrafuzz/nonempty-markdown@1", false)
    ]
  };
  fs.mkdirSync(path.join(layout.workspacesDir, nodeId), { recursive: true });
  writeArtifactFile(layout, nodeId, "custom/ledger.json", currentLedger);
  writeArtifactFile(layout, nodeId, "custom/catalog.json", catalog);
  writeArtifactFile(
    layout,
    nodeId,
    "custom/handoff.md",
    `${fixtureInvariantLedgerMarkdown(currentLedger)}\n${fixtureCanonicalPropertiesMarkdown(catalog).replace(
      'description: "Balances remain conserved."',
      'description: "Drifted canonical companion."'
    )}`
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"),
    JSON.stringify(result.diagnostics)
  );
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code.startsWith("INVARIANT_LEDGER_MARKDOWN_")),
    false,
    JSON.stringify(result.diagnostics)
  );
});

test("canonical property gate rejects wrong-contract lookalikes and ambiguous typed companions", () => {
  const verify = (
    runId: string,
    outputs: PlannedGraphNode["outputs"]
  ): ReturnType<typeof verifyRequiredArtifactsForAttempt> => {
    const layout = createRunLayout({ projectRoot: tempProject(), runId });
    const node: PlannedGraphNode = {
      ...plannedNode([]),
      id: "renamed-canonicalizer",
      logical_id: "noncanonical-canonicalizer-role",
      artifact_dir: "artifacts/renamed-canonicalizer",
      outputs
    };
    for (const output of outputs) {
      const contents =
        output.contract === "ultrafuzz/properties@2"
          ? '{"schema_version":"ultrafuzz.properties.v2","properties":[]}'
          : "lookalike\n";
      writeArtifactFile(layout, node.id, output.path, contents);
    }
    return verifyRequiredArtifactsForAttempt(layout, node, node.id);
  };

  const wrongCatalog = verify("run-wrong-catalog-lookalike", [
    boundOutput("properties.json", "ultrafuzz/text@1", true),
    boundOutput("properties.md", "ultrafuzz/nonempty-markdown@1", false)
  ]);
  assert.ok(
    wrongCatalog.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CATALOG_DECLARATION_WRONG_CONTRACT")
  );

  const wrongMarkdown = verify("run-wrong-markdown-lookalike", [
    boundOutput("custom/catalog.json", "ultrafuzz/properties@2", true),
    boundOutput("custom/catalog.md", "ultrafuzz/nonempty-markdown@1", false),
    boundOutput("properties.md", "ultrafuzz/text@1", false)
  ]);
  assert.ok(
    wrongMarkdown.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_DECLARATION_WRONG_CONTRACT")
  );

  const ambiguousMarkdown = verify("run-ambiguous-markdown", [
    boundOutput("custom/catalog.json", "ultrafuzz/properties@2", true),
    boundOutput("custom/a.md", "ultrafuzz/nonempty-markdown@1", false),
    boundOutput("custom/b.md", "ultrafuzz/nonempty-markdown@1", false)
  ]);
  assert.ok(
    ambiguousMarkdown.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_DECLARATION_AMBIGUOUS")
  );
});

test("project discovery gate requires ledger evidence to survive in the markdown handoff", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-ledger-markdown" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery",
    artifact_dir: "artifacts/project-discovery"
  };
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "overview.md"),
    `${"\n".repeat(53)}Total borrowed assets <= total supplied assets; source text mentions ### End ledger entry: evidence-borrowed-assets inline.\n`,
    "utf8"
  );
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-borrowed-assets",
        source_path: "docs/overview.md",
        source_location: "lines 54-55",
        kind: "inequality",
        verbatim:
          "Total borrowed assets <= total supplied assets; source text mentions ### End ledger entry: evidence-borrowed-assets inline.",
        inventory_ids: ["inventory-hub-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-solvency",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-borrowed-assets"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    fixtureInvariantLedgerMarkdown(JSON.stringify(ledger))
  );

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  const symbolMismatchLedger = structuredClone(ledger);
  symbolMismatchLedger.entries[0]!.source_location = "function Hub.totalBorrowed";
  symbolMismatchLedger.entries[0]!.verbatim = "This text is not present in the source";
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify(symbolMismatchLedger)
  );
  const symbolMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(symbolMismatch.ok, false);
  assert.ok(
    symbolMismatch.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH")
  );

  const missingSourceLedger = structuredClone(ledger);
  missingSourceLedger.entries[0]!.source_path = "docs/missing.md";
  const missingSourcePath = writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify(missingSourceLedger)
  );
  assert.equal(
    validateRegisteredJsonFileSync({
      schemaPath: path.join(artifactSchemaDirectory(), "invariant-evidence-ledger.schema.json"),
      filePath: missingSourcePath
    }).status,
    "valid",
    "portable document shape must pass before the named filesystem context gate"
  );
  const missingSource = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSource.ok, false);
  assert.ok(missingSource.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_MISSING"));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", "{");
  const malformedLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(malformedLedger.ok, false);
  assert.ok(malformedLedger.diagnostics.some((diagnostic) => diagnostic.code === "JSON_INSTANCE_INVALID"));

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: []
    })
  );
  const emptyLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(emptyLedger.ok, false);
  assert.ok(emptyLedger.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The documentation set states no invariant; only prose overviews are present.",
      scan_probes: [
        {
          id: "probe-docs-no-invariants",
          source_path: "docs/overview.md",
          query: "invariant|accounting|solvency",
          result: "No explicit invariant statements found"
        }
      ]
    })
  );
  const staleNoEvidenceMarkdown = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(staleNoEvidenceMarkdown.ok, false, JSON.stringify(staleNoEvidenceMarkdown.diagnostics));
  assert.ok(
    staleNoEvidenceMarkdown.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA"
    ),
    JSON.stringify(staleNoEvidenceMarkdown.diagnostics)
  );
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  const explicitNoEvidence = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(explicitNoEvidence.ok, true, JSON.stringify(explicitNoEvidence.diagnostics));

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    "# Discovery\nevidence-borrowed-assets\ndocs/overview.md\nlines 54-55\n"
  );
  const missingEvidence = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingEvidence.ok, false);
  assert.ok(
    missingEvidence.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING")
  );
});

test("artifact validation rejects a persisted schema binding that differs from the current registry", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-schema-binding-mismatch" });
  const artifactDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const node = plannedNode(["findings.json"]);
  node.outputs[0]!.schema_sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(artifactDir, "findings.json"), "[]\n", "utf8");

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "ARTIFACT_SCHEMA_BINDING_MISMATCH"));
});

test("project discovery gate accepts a repository-root scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(discoveryWorkspace, { recursive: true });
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The repository-wide scan found no invariant statement to record.",
      scan_probes: [
        {
          id: "probe-repository-root",
          source_path: ".",
          query: "repository-wide invariant inventory",
          result: "Repository-wide scan completed"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// Issue #292: this is the exact artifact from the report. An empty ledger whose only evidence is
// probe text nothing reads used to satisfy both evidence gates, because the gate enforced the SHAPE
// of the emptiness rather than asking anyone to stand behind it. Emptiness stays reachable, but only
// as an explicit, auditable claim.
test("project discovery gate rejects an empty ledger that does not justify the absence", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-unjustified-empty" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  const ledger = (justification?: string) =>
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      ...(justification === undefined ? {} : { no_invariants_justification: justification }),
      // The issue's literal `"id": "p1"` no longer passes the `^probe-` pattern; everything else
      // about the reported artifact, including the invented result text, is reproduced verbatim.
      scan_probes: [{ id: "probe-p1", source_path: ".", query: "invariant", result: "invented result text" }]
    });

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger());
  const unjustified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unjustified.ok, false, JSON.stringify(unjustified.diagnostics));
  assert.ok(
    unjustified.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"),
    JSON.stringify(unjustified.diagnostics)
  );

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    ledger("This target is a pure library of pure functions and states no invariant of its own.")
  );
  const justified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(justified.ok, true, JSON.stringify(justified.diagnostics));

  // A justification on a ledger that DOES carry entries is contradictory, so the schema refuses it
  // rather than letting both readings of the artifact coexist.
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-1",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Total borrowed <= total supplied",
          inventory_ids: ["inventory-1"]
        }
      ],
      inventory_rows: [{ id: "inventory-1", description: "Solvency", ledger_ids: ["evidence-1"] }],
      no_invariants_justification: "Contradicts the entries above.",
      scan_probes: []
    })
  );
  const contradictory = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contradictory.ok, false);
  assert.ok(
    contradictory.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"),
    JSON.stringify(contradictory.diagnostics)
  );
});

// R45's `project-discovery` died on `artifact-contract failure: invariant scan probe tests is
// unavailable: scan probe is not a regular file` (issue #289). A scan probe records WHERE the agent
// searched, and a directory like `tests/` is a perfectly reasonable thing to have scanned. The
// repository-root probe above is already accepted on exactly that reasoning; a subdirectory was not.
test("project discovery gate accepts a directory scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-directory-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(discoveryWorkspace, "tests", "Base.t.sol"), "contract Base {}\n");
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The tests directory carries no invariant statement to record.",
      scan_probes: [
        {
          id: "probe-tests-directory",
          source_path: "tests",
          query: "invariant harness scan",
          result: "Scanned the tests directory"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    false,
    JSON.stringify(result.diagnostics)
  );
});

// A symlink that resolves to a directory is deliberately NOT a directory probe: the allowance keys on
// `lstat`, so a leaf symlink cannot be used to reach outside the workspace unread.
test("project discovery gate rejects a symlinked-directory scan probe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-symlinked-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "tests"), { recursive: true });
  fs.symlinkSync(path.join(discoveryWorkspace, "tests"), path.join(discoveryWorkspace, "tests-alias"), "dir");
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The symlinked-directory fixture declares no invariant to record.",
      scan_probes: [
        {
          id: "probe-tests-alias",
          source_path: "tests-alias",
          query: "invariant harness scan",
          result: "Scanned the tests directory"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    JSON.stringify(result.diagnostics)
  );
});

// Issue #301: the generated workflow refuses a scan probe whose source is not tracked, unmodified,
// and byte-identical to the pinned commit, but the gate did no Git check at all. A probe naming an
// existing-but-untracked file therefore passed `ultrafuzz validate` and then killed the node mid-run.
// Both sites now call the shared validator, so the gate predicts what the run enforces.
test("project discovery gate rejects an untracked scan probe source in a pinned workspace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-unpinned-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = pinnedDiscoveryWorkspace(layout);
  fs.mkdirSync(path.join(discoveryWorkspace, "out"), { recursive: true });
  fs.writeFileSync(path.join(discoveryWorkspace, "out", "Counter.json"), '{"abi":[]}\n');
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      {
        id: "probe-generated-abi",
        source_path: "out/Counter.json",
        query: "invariant harness scan",
        result: "Scanned the generated ABI"
      }
    ])
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_SOURCE_UNPINNED"),
    JSON.stringify(result.diagnostics)
  );
});

// The mirrored rule must not over-fire: a tracked, unmodified, pinned probe source is exactly what
// the run accepts, so the gate has to accept it too.
test("project discovery gate accepts a pinned and unchanged scan probe source", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-pinned-probe" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  pinnedDiscoveryWorkspace(layout);
  writeArtifact(layout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    invariantProbeLedger([
      {
        id: "probe-counter",
        source_path: "src/Counter.sol",
        query: "invariant harness scan",
        result: "Scanned the counter source"
      }
    ])
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// An invariant SOURCE is different: its bytes are the evidence, so a directory must still be refused.
// The ledger here is schema-valid and its markdown handoff is complete, so the directory source is the
// only thing left that can fail the gate.
test("project discovery gate still rejects a directory invariant source", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-directory-source" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const discoveryWorkspace = path.join(layout.workspacesDir, "project-discovery");
  fs.mkdirSync(path.join(discoveryWorkspace, "src"), { recursive: true });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    fixtureInvariantLedgerMarkdown(
      JSON.stringify({
        schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
        entries: [
          {
            id: "evidence-directory-source",
            source_path: "src",
            source_location: "line 1",
            kind: "inequality",
            verbatim: "contract Hub {}",
            inventory_ids: ["inventory-hub-solvency"]
          }
        ],
        inventory_rows: [
          {
            id: "inventory-hub-solvency",
            description: "Hub borrowed assets remain at or below supplied assets.",
            ledger_ids: ["evidence-directory-source"]
          }
        ],
        scan_probes: []
      })
    )
  );
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-directory-source",
          source_path: "src",
          source_location: "line 1",
          kind: "inequality",
          verbatim: "contract Hub {}",
          inventory_ids: ["inventory-hub-solvency"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-hub-solvency",
          description: "Hub borrowed assets remain at or below supplied assets.",
          ledger_ids: ["evidence-directory-source"]
        }
      ],
      scan_probes: []
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SCHEMA_INVALID"),
    false,
    JSON.stringify(result.diagnostics)
  );
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "not-file"),
    JSON.stringify(result.diagnostics)
  );
});

test("project discovery gate rejects root-normalizing traversal and a symlinked workspace root", () => {
  const traversalLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-traversal" });
  const traversalNode = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.mkdirSync(path.join(traversalLayout.workspacesDir, "project-discovery"), { recursive: true });
  writeArtifact(traversalLayout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    traversalLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The traversal fixture declares no invariant to record.",
      scan_probes: [
        { id: "probe-traversal", source_path: "foo/..", query: "inventory", result: "done" },
        { id: "probe-drive", source_path: "C:/outside", query: "inventory", result: "done" },
        { id: "probe-backslash", source_path: "C:\\\\outside", query: "inventory", result: "done" },
        { id: "probe-absolute", source_path: "/outside", query: "inventory", result: "done" },
        { id: "probe-nul", source_path: "missing\u0000path", query: "inventory", result: "done" }
      ]
    })
  );
  const traversal = verifyRequiredArtifactsForAttempt(traversalLayout, traversalNode, traversalNode.id);
  assert.equal(traversal.ok, false);
  assert.ok(traversal.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));

  const canonicalWorkspace = path.join(traversalLayout.workspacesDir, "project-discovery");
  fs.symlinkSync(path.join(canonicalWorkspace, "missing-target"), path.join(canonicalWorkspace, "broken"), "dir");
  writeArtifact(
    traversalLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The broken-parent fixture declares no invariant to record.",
      scan_probes: [
        { id: "probe-broken-parent", source_path: "broken/optional.txt", query: "inventory", result: "absent" }
      ]
    })
  );
  const brokenParent = verifyRequiredArtifactsForAttempt(traversalLayout, traversalNode, traversalNode.id);
  assert.equal(brokenParent.ok, false);
  assert.ok(brokenParent.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));

  const symlinkLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-root-symlink" });
  const symlinkNode = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  fs.symlinkSync(tempProject(), path.join(symlinkLayout.workspacesDir, "project-discovery"), "dir");
  writeArtifact(symlinkLayout, "project-discovery", "setup/project-discovery.md", "# Discovery\n");
  writeArtifact(
    symlinkLayout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "The symlinked-workspace fixture declares no invariant to record.",
      scan_probes: [{ id: "probe-root", source_path: ".", query: "inventory", result: "done" }]
    })
  );
  const symlink = verifyRequiredArtifactsForAttempt(symlinkLayout, symlinkNode, symlinkNode.id);
  assert.equal(symlink.ok, false);
  assert.ok(symlink.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"));
});

test("project discovery gate verifies immutable source proof after the discovery workspace is reclaimed", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-source-proof" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-solvency",
        source_path: "docs/overview.md",
        source_location: "lines 1-1",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-solvency",
        description: "Borrowed assets stay below supplied assets.",
        ledger_ids: ["evidence-solvency"]
      }
    ],
    scan_probes: [
      {
        id: "probe-repository-root",
        source_path: ".",
        query: "repository-wide invariant inventory",
        result: "Repository-wide scan completed"
      }
    ]
  };
  const ledgerBytes = Buffer.from(JSON.stringify(ledger));
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledgerBytes.toString("utf8"));
  writeArtifact(
    layout,
    "project-discovery",
    "setup/project-discovery.md",
    fixtureInvariantLedgerMarkdown(JSON.stringify(ledger))
  );
  const source = "Total borrowed assets <= total supplied assets\n";
  fs.mkdirSync(path.join(layout.root, "source-proofs"), { recursive: true });
  fs.writeFileSync(
    path.join(layout.root, "source-proofs", "project-discovery.invariant.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-source-proof.v1",
      attempt_id: "project-discovery",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      ledger_sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
      files: [{ path: "docs/overview.md", sha256: createHash("sha256").update(source).digest("hex"), content: source }]
    })
  );
  fs.writeFileSync(
    path.join(layout.root, "source-proofs", "project-discovery.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.agent-source-proof.v2",
      attempt_id: "project-discovery",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      base_ref: "refs/heads/ultrafuzz-pinned",
      refs: [{ name: "refs/heads/ultrafuzz-pinned", object: "a".repeat(40) }],
      remotes: [],
      revision_count: 1,
      commit_object_count: 1,
      dependencies: null
    })
  );
  fs.rmSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true, force: true });
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  fs.writeFileSync(path.join(layout.workspacesDir, "project-discovery"), "present but not a Git workspace\n");
  const malformedPresentWorkspace = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(malformedPresentWorkspace.ok, false);
  assert.ok(
    malformedPresentWorkspace.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_PROOF_INVALID"
    )
  );
  fs.unlinkSync(path.join(layout.workspacesDir, "project-discovery"));

  fs.writeFileSync(
    path.join(layout.root, "source-proofs", "project-discovery.invariant.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-source-proof.v1",
      attempt_id: "project-discovery",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      ledger_sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
      files: [{ path: "docs/overview.md", sha256: "0".repeat(64), content: source }]
    })
  );
  const digestMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(digestMismatch.ok, false);
  assert.ok(
    digestMismatch.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "invariant-source-proof-git-binding"
    )
  );
  fs.writeFileSync(
    path.join(layout.root, "source-proofs", "project-discovery.invariant.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-source-proof.v1",
      attempt_id: "project-discovery",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      ledger_sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
      files: [{ path: "docs/overview.md", sha256: createHash("sha256").update(source).digest("hex"), content: source }]
    })
  );

  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      ...ledger,
      scan_probes: [{ id: "probe-unsafe", source_path: "../../outside", query: "inventory", result: "done" }]
    })
  );
  const unsafeRecoveredProbe = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unsafeRecoveredProbe.ok, false);
  assert.ok(
    unsafeRecoveredProbe.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID")
  );

  fs.writeFileSync(path.join(layout.root, "source-proofs", "project-discovery.invariant.json"), "{}");
  const invalidProof = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(invalidProof.ok, false);
  assert.ok(invalidProof.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_PROOF_INVALID"));
});

test("project discovery gate preserves repeated backslashes in Markdown formula evidence", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-escaped-formula" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const source = "$$ minLB = (maxLB - 100\\\\%) \\\\times lbFactor + 100\\\\% $$\n";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), source, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-min-lb-formula",
        source_path: "docs/overview.md",
        source_location: "line 1",
        kind: "bound",
        verbatim: source.trim(),
        inventory_ids: ["inventory-min-lb-formula"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-min-lb-formula",
        description: "The minimum liquidation bonus uses the documented lower-bound formula.",
        ledger_ids: ["evidence-min-lb-formula"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(layout, node.id, "setup/project-discovery.md", fixtureInvariantLedgerMarkdown(JSON.stringify(ledger)));

  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const collapsedSpacing = structuredClone(ledger);
  collapsedSpacing.entries[0]!.verbatim = source.trim().replace("lbFactor +", "lbFactor+");
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(collapsedSpacing));
  const spacingMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(spacingMismatch.ok, false);
  assert.ok(
    spacingMismatch.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH")
  );

  const collapsed = structuredClone(ledger);
  collapsed.entries[0]!.verbatim = source.trim().replaceAll("\\\\", "\\");
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(collapsed));
  const invalid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH"));
});

test("project discovery gate parses source text containing a closing ledger marker", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-marker-collision" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery",
    artifact_dir: "artifacts/project-discovery"
  };
  const verbatim = "Total borrowed assets <= total supplied assets\n### End ledger entry: evidence-marker";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), `${verbatim}\n`, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-marker",
        source_path: "docs/overview.md",
        source_location: "lines 1-2",
        kind: "inequality",
        verbatim,
        inventory_ids: ["inventory-marker"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-marker",
        description: "The source statement remains linked to its inventory row.",
        ledger_ids: ["evidence-marker"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(layout, node.id, "setup/project-discovery.md", fixtureInvariantLedgerMarkdown(JSON.stringify(ledger)));

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "setup/project-discovery.md",
    fixtureInvariantLedgerMarkdown(JSON.stringify(ledger)).replace(
      '### End ledger entry: "evidence-marker"',
      '### End ledger entry: "evidence-other"'
    )
  );
  const missingCloser = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingCloser.ok, false);
  assert.ok(
    missingCloser.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING")
  );
});

test("project discovery gate preserves multiline evidence through exact JSON string escaping", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-multiline-prefix" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const source = "- first invariant\n> second invariant\n";
  const sourceDir = path.join(layout.workspacesDir, node.id, "docs");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "overview.md"), source, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-multiline-prefix",
        source_path: "docs/overview.md",
        source_location: "lines 1-2",
        kind: "invariant",
        verbatim: source.trim(),
        inventory_ids: ["inventory-multiline-prefix"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-multiline-prefix",
        description: "Both source bullets remain linked to one inventory row.",
        ledger_ids: ["evidence-multiline-prefix"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(layout, node.id, "setup/project-discovery.md", fixtureInvariantLedgerMarkdown(JSON.stringify(ledger)));

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  for (const verbatim of [
    "first invariant\n> second invariant",
    "- first invariant\nsecond invariant",
    "> first invariant\n> second invariant"
  ]) {
    const changedMarkdownPrefix = structuredClone(ledger);
    changedMarkdownPrefix.entries[0]!.verbatim = verbatim;
    writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(changedMarkdownPrefix));
    writeArtifact(
      layout,
      node.id,
      "setup/project-discovery.md",
      fixtureInvariantLedgerMarkdown(JSON.stringify(changedMarkdownPrefix))
    );
    const prefixMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
    assert.equal(prefixMismatch.ok, false);
    assert.ok(
      prefixMismatch.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH")
    );
  }
});

test("project discovery gate preserves symbol evidence whitespace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-symbol-whitespace" });
  const node = {
    ...plannedNode(["setup/project-discovery.md", "setup/invariant-evidence-ledger.json"]),
    id: "project-discovery",
    logical_id: "project-discovery"
  };
  const verbatim = "function foo  () external {\n  return;\n}";
  const sourceDir = path.join(layout.workspacesDir, node.id, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "Hub.sol"), `${verbatim}\n`, "utf8");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-symbol-whitespace",
        source_path: "src/Hub.sol",
        source_location: "function foo",
        kind: "invariant",
        verbatim,
        inventory_ids: ["inventory-symbol-whitespace"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-symbol-whitespace",
        description: "The symbol declaration remains linked to its source evidence.",
        ledger_ids: ["evidence-symbol-whitespace"]
      }
    ],
    scan_probes: []
  };
  writeArtifact(layout, node.id, "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writeArtifact(layout, node.id, "setup/project-discovery.md", fixtureInvariantLedgerMarkdown(JSON.stringify(ledger)));

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

// Surfaced while settling issue #292 and independent of the empty-ledger question: every shape of
// the ledger returned before fan-in reached a `verifyInvariantProbePath` call, so fan-in checked
// probe containment for no shape at all. An escaping probe path only ever had to survive the
// discovery node, and fan-in re-reads that same artifact without re-checking it.
test("fanin gate checks scan probe containment against the discovery workspace", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-fanin-probe-containment" });
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon"]
  };
  fs.mkdirSync(path.join(layout.workspacesDir, "project-discovery"), { recursive: true });
  const ledger = (probePath: string) =>
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      no_invariants_justification: "Discovery found no invariant statement in this target.",
      scan_probes: [{ id: "probe-1", source_path: probePath, query: "invariant", result: "nothing found" }]
    });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "A canonical property with no ledger evidence behind it.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "A canonical property with no ledger evidence behind it."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\n### End canonical property: "property-1"\n'
  );
  writePropertyLens(layout, "property-specification-recon", ["recon-1"]);

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger("."));
  const contained = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contained.ok, true, JSON.stringify(contained.diagnostics));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Drifted Markdown that the old no-evidence early return skipped."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\n### End canonical property: "property-1"\n'
  );
  const noEvidenceParity = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(noEvidenceParity.ok, false, JSON.stringify(noEvidenceParity.diagnostics));
  assert.ok(
    noEvidenceParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"),
    JSON.stringify(noEvidenceParity.diagnostics)
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "A canonical property with no ledger evidence behind it."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\n### End canonical property: "property-1"\n'
  );

  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", ledger("../../outside"));
  const escaping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(escaping.ok, false, JSON.stringify(escaping.diagnostics));
  assert.ok(
    escaping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_PROBE_PATH_INVALID"),
    JSON.stringify(escaping.diagnostics)
  );

  // Fan-in is the second gate that reads this artifact, and issue #292's whole point is that the
  // ledger must have ONE reading at both of them. The canonical JSON Schema now requires the
  // justification before semantic checks run, so fan-in must reject the invalid registered document.
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: [{ id: "probe-1", source_path: ".", query: "invariant", result: "nothing found" }]
    })
  );
  const unjustified = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unjustified.ok, false, JSON.stringify(unjustified.diagnostics));
  assert.ok(
    unjustified.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "INVARIANT_LEDGER_AUTHORITY_INVALID" &&
        diagnostic.message.includes("no_invariants_justification")
    ),
    JSON.stringify(unjustified.diagnostics)
  );
});

test("fanin gate requires every invariant ledger entry to map to a canonical property", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invariant-ledger-properties" });
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-borrowed-assets",
        source_path: "docs/overview.md",
        source_location: "lines 54-55",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-hub-solvency"]
      },
      {
        id: "evidence-borrowed-shares",
        source_path: "docs/overview.md",
        source_location: "line 56",
        kind: "invariant",
        verbatim: "Total borrowed shares == total minted debt shares",
        inventory_ids: ["inventory-hub-borrowed-shares"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-solvency",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-borrowed-assets"]
      },
      {
        id: "inventory-hub-borrowed-shares",
        description: "Borrowed share accounting remains consistent.",
        ledger_ids: ["evidence-borrowed-shares"]
      }
    ],
    scan_probes: []
  };
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon"]
  };
  const missingUpstreamLedger = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingUpstreamLedger.ok, false);
  assert.ok(missingUpstreamLedger.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MISSING"));
  writeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json", JSON.stringify(ledger));
  writePropertyLens(layout, "property-specification-recon", ["recon-1"]);
  const catalog = (ledgerIds: string[]) =>
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets remain at or below total supplied assets.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ledgerIds
        }
      ]
    });

  writeArtifact(layout, "property-specification-fanin", "properties.json", catalog(["evidence-borrowed-assets"]));
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    fixtureCanonicalPropertiesMarkdown(catalog(["evidence-borrowed-assets"]))
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, false);
  const missingMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(missingMapping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_REFERENCE_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    catalog(["evidence-borrowed-assets", "evidence-borrowed-shares"])
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    fixtureCanonicalPropertiesMarkdown(catalog(["evidence-borrowed-assets", "evidence-borrowed-shares"]))
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    fixtureCanonicalPropertiesMarkdown(catalog(["evidence-borrowed-assets", "evidence-borrowed-shares"])).replace(
      'ledger_ids: ["evidence-borrowed-assets","evidence-borrowed-shares"]',
      'ledger_ids: ["missing mapping"]'
    )
  );
  const missingMarkdownMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingMarkdownMapping.ok, false);
  assert.ok(
    missingMarkdownMapping.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING"
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    catalog(["evidence-borrowed-assets", "evidence-unknown"])
  );
  const unknownMapping = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(unknownMapping.ok, false);
  assert.ok(unknownMapping.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_REFERENCE_UNKNOWN"));
});

test("property fan-in gate rejects Markdown that omits source-only canonical rows", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-markdown-parity" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-borrowed-assets",
          source_path: "docs/overview.md",
          source_location: "line 55",
          kind: "invariant",
          verbatim: "Total borrowed assets remain below supplied assets.",
          inventory_ids: ["inventory-hub-solvency"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-hub-solvency",
          description: "Hub borrowed assets remain at or below supplied assets.",
          ledger_ids: ["evidence-borrowed-assets"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets | supplied assets remain bounded.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ["evidence-borrowed-assets"]
        },
        {
          id: "property-2",
          description: "Supply share price and drawn index do not decrease.",
          category: "monotonicity",
          priority: "high",
          sources: [{ source_node_id: "property-specification-aviggiano", source_property_id: "aviggiano-2" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Total borrowed assets | supplied assets remain bounded."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\nledger_ids: ["evidence-borrowed-assets"]\n### End canonical property: "property-1"\n'
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Total borrowed assets | supplied assets remain bounded.",
          category: "hub-accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
          ledger_ids: ["evidence-borrowed-assets"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Total borrowed assets | supplied assets remain bounded."\ncategory: "hub-accounting"\npriority: "high"\nledger_ids: ["evidence-borrowed-assets"]\n### End canonical property: "property-1"\n'
  );
  const missingSources = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSources.ok, false);
  assert.ok(
    missingSources.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && diagnostic.message.includes("sources")
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Total borrowed assets remain at or below supplied assets; evidence-borrowed-assets"\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\nledger_ids: ["evidence-other"]\n### End canonical property: "property-1"\n'
  );
  const missingLedgerField = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingLedgerField.ok, false);
  assert.ok(
    missingLedgerField.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING")
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Total borrowed assets remain at or below supplied assets."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"},{"source_node_id":"property-specification-extra","source_property_id":"extra-1"}]\nledger_ids: ["evidence-borrowed-assets","evidence-extra"]\n### End canonical property: "property-1"\n'
  );
  const extraMappings = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(extraMappings.ok, false);
  assert.ok(extraMappings.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));
  assert.ok(
    extraMappings.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING")
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\ndescription: "Total borrowed assets remain at or below supplied assets. extra"\ncategory: "hub-accounting extra"\npriority: "high extra"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"},{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\nledger_ids: ["evidence-borrowed-assets","evidence-borrowed-assets"]\n### End canonical property: "property-1"\n'
  );
  const duplicateAndScalarDrift = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(duplicateAndScalarDrift.ok, false);
  assert.ok(
    duplicateAndScalarDrift.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING")
  );
  assert.ok(
    duplicateAndScalarDrift.diagnostics.some(
      (diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING"
    )
  );

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-1"\nid: "property-2"\ndescription: "Total borrowed assets | supplied assets remain bounded."\ncategory: "hub-accounting"\npriority: "high"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]\nledger_ids: ["evidence-borrowed-assets"]\n### End canonical property: "property-1"\n### Canonical property: "property-extra"\n### End canonical property: "property-extra"\n### Canonical property: "property-1"\n### End canonical property: "property-1"\n'
  );
  const headingParity = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(headingParity.ok, false);
  assert.ok(headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_CANONICAL_UNKNOWN"));
  assert.ok(
    headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_CANONICAL_DUPLICATE")
  );
  assert.ok(headingParity.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));
});

// R45 and R46 both lost a full `property-specification-fanin` attempt to this (issue #297). Read from
// R46's own artifacts: 219 canonical properties, 78 with a non-empty `ledger_ids`, and the markdown
// renders the field exactly 78 times. The model did what the prompt asks -- "add a `ledger_ids` array to
// every canonical property THAT REPRESENTS one or more ledger entries" -- and what the schema allows,
// since `ledger_ids` is `.optional()`. Only the gate demanded the field unconditionally.
test("property fan-in gate does not demand a ledger_ids field from a property that has none", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-optional" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-from-lens-only",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-supply" }]
        },
        {
          id: "property-from-ledger",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-accounting" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      '### Canonical property: "property-from-lens-only"',
      'description: "Supply completes for valid state."',
      'category: "dos-liveness"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-supply"}]',
      '### End canonical property: "property-from-lens-only"',
      '### Canonical property: "property-from-ledger"',
      'description: "Supply accounting remains consistent."',
      'category: "accounting"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-accounting"}]',
      'ledger_ids: ["evidence-supply"]',
      '### End canonical property: "property-from-ledger"'
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && diagnostic.message.includes('"ledger_ids"')
    ),
    false,
    JSON.stringify(result.diagnostics)
  );
});

// The other half: a property that DOES have ledger IDs must still render them, so this cannot be read
// as dropping ledger parity altogether.
test("property fan-in gate still requires the ledger_ids field when the property has ledger IDs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-required" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-from-ledger",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-accounting" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      '### Canonical property: "property-from-ledger"',
      'description: "Supply accounting remains consistent."',
      'category: "accounting"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-accounting"}]',
      '### End canonical property: "property-from-ledger"'
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && diagnostic.message.includes('"ledger_ids"')
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("property fan-in gate rejects undeclared Markdown ledger-evidence fields instead of treating them as fallbacks", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-ledger-evidence" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-supply",
          description: "Supply accounting remains consistent.",
          ledger_ids: ["evidence-supply"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      '### Canonical property: "property-supply"',
      'description: "Supply accounting remains consistent."',
      'category: "accounting"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-supply"}]',
      'ledger_ids: ["evidence-supply"]',
      '### End canonical property: "property-supply"'
    ].join("\n")
  );
  writePropertyLens(layout, "property-specification-recon", ["recon-supply"]);
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon"]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  for (const evidenceField of [
    'ledger_evidence: {"id":"evidence-supply"}',
    'ledger evidence: {"id":"evidence-supply"}',
    'ledger-evidence: {"id":"evidence-supply"}'
  ]) {
    writeArtifact(
      layout,
      "property-specification-fanin",
      "properties.md",
      [
        '### Canonical property: "property-supply"',
        'description: "Supply accounting remains consistent."',
        'category: "accounting"',
        'priority: "high"',
        'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-supply"}]',
        'ledger_ids: ["evidence-supply"]',
        evidenceField,
        '### End canonical property: "property-supply"'
      ].join("\n")
    );
    const undeclaredField = verifyRequiredArtifactsForAttempt(layout, node, node.id);
    assert.equal(undeclaredField.ok, false, `${evidenceField}: ${JSON.stringify(undeclaredField.diagnostics)}`);
    assert.ok(
      undeclaredField.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "PROPERTY_MARKDOWN_PARITY_EXTRA" || diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"
      ),
      `${evidenceField}: ${JSON.stringify(undeclaredField.diagnostics)}`
    );
  }

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      '### Canonical property: "property-supply"',
      'description: "Supply accounting remains consistent."',
      'category: "accounting"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-supply"}]',
      'ledger_ids: ["evidence-supply","evidence-extra"]',
      '### End canonical property: "property-supply"'
    ].join("\n")
  );
  const extraLedgerResult = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(extraLedgerResult.ok, false);
  assert.ok(
    extraLedgerResult.diagnostics.some((diagnostic) => diagnostic.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING")
  );
});

test("property fan-in gate preserves reference expectation metadata in Markdown", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-reference-parity" });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "liveness",
          verbatim: "Supply completes for valid state.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        { id: "inventory-supply", description: "Supply remains live.", ledger_ids: ["evidence-supply"] }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "reference-properties-recon",
    "references/recon.md",
    "# Examples\n\nFor example, `scfuzzbench:aave-v4:iSpoke_supply` may be used when a supplied benchmark catalog names it.\n"
  );
  writeArtifact(
    layout,
    "reference-properties-recon",
    "references/expectations.json",
    JSON.stringify({
      schema_version: "ultrafuzz.reference-expectations.v2",
      expectations: [{ id: "scfuzzbench:aave-v4:iSpoke_supply" }]
    })
  );
  writeArtifact(
    layout,
    "project-discovery",
    "setup/arbitrary.json",
    JSON.stringify({ expectations: [{ id: "scfuzzbench:aave-v4:iSpoke_supply" }] })
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon"]
  };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-supply"\ndescription: "Supply completes for valid state."\ncategory: "dos-liveness"\npriority: "medium"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"iSpoke_supply"}]\nledger_ids: ["evidence-supply"]\n### End canonical property: "property-supply"\n'
  );
  const missing = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"));

  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-supply"\ndescription: "Supply completes for valid state."\ncategory: "dos-liveness"\npriority: "medium"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"iSpoke_supply"}]\nledger_ids: ["evidence-supply"]\nreference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]\n### End canonical property: "property-supply"\n'
  );
  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium"
        }
      ]
    })
  );
  const droppedFromLens = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(droppedFromLens.ok, false);
  assert.ok(
    droppedFromLens.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_DROPPED"),
    JSON.stringify(droppedFromLens.diagnostics)
  );
});

for (const [label, undeclaredPath] of [
  ["conventional", "properties/recon.json"],
  ["arbitrary sibling", "properties/other.json"]
] as const) {
  test(`property fan-in ignores ${label} lens JSON without a state declaration`, () => {
    const layout = createRunLayout({
      projectRoot: tempProject(),
      runId: `run-undeclared-lens-${label.replaceAll(" ", "-")}`
    });
    const node = writeMinimalPropertyFaninFixture(layout);
    const lensPath = writeArtifact(
      layout,
      "property-specification-recon",
      undeclaredPath,
      JSON.stringify({
        schema_version: "ultrafuzz.property-lens.v2",
        properties: [
          {
            id: "recon-1",
            description: "Supply accounting remains consistent.",
            category: "accounting",
            priority: "high"
          }
        ]
      })
    );
    const before = fs.readFileSync(lensPath);

    const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

    assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_DECLARATION_MISSING"),
      JSON.stringify(result.diagnostics)
    );
    assert.deepEqual(fs.readFileSync(lensPath), before);
  });
}

test("property fan-in consumes one exactly bound custom property-lens path", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-custom-declared-lens" });
  const node = writeMinimalPropertyFaninFixture(layout);
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "custom/recon-lens.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("authenticated current-node snapshots remain authoritative across live-file swaps", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-authenticated-current-snapshots" });
  const node = writeMinimalPropertyFaninFixture(layout);
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "custom/recon-lens.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );

  const artifactDir = getNodeArtifactDir(layout, node.id);
  const propertiesPath = path.join(artifactDir, "properties.json");
  const markdownPath = path.join(artifactDir, "properties.md");
  const propertiesBytes = fs.readFileSync(propertiesPath);
  const validMarkdownBytes = fs.readFileSync(markdownPath);
  const invalidMarkdownBytes = Buffer.from("# Authenticated but semantically unrelated Markdown\n", "utf8");
  const authenticated = (
    markdownBytes: Buffer
  ): NonNullable<Parameters<typeof verifyRuntimeRequiredArtifactsForAttempt>[4]> => {
    const bytesByPath = new Map<string, Buffer>([
      ["properties.json", propertiesBytes],
      ["properties.md", markdownBytes]
    ]);
    return {
      outputs: new Map(
        node.outputs.map((output) => [
          output.path,
          {
            absolutePath: path.join(artifactDir, output.path),
            bytes: Buffer.from(bytesByPath.get(output.path)!)
          }
        ])
      ),
      publications: new Map([...bytesByPath].map(([relativePath, bytes]) => [relativePath, Buffer.from(bytes)]))
    };
  };

  // An attacker temporarily restores authorized live bytes after the host has
  // captured a semantically invalid publication. The immutable capture wins.
  const invalidCapture = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    node.id,
    undefined,
    authenticated(invalidMarkdownBytes)
  );
  assert.equal(invalidCapture.ok, false, JSON.stringify(invalidCapture.diagnostics));
  assert.ok(
    invalidCapture.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"),
    JSON.stringify(invalidCapture.diagnostics)
  );

  // The opposite swap cannot make an already authenticated valid publication
  // fail: the later mutable file is not consulted by the contextual join.
  fs.writeFileSync(markdownPath, invalidMarkdownBytes);
  const validCapture = verifyRequiredArtifactsForAttempt(
    layout,
    node,
    node.id,
    undefined,
    authenticated(validMarkdownBytes)
  );
  assert.equal(validCapture.ok, true, JSON.stringify(validCapture.diagnostics));
  assert.deepEqual(fs.readFileSync(markdownPath), invalidMarkdownBytes);
});

test("property fan-in authenticates every sealed model-fanout lens attempt independently", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-sealed-fanout-lenses" });
  const faninNode = writeMinimalPropertyFaninFixture(layout);
  const discoveryGraph = JSON.parse(fs.readFileSync(layout.graphPath, "utf8")) as { nodes: PlannedGraphNode[] };
  const referenceNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "reference-input",
    logical_id: "reference-input",
    display_name: "Reference input",
    kind: "reference",
    depends_on: [],
    artifact_dir: "artifacts/reference-input",
    outputs: [boundOutput("result.md", "ultrafuzz/nonempty-markdown@1", true)],
    prompt_id: "reference-input",
    prompt_path: "",
    reference: "reference-input",
    reference_revision: {
      provider: "github",
      repo: "owner/repo",
      commit: "b".repeat(40),
      paths: ["result.md"]
    },
    model_fanout: []
  };
  const discoveryNode: PlannedGraphNode = {
    ...discoveryGraph.nodes.find((node) => node.id === "project-discovery")!,
    depends_on: [referenceNode.id],
    workflow: { node_id: "node:project-discovery", task_node_ids: ["node:project-discovery"] }
  };
  const lensOutput = boundOutput("custom/recon-lens.json", "ultrafuzz/property-lens@2", true);
  const lensNode: PlannedGraphNode = {
    ...plannedNode([]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    display_name: "Property specification recon",
    artifact_dir: "artifacts/property-specification-recon",
    depends_on: ["project-discovery"],
    outputs: [lensOutput],
    model_fanout: [
      {
        model_profile_id: "model-a",
        agent_ref: "CodexAgent",
        model_name: "gpt-test-a",
        reasoning_effort: "high",
        model_index: 0,
        loop_index: 0,
        attempt_index: 0
      },
      {
        model_profile_id: "model-b",
        agent_ref: "CodexAgent",
        model_name: "gpt-test-b",
        reasoning_effort: "high",
        model_index: 1,
        loop_index: 0,
        attempt_index: 0
      }
    ],
    workflow: {
      node_id: "node:property-specification-recon__model_0__attempt_0",
      task_node_ids: [
        "node:property-specification-recon__model_0__attempt_0",
        "node:property-specification-recon__model_1__attempt_0"
      ]
    }
  };
  const currentNode: PlannedGraphNode = {
    ...faninNode,
    artifact_dir: `artifacts/${faninNode.id}`,
    depends_on: [lensNode.id],
    workflow: { node_id: `node:${faninNode.id}`, task_node_ids: [`node:${faninNode.id}`] }
  };
  const unrelatedNode: PlannedGraphNode = {
    ...plannedNode(["unrelated.md"]),
    id: "unrelated-review",
    logical_id: "unrelated-review",
    display_name: "Unrelated review",
    artifact_dir: "artifacts/unrelated-review",
    workflow: { node_id: "node:unrelated-review", task_node_ids: ["node:unrelated-review"] }
  };
  const lensAttempts = [
    "property-specification-recon__model_0__attempt_0",
    "property-specification-recon__model_1__attempt_0"
  ];
  const lensDocument = JSON.stringify({
    schema_version: "ultrafuzz.property-lens.v2",
    properties: [
      {
        id: "recon-1",
        description: "Supply accounting remains consistent.",
        category: "accounting",
        priority: "high"
      }
    ]
  });
  for (const [modelIndex, attemptId] of lensAttempts.entries()) {
    registerArtifactNode(layout, attemptId, [lensOutput]);
    writeArtifactFile(layout, attemptId, lensOutput.path, lensDocument);
    finalizeArtifactNode(layout, attemptId, [lensOutput], {
      concreteNodeId: lensNode.id,
      logicalNodeId: lensNode.logical_id,
      modelIndex
    });
  }
  writePlannedGraph(layout, [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode]);

  writeArtifactFile(layout, referenceNode.id, "result.md", "# Reference input\n");
  writeArtifactManifest({
    layout,
    nodeId: referenceNode.id,
    include: ["result.md"],
    outputs: referenceNode.outputs,
    provenance: { origin: "pinned-reference" }
  });
  // The minimal fixture finalized discovery before this test added its pinned
  // reference dependency. Re-seal that manifest against the exact graph edge,
  // then restore the richer planned node metadata used by the task authority.
  finalizeArtifactNode(layout, discoveryNode.id, discoveryNode.outputs);
  for (const [modelIndex, attemptId] of lensAttempts.entries()) {
    finalizeArtifactNode(layout, attemptId, lensNode.outputs, {
      concreteNodeId: lensNode.id,
      logicalNodeId: lensNode.logical_id,
      modelIndex
    });
  }
  writePlannedGraph(layout, [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode]);

  const referenceArtifactDir = getNodeArtifactDir(layout, referenceNode.id, { create: true });
  const discoveryTaskWithReferenceVerifier = smithersTaskForNode({
    layout,
    node: discoveryNode,
    attemptId: discoveryNode.id,
    dependencies: [referenceNode.id],
    dependencyArtifactDirs: [referenceArtifactDir]
  });
  const discoveryTask: SmithersTaskManifestTask = {
    ...discoveryTaskWithReferenceVerifier,
    dependencySmithersNodeIds: [],
    metadata: {
      ...discoveryTaskWithReferenceVerifier.metadata,
      dependencies: {
        ...discoveryTaskWithReferenceVerifier.metadata.dependencies,
        smithersNodeIds: []
      }
    }
  };
  const lensTasks = lensAttempts.map((attemptId, modelIndex) =>
    smithersTaskForNode({
      layout,
      node: lensNode,
      attemptId,
      dependencies: [discoveryNode.id],
      dependencyArtifactDirs: [referenceArtifactDir, discoveryTask.artifactDir],
      modelIndex
    })
  );
  const currentTask = smithersTaskForNode({
    layout,
    node: currentNode,
    attemptId: currentNode.id,
    dependencies: lensAttempts,
    dependencyArtifactDirs: [
      referenceArtifactDir,
      discoveryTask.artifactDir,
      ...lensTasks.map((task) => task.artifactDir)
    ]
  });
  const unrelatedTask = smithersTaskForNode({
    layout,
    node: unrelatedNode,
    attemptId: unrelatedNode.id
  });
  const tasks = [discoveryTask, ...lensTasks, currentTask, unrelatedTask];
  writeSealedFixtureTaskAuthority(layout, [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode], tasks);
  const valid = verifyRuntimeRequiredArtifactsForAttempt(layout, currentNode, currentTask.attemptId, {
    task: currentTask,
    tasks
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const omittedAncestorTask: SmithersTaskManifestTask = {
    ...currentTask,
    dependencyArtifactDirs: currentTask.dependencyArtifactDirs.filter(
      (directory) => directory !== discoveryTask.artifactDir
    )
  };
  writeSealedFixtureTaskAuthority(
    layout,
    [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode],
    [discoveryTask, ...lensTasks, omittedAncestorTask, unrelatedTask]
  );
  const omittedAncestor = verifyRuntimeRequiredArtifactsForAttempt(layout, currentNode, currentTask.attemptId, {
    task: omittedAncestorTask,
    tasks: [discoveryTask, ...lensTasks, omittedAncestorTask, unrelatedTask]
  });
  assert.equal(omittedAncestor.ok, false, JSON.stringify(omittedAncestor.diagnostics));
  assert.ok(
    omittedAncestor.diagnostics.some((diagnostic) => diagnostic.message.includes(discoveryTask.artifactDir)),
    JSON.stringify(omittedAncestor.diagnostics)
  );

  const unrelatedAncestorTask: SmithersTaskManifestTask = {
    ...currentTask,
    dependencyArtifactDirs: [...currentTask.dependencyArtifactDirs, unrelatedTask.artifactDir]
  };
  writeSealedFixtureTaskAuthority(
    layout,
    [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode],
    [discoveryTask, ...lensTasks, unrelatedAncestorTask, unrelatedTask]
  );
  const unrelatedAncestor = verifyRuntimeRequiredArtifactsForAttempt(layout, currentNode, currentTask.attemptId, {
    task: unrelatedAncestorTask,
    tasks: [discoveryTask, ...lensTasks, unrelatedAncestorTask, unrelatedTask]
  });
  assert.equal(unrelatedAncestor.ok, false, JSON.stringify(unrelatedAncestor.diagnostics));
  assert.ok(
    unrelatedAncestor.diagnostics.some((diagnostic) => diagnostic.message.includes(unrelatedTask.artifactDir)),
    JSON.stringify(unrelatedAncestor.diagnostics)
  );

  const missingDeclaredTasks = [discoveryTask, lensTasks[0]!, currentTask, unrelatedTask];
  writeSealedFixtureTaskAuthority(
    layout,
    [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode],
    missingDeclaredTasks
  );
  const missingDeclaredAttempt = verifyRuntimeRequiredArtifactsForAttempt(layout, currentNode, currentTask.attemptId, {
    task: currentTask,
    tasks: missingDeclaredTasks
  });
  assert.equal(missingDeclaredAttempt.ok, false, JSON.stringify(missingDeclaredAttempt.diagnostics));
  assert.ok(
    missingDeclaredAttempt.diagnostics.some((diagnostic) =>
      `${diagnostic.message} ${diagnostic.path ?? ""}`.includes(lensAttempts[1]!)
    ),
    JSON.stringify(missingDeclaredAttempt.diagnostics)
  );

  fs.unlinkSync(path.join(layout.root, ".ultrafuzz-verification", `${lensAttempts[1]}.json`));
  writeSealedFixtureTaskAuthority(layout, [referenceNode, discoveryNode, lensNode, currentNode, unrelatedNode], tasks);
  const missingSecondAttempt = verifyRuntimeRequiredArtifactsForAttempt(layout, currentNode, currentTask.attemptId, {
    task: currentTask,
    tasks
  });
  assert.equal(missingSecondAttempt.ok, false, JSON.stringify(missingSecondAttempt.diagnostics));
  assert.ok(
    missingSecondAttempt.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_LENS_AUTHORITY_INVALID" &&
        `${diagnostic.message} ${diagnostic.path ?? ""}`.includes(lensAttempts[1]!)
    ),
    JSON.stringify(missingSecondAttempt.diagnostics)
  );
});

test("property fan-in selects a declared lens contract without relying on the producer name", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-contract-selected-lens" });
  const node = writeMinimalPropertyFaninFixture(layout, {
    sourceNodeId: "independent-security-review",
    dependsOn: ["independent-security-review"]
  });
  writeDeclaredPropertyLens(
    layout,
    "independent-security-review",
    "custom/review-lens.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("property fan-in cannot hide a planned lens by omitting its state declaration and catalog rows", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-planned-lens-state-omission" });
  const node = writeMinimalPropertyFaninFixture(layout, {
    sourceNodeId: "project-discovery",
    sourcePropertyId: "evidence-1",
    dependsOn: ["property-specification-recon"]
  });
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "custom/recon-lens.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );
  const state = readRunState(layout);
  delete state.nodes["property-specification-recon"]!.outputs;
  writeRunState(layout, state);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_DECLARATION_MISSING"),
    JSON.stringify(result.diagnostics)
  );
});

for (const finalizationState of ["failed", "unfinalized"] as const) {
  test(`property fan-in rejects a ${finalizationState} declared lens producer`, () => {
    const layout = createRunLayout({
      projectRoot: tempProject(),
      runId: `run-${finalizationState}-declared-lens`
    });
    const node = writeMinimalPropertyFaninFixture(layout);
    const output = boundOutput("custom/recon.json", "ultrafuzz/property-lens@2", true);
    const lens = JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    });
    if (finalizationState === "failed") {
      writeDeclaredPropertyLens(layout, "property-specification-recon", output.path, lens);
      updateNodeState(layout, "property-specification-recon", { status: "failed" });
    } else {
      registerArtifactNode(layout, "property-specification-recon", [output]);
      writeArtifactFile(layout, "property-specification-recon", output.path, lens);
    }

    const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

    assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_AUTHORITY_INVALID"),
      JSON.stringify(result.diagnostics)
    );
  });
}

for (const missingAuthority of ["manifest", "verification marker"] as const) {
  test(`property fan-in rejects a declared lens with a missing ${missingAuthority}`, () => {
    const layout = createRunLayout({
      projectRoot: tempProject(),
      runId: `run-lens-missing-${missingAuthority.replaceAll(" ", "-")}`
    });
    const node = writeMinimalPropertyFaninFixture(layout);
    writeDeclaredPropertyLens(
      layout,
      "property-specification-recon",
      "custom/recon.json",
      JSON.stringify({
        schema_version: "ultrafuzz.property-lens.v2",
        properties: [
          {
            id: "recon-1",
            description: "Supply accounting remains consistent.",
            category: "accounting",
            priority: "high"
          }
        ]
      })
    );
    const authorityPath =
      missingAuthority === "manifest"
        ? path.join(getNodeArtifactDir(layout, "property-specification-recon"), "artifact-manifest.json")
        : path.join(layout.root, ".ultrafuzz-verification", "property-specification-recon.json");
    fs.unlinkSync(authorityPath);

    const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

    assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_AUTHORITY_INVALID"),
      JSON.stringify(result.diagnostics)
    );
  });
}

test("property fan-in rejects lens bytes changed after finalization without rewriting them", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-finalized-lens-tamper" });
  const node = writeMinimalPropertyFaninFixture(layout);
  const lensPath = writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "custom/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );
  const changedBytes = Buffer.from(
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "These are different but still schema-valid bytes.",
          category: "accounting",
          priority: "high"
        }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(lensPath, changedBytes);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_AUTHORITY_INVALID"),
    JSON.stringify(result.diagnostics)
  );
  assert.deepEqual(fs.readFileSync(lensPath), changedBytes);
});

test("property fan-in rejects ambiguous property-lens declarations", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-ambiguous-declared-lens" });
  const node = writeMinimalPropertyFaninFixture(layout);
  const lens = JSON.stringify({
    schema_version: "ultrafuzz.property-lens.v2",
    properties: [
      {
        id: "recon-1",
        description: "Supply accounting remains consistent.",
        category: "accounting",
        priority: "high"
      }
    ]
  });
  registerArtifactNode(layout, "property-specification-recon", [
    boundOutput("custom/recon-a.json", "ultrafuzz/property-lens@2"),
    boundOutput("custom/recon-b.json", "ultrafuzz/property-lens@2")
  ]);
  writeArtifact(layout, "property-specification-recon", "custom/recon-a.json", lens);
  writeArtifact(layout, "property-specification-recon", "custom/recon-b.json", lens);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_DECLARATION_AMBIGUOUS"),
    JSON.stringify(result.diagnostics)
  );
});

test("property fan-in rejects a stale property-lens schema binding", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-stale-declared-lens" });
  const node = writeMinimalPropertyFaninFixture(layout);
  registerArtifactNode(layout, "property-specification-recon", [
    {
      ...boundOutput("custom/recon.json", "ultrafuzz/property-lens@2"),
      schema_sha256: "0".repeat(64)
    }
  ]);
  writeArtifact(
    layout,
    "property-specification-recon",
    "custom/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_LENS_SCHEMA_BINDING_INVALID"),
    JSON.stringify(result.diagnostics)
  );
});

test("an unrelated declared lens cannot satisfy a property fan-in source join", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-unrelated-declared-lens" });
  const node = writeMinimalPropertyFaninFixture(layout, {
    sourceNodeId: "property-specification-aviggiano",
    sourcePropertyId: "aviggiano-1",
    dependsOn: ["property-specification-recon"]
  });
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "custom/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );
  writeDeclaredPropertyLens(
    layout,
    "property-specification-aviggiano",
    "custom/aviggiano.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "aviggiano-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" && diagnostic.message.includes("Unknown property source")
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("a stale same-logical lens attempt cannot satisfy the current concrete fan-in dependency", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-stale-same-logical-lens",
    stateNodes: [
      {
        id: "property-specification-recon-current",
        logicalNodeId: "property-specification-recon",
        status: "succeeded"
      },
      {
        id: "property-specification-recon-stale",
        logicalNodeId: "property-specification-recon",
        status: "succeeded"
      }
    ]
  });
  const node = writeMinimalPropertyFaninFixture(layout, {
    sourceNodeId: "property-specification-recon",
    sourcePropertyId: "recon-1",
    dependsOn: ["property-specification-recon-current"]
  });
  writePropertyLens(layout, "property-specification-recon-current", ["current-only"]);
  writePropertyLens(layout, "property-specification-recon-stale", ["recon-1"]);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" && diagnostic.message.includes("Unknown property source")
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("property lens validation rejects duplicate keys without changing source bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-duplicate-key-property-lens" });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon"
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    '{"schema_version":"ultrafuzz.property-lens.v2","properties":[{"id":"recon-1","description":"Expected behavior","category":"accounting","priority":"high","priority":"low"}]}\n'
  );
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "JSON_DUPLICATE_KEY"),
    JSON.stringify(result.diagnostics)
  );
  assert.deepEqual(fs.readFileSync(lensPath), before);
});

test("property lens gate accepts a bound pinned expectation catalog without rewriting the lens", () => {
  const expectationId = "scfuzzbench:aave-v4:iSpoke_supply";
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.reference-expectations.v2",
    expectations: [{ id: expectationId }]
  });
  const catalogDigest = createHash("sha256").update(catalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-authority",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference: "reference-properties-recon",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lens = JSON.stringify({
    schema_version: "ultrafuzz.property-lens.v2",
    properties: [
      {
        id: "iSpoke_supply",
        description: "Supply completes for valid state.",
        category: "dos-liveness",
        priority: "high",
        reference_expectations: [expectationId]
      }
    ]
  });
  const lensPath = writeDeclaredPropertyLens(layout, node.id, "properties/recon.json", lens);
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", catalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(fs.readFileSync(lensPath), before);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_SANITIZED" ||
        diagnostic.code === "ARTIFACT_VERIFICATION_DIGEST_REFRESHED"
    ),
    false
  );
});

test("property lens gate rejects expectations when no pinned catalog was supplied without rewriting bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-no-catalog" });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon"
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: ["LEND_ACC_01"]
        }
      ]
    })
  );
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT")
  );
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED"));
  assert.deepEqual(fs.readFileSync(lensPath), before);
});

test("property lens gate requires true reference expectation omission when no catalog was supplied", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-no-catalog-empty-field" });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon"
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: []
        }
      ]
    })
  );
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT")
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED" &&
        diagnostic.path?.endsWith("#$.properties[0].reference_expectations") === true
    ),
    JSON.stringify(result.diagnostics)
  );
  assert.deepEqual(fs.readFileSync(lensPath), before);
});

test("property lens gate rejects every unauthorized catalog spelling without conversion", () => {
  const suppliedId = "supplied-expectation-01";
  const unauthorizedIds = [
    "testConvertToAssetsSharesDesirable",
    "erc4626.maxDeposit",
    "LEND_ACC_01",
    "LEND-ACC-01",
    "CRYTIC-ERC4626-05",
    "benchmark:unexpected"
  ];
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.reference-expectations.v2",
    expectations: [{ id: suppliedId }]
  });
  const catalogDigest = createHash("sha256").update(catalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-unauthorized",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference: "reference-properties-recon",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: [suppliedId, ...unauthorizedIds]
        }
      ]
    })
  );
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", catalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED").length,
    unauthorizedIds.length
  );
  assert.deepEqual(fs.readFileSync(lensPath), before);
  assert.equal(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_SANITIZED" ||
        diagnostic.code === "ARTIFACT_VERIFICATION_DIGEST_REFRESHED"
    ),
    false
  );
});

test("property lens gate rejects a digest-bound schema-invalid expectation catalog", () => {
  const expectationId = "scfuzzbench:aave-v4:iSpoke_supply";
  const malformedCatalog = JSON.stringify({ expectations: [{ id: expectationId }] });
  const catalogDigest = createHash("sha256").update(malformedCatalog).digest("hex");
  const catalogOutput = boundOutput("references/expectations.json", "ultrafuzz/reference-expectations@2");
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-malformed-catalog",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [catalogOutput],
        provenance: {
          origin: "pinned-reference",
          reference: "reference-properties-recon",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: catalogDigest
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high",
          reference_expectations: [expectationId]
        }
      ]
    })
  );
  writeArtifact(layout, "reference-properties-recon", "references/expectations.json", malformedCatalog);
  writeArtifactManifest({
    layout,
    nodeId: "reference-properties-recon",
    outputs: [catalogOutput],
    provenance: { origin: "pinned-reference" }
  });
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_TAMPERED"));
  assert.deepEqual(fs.readFileSync(lensPath), before);
});
test("ordinary pinned references without expectation catalogs do not require catalog provenance", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-no-catalog",
    stateNodes: [
      {
        id: "reference-properties-example",
        status: "succeeded",
        outputs: [
          {
            path: "references/example.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contract_digest: "a".repeat(64),
            primary: true
          }
        ],
        provenance: { origin: "pinned-reference", reference: "reference-properties-example" }
      }
    ]
  });
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "high"
        }
      ]
    })
  );
  const base = plannedNode(["properties/recon.json"]);
  const node = {
    ...base,
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    outputs: base.outputs.map((output) => ({ ...output, contract: "ultrafuzz/property-lens@2" as const })),
    depends_on: ["reference-properties-example"]
  };
  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_PROVENANCE_INVALID"),
    false
  );
});

test("the historical reference-expectations filename cannot authorize a property lens", () => {
  const expectationId = "benchmark:historical:supply";
  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.reference-expectations.v2",
    expectations: [{ id: expectationId }]
  });
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-historical-expectation-path",
    stateNodes: [
      {
        id: "reference-properties-recon",
        status: "succeeded",
        outputs: [boundOutput("references/reference-expectations.json", "ultrafuzz/reference-expectations@2")],
        provenance: {
          origin: "pinned-reference",
          reference: "reference-properties-recon",
          reference_expectations: {
            source: "operator-supplied",
            path: "reference-expectations.json",
            sha256: createHash("sha256").update(catalog).digest("hex")
          }
        }
      }
    ]
  });
  const node = {
    ...plannedNode(["properties/recon.json"]),
    id: "property-specification-recon",
    logical_id: "property-specification-recon",
    depends_on: ["reference-properties-recon"]
  };
  const lensPath = writeDeclaredPropertyLens(
    layout,
    node.id,
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high",
          reference_expectations: [expectationId]
        }
      ]
    })
  );
  writeArtifact(layout, "reference-properties-recon", "references/reference-expectations.json", catalog);
  const before = fs.readFileSync(lensPath);

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT")
  );
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED"));
  assert.deepEqual(fs.readFileSync(lensPath), before);
});

test("property fan-in gate rejects a lens reference expectation dropped from canonical JSON", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-properties-reference-drop",
    stateNodes: [
      { id: "property-specification-recon-0", logicalNodeId: "property-specification-recon", status: "succeeded" },
      { id: "property-specification-recon-1", logicalNodeId: "property-specification-recon", status: "succeeded" }
    ]
  });
  writeArtifact(
    layout,
    "project-discovery",
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-supply",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "liveness",
          verbatim: "Supply completes for valid state.",
          inventory_ids: ["inventory-supply"]
        }
      ],
      inventory_rows: [
        { id: "inventory-supply", description: "Supply remains live.", ledger_ids: ["evidence-supply"] }
      ],
      scan_probes: []
    })
  );
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon-0",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon-1",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "iSpoke_supply",
          description: "Withdraw completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_withdraw"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-supply",
          description: "Supply completes for valid state.",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }],
          ledger_ids: ["evidence-supply"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    '### Canonical property: "property-supply"\ndescription: "Supply completes for valid state."\ncategory: "dos-liveness"\npriority: "medium"\nsources: [{"source_node_id":"property-specification-recon","source_property_id":"iSpoke_supply"}]\nledger_ids: ["evidence-supply"]\nreference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]\n### End canonical property: "property-supply"\n'
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin",
    depends_on: ["property-specification-recon-0", "property-specification-recon-1"]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_DROPPED"),
    JSON.stringify(result.diagnostics)
  );
});

test("property fan-in gate rejects the issue 531 LEND_ACC_03 fabrication when every source lens omits expectations", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-issue-531-fabrication" });
  const sourceLenses = [
    ["property-specification-0kn0t", "0kn0t-1"],
    ["property-specification-a16z", "a16z-1"],
    ["property-specification-aviggiano", "aviggiano-1"],
    ["property-specification-certora-thinking", "certora-thinking-1"],
    ["property-specification-crytic", "crytic-1"],
    ["property-specification-josselin-feist", "josselin-feist-1"],
    ["property-specification-recon", "recon-1"],
    ["property-specification-runtime-verification", "runtime-verification-1"]
  ] as const;
  for (const [sourceNodeId, sourcePropertyId] of sourceLenses) {
    writeDeclaredPropertyLens(
      layout,
      sourceNodeId,
      `properties/${sourcePropertyId}.json`,
      JSON.stringify({
        schema_version: "ultrafuzz.property-lens.v2",
        properties: [
          {
            id: sourcePropertyId,
            description: "Supply accounting remains consistent.",
            category: "accounting",
            priority: "high"
          }
        ]
      })
    );
  }
  const node = writeMinimalPropertyFaninFixture(layout, {
    sourceNodeId: "property-specification-recon",
    sourcePropertyId: "recon-1",
    dependsOn: sourceLenses.map(([sourceNodeId]) => sourceNodeId),
    referenceExpectation: "LEND_ACC_03"
  });

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false, JSON.stringify(result.diagnostics));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_DROPPED" && diagnostic.message.includes("LEND_ACC_03")
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("property fan-in gate requires true omission when source lenses carry no authorized expectations", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties-empty-fanin-expectations" });
  writeDeclaredPropertyLens(
    layout,
    "property-specification-recon",
    "properties/recon.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-lens.v2",
      properties: [
        {
          id: "recon-1",
          description: "Supply accounting remains consistent.",
          category: "accounting",
          priority: "high"
        }
      ]
    })
  );
  const node = writeMinimalPropertyFaninFixture(layout);
  const absent = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(absent.ok, true, JSON.stringify(absent.diagnostics));

  const catalog = JSON.stringify({
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-1",
        description: "Supply accounting remains consistent.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
        ledger_ids: ["evidence-1"],
        reference_expectations: []
      }
    ]
  });
  writeArtifact(layout, node.id, "properties.json", catalog);
  writeArtifact(layout, node.id, "properties.md", fixtureCanonicalPropertiesMarkdown(catalog));

  const explicitEmpty = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(explicitEmpty.ok, false, JSON.stringify(explicitEmpty.diagnostics));
  assert.ok(
    explicitEmpty.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_EXPECTATION_OMISSION_REQUIRED"
    ),
    JSON.stringify(explicitEmpty.diagnostics)
  );
});

test("property implementation gate rejects an unknown canonical property reference", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-properties" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-unknown"] },
      properties: [
        {
          property_id: "property-unknown",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const node = {
    ...plannedNode(["implemented-properties.json"]),
    id: "stateful-invariant-implement-properties",
    logical_id: "stateful-invariant-implement-properties"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.message ?? "",
    /property-unknown/u
  );
});

test("property implementation resolves custom declared catalog and implementation paths", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-custom-property-handoffs",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const catalogId = "custom-property-catalog";
  const catalogOutput = boundOutput("handoffs/catalog-v2.json", "ultrafuzz/properties@2", true);
  const catalogMarkdownOutput = boundOutput("handoffs/catalog-v2-companion.md", "ultrafuzz/nonempty-markdown@1", false);
  const catalogContents = JSON.stringify({
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-1",
        description: "Balances remain conserved",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "independent-review", source_property_id: "review-1" }]
      }
    ]
  });
  writeDeclaredArtifactNode(layout, catalogId, [catalogOutput, catalogMarkdownOutput], {
    [catalogOutput.path]: catalogContents,
    [catalogMarkdownOutput.path]: fixtureCanonicalPropertiesMarkdown(catalogContents)
  });
  const implementationId = "custom-property-implementation";
  const implementationOutput = boundOutput(
    "handoffs/implementation-v3.json",
    "ultrafuzz/implemented-properties@3",
    true
  );
  writeDeclaredArtifactNode(layout, implementationId, [implementationOutput], {
    [implementationOutput.path]: JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  });
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: implementationId,
    logical_id: implementationId,
    display_name: implementationId,
    artifact_dir: `artifacts/${implementationId}`,
    depends_on: [catalogId],
    outputs: [implementationOutput]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("property consumers reject a finalized catalog whose typed Markdown companion is ambiguous", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-ambiguous-finalized-catalog-pair",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const catalogId = "renamed-catalog-producer";
  const catalog = '{"schema_version":"ultrafuzz.properties.v2","properties":[]}';
  const catalogOutputs = [
    boundOutput("custom/catalog.json", "ultrafuzz/properties@2", true),
    boundOutput("custom/catalog-a.md", "ultrafuzz/nonempty-markdown@1", false),
    boundOutput("custom/catalog-b.md", "ultrafuzz/nonempty-markdown@1", false)
  ];
  writeDeclaredArtifactNode(layout, catalogId, catalogOutputs, {
    "custom/catalog.json": catalog,
    "custom/catalog-a.md": "# Catalog A\n",
    "custom/catalog-b.md": "# Catalog B\n"
  });
  const implementationId = "renamed-property-consumer";
  const implementationOutput = boundOutput(
    "custom/implemented-properties.json",
    "ultrafuzz/implemented-properties@3",
    true
  );
  writeDeclaredArtifactNode(layout, implementationId, [implementationOutput], {
    [implementationOutput.path]: JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    })
  });
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: implementationId,
    logical_id: "noncanonical-property-consumer",
    display_name: "Renamed property consumer",
    artifact_dir: `artifacts/${implementationId}`,
    depends_on: [catalogId],
    outputs: [implementationOutput]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "REQUIRED_ARTIFACT_INVALID" &&
        diagnostic.message.includes("PROPERTY_MARKDOWN_DECLARATION_AMBIGUOUS")
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("property implementation accepts an intentional producer-free empty catalog through the full host gate", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-producer-free-implementation",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const output = boundOutput("handoffs/implementation-v3.json", "ultrafuzz/implemented-properties@3", true);
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "producer-free-implementation",
    logical_id: "producer-free-implementation",
    display_name: "Producer-free implementation",
    artifact_dir: "artifacts/producer-free-implementation",
    depends_on: [],
    outputs: [output]
  };
  writeDeclaredArtifactNode(layout, node.id, [output], {
    [output.path]: JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    })
  });
  writePlannedGraph(layout, [node]);

  const result = verifyRuntimeRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("property implementation gate enforces declared selection coverage and actionable blockers", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-implementation-selection",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-high",
          description: "ScFuzzBench supply liveness must not unexpectedly revert",
          category: "dos-liveness",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }]
        },
        {
          id: "property-medium",
          description: "A medium-priority non-benchmark relation",
          category: "liveness",
          priority: "medium",
          sources: [{ source_node_id: "property-specification-aviggiano", source_property_id: "aviggiano-medium" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );
  const node = {
    ...plannedNode(["implemented-properties.json"]),
    id: nodeId,
    logical_id: nodeId,
    outputs: plannedNode(["implemented-properties.json"]).outputs.map((output) => ({
      ...output,
      contract: "ultrafuzz/implemented-properties@3" as const
    }))
  };

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );
  const missingSelection = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingSelection.ok, false);
  assert.ok(missingSelection.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "deferred",
          implementation_paths: [],
          test_paths: []
        }
      ]
    })
  );

  const missingBlocker = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingBlocker.ok, false);
  assert.ok(missingBlocker.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        }
      ]
    })
  );
  const withBlocker = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(withBlocker.ok, true, JSON.stringify(withBlocker.diagnostics));

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "medium",
        priorities: ["high", "medium"],
        property_ids: ["property-high", "property-medium"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        },
        {
          property_id: "property-medium",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "missing-oracle",
            summary: "No stable target getter exposes the required value.",
            next_action: "Add a read-only harness oracle or document the source-backed blocker."
          }
        }
      ]
    })
  );
  const configMismatch = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(configMismatch.ok, false);
  assert.ok(
    configMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH"
    )
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: []
      },
      properties: []
    })
  );
  const missingSelectionId = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(missingSelectionId.ok, false);
  assert.ok(
    missingSelectionId.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH"
    )
  );
  assert.ok(
    missingSelectionId.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_COVERAGE_INCOMPLETE"
    )
  );
});

test("property implementation gate includes lower-priority benchmark expectations in selection", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-benchmark-expectation-selection",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-high",
          description: "Borrowed assets remain bounded",
          category: "hub-accounting",
          priority: "high",
          sources: [
            {
              source_node_id: "property-specification-recon",
              source_property_id: "invariant_totalBorrowedLessThanSupplied_v0"
            }
          ]
        },
        {
          id: "property-supply",
          description: "Supply does not unexpectedly revert for valid state",
          category: "dos-liveness",
          priority: "medium",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-high"] },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const baseNode = plannedNode(["implemented-properties.json"]);
  const node = {
    ...baseNode,
    id: nodeId,
    logical_id: nodeId,
    outputs: baseNode.outputs.map((output) => ({ ...output, contract: "ultrafuzz/implemented-properties@3" as const }))
  };
  const result = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH"),
    JSON.stringify(result.diagnostics)
  );
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH")
      ?.message ?? "",
    /property-supply/u
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high", "property-supply"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        },
        {
          property_id: "property-supply",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const missingReferenceMetadata = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.ok(
    missingReferenceMetadata.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_REFERENCE_EXPECTATIONS_MISMATCH"
    )
  );

  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: {
        priority_threshold: "high",
        priorities: ["high"],
        property_ids: ["property-high", "property-supply"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        },
        {
          property_id: "property-supply",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: [],
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    })
  );
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, nodeId).ok, true);
});

test("property implementation gate rejects an unknown finding property reference", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-implementation-finding" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  const nodeId = "stateful-invariant-implement-properties";
  writeArtifact(
    layout,
    nodeId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  writeArtifact(
    layout,
    nodeId,
    "findings.json",
    JSON.stringify([currentFinding("finding-property", { property_ids: ["property-unknown"] })])
  );
  const node = {
    ...plannedNode(["implemented-properties.json", "findings.json"]),
    id: nodeId,
    logical_id: nodeId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, nodeId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.path ?? "",
    /findings\.json/u
  );
});

test("campaign gate accepts non-property findings and validates property-derived failures", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"]),
      currentFinding("finding-setup", {
        title: "Harness setup issue",
        status: "needs-review",
        severity_guess: "Low",
        summary: "The harness setup is incomplete."
      })
    ])
  );
  writeCampaignSummary(layout, campaignId, 1, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true);

  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", [], ["failure-1"])])
  );
  const dropped = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(dropped.ok, false);
  assert.ok(dropped.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISMATCH"));

  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-2", property_ids: ["property-unknown"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-2", ["property-unknown"], ["failure-2"]),
      currentFinding("unknown-property-context", {
        title: "Unknown property failure",
        summary: "The unknown property failed."
      })
    ])
  );
  const unknown = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));

  writeArtifact(
    layout,
    campaignId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const combinedNode = {
    ...node,
    outputs: [...node.outputs, boundOutput("implemented-properties.json", "ultrafuzz/implemented-properties@3")]
  };
  const combined = verifyRequiredArtifactsForAttempt(layout, combinedNode, campaignId);
  assert.equal(combined.ok, false);
  assert.ok(
    combined.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_ROLE_DECLARATION_CONFLICT"),
    JSON.stringify(combined.diagnostics)
  );
});

test("current campaign gate rejects multiple backend records sharing one recon plan", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-partial-dual" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-campaign";
  // The current plan and result contract describe one authenticated backend.
  // A custom topology must not smuggle a second backend through the old v2
  // multi-record shape.
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "medusa-results.json",
    JSON.stringify(currentCampaign(["property-1"], [], { fuzzerBackend: "medusa" }))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"], 1, ["recon"])])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "medusa-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "property-campaign-context-joins"
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("campaign gate still applies to project-owned split recon campaign nodes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-split-campaign" });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: []
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-recon-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-unknown"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([currentFinding("failure-1", { property_ids: ["property-unknown"] })])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
});

test("campaign gates select custom declared paths and ignore undeclared conventional files", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-custom-campaign-contracts",
    resolvedConfigToml: '[invariants]\ninvariant_testing_fuzzer_timeout = "1h"\n'
  });
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "independent-review", source_property_id: "review-1" }]
        }
      ]
    })
  );
  const implementationId = "custom-implementation-stage";
  writeArtifact(
    layout,
    implementationId,
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  );
  const campaignId = "custom-fuzz-stage";
  const campaignOutput = boundOutput("custom/results.json", "ultrafuzz/property-campaign@3", true);
  const findingsOutput = boundOutput("custom/candidates.json", "ultrafuzz/findings@2");
  const campaignPlanOutput = boundOutput("custom/plan.json", "ultrafuzz/invariant-campaign-plan@2");
  const campaignSummaryOutput = boundOutput("custom/summary.json", "ultrafuzz/campaign-summary@2");
  const customCampaign = {
    ...currentCampaign(["property-1"], [], { executionStatus: "complete" }),
    campaign_plan_ref: campaignPlanOutput.path,
    findings_ref: findingsOutput.path,
    campaign_summary_ref: campaignSummaryOutput.path
  };
  writeDeclaredArtifactNode(
    layout,
    campaignId,
    [campaignOutput, findingsOutput, campaignPlanOutput, campaignSummaryOutput],
    {
      [campaignOutput.path]: JSON.stringify(customCampaign),
      [findingsOutput.path]: "[]",
      [campaignPlanOutput.path]: JSON.stringify(currentCampaignPlan()),
      [campaignSummaryOutput.path]: JSON.stringify({
        schema_version: "ultrafuzz.campaign-summary.v2",
        outcome: "complete",
        sequence_length: 100,
        implemented_property_suite_refs: ["implemented-properties.json"],
        campaign_plan_ref: campaignPlanOutput.path,
        backend_results: [{ fuzzer_backend: "recon", status: "complete", result_ref: campaignOutput.path }],
        finding_refs: [],
        reproducer_refs: [],
        failure_counts: { pre_deduplication: 0, post_deduplication: 0 }
      })
    }
  );
  const conventionalPath = writeArtifactFile(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    "{ this undeclared conventional file is intentionally invalid JSON"
  );
  const before = fs.readFileSync(conventionalPath);
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: campaignId,
    logical_id: campaignId,
    display_name: campaignId,
    artifact_dir: `artifacts/${campaignId}`,
    depends_on: [implementationId],
    timeout_seconds: 7200,
    outputs: [campaignOutput, findingsOutput, campaignPlanOutput, campaignSummaryOutput]
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(fs.readFileSync(conventionalPath), before);
});

test("producer-free final reports require the exact not-planned implementation coverage", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-producer-free-report" });
  const outputs = [
    boundOutput("deliverables/report.md", "ultrafuzz/nonempty-markdown@1", true),
    boundOutput("deliverables/report.json", "ultrafuzz/report@3")
  ];
  const node: PlannedGraphNode = {
    ...plannedNode([]),
    id: "producer-free-report",
    logical_id: "producer-free-report",
    display_name: "Producer-free report",
    artifact_dir: "artifacts/producer-free-report",
    depends_on: [],
    outputs
  };
  writeDeclaredArtifactNode(layout, node.id, outputs, {
    "deliverables/report.md": "# Ultrafuzz report\n",
    "deliverables/report.json": JSON.stringify(currentReport(layout.runId))
  });
  writePlannedGraph(layout, [node]);

  const valid = verifyRuntimeRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  writeDeclaredArtifactNode(layout, node.id, outputs, {
    "deliverables/report.md": "# Ultrafuzz report\n\nrecon-selected-declaration-completeness: `1/1`\n",
    "deliverables/report.json": JSON.stringify(currentReport(layout.runId))
  });
  const inventedCoverage = verifyRuntimeRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(inventedCoverage.ok, false, JSON.stringify(inventedCoverage.diagnostics));
  assert.ok(
    inventedCoverage.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_UNPLANNED"),
    JSON.stringify(inventedCoverage.diagnostics)
  );

  writeDeclaredArtifactNode(layout, node.id, outputs, {
    "deliverables/report.md": "# Ultrafuzz report\n",
    "deliverables/report.json": JSON.stringify(
      currentReport(layout.runId, {
        property_implementation_coverage: currentImplementedCoverage([])
      })
    )
  });
  const mismatched = verifyRuntimeRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatched.ok, false, JSON.stringify(mismatched.diagnostics));
  assert.ok(
    mismatched.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH"),
    JSON.stringify(mismatched.diagnostics)
  );
});

test("final report gate joins the default recon-only campaign backend", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-recon-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = { ...plannedNode(["report.md", "report.json"]), id: "final-report", logical_id: "final-report" };
  writeArtifact(layout, node.id, "report.md", reportCoverageMarkdown(currentImplementedCoverage(["property-1"])));
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  );
  // The default topology emits exactly this record from this node; the report
  // join must resolve `recon` from it rather than reporting a backend mismatch.
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "finding-property", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([accountedCampaignFinding("finding-property", ["property-1"], ["finding-property"])])
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backend: "recon"
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  // Final report IDs are presentation identities. A renamed outcome may bind
  // its campaign identity only through the canonical lifecycle source entry
  // and the explicit source_finding_id on property provenance.
  const renamedReport = (sourceFindingId?: string) =>
    currentReport(layout.runId, {
      non_production_outcomes: [currentNonProductionOutcome("NP-01", "finding-property")],
      property_provenance: [
        {
          finding_id: "NP-01",
          ...(sourceFindingId === undefined ? {} : { source_finding_id: sourceFindingId }),
          title: "Property failure",
          property_ids: ["property-1"],
          sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"],
          fuzzer_backend: "recon"
        }
      ],
      property_implementation_coverage: currentImplementedCoverage(["property-1"])
    });

  writeArtifact(layout, node.id, "report.json", JSON.stringify(renamedReport()));
  const missingSourceId = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSourceId.ok, false, JSON.stringify(missingSourceId.diagnostics));
  assert.ok(
    missingSourceId.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_SOURCE_FINDING_ID_REQUIRED"),
    JSON.stringify(missingSourceId.diagnostics)
  );

  writeArtifact(layout, node.id, "report.json", JSON.stringify(renamedReport("unrelated-finding")));
  const mismatchedSourceId = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatchedSourceId.ok, false, JSON.stringify(mismatchedSourceId.diagnostics));
  assert.ok(
    mismatchedSourceId.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_SOURCE_FINDING_ID_MISMATCH"
    ),
    JSON.stringify(mismatchedSourceId.diagnostics)
  );

  writeArtifact(layout, node.id, "report.json", JSON.stringify(renamedReport("finding-property")));
  const renamed = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(renamed.ok, true, JSON.stringify(renamed.diagnostics));

  const declaredPairGraph = fs.readFileSync(layout.graphPath);
  const graphWithoutDeclaredFindings = JSON.parse(declaredPairGraph.toString("utf8")) as {
    nodes: PlannedGraphNode[];
  };
  if (!graphWithoutDeclaredFindings.nodes.some((candidate) => candidate.id === "stateful-invariant-campaign")) {
    throw new Error("campaign fixture is missing from the planned graph");
  }
  graphWithoutDeclaredFindings.nodes = graphWithoutDeclaredFindings.nodes.map((candidate) =>
    candidate.id === "stateful-invariant-campaign"
      ? {
          ...candidate,
          outputs: candidate.outputs.filter((output) => output.contract !== "ultrafuzz/findings@2")
        }
      : candidate
  );
  fs.writeFileSync(layout.graphPath, JSON.stringify(graphWithoutDeclaredFindings), "utf8");
  const undeclaredFindingsPair = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(undeclaredFindingsPair.ok, false, JSON.stringify(undeclaredFindingsPair.diagnostics));
  assert.ok(
    undeclaredFindingsPair.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_AUTHORITY_INVALID"),
    JSON.stringify(undeclaredFindingsPair.diagnostics)
  );
  fs.writeFileSync(layout.graphPath, declaredPairGraph);

  // A report claiming a backend the campaign never recorded is still rejected.
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backends: ["recon", "medusa"]
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH"));
});

test("final report gate rejects backend provenance borrowed from an unrelated canonical finding", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-renumbered-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = { ...plannedNode(["report.md", "report.json"]), id: "final-report", logical_id: "final-report" };
  writeArtifact(layout, node.id, "report.md", reportCoverageMarkdown(currentImplementedCoverage(["property-1"])));
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["tests/recon/Properties.sol"],
          test_paths: ["tests/recon/CryticToFoundry.sol"]
        }
      ]
    })
  );
  for (const [artifactName, backend, failureId] of [
    ["recon-fuzzer-results.json", "recon", "failure-1"],
    ["medusa-results.json", "medusa", "failure-2"]
  ] as const) {
    writeArtifact(
      layout,
      "stateful-invariant-campaign",
      artifactName,
      JSON.stringify(
        currentCampaign(["property-1"], [{ id: failureId, property_ids: ["property-1"] }], {
          fuzzerBackend: backend
        })
      )
    );
  }
  writeArtifact(
    layout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"], 1, ["recon"]),
      accountedCampaignFinding("failure-2", ["property-1"], ["failure-2"], 1, ["medusa"])
    ])
  );

  const report = (fuzzerBackends: string[]) =>
    JSON.stringify(
      currentReport(layout.runId, {
        non_production_outcomes: [currentNonProductionOutcome("failure-1", "failure-1")],
        property_provenance: [
          {
            finding_id: "failure-1",
            title: "Canonical non-production outcome",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
            implementation_paths: ["tests/recon/Properties.sol"],
            test_paths: ["tests/recon/CryticToFoundry.sol"],
            fuzzer_backends: fuzzerBackends
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    );

  writeArtifact(layout, node.id, "report.json", report(["recon"]));
  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, node.id).ok, true);

  // A backend recorded for another canonical finding cannot be borrowed merely
  // because it appears elsewhere in the same campaign.
  writeArtifact(layout, node.id, "report.json", report(["medusa"]));
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH"));
});

test("final report gate rejects legacy report shapes without rewriting them and validates current provenance", () => {
  const legacyLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-legacy-report" });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(legacyLayout, node.id, "report.md", "# Report\n");
  const legacyPath = writeArtifact(
    legacyLayout,
    node.id,
    "report.json",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
      property_provenance: "unavailable"
    })
  );
  const legacyBytes = fs.readFileSync(legacyPath);
  const legacy = verifyRequiredArtifactsForAttempt(legacyLayout, node, node.id);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);

  const smokeLayout = createRunLayout({ projectRoot: tempProject(), runId: "run-smoke-report" });
  writeArtifact(smokeLayout, node.id, "report.md", "# Report\n");
  writeArtifact(smokeLayout, node.id, "report.json", JSON.stringify(currentReport(smokeLayout.runId)));
  assert.equal(verifyRequiredArtifactsForAttempt(smokeLayout, node, node.id).ok, true);

  const currentLayout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-current-report",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  writeArtifact(
    currentLayout,
    node.id,
    "report.md",
    reportCoverageMarkdown(currentImplementedCoverage(["property-1"]))
  );
  writeArtifact(
    currentLayout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "Balances remain conserved",
          category: "accounting",
          priority: "high",
          sources: [
            { source_node_id: "property-specification-certora", source_property_id: "certora-1" },
            { source_node_id: "property-specification-crytic", source_property_id: "crytic-2" }
          ]
        }
      ]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "implemented",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/Property1.t.sol"]
        }
      ]
    })
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "finding-property", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    currentLayout,
    "stateful-invariant-campaign",
    "findings.json",
    JSON.stringify([accountedCampaignFinding("finding-property", ["property-1"], ["finding-property"])])
  );
  writeCampaignSummary(currentLayout, "stateful-invariant-campaign", 1, 1);
  const campaignNode = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: "stateful-invariant-campaign",
    logical_id: "stateful-invariant-campaign"
  };
  assert.equal(
    verifyRequiredArtifactsForAttempt(currentLayout, campaignNode, campaignNode.id).ok,
    true,
    "finding-owned provenance must join the current authenticated campaign"
  );
  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        campaign_outcome: { outcome: "partial" },
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-unknown"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: [],
            test_paths: []
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const dangling = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN"));
  assert.match(
    dangling.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_REFERENCE_UNKNOWN")?.path ?? "",
    /report\.json/u
  );

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        campaign_outcome: { outcome: "partial" },
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backend: "recon"
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const incompleteJoin = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(incompleteJoin.ok, false);
  assert.ok(incompleteJoin.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_SOURCES_MISMATCH"));

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        campaign_outcome: { outcome: "partial" },
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [
              { source_node_id: "property-specification-certora", source_property_id: "certora-1" },
              { source_node_id: "property-specification-crytic", source_property_id: "crytic-2" }
            ],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backend: "recon"
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const completeJoin = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(completeJoin.ok, true, JSON.stringify(completeJoin.diagnostics));

  writeArtifact(
    currentLayout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(currentLayout.runId, {
        campaign_outcome: { outcome: "blocked" },
        non_production_outcomes: [currentNonProductionOutcome("finding-property", "finding-property")],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [
              { source_node_id: "property-specification-certora", source_property_id: "certora-1" },
              { source_node_id: "property-specification-crytic", source_property_id: "crytic-2" }
            ],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backend: "recon"
          }
        ],
        property_implementation_coverage: currentImplementedCoverage(["property-1"])
      })
    )
  );
  const forgedOutcome = verifyRequiredArtifactsForAttempt(currentLayout, node, node.id);
  assert.equal(forgedOutcome.ok, false);
  assert.ok(
    forgedOutcome.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "report-campaign-outcome-authority"
    ),
    JSON.stringify(forgedOutcome.diagnostics)
  );
});

test("current final reports preserve implementation coverage in JSON and Markdown", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-current-coverage",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  const catalog = {
    schema_version: "ultrafuzz.properties.v2" as const,
    properties: [
      {
        id: "property-high",
        description: "The accounting relation holds.",
        category: "accounting",
        priority: "high" as const,
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "hub-total" }]
      }
    ]
  };
  const implementation = {
    schema_version: "ultrafuzz.implemented-properties.v3" as const,
    selection: {
      priority_threshold: "high" as const,
      priorities: ["high" as const],
      property_ids: ["property-high"]
    },
    properties: [
      {
        property_id: "property-high",
        status: "implemented" as const,
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: ["test/foundry/PropertyHigh.t.sol"]
      }
    ]
  };
  const expectedCoverage = derivePropertyImplementationCoverage(catalog, implementation, {
    configuredSelection: { priority_threshold: "high", priorities: ["high"] },
    requireConfiguredSelection: true
  });
  assert.equal(expectedCoverage.ok, true, JSON.stringify(expectedCoverage.issues));
  assert.ok(expectedCoverage.value);
  writeArtifact(layout, "property-specification-fanin", "properties.json", JSON.stringify(catalog));
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify(implementation)
  );
  const reportPath = "report.json";
  const baseReport = currentReport(layout.runId);
  writeArtifact(layout, node.id, reportPath, JSON.stringify(baseReport));
  writeArtifact(layout, node.id, "report.md", "# Ultrafuzz report\n\nNo coverage section yet.\n");

  const wrongCurrentVariant = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(wrongCurrentVariant.ok, false);
  assert.ok(
    wrongCurrentVariant.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH"
    )
  );
  assert.ok(
    wrongCurrentVariant.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISSING"
    )
  );

  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: expectedCoverage.value
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `1`\n- Blocked properties: `0`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n"
  );
  const validCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(validCoverage.ok, true, JSON.stringify(validCoverage.diagnostics));

  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-high"] },
      properties: [
        {
          property_id: "property-high",
          status: "blocked",
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/foundry/PropertyHigh.t.sol"],
          blocker: { code: "MISSING_ORACLE", summary: "Oracle unavailable_*", next_action: "Add oracle" }
        }
      ]
    })
  );
  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: ["property-high"],
        implemented_property_ids: [],
        blocked_property_ids: ["property-high"],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: ["property-high: Oracle unavailable_*"]
      }
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `1`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n\nBlocker summaries:\n- property-high: Oracle unavailable\\_\\*\n"
  );
  const validBlockedCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(validBlockedCoverage.ok, true, JSON.stringify(validBlockedCoverage.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `1`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n\nBlocker summaries:\n- property-high: Wrong summary\n"
  );
  const blockerMarkdownMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(
    blockerMarkdownMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(blockerMarkdownMismatch.diagnostics)
  );

  writeArtifact(
    layout,
    node.id,
    "report.md",
    "# Ultrafuzz report\n\n## Property implementation coverage\n\n- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n- Implemented properties: `0`\n- Blocked properties: `0`\n- Pending properties: `0`\n- Deferred properties: `0`\n- Reference expectation properties: `0`\n"
  );
  const markdownMismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.ok(
    markdownMismatch.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(markdownMismatch.diagnostics)
  );

  writeArtifact(
    layout,
    node.id,
    reportPath,
    JSON.stringify({
      ...baseReport,
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: [],
        implemented_property_ids: [],
        blocked_property_ids: [],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: []
      }
    })
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(mismatch.ok, false);
  assert.ok(
    mismatch.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH")
  );
});

test("dependency gates reject reused descendants after an ancestor manifest changes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-reuse" });
  writeArtifact(layout, "ancestor", "result.md", "first\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:00.000Z" });
  writeArtifact(layout, "reused", "result.md", "derived\n");
  writeArtifactManifest({
    layout,
    nodeId: "reused",
    prerequisiteNodeIds: ["ancestor"],
    createdAt: "2026-07-18T00:00:01.000Z"
  });
  const state = createInitialRunState({
    runId: "run-reuse",
    graphFingerprint: "graph",
    configFingerprint: "c".repeat(64),
    nodes: [
      { id: "ancestor", status: "succeeded" },
      { id: "reused", status: "reused-from-prior-run" },
      { id: "consumer", status: "pending" }
    ]
  });
  const consumer = { ...plannedNode(["result.md"]), id: "consumer", depends_on: ["reused"] };

  assert.equal(dependencyGateForNode(consumer, state, layout).ok, true);
  writeArtifact(layout, "ancestor", "result.md", "changed\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:02.000Z" });
  assert.deepEqual(dependencyGateForNode(consumer, state, layout), {
    ok: false,
    reason_code: "CAUSAL_MANIFEST_MISMATCH",
    reason: "node consumer cannot reuse descendants after a prerequisite manifest changed",
    blocked_by: ["reused"]
  });
});

// Regression: https://github.com/.../issues/386 — the campaign gate demanded a
// finding sharing each raw counterexample's ID, so a campaign that correctly
// deduplicated many counterexamples of one property into one finding failed.
function campaignPropertyCatalog(layout: ReturnType<typeof createRunLayout>, propertyIds: string[]): void {
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: propertyIds.map((propertyId) => ({
        id: propertyId,
        description: `Invariant ${propertyId}`,
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-certora", source_property_id: `certora-${propertyId}` }]
      }))
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: propertyIds },
      properties: propertyIds.map((propertyId) => ({
        property_id: propertyId,
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: []
      }))
    })
  );
}

function campaignFinding(id: string, propertyIds: string[]): Record<string, unknown> {
  const finding = currentFinding(id, {
    title: propertyIds.length > 0 ? `Violation of ${propertyIds.join(", ")}` : "Harness observation"
  });
  // A finding with no property provenance omits the key entirely; an empty
  // array is not how the campaign nodes express "no properties".
  if (propertyIds.length > 0) {
    finding.property_ids = propertyIds;
  }
  return finding;
}

type CampaignFailureReferenceFixture = string | { fuzzer_backend: string; failure_id: string; raw_result_ref?: string };

function campaignResultRefForBackend(backend: string): string {
  return backend === "recon" ? "recon-fuzzer-results.json" : `${backend}-results.json`;
}

function accountedCampaignFinding(
  id: string,
  propertyIds: string[],
  contributions: CampaignFailureReferenceFixture[],
  preDedupCount = contributions.length,
  fuzzerBackends: string[] = ["recon"]
): Record<string, unknown> {
  const defaultBackend = fuzzerBackends[0] ?? "recon";
  return {
    ...campaignFinding(id, propertyIds),
    contributing_backend_failures: contributions.map((contribution) => {
      const fuzzerBackend = typeof contribution === "string" ? defaultBackend : contribution.fuzzer_backend;
      const failureId = typeof contribution === "string" ? contribution : contribution.failure_id;
      return {
        fuzzer_backend: fuzzerBackend,
        failure_id: failureId,
        raw_result_ref:
          typeof contribution === "string"
            ? campaignResultRefForBackend(fuzzerBackend)
            : (contribution.raw_result_ref ?? campaignResultRefForBackend(fuzzerBackend))
      };
    }),
    deduplication: { pre_dedup_count: preDedupCount },
    ...(fuzzerBackends.length === 1 ? { fuzzer_backend: fuzzerBackends[0] } : { fuzzer_backends: fuzzerBackends })
  };
}

function currentCampaignNode(paths: string[]): PlannedGraphNode {
  return {
    ...plannedNode([...new Set([...paths, "campaign-plan.json", "campaign-summary.json"])]),
    timeout_seconds: 7200
  };
}

const campaignFixturePaths = {
  corpus: "backends/recon-fuzzer/corpus",
  cache: "backends/recon-fuzzer/cache",
  log: "backends/recon-fuzzer/run.log",
  raw_results: "backends/recon-fuzzer/results.json",
  reproducers: "backends/recon-fuzzer/reproducers"
} as const;

const RECON_TIMEOUT_TEST_LIMIT = "18446744073709551615";
const CURRENT_CAMPAIGN_TIMEOUT_SECONDS = 3600;
const CURRENT_CAMPAIGN_FORCE_KILL_GRACE_SECONDS = 300;
const CURRENT_CAMPAIGN_FINALIZATION_RESERVE_SECONDS = 300;
const CURRENT_CAMPAIGN_STARTED_AT = "2026-01-01T00:00:00.000Z";
const CURRENT_CAMPAIGN_FUZZING_DEADLINE = "2026-01-01T01:00:00.000Z";
const CURRENT_CAMPAIGN_FORCE_KILL_DEADLINE = "2026-01-01T01:05:00.000Z";
const CURRENT_CAMPAIGN_FINAL_ARTIFACT_DEADLINE = "2026-01-01T01:10:00.000Z";
const CURRENT_CAMPAIGN_COMMAND =
  `timeout --preserve-status --signal=INT --kill-after=${CURRENT_CAMPAIGN_FORCE_KILL_GRACE_SECONDS}s ` +
  `${CURRENT_CAMPAIGN_TIMEOUT_SECONDS}s recon fuzz . --workers 1 ` +
  `--timeout ${CURRENT_CAMPAIGN_TIMEOUT_SECONDS} --test-limit ${RECON_TIMEOUT_TEST_LIMIT} --seq-len 100`;

function currentCampaignPlan(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.invariant-campaign-plan.v2",
    available_vcpus: 1,
    workers: 1,
    configured_budget_seconds:
      CURRENT_CAMPAIGN_TIMEOUT_SECONDS +
      CURRENT_CAMPAIGN_FORCE_KILL_GRACE_SECONDS +
      CURRENT_CAMPAIGN_FINALIZATION_RESERVE_SECONDS,
    deadline: CURRENT_CAMPAIGN_FINAL_ARTIFACT_DEADLINE,
    finalization_reserve_seconds: CURRENT_CAMPAIGN_FINALIZATION_RESERVE_SECONDS,
    configured_fuzzer_timeout_seconds: CURRENT_CAMPAIGN_TIMEOUT_SECONDS,
    recon_internal_timeout_seconds: CURRENT_CAMPAIGN_TIMEOUT_SECONDS,
    recon_test_limit: RECON_TIMEOUT_TEST_LIMIT,
    recon_sequence_length: 100,
    host_soft_timeout_seconds: CURRENT_CAMPAIGN_TIMEOUT_SECONDS,
    host_force_kill_grace_seconds: CURRENT_CAMPAIGN_FORCE_KILL_GRACE_SECONDS,
    artifact_finalization_reserve_seconds: CURRENT_CAMPAIGN_FINALIZATION_RESERVE_SECONDS,
    backend_started_at: CURRENT_CAMPAIGN_STARTED_AT,
    fuzzing_deadline_utc: CURRENT_CAMPAIGN_FUZZING_DEADLINE,
    force_kill_deadline_utc: CURRENT_CAMPAIGN_FORCE_KILL_DEADLINE,
    final_artifact_deadline_utc: CURRENT_CAMPAIGN_FINAL_ARTIFACT_DEADLINE,
    backend: { name: "recon", version: null, exact_shell_escaped_command: CURRENT_CAMPAIGN_COMMAND },
    command_plan: [{ phase: "campaign", command: CURRENT_CAMPAIGN_COMMAND }],
    paths: campaignFixturePaths
  };
}

type CampaignFailureFixture = {
  id: string;
  status?: string;
  property_ids?: string[];
  entrypoint?: string | null;
  sequence?: string[];
  precondition_evidence?: string[];
  raw_reproducer_ref?: string;
  deterministic_reproducer_ref?: string | null;
  reproduction_blocker?: string | null;
};

function currentCampaignFailure(failure: CampaignFailureFixture): Record<string, unknown> {
  const status = failure.status ?? "reproduced";
  return {
    id: failure.id,
    status,
    property_ids: failure.property_ids ?? [],
    entrypoint: failure.entrypoint ?? `handler_${failure.id}()`,
    sequence: failure.sequence ?? [`call ${failure.id}`],
    precondition_evidence: failure.precondition_evidence ?? ["fixture precondition held"],
    raw_reproducer_ref: failure.raw_reproducer_ref ?? campaignFixturePaths.raw_results,
    deterministic_reproducer_ref:
      failure.deterministic_reproducer_ref ??
      (status === "reproduced" ? `${campaignFixturePaths.reproducers}/${failure.id}.t.sol` : null),
    reproduction_blocker:
      failure.reproduction_blocker ?? (status === "blocked-unreproduced" ? "fixture reproduction was blocked" : null)
  };
}

function currentCampaign(
  implementedPropertyIds: readonly string[],
  failureFixtures: readonly CampaignFailureFixture[],
  options: {
    fuzzerBackend?: string;
    executionStatus?: "complete" | "partial";
  } = {}
): Record<string, unknown> {
  const failures = failureFixtures.map(currentCampaignFailure);
  const executionStatus = options.executionStatus ?? "partial";
  const complete = executionStatus === "complete";
  const finishedAt = complete ? "2026-01-01T01:00:01.000Z" : "2026-01-01T00:05:00.000Z";
  const evidencePaths = new Set<string>([campaignFixturePaths.log, campaignFixturePaths.raw_results]);
  for (const failure of failures) {
    if (typeof failure.raw_reproducer_ref === "string") evidencePaths.add(failure.raw_reproducer_ref);
    if (typeof failure.deterministic_reproducer_ref === "string")
      evidencePaths.add(failure.deterministic_reproducer_ref);
  }
  return {
    schema_version: "ultrafuzz.property-campaign.v3",
    campaign_plan_ref: "campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: options.fuzzerBackend ?? "recon",
    backend_version: null,
    configured_timeout_seconds: CURRENT_CAMPAIGN_TIMEOUT_SECONDS,
    sequence_length: 100,
    exact_command: CURRENT_CAMPAIGN_COMMAND,
    start_timestamp: CURRENT_CAMPAIGN_STARTED_AT,
    end_timestamp: finishedAt,
    termination_reason: complete ? "configured-timeout" : "process-exit",
    campaign_outcome: complete ? "complete" : "partial",
    usable_results: true,
    execution: {
      status: executionStatus,
      usable_results: true,
      command: CURRENT_CAMPAIGN_COMMAND,
      config_path: null,
      workers: 1,
      started_at: CURRENT_CAMPAIGN_STARTED_AT,
      finished_at: finishedAt,
      deadline: CURRENT_CAMPAIGN_FINAL_ARTIFACT_DEADLINE,
      exit_code: complete ? 0 : 1,
      failure: complete
        ? null
        : { category: "process-failed", summary: "The fixture campaign stopped after producing usable results." }
    },
    paths: campaignFixturePaths,
    evidence_files: [...evidencePaths].map((evidencePath) => ({
      path: evidencePath,
      size_bytes: 1,
      sha256: CAMPAIGN_EVIDENCE_SHA256
    })),
    coverage: {
      status: "reported",
      metrics: [{ name: "executions", value: 1, unit: "count", source_ref: campaignFixturePaths.raw_results }],
      unavailable_reason: null
    },
    property_results: implementedPropertyIds.map((propertyId) => {
      const failureIds = failures.flatMap((failure) =>
        Array.isArray(failure.property_ids) &&
        failure.property_ids.includes(propertyId) &&
        typeof failure.id === "string"
          ? [failure.id]
          : []
      );
      return failureIds.length > 0
        ? {
            property_id: propertyId,
            status: "failed",
            failure_ids: failureIds,
            coverage_metric_names: ["executions"],
            evidence_refs: [campaignFixturePaths.raw_results],
            reason: null
          }
        : executionStatus === "complete"
          ? {
              property_id: propertyId,
              status: "passed",
              failure_ids: [],
              coverage_metric_names: ["executions"],
              evidence_refs: [campaignFixturePaths.raw_results],
              reason: null
            }
          : {
              property_id: propertyId,
              status: "inconclusive",
              failure_ids: [],
              coverage_metric_names: ["executions"],
              evidence_refs: [campaignFixturePaths.raw_results],
              reason: "The partial fixture campaign did not establish a pass."
            };
    }),
    failures
  };
}

test("controller campaign gate authenticates every declared evidence file", () => {
  for (const mode of ["missing", "digest-mismatch", "hard-link", "symlink"] as const) {
    const layout = createRunLayout({ projectRoot: tempProject(), runId: `run-campaign-evidence-${mode}` });
    campaignPropertyCatalog(layout, ["property-1"]);
    const campaignId = "stateful-invariant-campaign";
    writeArtifact(
      layout,
      campaignId,
      "recon-fuzzer-results.json",
      JSON.stringify(currentCampaign(["property-1"], [], { executionStatus: "complete" }))
    );
    writeArtifact(layout, campaignId, "findings.json", "[]");
    writeCampaignSummary(layout, campaignId, 0, 0);
    const node = {
      ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
      id: campaignId,
      logical_id: campaignId
    };
    assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true, mode);

    const evidencePath = path.join(getNodeArtifactDir(layout, campaignId), campaignFixturePaths.raw_results);
    if (mode === "missing") {
      fs.rmSync(evidencePath);
    } else if (mode === "digest-mismatch") {
      fs.writeFileSync(evidencePath, "y", "utf8");
    } else if (mode === "hard-link") {
      fs.linkSync(evidencePath, `${evidencePath}.alias`);
    } else {
      fs.rmSync(evidencePath);
      fs.symlinkSync(`${evidencePath}.target`, evidencePath);
    }

    const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
    assert.equal(result.ok, false, mode);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          diagnostic.details?.gate === "property-campaign-evidence-integrity"
      ),
      `${mode}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test("controller campaign gate requires exact verification-marker publication authority", () => {
  for (const mode of ["omitted-publication", "missing-marker"] as const) {
    const layout = createRunLayout({ projectRoot: tempProject(), runId: `run-campaign-publication-${mode}` });
    campaignPropertyCatalog(layout, ["property-1"]);
    const campaignId = "stateful-invariant-campaign";
    writeArtifact(
      layout,
      campaignId,
      "recon-fuzzer-results.json",
      JSON.stringify(currentCampaign(["property-1"], [], { executionStatus: "complete" }))
    );
    writeArtifact(layout, campaignId, "findings.json", "[]");
    writeCampaignSummary(layout, campaignId, 0, 0);
    const node = {
      ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
      id: campaignId,
      logical_id: campaignId
    };
    assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true, mode);

    const markerPath = path.join(layout.root, ".ultrafuzz-verification", `${campaignId}.json`);
    if (mode === "missing-marker") {
      fs.rmSync(markerPath);
    } else {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
        publications: Array<{ path: string; sha256: string }>;
      };
      marker.publications = marker.publications.filter((entry) => entry.path !== campaignFixturePaths.raw_results);
      fs.writeFileSync(markerPath, JSON.stringify(marker), "utf8");
    }

    const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
    assert.equal(result.ok, false, mode);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code ===
            (mode === "missing-marker"
              ? "ARTIFACT_SEMANTIC_GATE_CONTEXT_UNAVAILABLE"
              : "ARTIFACT_SEMANTIC_GATE_FAILED") &&
          diagnostic.details?.gate === "property-campaign-publication-authority"
      ),
      `${mode}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

function writeCampaignSummary(
  layout: ReturnType<typeof createRunLayout>,
  campaignId: string,
  preDeduplication: number,
  postDeduplication: number
): void {
  const timeoutSetting = 'invariant_testing_fuzzer_timeout = "1h"';
  const currentConfig = fs.readFileSync(layout.resolvedConfigPath, "utf8");
  if (!/^\s*invariant_testing_fuzzer_timeout\s*=/mu.test(currentConfig)) {
    const invariantsHeader = /^\s*\[invariants\]\s*$/mu;
    const withTimeout = invariantsHeader.test(currentConfig)
      ? currentConfig.replace(invariantsHeader, (header) => `${header}\n${timeoutSetting}`)
      : `${currentConfig.trimEnd()}${currentConfig.trim().length === 0 ? "" : "\n\n"}[invariants]\n${timeoutSetting}\n`;
    fs.writeFileSync(layout.resolvedConfigPath, withTimeout, "utf8");
  }
  writeArtifact(layout, campaignId, "campaign-plan.json", JSON.stringify(currentCampaignPlan()));
  const artifactDir = getNodeArtifactDir(layout, campaignId);
  const campaign = JSON.parse(fs.readFileSync(path.join(artifactDir, "recon-fuzzer-results.json"), "utf8")) as {
    fuzzer_backend: string;
    execution: { status: "complete" | "partial" | "blocked" | "failed" | "timed-out" | "unavailable" };
    failures: Array<{
      id: string;
      deterministic_reproducer_ref: string | null;
      reproduction_blocker: string | null;
    }>;
    evidence_files: Array<{ path: string; sha256: string }>;
  };
  const findings = JSON.parse(fs.readFileSync(path.join(artifactDir, "findings.json"), "utf8")) as Array<{
    id: string;
  }>;
  const uniqueFindings = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  const failuresById = new Map(campaign.failures.map((failure) => [failure.id, failure]));
  writeArtifact(
    layout,
    campaignId,
    "campaign-summary.json",
    JSON.stringify({
      schema_version: "ultrafuzz.campaign-summary.v2",
      outcome: campaign.execution.status === "complete" ? "complete" : "partial",
      sequence_length: 100,
      implemented_property_suite_refs: ["implemented-properties.json"],
      campaign_plan_ref: "campaign-plan.json",
      backend_results: [
        {
          fuzzer_backend: campaign.fuzzer_backend,
          status: campaign.execution.status,
          result_ref: "recon-fuzzer-results.json"
        }
      ],
      finding_refs: uniqueFindings.map((finding) => finding.id),
      reproducer_refs: uniqueFindings.map((finding) => {
        const failure = failuresById.get(finding.id);
        return {
          finding_id: finding.id,
          path: failure?.deterministic_reproducer_ref ?? null,
          blocker: failure?.reproduction_blocker ?? null
        };
      }),
      failure_counts: {
        pre_deduplication: preDeduplication,
        post_deduplication: postDeduplication
      }
    })
  );
}

interface CampaignTimeoutPlanFixture extends Record<string, unknown> {
  schema_version: "ultrafuzz.invariant-campaign-plan.v2";
  available_vcpus: number;
  workers: number;
  configured_budget_seconds: number;
  deadline: string;
  finalization_reserve_seconds: number;
  configured_fuzzer_timeout_seconds: number;
  recon_internal_timeout_seconds: number;
  recon_test_limit: string;
  recon_sequence_length: number;
  host_soft_timeout_seconds: number;
  host_force_kill_grace_seconds: number;
  artifact_finalization_reserve_seconds: number;
  backend_started_at: string;
  fuzzing_deadline_utc: string;
  force_kill_deadline_utc: string;
  final_artifact_deadline_utc: string;
  backend: { name: "recon"; version: string | null; exact_shell_escaped_command: string };
  command_plan: Array<{ phase: "campaign"; command: string }>;
  paths: typeof campaignFixturePaths;
}

interface CampaignTimeoutResultFixture extends Record<string, unknown> {
  schema_version: "ultrafuzz.property-campaign.v3";
  fuzzer_backend: "recon";
  configured_timeout_seconds: number;
  sequence_length: number;
  exact_command: string;
  start_timestamp: string;
  end_timestamp: string;
  termination_reason: string;
  campaign_outcome: string;
  usable_results: boolean;
  execution: Record<string, unknown>;
  coverage: Record<string, unknown>;
  property_results: Array<Record<string, unknown>>;
  evidence_files: Array<Record<string, unknown>>;
}

interface CampaignTimeoutSummaryFixture extends Record<string, unknown> {
  schema_version: "ultrafuzz.campaign-summary.v2";
  outcome: string;
  sequence_length: number;
  campaign_plan_ref: string;
  backend_results: Array<Record<string, unknown>>;
  failure_counts: { pre_deduplication: number; post_deduplication: number };
}

interface CampaignTimeoutFixture {
  plan: CampaignTimeoutPlanFixture;
  backend: CampaignTimeoutResultFixture;
  summary: CampaignTimeoutSummaryFixture;
}

function campaignTimeoutFixture(): CampaignTimeoutFixture {
  const command =
    `timeout --preserve-status --signal=INT --kill-after=300s 3600s recon fuzz . ` +
    `--contract CryticTester --test-mode assertion --workers 8 ` +
    `--timeout 3600 --test-limit ${RECON_TIMEOUT_TEST_LIMIT} --seq-len 100`;
  const backend = currentCampaign(["property-1"], [], {
    executionStatus: "complete"
  }) as unknown as CampaignTimeoutResultFixture;
  Object.assign(backend, {
    configured_timeout_seconds: 3600,
    sequence_length: 100,
    exact_command: command,
    start_timestamp: "2026-08-11T00:00:00.000Z",
    end_timestamp: "2026-08-11T01:00:01.000Z",
    termination_reason: "configured-timeout",
    campaign_outcome: "complete",
    usable_results: true,
    execution: {
      ...backend.execution,
      command,
      workers: 8,
      started_at: "2026-08-11T00:00:00.000Z",
      finished_at: "2026-08-11T01:00:01.000Z",
      deadline: "2026-08-11T01:10:00.000Z"
    }
  });
  return {
    plan: {
      schema_version: "ultrafuzz.invariant-campaign-plan.v2",
      available_vcpus: 8,
      workers: 8,
      configured_budget_seconds: 4200,
      deadline: "2026-08-11T01:10:00.000Z",
      finalization_reserve_seconds: 300,
      configured_fuzzer_timeout_seconds: 3600,
      recon_internal_timeout_seconds: 3600,
      recon_test_limit: RECON_TIMEOUT_TEST_LIMIT,
      recon_sequence_length: 100,
      host_soft_timeout_seconds: 3600,
      host_force_kill_grace_seconds: 300,
      artifact_finalization_reserve_seconds: 300,
      backend_started_at: "2026-08-11T00:00:00.000Z",
      fuzzing_deadline_utc: "2026-08-11T01:00:00.000Z",
      force_kill_deadline_utc: "2026-08-11T01:05:00.000Z",
      final_artifact_deadline_utc: "2026-08-11T01:10:00.000Z",
      backend: { name: "recon", version: null, exact_shell_escaped_command: command },
      command_plan: [{ phase: "campaign", command }],
      paths: campaignFixturePaths
    },
    backend,
    summary: {
      schema_version: "ultrafuzz.campaign-summary.v2",
      outcome: "complete",
      sequence_length: 100,
      implemented_property_suite_refs: ["implemented-properties.json"],
      campaign_plan_ref: "campaign-plan.json",
      backend_results: [{ fuzzer_backend: "recon", status: "complete", result_ref: "recon-fuzzer-results.json" }],
      finding_refs: [],
      reproducer_refs: [],
      failure_counts: { pre_deduplication: 0, post_deduplication: 0 }
    }
  };
}

function synchronizeStrictCampaignTimeoutFixture(fixture: CampaignTimeoutFixture): void {
  const usableResults = fixture.backend.usable_results;
  const executionStatus =
    fixture.backend.campaign_outcome === "complete" && usableResults
      ? "complete"
      : usableResults
        ? "partial"
        : "failed";
  fixture.backend.execution = {
    ...fixture.backend.execution,
    status: executionStatus,
    usable_results: usableResults,
    command: fixture.backend.exact_command,
    workers: fixture.plan.workers,
    started_at: fixture.backend.start_timestamp,
    finished_at: fixture.backend.end_timestamp,
    deadline: fixture.plan.final_artifact_deadline_utc,
    exit_code: executionStatus === "complete" ? 0 : 1,
    failure:
      executionStatus === "complete"
        ? null
        : {
            category: fixture.backend.termination_reason === "launch-error" ? "launch-failed" : "process-failed",
            summary: "The timeout-evidence fixture did not complete normally."
          }
  };
  fixture.summary.backend_results[0] = {
    fuzzer_backend: "recon",
    status: executionStatus,
    result_ref: "recon-fuzzer-results.json"
  };
  if (!usableResults) {
    fixture.backend.coverage = {
      status: "unavailable",
      metrics: [],
      unavailable_reason: "The timeout-evidence fixture produced no usable results."
    };
    fixture.backend.property_results = fixture.backend.property_results.map((result) => ({
      ...result,
      status: "not-executed",
      failure_ids: [],
      coverage_metric_names: [],
      evidence_refs: [],
      reason: "The timeout-evidence fixture produced no usable results."
    }));
    fixture.backend.evidence_files = fixture.backend.evidence_files.filter(
      (evidence) => evidence.path === campaignFixturePaths.log
    );
  } else if (executionStatus === "partial") {
    fixture.backend.property_results = fixture.backend.property_results.map((result) => ({
      ...result,
      status: "inconclusive",
      failure_ids: [],
      reason: "The timeout-evidence fixture ended before establishing a pass."
    }));
  }
}

function runCampaignTimeoutGate(
  mutate: (fixture: CampaignTimeoutFixture) => void = () => undefined,
  options: {
    topologyTimeoutSeconds?: number | null;
    modelTimeoutSeconds?: number | null;
    logicalNodeId?: string;
    outputCounts?: Partial<Record<"plan" | "result" | "findings" | "summary", number>>;
    nonRecordDocument?: "result" | "summary";
    declaredPaths?: {
      plan: string;
      result: string;
      findings: string;
      summary: string;
    };
  } = {}
): ReturnType<typeof verifyRequiredArtifactsForAttempt> {
  const topologyTimeoutSeconds = options.topologyTimeoutSeconds === undefined ? 7200 : options.topologyTimeoutSeconds;
  const modelTimeoutSeconds = options.modelTimeoutSeconds ?? null;
  const declaredPaths = options.declaredPaths ?? {
    plan: "campaign-plan.json",
    result: "recon-fuzzer-results.json",
    findings: "findings.json",
    summary: "campaign-summary.json"
  };
  const outputCounts = {
    plan: 1,
    result: 1,
    findings: 1,
    summary: 1,
    ...options.outputCounts
  };
  const rolePath = (role: keyof typeof outputCounts, index: number): string =>
    index === 0 ? declaredPaths[role] : `${declaredPaths[role]}.duplicate-${index}`;
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-campaign-timeout",
    resolvedConfigToml: '[invariants]\ninvariant_testing_fuzzer_timeout = "1h"\n'
  });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = options.logicalNodeId ?? "stateful-invariant-campaign";
  const fixture = campaignTimeoutFixture();
  mutate(fixture);
  synchronizeStrictCampaignTimeoutFixture(fixture);
  fixture.summary.campaign_plan_ref = declaredPaths.plan;
  fixture.summary.backend_results[0] = {
    ...fixture.summary.backend_results[0],
    result_ref: declaredPaths.result
  };
  writeArtifact(
    layout,
    campaignId,
    declaredPaths.plan,
    JSON.stringify(fixture.plan),
    "ultrafuzz/invariant-campaign-plan@2"
  );
  writeArtifact(
    layout,
    campaignId,
    declaredPaths.result,
    JSON.stringify(options.nonRecordDocument === "result" ? [] : fixture.backend),
    "ultrafuzz/property-campaign@3"
  );
  writeArtifact(layout, campaignId, declaredPaths.findings, "[]", "ultrafuzz/findings@2");
  writeArtifact(
    layout,
    campaignId,
    declaredPaths.summary,
    JSON.stringify(options.nonRecordDocument === "summary" ? [] : fixture.summary),
    "ultrafuzz/campaign-summary@2"
  );
  for (let index = 1; index < outputCounts.plan; index += 1) {
    writeArtifact(
      layout,
      campaignId,
      rolePath("plan", index),
      JSON.stringify(fixture.plan),
      "ultrafuzz/invariant-campaign-plan@2"
    );
  }
  for (let index = 1; index < outputCounts.result; index += 1) {
    writeArtifact(
      layout,
      campaignId,
      rolePath("result", index),
      JSON.stringify(fixture.backend),
      "ultrafuzz/property-campaign@3"
    );
  }
  for (let index = 1; index < outputCounts.findings; index += 1) {
    writeArtifact(layout, campaignId, rolePath("findings", index), "[]", "ultrafuzz/findings@2");
  }
  for (let index = 1; index < outputCounts.summary; index += 1) {
    writeArtifact(
      layout,
      campaignId,
      rolePath("summary", index),
      JSON.stringify(fixture.summary),
      "ultrafuzz/campaign-summary@2"
    );
  }
  const base = currentCampaignNode([
    "campaign-plan.json",
    "recon-fuzzer-results.json",
    "findings.json",
    "campaign-summary.json"
  ]);
  const outputs = [
    ...Array.from({ length: outputCounts.plan }, (_, index) =>
      boundOutput(rolePath("plan", index), "ultrafuzz/invariant-campaign-plan@2", index === 0)
    ),
    ...Array.from({ length: outputCounts.result }, (_, index) =>
      boundOutput(rolePath("result", index), "ultrafuzz/property-campaign@3", false)
    ),
    ...Array.from({ length: outputCounts.findings }, (_, index) =>
      boundOutput(rolePath("findings", index), "ultrafuzz/findings@2", false)
    ),
    ...Array.from({ length: outputCounts.summary }, (_, index) =>
      boundOutput(rolePath("summary", index), "ultrafuzz/campaign-summary@2", false)
    )
  ];
  if (outputs.length > 0 && !outputs.some((output) => output.primary)) outputs[0] = { ...outputs[0]!, primary: true };
  const node: PlannedGraphNode = {
    ...base,
    id: campaignId,
    logical_id: campaignId,
    ...(topologyTimeoutSeconds === null ? {} : { timeout_seconds: topologyTimeoutSeconds }),
    ...(modelTimeoutSeconds === null
      ? {}
      : {
          model_fanout: [
            {
              attempt_id: campaignId,
              model_profile_id: "default",
              agent_ref: "CodexAgent",
              timeout_seconds: modelTimeoutSeconds,
              model_index: 0,
              loop_index: 0,
              attempt_index: 0
            }
          ]
        }),
    outputs
  };
  if (topologyTimeoutSeconds === null) delete node.timeout_seconds;
  return verifyRequiredArtifactsForAttempt(layout, node, campaignId);
}

test("current campaign timeout gate accepts exact configured Recon timeout evidence", () => {
  const result = runCampaignTimeoutGate();
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "campaign-timeout-evidence"),
    []
  );
});

test("current campaign timeout gate resolves custom artifact paths from sealed contract declarations", () => {
  const result = runCampaignTimeoutGate(
    (fixture) => {
      fixture.plan.configured_fuzzer_timeout_seconds = 3300;
    },
    {
      logicalNodeId: "project-owned-recon-campaign",
      declaredPaths: {
        plan: "custom/campaign-plan.json",
        result: "custom/recon-results.json",
        findings: "custom/findings.json",
        summary: "custom/campaign-summary.json"
      }
    }
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH" &&
        diagnostic.path?.endsWith("custom/campaign-plan.json#$.configured_fuzzer_timeout_seconds")
    ),
    JSON.stringify(result.diagnostics)
  );
});

test("current campaign timeout gate requires exactly one declaration for every tuple member", () => {
  const tupleMembers = [
    ["plan", "ultrafuzz/invariant-campaign-plan@2"],
    ["result", "ultrafuzz/property-campaign@3"],
    ["summary", "ultrafuzz/campaign-summary@2"],
    ["findings", "ultrafuzz/findings@2"]
  ] as const;
  for (const [role, contract] of tupleMembers) {
    for (const count of [0, 2] as const) {
      const result = runCampaignTimeoutGate(() => undefined, {
        logicalNodeId: "project-owned-recon-campaign",
        outputCounts: { [role]: count }
      });
      assert.equal(result.ok, false, `${role}:${count}`);
      assert.ok(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "CAMPAIGN_TIMEOUT_OUTPUT_DECLARATION_INVALID" &&
            diagnostic.message.includes(contract) &&
            diagnostic.message.endsWith(`found ${count}`)
        ),
        `${role}:${count}: ${JSON.stringify(result.diagnostics)}`
      );
    }
  }
});

test("current campaign timeout gate explicitly rejects non-object result and summary documents", () => {
  for (const role of ["result", "summary"] as const) {
    const result = runCampaignTimeoutGate(() => undefined, { nonRecordDocument: role });
    assert.equal(result.ok, false, role);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID" && diagnostic.message.includes("must be an object")
      ),
      `${role}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test("current campaign timeout gate requires the sealed topology node budget", () => {
  const result = runCampaignTimeoutGate(() => undefined, { topologyTimeoutSeconds: null });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_PLAN_BUDGET_MISSING"));
});

test("current campaign timeout gate accepts a sealed model-profile or run-default budget", () => {
  const result = runCampaignTimeoutGate(() => undefined, {
    topologyTimeoutSeconds: null,
    modelTimeoutSeconds: 7200
  });
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "campaign-timeout-evidence"),
    [],
    JSON.stringify(result.diagnostics)
  );
});

test("current campaign timeout gate rejects reserve subtraction and ambiguous Recon command flags", () => {
  const cases: Array<{
    name: string;
    code: string;
    mutate: (fixture: CampaignTimeoutFixture) => void;
  }> = [
    {
      name: "plan configured timeout",
      code: "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.configured_fuzzer_timeout_seconds = 3300;
      }
    },
    {
      name: "Recon internal timeout",
      code: "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.recon_internal_timeout_seconds = 3300;
      }
    },
    {
      name: "host soft timeout",
      code: "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.host_soft_timeout_seconds = 3300;
      }
    },
    {
      name: "backend configured timeout",
      code: "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
      mutate: (fixture) => {
        fixture.backend.configured_timeout_seconds = 3300;
      }
    },
    {
      name: "reserve-subtracted command timeout",
      code: "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--timeout 3600", "--timeout 3300");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "duplicate timeout flag",
      code: "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = `${fixture.backend.exact_command} --timeout 3600`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "missing timeout flag",
      code: "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--timeout 3600 ", "");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "missing GNU timeout wrapper",
      code: "CAMPAIGN_TIMEOUT_HOST_WRAPPER_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace(
          "timeout --preserve-status --signal=INT --kill-after=300s 3600s ",
          ""
        );
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "wrong GNU timeout soft deadline",
      code: "CAMPAIGN_TIMEOUT_HOST_WRAPPER_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("300s 3600s recon", "300s 3300s recon");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "wrong host force-kill grace",
      code: "CAMPAIGN_TIMEOUT_HOST_GRACE_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.host_force_kill_grace_seconds = 30;
        const command = fixture.backend.exact_command.replace("--kill-after=300s", "--kill-after=30s");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "foreground wrapper",
      code: "CAMPAIGN_TIMEOUT_HOST_WRAPPER_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--preserve-status", "--preserve-status --foreground");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "bounded default test limit",
      code: "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace(
          `--test-limit ${RECON_TIMEOUT_TEST_LIMIT}`,
          "--test-limit 50000"
        );
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "one-step stateful sequence in plan",
      code: "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.recon_sequence_length = 1;
      }
    },
    {
      name: "one-step stateful sequence in result",
      code: "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
      mutate: (fixture) => {
        fixture.backend.sequence_length = 1;
      }
    },
    {
      name: "one-step stateful sequence in summary",
      code: "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
      mutate: (fixture) => {
        fixture.summary.sequence_length = 1;
      }
    },
    {
      name: "one-step stateful sequence command",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--seq-len 100", "--seq-len 1");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "missing stateful sequence command flag",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace(" --seq-len 100", "");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "stateful sequence flag before a compound Recon command",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = `echo --seq-len 100 >/dev/null && ${fixture.backend.exact_command.replace(" --seq-len 100", "")}`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    ...["&&", "||", ";", "|", "&"].map((operator) => ({
      name: `attached ${operator} compound command`,
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture: CampaignTimeoutFixture) => {
        const command = `${fixture.backend.exact_command}${operator}recon fuzz . --config smoke.yaml`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    })),
    {
      name: "newline-delimited evidence command",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = `${fixture.backend.exact_command.replace(" --seq-len 100", "")}\necho --seq-len 100`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "non-executed Recon text passed to another command",
      code: "CAMPAIGN_TIMEOUT_HOST_WRAPPER_INVALID",
      mutate: (fixture) => {
        const command = `echo ${fixture.backend.exact_command}`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "commented stateful sequence flag",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace(" --seq-len 100", " # --seq-len 100");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "quoted stateful sequence text",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--seq-len 100", "'--seq-len 100'");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "duplicate stateful sequence flags",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = `${fixture.backend.exact_command} --seq-len 100`;
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "stateful sequence flag after the option terminator",
      code: "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
      mutate: (fixture) => {
        const command = fixture.backend.exact_command.replace("--seq-len 100", "-- --seq-len 100");
        fixture.backend.exact_command = command;
        fixture.plan.backend.exact_shell_escaped_command = command;
      }
    },
    {
      name: "plan test limit",
      code: "CAMPAIGN_TIMEOUT_TEST_LIMIT_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.recon_test_limit = "50000";
      }
    },
    {
      name: "non-positive host force-kill grace",
      code: "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      mutate: (fixture) => {
        fixture.plan.host_force_kill_grace_seconds = 0;
      }
    },
    {
      name: "non-positive artifact finalization reserve",
      code: "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      mutate: (fixture) => {
        fixture.plan.artifact_finalization_reserve_seconds = 0;
      }
    },
    {
      name: "positive but forged artifact finalization reserve",
      code: "CAMPAIGN_TIMEOUT_FINALIZATION_RESERVE_MISMATCH",
      mutate: (fixture) => {
        fixture.plan.artifact_finalization_reserve_seconds = 299;
      }
    },
    {
      name: "backend command differs from plan",
      code: "CAMPAIGN_TIMEOUT_COMMAND_MISMATCH",
      mutate: (fixture) => {
        fixture.backend.exact_command = `${fixture.backend.exact_command} --quiet`;
      }
    },
    {
      name: "backend start differs from plan",
      code: "CAMPAIGN_TIMEOUT_START_MISMATCH",
      mutate: (fixture) => {
        fixture.backend.start_timestamp = "2026-08-11T00:00:01.000Z";
      }
    },
    {
      name: "unknown termination reason",
      code: "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      mutate: (fixture) => {
        fixture.backend.termination_reason = "unknown";
      }
    }
  ];

  for (const entry of cases) {
    const result = runCampaignTimeoutGate(entry.mutate);
    assert.equal(result.ok, false, entry.name);
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === entry.code),
      `${entry.name}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test("current campaign timeout gate verifies deadline arithmetic", () => {
  for (const field of ["fuzzing_deadline_utc", "force_kill_deadline_utc", "final_artifact_deadline_utc"] as const) {
    const result = runCampaignTimeoutGate((fixture) => {
      fixture.plan[field] = "2026-08-11T01:00:02.000Z";
    });
    assert.equal(result.ok, false, field);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_DEADLINE_MISMATCH" && diagnostic.path?.endsWith(field)
      ),
      `${field}: ${JSON.stringify(result.diagnostics)}`
    );
  }
});

test("current campaign timeout gate derives early-exit outcome from recorded duration and usability", () => {
  const truthfulPartial = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T00:30:00.000Z";
    fixture.backend.termination_reason = "process-exit";
    fixture.backend.campaign_outcome = "partial";
    fixture.summary.outcome = "partial";
  });
  assert.equal(truthfulPartial.ok, true, JSON.stringify(truthfulPartial.diagnostics));

  const falseComplete = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T00:30:00.000Z";
  });
  assert.equal(falseComplete.ok, false);
  for (const code of ["CAMPAIGN_TIMEOUT_DURATION_MISMATCH", "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH"]) {
    assert.ok(
      falseComplete.diagnostics.some((diagnostic) => diagnostic.code === code),
      `${code}: ${JSON.stringify(falseComplete.diagnostics)}`
    );
  }

  const earlyConfiguredPartial = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T00:30:00.000Z";
    fixture.backend.campaign_outcome = "partial";
    fixture.summary.outcome = "partial";
  });
  assert.equal(earlyConfiguredPartial.ok, false);
  assert.ok(
    earlyConfiguredPartial.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_DURATION_MISMATCH")
  );

  const fullConfiguredPartial = runCampaignTimeoutGate((fixture) => {
    fixture.backend.campaign_outcome = "partial";
    fixture.summary.outcome = "partial";
  });
  assert.equal(fullConfiguredPartial.ok, false);
  assert.ok(
    fullConfiguredPartial.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH")
  );

  const fullDurationProcessExit = runCampaignTimeoutGate((fixture) => {
    fixture.backend.termination_reason = "process-exit";
  });
  assert.equal(fullDurationProcessExit.ok, false);
  assert.ok(
    fullDurationProcessExit.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH")
  );

  const falsePartialWithoutResults = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T00:00:01.000Z";
    fixture.backend.termination_reason = "launch-error";
    fixture.backend.campaign_outcome = "partial";
    fixture.backend.usable_results = false;
    fixture.summary.outcome = "partial";
  });
  assert.equal(falsePartialWithoutResults.ok, false);
  assert.ok(
    falsePartialWithoutResults.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH")
  );

  const truthfulBlocked = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T00:00:01.000Z";
    fixture.backend.termination_reason = "launch-error";
    fixture.backend.campaign_outcome = "blocked";
    fixture.backend.usable_results = false;
    fixture.summary.outcome = "blocked";
  });
  assert.equal(truthfulBlocked.ok, true, JSON.stringify(truthfulBlocked.diagnostics));
});

test("current campaign timeout gate classifies termination after the force-kill deadline", () => {
  const prematureForceKill = runCampaignTimeoutGate((fixture) => {
    fixture.backend.termination_reason = "host-force-kill";
    fixture.backend.campaign_outcome = "partial";
    fixture.summary.outcome = "partial";
  });
  assert.equal(prematureForceKill.ok, false);
  assert.ok(
    prematureForceKill.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_FORCE_KILL_MISMATCH")
  );

  const falseComplete = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T01:05:06.000Z";
  });
  assert.equal(falseComplete.ok, false);
  assert.ok(falseComplete.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_FORCE_KILL_MISMATCH"));

  const truthfulPartial = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T01:05:06.000Z";
    fixture.backend.termination_reason = "host-force-kill";
    fixture.backend.campaign_outcome = "partial";
    fixture.summary.outcome = "partial";
  });
  assert.equal(truthfulPartial.ok, true, JSON.stringify(truthfulPartial.diagnostics));

  const truthfulBlocked = runCampaignTimeoutGate((fixture) => {
    fixture.backend.end_timestamp = "2026-08-11T01:05:06.000Z";
    fixture.backend.termination_reason = "host-force-kill";
    fixture.backend.campaign_outcome = "blocked";
    fixture.backend.usable_results = false;
    fixture.summary.outcome = "blocked";
  });
  assert.equal(truthfulBlocked.ok, true, JSON.stringify(truthfulBlocked.diagnostics));
});

test("current campaign timeout gate cross-checks backend and summary outcomes", () => {
  const result = runCampaignTimeoutGate((fixture) => {
    fixture.summary.outcome = "partial";
  });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "CAMPAIGN_TIMEOUT_SUMMARY_MISMATCH"));
});

test("campaign gate accepts many counterexamples of one property deduplicated into one finding", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-dedup" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1"],
        [1, 2, 3].map((index) => ({
          id: `failure-${index}`,
          property_ids: ["property-1"]
        }))
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2", "failure-3"])])
  );
  writeCampaignSummary(layout, campaignId, 3, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("current campaign gate accepts the exact R55 partition: 29 counterexamples, two findings", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-r55" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  // 27 counterexamples of property-1 and 2 of property-3, exactly as R55 produced.
  const failures = Array.from({ length: 29 }, (_value, index) => ({
    id: `failure-${index + 1}`,
    status: "reproduced",
    property_ids: [index + 1 === 25 || index + 1 === 26 ? "property-3" : "property-1"]
  }));
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1", "property-3"], failures))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        failures.filter((failure) => failure.property_ids[0] === "property-1").map((failure) => failure.id)
      ),
      accountedCampaignFinding(
        "failure-25",
        ["property-3"],
        failures.filter((failure) => failure.property_ids[0] === "property-3").map((failure) => failure.id)
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 29, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("current campaign gate requires partition metadata and accepts an explicit complete partition", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-required" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-1"] }
        ]
      )
    )
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  writeCampaignSummary(layout, campaignId, 2, 1);

  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };
  const current = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(current.ok, false);
  assert.ok(current.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REQUIRED"));
  assert.equal(
    current.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_UNCLAIMED").length,
    2
  );
  assert.ok(
    current.diagnostics
      .filter((diagnostic) => diagnostic.code.startsWith("PROPERTY_CAMPAIGN_PARTITION_"))
      .every((diagnostic) => diagnostic.severity === "error")
  );

  const completePartition = accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2"]);
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([completePartition]));
  const complete = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
});

test("campaign partition rejects unknown contributions and per-finding count mismatches", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-unknown" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-unknown"], 2)])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  for (const code of [
    "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_UNKNOWN",
    "PROPERTY_CAMPAIGN_PARTITION_COUNT_MISMATCH",
    "PROPERTY_CAMPAIGN_PARTITION_UNCLAIMED"
  ]) {
    assert.ok(
      result.diagnostics.some((diagnostic) => diagnostic.code === code),
      code
    );
  }
});

test("campaign partition rejects duplicate claims and property subset mismatches", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-duplicate" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-2"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-2"] }
        ]
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-1", "failure-2"]),
      accountedCampaignFinding("failure-2", ["property-2"], ["failure-2"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_DUPLICATE"));
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_PROPERTY_MISMATCH")
  );
});

test("campaign partition requires each finding ID to represent one of its contributions", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-representative" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-1"] }
        ]
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1"], ["failure-2"]),
      accountedCampaignFinding("failure-2", ["property-1"], ["failure-1"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_REPRESENTATIVE_MISMATCH")
      .length,
    2
  );
});

test("campaign partition requires a finding's properties to equal its contribution union", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-property-union" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-2"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-2"] }
        ]
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding("failure-1", ["property-1", "property-2"], ["failure-1"]),
      accountedCampaignFinding("failure-2", ["property-2"], ["failure-2"])
    ])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.equal(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_PROPERTY_MISMATCH")
      .length,
    1
  );
});

test("campaign partition binds finding backend provenance to its exact contributions", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partition-backend-set" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        [
          {
            fuzzer_backend: "recon",
            failure_id: "failure-1",
            raw_result_ref: "recon-fuzzer-results.json"
          }
        ],
        1,
        ["medusa"]
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_BACKEND_MISMATCH")
  );
});

test("campaign contributions bind raw_result_ref to the authenticated campaign artifact", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-raw-result-authority" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        [
          {
            fuzzer_backend: "recon",
            failure_id: "failure-1",
            raw_result_ref: campaignFixturePaths.raw_results
          }
        ]
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PARTITION_RAW_RESULT_MISMATCH")
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "property-campaign-context-joins"
    )
  );
});

test("campaign failures and findings cannot name selected but non-implemented properties", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-implemented-authority" });
  campaignPropertyCatalog(layout, ["property-1"]);
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "fixture-deferred",
            summary: "The fixture property is not implemented.",
            next_action: "Implement the property before fuzzing it."
          }
        }
      ]
    })
  );
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign([], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1"], ["failure-1"])])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_IMPLEMENTATION_REFERENCE_INVALID").length >=
      2
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "property-campaign-context-joins"
    )
  );
});

test("campaign contract rejects v2 bytes without converting or rewriting them", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-v2-rejected" });
  const campaignId = "stateful-invariant-campaign";
  const campaignPath = writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v2",
      fuzzer_backend: "recon",
      failures: []
    })
  );
  const before = fs.readFileSync(campaignPath);
  const node = {
    ...plannedNode(["recon-fuzzer-results.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(campaignPath), before);
});

test("campaign gate conditionally reconciles the R55 summary failure counts with every backend failure and finding", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-r55-summary" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  const failures = Array.from({ length: 29 }, (_value, index) => ({
    id: `failure-${index + 1}`,
    status: "reproduced",
    property_ids: [index + 1 === 25 || index + 1 === 26 ? "property-3" : "property-1"]
  }));
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1", "property-3"], failures))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([
      accountedCampaignFinding(
        "failure-1",
        ["property-1"],
        failures.filter((failure) => failure.property_ids[0] === "property-1").map((failure) => failure.id)
      ),
      accountedCampaignFinding(
        "failure-25",
        ["property-3"],
        failures.filter((failure) => failure.property_ids[0] === "property-3").map((failure) => failure.id)
      )
    ])
  );
  writeCampaignSummary(layout, campaignId, 29, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json", "campaign-summary.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  assert.equal(verifyRequiredArtifactsForAttempt(layout, node, campaignId).ok, true);

  writeCampaignSummary(layout, campaignId, 0, 0);
  const mismatched = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(mismatched.ok, false);
  assert.ok(
    mismatched.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "campaign-summary-count-coupling"
    )
  );
  assert.deepEqual(
    mismatched.diagnostics
      .filter((diagnostic) => diagnostic.code === "CAMPAIGN_SUMMARY_FAILURE_COUNT_MISMATCH")
      .map((diagnostic) => diagnostic.path?.split(".").at(-1)),
    ["pre_deduplication", "post_deduplication"]
  );

  const legacyPath = writeArtifact(layout, campaignId, "campaign-summary.json", JSON.stringify({ outcome: "partial" }));
  const legacyBytes = fs.readFileSync(legacyPath);
  const legacy = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(legacy.ok, false);
  assert.ok(legacy.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);

  const incompletePath = writeArtifact(
    layout,
    campaignId,
    "campaign-summary.json",
    JSON.stringify({
      schema_version: "ultrafuzz.campaign-summary.v2",
      outcome: "partial",
      implemented_property_suite_refs: ["implemented-properties.json"],
      campaign_plan_ref: "campaign-plan.json",
      backend_results: [{ fuzzer_backend: "recon", status: "partial", result_ref: "recon-fuzzer-results.json" }],
      finding_refs: [],
      reproducer_refs: [],
      failure_counts: { pre_deduplication: 29 }
    })
  );
  const incompleteBytes = fs.readFileSync(incompletePath);
  const incomplete = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.diagnostics.some((diagnostic) => diagnostic.code === "JSON_SCHEMA_VIOLATION"));
  assert.deepEqual(fs.readFileSync(incompletePath), incompleteBytes);
});

test("campaign gate still rejects a property-derived failure no finding covers", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-uncovered" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-2"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-2"] }
        ]
      )
    )
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  writeCampaignSummary(layout, campaignId, 2, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.path ?? "", /failures\[1\]/u);
});

test("campaign gate does not let an unrelated finding cover a campaign failure", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-unrelated-coverage" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("unrelated-finding", ["property-1"])])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING"));
});

test("campaign gate names only the genuinely uncovered property of a partially covered failure", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-partial" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-2"],
        [
          { id: "failure-1", property_ids: ["property-1", "property-2"] },
          { id: "failure-2", property_ids: ["property-1"] }
        ]
      )
    )
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-2", ["property-1"])]));
  writeCampaignSummary(layout, campaignId, 2, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.message ?? "", /property-2/u);
  // property-1 is covered by the finding, so naming it would send the retry
  // after an artifact that is already correct.
  assert.doesNotMatch(missing?.message ?? "", /property-1/u);
});

test("campaign gate keeps flagging ambiguous and mismatched same-ID findings", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-ambiguous" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-1"] }
        ]
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1"]), campaignFinding("failure-1", ["property-1"])])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };
  const ambiguous = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_AMBIGUOUS"));

  // A finding that claims a failure's ID must still carry that failure's properties,
  // even though other failures may now be covered by a different finding.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", []), campaignFinding("failure-2", ["property-1"])])
  );
  writeCampaignSummary(layout, campaignId, 2, 2);
  const mismatched = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISMATCH"));
});

test("campaign gate rejects a failure whose property combination no single finding claims", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-combination" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  // The counterexample that broke both invariants at once is the most
  // interesting one in the file; per-property coverage alone would drop it.
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-2"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-2"] },
          { id: "failure-3", property_ids: ["property-1", "property-2"] }
        ]
      )
    )
  );
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1"]), campaignFinding("failure-2", ["property-2"])])
  );
  writeCampaignSummary(layout, campaignId, 3, 2);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const missing = result.diagnostics.find((diagnostic) => diagnostic.code === "PROPERTY_FINDING_REFERENCE_MISSING");
  assert.ok(missing);
  assert.match(missing?.message ?? "", /failure-3/u);
});

test("campaign gate accepts a deduplicated finding that unions the properties of the failures it covers", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-union" });
  campaignPropertyCatalog(layout, ["property-1", "property-3"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(
      currentCampaign(
        ["property-1", "property-3"],
        [
          { id: "failure-1", property_ids: ["property-1"] },
          { id: "failure-2", property_ids: ["property-1", "property-3"] }
        ]
      )
    )
  );
  // The campaign prompt says to reuse a stable failure ID on the deduplicated
  // finding, so the finding that collapses both failures carries failure-1's ID
  // while carrying the union of their properties.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([accountedCampaignFinding("failure-1", ["property-1", "property-3"], ["failure-1", "failure-2"])])
  );
  writeCampaignSummary(layout, campaignId, 2, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.source === "property-provenance"),
    []
  );
  assert.equal(result.ok, true);
});

test("campaign gate rejects a finding that claims a property no failure ever reported", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-invented" });
  campaignPropertyCatalog(layout, ["property-1", "property-2"]);
  const campaignId = "stateful-invariant-campaign";
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1", "property-2"], [{ id: "failure-1", property_ids: ["property-1"] }]))
  );
  // property-2 is implemented and in the catalog, so only the campaign join can
  // catch it: no counterexample anywhere reported it.
  writeArtifact(
    layout,
    campaignId,
    "findings.json",
    JSON.stringify([campaignFinding("failure-1", ["property-1", "property-2"])])
  );
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  const unobserved = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PROPERTY_UNOBSERVED"
  );
  assert.ok(unobserved);
  assert.match(unobserved?.message ?? "", /property-2/u);
  assert.doesNotMatch(unobserved?.message ?? "", /property-1/u);
});

test("campaign gate rejects a property claim anchored to a failure that reported no property", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-campaign-harness-anchor" });
  campaignPropertyCatalog(layout, ["property-1"]);
  const campaignId = "stateful-invariant-campaign";
  // A harness defect legitimately omits property_ids. A finding may not borrow
  // its ID and then attribute a catalog property to it.
  writeArtifact(
    layout,
    campaignId,
    "recon-fuzzer-results.json",
    JSON.stringify(currentCampaign(["property-1"], [{ id: "failure-1", property_ids: [] }]))
  );
  writeArtifact(layout, campaignId, "findings.json", JSON.stringify([campaignFinding("failure-1", ["property-1"])]));
  writeCampaignSummary(layout, campaignId, 1, 1);
  const node = {
    ...currentCampaignNode(["recon-fuzzer-results.json", "findings.json"]),
    id: campaignId,
    logical_id: campaignId
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, campaignId);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === "PROPERTY_CAMPAIGN_PROPERTY_UNOBSERVED"),
    `expected an unobserved-property diagnostic, got ${JSON.stringify(result.diagnostics.map((d) => d.code))}`
  );
});

// The prompt still illustrates the human-readable rendering, but the pinned
// schema and runtime-derived value are the only JSON-shape and value authority.
// Run that Markdown illustration against a value derived from canonical
// current-run handoffs so the prompt cannot become a parallel JSON authority.
function fencedBlockAfter(markdown: string, anchor: string, language: string): string {
  const anchorIndex = markdown.indexOf(anchor);
  assert.ok(anchorIndex >= 0, `final-report.md no longer contains ${JSON.stringify(anchor)}`);
  const fence = "```" + language + "\n";
  const start = markdown.indexOf(fence, anchorIndex);
  assert.ok(start >= 0, `no ${language} block follows ${JSON.stringify(anchor)}`);
  const bodyStart = start + fence.length;
  const end = markdown.indexOf("\n```", bodyStart);
  assert.ok(end >= 0, `unterminated ${language} block after ${JSON.stringify(anchor)}`);
  return markdown.slice(bodyStart, end);
}

test("the coverage Markdown example in final-report.md matches runtime-derived coverage", () => {
  const finalReport = loadBuiltInPromptAssets().find((asset) => asset.relativePath === "review/final-report.md");
  assert.ok(finalReport, "missing built-in prompt review/final-report.md");
  const coverageMarkdown = fencedBlockAfter(
    finalReport.markdown,
    "These bullets are the Markdown rendering",
    "markdown"
  );

  const catalog = {
    schema_version: "ultrafuzz.properties.v2" as const,
    properties: [
      {
        id: "property-1",
        description: "The accounting relation holds.",
        category: "accounting",
        priority: "high" as const,
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "hub-total" }],
        reference_expectations: ["scfuzzbench:example:expectation-1"]
      },
      {
        id: "property-2",
        description: "The premium delta is conserved.",
        category: "accounting",
        priority: "medium" as const,
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "premium-delta" }]
      }
    ]
  };
  const implementation = {
    schema_version: "ultrafuzz.implemented-properties.v3" as const,
    selection: {
      priority_threshold: "medium" as const,
      priorities: ["high" as const, "medium" as const],
      property_ids: ["property-1", "property-2"]
    },
    properties: [
      {
        property_id: "property-1",
        status: "implemented" as const,
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: ["test/foundry/Property1.t.sol"],
        reference_expectations: ["scfuzzbench:example:expectation-1"]
      },
      {
        property_id: "property-2",
        status: "deferred" as const,
        implementation_paths: [],
        test_paths: [],
        blocker: {
          code: "transition-oracle-deferred",
          summary: "The handler cannot observe the premium delta returned by the Hub.",
          next_action: "Add property-scoped snapshots around the handler."
        }
      }
    ]
  };
  const expectedCoverage = derivePropertyImplementationCoverage(catalog, implementation, {
    configuredSelection: { priority_threshold: "medium", priorities: ["high", "medium"] },
    requireConfiguredSelection: true
  });
  assert.equal(expectedCoverage.ok, true, JSON.stringify(expectedCoverage.issues));
  assert.ok(expectedCoverage.value);

  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-prompt-coverage-example",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "medium"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(layout, "property-specification-fanin", "properties.json", JSON.stringify(catalog));
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify(implementation)
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        property_implementation_coverage: expectedCoverage.value
      })
    )
  );
  writeArtifact(
    layout,
    node.id,
    "report.md",
    `# Ultrafuzz report\n\n## Property implementation coverage\n\n${coverageMarkdown}\n`
  );

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics, null, 2));
});

test("coverage Markdown accepts a blocker summary escaped or as written, but not reworded", () => {
  const summary = "The handler cannot observe _beforeTokenTransfer deltas *at all*.";
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-blocker-escaping",
    resolvedConfigToml: '[invariants]\nproperty_priority_threshold = "high"\n'
  });
  const node = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report"
  };
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-1",
          description: "The premium delta is conserved.",
          category: "accounting",
          priority: "high",
          sources: [{ source_node_id: "property-specification-recon", source_property_id: "premium-delta" }]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v3",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
      properties: [
        {
          property_id: "property-1",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "transition-oracle-deferred",
            summary,
            next_action: "Add property-scoped snapshots around the handler."
          }
        }
      ]
    })
  );
  writeArtifact(
    layout,
    node.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1"],
          implemented_property_ids: [],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: ["property-1"],
          reference_expected_property_ids: [],
          reference_expectation_ids: [],
          blocker_summaries: [`property-1: ${summary}`]
        }
      })
    )
  );
  const counts =
    "- Priority threshold: `high`\n- Included priorities: `high`\n- Selected properties: `1`\n" +
    "- Implemented properties: `0`\n- Blocked properties: `0`\n- Pending properties: `0`\n" +
    "- Deferred properties: `1`\n- Reference expectation properties: `0`\n";
  const withBlocker = (bullet: string): string =>
    `# Ultrafuzz report\n\n## Property implementation coverage\n\n${counts}\nBlocker summaries:\n${bullet}\n`;

  writeArtifact(layout, node.id, "report.md", withBlocker(`- property-1: ${summary}`));
  const plain = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(plain.ok, true, JSON.stringify(plain.diagnostics));

  writeArtifact(
    layout,
    node.id,
    "report.md",
    withBlocker("- property-1: The handler cannot observe \\_beforeTokenTransfer deltas \\*at all\\*.")
  );
  const escaped = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(escaped.ok, true, JSON.stringify(escaped.diagnostics));

  // Relaxing the escaping must not relax the join: the Markdown still has to
  // report the same blocker the JSON does.
  writeArtifact(layout, node.id, "report.md", withBlocker("- property-1: Something else entirely."));
  const reworded = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(reworded.ok, false);
  assert.ok(
    reworded.diagnostics.some(
      (diagnostic) => diagnostic.code === "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH"
    )
  );
});

// #408: the field parser strips a trailing pipe to normalize Markdown table
// cells, which silently truncates any value that legitimately ENDS with one.
// R58's property-specification-fanin failed on five consecutive properties whose
// descriptions quote a row of Aave's docs/overview.md verbatim, as the fan-in
// prompt requires. Any target documenting parameters in tables hits this.
test("properties Markdown parity accepts a description that ends with a pipe", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-fanin-trailing-pipe" });
  const ledgerNodeId = "custom-evidence-root";
  // Shaped after R58's property-277: prose, then a verbatim docs table row.
  const description =
    "Project discovery evidence evidence-doc-liquidation-targethf-row (bound) at docs/overview.md:line 237; " +
    "verbatim: | `TargetHealthFactor` | A spoke-wide value set by the Governor. | Must be >= the constant. |";
  writeArtifact(
    layout,
    ledgerNodeId,
    "setup/invariant-evidence-ledger.json",
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-doc-liquidation-targethf-row",
          source_path: "docs/overview.md",
          source_location: "line 237",
          kind: "bound",
          verbatim: "TargetHealthFactor is a per-reserve WAD parameter above the liquidation threshold.",
          inventory_ids: ["inventory-doc-liquidation-targethf-row"]
        }
      ],
      inventory_rows: [
        {
          id: "inventory-doc-liquidation-targethf-row",
          description: "TargetHealthFactor is a per-reserve WAD parameter.",
          ledger_ids: ["evidence-doc-liquidation-targethf-row"]
        }
      ],
      scan_probes: []
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.json",
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v2",
      properties: [
        {
          id: "property-277",
          description,
          category: "configuration",
          priority: "high",
          sources: [{ source_node_id: ledgerNodeId, source_property_id: "evidence-doc-liquidation-targethf-row" }],
          ledger_ids: ["evidence-doc-liquidation-targethf-row"]
        }
      ]
    })
  );
  writeArtifact(
    layout,
    "property-specification-fanin",
    "properties.md",
    [
      '### Canonical property: "property-277"',
      `description: ${JSON.stringify(description)}`,
      'category: "configuration"',
      'priority: "high"',
      `sources: ${JSON.stringify([
        { source_node_id: ledgerNodeId, source_property_id: "evidence-doc-liquidation-targethf-row" }
      ])}`,
      'ledger_ids: ["evidence-doc-liquidation-targethf-row"]',
      '### End canonical property: "property-277"'
    ].join("\n")
  );
  const node = {
    ...plannedNode(["properties.json", "properties.md"]),
    id: "property-specification-fanin",
    logical_id: "property-specification-fanin"
  };

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.deepEqual(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "PROPERTY_MARKDOWN_PARITY_MISSING"),
    []
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test("coverage gate joins unavailable evidence to a blocked null goal and the exact typed blockers", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-unavailable-coverage" });
  const node = {
    ...plannedNode(["coverage-goal.json", "coverage-report.md", "coverage-evidence.json"]),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);

  const blockers = [
    {
      category: "coverage-tooling-blocked",
      summary: "Recon <span hidden>could not</span> produce an authenticated coverage map.",
      evidence_paths: ["logs/recon-coverage.log"]
    }
  ];
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "unavailable",
    blockers
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: null,
    current_status: "blocked",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- Status: unavailable\n\nBlockers:\n" +
    "- coverage-tooling-blocked: Recon &lt;span hidden&gt;could not&lt;/span&gt; produce an authenticated coverage map.\n" +
    "  - Evidence: `logs/recon-coverage.log`\n";
  const publish = (
    goalValue: unknown,
    markdownValue = markdown
  ): ReturnType<typeof verifyRequiredArtifactsForAttempt> => {
    writeDeclaredArtifactNode(layout, node.id, node.outputs, {
      "coverage-goal.json": JSON.stringify(goalValue),
      "coverage-report.md": markdownValue,
      "coverage-evidence.json": JSON.stringify(evidence)
    });
    return verifyRequiredArtifactsForAttempt(layout, node, node.id);
  };

  const valid = publish(goal);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const flattenedBlockerEvidence = publish(goal, markdown.replace("  - Evidence:", "- Evidence:"));
  assert.equal(flattenedBlockerEvidence.ok, false);
  assert.ok(
    flattenedBlockerEvidence.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_EVIDENCE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(flattenedBlockerEvidence.diagnostics)
  );

  const nonBlocked = publish({ ...goal, current_status: "not-run", blockers: [] });
  assert.ok(
    nonBlocked.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_GOAL_BLOCKER_MISMATCH"),
    JSON.stringify(nonBlocked.diagnostics)
  );

  const measuredBlocked = publish({
    ...goal,
    current_measurement: {
      scope: "recon-selected-declaration-completeness",
      covered_ranges: 0,
      total_ranges: 0
    }
  });
  assert.ok(
    measuredBlocked.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_GOAL_BLOCKER_MISMATCH"),
    JSON.stringify(measuredBlocked.diagnostics)
  );

  const mismatchedBlocker = publish({
    ...goal,
    blockers: [{ ...blockers[0], summary: "A different blocker was reported." }]
  });
  assert.ok(
    mismatchedBlocker.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_GOAL_BLOCKER_MISMATCH"),
    JSON.stringify(mismatchedBlocker.diagnostics)
  );
});

test("coverage goal parity derives 0/0 as below-target and ignores unsafe counts without throwing", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-empty-measured-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src"]\n'
  });
  const rawLcov = "";
  const rawReconSelection = "{}\n";
  const digest = (contents: string): string => createHash("sha256").update(contents).digest("hex");
  const rawPaths = new Set(["coverage-input.lcov", "recon-coverage.json"]);
  const node = {
    ...plannedNode([
      "coverage-goal.json",
      "coverage-report.md",
      "coverage-evidence.json",
      "coverage-input.lcov",
      "recon-coverage.json"
    ]),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  node.outputs = node.outputs.map((output) =>
    rawPaths.has(output.path) ? boundOutput(output.path, "ultrafuzz/text@1", false) : output
  );
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src/Interfaces.sol"),
    "interface ExternalApi { function quote(uint256 value) external view returns (uint256); }\n"
  );

  const selectedMeasurement = {
    scope: "recon-selected-declaration-completeness",
    covered_ranges: 0,
    total_ranges: 0
  };
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov: { path: "coverage-input.lcov", sha256: digest(rawLcov) },
    recon_selection: { path: "recon-coverage.json", sha256: digest(rawReconSelection) },
    views: [selectedMeasurement, { scope: "production-declaration-completeness", covered_ranges: 0, total_ranges: 0 }],
    files: [
      {
        path: "src/Interfaces.sol",
        kind: "production",
        included: false,
        exclusion_reason: "contains no executable declarations",
        covered_ranges: 0,
        total_ranges: 0
      }
    ],
    counted_ranges: [],
    zero_coverage_components: []
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: selectedMeasurement,
    current_status: "below-target",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n" +
    "- recon-selected-declaration-completeness: `0/0`\n" +
    "- production-declaration-completeness: `0/0`\n\n" +
    "Excluded from Recon-selected scope:\n- `src/Interfaces.sol` (production): contains no executable declarations\n\n" +
    "Zero-coverage components:\n- None\n";
  const publish = (
    goalValue: unknown,
    evidenceValue: unknown = evidence
  ): ReturnType<typeof verifyRequiredArtifactsForAttempt> => {
    writeDeclaredArtifactNode(layout, node.id, node.outputs, {
      "coverage-goal.json": JSON.stringify(goalValue),
      "coverage-report.md": markdown,
      "coverage-evidence.json": JSON.stringify(evidenceValue),
      "coverage-input.lcov": rawLcov,
      "recon-coverage.json": rawReconSelection
    });
    return verifyRequiredArtifactsForAttempt(layout, node, node.id);
  };

  const valid = publish(goal);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const contradictory = publish({ ...goal, current_status: "target-met" });
  assert.ok(
    contradictory.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_GOAL_MEASUREMENT_MISMATCH"),
    JSON.stringify(contradictory.diagnostics)
  );

  const unsafeEvidence = structuredClone(evidence);
  unsafeEvidence.views[0]!.covered_ranges = Number.MAX_SAFE_INTEGER + 1;
  const unsafe = publish(goal, unsafeEvidence);
  assert.equal(unsafe.ok, false);
});

test("coverage gate binds selected and unselected ranges to the trusted production inventory", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-scoped-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src", "contracts"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src/Core.sol"),
    "contract Core {\n  function core() external {}\n  function read() external view returns (uint256) { return 1; }\n}\n"
  );
  fs.writeFileSync(
    path.join(workspace, "src/Critical.sol"),
    [
      "contract Critical {",
      "  struct Inner { uint256 x; }",
      "  struct Outer { Inner inner; }",
      "  modifier check(bool ok) { require(ok); _; }",
      "  function helper() private {}",
      // Equality inside a modifier argument belongs to the function signature;
      // it must not hide the public getter declared after the function body.
      "  function guarded(bool cond) external check(cond == true) {}",
      "  Outer public state = Outer({inner: Inner({x: 1})});",
      "}",
      ""
    ].join("\n")
  );
  const reconSelection = writeReconCoverageSelection(workspace, { "src/Core.sol": ["2"] });
  const lcov = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 }
  });
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
      { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 6 }
    ],
    files: [
      {
        path: "src/Core.sol",
        kind: "production",
        included: true,
        covered_ranges: 1,
        total_ranges: 2
      },
      {
        path: "src/Critical.sol",
        kind: "production",
        included: false,
        exclusion_reason: "not selected",
        covered_ranges: 0,
        total_ranges: 4
      }
    ],
    counted_ranges: [
      {
        file: "src/Core.sol",
        kind: "production",
        start_line: 2,
        line_count: 1,
        selected: true,
        covered: true
      },
      {
        file: "src/Core.sol",
        kind: "production",
        start_line: 3,
        line_count: 1,
        selected: false,
        covered: false
      },
      {
        file: "src/Critical.sol",
        kind: "production",
        start_line: 4,
        line_count: 1,
        selected: false,
        covered: false
      },
      {
        file: "src/Critical.sol",
        kind: "production",
        start_line: 5,
        line_count: 1,
        selected: false,
        covered: false
      },
      {
        file: "src/Critical.sol",
        kind: "production",
        start_line: 6,
        line_count: 1,
        selected: false,
        covered: false
      },
      {
        file: "src/Critical.sol",
        kind: "production",
        start_line: 7,
        line_count: 1,
        selected: false,
        covered: false
      }
    ],
    zero_coverage_components: [
      { path: "src/Core.sol", kind: "production", start_line: 3, line_count: 1 },
      { path: "src/Critical.sol", kind: "production", start_line: 4, line_count: 1 },
      { path: "src/Critical.sol", kind: "production", start_line: 5, line_count: 1 },
      { path: "src/Critical.sol", kind: "production", start_line: 6, line_count: 1 },
      { path: "src/Critical.sol", kind: "production", start_line: 7, line_count: 1 }
    ]
  };
  const scopedMarkdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n- production-declaration-completeness: `1/6`\n\n" +
    "Excluded from Recon-selected scope:\n- `src/Critical.sol` (production): not selected\n\n" +
    "Zero-coverage components:\n- `src/Core.sol:3-3` (production)\n" +
    "- `src/Critical.sol:4-4` (production)\n- `src/Critical.sol:5-5` (production)\n" +
    "- `src/Critical.sol:6-6` (production)\n- `src/Critical.sol:7-7` (production)\n";
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
    current_status: "target-met",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const publish = (value: unknown, markdown = scopedMarkdown, goalValue: unknown = goal): void => {
    writeMeasuredCoverageArtifacts(layout, node, workspace, { goal: goalValue, markdown, evidence: value });
  };

  publish(evidence);
  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const longHitCount = "9".repeat(100_000);
  const longHitLcov = Buffer.from(
    [
      "SF:src/Core.sol",
      "DA:2,0",
      `DA:2,${longHitCount}`,
      "DA:3,0",
      "end_of_record",
      "SF:src/Critical.sol",
      "DA:4,0",
      "DA:5,0",
      "DA:6,0",
      "DA:7,0",
      "end_of_record",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(workspace, "coverage-input.lcov"), longHitLcov);
  const longHitEvidence = structuredClone(evidence);
  longHitEvidence.lcov.sha256 = createHash("sha256").update(longHitLcov).digest("hex");
  publish(longHitEvidence);
  const boundedLongHit = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(boundedLongHit.ok, true, JSON.stringify(boundedLongHit.diagnostics));
  writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 }
  });

  for (const unscopedProducerScore of [
    'Coverage was 100% <span style="opacity: 0">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="clip-path: inset(100%)">recon-selected-declaration-completeness</span>.',
    "covg_eval=39/39."
  ]) {
    publish(evidence, `${scopedMarkdown}\n## Notes\n\n${unscopedProducerScore}\n`);
    const hiddenProducerScope = verifyRequiredArtifactsForAttempt(layout, node, node.id);
    assert.equal(hiddenProducerScope.ok, false, unscopedProducerScore);
    assert.ok(
      hiddenProducerScope.diagnostics.some((diagnostic) =>
        /^UNSCOPED_COVERAGE_(?:FRACTION|PERCENTAGE)$/u.test(diagnostic.code)
      ),
      JSON.stringify(hiddenProducerScope.diagnostics)
    );
  }

  const incompleteZeroRanges = structuredClone(evidence);
  incompleteZeroRanges.zero_coverage_components.shift();
  publish(incompleteZeroRanges, scopedMarkdown.replace("- `src/Core.sol:3-3` (production)\n", ""));
  const missingPartialFileGap = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingPartialFileGap.ok, false);
  assert.ok(
    missingPartialFileGap.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_ZERO_COMPONENT_RESULT_MISMATCH"
    ),
    JSON.stringify(missingPartialFileGap.diagnostics)
  );

  const inventedCoveredFlag = structuredClone(evidence);
  inventedCoveredFlag.counted_ranges[1]!.covered = true;
  inventedCoveredFlag.files[0]!.covered_ranges = 2;
  inventedCoveredFlag.views[1]!.covered_ranges = 2;
  inventedCoveredFlag.zero_coverage_components.shift();
  publish(
    inventedCoveredFlag,
    scopedMarkdown
      .replace("production-declaration-completeness: `1/6`", "production-declaration-completeness: `2/6`")
      .replace("- `src/Core.sol:3-3` (production)\n", "")
  );
  const forgedCoverage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(forgedCoverage.ok, false);
  assert.ok(
    forgedCoverage.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_RANGE_RESULT_MISMATCH"),
    JSON.stringify(forgedCoverage.diagnostics)
  );

  const missingLcov = structuredClone(evidence);
  missingLcov.lcov.path = "echidna/missing.lcov";
  publish(missingLcov);
  const missingRawAuthority = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingRawAuthority.ok, false);
  assert.ok(
    missingRawAuthority.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_LCOV_INVALID"),
    JSON.stringify(missingRawAuthority.diagnostics)
  );

  const staleLcovDigest = structuredClone(evidence);
  staleLcovDigest.lcov.sha256 = "f".repeat(64);
  publish(staleLcovDigest);
  const staleRawAuthority = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(staleRawAuthority.ok, false);
  assert.ok(
    staleRawAuthority.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_LCOV_INVALID"),
    JSON.stringify(staleRawAuthority.diagnostics)
  );

  fs.mkdirSync(path.join(workspace, "test/recon"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "test/recon/Harness.sol"),
    "contract Harness { function fuzz() external {} }\n"
  );
  const lcovWithHarness = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 },
    "test/recon/Harness.sol": { 1: 1 }
  });
  const omittedHarness = structuredClone(evidence);
  omittedHarness.lcov = lcovWithHarness;
  publish(omittedHarness);
  const missingAttribution = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingAttribution.ok, false);
  assert.ok(
    missingAttribution.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_LCOV_SOURCE_OMITTED"),
    JSON.stringify(missingAttribution.diagnostics)
  );

  const relabeledHarness = structuredClone(omittedHarness);
  relabeledHarness.files.push({
    path: "test/recon/Harness.sol",
    kind: "test",
    included: false,
    exclusion_reason: "not selected",
    covered_ranges: 0,
    total_ranges: 0
  });
  publish(
    relabeledHarness,
    scopedMarkdown.replace(
      "- `src/Critical.sol` (production): not selected",
      "- `src/Critical.sol` (production): not selected\n- `test/recon/Harness.sol` (test): not selected"
    )
  );
  const spoofedAttribution = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(spoofedAttribution.ok, false);
  assert.ok(
    spoofedAttribution.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_SOURCE_ATTRIBUTION_MISMATCH"),
    JSON.stringify(spoofedAttribution.diagnostics)
  );

  fs.mkdirSync(path.join(workspace, "packages/core/lib"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "packages/core/test/recon"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "packages/core/lib/Dep.sol"), "library Dep { function value() internal {} }\n");
  fs.writeFileSync(
    path.join(workspace, "packages/core/test/recon/NestedHarness.sol"),
    "contract NestedHarness { function fuzz() external {} }\n"
  );
  const nestedSources = structuredClone(evidence);
  nestedSources.lcov = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 },
    "packages/core/lib/Dep.sol": { 1: 1 },
    "packages/core/test/recon/NestedHarness.sol": { 1: 1 }
  });
  nestedSources.files.push(
    {
      path: "packages/core/lib/Dep.sol",
      kind: "dependency",
      included: false,
      exclusion_reason: "not selected",
      covered_ranges: 0,
      total_ranges: 0
    },
    {
      path: "packages/core/test/recon/NestedHarness.sol",
      kind: "harness",
      included: false,
      exclusion_reason: "not selected",
      covered_ranges: 0,
      total_ranges: 0
    }
  );
  publish(
    nestedSources,
    scopedMarkdown.replace(
      "- `src/Critical.sol` (production): not selected",
      "- `src/Critical.sol` (production): not selected\n" +
        "- `packages/core/lib/Dep.sol` (dependency): not selected\n" +
        "- `packages/core/test/recon/NestedHarness.sol` (harness): not selected"
    )
  );
  const nestedAttribution = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(nestedAttribution.ok, true, JSON.stringify(nestedAttribution.diagnostics));

  evidence.lcov = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 }
  });

  evidence.recon_selection = writeReconCoverageSelection(workspace, {});
  publish(evidence);
  const missingSelectionAuthority = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingSelectionAuthority.ok, false);
  assert.ok(
    missingSelectionAuthority.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_SELECTION_MISMATCH"
    ),
    JSON.stringify(missingSelectionAuthority.diagnostics)
  );
  evidence.recon_selection = writeReconCoverageSelection(workspace, { "src/Core.sol": ["2"] });

  const inventedNonProduction = structuredClone(evidence);
  inventedNonProduction.files.push({
    path: "test/Fake.sol",
    kind: "test",
    included: false,
    exclusion_reason: "not selected",
    covered_ranges: 0,
    total_ranges: 1
  });
  inventedNonProduction.counted_ranges.push({
    file: "test/Fake.sol",
    kind: "test",
    start_line: 1,
    line_count: 1,
    selected: false,
    covered: false
  });
  inventedNonProduction.zero_coverage_components.push({
    path: "test/Fake.sol",
    kind: "test",
    start_line: 1,
    line_count: 1
  });
  publish(
    inventedNonProduction,
    scopedMarkdown
      .replace(
        "- `src/Critical.sol` (production): not selected",
        "- `src/Critical.sol` (production): not selected\n- `test/Fake.sol` (test): not selected"
      )
      .replace(
        "- `src/Critical.sol:7-7` (production)\n",
        "- `src/Critical.sol:7-7` (production)\n- `test/Fake.sol:1-1` (test)\n"
      )
  );
  const fakeSource = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(fakeSource.ok, false);
  assert.ok(fakeSource.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_NON_PRODUCTION_FILE_UNKNOWN"));

  const hiddenExcludedRange = structuredClone(evidence);
  hiddenExcludedRange.counted_ranges[5]!.selected = true;
  publish(hiddenExcludedRange);
  const hidden = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(hidden.ok, false);
  assert.ok(
    hidden.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
        diagnostic.details?.gate === "coverage-evidence-reconciliation"
    ),
    JSON.stringify(hidden.diagnostics)
  );

  const inventedExcludedTotal = structuredClone(evidence);
  inventedExcludedTotal.files[1]!.total_ranges = 5;
  inventedExcludedTotal.views[1]!.total_ranges = 7;
  publish(inventedExcludedTotal);
  const invented = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(invented.ok, false);
  assert.ok(
    invented.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_FILE_DENOMINATOR_MISMATCH"),
    JSON.stringify(invented.diagnostics)
  );

  const incidentallyCoveredUnselected = structuredClone(evidence);
  incidentallyCoveredUnselected.counted_ranges[1]!.covered = true;
  incidentallyCoveredUnselected.files[0]!.covered_ranges = 2;
  incidentallyCoveredUnselected.views[1]!.covered_ranges = 2;
  incidentallyCoveredUnselected.lcov = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 1 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 }
  });
  incidentallyCoveredUnselected.zero_coverage_components =
    incidentallyCoveredUnselected.zero_coverage_components.filter((entry) => entry.path !== "src/Core.sol");
  publish(
    incidentallyCoveredUnselected,
    scopedMarkdown
      .replace("production-declaration-completeness: `1/6`", "production-declaration-completeness: `2/6`")
      .replace("- `src/Core.sol:3-3` (production)\n", "")
  );
  const independentViews = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(independentViews.ok, true, JSON.stringify(independentViews.diagnostics));
  evidence.lcov = writeCoverageLcov(workspace, {
    "src/Core.sol": { 2: 1, 3: 0 },
    "src/Critical.sol": { 4: 0, 5: 0, 6: 0, 7: 0 }
  });

  const inventedSelection = structuredClone(evidence);
  inventedSelection.counted_ranges[0]!.selected = false;
  inventedSelection.counted_ranges[0]!.covered = false;
  inventedSelection.counted_ranges[1]!.selected = true;
  inventedSelection.counted_ranges[1]!.covered = true;
  inventedSelection.zero_coverage_components = [
    { path: "src/Core.sol", kind: "production", start_line: 2, line_count: 1 },
    ...inventedSelection.zero_coverage_components.filter((entry) => entry.path !== "src/Core.sol")
  ];
  publish(inventedSelection);
  const wrongSelection = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(wrongSelection.ok, false);
  assert.ok(
    wrongSelection.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_SELECTION_MISMATCH"),
    JSON.stringify(wrongSelection.diagnostics)
  );

  const wrongBoundary = structuredClone(evidence);
  wrongBoundary.counted_ranges[5]!.line_count = 2;
  publish(wrongBoundary);
  const staleBoundary = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(staleBoundary.ok, false);
  assert.ok(
    staleBoundary.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_BOUNDARY_MISMATCH"),
    JSON.stringify(staleBoundary.diagnostics)
  );

  const outOfBounds = structuredClone(evidence);
  outOfBounds.counted_ranges[0]!.line_count = 999;
  publish(outOfBounds);
  const impossible = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(impossible.ok, false);
  assert.ok(
    impossible.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_OUT_OF_BOUNDS"),
    JSON.stringify(impossible.diagnostics)
  );

  publish(evidence, "# Coverage\n\n100% standardized coverage\n");
  const missingCanonicalProjection = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(missingCanonicalProjection.ok, false);
  assert.ok(
    missingCanonicalProjection.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_EVIDENCE_MARKDOWN_MISMATCH"
    )
  );

  publish(evidence, `${scopedMarkdown}\n## Notes\n\nrecon-selected-declaration-completeness coverage: 100%.\n`);
  const namedPercentage = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(namedPercentage.ok, false);
  assert.ok(
    namedPercentage.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_EVIDENCE_MARKDOWN_MISMATCH"),
    JSON.stringify(namedPercentage.diagnostics)
  );

  publish(evidence, `${scopedMarkdown}\n## Notes\n\nrecon-selected-declaration-completeness: 0/1.\n`);
  const contradictoryScopedFraction = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contradictoryScopedFraction.ok, false);
  assert.ok(
    contradictoryScopedFraction.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_EVIDENCE_MARKDOWN_MISMATCH"
    ),
    JSON.stringify(contradictoryScopedFraction.diagnostics)
  );

  publish(evidence, `${scopedMarkdown}\n## Notes\n\nRetry 1/2 reproduced the same revert.\n`);
  const ordinaryFraction = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(ordinaryFraction.ok, false);
  assert.ok(
    ordinaryFraction.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_SCORE"),
    JSON.stringify(ordinaryFraction.diagnostics)
  );

  const staleGoal = structuredClone(goal);
  staleGoal.current_measurement.covered_ranges = 0;
  publish(evidence, scopedMarkdown, staleGoal);
  const contradictoryGoal = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(contradictoryGoal.ok, false);
  assert.ok(
    contradictoryGoal.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_GOAL_MEASUREMENT_MISMATCH")
  );
});

test("coverage gate rejects a selected declaration with any uncovered instrumented line", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-partial-declaration-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src/Core.sol"),
    [
      "contract Core {",
      "  function core() external {",
      "    uint256 value = 1;",
      "    if (value == 1) value = 2;",
      "  }",
      "}",
      ""
    ].join("\n")
  );
  const reconSelection = writeReconCoverageSelection(workspace, { "src/Core.sol": ["2-5"] });
  const lcov = writeCoverageLcov(workspace, { "src/Core.sol": { 3: 1, 4: 0 } });
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
      { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 1 }
    ],
    files: [{ path: "src/Core.sol", kind: "production", included: true, covered_ranges: 1, total_ranges: 1 }],
    counted_ranges: [
      {
        file: "src/Core.sol",
        kind: "production",
        start_line: 2,
        line_count: 4,
        selected: true,
        covered: true
      }
    ],
    zero_coverage_components: [] as Array<{
      path: string;
      kind: string;
      start_line: number;
      line_count: number;
    }>
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
    current_status: "target-met",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  writeMeasuredCoverageArtifacts(layout, node, workspace, {
    goal,
    markdown:
      "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n- production-declaration-completeness: `1/1`\n\n" +
      "Excluded from Recon-selected scope:\n- None\n\nZero-coverage components:\n- None\n",
    evidence
  });

  const partial = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(partial.ok, false);
  assert.ok(
    partial.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_RANGE_RESULT_MISMATCH"),
    JSON.stringify(partial.diagnostics)
  );

  evidence.counted_ranges[0]!.covered = false;
  evidence.files[0]!.covered_ranges = 0;
  evidence.views[0]!.covered_ranges = 0;
  evidence.views[1]!.covered_ranges = 0;
  goal.current_measurement.covered_ranges = 0;
  goal.current_status = "below-target";
  writeMeasuredCoverageArtifacts(layout, node, workspace, {
    goal,
    markdown:
      "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `0/1`\n- production-declaration-completeness: `0/1`\n\n" +
      "Excluded from Recon-selected scope:\n- None\n\nZero-coverage components:\n- None\n",
    evidence
  });

  const completeMetric = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(completeMetric.ok, true, JSON.stringify(completeMetric.diagnostics));

  evidence.zero_coverage_components.push({
    path: "src/Core.sol",
    kind: "production",
    start_line: 2,
    line_count: 4
  });
  writeMeasuredCoverageArtifacts(layout, node, workspace, {
    goal,
    markdown:
      "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `0/1`\n- production-declaration-completeness: `0/1`\n\n" +
      "Excluded from Recon-selected scope:\n- None\n\nZero-coverage components:\n- `src/Core.sol:2-5` (production)\n",
    evidence
  });
  const partialMislabeledAsZero = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(partialMislabeledAsZero.ok, false);
  assert.ok(
    partialMislabeledAsZero.diagnostics.some(
      (diagnostic) => diagnostic.code === "COVERAGE_ZERO_COMPONENT_RESULT_MISMATCH"
    ),
    JSON.stringify(partialMislabeledAsZero.diagnostics)
  );
});

test("coverage gate excludes nested non-production directories from configured production roots", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-scoped-coverage-nested-roots",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["contracts", "test"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  for (const relativePath of [
    "contracts/Core.sol",
    "contracts/lib/ProductionLibrary.sol",
    "test/ConfiguredProduction.sol",
    "contracts/dependencies/Dep.sol",
    "contracts/test/Test.sol",
    "contracts/test/recon/Harness.sol",
    "contracts/mocks/Mock.sol"
  ]) {
    const absolutePath = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `contract ${path.basename(relativePath, ".sol")} { function run() external {} }\n`);
  }
  const reconSelection = writeReconCoverageSelection(workspace, { "contracts/Core.sol": ["1"] });
  const lcov = writeCoverageLcov(workspace, {
    "contracts/Core.sol": { 1: 1 },
    "contracts/lib/ProductionLibrary.sol": { 1: 1 },
    "test/ConfiguredProduction.sol": { 1: 1 },
    "contracts/dependencies/Dep.sol": { 1: 1 },
    "contracts/test/Test.sol": { 1: 1 },
    "contracts/test/recon/Harness.sol": { 1: 1 },
    "contracts/mocks/Mock.sol": { 1: 1 }
  });
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
      { scope: "production-declaration-completeness", covered_ranges: 3, total_ranges: 3 }
    ],
    files: [
      { path: "contracts/Core.sol", kind: "production", included: true, covered_ranges: 1, total_ranges: 1 },
      {
        path: "contracts/lib/ProductionLibrary.sol",
        kind: "production",
        included: false,
        exclusion_reason: "not selected",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "test/ConfiguredProduction.sol",
        kind: "production",
        included: false,
        exclusion_reason: "configured root remains authoritative",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "contracts/dependencies/Dep.sol",
        kind: "dependency",
        included: false,
        exclusion_reason: "nested dependency source",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "contracts/test/Test.sol",
        kind: "test",
        included: false,
        exclusion_reason: "nested test source",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "contracts/test/recon/Harness.sol",
        kind: "harness",
        included: false,
        exclusion_reason: "nested harness source",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "contracts/mocks/Mock.sol",
        kind: "harness",
        included: false,
        exclusion_reason: "mock harness source",
        covered_ranges: 1,
        total_ranges: 1
      }
    ],
    counted_ranges: [
      {
        file: "contracts/Core.sol",
        kind: "production",
        start_line: 1,
        line_count: 1,
        selected: true,
        covered: true
      },
      {
        file: "contracts/lib/ProductionLibrary.sol",
        kind: "production",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      },
      {
        file: "test/ConfiguredProduction.sol",
        kind: "production",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      },
      {
        file: "contracts/dependencies/Dep.sol",
        kind: "dependency",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      },
      {
        file: "contracts/test/Test.sol",
        kind: "test",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      },
      {
        file: "contracts/test/recon/Harness.sol",
        kind: "harness",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      },
      {
        file: "contracts/mocks/Mock.sol",
        kind: "harness",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      }
    ],
    zero_coverage_components: []
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
    current_status: "target-met",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n- production-declaration-completeness: `3/3`\n\n" +
    "Excluded from Recon-selected scope:\n- `contracts/lib/ProductionLibrary.sol` (production): not selected\n" +
    "- `test/ConfiguredProduction.sol` (production): configured root remains authoritative\n" +
    "- `contracts/dependencies/Dep.sol` (dependency): nested dependency source\n" +
    "- `contracts/test/Test.sol` (test): nested test source\n" +
    "- `contracts/test/recon/Harness.sol` (harness): nested harness source\n" +
    "- `contracts/mocks/Mock.sol` (harness): mock harness source\n\n" +
    "Zero-coverage components:\n- None\n";
  writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown, evidence });

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  const relabeled = structuredClone(evidence);
  relabeled.files[3]!.kind = "production";
  relabeled.counted_ranges[3]!.kind = "production";
  writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown, evidence: relabeled });
  const spoofed = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(spoofed.ok, false);
  assert.ok(
    spoofed.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_SOURCE_ATTRIBUTION_MISMATCH"),
    JSON.stringify(spoofed.diagnostics)
  );
});

test("coverage gate groups same-line Solidity declarations into one representable trusted range", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-minified-scoped-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src/Minified.sol"),
    "contract Minified { uint256 public a; uint256 public b; function set(uint256 value) external { a = value; } }\n"
  );
  fs.writeFileSync(
    path.join(workspace, "src/Interfaces.sol"),
    "interface ExternalApi { function quote(uint256 value) external view returns (uint256); } " +
      "abstract contract AbstractApi { function settle() external virtual; }\n"
  );
  fs.writeFileSync(
    path.join(workspace, "lib/Dependency.sol"),
    "library Dependency { function normalize(uint256 value) internal pure returns (uint256) { return value; } }\n"
  );
  const reconSelection = writeReconCoverageSelection(workspace, {
    "src/Minified.sol": ["1"],
    "lib/Dependency.sol": ["1"]
  });
  const lcov = writeCoverageLcov(workspace, {
    "src/Minified.sol": { 1: 1 },
    "lib/Dependency.sol": { 1: 1 }
  });
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
      { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 1 }
    ],
    files: [
      {
        path: "src/Minified.sol",
        kind: "production",
        included: true,
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "lib/Dependency.sol",
        kind: "dependency",
        included: false,
        exclusion_reason: "outside configured production roots",
        covered_ranges: 1,
        total_ranges: 1
      },
      {
        path: "src/Interfaces.sol",
        kind: "production",
        included: false,
        exclusion_reason: "contains no executable declarations",
        covered_ranges: 0,
        total_ranges: 0
      }
    ],
    counted_ranges: [
      {
        file: "src/Minified.sol",
        kind: "production",
        start_line: 1,
        line_count: 1,
        selected: true,
        covered: true
      },
      {
        file: "lib/Dependency.sol",
        kind: "dependency",
        start_line: 1,
        line_count: 1,
        selected: false,
        covered: true
      }
    ],
    zero_coverage_components: []
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
    current_status: "target-met",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n- production-declaration-completeness: `1/1`\n\n" +
    "Excluded from Recon-selected scope:\n- `lib/Dependency.sol` (dependency): outside configured production roots\n" +
    "- `src/Interfaces.sol` (production): contains no executable declarations\n\n" +
    "Zero-coverage components:\n- None\n";
  writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown, evidence });

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  evidence.recon_selection = writeReconCoverageSelection(workspace, {
    "src/Minified.sol": ["1"],
    "lib/Missing.sol": ["1"]
  });
  writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown, evidence });
  const nonexistentDependency = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(nonexistentDependency.ok, false);
  assert.ok(
    nonexistentDependency.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_RECON_SELECTION_FILE_UNKNOWN"),
    JSON.stringify(nonexistentDependency.diagnostics)
  );
});

test("coverage gate fails closed when every configured production root is missing", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-missing-coverage-roots",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["missing-production"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "test/Harness.sol"), "contract Harness {}\n");
  const reconSelection = writeReconCoverageSelection(workspace, {});
  const lcov = writeCoverageLcov(workspace, {});
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 },
      { scope: "production-declaration-completeness", covered_ranges: 0, total_ranges: 0 }
    ],
    files: [
      {
        path: "test/Harness.sol",
        kind: "harness",
        included: false,
        exclusion_reason: "not a production source",
        covered_ranges: 0,
        total_ranges: 0
      }
    ],
    counted_ranges: [],
    zero_coverage_components: []
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 },
    current_status: "below-target",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `0/0`\n" +
    "- production-declaration-completeness: `0/0`\n\nExcluded from Recon-selected scope:\n" +
    "- `test/Harness.sol` (harness): not a production source\n\nZero-coverage components:\n- None\n";
  writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown, evidence });

  const result = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_SOURCE_INVENTORY_UNSAFE"));
});

test("coverage gate authenticates Vyper declaration boundaries outside the Solidity-only Recon selection", () => {
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-vyper-scoped-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src"]\n'
  });
  const node = {
    ...plannedMeasuredCoverageNode(),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  writePlannedGraph(layout, [node]);
  const workspace = path.join(layout.workspacesDir, node.id);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "src/Module.vy"),
    [
      '"""module docs',
      "def fake():",
      "    pass",
      '"""',
      "value: public(uint256)",
      "",
      "@external",
      "def mutate(",
      "    amount: uint256,",
      "):",
      "    self.value = amount",
      "",
      "@external",
      "@view",
      "def read() -> uint256:",
      "    return self.value",
      "",
      "@internal",
      "def helper():",
      "    pass",
      "",
      "interface ExternalApi:",
      "    def quote(value: uint256) -> uint256: view",
      ""
    ].join("\n")
  );
  const reconSelection = writeReconCoverageSelection(workspace, {});
  const lcov = writeCoverageLcov(workspace, {
    "src/Module.vy": { 5: 0, 8: 0, 15: 0, 19: 0 }
  });

  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 },
      { scope: "production-declaration-completeness", covered_ranges: 0, total_ranges: 4 }
    ],
    files: [
      {
        path: "src/Module.vy",
        kind: "production",
        included: false,
        exclusion_reason: "Recon coverage-map generation is Solidity-only",
        covered_ranges: 0,
        total_ranges: 4
      }
    ],
    counted_ranges: [
      {
        file: "src/Module.vy",
        kind: "production",
        start_line: 5,
        line_count: 1,
        selected: false,
        covered: false
      },
      {
        file: "src/Module.vy",
        kind: "production",
        start_line: 8,
        line_count: 4,
        selected: false,
        covered: false
      },
      {
        file: "src/Module.vy",
        kind: "production",
        start_line: 15,
        line_count: 2,
        selected: false,
        covered: false
      },
      {
        file: "src/Module.vy",
        kind: "production",
        start_line: 19,
        line_count: 2,
        selected: false,
        covered: false
      }
    ],
    zero_coverage_components: [
      { path: "src/Module.vy", kind: "production", start_line: 5, line_count: 1 },
      { path: "src/Module.vy", kind: "production", start_line: 8, line_count: 4 },
      { path: "src/Module.vy", kind: "production", start_line: 15, line_count: 2 },
      { path: "src/Module.vy", kind: "production", start_line: 19, line_count: 2 }
    ]
  };
  const goal = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 },
    current_status: "below-target",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: []
  };
  const markdown =
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `0/0`\n" +
    "- production-declaration-completeness: `0/4`\n\nExcluded from Recon-selected scope:\n" +
    "- `src/Module.vy` (production): Recon coverage-map generation is Solidity-only\n\n" +
    "Zero-coverage components:\n- `src/Module.vy:5-5` (production)\n" +
    "- `src/Module.vy:8-11` (production)\n- `src/Module.vy:15-16` (production)\n" +
    "- `src/Module.vy:19-20` (production)\n";
  const publish = (value: unknown, rendered = markdown): void => {
    writeMeasuredCoverageArtifacts(layout, node, workspace, { goal, markdown: rendered, evidence: value });
  };

  publish(evidence);
  const valid = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const wrongBoundary = structuredClone(evidence);
  wrongBoundary.counted_ranges[1]!.line_count = 3;
  publish(wrongBoundary);
  const staleBoundary = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(staleBoundary.ok, false);
  assert.ok(
    staleBoundary.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_BOUNDARY_MISMATCH"),
    JSON.stringify(staleBoundary.diagnostics)
  );

  const inventedSelection = structuredClone(evidence);
  inventedSelection.counted_ranges[1]!.selected = true;
  inventedSelection.counted_ranges[1]!.covered = true;
  inventedSelection.files[0] = {
    path: "src/Module.vy",
    kind: "production",
    included: true,
    covered_ranges: 1,
    total_ranges: 4
  } as (typeof inventedSelection.files)[number];
  inventedSelection.views[0] = { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 };
  inventedSelection.views[1] = { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 4 };
  inventedSelection.zero_coverage_components = inventedSelection.zero_coverage_components.filter(
    (entry) => entry.start_line !== 8
  );
  publish(
    inventedSelection,
    "# Coverage\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n" +
      "- production-declaration-completeness: `1/4`\n\nExcluded from Recon-selected scope:\n- None\n\nZero-coverage components:\n" +
      "- `src/Module.vy:5-5` (production)\n- `src/Module.vy:15-16` (production)\n" +
      "- `src/Module.vy:19-20` (production)\n"
  );
  const wrongSelection = verifyRequiredArtifactsForAttempt(layout, node, node.id);
  assert.equal(wrongSelection.ok, false);
  assert.ok(
    wrongSelection.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_PRODUCTION_RANGE_SELECTION_MISMATCH"),
    JSON.stringify(wrongSelection.diagnostics)
  );
});

test("final report preserves typed coverage evidence and its canonical Markdown projection", () => {
  const lcovArtifactPath = "reports/2026/08/coverage-input.lcov";
  const layout = createRunLayout({
    projectRoot: tempProject(),
    runId: "run-final-scoped-coverage",
    resolvedConfigToml: '[permissions]\nproduction_source_roots = ["src"]\n'
  });
  const coverageNode = {
    ...plannedMeasuredCoverageNode(["coverage-report.md", "coverage-evidence.json"]),
    id: "stateful-invariant-coverage",
    logical_id: "stateful-invariant-coverage",
    artifact_dir: "artifacts/stateful-invariant-coverage"
  };
  coverageNode.outputs = coverageNode.outputs.map((output) =>
    output.path === "coverage-input.lcov" ? boundOutput(lcovArtifactPath, "ultrafuzz/text@1", false) : output
  );
  const reportNode = {
    ...plannedNode(["report.md", "report.json"]),
    id: "final-report",
    logical_id: "final-report",
    artifact_dir: "artifacts/final-report",
    depends_on: [coverageNode.id]
  };
  writePlannedGraph(layout, [coverageNode, reportNode]);
  const coverageWorkspace = path.join(layout.workspacesDir, coverageNode.id);
  const workspace = path.join(coverageWorkspace, "src");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "Core.sol"), "contract Core { function core() external {} }\n");
  const reconSelection = writeReconCoverageSelection(coverageWorkspace, { "src/Core.sol": ["1"] });
  const lcov = writeCoverageLcov(coverageWorkspace, { "src/Core.sol": { 1: 1 } }, lcovArtifactPath);
  const evidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov,
    recon_selection: reconSelection,
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
      { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 1 }
    ],
    files: [
      {
        path: "src/Core.sol",
        kind: "production",
        included: true,
        covered_ranges: 1,
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
        covered: true
      }
    ],
    zero_coverage_components: []
  };
  writeMeasuredCoverageArtifacts(layout, coverageNode, coverageWorkspace, {
    markdown: "# Coverage\n\nrecon-selected-declaration-completeness: 1/1\n",
    evidence
  });
  const scopedMarkdown =
    "# Ultrafuzz report\n\n## Scoped coverage evidence\n\n- recon-selected-declaration-completeness: `1/1`\n" +
    "- production-declaration-completeness: `1/1`\n\nExcluded from Recon-selected scope:\n- None\n\n" +
    "Zero-coverage components:\n- None\n";
  writeArtifact(layout, reportNode.id, "report.md", scopedMarkdown);
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence }))
  );

  const valid = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(valid.ok, true, JSON.stringify(valid.diagnostics));

  const indentedMeasuredBody = scopedMarkdown
    .split("\n")
    .map((line, index) => (index > 2 && line.length > 0 ? `    ${line}` : line))
    .join("\n");
  writeArtifact(layout, reportNode.id, "report.md", indentedMeasuredBody);
  const measuredBodyAsCode = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(measuredBodyAsCode.ok, false);
  assert.ok(
    measuredBodyAsCode.diagnostics.some(
      (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    ),
    JSON.stringify(measuredBodyAsCode.diagnostics)
  );
  writeArtifact(layout, reportNode.id, "report.md", scopedMarkdown);

  for (const stylesheetReport of [
    `<style>h2,ul { display: none }</style>\n${scopedMarkdown}`,
    `<style>.x::after { content: "Overall coverage was 100%" }</style>\n${scopedMarkdown}`
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", stylesheetReport);
    const stylesheet = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(stylesheet.ok, false, stylesheetReport);
    assert.ok(
      stylesheet.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_MARKDOWN_STYLESHEET_UNSUPPORTED"),
      JSON.stringify(stylesheet.diagnostics)
    );
    assert.ok(
      stylesheet.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"),
      JSON.stringify(stylesheet.diagnostics)
    );
  }

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\n<select><option selected>Overall coverage was 100%</option><option>for production-declaration-completeness</option></select>\n`
  );
  const selectControl = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(selectControl.ok, false, JSON.stringify(selectControl.diagnostics));
  assert.ok(
    selectControl.diagnostics.some((diagnostic) => diagnostic.code === "COVERAGE_MARKDOWN_SELECT_UNSUPPORTED"),
    JSON.stringify(selectControl.diagnostics)
  );

  for (const hiddenContainer of ["details", "dialog"]) {
    writeArtifact(
      layout,
      reportNode.id,
      "report.md",
      `<${hiddenContainer}>\n\n${scopedMarkdown}\n## Container end\n\n</${hiddenContainer}>\n`
    );
    const hiddenCanonicalSection = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(hiddenCanonicalSection.ok, false, hiddenContainer);
    assert.ok(
      hiddenCanonicalSection.diagnostics.some(
        (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
      ),
      `${hiddenContainer}: ${JSON.stringify(hiddenCanonicalSection.diagnostics)}`
    );

    writeArtifact(
      layout,
      reportNode.id,
      "report.md",
      `<${hiddenContainer} open>\n\n${scopedMarkdown}\n## Container end\n\n</${hiddenContainer}>\n`
    );
    const visibleCanonicalSection = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(
      visibleCanonicalSection.ok,
      true,
      `${hiddenContainer}: ${JSON.stringify(visibleCanonicalSection.diagnostics)}`
    );
  }

  const commentedScopedMarkdown = scopedMarkdown
    .replace("## Scoped coverage evidence", "<!--\n## Scoped coverage evidence")
    .replace("Zero-coverage components:\n- None\n", "Zero-coverage components:\n- None\n## Hidden boundary\n-->\n");
  writeArtifact(layout, reportNode.id, "report.md", commentedScopedMarkdown);
  const commentedScopedSection = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(commentedScopedSection.ok, false);
  assert.ok(
    commentedScopedSection.diagnostics.some(
      (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    ),
    JSON.stringify(commentedScopedSection.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nOverall coverage was 25%; the recon-selected-declaration-completeness result was 1/1.\n`
  );
  const additionalProse = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(additionalProse.ok, false);
  assert.ok(
    additionalProse.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_SCORE"),
    JSON.stringify(additionalProse.diagnostics)
  );
  assert.ok(
    additionalProse.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"),
    JSON.stringify(additionalProse.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nproduction-declaration-completeness coverage: 100%.\n`
  );
  const namedPercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(namedPercentage.ok, false);
  assert.ok(
    namedPercentage.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"),
    JSON.stringify(namedPercentage.diagnostics)
  );
  assert.ok(
    !namedPercentage.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
    JSON.stringify(namedPercentage.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nThe recon-selected-declaration-completeness score was 100%, while overall coverage was 25%.\n`
  );
  const mixedScopePercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(mixedScopePercentage.ok, false);
  assert.ok(mixedScopePercentage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"));
  assert.ok(
    mixedScopePercentage.diagnostics.some(
      (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    ),
    JSON.stringify(mixedScopePercentage.diagnostics)
  );

  for (const mixedScore of [
    "The recon-selected-declaration-completeness score was 100%. Overall coverage was 25%.",
    "The recon-selected-declaration-completeness score was 100% (overall coverage was 25%).",
    "recon-selected-declaration-completeness coverage was 100% — overall coverage was 25%.",
    "recon-selected-declaration-completeness coverage was 100% overall coverage was 25%.",
    "recon-selected-declaration-completeness coverage was 100% and overall was 25%.",
    "recon-selected-declaration-completeness coverage was 100%; its overall value was 25%.",
    "recon-selected-declaration-completeness coverage was 100%; the overall metric was 25%.",
    "recon-selected-declaration-completeness coverage was 100% plus overall 25%.",
    "Coverage was 100% recon-selected-declaration-completeness and 25% overall.",
    "Coverage was 100% recon-selected-declaration-completeness plus 25% overall.",
    "Coverage was 99% recon-selected-declaration-completeness 25%.",
    "Coverage was 100% in the recon-selected-declaration-completeness methodology.",
    "Overall coverage is approximately 25%.",
    "Overall coverage came to 25%.",
    "Overall coverage hit 25%.",
    "Coverage climbed to 100%.",
    "Coverage improved from 25% to 100%.",
    "Coverage decreased by 5% to 95%.",
    "Coverage dropped to 95%.",
    "Coverage averaged 95%.",
    "Coverage has improved by 5% to 95%.",
    "Coverage exceeded 90%.",
    "Coverage is above 90%.",
    "Coverage now shows 100%.",
    "coverage_rate=100%.",
    "coverage.percent=100%.",
    "Coverage percent was 100%.",
    "covg_eval=39/39.",
    "coverage_ratio=39/39.",
    "covgEval=39/39.",
    "coveragePct=100%.",
    "Coverage was 100 percent.",
    "Coverage was 100 per cent.",
    "Coverage was 100 pct.",
    "Coverage was one hundred percent.",
    "Coverage was a hundred percent.",
    "Coverage was ninety-nine percent.",
    "Coverage was one hundred per cent.",
    "LCOV result was one hundred percent.",
    "Coverage was .5%.",
    "Coverage was 1e2%.",
    "Coverage accounted for 39/39 ranges.",
    "Coverage was 39 out of 39 ranges.",
    "Coverage was 39 of 39 ranges.",
    "Coverage was 1,000/1,000 lines.",
    "Coverage was thirty-nine out of thirty-nine ranges.",
    "Coverage was 39 over 39 ranges.",
    "Coverage ratio was 39:39.",
    "coverage_ratio=39:39.",
    "Coverage was 99,5%.",
    "Coverage (after normalization) was 100%.",
    "Coverage reached a perfect 100%.",
    "The coverage result after the campaign came in at 100%.",
    "The campaign covered 100% of production code.",
    "Line execution: 100%.",
    "LCOV :: 100%.",
    "covg eval: 39/39.",
    "Coverage → 100%.",
    "100% statement coverage.",
    "100% path coverage.",
    "100% condition coverage.",
    "100% decision coverage.",
    "100% instruction coverage.",
    "100% block coverage.",
    "100% method coverage.",
    "100% class coverage.",
    "100% aggregate coverage.",
    "100% global coverage.",
    "100% total coverage.",
    "## Statement coverage\n\n100%.",
    "## Global coverage\n\n100%.",
    "<h2>Line coverage</h2><p>100%</p>",
    "Unlike recon-selected-declaration-completeness measurements: overall coverage was 25%.",
    "Coverage was **100%**.",
    "Coverage was *100%*.",
    "Coverage was `100%`.",
    "Coverage was <strong>100%</strong>.",
    "Coverage was [100%](https://example.invalid/coverage).",
    "Coverage was 100<!-- rendered -->%.",
    "Coverage was 100\u200b%.",
    "Coverage was 100％.",
    "Coverage was １００%.",
    "Coverage was １００％.",
    "Coverage was 39⁄39 ranges.",
    "Coverage was 39∕39 ranges.",
    "Coverage was 39⧸39 ranges.",
    "Coverage was 39／39 ranges.",
    "Coverage was ١٠٠%.",
    "Coverage was १००%.",
    "Coverage was ১০০%.",
    "Coverage was ١٠٠٫٠٪.",
    "Coverage was 100٪.",
    "Coverage was **39/39** ranges.",
    "Coverage was 100\\%.",
    "Coverage was 39\\/39 ranges.",
    "Coverage was 39&#47;39 ranges.",
    "Coverage was &#49;&#48;&#48;&percnt;.",
    "Coverage was 100&ZeroWidthSpace;%.",
    "Coverage was 100<!--\nrendered\n-->%.",
    "Coverage was\n100%.",
    "Coverage was 100% <script>recon-selected-declaration-completeness</script>.",
    "Coverage was 100% <template>recon-selected-declaration-completeness</template>.",
    "Coverage was 100% <span hidden>recon-selected-declaration-completeness</span>.",
    'Coverage was 100% <span style="display: none">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="opacity: 0">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="opacity: 0%">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="font-size: 0">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="color: transparent">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="color: hsla(0, 0%, 0%, 0)">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="clip-path: inset(100%)">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="position:absolute;left:-9999px">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="display:/**/none">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="transform: scale(0)">recon-selected-declaration-completeness</span>.',
    'Coverage was 100% <span style="clip-path:inset(100%)">production-</span>declaration-completeness.',
    'Coverage was 100% production-<span class="x">declaration</span>-completeness.',
    'Coverage was 100% <span class="hidden-scope">production-declaration-completeness</span>.',
    'Coverage was 100% <span id="hidden-scope">production-declaration-completeness</span>.',
    "<style>span { display:none }</style>\nCoverage was 100% <span>production-declaration-completeness</span>.",
    '<span class="metric">Overall coverage was 100%.</span>',
    'Coverage was 100% production<span style="display:none">-</span>declaration-completeness.',
    'Coverage was 100% prod<span style="display:none">&#117;</span>ction-declaration-completeness.',
    "Coverage was 100% for recon-selected-declaration-completeness and production-declaration-completeness.",
    "Coverage was 100% ![recon-selected-declaration-completeness](https://example.invalid/chart.svg).",
    "![Coverage was 100%.](https://example.invalid/chart.svg)",
    '<img src="https://example.invalid/chart.svg" alt="Coverage was 100%.">',
    '<span aria-label="Coverage was 100%."></span>',
    '<span aria-label="Coverage was 100% for production-&amp;#100;eclaration-completeness"></span>',
    '<input type="button" value="Overall coverage was 100%">',
    '<input type="text" value="Overall coverage was 100%">',
    '<input type="text" placeholder="Overall coverage was 100%">',
    '<input type="number" placeholder="Overall coverage was 100%">',
    '<input type="image" alt="Overall coverage was 100%">',
    '<input type="&#116;ext" value="Overall coverage was 100%">',
    '<input type="unknown" value="Overall coverage was 100%">',
    "Coverage was 10\uFE0F0%.",
    "Covera\u034Fge was 100%.",
    "<h2>Coverage</h2>\n\n100%.",
    "<h2>Coverage overview</h2>\n\n100%.",
    "### Coverage\n\n100%.",
    "## Coverage overview\n\n100%.",
    "| Coverage |\n| --- |\n| 100% |",
    "Coverage:\n\n- 100%.",
    "```text\nCoverage was 100%.\n```",
    "    Coverage was 100%.",
    "<pre>Coverage was 100%.</pre>",
    "All production lines were covered (100%).",
    'Coverage was <a href="https://example.invalid">100%</a>.',
    "Coverage was <small>100%</small>.",
    "Coverage was 100<wbr>%.",
    "Cover&#97;ge was 100%.",
    'Coverage was <strong title="x>y">100%</strong>.',
    'Coverage was 100% <a href="recon-selected-declaration-completeness">details</a>.',
    "The recon-selected-declaration-completeness trend differed from overall coverage at 100%.",
    "In recon-selected-declaration-completeness context overall coverage reached 100%.",
    "The recon-selected-declaration-completeness methodology was discussed because coverage was 100%.",
    "The recon-selected-declaration-completeness trend differed from total coverage at 100%.",
    "recon-selected-declaration-completeness context differs from production coverage at 100%.",
    "<input hidden>\n\nCoverage was 100%."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${mixedScore}\n`);
    const mixed = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(mixed.ok, false, mixedScore);
    const normalizedMixedScore = mixedScore.normalize("NFKC").replace(/[\u2044\u2215\u29f8]/gu, "/");
    assert.ok(
      mixed.diagnostics.some(
        (diagnostic) =>
          diagnostic.code ===
          (/%|٪|&(?:percnt|#0*37|#x0*25);|\bpct\b\.?|\bper[ -]?cent(?:age)?\b/iu.test(normalizedMixedScore)
            ? "UNSCOPED_COVERAGE_PERCENTAGE"
            : "UNSCOPED_COVERAGE_FRACTION")
      ),
      mixedScore
    );
  }

  for (const visiblyScopedScore of [
    'Coverage was 100% <span aria-hidden="true">production-declaration-completeness</span>.',
    "Coverage was 100% <span inert>production-declaration-completeness</span>."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${visiblyScopedScore}\n`);
    const visibleScope = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(visibleScope.ok, false, visiblyScopedScore);
    assert.ok(
      !visibleScope.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
      `${visiblyScopedScore}: ${JSON.stringify(visibleScope.diagnostics)}`
    );
  }

  const denseScopedScores = Array.from({ length: 12_000 }, () => "production-declaration-completeness: 1/1").join("; ");
  for (const denseScoreBlock of [denseScopedScores, `<span class="metric">${denseScopedScores}</span>`]) {
    const denseBindingStartedAt = process.cpuUsage();
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${denseScoreBlock}\n`);
    const denseBinding = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    const denseBindingUsage = process.cpuUsage(denseBindingStartedAt);
    const denseBindingElapsedMs = (denseBindingUsage.user + denseBindingUsage.system) / 1_000;
    assert.equal(denseBinding.ok, false);
    assert.ok(denseBindingElapsedMs < 5_000, `dense scope binding took ${denseBindingElapsedMs}ms`);
    assert.equal(
      denseBinding.diagnostics.filter((diagnostic) => diagnostic.code === "COVERAGE_SCORE_SCAN_LIMIT_EXCEEDED").length,
      1,
      JSON.stringify(denseBinding.diagnostics)
    );
    assert.ok(denseBinding.diagnostics.length < 10, JSON.stringify(denseBinding.diagnostics));
    assert.ok(
      !denseBinding.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
      JSON.stringify(denseBinding.diagnostics)
    );
  }

  for (const nonRenderedScore of [
    "<!--\nCoverage was 100%.\n-->",
    '<div title="Coverage was 100%">No score is published.</div>',
    '<a title="Coverage was 100%">Coverage details</a>',
    "[details]: https://example.invalid/?coverage=100%",
    "<template>Coverage was 100%.</template>",
    "<span hidden>Coverage was 100%.</span>",
    '<span style="visibility: hidden">Coverage was 100%.</span>',
    '<span style="opacity: 0">Coverage was 100%.</span>',
    '<span style="opacity: 0%">Coverage was 100%.</span>',
    '<span style="font-size: 0">Coverage was 100%.</span>',
    '<span style="color: transparent">Coverage was 100%.</span>',
    '<span style="display:inline;display:none">Overall coverage was 100%.</span>',
    '<span style="display:none!important;display:inline">Overall coverage was 100%.</span>',
    '<img hidden alt="Coverage was 100%.">',
    '<span aria-hidden="true" aria-label="Coverage was 100%."></span>',
    "<span title='fake aria-label=\"Coverage was 100%.\"'>No score is published.</span>",
    '<script>if (a < b) { const score = "Coverage was 100%."; }</script>',
    "<script>if (a < b) x()</scripted>Coverage was 100%.</script>",
    "<template>\n\nCoverage was 100%.\n\n</template>",
    "Coverage was 100&amp;#37;."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${nonRenderedScore}\n`);
    const hidden = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(hidden.ok, true, `${nonRenderedScore}: ${JSON.stringify(hidden.diagnostics)}`);
  }

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nCoverage was 100% <a href="details">production-declaration-completeness</a>.\n`
  );
  const linkedVisibleScope = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(linkedVisibleScope.ok, false);
  assert.ok(
    linkedVisibleScope.diagnostics.some(
      (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    ),
    JSON.stringify(linkedVisibleScope.diagnostics)
  );
  assert.ok(
    !linkedVisibleScope.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
    JSON.stringify(linkedVisibleScope.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nCoverage was 100%\nfor production-declaration-completeness.\n`
  );
  const wrappedVisibleScope = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(wrappedVisibleScope.ok, false);
  assert.ok(
    wrappedVisibleScope.diagnostics.some(
      (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    ),
    JSON.stringify(wrappedVisibleScope.diagnostics)
  );
  assert.ok(
    !wrappedVisibleScope.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
    JSON.stringify(wrappedVisibleScope.diagnostics)
  );

  for (const crossRenderedLineScope of [
    "Coverage was 100%  \nfor production-declaration-completeness.",
    "Coverage was 100%<br>for production-declaration-completeness.",
    "<div>Coverage was 100%.</div><div>production-declaration-completeness.</div>",
    "```text\nCoverage was 100%.\nproduction-declaration-completeness.\n```",
    "<pre>Coverage was 100%.\nproduction-declaration-completeness.</pre>"
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${crossRenderedLineScope}\n`);
    const crossLine = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(crossLine.ok, false, crossRenderedLineScope);
    assert.ok(
      crossLine.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
      `${crossRenderedLineScope}: ${JSON.stringify(crossLine.diagnostics)}`
    );
  }

  for (const implicitlyVisibleScore of [
    "<p hidden>\n\nCoverage was 100%.",
    "<h1 hidden>\n\nCoverage was 100%.",
    "<p hidden>hidden<p>Coverage was 100%.</p>",
    "<p hidden>hidden<div>Coverage was 100%.</div>",
    "<h1 hidden>hidden<h2>Coverage was 100%.</h2>",
    '<span style="display:none;display:inline">Overall coverage was 100%.</span>',
    '<span style="display:none!important;display:inline!important">Overall coverage was 100%.</span>',
    "<span style=\"--x:'foo;display:none;bar'\">Overall coverage was 100%.</span>",
    '<span style="display:inline;/*;display:none;*/">Overall coverage was 100%.</span>',
    '<span style="--x:foo\\;display:none">Overall coverage was 100%.</span>',
    '<span aria-hidden="true">Coverage was 100%.</span>',
    "<span inert>Coverage was 100%.</span>",
    '<span title="foo hidden bar">Coverage was 100%.</span>',
    "<span title=\"fake style='display:none'\">Coverage was 100%.</span>",
    "<span data-note='aria-label=\"production-declaration-completeness\"'>Coverage was 100%.</span>",
    "<script>if (a < b) x()</script>Coverage was 100%.",
    "<script>hidden</script data-end=x>Overall coverage was 100%.",
    '<script>hidden</script data-end=">">Overall coverage was 100%.',
    "<style>hidden</style data-end=x>Overall coverage was 100%.",
    "<textarea>hidden</textarea data-end=x>Overall coverage was 100%.",
    "<xmp>hidden</xmp data-end=x>Overall coverage was 100%.",
    "<style>.x { width: calc(1 < 2); }</style>Coverage was 100%.",
    "<noscript>Coverage was 100%.</noscript>",
    "<textarea>Coverage was 100%.</textarea>",
    "<xmp>Coverage was 100%.</xmp>"
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${implicitlyVisibleScore}\n`);
    const visibleAfterImplicitClose = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(visibleAfterImplicitClose.ok, false, implicitlyVisibleScore);
    assert.ok(
      visibleAfterImplicitClose.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
      `${implicitlyVisibleScore}: ${JSON.stringify(visibleAfterImplicitClose.diagnostics)}`
    );
  }

  for (const paragraphClosingTag of [
    "center",
    "details",
    "dialog",
    "dir",
    "figcaption",
    "figure",
    "summary",
    "li",
    "dt",
    "dd"
  ]) {
    const openAttribute = paragraphClosingTag === "details" || paragraphClosingTag === "dialog" ? " open" : "";
    const implicitlyVisibleScore = `<p hidden>x<${paragraphClosingTag}${openAttribute}>Overall coverage was 100%.</${paragraphClosingTag}>`;
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${implicitlyVisibleScore}\n`);
    const visibleAfterParagraphClose = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(visibleAfterParagraphClose.ok, false, implicitlyVisibleScore);
    assert.ok(
      visibleAfterParagraphClose.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
      `${implicitlyVisibleScore}: ${JSON.stringify(visibleAfterParagraphClose.diagnostics)}`
    );
  }

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\n<div hidden>\n\nCoverage was 100%.\n\n</div>\n`
  );
  const hiddenFlowContainer = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(hiddenFlowContainer.ok, true, JSON.stringify(hiddenFlowContainer.diagnostics));

  const nestedHtml = `${"<span>".repeat(4_000)}Coverage was 100%.${"</span>".repeat(4_000)}`;
  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${nestedHtml}\n`);
  const deeplyNestedHtml = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(deeplyNestedHtml.ok, false);
  assert.ok(
    deeplyNestedHtml.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
    JSON.stringify(deeplyNestedHtml.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nAt 100% utilization, insurance coverage is exhausted.\n`
  );
  const insuranceProse = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(insuranceProse.ok, true, JSON.stringify(insuranceProse.diagnostics));

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nAt 100% utilization insurance coverage is exhausted.\n`
  );
  const insuranceProseWithoutComma = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(insuranceProseWithoutComma.ok, true, JSON.stringify(insuranceProseWithoutComma.diagnostics));

  for (const extraScopedPercentage of [
    "recon-selected-declaration-completeness coverage was 100%, while the insurance payout was 25%.",
    "recon-selected-declaration-completeness coverage was 100% and interest was 25%."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${extraScopedPercentage}\n`);
    const extraScopedProse = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(extraScopedProse.ok, false, extraScopedPercentage);
    assert.ok(
      extraScopedProse.diagnostics.some(
        (diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
      ),
      `${extraScopedPercentage}: ${JSON.stringify(extraScopedProse.diagnostics)}`
    );
    assert.ok(
      !extraScopedProse.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
      `${extraScopedPercentage}: ${JSON.stringify(extraScopedProse.diagnostics)}`
    );
  }

  for (const unrelatedPercentage of [
    "The insurance policy coverage was 25%.",
    "Coverage for the insurance policy was 25%.",
    "Coverage for the warranty was 25%.",
    "Coverage was 25% under the insurance policy.",
    "The insurance policy coverage was twenty-five percent.",
    "The flood insurance's coverage was 25%.",
    "The warranty coverage was 25% of the repair cost."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${unrelatedPercentage}\n`);
    const unrelatedProse = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(unrelatedProse.ok, true, `${unrelatedPercentage}: ${JSON.stringify(unrelatedProse.diagnostics)}`);
  }

  for (const numericArtifactPath of [
    "Coverage artifacts are stored in logs/2026/08/result.json.",
    "The LCOV path is reports/2026/08/coverage.lcov."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${numericArtifactPath}\n`);
    const numericPath = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(numericPath.ok, true, `${numericArtifactPath}: ${JSON.stringify(numericPath.diagnostics)}`);
  }

  for (const coverageTimestamp of [
    "Coverage report generated at 10:30.",
    "Coverage score generated at 10:30 UTC.",
    "Coverage ran for 1:30 before stopping.",
    "Coverage report generated at 10:30:45 UTC.",
    "LCOV generated at 10:30."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n${coverageTimestamp}\n`);
    const timestamp = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(timestamp.ok, true, `${coverageTimestamp}: ${JSON.stringify(timestamp.diagnostics)}`);
  }

  for (const coverageSectionProse of [
    "Retry 1/2 after the transient failure.",
    "At 25% utilization, insurance coverage is exhausted.",
    "The campaign used 25% of its time budget."
  ]) {
    writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Coverage\n\n${coverageSectionProse}\n`);
    const unrelatedSectionProse = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(
      unrelatedSectionProse.ok,
      true,
      `${coverageSectionProse}: ${JSON.stringify(unrelatedSectionProse.diagnostics)}`
    );
  }

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nThe recon-selected-declaration-completeness was 1/1.\n`
  );
  const misplaced = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(misplaced.ok, false);
  assert.ok(
    misplaced.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING")
  );
  assert.ok(
    !misplaced.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
    JSON.stringify(misplaced.diagnostics)
  );

  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\nStandardized score: 100%.\n`);
  const disguisedPercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(disguisedPercentage.ok, false);
  assert.ok(disguisedPercentage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"));

  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\nOverall coverage reached 99.5%.\n`);
  const decimalPercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(decimalPercentage.ok, false);
  assert.ok(decimalPercentage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"));

  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\n100&#37; standardized coverage.\n`);
  const encodedPercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(encodedPercentage.ok, false);
  assert.ok(encodedPercentage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"));

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    `${scopedMarkdown}\n## Notes\n\nStandardized coverage was 100&percnt;.\n`
  );
  const namedEntityPercentage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(namedEntityPercentage.ok, false);
  assert.ok(namedEntityPercentage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"));

  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n## Notes\n\nStandardized coverage: 39/39.\n`);
  const disguisedFraction = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(disguisedFraction.ok, false);
  assert.ok(disguisedFraction.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_FRACTION"));

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    "# Ultrafuzz report\n\n## Notes\n\n- recon-selected-declaration-completeness: `1/1`\n- production-declaration-completeness: `1/1`\n"
  );
  const wrongSection = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(wrongSection.ok, false);
  assert.ok(
    wrongSection.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING")
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.md",
    scopedMarkdown.replace(
      "- production-declaration-completeness: `1/1`",
      "- production-declaration-completeness: `1/1`\n- production-declaration-completeness: `0/1`"
    )
  );
  const contradictory = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(contradictory.ok, false);
  assert.ok(
    contradictory.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING")
  );

  writeArtifact(layout, reportNode.id, "report.md", `${scopedMarkdown}\n${scopedMarkdown}`);
  const duplicateSection = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(duplicateSection.ok, false);
  assert.ok(
    duplicateSection.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING")
  );

  writeArtifact(layout, reportNode.id, "report.md", scopedMarkdown);
  const coverageProseIssue = {
    ...currentFinding("M-01", {
      title: "[M-01] - Property failure",
      dedupe_key: "root-coverage-prose",
      triage_classification: "true-positive",
      notes: ["triage_reason=public path is reachable", "Standardized coverage was 100%."],
      severity: "Medium",
      impact: "High",
      likelihood: "Low",
      impact_rationale: "The reachable path can lock assets.",
      likelihood_rationale: "The path requires narrow timing.",
      severity_rationale: "High impact x Low likelihood maps to Medium."
    }),
    description: "The public path can lock user assets.",
    proof_of_concept: {
      scenario: ["Call the public path in the affected state."],
      language: "solidity",
      code: "assertTrue(locked);"
    },
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant-coverage", detections: 1, configured_loops: 1 }]
    },
    lifecycle: {
      dedupe_key: "root-coverage-prose",
      source_artifacts: [],
      strategy_hits: [{ strategy: "stateful-invariant-coverage", attempt_index: 0 }],
      triage_classification: "true-positive",
      triage_reason: "public path is reachable",
      canonical_severity: "Medium",
      final_disposition: "promoted",
      stages: [
        {
          stage: "severity-classified",
          artifact_path: "severity-classified-findings.json",
          finding_id: "finding-coverage-prose"
        }
      ]
    }
  };
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [coverageProseIssue] }))
  );
  const proseInTypedReport = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(proseInTypedReport.ok, false);
  assert.ok(
    proseInTypedReport.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
    JSON.stringify(proseInTypedReport.diagnostics)
  );

  for (const noteSequence of [["Coverage:\n\n100%."], ["Coverage overview:\n\n100%."], ["Coverage:", "100%."]]) {
    const jsonBypassIssue = {
      ...structuredClone(coverageProseIssue),
      notes: ["triage_reason=public path is reachable", ...noteSequence]
    };
    writeArtifact(
      layout,
      reportNode.id,
      "report.json",
      JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [jsonBypassIssue] }))
    );
    const jsonBypass = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    assert.equal(jsonBypass.ok, false, JSON.stringify(noteSequence));
    assert.ok(
      jsonBypass.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
      `${JSON.stringify(noteSequence)}: ${JSON.stringify(jsonBypass.diagnostics)}`
    );
  }

  const persistentCoverageLabelIssue = {
    ...structuredClone(coverageProseIssue),
    notes: ["triage_reason=public path is reachable", "Coverage:", "100%.", "95%."]
  };
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [persistentCoverageLabelIssue] }))
  );
  const persistentCoverageLabel = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  const persistentPercentageDiagnostics = persistentCoverageLabel.diagnostics.filter(
    (diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"
  );
  assert.equal(persistentPercentageDiagnostics.length, 2, JSON.stringify(persistentCoverageLabel.diagnostics));
  assert.ok(
    persistentPercentageDiagnostics.some((diagnostic) => diagnostic.path?.endsWith("#$.issues[0].notes[2]:1")),
    JSON.stringify(persistentPercentageDiagnostics)
  );
  assert.ok(
    persistentPercentageDiagnostics.some((diagnostic) => diagnostic.path?.endsWith("#$.issues[0].notes[3]:1")),
    JSON.stringify(persistentPercentageDiagnostics)
  );

  for (const boundedCoverageNotes of [
    ["Coverage:", "100%.", "## Timing", "95%."],
    ["Coverage:", "100%.", "Timing:", "95%."]
  ]) {
    const boundedCoverageIssue = {
      ...structuredClone(coverageProseIssue),
      notes: ["triage_reason=public path is reachable", ...boundedCoverageNotes]
    };
    writeArtifact(
      layout,
      reportNode.id,
      "report.json",
      JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [boundedCoverageIssue] }))
    );
    const boundedCoverage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
    const boundedPercentageDiagnostics = boundedCoverage.diagnostics.filter(
      (diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"
    );
    assert.equal(boundedPercentageDiagnostics.length, 1, JSON.stringify(boundedCoverage.diagnostics));
    assert.ok(
      boundedPercentageDiagnostics[0]?.path?.endsWith("#$.issues[0].notes[2]:1"),
      JSON.stringify(boundedPercentageDiagnostics)
    );
  }

  const headingBoundaryIssue = {
    ...structuredClone(coverageProseIssue),
    notes: ["triage_reason=public path is reachable", "Coverage:", "## Notes\n\n25% time used."]
  };
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [headingBoundaryIssue] }))
  );
  const headingBoundary = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.ok(
    !headingBoundary.diagnostics.some((diagnostic) => diagnostic.code.startsWith("UNSCOPED_")),
    JSON.stringify(headingBoundary.diagnostics)
  );

  const strategyRateIssue = {
    ...structuredClone(coverageProseIssue),
    notes: ["triage_reason=public path is reachable", "stateful-invariant-coverage detection rate was 1/1."]
  };
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [strategyRateIssue] }))
  );
  const strategyRate = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(strategyRate.ok, true, JSON.stringify(strategyRate.diagnostics));

  const evaluatorFractionIssue = {
    ...structuredClone(coverageProseIssue),
    notes: ["triage_reason=public path is reachable", "covg_eval=39/39."]
  };
  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(currentReport(layout.runId, { coverage_evidence: evidence, issues: [evaluatorFractionIssue] }))
  );
  const evaluatorFraction = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(evaluatorFraction.ok, false);
  assert.ok(
    evaluatorFraction.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_FRACTION"),
    JSON.stringify(evaluatorFraction.diagnostics)
  );

  const nestedCoverageReport = currentReport(layout.runId, { coverage_evidence: evidence }) as Record<string, unknown>;
  nestedCoverageReport.coverage = { score: "100%" };
  writeArtifact(layout, reportNode.id, "report.json", JSON.stringify(nestedCoverageReport));
  const nestedCoverage = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.ok(
    nestedCoverage.diagnostics.some((diagnostic) => diagnostic.code === "UNSCOPED_COVERAGE_PERCENTAGE"),
    JSON.stringify(nestedCoverage.diagnostics)
  );

  writeArtifact(
    layout,
    reportNode.id,
    "report.json",
    JSON.stringify(
      currentReport(layout.runId, {
        coverage_evidence: {
          ...evidence,
          views: [
            { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 1 },
            { scope: "production-declaration-completeness", covered_ranges: 0, total_ranges: 1 }
          ]
        }
      })
    )
  );
  const mismatch = verifyRequiredArtifactsForAttempt(layout, reportNode, reportNode.id);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some((diagnostic) => diagnostic.code === "REPORT_COVERAGE_EVIDENCE_MISMATCH"));
});
