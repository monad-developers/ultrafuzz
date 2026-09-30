import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { ARTIFACTS_MODULE_URL, runWithRebuiltValidator } from "./rebuilt-validator.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  VALIDATOR_BUILD_IDENTITY,
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  layoutForRunRoot,
  parseSmithersTaskManifestBytes,
  readRunPlanDocument,
  writeArtifactManifest,
  type ExecutionNodeProvenance,
  type RunState
} from "@ultrafuzz/artifacts";

import {
  getRunHealth,
  initProject,
  materializeDynamicRuntime,
  queryWorkflowEvents,
  readLinkedWorkflowEvidence,
  resumeRun,
  startRun,
  syncRun,
  watchWorkflowEvents,
  type WorkflowLifecycleEvent
} from "../src/index.js";
import { effectiveRouteEnvironment } from "../src/data-governance.js";
import {
  renderCurrentSmithersController,
  type CompiledSmithersDynamicGroup,
  type CompiledSmithersTask
} from "../src/smithers.js";
import { bindSmithersExecutableCapability } from "../src/smithers-executable-capability.js";
import { verifySealedTaskManifestSnapshot, verifyWorkflowControlSnapshot } from "../src/workflow-integrity.js";

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

interface WorkflowRunLifecycle {
  status: string;
  state: string;
}

interface DynamicFixture {
  project: string;
  runId: string;
  runRoot: string;
  workflowRunId: string;
  env: Record<string, string | undefined>;
  inspectPath: string;
  eventsPath: string;
  statusPath: string;
  plannerTask: CompiledSmithersTask;
  generatedTasks: CompiledSmithersTask[];
  joinTask: CompiledSmithersTask;
  generatedNodeId?: string;
  storageId?: string;
}

function tempProject(): string {
  return temporaryRoot("ufz-dynamic-lifecycle-");
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
  // The fake runner never heartbeats, so a sync that runs one lease after launch parks every open node
  // as a lost controller. Slow CI setup alone can take longer than the default 30 s lease.
  const configPath = path.join(project, "ultrafuzz.toml");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /^controller_lease_seconds = 30$/mu);
  fs.writeFileSync(configPath, config.replace(/^controller_lease_seconds = 30$/mu, "controller_lease_seconds = 3600"));
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
  statusPath: string;
} {
  const binDir = temporaryRoot("ufz-dynamic-lifecycle-runner-");
  const inspectPath = path.join(project, "workflow-inspect.json");
  const eventsPath = path.join(project, "workflow-events.ndjson");
  const statusPath = path.join(project, "workflow-status.json");
  const smithers = path.join(binDir, "smithers");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(inspectPath, "{}\n", "utf8");
  fs.writeFileSync(eventsPath, "", "utf8");
  fs.writeFileSync(statusPath, "{}\n", "utf8");
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
      "  status)",
      `    cat ${shellQuote(statusPath)}`,
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
        ULTRAFUZZ_PROVIDER_HOME_ROOT: temporaryRoot("ufz-dynamic-provider-homes-"),
        ULTRAFUZZ_PRICING_CATALOG_URL: "off"
      },
      smithers,
      project
    ),
    inspectPath,
    eventsPath,
    statusPath
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
  /** Runs after launch and before the fixture's render expands the group. */
  beforeExpansion?: (project: string, groups: readonly CompiledSmithersDynamicGroup[]) => void;
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
  fs.writeFileSync(
    lifecycle.statusPath,
    `${JSON.stringify(workflowStatus(taskDocument.smithers_run_id), null, 2)}\n`,
    "utf8"
  );
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
  input.beforeExpansion?.(project, taskDocument.dynamic_groups);
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
    statusPath: lifecycle.statusPath,
    plannerTask,
    generatedTasks,
    joinTask,
    generatedNodeId: generatedNode?.id,
    storageId: generatedNode?.dynamic_generated?.storage_id
  };
}

function setLifecycle(
  fixture: DynamicFixture,
  steps: LifecycleStep[],
  events: LifecycleEvent[],
  run: WorkflowRunLifecycle = { status: "running", state: "running" }
): void {
  fs.writeFileSync(
    fixture.inspectPath,
    `${JSON.stringify(workflowInspect(fixture.workflowRunId, steps, run), null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(fixture.eventsPath, workflowEvents(fixture.workflowRunId, events), "utf8");
}

function workflowInspect(
  workflowRunId: string,
  inputSteps: LifecycleStep[],
  run: WorkflowRunLifecycle = { status: "running", state: "running" }
): unknown {
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
        status: run.status,
        started: "2026-08-04T00:00:00.000Z",
        elapsed: "3s"
      },
      runState: {
        runId: workflowRunId,
        computedAt: "2026-08-04T00:00:03.000Z",
        state: run.state
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

/** The `status --format json --full-output` envelope the pinned runner emits for a live run. */
function workflowStatus(workflowRunId: string): unknown {
  return {
    ok: true,
    data: {
      status: "running",
      verdict: "running-healthy",
      reason: "1 running, 1 finished in last 10m",
      counts: {
        finished: 1,
        inProgress: 1,
        pending: 2,
        failed: 0,
        stalled: 0,
        waitingApproval: 0,
        waitingEvent: 0,
        waitingTimer: 0,
        skipped: 0,
        other: 0,
        total: 4
      },
      modelMix: [],
      throughput: { recentFinished: 1, windowMs: 600_000, totalFinished: 1, lastFinishedAtMs: 1_000 },
      bottleneck: [],
      bottleneckOmitted: 0,
      quota: null,
      runId: workflowRunId,
      workflow: workflowRunId,
      liveness: { state: "running" },
      startedAtMs: 1_000,
      finishedAtMs: null,
      generatedAtMs: 2_000
    },
    meta: { command: "status", duration: "1ms" }
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
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);

  // Admission reads no prompt file, so a deleted runtime prompt is admitted, and no reader
  // republishes it on the controller's behalf: only the next render does.
  fs.rmSync(generated.renderedPromptPath);
  const admitted = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(admitted.ok, true, "diagnostics" in admitted ? JSON.stringify(admitted.diagnostics) : "");
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  assert.equal(fs.existsSync(generated.renderedPromptPath), false);

  // Re-deriving the published expansion is an admission check for scheduling, and a controller killed
  // mid-expansion leaves exactly this behind: the manifest and the task plan are published but the
  // graph is not. One campaign run was permanently unobservable for this reason while `status`
  // treated the check as fatal (issue #866).
  fs.copyFileSync(
    path.join(fixture.runRoot, "smithers", "runtime-base-graph.json"),
    path.join(fixture.runRoot, "graph.json")
  );

  const strict = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(strict.ok, false);
  if (!strict.ok) {
    assert.equal(strict.diagnostics[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
    assert.match(strict.diagnostics[0]?.message ?? "", /persisted dynamic runtime graph does not match/u);
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
        /published dynamic runtime controls no longer re-derive from their sealed base: persisted dynamic runtime graph does not match/u.test(
          divergence
        )
      ),
      JSON.stringify(observed.verifiedControl.divergences)
    );
  }

  // Reporting must never re-publish the missing prompt on the observer's behalf.
  assert.equal(fs.existsSync(generated.renderedPromptPath), false);
});

/** Replays the first render of the workflow `resume` hands to the runner, with that workflow's own literals. */
function replayResumedWorkflowRender(fixture: DynamicFixture) {
  const metadata = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "run.json"), "utf8")) as {
    workflow?: { path?: string };
  };
  assert.ok(metadata.workflow?.path);
  const workflowSource = fs.readFileSync(path.join(fixture.project, ...metadata.workflow.path.split("/")), "utf8");
  const compiled = compiledControllerConstants(workflowSource);
  return materializeDynamicRuntime({
    runId: fixture.runId,
    projectRoot: fixture.project,
    runRoot: fixture.runRoot,
    graphPath: path.join(fixture.runRoot, "graph.json"),
    tasksPath: path.join(fixture.runRoot, "smithers", "tasks.json"),
    baseTasks: compiled.baseTasks,
    groups: compiled.groups,
    readyGroupIds: ["fanout"]
  });
}

async function assertSynchronizableRun(fixture: DynamicFixture): Promise<void> {
  const strict = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(strict.ok, true, "diagnostics" in strict ? JSON.stringify(strict.diagnostics) : "");
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  const health = await getRunHealth({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  for (const result of [synced, health]) {
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    for (const diagnostic of result.diagnostics) {
      assert.doesNotMatch(
        diagnostic.code,
        /^WORKFLOW_(CONTROL_EVIDENCE_|STATE_SYNC_SKIPPED)/u,
        JSON.stringify(diagnostic)
      );
    }
  }
}

test("a hand-edited runtime prompt keeps a launched dynamic run synchronizable and resumable", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-prompt-edit" });
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);
  // An operator's edit of tasks that have not run, and what an upgrade that changed a renderer or a
  // projection leaves (#1176, #1195): the join, like the stock final report, renders only after the
  // group expands.
  const prompts = [fixture.joinTask, ...fixture.generatedTasks].map((task) => {
    assert.ok(task.renderedPromptPath);
    const edited = `${fs.readFileSync(task.renderedPromptPath, "utf8")}\nOperator note: start from the overdue path.\n`;
    fs.writeFileSync(task.renderedPromptPath, edited, "utf8");
    return { attemptId: task.attemptId, path: task.renderedPromptPath, edited };
  });
  await assertSynchronizableRun(fixture);

  // The run stopped; the operator resumes it, and the resumed engine runs the edited prompts.
  setLifecycle(fixture, planner.steps, planner.events, { status: "failed", state: "failed" });
  const resumed = await resumeRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const rendered = replayResumedWorkflowRender(fixture);
  assert.deepEqual(rendered.promptRenderFailures, []);
  for (const prompt of prompts) {
    assert.equal(rendered.tasks.find((task) => task.attemptId === prompt.attemptId)?.renderedPromptPath, prompt.path);
    assert.equal(fs.readFileSync(prompt.path, "utf8"), prompt.edited);
  }
  setLifecycle(fixture, planner.steps, planner.events);
  await assertSynchronizableRun(fixture);
});

test("a runtime prompt that cannot be rendered fails only its task and recovers once fixed", async () => {
  // E2: a typo in the group template before the group expands. The fixture's render publishes the
  // manifest, task plan and graph, and every other prompt.
  let groupTemplatePath: string | undefined;
  let groupTemplate: string | undefined;
  const fixture = await createDynamicFixture({
    runId: "dynamic-prompt-render-failure",
    beforeExpansion: (project, groups) => {
      assert.ok(groups[0]);
      groupTemplatePath = path.resolve(project, groups[0].templatePath);
      groupTemplate = fs.readFileSync(groupTemplatePath, "utf8");
      fs.writeFileSync(groupTemplatePath, groupTemplate.replace("{{item.goal_prompt}}", "{{item.goal_promt}}"), "utf8");
    }
  });
  assert.ok(groupTemplatePath && groupTemplate);
  const child = fixture.generatedTasks[0];
  assert.ok(child?.renderedPromptPath);
  assert.equal(fs.existsSync(child.renderedPromptPath), false);
  assert.ok(fixture.joinTask.renderedPromptPath && fixture.joinTask.promptTemplatePath);
  assert.equal(fs.existsSync(fixture.joinTask.renderedPromptPath), true, "an independent prompt still renders");

  // E1: the join's published prompt is deleted and its template copy no longer renders.
  const joinTemplatePath = path.resolve(fixture.project, fixture.joinTask.promptTemplatePath);
  const joinTemplate = fs.readFileSync(joinTemplatePath, "utf8");
  fs.rmSync(fixture.joinTask.renderedPromptPath);
  fs.appendFileSync(joinTemplatePath, "{{artifact_pth:fanout}}\n", "utf8");

  // Every render still returns; it reports each broken prompt for its own task to fail on.
  const failed = replayResumedWorkflowRender(fixture);
  const failures = new Map(failed.promptRenderFailures.map((failure) => [failure.attemptId, failure.message]));
  assert.deepEqual([...failures.keys()].sort(), [child.attemptId, fixture.joinTask.attemptId].sort());
  assert.match(failures.get(child.attemptId) ?? "", /item\.goal_promt/u);
  assert.match(failures.get(fixture.joinTask.attemptId) ?? "", /artifact_pth:fanout/u);
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(fixture, planner.steps, planner.events);
  await assertSynchronizableRun(fixture);

  // Fixing both template copies and retrying the failed tasks recovers the run.
  fs.writeFileSync(groupTemplatePath, groupTemplate, "utf8");
  fs.writeFileSync(joinTemplatePath, joinTemplate, "utf8");
  setLifecycle(
    fixture,
    [
      ...planner.steps,
      { id: child.preparationSmithersNodeId, state: "failed", attempt: 1 },
      { id: fixture.joinTask.preparationSmithersNodeId, state: "failed", attempt: 1 }
    ],
    planner.events,
    { status: "failed", state: "failed" }
  );
  const resumed = await resumeRun({
    projectRoot: fixture.project,
    runId: fixture.runId,
    force: true,
    retryFailed: true,
    env: fixture.env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  const recovered = replayResumedWorkflowRender(fixture);
  assert.deepEqual(recovered.promptRenderFailures, []);
  assert.match(fs.readFileSync(child.renderedPromptPath, "utf8"), /find any vulnerability affecting/u);
  assert.equal(fs.existsSync(fixture.joinTask.renderedPromptPath), true);
  setLifecycle(fixture, planner.steps, planner.events);
  await assertSynchronizableRun(fixture);
});

test("a re-running dynamic source keeps published controls admissible and observable", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-source-retry-events" });
  const [firstTask] = fixture.generatedTasks;
  assert.ok(firstTask);
  const eventNodeId = firstTask.smithersNodeId;
  setLifecycle(fixture, [], [{ type: "NodeStarted", nodeId: eventNodeId, attempt: 2 }]);
  // A reset re-runs the planner, whose agent attempt first wipes its canonical artifact directory.
  const sourcePath = path.join(fixture.runRoot, "artifacts", "planner", "plan.json");
  const publishedPlan = fs.readFileSync(sourcePath, "utf8");
  fs.rmSync(sourcePath);

  // The published expansion manifest decides the fan-out, so the strict admission that cancel,
  // pause, fork, and replay require keeps re-deriving the same controls without the source.
  const strict = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(strict.ok, true, "diagnostics" in strict ? JSON.stringify(strict.diagnostics) : "");

  const queried = await queryWorkflowEvents({
    projectRoot: fixture.project,
    runId: fixture.runId,
    env: fixture.env
  });
  assert.equal(queried.ok, true, JSON.stringify(queried.diagnostics));
  assert.equal(queried.value?.events[0]?.category, "NodeStarted");
  assert.equal(queried.value?.events[0]?.node_id, eventNodeId);
  assert.equal(
    queried.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_DIVERGED"),
    false,
    JSON.stringify(queried.diagnostics)
  );

  const streamed: WorkflowLifecycleEvent[] = [];
  const watched = await watchWorkflowEvents({
    projectRoot: fixture.project,
    runId: fixture.runId,
    env: fixture.env,
    onEvent: (event) => streamed.push(event)
  });
  assert.equal(watched.ok, true, JSON.stringify(watched.diagnostics));
  assert.equal(streamed[0]?.category, "NodeStarted");
  assert.equal(
    watched.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_DIVERGED"),
    false,
    JSON.stringify(watched.diagnostics)
  );
  // Observation must not recreate or otherwise repair the dynamic source on the controller's behalf.
  assert.equal(fs.existsSync(sourcePath), false);

  // The re-run then writes a plan whose goal has a different key; admission still follows the
  // published manifest.
  const plan = JSON.parse(publishedPlan) as { threat_goals: Array<Record<string, unknown>> };
  plan.threat_goals = plan.threat_goals.map((goal) => ({ ...goal, id: "liquidation:early" }));
  fs.writeFileSync(sourcePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const rewritten = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(rewritten.ok, true, "diagnostics" in rewritten ? JSON.stringify(rewritten.diagnostics) : "");
});

test("current-controller rendering accepts runtime-materialized dynamic prompts", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-refresh-render" });
  const generated = fixture.generatedTasks[0]!;
  assert.ok(generated.renderedPromptPath);
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);

  // `resume --refresh-controller` is handed the LIVE manifest, which carries every task the dynamic
  // runtime materialized, while `plan.json` is written before any expansion and can never name a
  // generated attempt. A refresh must not need a plan row for any prompt path it binds.
  const taskDocument = parseSmithersTaskManifestBytes(
    fs.readFileSync(path.join(fixture.runRoot, "smithers", "tasks.json"))
  );
  const baseTasksPath = path.join(fixture.runRoot, "smithers", "runtime-base-tasks.json");
  const baseDocument = parseSmithersTaskManifestBytes(fs.readFileSync(baseTasksPath));
  const plan = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "plan.json"), "utf8")) as {
    rendered_prompts: Array<{ attempt_id: string }>;
  };
  assert.equal(
    taskDocument.tasks.some((task) => task.attemptId === generated.attemptId),
    true
  );
  assert.equal(
    plan.rendered_prompts.some((prompt) => prompt.attempt_id === generated.attemptId),
    false
  );
  const generatedTask = taskDocument.tasks.find((task) => task.attemptId === generated.attemptId);
  assert.ok(generatedTask?.metadata.node.dynamic);
  assert.ok((generatedTask.deferredPromptGroups ?? []).length > 0);

  // The join is a PLANNED task, but it has a dynamic ancestor, so the runtime -- not plan time --
  // rendered its prompt. It is likewise absent from `plan.json`.
  const deferredPlannedTask = taskDocument.tasks.find(
    (task) =>
      task.metadata.node.dynamic === undefined &&
      (task.deferredPromptGroups ?? []).length > 0 &&
      task.renderedPromptPath !== undefined
  );
  assert.ok(deferredPlannedTask);
  assert.equal(
    plan.rendered_prompts.some((prompt) => prompt.attempt_id === deferredPlannedTask.attemptId),
    false
  );

  // A run sealed before `runtime-base-tasks.json` existed has no sealed base manifest, so the
  // refresh still compiles the LIVE one, generated tasks and all, and binds every prompt to its
  // runtime location.
  const sealedBaseTasks = fs.readFileSync(baseTasksPath);
  fs.rmSync(baseTasksPath);
  const legacyWorkflow = fs.readFileSync(
    renderCurrentSmithersController({
      projectRoot: fixture.project,
      layout: evidence.layout,
      smithersRunId: evidence.smithersRunId,
      tasks: taskDocument,
      config: JSON.parse(resolvedConfig.contents.toString("utf8"))
    }),
    "utf8"
  );
  assert.ok(
    legacyWorkflow.includes(JSON.stringify(generated.attemptId)),
    "generated attempt is absent from the controller"
  );
  assert.ok(
    legacyWorkflow.includes(JSON.stringify(generated.renderedPromptPath)),
    "generated prompt path was rebound away from its runtime location"
  );
  assert.ok(
    legacyWorkflow.includes(JSON.stringify(deferredPlannedTask.renderedPromptPath)),
    "deferred prompt path was rebound away from its runtime location"
  );
  fs.writeFileSync(baseTasksPath, sealedBaseTasks);

  const workflowPath = renderCurrentSmithersController({
    projectRoot: fixture.project,
    layout: evidence.layout,
    smithersRunId: evidence.smithersRunId,
    tasks: taskDocument,
    config: JSON.parse(resolvedConfig.contents.toString("utf8"))
  });
  assert.ok(fs.existsSync(workflowPath));
  const workflow = fs.readFileSync(workflowPath, "utf8");

  // With the sealed base manifest present the refresh compiles the PRE-EXPANSION set instead, so the
  // runtime-generated attempt is deliberately absent: the dynamic runtime re-materializes it from
  // the group templates on the next tick, and compiling it in would reserve its own ID against that
  // expansion. See `refreshed controller compiles the pre-expansion base task set`.
  assert.equal(
    workflow.includes(JSON.stringify(generated.attemptId)),
    false,
    "runtime-generated attempt was compiled into the refreshed controller"
  );
  assert.ok(
    workflow.includes(JSON.stringify(deferredPlannedTask.attemptId)),
    "deferred-prompt planned task is absent from the controller"
  );
  // A prompt rendered at plan time keeps its launch path: the run's own prompt file.
  const plannedTask = baseDocument.tasks.find(
    (task) => task.renderedPromptPath !== undefined && (task.deferredPromptGroups ?? []).length === 0
  );
  assert.ok(plannedTask?.renderedPromptPath);
  assert.equal(
    compiledControllerConstants(workflow).taskSpecs.find((spec) => spec.attemptId === plannedTask.attemptId)
      ?.promptPath,
    plannedTask.renderedPromptPath
  );
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

  // The fake runner has no controller heartbeat. Keep its lease current independently of CI setup time.
  const observedAtMs = Date.parse(readState(fixture).last_transition_at) + 1_000;
  const syncControl = { now: () => observedAtMs };
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env }, syncControl);
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
  const replayed = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env }, syncControl);
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
    // The attempt ledger records only NodeFinished/NodeFailed/NodeCancelled terminal events.
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

/**
 * Every observer of a run whose expansion generation was withdrawn: the control evidence reader,
 * `status`, and a real synchronization pass over the runner's history, which still names the
 * archived generation's nodes. None may refuse the run on its control evidence.
 */
async function assertObserversAdmitted(fixture: DynamicFixture): Promise<void> {
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId, {
    tolerateControlDivergence: true,
    observeOnly: true
  });
  assert.equal(evidence.ok, true, JSON.stringify(evidence.ok ? undefined : evidence.diagnostics));
  if (!evidence.ok) return;
  assert.deepEqual(evidence.verifiedControl.divergences, []);
  const health = await getRunHealth({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(health.ok, true, JSON.stringify(health.diagnostics));
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  for (const diagnostic of [...health.diagnostics, ...synced.diagnostics]) {
    assert.doesNotMatch(diagnostic.code, /^WORKFLOW_CONTROL_EVIDENCE_/u, JSON.stringify(diagnostic));
  }
}

/**
 * The reopened producer writes a plan whose only goal has a different key, and the next render
 * re-expands the group from it under a different human node ID and a different storage ID. This is
 * the gap #1063 describes: the source artifact exists, its verifier has not published yet, and the
 * producer's finalized authority documents from the earlier attempt are untouched.
 */
function republishRetriedExpansion(fixture: DynamicFixture): CompiledSmithersTask[] {
  const planPath = path.join(fixture.plannerTask.artifactDir, "plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    modeled_threat_ids: string[];
    threat_goals: Array<Record<string, unknown>>;
    goal_lanes: Array<Record<string, unknown>>;
  };
  const goal = plan.threat_goals[0];
  assert.ok(goal);
  const retriedGoal = {
    ...goal,
    id: "liquidation:early",
    node_id: "dynamic:threat:liquidation:early",
    threat_ids: ["liquidation:early"],
    attack_surface_ids: ["liquidation:early"]
  };
  plan.threat_goals = [retriedGoal];
  plan.modeled_threat_ids = ["liquidation:early"];
  plan.goal_lanes = plan.goal_lanes.map((lane) =>
    lane.kind === "threat" ? { ...lane, lane_id: "liquidation:early", node_ids: [retriedGoal.node_id] } : lane
  );
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const baseTasksPath = path.join(fixture.runRoot, "smithers", "runtime-base-tasks.json");
  const base = JSON.parse(fs.readFileSync(baseTasksPath, "utf8")) as {
    tasks: CompiledSmithersTask[];
    dynamic_groups: CompiledSmithersDynamicGroup[];
  };
  const materialized = materializeDynamicRuntime({
    runId: fixture.runId,
    projectRoot: fixture.project,
    runRoot: fixture.runRoot,
    graphPath: path.join(fixture.runRoot, "graph.json"),
    tasksPath: path.join(fixture.runRoot, "smithers", "tasks.json"),
    baseGraphPath: path.join(fixture.runRoot, "smithers", "runtime-base-graph.json"),
    baseTasksPath,
    baseTasks: base.tasks,
    groups: base.dynamic_groups,
    readyGroupIds: ["fanout"]
  });
  return materialized.tasks.filter((task) => task.metadata.node.dynamic?.groupNodeId === "fanout");
}

test("explicit source retry prunes the withdrawn generation from run state and keeps observers admitted", async () => {
  const fixture = await createDynamicFixture({ runId: "dynamic-retry-archive", modelFanout: true });
  const planner = plannerSuccessEvidence(fixture);
  const finishedSteps = (tasks: CompiledSmithersTask[], attempt: number): LifecycleStep[] =>
    tasks.map((task) => ({ id: task.smithersNodeId, state: "finished", attempt }));
  const finishedEvents = (tasks: CompiledSmithersTask[], attempt: number): LifecycleEvent[] =>
    tasks.flatMap((task) => [
      { type: "NodeStarted", nodeId: task.smithersNodeId, attempt },
      { type: "NodeFinished", nodeId: task.smithersNodeId, attempt }
    ]);
  for (const task of fixture.generatedTasks) writeFinding(task);
  const generationEvents = [...planner.events, ...finishedEvents(fixture.generatedTasks, 1)];
  setLifecycle(fixture, [...planner.steps, ...finishedSteps(fixture.generatedTasks, 1)], generationEvents);
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  // A model fan-out generation is recorded under its storage ID and under every attempt ID.
  assert.ok(fixture.storageId);
  const generationStateIds = [fixture.storageId, ...fixture.generatedTasks.map((task) => task.attemptId)].sort();
  assert.equal(generationStateIds.length, 3);
  const recorded = readState(fixture);
  for (const nodeId of generationStateIds) assert.equal(recorded.nodes[nodeId]?.status, "succeeded", nodeId);

  // The producer's verifier fails afterwards and the operator retries it. The reopened producer
  // owns the published generation, so the resume withdraws it into the history directory (#1063).
  setLifecycle(
    fixture,
    [
      ...planner.steps,
      { id: fixture.plannerTask.verifierSmithersNodeId, state: "failed", attempt: 1 },
      ...finishedSteps(fixture.generatedTasks, 1)
    ],
    generationEvents,
    { status: "failed", state: "failed" }
  );
  const resumed = await resumeRun({
    projectRoot: fixture.project,
    runId: fixture.runId,
    force: true,
    retryFailed: true,
    env: fixture.env
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.deepEqual(fs.readdirSync(path.join(fixture.runRoot, "dynamic-expansions")), []);
  const historyRoot = path.join(fixture.runRoot, "dynamic-expansion-history");
  const [archiveName, ...otherArchives] = fs.readdirSync(historyRoot);
  assert.ok(archiveName);
  assert.deepEqual(otherArchives, []);
  const retryRecord = JSON.parse(fs.readFileSync(path.join(historyRoot, archiveName, "retry.json"), "utf8")) as {
    group_node_ids?: string[];
    pruned_state_node_ids?: string[];
  };
  assert.deepEqual(retryRecord.group_node_ids, ["fanout"]);
  assert.deepEqual(retryRecord.pruned_state_node_ids, generationStateIds);
  // The join's prompt waits on the group, so it was rendered from the withdrawn generation and is
  // withdrawn with it.
  const joinPromptPath = fixture.joinTask.renderedPromptPath;
  assert.ok(joinPromptPath);
  assert.equal(fs.existsSync(joinPromptPath), false);
  assert.equal(
    fs.existsSync(
      path.join(historyRoot, archiveName, "artifacts", fixture.joinTask.attemptId, path.basename(joinPromptPath))
    ),
    true
  );
  const pruned = readState(fixture);
  for (const nodeId of generationStateIds) assert.equal(pruned.nodes[nodeId], undefined, nodeId);
  for (const nodeId of [fixture.plannerTask.attemptId, "fanout", fixture.joinTask.attemptId]) {
    assert.ok(pruned.nodes[nodeId], nodeId);
  }

  // The runner has reset the producer and is re-running it. Its history still names the withdrawn
  // generation's nodes, and nothing has re-expanded the group yet.
  setLifecycle(
    fixture,
    [{ id: fixture.plannerTask.smithersNodeId, state: "in-progress", attempt: 2 }],
    [...generationEvents, { type: "NodeStarted", nodeId: fixture.plannerTask.smithersNodeId, attempt: 2 }]
  );
  await assertObserversAdmitted(fixture);
  for (const nodeId of generationStateIds) assert.equal(readState(fixture).nodes[nodeId], undefined, nodeId);

  // The reopened producer writes a different plan and the render re-expands the group under
  // different storage IDs while the producer is still running. The withdrawn generation must not
  // shadow the new one anywhere, and every observer stays admitted.
  const regenerated = republishRetriedExpansion(fixture);
  assert.equal(regenerated.length, 2);
  assert.equal(fs.existsSync(joinPromptPath), true);
  const regeneratedStorageId = regenerated[0]?.metadata.node.storageId;
  assert.ok(regeneratedStorageId);
  assert.notEqual(regeneratedStorageId, fixture.storageId);
  await assertObserversAdmitted(fixture);
  const regeneratedState = readState(fixture);
  assert.equal(regeneratedState.nodes[regeneratedStorageId]?.status, "pending");
  for (const task of regenerated) assert.equal(regeneratedState.nodes[task.attemptId]?.status, "pending");
  for (const nodeId of generationStateIds) assert.equal(regeneratedState.nodes[nodeId], undefined, nodeId);
});

test(
  "the next resume completes a source retry whose withdrawal was interrupted after the reset",
  { skip: process.getuid?.() === 0 ? "root ignores the directory permissions this test uses" : false },
  async () => {
    const fixture = await createDynamicFixture({ runId: "dynamic-retry-interrupted" });
    const planner = plannerSuccessEvidence(fixture);
    for (const task of fixture.generatedTasks) writeFinding(task);
    const generationSteps: LifecycleStep[] = fixture.generatedTasks.map((task) => ({
      id: task.smithersNodeId,
      state: "finished",
      attempt: 1
    }));
    const generationEvents: LifecycleEvent[] = [
      ...planner.events,
      ...fixture.generatedTasks.flatMap((task) => [
        { type: "NodeStarted", nodeId: task.smithersNodeId, attempt: 1 },
        { type: "NodeFinished", nodeId: task.smithersNodeId, attempt: 1 }
      ])
    ];
    setLifecycle(fixture, [...planner.steps, ...generationSteps], generationEvents);
    const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
    assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));

    // The producer's verifier fails and the operator retries it. Smithers resets the producer, and then
    // the first move of the withdrawal fails, which leaves the published generation in place.
    const failedLifecycle: LifecycleStep[] = [
      ...planner.steps,
      { id: fixture.plannerTask.verifierSmithersNodeId, state: "failed", attempt: 1 },
      ...generationSteps
    ];
    setLifecycle(fixture, failedLifecycle, generationEvents, { status: "failed", state: "failed" });
    const manifestDir = path.join(fixture.runRoot, "dynamic-expansions");
    const artifactsRoot = path.join(fixture.runRoot, "artifacts");
    fs.chmodSync(artifactsRoot, 0o555);
    let interrupted: Awaited<ReturnType<typeof resumeRun>>;
    try {
      interrupted = await resumeRun({
        projectRoot: fixture.project,
        runId: fixture.runId,
        force: true,
        retryFailed: true,
        env: fixture.env
      });
    } finally {
      fs.chmodSync(artifactsRoot, 0o755);
    }
    assert.equal(interrupted.ok, false);
    assert.match(JSON.stringify(interrupted.diagnostics), /EACCES/u);
    assert.deepEqual(fs.readdirSync(manifestDir).sort(), [".retry-withdrawal.json", "fanout.json"]);

    // Smithers has reset the producer and its dependents, and left the run without an owner, so no
    // task is failed and a later `--retry-failed` would plan no withdrawal. The next resume completes
    // the recorded one before it starts the engine, and the retried producer's new output expands the
    // group again.
    setLifecycle(
      fixture,
      [{ id: fixture.plannerTask.smithersNodeId, state: "pending", attempt: 1 }],
      generationEvents,
      {
        status: "running",
        state: "stale"
      }
    );
    const resumed = await resumeRun({
      projectRoot: fixture.project,
      runId: fixture.runId,
      force: true,
      retryFailed: true,
      env: fixture.env
    });
    assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
    assert.deepEqual(fs.readdirSync(manifestDir), []);
    const historyRoot = path.join(fixture.runRoot, "dynamic-expansion-history");
    const [archiveName, ...otherArchives] = fs.readdirSync(historyRoot);
    assert.ok(archiveName);
    assert.deepEqual(otherArchives, []);
    const retryRecord = JSON.parse(fs.readFileSync(path.join(historyRoot, archiveName, "retry.json"), "utf8")) as {
      group_node_ids?: string[];
    };
    assert.deepEqual(retryRecord.group_node_ids, ["fanout"]);
    for (const task of fixture.generatedTasks) {
      assert.equal(fs.existsSync(task.artifactDir), false, task.attemptId);
      assert.equal(
        fs.existsSync(path.join(historyRoot, archiveName, "artifacts", task.attemptId)),
        true,
        task.attemptId
      );
    }
    const joinPromptPath = fixture.joinTask.renderedPromptPath;
    assert.ok(joinPromptPath);
    assert.equal(fs.existsSync(joinPromptPath), false);
    const regenerated = republishRetriedExpansion(fixture);
    assert.notEqual(regenerated[0]?.metadata.node.storageId, fixture.storageId);
    await assertObserversAdmitted(fixture);
  }
);

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

test("dynamic lifecycle admission rejects graph and task extensions not derived from sealed controls", async () => {
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
});

/**
 * Recover the two literals the refreshed controller compiles in, exactly as the rendered
 * workflow module binds them at `workflow.tsx` `compiledBaseTasks` / `dynamicGroupSpecs`.
 */
function compiledControllerConstants(workflowSource: string): {
  baseTasks: CompiledSmithersTask[];
  groups: CompiledSmithersDynamicGroup[];
  taskSpecs: Array<{ attemptId: string; promptPath?: string }>;
} {
  const read = (name: string, terminator: string): unknown => {
    const opener = `const ${name} = `;
    const start = workflowSource.indexOf(opener);
    assert.notEqual(start, -1, `rendered controller is missing ${name}`);
    const end = workflowSource.indexOf(`;\nconst ${terminator} = `, start);
    assert.notEqual(end, -1, `rendered controller is missing the ${name} terminator`);
    return JSON.parse(workflowSource.slice(start + opener.length, end)) as unknown;
  };
  // `serializedTaskSpecs` ends in `as const;`, which the terminator reader above cannot match.
  const specsOpener = "const serializedTaskSpecs = ";
  const specsStart = workflowSource.indexOf(specsOpener);
  assert.notEqual(specsStart, -1, "rendered controller is missing serializedTaskSpecs");
  const specsEnd = workflowSource.indexOf(" as const;", specsStart);
  assert.ok(specsEnd > specsStart, "rendered controller is missing the serializedTaskSpecs terminator");
  return {
    baseTasks: read("compiledBaseTasks", "dynamicGroupSpecs") as CompiledSmithersTask[],
    groups: read("dynamicGroupSpecs", "maxDynamicNodes") as CompiledSmithersDynamicGroup[],
    taskSpecs: JSON.parse(workflowSource.slice(specsStart + specsOpener.length, specsEnd)) as Array<{
      attemptId: string;
      promptPath?: string;
    }>
  };
}

test("refreshed controller compiles the pre-expansion base task set", async () => {
  const fixture = await createDynamicFixture({ runId: "refresh-base-tasks" });
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);

  // The run has expanded once, so the LIVE manifest -- the document `resume --refresh-controller`
  // reads off disk -- now carries the generated tasks alongside the static ones.
  const tasksPath = path.join(fixture.runRoot, "smithers", "tasks.json");
  const liveTaskDocument = parseSmithersTaskManifestBytes(fs.readFileSync(tasksPath));
  const generated = fixture.generatedTasks[0]!;
  assert.equal(
    liveTaskDocument.tasks.some((task) => task.attemptId === generated.attemptId),
    true,
    "fixture did not expand a dynamic group"
  );
  const basePath = path.join(fixture.runRoot, "smithers", "runtime-base-tasks.json");
  assert.equal(fs.existsSync(basePath), true, "sealed dynamic base task manifest is missing");

  const workflowPath = renderCurrentSmithersController({
    projectRoot: fixture.project,
    layout: evidence.layout,
    smithersRunId: evidence.smithersRunId,
    tasks: liveTaskDocument,
    config: JSON.parse(resolvedConfig.contents.toString("utf8"))
  });
  const compiled = compiledControllerConstants(fs.readFileSync(workflowPath, "utf8"));

  // The controller's compiled constant is the dynamic runtime's `baseTasks`. Compiling the
  // already-generated tasks into it reserves their own attempt IDs against the very expansion
  // that produced them, so the next materialization dies with DYNAMIC_NODE_ID_COLLISION.
  assert.equal(
    compiled.baseTasks.some((task) => task.metadata.node.dynamic !== undefined),
    false,
    "refreshed controller compiled runtime-generated tasks into its base task set"
  );

  // Replay the workflow's own call with the refreshed controller's literals.
  const rematerialized = materializeDynamicRuntime({
    runId: fixture.runId,
    projectRoot: fixture.project,
    runRoot: fixture.runRoot,
    graphPath: path.join(fixture.runRoot, "graph.json"),
    tasksPath,
    baseTasks: compiled.baseTasks,
    groups: compiled.groups,
    readyGroupIds: ["fanout"]
  });
  assert.deepEqual(
    rematerialized.tasks.map((task) => task.attemptId).sort(),
    liveTaskDocument.tasks.map((task) => task.attemptId).sort(),
    "refreshed controller re-derived a different task set than the run already published"
  );

  // The controls this materialization republished must also pass the admission check that every
  // gated lifecycle command runs first. The refreshed controller publishes the SEALED launch path
  // into `tasks.json`, so `verifyDynamicRuntimeMaterialization`'s re-derivation from the sealed
  // `controls/runtime-base-tasks.json` matches byte-for-byte.
  const readmitted = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(readmitted.ok, true, "diagnostics" in readmitted ? JSON.stringify(readmitted.diagnostics) : "");

  // The task spec binds the same path: the run's own prompt file is what the agent reads.
  const plan = readRunPlanDocument(path.join(fixture.runRoot, "plan.json"), fixture.runId);
  const planned = plan.rendered_prompts.find((prompt) => prompt.attempt_id === "planner");
  assert.ok(planned, "fixture has no planner prompt plan row");
  const plannerBase = compiled.baseTasks.find((task) => task.attemptId === planned.attempt_id);
  assert.ok(plannerBase);
  assert.equal(
    plannerBase.renderedPromptPath,
    planned.rendered_prompt_path,
    "compiled base task must carry the sealed launch path"
  );
  assert.equal(
    compiled.taskSpecs.find((spec) => spec.attemptId === planned.attempt_id)?.promptPath,
    planned.rendered_prompt_path,
    "task spec must bind the run's own prompt file"
  );

  // Selecting the base set drops only the runtime-generated tasks. A PLANNED task whose prompt is
  // deferred behind a dynamic ancestor belongs to the base set and must survive.
  assert.ok(
    compiled.baseTasks.some(
      (task) => task.metadata.node.dynamic === undefined && (task.deferredPromptGroups ?? []).length > 0
    ),
    "base task set lost its deferred-prompt planned task"
  );
  assert.deepEqual(
    compiled.baseTasks.map((task) => task.attemptId).sort(),
    liveTaskDocument.tasks
      .filter((task) => task.metadata.node.dynamic === undefined)
      .map((task) => task.attemptId)
      .sort()
  );
});

/**
 * `resume --refresh-controller` renders the current controller over the run's own prompt files. An
 * operator's edit of a static task that has not run therefore reaches the refreshed controller, and
 * the launch copy in `prompt-snapshots/` is never read while that file exists, edited or not.
 */
test("--refresh-controller keeps a hand-edited static prompt", async () => {
  const fixture = await createDynamicFixture({ runId: "refresh-edited-static-prompt" });
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);

  const plan = readRunPlanDocument(path.join(fixture.runRoot, "plan.json"), fixture.runId);
  const planned = plan.rendered_prompts.find((prompt) => prompt.attempt_id === "planner");
  assert.ok(planned, "fixture has no planner prompt plan row");
  const edited = `${fs.readFileSync(planned.rendered_prompt_path, "utf8")}\nOperator note: plan the overdue path first.\n`;
  fs.writeFileSync(planned.rendered_prompt_path, edited, "utf8");
  fs.appendFileSync(path.join(fixture.runRoot, planned.rendered_prompt_snapshot_path), "\nAn edited launch copy.\n");

  const tasksPath = path.join(fixture.runRoot, "smithers", "tasks.json");
  const workflowPath = renderCurrentSmithersController({
    projectRoot: fixture.project,
    layout: evidence.layout,
    smithersRunId: evidence.smithersRunId,
    tasks: parseSmithersTaskManifestBytes(fs.readFileSync(tasksPath)),
    config: JSON.parse(resolvedConfig.contents.toString("utf8"))
  });
  const compiled = compiledControllerConstants(fs.readFileSync(workflowPath, "utf8"));
  assert.equal(
    compiled.taskSpecs.find((spec) => spec.attemptId === planned.attempt_id)?.promptPath,
    planned.rendered_prompt_path
  );
  assert.equal(fs.readFileSync(planned.rendered_prompt_path, "utf8"), edited);
});

/**
 * The production repair shape, end to end. A run damaged by a refresh on the broken build has the
 * rebound `prompt-snapshots/` path in its live `smithers/tasks.json` and an INTACT sealed
 * `controls/runtime-base-tasks.json` -- the only shape a sealed dynamic run can actually be in.
 * Admission is therefore permanently invalid, and because `submitSmithersContinuation` never calls
 * `readLinkedWorkflowEvidence`, `resume --refresh-controller` is the one command still able to run.
 * One refresh plus the materialization its first tick performs must restore admission.
 */
test("a refresh repairs control evidence a rebound task manifest permanently invalidated", async () => {
  const fixture = await createDynamicFixture({ runId: "refresh-repairs-evidence" });
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);
  const { layout, smithersRunId } = evidence;
  const config = JSON.parse(resolvedConfig.contents.toString("utf8"));

  const plan = readRunPlanDocument(path.join(fixture.runRoot, "plan.json"), fixture.runId);
  const planned = plan.rendered_prompts.find((prompt) => prompt.attempt_id === "planner");
  assert.ok(planned, "fixture has no planner prompt plan row");

  // Exactly what a refresh on the broken build left behind: the rebound snapshot path published
  // into the live manifest, with the sealed base manifest untouched.
  const tasksPath = path.join(fixture.runRoot, "smithers", "tasks.json");
  const basePath = path.join(fixture.runRoot, "smithers", "runtime-base-tasks.json");
  assert.equal(fs.existsSync(basePath), true, "sealed dynamic base task manifest is missing");
  const damaged = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as {
    tasks: Array<{ attemptId: string; renderedPromptPath?: string }>;
  };
  const damagedTask = damaged.tasks.find((task) => task.attemptId === planned.attempt_id);
  assert.ok(damagedTask);
  assert.equal(damagedTask.renderedPromptPath, planned.rendered_prompt_path);
  damagedTask.renderedPromptPath = path.join(fixture.runRoot, planned.rendered_prompt_snapshot_path);
  fs.writeFileSync(tasksPath, `${JSON.stringify(damaged, null, 2)}\n`, "utf8");

  // Every gated lifecycle command -- sync, pause, replay, fork -- now fails, and stays failed.
  const damagedEvidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(damagedEvidence.ok, false, "a rebound task manifest should invalidate control evidence");
  assert.ok(
    !damagedEvidence.ok &&
      damagedEvidence.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "WORKFLOW_CONTROL_EVIDENCE_INVALID" &&
          /published dynamic runtime controls no longer re-derive from their sealed base/u.test(diagnostic.message)
      ),
    "diagnostics" in damagedEvidence ? JSON.stringify(damagedEvidence.diagnostics) : ""
  );

  // The repair: one `resume --refresh-controller`, then the materialization its first tick runs.
  const workflowPath = renderCurrentSmithersController({
    projectRoot: fixture.project,
    layout,
    smithersRunId,
    tasks: parseSmithersTaskManifestBytes(fs.readFileSync(tasksPath)),
    config
  });
  const compiled = compiledControllerConstants(fs.readFileSync(workflowPath, "utf8"));
  materializeDynamicRuntime({
    runId: fixture.runId,
    projectRoot: fixture.project,
    runRoot: fixture.runRoot,
    graphPath: path.join(fixture.runRoot, "graph.json"),
    tasksPath,
    baseTasks: compiled.baseTasks,
    groups: compiled.groups,
    readyGroupIds: ["fanout"]
  });

  const repaired = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(repaired.ok, true, "diagnostics" in repaired ? JSON.stringify(repaired.diagnostics) : "");
  const republished = parseSmithersTaskManifestBytes(fs.readFileSync(tasksPath));
  assert.equal(
    republished.tasks.find((task) => task.attemptId === planned.attempt_id)?.renderedPromptPath,
    planned.rendered_prompt_path,
    "repair must republish the sealed launch path into the live manifest"
  );
  assert.equal(
    compiled.taskSpecs.find((spec) => spec.attemptId === planned.attempt_id)?.promptPath,
    planned.rendered_prompt_path,
    "the repaired controller must bind the run's own prompt file"
  );
});

const REBUILT_VALIDATOR_REFRESH = String.raw`
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const artifacts = await import(input.artifactsModule);
const { renderCurrentSmithersController } = await import(input.smithersModule);
const workflowPath = renderCurrentSmithersController({
  projectRoot: input.project,
  layout: artifacts.layoutForRunRoot(input.runRoot),
  smithersRunId: input.smithersRunId,
  tasks: artifacts.parseSmithersTaskManifestBytes(fs.readFileSync(input.tasksPath)),
  config: input.config
});
process.stdout.write(JSON.stringify({ validatorBuild: artifacts.VALIDATOR_BUILD_IDENTITY, workflowPath }));
`;

/**
 * #921: `resume --refresh-controller` re-renders the workflow with the operator's current build, and a
 * rebuild that changed only the validator build must not change what that workflow records for the
 * run's outputs. Its first tick republishes the runtime task plan that every gated command re-derives
 * from the sealed base, and its verifier copies each declared output into the marker that
 * synchronization compares with `graph.json`. The refresh runs in a child whose rebuilt validator
 * module yields a different identity; the run was launched by this process.
 */
test("a controller refresh by a rebuilt validator keeps the run's recorded output bindings", async () => {
  const fixture = await createDynamicFixture({ runId: "refresh-rebuilt-validator" });
  const evidence = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(evidence.ok, true, "diagnostics" in evidence ? JSON.stringify(evidence.diagnostics) : "");
  if (!evidence.ok) return;
  const resolvedConfig = evidence.verifiedControl.executionFiles.find(
    (file) => file.snapshotPath === "controls/resolved-config.json"
  );
  assert.ok(resolvedConfig);
  const tasksPath = path.join(fixture.runRoot, "smithers", "tasks.json");
  const refreshed = runWithRebuiltValidator(
    REBUILT_VALIDATOR_REFRESH,
    {
      artifactsModule: ARTIFACTS_MODULE_URL,
      smithersModule: new URL("../src/smithers.js", import.meta.url).href,
      project: fixture.project,
      runRoot: fixture.runRoot,
      smithersRunId: evidence.smithersRunId,
      tasksPath,
      config: JSON.parse(resolvedConfig.contents.toString("utf8")) as unknown
    },
    fixture.project
  ) as { validatorBuild: string; workflowPath: string };
  assert.notEqual(refreshed.validatorBuild, VALIDATOR_BUILD_IDENTITY, "the refresh must run a rebuilt validator");
  const compiled = compiledControllerConstants(fs.readFileSync(refreshed.workflowPath, "utf8"));

  // Replay the refreshed workflow's first-tick materialization with its own literals.
  const rematerialized = materializeDynamicRuntime({
    runId: fixture.runId,
    projectRoot: fixture.project,
    runRoot: fixture.runRoot,
    graphPath: path.join(fixture.runRoot, "graph.json"),
    tasksPath,
    baseTasks: compiled.baseTasks,
    groups: compiled.groups,
    readyGroupIds: ["fanout"]
  });
  const readmitted = await readLinkedWorkflowEvidence(fixture.project, fixture.runId);
  assert.equal(readmitted.ok, true, "diagnostics" in readmitted ? JSON.stringify(readmitted.diagnostics) : "");

  // A generated attempt the refreshed workflow verifies: its marker records the refreshed declaration.
  const generated = rematerialized.tasks.find((task) => task.attemptId === fixture.generatedTasks[0]?.attemptId);
  assert.ok(generated);
  writeFinding(generated);
  const planner = plannerSuccessEvidence(fixture);
  setLifecycle(
    fixture,
    [...planner.steps, { id: generated.smithersNodeId, state: "finished", attempt: 1 }],
    [
      ...planner.events,
      { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 1 },
      { type: "NodeFinished", nodeId: generated.smithersNodeId, attempt: 1 }
    ]
  );
  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  assert.equal(readState(fixture).nodes[generated.attemptId]?.status, "succeeded");
});
