import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cancelRun,
  diagnoseProject,
  diagnoseRun,
  getRunTimeline,
  getWorkflowNode,
  initProject,
  listRunSnapshots,
  queryWorkflowEvents,
  startRun,
  validateProject,
  watchWorkflowEvents,
  watchWorkflowNode,
  type WorkflowLifecycleEvent
} from "../src/index.js";
import { SMITHERS_COMPATIBILITY_PATCHES } from "../src/smithers.js";
import { SMITHERS_ORCHESTRATOR_BIN_PATH, SMITHERS_ORCHESTRATOR_VERSION } from "../src/smithers-package.js";

const WORKFLOW_RUN_ID = "ultrafuzz-inspect-run";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-inspect-"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeSmallTopology(project: string, requiredCommand?: string): void {
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
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
${requiredCommand === undefined ? "" : `    required_commands:\n      - ${requiredCommand}\n`}
    depends_on:
      - __start__
    outputs:
      - path: setup/project-discovery.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: findings.json
        contract: ultrafuzz/findings@1
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

interface FakeInspectionFixtures {
  why?: unknown;
  nodeWatchLines?: string;
  timeline?: unknown;
  snapshots?: unknown;
  node?: unknown;
  events?: string;
  cancelStatus?: string;
  cancelExitCode?: number;
}

/**
 * A fake workflow runner that answers the inspection and lifecycle commands
 * with the exact JSON shapes the pinned engine emits.
 */
function fakeInspectionEnv(project: string, fixtures: FakeInspectionFixtures): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const files = {
    why: path.join(project, "fake-why.json"),
    timeline: path.join(project, "fake-timeline.json"),
    snapshots: path.join(project, "fake-snapshots.json"),
    node: path.join(project, "fake-node.json"),
    events: path.join(project, "fake-events.ndjson")
  };
  fs.writeFileSync(files.why, `${JSON.stringify({ data: fixtures.why ?? {} })}\n`, "utf8");
  fs.writeFileSync(files.timeline, `${JSON.stringify(fixtures.timeline ?? { timeline: { frames: [] } })}\n`, "utf8");
  fs.writeFileSync(files.snapshots, `${JSON.stringify(fixtures.snapshots ?? { snapshots: [] })}\n`, "utf8");
  fs.writeFileSync(files.node, `${JSON.stringify({ data: fixtures.node ?? {} })}\n`, "utf8");
  fs.writeFileSync(files.events, fixtures.events ?? "", "utf8");
  const nodeWatchPath = path.join(project, "fake-node-watch.ndjson");
  if (fixtures.nodeWatchLines !== undefined) {
    fs.writeFileSync(nodeWatchPath, fixtures.nodeWatchLines, "utf8");
  }

  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"; fi',
      'case "$1" in',
      "  why)",
      `    cat ${shellQuote(files.why)}`,
      "    ;;",
      "  timeline)",
      `    cat ${shellQuote(files.timeline)}`,
      "    ;;",
      "  snapshots)",
      `    cat ${shellQuote(files.snapshots)}`,
      "    ;;",
      "  node)",
      '    if [ -n "$SMITHERS_FAKE_NODE_WATCH" ]; then',
      '      cat "$SMITHERS_FAKE_NODE_WATCH"',
      "    else",
      `      cat ${shellQuote(files.node)}`,
      "    fi",
      "    ;;",
      "  events)",
      `    cat ${shellQuote(files.events)}`,
      "    ;;",
      "  cancel)",
      `    printf '%s\\n' '{"data":{"status":"${fixtures.cancelStatus ?? "cancel-requested"}"}}'`,
      `    exit ${fixtures.cancelExitCode ?? 2}`,
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
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    ...(fixtures.nodeWatchLines === undefined ? {} : { SMITHERS_FAKE_NODE_WATCH: nodeWatchPath })
  };
}

async function launchedProject(
  fixtures: FakeInspectionFixtures
): Promise<{ project: string; env: Record<string, string | undefined>; runRoot: string }> {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const env = fakeInspectionEnv(project, fixtures);
  const run = await startRun({ projectRoot: project, runId: "inspect-run", env });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  return { project, env, runRoot: run.value!.run_root };
}

function smithersLog(project: string): string {
  return fs.readFileSync(path.join(project, "smithers-commands.log"), "utf8");
}

function assertNoEngineBranding(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /smithers/iu);
}

test("cancelRun keeps the run nonterminal for a durable cancel request", async () => {
  const { project, env, runRoot } = await launchedProject({ cancelStatus: "cancel-requested" });

  const requested = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(requested.ok, true, JSON.stringify(requested.diagnostics));
  assert.equal(requested.value?.status, "cancel-requested");
  assert.equal(requested.value?.submitted, true);
  assert.equal(requested.value?.confirmed, false);
  assert.equal(requested.value?.workflow_run_id, WORKFLOW_RUN_ID);
  assertNoEngineBranding(requested.value);
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status: string };
  assert.equal(state.status, "running");
  const events = fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8");
  assert.match(events, /workflow-cancel-requested/u);
  assert.doesNotMatch(events, /workflow-cancel-confirmed/u);
  assert.match(smithersLog(project), new RegExp(`cancel ${WORKFLOW_RUN_ID} --format json`, "u"));
});

test("cancelRun persists the canonical canceled state once the engine confirms", async () => {
  const { project, env, runRoot } = await launchedProject({ cancelStatus: "cancelled" });

  const confirmed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(confirmed.ok, true, JSON.stringify(confirmed.diagnostics));
  assert.equal(confirmed.value?.status, "canceled");
  assert.equal(confirmed.value?.confirmed, true);
  assert.equal(confirmed.value?.submitted, false);
  assert.equal(confirmed.value?.run_status, "canceled");
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as {
    status: string;
    finished_at?: string;
  };
  assert.equal(state.status, "canceled");
  assert.equal(typeof state.finished_at, "string");
  assert.match(fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8"), /workflow-cancel-confirmed/u);
});

test("cancelRun reports a stable diagnostic when the engine command fails", async () => {
  const { project, env } = await launchedProject({});
  fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nprintf '%s\\n' 'boom' >&2\nexit 9\n", "utf8");
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  const failed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostics[0]?.code, "WORKFLOW_CANCEL_FAILED");
  assertNoEngineBranding(failed.diagnostics);
});

test("lifecycle commands reject a missing product run and an unlinked run", async () => {
  const { project, env, runRoot } = await launchedProject({});

  const missing = await diagnoseRun({ projectRoot: project, runId: "absent-run", env });
  assert.equal(missing.ok, false);
  assert.equal(missing.diagnostics[0]?.code, "RUN_METADATA_MISSING");

  const metadataPath = path.join(runRoot, "run.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  delete metadata.workflow;
  delete metadata.workflow_ids;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

  for (const command of [cancelRun, diagnoseRun, getRunTimeline, listRunSnapshots, queryWorkflowEvents]) {
    const unlinked = await command({ projectRoot: project, runId: "inspect-run", env });
    assert.equal(unlinked.ok, false);
    assert.equal(unlinked.diagnostics[0]?.code, "WORKFLOW_RUN_ID_MISSING");
  }
});

test("diagnoseRun adapts the engine diagnosis without engine-branded public text", async () => {
  const { project, env } = await launchedProject({
    why: {
      runId: WORKFLOW_RUN_ID,
      status: "running",
      summary: "1 node waiting for approval; run `smithers why` for detail",
      generatedAtMs: 1_700_000_000_000,
      currentNodeId: "node:project-discovery",
      information: ["smithers recorded 1 stale heartbeat"],
      blockers: [
        {
          kind: "waiting-approval",
          nodeId: "node:project-discovery",
          iteration: 0,
          reason: "waiting on a human approval",
          waitingSince: 1_699_999_000_000,
          unblocker: "smithers approve",
          attempt: 2,
          maxAttempts: 3
        },
        {
          kind: "side-effect-boundary-crossed",
          nodeId: "node:project-discovery",
          iteration: null,
          reason: "side effect boundary crossed",
          waitingSince: 1_699_999_500_000,
          unblocker: "review the boundary"
        }
      ]
    }
  });

  const diagnosis = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.diagnostics));
  assert.equal(diagnosis.value?.workflow_status, "running");
  assert.equal(diagnosis.value?.current_node_id, "node:project-discovery");
  assert.equal(diagnosis.value?.summary, "1 node waiting for approval; run `ultrafuzz why` for detail");
  assert.equal(diagnosis.value?.notes[0], "workflow runner recorded 1 stale heartbeat");
  assert.equal(diagnosis.value?.blockers[0]?.kind, "waiting-approval");
  assert.equal(diagnosis.value?.blockers[0]?.attempt, 2);
  assert.equal(diagnosis.value?.blockers[0]?.max_attempts, 3);
  assert.equal(diagnosis.value?.blockers[0]?.unblocker, "workflow runner approve");
  assert.equal(diagnosis.value?.blockers[0]?.waiting_since, new Date(1_699_999_000_000).toISOString());
  assert.equal(diagnosis.value?.blockers[1]?.kind, "side-effect-boundary");
  assert.equal(diagnosis.value?.blockers[1]?.iteration, null);
  assertNoEngineBranding(diagnosis.value);
  assert.match(smithersLog(project), new RegExp(`why ${WORKFLOW_RUN_ID} --format json`, "u"));
});

test("diagnoseRun rejects an unexpected engine response", async () => {
  const { project, env } = await launchedProject({});
  fs.writeFileSync(path.join(project, "fake-why.json"), "not json\n", "utf8");

  const diagnosis = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.diagnostics.at(-1)?.code, "WORKFLOW_DIAGNOSIS_INVALID");
});

test("getRunTimeline adapts frames and fork lineage in tree mode", async () => {
  const { project, env } = await launchedProject({
    timeline: {
      timeline: {
        runId: WORKFLOW_RUN_ID,
        branch: "main",
        frames: [
          { frameNo: 1, createdAtMs: 1_700_000_000_000, contentHash: "hash-1", forks: [] },
          {
            frameNo: 4,
            createdAtMs: 1_700_000_600_000,
            contentHash: "hash-4",
            forks: [{ runId: `${WORKFLOW_RUN_ID}-forked`, branchLabel: "retry", forkDescription: "smithers fork" }]
          }
        ],
        children: [
          {
            runId: `${WORKFLOW_RUN_ID}-forked`,
            branch: "retry",
            frames: [{ frameNo: 5, createdAtMs: 1_700_000_700_000, contentHash: "hash-5", forks: [] }],
            children: []
          }
        ]
      }
    }
  });

  const timeline = await getRunTimeline({ projectRoot: project, runId: "inspect-run", tree: true, env });

  assert.equal(timeline.ok, true, JSON.stringify(timeline.diagnostics));
  assert.equal(timeline.value?.tree, true);
  assert.equal(timeline.value?.frames.length, 2);
  assert.equal(timeline.value?.latest_frame, 4);
  assert.equal(timeline.value?.frames[0]?.created_at, new Date(1_700_000_000_000).toISOString());
  assert.equal(timeline.value?.frames[1]?.forks[0]?.branch_label, "retry");
  assert.equal(timeline.value?.frames[1]?.forks[0]?.description, "`ultrafuzz fork`");
  assert.equal(timeline.value?.lineage.length, 2);
  assert.equal(timeline.value?.lineage[1]?.depth, 1);
  assert.equal(timeline.value?.lineage[1]?.frames[0]?.frame, 5);
  assert.match(smithersLog(project), new RegExp(`timeline ${WORKFLOW_RUN_ID} --tree --json`, "u"));
});

test("getRunTimeline stays read-only and omits --tree by default", async () => {
  const { project, env, runRoot } = await launchedProject({
    timeline: { timeline: { runId: WORKFLOW_RUN_ID, branch: null, frames: [], children: [] } }
  });
  const eventsBefore = fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8");

  const timeline = await getRunTimeline({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(timeline.ok, true, JSON.stringify(timeline.diagnostics));
  assert.equal(timeline.value?.frames.length, 0);
  assert.equal(timeline.value?.latest_frame, null);
  assert.doesNotMatch(smithersLog(project), /--tree/u);
  assert.equal(fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8"), eventsBefore);
});

test("listRunSnapshots adapts the checkpoint list", async () => {
  const { project, env } = await launchedProject({
    snapshots: {
      snapshots: [
        {
          seq: 3,
          nodeId: "node:project-discovery",
          iteration: 0,
          attempt: 1,
          tier: 1,
          source: "node-finish",
          label: null,
          commitId: "commit-abc",
          operationId: "op-abc",
          cwd: "/workspace",
          createdAtMs: 1_700_000_100_000
        }
      ]
    }
  });

  const snapshots = await listRunSnapshots({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(snapshots.ok, true, JSON.stringify(snapshots.diagnostics));
  assert.equal(snapshots.value?.snapshots.length, 1);
  assert.equal(snapshots.value?.snapshots[0]?.sequence, 3);
  assert.equal(snapshots.value?.snapshots[0]?.tier, 1);
  assert.equal(snapshots.value?.snapshots[0]?.created_at, new Date(1_700_000_100_000).toISOString());
  // Commit and workspace identifiers stay internal to the engine.
  assert.equal("commit_id" in (snapshots.value?.snapshots[0] ?? {}), false);
  assert.equal("cwd" in (snapshots.value?.snapshots[0] ?? {}), false);
  assert.match(smithersLog(project), new RegExp(`snapshots ${WORKFLOW_RUN_ID} --json`, "u"));
});

test("queryWorkflowEvents returns a bounded lifecycle array and never asks for raw chunks", async () => {
  const { project, env } = await launchedProject({
    events: [
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 1,
        timestampMs: 1_700_000_000_000,
        type: "node.started",
        payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1, state: "in-progress" }
      }),
      "not json",
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 2,
        timestampMs: 1_700_000_060_000,
        type: "run.finished",
        payload: { status: "smithers finished the run" }
      }),
      ""
    ].join("\n")
  });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 50 });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.limit, 50);
  assert.equal(events.value?.truncated, false);
  assert.equal(events.value?.events.length, 2);
  assert.equal(events.value?.events[0]?.category, "node");
  assert.equal(events.value?.events[0]?.node_id, "node:project-discovery");
  assert.equal(events.value?.events[0]?.attempt, 1);
  assert.equal(events.value?.events[0]?.timestamp, new Date(1_700_000_000_000).toISOString());
  assert.equal(events.value?.events[1]?.detail, "workflow runner finished the run");
  assertNoEngineBranding(events.value);
  const log = smithersLog(project);
  assert.match(log, new RegExp(`events ${WORKFLOW_RUN_ID} --limit 50 --json`, "u"));
  assert.doesNotMatch(log, /--raw/u);
  assert.doesNotMatch(log, /--watch/u);
});

test("queryWorkflowEvents caps the limit and reports truncation", async () => {
  const lines = Array.from({ length: 5 }, (_, index) =>
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "node.progress",
      payload: { nodeId: "node:project-discovery" }
    })
  );
  const { project, env } = await launchedProject({ events: lines.join("\n") });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 2 });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.events.length, 2);
  assert.equal(events.value?.truncated, true);
  assert.match(smithersLog(project), /--limit 2/u);

  const capped = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 10_000_000 });
  assert.equal(capped.ok, true, JSON.stringify(capped.diagnostics));
  assert.match(smithersLog(project), /--limit 2000/u);
});

test("queryWorkflowEvents forwards node, type, since, and history filters", async () => {
  const { project, env } = await launchedProject({ events: "" });

  const events = await queryWorkflowEvents({
    projectRoot: project,
    runId: "inspect-run",
    env,
    nodeId: "node:project-discovery",
    type: "node",
    since: "5m",
    history: true,
    limit: 25
  });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.match(
    smithersLog(project),
    /events ultrafuzz-inspect-run --node node:project-discovery --type node --since 5m --limit 25 --history --json/u
  );
});

test("watchWorkflowEvents streams each event and terminates cleanly", async () => {
  const { project, env } = await launchedProject({
    events: [
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 1,
        timestampMs: 1_700_000_000_000,
        type: "node.started",
        payload: { nodeId: "node:project-discovery" }
      }),
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 2,
        timestampMs: 1_700_000_030_000,
        type: "node.finished",
        payload: { nodeId: "node:project-discovery", state: "succeeded" }
      })
    ].join("\n")
  });
  const streamed: WorkflowLifecycleEvent[] = [];

  const watched = await watchWorkflowEvents({
    projectRoot: project,
    runId: "inspect-run",
    env,
    intervalSeconds: 1,
    onEvent: (event) => {
      streamed.push(event);
    }
  });

  assert.equal(watched.ok, true, JSON.stringify(watched.diagnostics));
  assert.equal(streamed.length, 2);
  assert.equal(streamed[1]?.detail, "succeeded");
  assert.match(smithersLog(project), /events ultrafuzz-inspect-run --limit 200 --watch --json --interval 1/u);
});

test("watchWorkflowEvents stops streaming when the caller aborts", async () => {
  const { project, env } = await launchedProject({ events: "" });
  const controller = new AbortController();
  controller.abort();

  const watched = await watchWorkflowEvents({
    projectRoot: project,
    runId: "inspect-run",
    env,
    signal: controller.signal,
    onEvent: () => {
      assert.fail("aborted watch must not stream events");
    }
  });

  assert.equal(watched.ok, true, JSON.stringify(watched.diagnostics));
  assert.equal(watched.value?.limit, 0);
});

test("event queries report a diagnostic when the engine command exits nonzero", async () => {
  const { project, env } = await launchedProject({ events: "" });
  fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nprintf '%s\\n' 'run not found' >&2\nexit 4\n", "utf8");
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  // A failed query must not look like a run with no events.
  const queried = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });
  assert.equal(queried.ok, false);
  assert.equal(queried.diagnostics[0]?.code, "WORKFLOW_EVENTS_QUERY_FAILED");
  assert.match(queried.diagnostics[0]?.message ?? "", /run not found/u);
  assertNoEngineBranding(queried.diagnostics);

  const watched = await watchWorkflowEvents({
    projectRoot: project,
    runId: "inspect-run",
    env,
    onEvent: () => {
      assert.fail("a failing watch must not stream events");
    }
  });
  assert.equal(watched.ok, false);
  assert.equal(watched.diagnostics[0]?.code, "WORKFLOW_EVENTS_WATCH_FAILED");
});

test("event queries report a diagnostic when the engine process is killed by a signal", async () => {
  const { project, env } = await launchedProject({ events: "" });
  // An OOM-style external kill leaves no exit code, which must still be a
  // failure rather than an empty success.
  fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nkill -9 $$\n", "utf8");
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  const queried = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(queried.ok, false);
  assert.equal(queried.diagnostics[0]?.code, "WORKFLOW_EVENTS_QUERY_FAILED");
  assert.match(queried.diagnostics[0]?.message ?? "", /terminated by SIGKILL/u);
  assertNoEngineBranding(queried.diagnostics);
});

test("a truncated event stream stays successful even though the process is killed", async () => {
  const lines = Array.from({ length: 4 }, (_, index) =>
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "node.progress",
      payload: { nodeId: "node:project-discovery" }
    })
  );
  const { project, env } = await launchedProject({ events: lines.join("\n") });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 2 });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.truncated, true);
  assert.equal(events.value?.events.length, 2);
});

test("getWorkflowNode returns focused status without attempt or tool detail by default", async () => {
  const { project, env } = await launchedProject({ node: nodeDetailFixture() });

  const node = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    env
  });

  assert.equal(node.ok, true, JSON.stringify(node.diagnostics));
  assert.equal(node.value?.node_id, "node:project-discovery");
  assert.equal(node.value?.iteration, 0);
  assert.equal(node.value?.state, "finished");
  assert.equal(node.value?.status, "succeeded");
  assert.equal(node.value?.duration_ms, 42_000);
  assert.deepEqual(node.value?.attempt_counts, { total: 2, succeeded: 1, failed: 1, cancelled: 0, waiting: 0 });
  assert.deepEqual(node.value?.models, ["gpt-test"]);
  assert.deepEqual(node.value?.agents, ["codex"]);
  assert.equal(node.value?.output.present, true);
  assert.equal(node.value?.output.source, "cache");
  assert.equal(node.value?.attempts.length, 0);
  assert.equal(node.value?.tool_details_included, false);
  assertNoEngineBranding(node.value);
  assert.match(smithersLog(project), /node node:project-discovery --run-id ultrafuzz-inspect-run --format json/u);
});

test("getWorkflowNode includes attempts on request and tool payloads only with --tools", async () => {
  const { project, env } = await launchedProject({ node: nodeDetailFixture() });

  const attemptsOnly = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    iteration: 0,
    attempts: true,
    env
  });

  assert.equal(attemptsOnly.ok, true, JSON.stringify(attemptsOnly.diagnostics));
  assert.equal(attemptsOnly.value?.attempts.length, 2);
  assert.equal(attemptsOnly.value?.attempts[0]?.error, "workflow runner attempt failed");
  assert.equal(attemptsOnly.value?.attempts[1]?.cached, true);
  assert.equal(attemptsOnly.value?.attempts[0]?.tool_calls.length, 1);
  assert.equal("input" in (attemptsOnly.value?.attempts[0]?.tool_calls[0] ?? {}), false);
  assert.equal("output" in (attemptsOnly.value?.attempts[0]?.tool_calls[0] ?? {}), false);
  assert.match(smithersLog(project), /--iteration 0/u);

  const withTools = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    tools: true,
    env
  });

  assert.equal(withTools.ok, true, JSON.stringify(withTools.diagnostics));
  assert.equal(withTools.value?.tool_details_included, true);
  const call = withTools.value?.attempts[0]?.tool_calls[0];
  assert.equal("input" in (call ?? {}), true);
  assert.deepEqual(call?.output, { note: "ok" });
  // Tool payloads pass through the shared secret redaction helpers.
  assert.doesNotMatch(JSON.stringify(call?.input), /sk-live-secret/u);
});

test("watchWorkflowNode keeps streaming past the engine's terminal clear-screen bytes", async () => {
  const detail = JSON.stringify(nodeDetailFixture());
  // The engine's watch loop clears the terminal before every non-initial
  // render, writing an ANSI sequence with no trailing newline into the same
  // stdout stream as the JSONL payload.
  const { project, env } = await launchedProject({
    nodeWatchLines: `${detail}\n\u001B[2J\u001B[0f${detail}\n\u001B[2J\u001B[0f${detail}\n`
  });
  const snapshots: string[] = [];

  const watched = await watchWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    env,
    intervalSeconds: 1,
    onSnapshot: (value) => {
      snapshots.push(value.node_id);
    }
  });

  assert.equal(watched.ok, true, JSON.stringify(watched.diagnostics));
  assert.equal(snapshots.length, 3);
  assert.deepEqual(new Set(snapshots), new Set(["node:project-discovery"]));
  assert.match(
    smithersLog(project),
    /node node:project-discovery --run-id ultrafuzz-inspect-run --format jsonl --watch --interval 1/u
  );
});

test("cancelRun converges when the engine reports the run is already terminal", async () => {
  const { project, env, runRoot } = await launchedProject({});
  // The engine answers RUN_NOT_ACTIVE with exit 4 once a run is cancelled, so
  // rerunning cancel to confirm an in-flight request must not error.
  fs.writeFileSync(
    env.SMITHERS_BIN!,
    [
      "#!/bin/sh",
      'if [ "$1" = "cancel" ]; then',
      '  printf \'%s\\n\' \'{"ok":false,"error":{"code":"RUN_NOT_ACTIVE"}}\'',
      "  exit 4",
      "fi",
      "printf '%s\\n' '{\"ok\":true}'",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  const confirmed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(confirmed.ok, true, JSON.stringify(confirmed.diagnostics));
  assert.equal(confirmed.value?.status, "canceled");
  assert.equal(confirmed.value?.confirmed, true);
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status: string };
  assert.equal(state.status, "canceled");
});

test("cancelRun still fails on an unrelated engine error exit", async () => {
  const { project, env } = await launchedProject({});
  fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nprintf '%s\\n' 'database is locked' >&2\nexit 4\n", "utf8");
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  const failed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostics[0]?.code, "WORKFLOW_CANCEL_FAILED");
});

test("queryWorkflowEvents does not call an exact-limit result truncated", async () => {
  const lines = Array.from({ length: 2 }, (_, index) =>
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "node.progress",
      payload: { nodeId: "node:project-discovery" }
    })
  );
  const { project, env } = await launchedProject({ events: lines.join("\n") });

  const exact = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 2 });

  assert.equal(exact.ok, true, JSON.stringify(exact.diagnostics));
  assert.equal(exact.value?.events.length, 2);
  assert.equal(exact.value?.truncated, false);
});

test("watchWorkflowEvents stops the stream when the caller aborts mid-stream", async () => {
  const lines = Array.from({ length: 200 }, (_, index) =>
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "node.progress",
      payload: { nodeId: "node:project-discovery" }
    })
  );
  const { project, env } = await launchedProject({ events: lines.join("\n") });
  const controller = new AbortController();
  let observed = 0;

  const watched = await watchWorkflowEvents({
    projectRoot: project,
    runId: "inspect-run",
    env,
    signal: controller.signal,
    onEvent: () => {
      observed += 1;
      if (observed === 1) {
        controller.abort();
      }
    }
  });

  assert.equal(watched.ok, true, JSON.stringify(watched.diagnostics));
  assert.ok(observed >= 1);
  // An abort is a caller-initiated stop, so it must not surface as a failure.
  assert.equal(watched.diagnostics.length, 0);
});

test("getWorkflowNode rejects an unexpected engine response", async () => {
  const { project, env } = await launchedProject({ node: { status: "succeeded" } });

  const node = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    env
  });

  assert.equal(node.ok, false);
  assert.equal(node.diagnostics[0]?.code, "WORKFLOW_NODE_INVALID");
});

test("diagnoseProject reports a healthy pinned install and the latest published version", async () => {
  const { project, env } = await launchedProject({});
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });

  const doctor = await diagnoseProject({ projectRoot: project, env, offline: true });

  assert.equal(doctor.value?.workflow_engine.installed_version, SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(doctor.value?.workflow_engine.required_version, SMITHERS_ORCHESTRATOR_VERSION);
  assert.equal(doctor.value?.workflow_engine.installed_bin_target, SMITHERS_ORCHESTRATOR_BIN_PATH);
  assert.equal(doctor.value?.workflow_engine.layout_status, "ok");
  assert.equal(doctor.value?.workflow_engine.layout_detail, null);
  assert.equal(doctor.value?.checks.find((check) => check.name === "workflow-engine-install")?.status, "ok");
  assert.equal(typeof doctor.value?.validation.policy_posture.config?.status, "string");
  assert.ok(doctor.value?.toolchain.some((entry) => entry.name === "forge"));
});

test("diagnoseProject reports commands required by the active topology", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });

  const doctor = await diagnoseProject({
    projectRoot: project,
    env: { PATH: path.join(project, "empty-bin") },
    offline: true
  });

  assert.equal(doctor.value?.toolchain.find((entry) => entry.name === "recon")?.required, true);
  assert.equal(doctor.value?.toolchain.find((entry) => entry.name === "recon")?.available, false);
  assert.ok(
    doctor.diagnostics.some((entry) => entry.code === "DOCTOR_TOOLCHAIN_MISSING" && entry.message.includes("recon"))
  );
});

test("startRun rejects a missing required backend before creating a run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");

  const run = await startRun({
    projectRoot: project,
    runId: "missing-recon",
    env: { PATH: path.join(project, "empty-bin") }
  });

  assert.equal(run.ok, false);
  assert.equal(run.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
  assert.match(run.diagnostics[0]?.message ?? "", /recon/u);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "missing-recon")), false);
});

test("active topology transforms remove excluded nodes' command requirements", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
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
  - id: required-branch
    prompt: setup/project-discovery.md
    required_commands: [recon]
    depends_on: [__start__]
    outputs:
      - path: required.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: active-branch
    prompt: setup/project-discovery.md
    depends_on: [__start__]
    outputs:
      - path: active.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [required-branch, active-branch]
`,
    "utf8"
  );

  const validation = await validateProject({
    projectRoot: project,
    topologyTransform: { excludedNodeIds: ["required-branch"] }
  });

  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
  assert.deepEqual(validation.value?.topology?.required_commands, []);
});

test("startRun delegates cloud requirements to the execution-provider probe before creating a run", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    `${fs
      .readFileSync(configPath, "utf8")
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );
  let probed: readonly string[] = [];

  const run = await startRun({
    projectRoot: project,
    runId: "missing-cloud-recon",
    env: {
      PATH: path.join(project, "controller-empty-bin"),
      UFZ_PROVIDER_ONE: "provider-one",
      UFZ_PROVIDER_TWO: "provider-two"
    },
    requiredCommandProbe: async (commands) => {
      probed = commands;
      return commands.map((name) => ({ name, available: false, path: null, version: null }));
    }
  });

  assert.deepEqual(probed, ["recon"], JSON.stringify(run.diagnostics));
  assert.equal(run.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "missing-cloud-recon")), false);
});

test("diagnoseProject probes topology commands in the configured cloud execution environment", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    `${fs
      .readFileSync(configPath, "utf8")
      .replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"\nprovider = "modal"')}

[execution.providers.modal]
app = "ultrafuzz-test"
image = "ultrafuzz-test"
credential_env = ["UFZ_PROVIDER_ONE", "UFZ_PROVIDER_TWO"]
`,
    "utf8"
  );
  let probed: readonly string[] = [];

  const doctor = await diagnoseProject({
    projectRoot: project,
    env: {
      PATH: path.join(project, "controller-empty-bin"),
      UFZ_PROVIDER_ONE: "provider-one",
      UFZ_PROVIDER_TWO: "provider-two"
    },
    offline: true,
    requiredCommandProbe: async (commands) => {
      probed = commands;
      return commands.map((name) => ({
        name,
        available: name !== "recon",
        path: name === "recon" ? null : `/usr/local/bin/${name}`,
        version: null
      }));
    }
  });

  assert.ok(probed.includes("recon"), JSON.stringify(doctor.diagnostics));
  assert.equal(doctor.value?.toolchain.find((entry) => entry.name === "recon")?.available, false);
  assert.ok(doctor.diagnostics.some((entry) => entry.code === "DOCTOR_TOOLCHAIN_MISSING"));
});

// The scheduler and engine workarounds are the two that carry durable resume
// progress, and an unreported posture reads as healthy. Cover every tracked
// workaround, not just the CLI pair.
test("diagnoseProject reports a posture for every tracked compatibility patch", async () => {
  const { project, env } = await launchedProject({});
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });
  const nodeModules = path.join(project, ".smithers", "node_modules");
  // Group by source because many workflow-path workarounds patch the same file.
  // Shared files can mix applied and missing anchors; incompatible and unknown
  // remain whole-file postures and are assigned to single-workaround sources.
  const bySource = new Map<string, typeof SMITHERS_COMPATIBILITY_PATCHES>();
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES) {
    const source = path.join(nodeModules, ...patch.packageName.split("/"), ...patch.sourceRelativePath.split("/"));
    bySource.set(source, [...(bySource.get(source) ?? []), patch]);
  }
  const wholeFilePostures = ["incompatible", "unknown", "applied"] as const;
  const singleSources = [...bySource.entries()].filter(([, patches]) => patches.length === 1);
  assert.ok(
    singleSources.length <= wholeFilePostures.length,
    "extend the whole-file posture rotation to cover every single-workaround source"
  );
  const expected: Record<string, string> = {};
  let singleIndex = 0;
  for (const [source, patches] of bySource) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    if (patches.length === 1) {
      const patch = patches[0]!;
      const posture = wholeFilePostures[singleIndex]!;
      singleIndex += 1;
      if (posture === "applied") fs.writeFileSync(source, `${patch.patched}\n`, "utf8");
      if (posture === "incompatible") fs.writeFileSync(source, "export const unrelated = 1;\n", "utf8");
      expected[patch.id] = posture;
      continue;
    }
    const lines: string[] = [];
    for (const [index, patch] of patches.entries()) {
      const posture = index % 2 === 0 ? "applied" : "missing";
      lines.push(posture === "applied" ? patch.patched : patch.patchable);
      expected[patch.id] = posture;
    }
    fs.writeFileSync(source, `${lines.join("\n")}\n`, "utf8");
  }

  const { SMITHERS_REQUIRED_ENGINE_ANCHORS } = await import("../src/smithers.js");
  for (const required of SMITHERS_REQUIRED_ENGINE_ANCHORS) {
    const source = path.join(
      nodeModules,
      ...required.packageName.split("/"),
      ...required.sourceRelativePath.split("/")
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.appendFileSync(source, `${required.anchor}\n`, "utf8");
    expected[required.id] = "applied";
  }

  const doctor = await diagnoseProject({ projectRoot: project, env, offline: true });

  const reported = doctor.value?.workflow_engine.compatibility_patches ?? {};
  assert.deepEqual(reported, expected);
  // Named explicitly: these two were previously omitted from the posture report.
  assert.ok(Object.hasOwn(reported, "terminal_state_restore"));
  assert.ok(Object.hasOwn(reported, "resume_hydration"));
  // An incompatible source means the next run throws, so doctor must not pass it.
  assert.equal(doctor.value?.checks.find((check) => check.name === "workflow-engine-patches")?.status, "error");
  assert.equal(doctor.ok, false);
  assert.ok(doctor.diagnostics.some((entry) => entry.code === "DOCTOR_WORKFLOW_ENGINE_PATCHES_INCOMPATIBLE"));
});

test("diagnoseProject reports a missing install and a version mismatch", async () => {
  const { project, env } = await launchedProject({});

  const missing = await diagnoseProject({ projectRoot: project, env, offline: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.value?.workflow_engine.installed_version, null);
  assert.ok(missing.diagnostics.some((entry) => entry.code === "DOCTOR_WORKFLOW_ENGINE_MISSING"));

  writeFakeInstalledEngine(project, { version: "0.29.0" });
  const mismatched = await diagnoseProject({ projectRoot: project, env, offline: true });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.value?.workflow_engine.installed_version, "0.29.0");
  assert.ok(mismatched.diagnostics.some((entry) => entry.code === "DOCTOR_WORKFLOW_ENGINE_VERSION_MISMATCH"));
});

test("diagnoseProject reports a modified installed manifest", async () => {
  const { project, env } = await launchedProject({});
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION, binTarget: "dist/other.js" });

  const doctor = await diagnoseProject({ projectRoot: project, env, offline: true });

  assert.equal(doctor.ok, false);
  assert.equal(doctor.value?.workflow_engine.installed_bin_target, "dist/other.js");
  assert.equal(doctor.value?.workflow_engine.layout_status, "error");
  assert.ok(doctor.diagnostics.some((entry) => entry.code === "DOCTOR_WORKFLOW_ENGINE_LAYOUT_INVALID"));
});

test("diagnoseProject keeps an offline registry lookup non-fatal", async () => {
  const { project, env } = await launchedProject({});
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });
  const failingBin = path.join(project, "offline-bin");
  fs.mkdirSync(failingBin, { recursive: true });
  const npm = path.join(failingBin, "npm");
  fs.writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' 'offline' >&2\nexit 1\n", "utf8");
  fs.chmodSync(npm, 0o755);

  const doctor = await diagnoseProject({
    projectRoot: project,
    env: { ...env, PATH: `${failingBin}${path.delimiter}${env.PATH ?? ""}` }
  });

  assert.equal(doctor.value?.workflow_engine.latest_published_version, "unknown");
  assert.equal(doctor.value?.checks.find((check) => check.name === "workflow-engine-registry")?.status, "warning");
  assert.ok(doctor.diagnostics.some((entry) => entry.code === "DOCTOR_REGISTRY_UNAVAILABLE"));
  assert.equal(doctor.diagnostics.find((entry) => entry.code === "DOCTOR_REGISTRY_UNAVAILABLE")?.severity, "warning");
  // A valid pinned install stays healthy without registry access.
  assert.equal(doctor.value?.workflow_engine.layout_status, "ok");
});

test("diagnoseProject does not mutate the installed dependency layout", async () => {
  const { project, env } = await launchedProject({});
  writeFakeInstalledEngine(project, { version: SMITHERS_ORCHESTRATOR_VERSION });
  const manifestPath = path.join(project, ".smithers", "node_modules", "smithers-orchestrator", "package.json");
  const before = fs.readFileSync(manifestPath, "utf8");

  await diagnoseProject({ projectRoot: project, env, offline: true });

  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
});

function writeFakeInstalledEngine(project: string, input: { version: string; binTarget?: string }): void {
  const packageRoot = path.join(project, ".smithers", "node_modules", "smithers-orchestrator");
  const target = path.join(packageRoot, ...SMITHERS_ORCHESTRATOR_BIN_PATH.split("/"));
  const shim = path.join(project, ".smithers", "node_modules", ".bin", "smithers");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "smithers-orchestrator",
      version: input.version,
      bin: { smithers: input.binTarget ?? SMITHERS_ORCHESTRATOR_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(target, "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n", "utf8");
  fs.chmodSync(target, 0o755);
  fs.rmSync(shim, { force: true });
  fs.symlinkSync(path.relative(path.dirname(shim), target), shim);
}

function nodeDetailFixture(): unknown {
  return {
    node: {
      runId: WORKFLOW_RUN_ID,
      nodeId: "node:project-discovery",
      iteration: 0,
      state: "finished",
      lastAttempt: 2,
      updatedAtMs: 1_700_000_200_000,
      outputTable: null,
      label: null
    },
    status: "succeeded",
    durationMs: 42_000,
    attemptsSummary: { total: 2, failed: 1, cancelled: 0, succeeded: 1, waiting: 0 },
    attempts: [
      {
        runId: WORKFLOW_RUN_ID,
        nodeId: "node:project-discovery",
        iteration: 0,
        attempt: 1,
        state: "failed",
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_020_000,
        durationMs: 20_000,
        error: "smithers attempt failed",
        errorDetail: null,
        tokenUsage: { models: ["gpt-test"], agents: ["codex"] },
        toolCalls: [
          {
            attempt: 1,
            seq: 1,
            name: "shell",
            status: "ok",
            startedAtMs: 1_700_000_001_000,
            finishedAtMs: 1_700_000_002_000,
            durationMs: 1_000,
            input: { command: "forge build", token: "sk-live-secret-value" },
            output: { note: "ok" },
            error: null
          }
        ],
        meta: null,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: null
      },
      {
        runId: WORKFLOW_RUN_ID,
        nodeId: "node:project-discovery",
        iteration: 0,
        attempt: 2,
        state: "finished",
        startedAtMs: 1_700_000_100_000,
        finishedAtMs: 1_700_000_122_000,
        durationMs: 22_000,
        error: null,
        errorDetail: null,
        tokenUsage: { models: ["gpt-test"], agents: ["codex"] },
        toolCalls: [],
        meta: null,
        responseText: null,
        cached: true,
        jjPointer: null,
        jjCwd: null
      }
    ],
    toolCalls: [],
    tokenUsage: { models: ["gpt-test"], agents: ["codex"], byAttempt: [] },
    scorers: [],
    output: { validated: { ok: true }, raw: null, source: "cache", cacheKey: null },
    approval: null,
    limits: { toolPayloadBytesHuman: 1, validatedOutputBytesHuman: 1 }
  };
}
