import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunState } from "@ultrafuzz/artifacts";

import { initProject, materializeDynamicRuntime, startRun, syncRun } from "../src/index.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask } from "../src/smithers.js";

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

function writeDynamicProject(project: string, modelFanout: boolean): void {
  initProject({ projectRoot: project, force: true });
  writePrompt(project, "dynamic/planner.md", "dynamic-planner", "Write the plan to {{artifact_path}}/plan.json.");
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    "Your /goal is {{item.goal_prompt}} using threat model threat {{liquidation:overdue}}."
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
        contract: ultrafuzz/json-object@1
        primary: true
  - id: fanout
    kind: agentic
    prompt: dynamic/worker.md
    depends_on: [planner]
${modelFanout ? "    model_profiles: [default, claude]\n" : ""}    dynamic:
      from:
        node: planner
        path: $.goals
      key: id
      node_id: "dynamic:threat:{{ item.id }}"
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@1
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
  const binDir = path.join(project, "fake-bin");
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
  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_BIN: smithers,
      ULTRAFUZZ_PRICING_CATALOG_URL: "off"
    },
    inspectPath,
    eventsPath
  };
}

async function createDynamicFixture(input: {
  runId: string;
  goals?: Array<Record<string, unknown>>;
  modelFanout?: boolean;
}): Promise<DynamicFixture> {
  const project = tempProject();
  writeDynamicProject(project, input.modelFanout ?? false);
  const lifecycle = lifecycleEnvironment(project);
  const started = await startRun({ projectRoot: project, runId: input.runId, maxConcurrency: 2, env: lifecycle.env });
  assert.equal(started.ok, true, JSON.stringify(started.diagnostics));
  const runRoot = started.value!.run_root;
  const tasksPath = path.join(runRoot, "smithers", "tasks.json");
  const graphPath = path.join(runRoot, "graph.json");
  const taskDocument = JSON.parse(fs.readFileSync(tasksPath, "utf8")) as {
    smithers_run_id: string;
    tasks: CompiledSmithersTask[];
    dynamic_groups: CompiledSmithersDynamicGroup[];
  };
  const goals = input.goals ?? [
    {
      id: "liquidation.overdue",
      goal_prompt: "find any vulnerability affecting overdue liquidation",
      replacements: { "liquidation:overdue": "the persisted liquidation threat model" }
    }
  ];
  const plannerArtifactDir = path.join(runRoot, "artifacts", "planner");
  fs.mkdirSync(plannerArtifactDir, { recursive: true });
  fs.writeFileSync(path.join(plannerArtifactDir, "plan.json"), `${JSON.stringify({ goals }, null, 2)}\n`, "utf8");
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
        started: "2026-08-04T00:00:00.000Z"
      },
      runState: {
        runId: workflowRunId,
        computedAt: "2026-08-04T00:00:03.000Z",
        state: "running"
      },
      steps
    }
  };
}

function workflowEvents(workflowRunId: string, events: LifecycleEvent[]): string {
  const base = Date.parse("2026-08-04T00:00:00.000Z");
  return `${events
    .map((event, index) => {
      const timestampMs = base + index * 100;
      const payload: Record<string, unknown> = { type: event.type, runId: workflowRunId, timestampMs };
      if (event.nodeId !== undefined) payload.nodeId = event.nodeId;
      if (event.attempt !== undefined) payload.attempt = event.attempt;
      if (event.error !== undefined) payload.error = event.error;
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
          schema_version: "1.0",
          id: "overdue-liquidation",
          title: "Fixed-term liquidation can occur before overdue",
          status: "candidate",
          severity_guess: "high",
          confidence: "high",
          summary: "A boundary check permits liquidation before the debt is overdue.",
          producer_node_id: "dynamic:spoofed"
        }
      ],
      null,
      2
    )}\n`,
    "utf8"
  );
}

function readState(fixture: DynamicFixture): RunState {
  return JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "state.json"), "utf8")) as RunState;
}

function readUsageLedger(fixture: DynamicFixture): Array<{ attempt_id?: string; node_id?: string }> {
  const ledgerPath = path.join(fixture.runRoot, "usage.jsonl");
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as { attempt_id?: string });
}

function readLedger(fixture: DynamicFixture): Array<Record<string, unknown>> {
  const ledgerPath = path.join(fixture.runRoot, "attempts.jsonl");
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8").trim();
  return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

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
          totalTokens: 15,
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
  assert.ok(interrupted.diagnostics.some((diagnostic) => diagnostic.code === "WORKFLOW_SYNC_DEADLINE_EXCEEDED"));
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(runEventsPath, "utf8"), eventsBefore);

  const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  const state = readState(fixture);
  assert.equal(state.nodes[fixture.storageId!]?.status, "succeeded");
  assert.equal(state.nodes[fixture.storageId!]?.provenance?.producer_node_id, fixture.generatedNodeId);
  // `source_node_id` is the one key both sides must agree on (#364): it is the term #183 uses and
  // exactly what the eval reader looks for on a dynamic node's provenance. The nested camelCase
  // record stays alongside it for the expansion key, item digest and manifest path.
  assert.equal(state.nodes[fixture.storageId!]?.provenance?.source_node_id, "planner");
  assert.equal(
    (state.nodes[fixture.storageId!]?.provenance?.dynamic as { sourceNodeId?: string } | undefined)?.sourceNodeId,
    "planner"
  );
  // A static node was never expanded from anything, so it must not claim a source.
  assert.equal(state.nodes.planner?.provenance?.source_node_id, undefined);

  // Per-lane cost is a join from the usage ledger onto `state.json`, so the ledger this real sync
  // wrote must carry the identity `state.json` is keyed by. `attempt_id` cannot serve: it is a
  // digest, and the usage event names the workflow task (`node:<attempt>`), not the state node.
  const usageLedger = readUsageLedger(fixture);
  assert.equal(usageLedger.length, 1);
  assert.match(usageLedger[0]?.attempt_id ?? "", /^usage-attempt-[0-9a-f]{32}$/u);
  assert.equal(usageLedger[0]?.node_id, fixture.storageId);
  assert.ok(state.nodes[usageLedger[0]?.node_id ?? ""] !== undefined);
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
  assert.deepEqual(childSyncEvent?.provenance, {
    producer_node_id: fixture.generatedNodeId,
    concrete_node_id: fixture.generatedNodeId,
    strategy_attempt_id: generated.attemptId,
    storage_id: fixture.storageId,
    dynamic: generated.metadata.node.dynamic
  });
  const runMetadata = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "run.json"), "utf8")) as {
    accounting?: {
      current?: {
        total_tokens?: number;
        event_count?: number;
        attempt_ids?: string[];
        models?: string[];
      };
    };
  };
  assert.equal(runMetadata.accounting?.current?.total_tokens, 15);
  assert.equal(runMetadata.accounting?.current?.event_count, 1);
  assert.equal(runMetadata.accounting?.current?.attempt_ids?.length, 1);
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
      [...planner.steps, { id: generated.smithersNodeId, state: outcome, attempt: 1 }],
      [...planner.events, { type: "NodeStarted", nodeId: generated.smithersNodeId, attempt: 1 }, terminalEvent]
    );

    const synced = await syncRun({ projectRoot: fixture.project, runId: fixture.runId, env: fixture.env });
    assert.equal(synced.ok, true, `${outcome}: ${JSON.stringify(synced.diagnostics)}`);
    const state = readState(fixture);
    assert.equal(state.nodes[fixture.storageId!]?.status, outcome, outcome);
    assert.equal(state.nodes.fanout?.status, outcome, outcome);
    assert.equal(state.nodes["strict-join"]?.wait_reason, "dependency", outcome);
    assert.equal(
      readLedger(fixture).find((entry) => entry.strategy_attempt_id === generated.attemptId)?.outcome,
      outcome,
      outcome
    );
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
  assert.equal(state.nodes[fixture.storageId!]?.provenance?.producer_node_id, fixture.generatedNodeId);
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
