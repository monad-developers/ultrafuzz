import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  VALIDATOR_BUILD_IDENTITY,
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  layoutForRunRoot,
  writeArtifactManifest,
  type ExecutionNodeProvenance,
  type RunState
} from "@ultrafuzz/artifacts";

import { initProject, materializeDynamicRuntime, readLinkedWorkflowEvidence, startRun, syncRun } from "../src/index.js";
import { effectiveRouteEnvironment } from "../src/data-governance.js";
import {
  refreshedSmithersControllerSnapshot,
  type CompiledSmithersDynamicGroup,
  type CompiledSmithersTask
} from "../src/smithers.js";
import { bindSmithersExecutableCapability } from "../src/smithers-executable-capability.js";
import {
  commitControllerGeneration,
  prepareControllerGeneration,
  verifyCommittedControllerGenerationAuthority
} from "../src/workflow-controller-generation.js";
import {
  materializeWorkflowExecutionSnapshot,
  verifySealedTaskManifestSnapshot,
  verifyWorkflowControlSnapshot
} from "../src/workflow-integrity.js";

const TEST_DATA_GOVERNANCE_POLICY = JSON.stringify({
  schema_version: "ultrafuzz.data-governance-policy.v1",
  sensitivity: "public",
  source_destinations: ["model:anthropic", "model:openai"],
  artifact_destinations: [],
  destination_policies: ["model:anthropic", "model:openai"].map((destination) => ({
    destination,
    processor: "test",
    region: "local",
    retention_policy: "test",
    training_policy: "none",
    dpa_status: "n/a",
    minimization_policy: "synthetic",
    data_handling_basis: "public"
  })),
  openrouter_model_allowlist: []
});

interface LifecycleStep {
  id: string;
  state: string;
  attempt?: number;
}

interface LifecycleEvent {
  type: string;
  nodeId?: string;
  attempt?: number;
  error?: unknown;
  extra?: Record<string, unknown>;
}

interface DynamicFixture {
  project: string;
  runId: string;
  runRoot: string;
  workflowRunId: string;
  env: Record<string, string | undefined>;
  inspectPath: string;
  eventsPath: string;
  plannerTask: CompiledSmithersTask;
  generatedTasks: CompiledSmithersTask[];
  joinTask: CompiledSmithersTask;
  generatedNodeId?: string;
  storageId?: string;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-dynamic-lifecycle-"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writePrompt(project: string, relativePath: string, id: string, body: string): void {
  const promptPath = path.join(project, ".ultrafuzz", "prompts", relativePath);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, `---\nid: ${id}\ndisplay_name: ${id}\n---\n\n${body}\n`, "utf8");
}

function writeDynamicProject(project: string, modelFanout: boolean, emptyGroup = false): void {
  initProject({ projectRoot: project, force: true });
  writePrompt(project, "dynamic/planner.md", "dynamic-planner", "Write the plan to {{artifact_path}}/plan.json.");
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    "Your /goal is {{item.goal_prompt}} using threat model threat {{liquidation:overdue}}.\n{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}"
  );
  writePrompt(project, "dynamic/join.md", "dynamic-join", "Summarize completed work in {{artifact_path}}/report.md.");
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: planner
    kind: agentic
    prompt: dynamic/planner.md
    depends_on: [__start__]
    outputs:
      - path: plan.json
        contract: ultrafuzz/goal-plan@1
        primary: true
  - id: fanout
    kind: agentic
    prompt: dynamic/worker.md
    depends_on: [planner]
${modelFanout ? "    model_profiles: [default, claude]\n" : ""}    dynamic:
      from:
        node: planner
        path: ${emptyGroup ? "$.class_goals" : "$.threat_goals"}
      key: id
      node_id: "dynamic:threat:{{ item.id }}"
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@2
        primary: true
  - id: strict-join
    kind: agentic
    prompt: dynamic/join.md
    depends_on: [fanout]
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [strict-join]
`,
    "utf8"
  );
}

function lifecycleEnvironment(project: string): {
  env: Record<string, string | undefined>;
  inspectPath: string;
  eventsPath: string;
} {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-dynamic-lifecycle-runner-"));
  const inspectPath = path.join(project, "workflow-inspect.json");
  const eventsPath = path.join(project, "workflow-events.ndjson");
  const smithers = path.join(binDir, "smithers");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(inspectPath, "{}\n", "utf8");
  fs.writeFileSync(eventsPath, "", "utf8");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  inspect)",
      `    cat ${shellQuote(inspectPath)}`,
      "    ;;",
      "  events)",
      `    cat ${shellQuote(eventsPath)}`,
      "    ;;",
      "  node)",
      "    node_id=$2",
      "    attempt_id=${node_id#node:}",
      "    profile_id=default",
      "    model_name=gpt-5.5",
      '    case "$attempt_id" in',
      "      *__model_1__*) profile_id=claude; model_name=claude-opus-4-8 ;;",
      "    esac",
      "    agent_id=ultrafuzz-agent:${attempt_id}:0:${profile_id}",
      '    printf \'{"ok":true,"data":{"node":{"nodeId":"%s"},"attempts":[{"nodeId":"%s","attempt":1,"state":"finished","meta":{"agentChainIndex":0,"agentId":"%s","agentModel":"%s"}},{"nodeId":"%s","attempt":2,"state":"finished","meta":{"agentChainIndex":0,"agentId":"%s","agentModel":"%s"}}]}}\\n\' "$node_id" "$node_id" "$agent_id" "$model_name" "$node_id" "$agent_id" "$model_name"',
      "    ;;",
      "  up)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "  cancel)",
      "    printf '%s\\n' '{\"status\":\"cancel-requested\"}'",
      "    exit 2",
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const ambientRouteEnvironment = Object.fromEntries(
    ["ClaudeAgent", "CodexAgent"]
      .flatMap((agent) => effectiveRouteEnvironment(agent, process.env).map(([name]) => name))
      .map((name) => [name, undefined])
  );
  return {
    env: bindSmithersExecutableCapability(
      {
        ...ambientRouteEnvironment,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SMITHERS_BIN: smithers,
        ULTRAFUZZ_DATA_GOVERNANCE_POLICY: TEST_DATA_GOVERNANCE_POLICY,
        ULTRAFUZZ_PROVIDER_HOME_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "ufz-dynamic-provider-homes-")),
        ULTRAFUZZ_PRICING_CATALOG_URL: "off"
      },
      smithers,
      project
    ),
    inspectPath,
    eventsPath
  };
}

function fakeUltrafuzzCliEntrypoint(project: string): string {
  const packageRoot = path.join(project, ".fake-ultrafuzz-cli");
  const entrypoint = path.join(packageRoot, "dist", "index.mjs");
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  assert.ok(findings);
  const preflightResponse = {
    schema_version: "ultrafuzz.cli.result.v2",
    command: "json validate",
    ok: true,
    diagnostics: [],
    data: {
      status: "valid",
      diagnostics: [],
      schema: {
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY,
        registered: true
      },
      artifact_sha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
      truncated: false
    }
  };
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "fake-ultrafuzz-cli", version: "1.0.0", type: "module" })}\n`,
    "utf8"
  );
  fs.writeFileSync(entrypoint, `process.stdout.write(${JSON.stringify(JSON.stringify(preflightResponse))});\n`, "utf8");
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

async function createDynamicFixture(input: {
  runId: string;
  goals?: Array<Record<string, unknown>>;
  modelFanout?: boolean;
}): Promise<DynamicFixture> {
  const project = tempProject();
  const emptyGroup = input.goals !== undefined && input.goals.length === 0;
  writeDynamicProject(project, input.modelFanout ?? false, emptyGroup);
  const lifecycle = lifecycleEnvironment(project);
  const started = await startRun({
    projectRoot: project,
    runId: input.runId,
    maxConcurrency: 2,
    env: lifecycle.env,
    ultrafuzzCliEntrypoint: fakeUltrafuzzCliEntrypoint(project)
  });
  assert.equal(started.ok, true, JSON.stringify(started.diagnostics));
  const runRoot = started.value!.run_root;
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  const graphPath = path.join(runRoot, "graph.json");
  const taskDocument = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as {
    smithers_run_id: string;
    tasks: CompiledSmithersTask[];
    dynamic_groups: CompiledSmithersDynamicGroup[];
  };
  const canonicalGoal = {
    kind: "threat",
    id: "liquidation:overdue",
    node_id: "dynamic:threat:liquidation:overdue",
    title: "Inspect overdue liquidation",
    threat_ids: ["liquidation:overdue"],
    class_ids: [],
    attack_surface_ids: ["liquidation:overdue"],
    goal_prompt: "find any vulnerability affecting {{liquidation:overdue}}",
    replacements: { "liquidation:overdue": "the persisted liquidation threat model" },
    selection_rationale: "Every modeled threat receives one focused goal."
  };
  const goals = input.goals ?? [canonicalGoal];
  // The goal-plan contract requires at least one modeled threat. For the empty-group case the
  // dynamic source is the valid-but-empty class_goals lane while the canonical threat remains in
  // the authenticated plan outside that source.
  const plannedThreatGoals = emptyGroup ? [canonicalGoal] : goals;
  const plannerArtifactDir = path.join(runRoot, "artifacts", "planner");
  fs.mkdirSync(plannerArtifactDir, { recursive: true });
  const threatIds = plannedThreatGoals.map((goal) => String(goal.id));
  const planDocument = {
    schema_version: "ultrafuzz.goal-plan.v1",
    policy: "additive-v1",
    threat_model_sha256: "a".repeat(64),
    vulnerability_database: {
      planner_catalog_schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1",
      snapshot_manifest_schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
      database_schema_version: 1,
      aggregate_sha256: "a".repeat(64),
      catalog_sha256: "a".repeat(64)
    },
    catalog_class_ids: [],
    modeled_threat_ids: threatIds,
    threat_goals: plannedThreatGoals,
    class_goals: [],
    applicability_decisions: [],
    selected_class_records: [],
    roaming_goal: {
      node_id: "goal-roaming",
      prompt_path: "strategies/roaming-goal.md",
      purpose: "Challenge taxonomy and threat-model completeness."
    },
    counts: {
      threats: plannedThreatGoals.length,
      applicable_classes: 0,
      inapplicable_classes: 0,
      dynamic_goals: plannedThreatGoals.length,
      total_goals: plannedThreatGoals.length + 1
    },
    expected_child_count: plannedThreatGoals.length,
    threat_count: plannedThreatGoals.length,
    applicable_class_count: 0,
    max_dynamic_nodes: 100,
    goal_lanes: [
      ...plannedThreatGoals.map((goal) => ({
        kind: "threat",
        lane_id: String(goal.id),
        node_ids: [String(goal.node_id)]
      })),
      { kind: "roaming", lane_id: "goal-roaming", node_ids: ["goal-roaming"] }
    ]
  };
  fs.writeFileSync(path.join(plannerArtifactDir, "plan.json"), `${JSON.stringify(planDocument, null, 2)}\n`, "utf8");
  const materialized = materializeDynamicRuntime({
    runId: input.runId,
    projectRoot: project,
    runRoot,
    graphPath,
    tasksPath,
    baseTasks: taskDocument.tasks,
    groups: taskDocument.dynamic_groups,
    readyGroupIds: ["fanout"]
  });
  const plannerTask = materialized.tasks.find((task) => task.concreteNodeId === "planner");
  const joinTask = materialized.tasks.find((task) => task.concreteNodeId === "strict-join");
  const generatedTasks = materialized.tasks.filter((task) => task.metadata.node.dynamic?.groupNodeId === "fanout");
  assert.ok(plannerTask);
  assert.ok(joinTask);
  assert.equal(generatedTasks.length, goals.length * (input.modelFanout ? 2 : 1));
  const generatedNode = materialized.graph.nodes.find((node) => node.dynamic_generated !== undefined);
  if (goals.length > 0) {
    assert.ok(generatedNode);
  }
  writeVerifiedArtifactAuthorities(runRoot, plannerTask);
  return {
    project,
    runId: input.runId,
    runRoot,
    workflowRunId: taskDocument.smithers_run_id,
    env: lifecycle.env,
    inspectPath: lifecycle.inspectPath,
    eventsPath: lifecycle.eventsPath,
    plannerTask,
    generatedTasks,
    joinTask,
    generatedNodeId: generatedNode?.id,
    storageId: generatedNode?.dynamic_generated?.storage_id
  };
}

function setLifecycle(fixture: DynamicFixture, steps: LifecycleStep[], events: LifecycleEvent[]): void {
  fs.writeFileSync(
    fixture.inspectPath,
    `${JSON.stringify(workflowInspect(fixture.workflowRunId, steps), null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(fixture.eventsPath, workflowEvents(fixture.workflowRunId, events), "utf8");
}

function workflowInspect(workflowRunId: string, inputSteps: LifecycleStep[]): unknown {
  const explicit = new Set(inputSteps.map((step) => step.id));
  const steps = inputSteps.flatMap((step) => {
    if (!step.id.startsWith("node:") || !isSucceededWorkflowState(step.state)) return [step];
    const verifierId = `verify:${step.id.slice("node:".length)}`;
    return explicit.has(verifierId) ? [step] : [step, { id: verifierId, state: "finished", attempt: step.attempt }];
  });
  return {
    ok: true,
    data: {
      run: {
        id: workflowRunId,
        workflow: workflowRunId,
        status: "running",
        started: "2026-08-04T00:00:00.000Z",
        elapsed: "3s"
      },
      runState: {
        runId: workflowRunId,
        computedAt: "2026-08-04T00:00:03.000Z",
        state: "running"
      },
      steps,
      nodes: steps.map((step) => ({
        nodeId: step.id,
        state: step.state,
        attempt: step.attempt ?? 1,
        label: step.id
      }))
    },
    meta: { command: "inspect", duration: "1ms" }
  };
}

function workflowEvents(workflowRunId: string, events: LifecycleEvent[]): string {
  const base = Date.parse("2026-08-04T00:00:00.000Z");
  return `${events
    .map((event, index) => {
      const timestampMs = base + index * 100;
      const payload: Record<string, unknown> = { type: event.type, runId: workflowRunId, timestampMs };
      if (event.nodeId !== undefined) {
        payload.nodeId = event.nodeId;
        payload.iteration = 0;
      }
      if (event.attempt !== undefined) payload.attempt = event.attempt;
      if (event.error !== undefined) payload.error = event.error;
      if (event.type === "TaskHeartbeatTimeout") {
        payload.lastHeartbeatAtMs = timestampMs - 1_000;
        payload.timeoutMs = 1_000;
      }
      if (event.extra !== undefined) Object.assign(payload, event.extra);
      return JSON.stringify({
        runId: workflowRunId,
        seq: index,
        timestampMs,
        type: event.type,
        payload
      });
    })
    .join("\n")}\n`;
}

function isSucceededWorkflowState(state: string): boolean {
  return ["finished", "succeeded", "success", "complete", "completed"].includes(state.toLowerCase());
}

function plannerSuccessEvidence(fixture: DynamicFixture): { steps: LifecycleStep[]; events: LifecycleEvent[] } {
  return {
    steps: [{ id: fixture.plannerTask.smithersNodeId, state: "finished", attempt: 1 }],
    events: [
      { type: "NodeStarted", nodeId: fixture.plannerTask.smithersNodeId, attempt: 1 },
      { type: "NodeFinished", nodeId: fixture.plannerTask.smithersNodeId, attempt: 1 }
    ]
  };
}

function writeFinding(task: CompiledSmithersTask): void {
  fs.mkdirSync(task.artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(task.artifactDir, "findings.json"),
    `${JSON.stringify(
      [
        {
          schema_version: "ultrafuzz.finding.v2",
          id: "overdue-liquidation",
          title: "Fixed-term liquidation can occur before overdue",
          status: "candidate",
          severity_guess: "High",
          confidence: "high",
          summary: "A boundary check permits liquidation before the debt is overdue.",
          producer_node_id: task.concreteNodeId,
          producer_attempt_id: task.attemptId,
          source_node_id: task.concreteNodeId,
          source_nodes: [task.concreteNodeId]
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
  writeVerifiedArtifactAuthorities(path.resolve(task.artifactDir, "..", ".."), task);
}

function writeVerifiedArtifactAuthorities(runRoot: string, task: CompiledSmithersTask): void {
  const outputs = task.metadata.artifacts.outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contract_digest: output.contractDigest,
    ...(output.schemaFile === undefined
      ? {}
      : {
          schema_file: output.schemaFile,
          schema_id: output.schemaId,
          schema_sha256: output.schemaSha256,
          schema_bundle_sha256: output.schemaBundleSha256,
          validator_build: output.validatorBuild
        }),
    primary: output.primary
  }));
  const snapshots = outputs.map((output) => {
    const bytes = fs.readFileSync(path.join(task.artifactDir, output.path));
    return { output, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  });
  writeArtifactManifest({
    layout: layoutForRunRoot(runRoot),
    nodeId: task.attemptId,
    include: outputs.map((output) => output.path),
    outputs,
    prerequisiteNodeIds: task.dependencies,
    provenance: {
      producer_node_id: task.concreteNodeId,
      logical_node_id: task.logicalNodeId,
      attempt_index: task.metadata.loop.attemptIndex,
      loop_index: task.metadata.loop.index,
      model_index: task.metadata.model?.modelIndex ?? 0,
      agent_ref: task.agentRef,
      workflow_run_id: task.metadata.run.smithersWorkflowName,
      workflow_task_id: task.smithersNodeId,
      origin: "workflow",
      metadata: { concrete_node_id: task.concreteNodeId }
    }
  });
  const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markerRoot, { recursive: true });
  fs.writeFileSync(
    path.join(markerRoot, `${task.attemptId}.json`),
    `${JSON.stringify(
      {
        schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
        attempt_id: task.attemptId,
        node_id: task.logicalNodeId,
        admitted_dependency_attempt_ids: task.dependencies,
        artifacts: snapshots.map(({ output, sha256 }) => ({ ...output, sha256 })),
        publications: snapshots.map(({ output, sha256 }) => ({ path: output.path, sha256 }))
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function readState(fixture: DynamicFixture): RunState {
  return JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "state.json"), "utf8")) as RunState;
}

function readUsageLedger(fixture: DynamicFixture): Array<{ node_id?: string; attempt?: number }> {
  const ledgerPath = path.join(fixture.runRoot, "usage.jsonl");
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as { node_id?: string; attempt?: number });
}

function readLedger(fixture: DynamicFixture): Array<Record<string, unknown>> {
  const ledgerPath = path.join(fixture.runRoot, "attempts.jsonl");
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("runtime-materialized dynamic producer prompts retain validator commands", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-validator-commands", modelFanout: true });
  assert.ok(fixture.generatedTasks.length > 1);
  for (const task of fixture.generatedTasks) {
    assert.ok(task.renderedPromptPath);
    const rendered = fs.readFileSync(task.renderedPromptPath, "utf8");
    const schemaPath = path.join(task.workspacePath, ".ultrafuzz", "schemas", "findings.schema.json");
    const artifactPath = path.join(task.artifactDir, "findings.json");
    assert.equal(rendered.split("\n").filter((line) => line.startsWith("  Validate against: ")).length, 1);
    assert.equal(
      rendered.split("\n").filter((line) => line.startsWith("  Validation command: `ultrafuzz json validate --schema "))
        .length,
      1
    );
    assert.equal(
      rendered
        .split("\n")
        .filter((line) => line.startsWith("  Contract validation command: `ultrafuzz artifact validate ")).length,
      1
    );
    assert.ok(
      rendered.includes(
        `  Validation command: \`ultrafuzz json validate --schema '${schemaPath}' --file '${artifactPath}'\``
      ),
      rendered
    );
    assert.ok(
      rendered.includes(
        `  Contract validation command: \`ultrafuzz artifact validate 'ultrafuzz/findings@2' '${artifactPath}'\``
      ),
      rendered
    );
  }
});

test("a half-published dynamic expansion stays readable while execution stays closed", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-unreadable-expansion" });
  const generated = fixture.generatedTasks[0]!;
  assert.ok(generated.renderedPromptPath);
  const before = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(before.ok, true, "diagnostics" in before ? JSON.stringify(before.diagnostics) : "");

  // Re-deriving the published expansion is an admission check for scheduling, and a controller killed
  // mid-expansion leaves exactly this behind: the manifest is written but a lane's rendered prompt is
  // not. One campaign run was permanently unobservable for this reason while `status` treated the
  // check as fatal (issue #866).
  fs.rmSync(generated.renderedPromptPath!);

  const strict = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.equal(strict.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(strict.diagnostics[0]?.message ?? "", /runtime rendered prompt is missing/u);
  }
  const synchronized = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synchronized.ok, false);

  const observed = await readLinkedWorkflowEvidence(fixture.project, fixture.runId, {
    tolerateControlDivergence: true
  });
  assert.equal(observed.ok, true, "diagnostics" in observed ? JSON.stringify(observed.diagnostics) : "");
  if (observed.ok) {
    assert.ok(
      observed.verifiedControl.divergences.some((divergence) =>
        /published dynamic runtime controls no longer re-derive from their sealed base: runtime rendered prompt is missing/u.test(
          divergence
        )
      ),
      JSON.stringify(observed.verifiedControl.divergences)
    );
  }

  // Reporting must never re-publish the missing prompt on the observer's behalf.
  assert.equal(fs.existsSync(generated.renderedPromptPath!), false);
});

test("controller refresh preserves the sealed dynamic base after runtime materialization", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-controller-refresh" });
  const generated = fixture.generatedTasks[0]!;
  assert.ok(generated.renderedPromptPath);
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const baseTasks = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/runtime-base-tasks.json"
  );
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(baseTasks);
  assert.ok(resolvedConfig);
  const baseGraph = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/runtime-base-graph.json"
  );
  assert.ok(baseGraph);
  const baseDocument = JSON.parse(baseTasks.contents.toString("utf8")) as { tasks: CompiledSmithersTask[] };
  const currentDocument = JSON.parse(evidence.verifiedControl.contents.tasks.toString("utf8")) as {
    tasks: CompiledSmithersTask[];
  };
  assert.equal(
    baseDocument.tasks.some((task) => task.attemptId === generated.attemptId),
    false
  );
  assert.equal(
    currentDocument.tasks.some((task) => task.attemptId === generated.attemptId),
    true
  );
  assert.equal(baseGraph.contents.equals(evidence.verifiedControl.contents.graph), false);

  const sealedBase = {
    ...evidence.verifiedControl,
    contents: {
      ...evidence.verifiedControl.contents,
      graph: baseGraph.contents,
      tasks: baseTasks.contents
    }
  };
  const config = JSON.parse(resolvedConfig.contents.toString("utf8"));
  const firstRefresh = refreshedSmithersControllerSnapshot({
    projectRoot: fixture.project,
    layout: evidence.layout,
    original: sealedBase,
    config
  });
  const firstPrepared = prepareControllerGeneration(evidence.layout, sealedBase, firstRefresh, {
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId
  });
  materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.project,
    layout: evidence.layout,
    snapshot: firstPrepared.snapshot,
    authorizedGenerations: firstPrepared.authorizedGenerations
  });
  commitControllerGeneration(evidence.layout, sealedBase, firstPrepared.controllerGeneration);

  const refreshed = refreshedSmithersControllerSnapshot({
    projectRoot: fixture.project,
    layout: evidence.layout,
    original: evidence.verifiedControl,
    config
  });

  const workflow = refreshed.snapshot.contents.workflow.toString("utf8");
  assert.equal(workflow.includes(JSON.stringify(generated.attemptId)), false);
  assert.equal(workflow.includes(JSON.stringify(generated.renderedPromptPath)), false);
  assert.deepEqual(refreshed.snapshot.contents.tasks, evidence.verifiedControl.contents.tasks);
  assert.equal(refreshed.semanticFingerprint, firstRefresh.semanticFingerprint);

  const moduleIndex = refreshed.snapshot.executionFiles.findIndex((file) =>
    file.snapshotPath.startsWith("modules/@ultrafuzz/runtime/dist/")
  );
  assert.notEqual(moduleIndex, -1);
  const secondRefresh = {
    ...refreshed,
    snapshot: {
      ...refreshed.snapshot,
      executionFiles: refreshed.snapshot.executionFiles.map((file, index) =>
        index === moduleIndex
          ? { ...file, contents: Buffer.concat([file.contents, Buffer.from("\n// synthetic controller update\n")]) }
          : file
      )
    },
    controllerSourceDigest: crypto
      .createHash("sha256")
      .update(refreshed.controllerSourceDigest)
      .update("synthetic-controller-update")
      .digest("hex")
  };
  const secondPrepared = prepareControllerGeneration(evidence.layout, evidence.verifiedControl, secondRefresh, {
    workflowRunId: evidence.smithersRunId,
    workflowLinkId: evidence.workflowLinkId
  });
  materializeWorkflowExecutionSnapshot({
    projectRoot: fixture.project,
    layout: evidence.layout,
    snapshot: secondPrepared.snapshot,
    authorizedGenerations: secondPrepared.authorizedGenerations
  });
  commitControllerGeneration(evidence.layout, evidence.verifiedControl, secondPrepared.controllerGeneration);
  const authority = verifyCommittedControllerGenerationAuthority(
    evidence.layout,
    evidence.controlGeneration,
    secondPrepared.controllerGeneration
  );
  assert.equal(authority.controllerGeneration, secondPrepared.controllerGeneration);
  assert.equal(authority.semanticFingerprint, firstRefresh.semanticFingerprint);
});

test(
  "verified-output authority authenticates dynamic execution bytes once per live lifecycle",
  { concurrency: false },
  async () => {
    const fixture = await createDynamicFixture({ runId: "dynamic-verified-output-snapshot-cache" });
    const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
    assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
    if (!evidence.ok) return;

    const largest = evidence.verifiedControl.executionFiles.reduce((selected, file) =>
      file.contents.byteLength > selected.contents.byteLength ? file : selected
    );
    assert.ok(largest.contents.byteLength > 0);
    const snapshotRoot = path.join(evidence.layout.root, "smithers", "execution-snapshots", evidence.controlGeneration);
    const largestPath = path.join(snapshotRoot, ...largest.snapshotPath.split("/"));

    // Change and restore only the directory metadata so the next lookup must perform one fresh
    // byte authentication. Later lookups can then prove that the live generation is reused.
    const snapshotMode = fs.statSync(snapshotRoot).mode & 0o777;
    fs.chmodSync(snapshotRoot, 0o700);
    fs.chmodSync(snapshotRoot, snapshotMode);

    const openDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const readDescriptor = Object.getOwnPropertyDescriptor(fs, "readSync")!;
    const closeDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    const originalCloseSync = fs.closeSync;
    const tracked = new Set<number>();
    let authenticatedBytes = 0;
    Object.defineProperty(fs, "openSync", {
      ...openDescriptor,
      value: (...args: unknown[]) => {
        const descriptor = Reflect.apply(originalOpenSync, fs, args) as number;
        if (path.resolve(String(args[0])) === largestPath) tracked.add(descriptor);
        return descriptor;
      }
    });
    Object.defineProperty(fs, "readSync", {
      ...readDescriptor,
      value: (...args: unknown[]) => {
        const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
        if (tracked.has(Number(args[0]))) authenticatedBytes += bytesRead;
        return bytesRead;
      }
    });
    Object.defineProperty(fs, "closeSync", {
      ...closeDescriptor,
      value: (...args: unknown[]) => {
        tracked.delete(Number(args[0]));
        return Reflect.apply(originalCloseSync, fs, args) as void;
      }
    });
    let liveControl: typeof evidence.verifiedControl | undefined;
    try {
      for (let lookup = 0; lookup < 5; lookup += 1) {
        verifySealedTaskManifestSnapshot(evidence.layout);
        const current = verifyWorkflowControlSnapshot(fixture.project, evidence.layout);
        if (liveControl === undefined) liveControl = current;
        else {
          assert.equal(
            current,
            liveControl,
            "one live generation must reuse its exact authenticated capability instead of retaining another file graph"
          );
        }
      }
    } finally {
      Object.defineProperty(fs, "closeSync", closeDescriptor);
      Object.defineProperty(fs, "readSync", readDescriptor);
      Object.defineProperty(fs, "openSync", openDescriptor);
    }
    assert.equal(
      authenticatedBytes,
      largest.contents.byteLength,
      "protected execution bytes should be read once, not once per finalized-output lookup"
    );

    const original = Buffer.from(largest.contents);
    const originalStat = fs.statSync(largestPath);
    const replacement = Buffer.alloc(original.byteLength, original[0] === 0x78 ? 0x79 : 0x78);
    fs.chmodSync(largestPath, 0o600);
    fs.writeFileSync(largestPath, replacement);
    fs.utimesSync(largestPath, originalStat.atime, originalStat.mtime);
    fs.chmodSync(largestPath, originalStat.mode & 0o777);
    try {
      assert.throws(
        () => verifySealedTaskManifestSnapshot(evidence.layout),
        /sealed workflow execution file changed/u,
        "a same-size mutation with restored mtime must invalidate the cache and fail closed"
      );
    } finally {
      fs.chmodSync(largestPath, 0o600);
      fs.writeFileSync(largestPath, original);
      fs.chmodSync(largestPath, originalStat.mode & 0o777);
    }
  }
);

test("dynamic child success is resumable, idempotent, provenance-safe, and opens its strict join", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-success" });
  const generated = fixture.generatedTasks[0]!;
  const planner = plannerSuccessEvidence(fixture);
  writeFinding(generated);
  setLifecycle(
    fixture,
    [...planner.steps, { id: generated.smithersNodeId, state: "finished", attempt: 1 }],
    [
      ...planner.events,
      { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 1 },
      { type: "NodeFinished", nodeId: generated.smithersNodeId, attempt: 1 },
      {
        type: "TokenUsageReported",
        nodeId: generated.smithersNodeId,
        attempt: 1,
        extra: {
          iteration: 0,
          inputTokens: 12,
          outputTokens: 3,
          model: "dynamic-test-model",
          agent: "CodexAgent"
        }
      }
    ]
  );

  const statePath = path.join(fixture.runRoot, "state.json");
  const runEventsPath = path.join(fixture.runRoot, "events.jsonl");
  const stateBefore = fs.readFileSync(statePath, "utf8");
  const eventsBefore = fs.readFileSync(runEventsPath, "utf8");
  let clockReads = 0;
  const interrupted = await syncRun(
    { projectRoot: fixture.project, runId: fixture.runId, env: fixture.env },
    { now: () => (clockReads++ === 0 ? 0 : 1_000), deadlineMs: 500 }
  );
  assert.equal(interrupted.ok, false);
  assert.ok(
    interrupted.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"),
    JSON.stringify(interrupted.diagnostics)
  );
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(runEventsPath, "utf8"), eventsBefore);

  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  const state = readState(fixture);
  const generatedProvenance = state.nodes[fixture.storageId!]?.provenance as ExecutionNodeProvenance | undefined;
  const plannerProvenance = state.nodes.planner?.provenance as ExecutionNodeProvenance | undefined;
  assert.equal(state.nodes[fixture.storageId!]?.status, "succeeded");
  assert.equal(generatedProvenance?.producer_node_id, fixture.generatedNodeId);
  // `source_node_id` is the one key both sides must agree on (#364): it is the term #183 uses and
  // exactly what the eval reader looks for on a dynamic node's provenance. The nested camelCase
  // record stays alongside it for the expansion key, item digest and manifest path.
  assert.equal(generatedProvenance?.source_node_id, "planner");
  assert.equal(generatedProvenance?.dynamic?.sourceNodeId, "planner");
  // A static node was never expanded from anything, so it must not claim a source.
  assert.equal(plannerProvenance?.source_node_id, undefined);

  // The current ledger preserves the runner's exact task/attempt identity; the sealed task plan is
  // the authenticated join from that workflow identity to the storage-keyed state record.
  const usageLedger = readUsageLedger(fixture);
  assert.equal(usageLedger.length, 1);
  assert.equal(usageLedger[0]?.node_id, generated.smithersNodeId);
  assert.equal(usageLedger[0]?.attempt, 1);
  assert.ok(state.nodes[fixture.storageId!] !== undefined);
  assert.equal(state.nodes.fanout?.status, "succeeded");
  assert.equal(state.nodes["strict-join"]?.wait_reason, "ready");
  assert.match(fs.readFileSync(generated.renderedPromptPath!, "utf8"), /persisted liquidation threat model/u);

  const findings = JSON.parse(fs.readFileSync(path.join(generated.artifactDir, "findings.json"), "utf8")) as Array<{
    source_node_id?: string;
    source_nodes?: string[];
    producer_node_id?: string;
    producer_attempt_id?: string;
  }>;
  // The compatibility alias must equal source_nodes[0] so the downstream dedupe gate accepts this
  // canonical upstream artifact; the storage/attempt identity stays explicit and in the manifest.
  assert.deepEqual(findings[0]?.source_nodes, [fixture.generatedNodeId]);
  assert.equal(findings[0]?.source_node_id, fixture.generatedNodeId);
  assert.equal(findings[0]?.producer_attempt_id, generated.attemptId);
  assert.equal(findings[0]?.producer_node_id, fixture.generatedNodeId);
  const manifest = JSON.parse(fs.readFileSync(path.join(generated.artifactDir, "artifact-manifest.json"), "utf8")) as {
    producer_node_id?: string;
    provenance?: { metadata?: { storage_id?: string; dynamic?: { groupNodeId?: string } } };
    files?: Array<{ provenance?: { producer_node_id?: string } }>;
  };
  assert.equal(manifest.producer_node_id, fixture.generatedNodeId);
  assert.equal(manifest.files?.[0]?.provenance?.producer_node_id, fixture.generatedNodeId);
  assert.equal(manifest.provenance?.metadata?.storage_id, fixture.storageId);
  assert.equal(manifest.provenance?.metadata?.dynamic?.groupNodeId, "fanout");
  const productEvents = fs
    .readFileSync(runEventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const childSyncEvent = productEvents.find(
    (event) => event.event_type === "node-synced" && event.node_id === generated.attemptId
  );
  assert.ok(childSyncEvent);
  assert.equal(childSyncEvent.provenance, undefined);
  const runMetadata = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        event_count?: number;
        attempts?: Array<{ node_id?: string; iteration?: number; attempt?: number }>;
        models?: string[];
      };
    };
  };
  assert.equal(runMetadata.accounting?.current?.total_tokens, 15);
  assert.equal(runMetadata.accounting?.current?.event_count, 1);
  assert.deepEqual(runMetadata.accounting?.current?.attempts, [
    { node_id: generated.smithersNodeId, iteration: 0, attempt: 1 }
  ]);
  assert.deepEqual(runMetadata.accounting?.current?.models, ["dynamic-test-model"]);
  const expansion = JSON.parse(
    fs.readFileSync(path.join(fixture.runRoot, "dynamic-expansions", "fanout.json"), "utf8")
  ) as { items?: Array<{ node_id?: string; storage_id?: string }> };
  assert.deepEqual(expansion.items?.[0], {
    ...expansion.items?.[0],
    node_id: fixture.generatedNodeId,
    storage_id: fixture.storageId
  });

  const ledgerAfterFirstSync = fs.readFileSync(path.join(fixture.runRoot, "attempts.jsonl"), "utf8");
  const eventsAfterFirstSync = fs.readFileSync(runEventsPath, "utf8");
  const replayed = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  assert.equal(fs.readFileSync(path.join(fixture.runRoot, "attempts.jsonl"), "utf8"), ledgerAfterFirstSync);
  assert.equal(fs.readFileSync(runEventsPath, "utf8"), eventsAfterFirstSync);
});

test("dynamic child failure, skip, and timeout keep strict joins blocked with durable terminal state", async () => {
  for (const outcome of ["failed", "skipped", "timed-out"] as const) {
    const fixture = await createDynamicFixture({ runId: `dynamic-${outcome}` });
    const generated = fixture.generatedTasks[0]!;
    const planner = plannerSuccessEvidence(fixture);
    const terminalEvent =
      outcome === "failed"
        ? { type: "NodeFailed", nodeId: generated.smithersNodeId, attempt: 1, error: { message: "worker failed" } }
        : outcome === "skipped"
          ? { type: "NodeSkipped", nodeId: generated.smithersNodeId, attempt: 1 }
          : { type: "TaskHeartbeatTimeout", nodeId: generated.smithersNodeId, attempt: 1 };
    setLifecycle(
      fixture,
      [
        ...planner.steps,
        // Smithers exposes timeout as terminal event evidence; its current inspect node enum has no
        // synthetic "timed-out" state, so the corresponding node summary remains failed.
        { id: generated.smithersNodeId, state: outcome === "timed-out" ? "failed" : outcome, attempt: 1 }
      ],
      [...planner.events, { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 1 }, terminalEvent]
    );

    const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
    assert.equal(synced.ok, true, `${outcome}: ${JSON.stringify(synced.diagnostics)}`);
    const state = readState(fixture);
    assert.equal(state.nodes[fixture.storageId!]?.status, outcome, outcome);
    assert.equal(state.nodes.fanout?.status, outcome, outcome);
    assert.equal(state.nodes["strict-join"]?.wait_reason, "dependency", outcome);
    const ledgerOutcome = readLedger(fixture).find(
      (entry) => entry.strategy_attempt_id === generated.attemptId
    )?.outcome;
    // The current strict attempt ledger records only NodeFinished/NodeFailed terminal authorities.
    // A skip or heartbeat timeout remains durable in state without inventing a ledger terminal
    // event that the workflow runner did not emit.
    assert.equal(ledgerOutcome, outcome === "failed" ? "failed" : undefined, outcome);
  }
});

test("dynamic retries retain their immutable ledger and settle the generated group once", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-retry" });
  const generated = fixture.generatedTasks[0]!;
  const planner = plannerSuccessEvidence(fixture);
  writeFinding(generated);
  setLifecycle(
    fixture,
    [...planner.steps, { id: generated.smithersNodeId, state: "finished", attempt: 2 }],
    [
      ...planner.events,
      { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 1 },
      { type: "NodeFailed", nodeId: generated.smithersNodeId, attempt: 1, error: { message: "retry me" } },
      { type: "NodeRetrying", nodeId: generated.smithersNodeId, attempt: 2 },
      { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 2 },
      { type: "NodeFinished", nodeId: generated.smithersNodeId, attempt: 2 }
    ]
  );

  const first = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  const replayed = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics));
  const generatedLedger = readLedger(fixture).filter((entry) => entry.strategy_attempt_id === generated.attemptId);
  assert.deepEqual(
    generatedLedger.map((entry) => entry.outcome),
    ["failed", "succeeded"]
  );
  assert.equal(generatedLedger[1]?.parent_attempt_id, generatedLedger[0]?.attempt_id);
  const state = readState(fixture);
  assert.equal(state.nodes[generated.attemptId]?.retry_count, 1);
  assert.equal(state.nodes.fanout?.status, "succeeded");
  assert.equal(state.nodes["strict-join"]?.wait_reason, "ready");
});

test("empty dynamic groups terminate successfully and release their strict join", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-empty", goals: [] });
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);

  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  const state = readState(fixture);
  assert.equal(state.nodes.fanout?.status, "succeeded");
  assert.equal(state.nodes["strict-join"]?.wait_reason, "ready");
  assert.deepEqual(fixture.joinTask.dependencies, [fixture.plannerTask.attemptId]);
});

test("model-fanout dynamic nodes stay pending until every generated attempt has evidence", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-model-fanout", modelFanout: true });
  const [completed, absent] = fixture.generatedTasks;
  assert.ok(completed);
  assert.ok(absent);
  assert.notEqual(completed.attemptId, absent.attemptId);
  writeFinding(completed);
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(
    fixture,
    [...planner.steps, { id: completed.smithersNodeId, state: "finished", attempt: 1 }],
    [
      ...planner.events,
      { type: "NodeStarted", nodeId: completed.smithersNodeId, attempt: 1 },
      { type: "NodeFinished", nodeId: completed.smithersNodeId, attempt: 1 }
    ]
  );

  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  const state = readState(fixture);
  assert.equal(state.nodes[completed.attemptId]?.status, "succeeded");
  assert.equal(state.nodes[absent.attemptId]?.status, "pending");
  assert.equal(state.nodes[fixture.storageId!]?.status, "pending");
  assert.equal(state.nodes.fanout?.status, "pending");
  assert.equal(state.nodes["strict-join"]?.wait_reason, "dependency");
});

test("model-fanout dynamic aggregate state is materialized before child evidence exists", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-model-pending", modelFanout: true });
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);

  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  const state = readState(fixture);
  assert.equal(state.nodes[fixture.storageId!]?.status, "pending");
  assert.equal(state.nodes[fixture.storageId!]?.wait_reason, "dependency");
  assert.equal(state.nodes[fixture.storageId!]?.next_eligible_action, "task-complete");
  assert.equal(
    (state.nodes[fixture.storageId!]?.provenance as ExecutionNodeProvenance | undefined)?.producer_node_id,
    fixture.generatedNodeId
  );
  assert.ok(fixture.generatedTasks.every((task) => state.nodes[task.attemptId]?.status === "pending"));
  assert.equal(state.nodes.fanout?.status, "pending");
  assert.equal(state.nodes["strict-join"]?.wait_reason, "dependency");
});

test("dynamic state materialization checks the synchronization deadline before publication", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-state-budget", modelFanout: true });
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);
  const statePath = path.join(fixture.runRoot, "state.json");
  const runEventsPath = path.join(fixture.runRoot, "events.jsonl");
  const stateBefore = fs.readFileSync(statePath, "utf8");
  const eventsBefore = fs.readFileSync(runEventsPath, "utf8");
  const graph = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "graph.json"), "utf8")) as {
    nodes: unknown[];
  };
  const taskDocument = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "smithers", "tasks.json"), "utf8")) as {
    tasks: unknown[];
  };

  // Four synchronization clocks are read around the three workflow-runner
  // inspections. The state materializer then checks once on entry, once per
  // task, once per graph node, and once immediately before its durable write.
  const expireOnRead = 6 + taskDocument.tasks.length + graph.nodes.length;
  let clockReads = 0;
  const interrupted = await syncRun(
    { projectRoot: fixture.project, runId: fixture.runId, env: fixture.env },
    {
      now: () => (++clockReads >= expireOnRead ? 1_000 : 0),
      deadlineMs: 500
    }
  );

  assert.equal(interrupted.ok, false);
  assert.ok(interrupted.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.equal(clockReads, expireOnRead);
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(runEventsPath, "utf8"), eventsBefore);
});

test("dynamic lifecycle admission rejects graph, task, and state extensions not derived from sealed controls", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-control-admission" });
  const graphPath = path.join(fixture.runRoot, "graph.json");
  const tasksPath = path.join(fixture.runRoot, "smithers", "tasks.json");
  const statePath = path.join(fixture.runRoot, "state.json");
  const graphBytes = fs.readFileSync(graphPath, "utf8");
  const taskBytes = fs.readFileSync(tasksPath, "utf8");
  const stateBytes = fs.readFileSync(statePath, "utf8");

  const rejectControlMutation = async (message: RegExp): Promise<void> => {
    const result = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID" && message.test(diagnostic.message)
      ),
      JSON.stringify(result.diagnostics)
    );
    assert.equal(fs.readFileSync(statePath, "utf8"), stateBytes);
  };

  const graph = JSON.parse(graphBytes) as Record<string, unknown>;
  graph.unadmitted_control = true;
  fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  await rejectControlMutation(/dynamic runtime graph does not match/u);
  fs.writeFileSync(graphPath, graphBytes, "utf8");

  const tasks = JSON.parse(taskBytes) as Record<string, unknown>;
  tasks.unadmitted_control = true;
  fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
  await rejectControlMutation(/dynamic runtime task plan does not match/u);
  fs.writeFileSync(tasksPath, taskBytes, "utf8");

  const state = JSON.parse(stateBytes) as RunState;
  state.nodes["injected-control-node"] = structuredClone(state.nodes.planner!);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const rejectedState = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(rejectedState.ok, false);
  assert.ok(
    rejectedState.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID" &&
        /outside the verified dynamic runtime graph/u.test(diagnostic.message)
    ),
    JSON.stringify(rejectedState.diagnostics)
  );
});
