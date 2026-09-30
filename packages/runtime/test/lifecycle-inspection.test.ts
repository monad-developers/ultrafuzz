import assert from "node:assert/strict";
import { registerTemporaryPath, temporaryRoot } from "./temporary-root.js";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  layoutForRunRoot,
  VALIDATOR_BUILD_IDENTITY
} from "@ultrafuzz/artifacts";

import {
  cancelRun,
  diagnoseProject,
  diagnoseRun,
  type forkRun,
  getRunTimeline,
  getWorkflowNode,
  initProject,
  listRunSnapshots,
  queryWorkflowEvents,
  type replayRun,
  type resumeRun,
  startRun as runtimeStartRun,
  validateProject,
  watchWorkflowEvents,
  watchWorkflowNode,
  type WorkflowLifecycleEvent
} from "../src/index.js";
import {
  bindInstalledWorkflowRunner,
  inspectSmithersInstallation,
  installedWorkflowRunner,
  patchedWorkflowRunner,
  SMITHERS_COMPATIBILITY_PATCHES
} from "../src/smithers.js";
import { bindSmithersExecutableCapability } from "../src/smithers-executable-capability.js";
import { SMITHERS_BIN_PATH, SMITHERS_VERSION } from "../src/smithers-package.js";
import { acquireWorkflowControlLock } from "../src/workflow-integrity.js";
import { addOpenRouterProfile } from "./openrouter-profile-fixture.js";

const WORKFLOW_RUN_ID = "ultrafuzz-inspect-run";
const TEST_GOVERNANCE_POLICY = `{"schema_version":"ultrafuzz.data-governance-policy.v1","sensitivity":"public","source_destinations":["cloud:modal","model:openai"],"artifact_destinations":["cloud:modal"],"destination_policies":[{"destination":"cloud:modal","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"},{"destination":"model:openai","processor":"test","region":"local","retention_policy":"test","training_policy":"none","dpa_status":"n/a","minimization_policy":"synthetic","data_handling_basis":"public"}],"openrouter_model_allowlist":[]}`;
const startRun = (input: Parameters<typeof runtimeStartRun>[0]): ReturnType<typeof runtimeStartRun> =>
  runtimeStartRun({
    ...input,
    env: {
      ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(
        path.dirname(input.projectRoot),
        `${path.basename(input.projectRoot)}-provider-homes`
      ),
      ULTRAFUZZ_DATA_GOVERNANCE_POLICY: TEST_GOVERNANCE_POLICY,
      ...input.env
    }
  });

function tempProject(): string {
  return temporaryRoot("ufz-inspect-");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
        contract: ultrafuzz/findings@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
  fs.appendFileSync(
    path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
    "\n{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}\n",
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
  eventsFirstRead?: string;
  cancelStatus?: string;
}

const FAKE_INSPECTION_CONTROLS = ["cancel-terminal", "error-exit-code", "error-text", "kill-self"] as const;
type FakeInspectionControl = (typeof FAKE_INSPECTION_CONTROLS)[number];

function fakeInspectionControlPath(project: string, control: FakeInspectionControl): string {
  return path.join(project, `fake-${control}`);
}

function fakeInspectionFiles(project: string) {
  return {
    why: path.join(project, "fake-why.json"),
    timeline: path.join(project, "fake-timeline.json"),
    snapshots: path.join(project, "fake-snapshots.json"),
    node: path.join(project, "fake-node.json"),
    nodeWatch: path.join(project, "fake-node-watch.ndjson"),
    events: path.join(project, "fake-events.ndjson"),
    eventsFirstRead: path.join(project, "fake-events-first-read.ndjson"),
    eventsFirstReadMarker: path.join(project, "fake-events-first-read-complete"),
    cancel: path.join(project, "fake-cancel.json"),
    commandLog: path.join(project, "smithers-commands.log")
  };
}

function failFakeInspectionRunner(project: string, message: string, exitCode: number): void {
  fs.writeFileSync(fakeInspectionControlPath(project, "error-text"), `${message}\n`, "utf8");
  fs.writeFileSync(fakeInspectionControlPath(project, "error-exit-code"), `${exitCode}\n`, "utf8");
}

function enableFakeInspectionControl(
  project: string,
  control: Exclude<FakeInspectionControl, "error-exit-code" | "error-text">
): void {
  fs.writeFileSync(fakeInspectionControlPath(project, control), "", "utf8");
}

function smithersEventLine(input: {
  seq: number;
  timestampMs: number;
  type: string;
  payload?: Record<string, unknown>;
}): string {
  const payload = {
    type: input.type,
    runId: WORKFLOW_RUN_ID,
    timestampMs: input.timestampMs,
    ...input.payload
  };
  return JSON.stringify({
    runId: WORKFLOW_RUN_ID,
    seq: input.seq,
    timestampMs: input.timestampMs,
    type: input.type,
    payload
  });
}

/**
 * Sets the answers the fake runner gives, and clears the previous answers, the
 * control files and the command log, so a test sees only its own commands.
 */
function writeInspectionFixtures(project: string, fixtures: FakeInspectionFixtures): void {
  const files = fakeInspectionFiles(project);
  for (const stale of [
    files.nodeWatch,
    files.eventsFirstRead,
    files.eventsFirstReadMarker,
    files.commandLog,
    ...FAKE_INSPECTION_CONTROLS.map((control) => fakeInspectionControlPath(project, control))
  ]) {
    fs.rmSync(stale, { force: true });
  }
  fs.writeFileSync(
    files.why,
    `${JSON.stringify({
      ok: true,
      data: fixtures.why ?? {},
      meta: { command: "why", duration: "1ms" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    files.timeline,
    `${JSON.stringify(
      fixtures.timeline ?? {
        timeline: { runId: WORKFLOW_RUN_ID, branch: null, frames: [], children: [] }
      }
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(files.snapshots, `${JSON.stringify(fixtures.snapshots ?? { snapshots: [] })}\n`, "utf8");
  fs.writeFileSync(
    files.node,
    `${JSON.stringify({
      ok: true,
      data: fixtures.node ?? {},
      meta: { command: "node", duration: "1ms" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(files.events, fixtures.events ?? "", "utf8");
  if (fixtures.eventsFirstRead !== undefined) {
    fs.writeFileSync(files.eventsFirstRead, fixtures.eventsFirstRead, "utf8");
  }
  if (fixtures.nodeWatchLines !== undefined) {
    fs.writeFileSync(files.nodeWatch, fixtures.nodeWatchLines, "utf8");
  }
  fs.writeFileSync(
    files.cancel,
    `${JSON.stringify({ ok: true, data: { status: fixtures.cancelStatus ?? "cancel-requested" } })}\n`,
    "utf8"
  );
}

/**
 * A fake workflow runner that answers the inspection and lifecycle commands
 * with the exact JSON shapes the pinned engine emits. It reads every answer
 * from the files `writeInspectionFixtures` sets, so the runner a run was
 * launched with never has to change.
 */
function fakeInspectionEnv(project: string): Record<string, string | undefined> {
  const binDir = path.join(path.dirname(project), `${path.basename(project)}-fake-bin`);
  fs.mkdirSync(binDir, { recursive: true });
  registerTemporaryPath(binDir);
  const files = fakeInspectionFiles(project);
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${shellQuote(files.commandLog)}`,
      `if [ -f ${shellQuote(fakeInspectionControlPath(project, "kill-self"))} ]; then kill -9 $$; fi`,
      `if [ -f ${shellQuote(fakeInspectionControlPath(project, "error-exit-code"))} ]; then`,
      `  if [ -f ${shellQuote(fakeInspectionControlPath(project, "error-text"))} ]; then cat ${shellQuote(fakeInspectionControlPath(project, "error-text"))} >&2; fi`,
      `  exit "$(cat ${shellQuote(fakeInspectionControlPath(project, "error-exit-code"))})"`,
      "fi",
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
      `    if [ -f ${shellQuote(files.nodeWatch)} ]; then cat ${shellQuote(files.nodeWatch)}; else cat ${shellQuote(files.node)}; fi`,
      "    ;;",
      "  events)",
      `    if [ -f ${shellQuote(files.eventsFirstRead)} ] && [ ! -f ${shellQuote(files.eventsFirstReadMarker)} ]; then`,
      `      : > ${shellQuote(files.eventsFirstReadMarker)}`,
      `      cat ${shellQuote(files.eventsFirstRead)}`,
      "    else",
      `      cat ${shellQuote(files.events)}`,
      "    fi",
      "    ;;",
      "  cancel)",
      `    if [ -f ${shellQuote(fakeInspectionControlPath(project, "cancel-terminal"))} ]; then`,
      '      printf \'%s\\n\' \'{"ok":false,"error":{"code":"RUN_NOT_ACTIVE","message":"Run is not active"}}\'',
      "      exit 4",
      "    fi",
      `    cat ${shellQuote(files.cancel)}`,
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
  return bindSmithersExecutableCapability(
    {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_BIN: smithers
    },
    smithers,
    project
  );
}

/** A project with the fake runner installed and no run; `diagnoseProject` never reads one. */
function projectWithFakeRunner(): { project: string; env: Record<string, string | undefined> } {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  return { project, env: fakeInspectionEnv(project) };
}

async function launchedProject(
  fixtures: FakeInspectionFixtures,
  runId = "inspect-run"
): Promise<{ project: string; env: Record<string, string | undefined>; runRoot: string }> {
  const { project, env } = projectWithFakeRunner();
  writeInspectionFixtures(project, fixtures);
  const run = await startRun({
    projectRoot: project,
    runId,
    env,
    ultrafuzzCliEntrypoint: fakeUltrafuzzCliEntrypoint(project)
  });
  assert.equal(run.ok, true, JSON.stringify(run.diagnostics));
  return { project, env, runRoot: run.value!.run_root };
}

/** The run documents a lifecycle command writes: metadata, status, the event log and the engine link. */
const SHARED_RUN_DOCUMENTS = [
  "run.json",
  "state.json",
  "events.jsonl",
  path.join("smithers", "workflow-run-link-journal.json")
] as const;

function readRunDocuments(runRoot: string): Record<string, string | null> {
  return Object.fromEntries(
    SHARED_RUN_DOCUMENTS.map((document) => {
      const documentPath = path.join(runRoot, document);
      return [document, fs.existsSync(documentPath) ? fs.readFileSync(documentPath, "utf8") : null];
    })
  );
}

let sharedInspectedRun:
  | Promise<Awaited<ReturnType<typeof launchedProject>> & { launchedDocuments: Record<string, string | null> }>
  | undefined;

/**
 * Launching a run is the slow part of these tests. Tests whose commands leave
 * the run's files unchanged share one run, and each call only resets the
 * runner's answers. A test whose cancel succeeds, or that rewrites run
 * metadata, launches its own run with `launchedProject`; each call checks that
 * no earlier test broke that rule.
 */
async function inspectedRun(fixtures: FakeInspectionFixtures): ReturnType<typeof launchedProject> {
  // A failed launch stays cached, so every later caller reports it as the shared launch failing, not
  // as its own regression.
  sharedInspectedRun ??= launchedProject({}).then(
    (launched) => ({ ...launched, launchedDocuments: readRunDocuments(launched.runRoot) }),
    (error: unknown) => {
      throw new Error("the shared inspection run failed to launch, so this test did not run", { cause: error });
    }
  );
  const { launchedDocuments, ...launched } = await sharedInspectedRun;
  assert.deepEqual(
    readRunDocuments(launched.runRoot),
    launchedDocuments,
    "an earlier test changed the shared inspection run; a test that changes run state must launch its own run with launchedProject"
  );
  writeInspectionFixtures(launched.project, fixtures);
  return launched;
}

function smithersLog(project: string): string {
  return fs.readFileSync(fakeInspectionFiles(project).commandLog, "utf8");
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
  const { project, env } = await inspectedRun({});
  failFakeInspectionRunner(project, "boom", 9);

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
  metadata.workflow_ids = [];
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

  for (const command of [cancelRun, diagnoseRun, getRunTimeline, listRunSnapshots, queryWorkflowEvents]) {
    const unlinked = await command({ projectRoot: project, runId: "inspect-run", env });
    assert.equal(unlinked.ok, false);
    assert.equal(unlinked.diagnostics[0]?.code, "WORKFLOW_RUN_ID_MISSING");
  }
});

test("resume, replay and fork declare workflow_run_id on every lifecycle value", () => {
  // Compile-time check: each reader stops type-checking if the value its
  // function returns lets workflow_run_id be undefined.
  const resume = (value: NonNullable<Awaited<ReturnType<typeof resumeRun>>["value"]>): string => value.workflow_run_id;
  const replay = (value: NonNullable<Awaited<ReturnType<typeof replayRun>>["value"]>): string => value.workflow_run_id;
  const fork = (value: NonNullable<Awaited<ReturnType<typeof forkRun>>["value"]>): string => value.workflow_run_id;
  const value = { run_id: "run", workflow_run_id: "ultrafuzz-run", action: "resume", submitted: true } as const;
  assert.deepEqual([resume(value), replay(value), fork(value)], ["ultrafuzz-run", "ultrafuzz-run", "ultrafuzz-run"]);
});

test("diagnoseRun adapts the engine diagnosis without engine-branded public text", async () => {
  const { project, env } = await inspectedRun({
    why: {
      runId: WORKFLOW_RUN_ID,
      status: "running",
      summary: "1 node waiting for approval; run `smithers why` for detail",
      generatedAtMs: 1_700_000_000_000,
      currentNodeId: "node:project-discovery",
      // 0.35.0 spreads `warnings` onto every `buildDiagnosis` return path, and
      // raises a `stalled` blocker for a node parked on an identical-error streak.
      warnings: ["Concurrency ceiling saturated: requested demand 8, effective cap 4."],
      information: ["smithers recorded 1 stale heartbeat", "then run smithers inspect"],
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
        },
        {
          // New in 0.35.0: raised for every node the scheduler parked on an
          // identical-error streak. A closed enum without it rejected the whole
          // diagnosis, not just this row.
          kind: "stalled",
          nodeId: "node:strategy",
          iteration: 0,
          reason: "3 identical failures in a row",
          waitingSince: 1_699_999_700_000,
          unblocker: "smithers resume --retry-failed"
        }
      ]
    }
  });

  const diagnosis = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.diagnostics));
  assert.equal(diagnosis.value?.workflow_status, "running");
  assert.equal(diagnosis.value?.current_node_id, "node:project-discovery");
  assert.equal(diagnosis.value?.summary, "1 node waiting for approval; run `ultrafuzz why` for detail");
  // Smithers 0.35.0 reports a concurrency-saturation `warnings` array beside
  // `information`, and renders both in the same operator section of `why`, so
  // they land together in the public `notes` with warnings first.
  assert.deepEqual(diagnosis.value?.notes, [
    "Concurrency ceiling saturated: requested demand 8, effective cap 4.",
    "workflow runner recorded 1 stale heartbeat",
    "then run `ultrafuzz inspect`"
  ]);
  assert.equal(diagnosis.value?.blockers[0]?.kind, "waiting-approval");
  assert.equal(diagnosis.value?.blockers[0]?.attempt, 2);
  assert.equal(diagnosis.value?.blockers[0]?.max_attempts, 3);
  assert.equal(diagnosis.value?.blockers[0]?.unblocker, "workflow runner approve");
  assert.equal(diagnosis.value?.blockers[0]?.waiting_since, new Date(1_699_999_000_000).toISOString());
  assert.equal(diagnosis.value?.blockers[1]?.kind, "side-effect-boundary-crossed");
  assert.equal(diagnosis.value?.blockers[1]?.iteration, null);
  assert.equal(diagnosis.value?.blockers[2]?.kind, "stalled");
  assert.equal(diagnosis.value?.blockers[2]?.node_id, "node:strategy");
  assertNoEngineBranding(diagnosis.value);
  assert.match(smithersLog(project), new RegExp(`why ${WORKFLOW_RUN_ID} --format json`, "u"));
});

test("diagnoseRun keeps a runner path intact in public text", async () => {
  const workflowPath = "/work/target/.smithers/workflows/ultrafuzz-inspect-run.tsx";
  const { project, env } = await inspectedRun({
    why: {
      runId: WORKFLOW_RUN_ID,
      status: "running",
      summary: `smithers could not reload ${workflowPath}`,
      generatedAtMs: 1_700_000_000_000,
      currentNodeId: "node:project-discovery",
      warnings: [],
      information: [
        "spawn /opt/runner/bin/smithers ENOENT",
        "spawn /opt/runner/pre-smithers ENOENT",
        "**smithers why** explains the stall"
      ],
      blockers: []
    }
  });

  const diagnosis = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis.diagnostics));
  assert.equal(diagnosis.value?.summary, `workflow runner could not reload ${workflowPath}`);
  assert.deepEqual(diagnosis.value?.notes, [
    "spawn /opt/runner/bin/smithers ENOENT",
    "spawn /opt/runner/pre-smithers ENOENT",
    "**`ultrafuzz why`** explains the stall"
  ]);
});

test("diagnoseRun names the ultrafuzz command for each recovery the runner suggests", async () => {
  // A run ID naming the runner shows the rebuilt commands are not put through the runner-name scrub.
  const runId = "smithers-probe";
  const workflowRunId = `ultrafuzz-${runId}`;
  const { project, env } = await launchedProject({}, runId);
  // The pinned runner's own suggestions, which name its CLI, its workflow file and its run ID.
  const workflow = `/work/target/.smithers/workflows/${workflowRunId}.tsx`;
  const resume = `smithers up ${workflow} --run-id ${workflowRunId} --resume true`;
  const retryTask = `smithers retry-task ${workflow} --run-id ${workflowRunId} --node-id node:project-discovery --iteration 0`;
  const diagnose = async (
    status: string,
    summary: string,
    blockers: Array<{ kind: string; unblocker: string; nodeId?: string; iteration?: null }>,
    notes: { warnings?: string[]; information?: string[] } = {}
  ) => {
    const data = {
      runId: workflowRunId,
      status,
      summary,
      generatedAtMs: 1_700_000_000_000,
      currentNodeId: null,
      warnings: notes.warnings ?? [],
      information: notes.information ?? [],
      blockers: blockers.map((row) => ({
        nodeId: "node:project-discovery",
        iteration: 0,
        reason: row.kind,
        waitingSince: 1_699_999_000_000,
        ...row
      }))
    };
    const envelope = { ok: true, data, meta: { command: "why", duration: "1ms" } };
    fs.writeFileSync(path.join(project, "fake-why.json"), `${JSON.stringify(envelope)}\n`, "utf8");
    const diagnosis = await diagnoseRun({ projectRoot: project, runId, env });
    assert.ok(diagnosis.value, JSON.stringify(diagnosis.diagnostics));
    return diagnosis.value;
  };

  // A plain resume leaves a failed node failed, so on a failed run every retry goes through --retry-failed.
  const failed = await diagnose(
    "failed",
    `Run ${workflowRunId} is failed`,
    [
      { kind: "retries-exhausted", nodeId: "verify:project-discovery", unblocker: resume },
      { kind: "stalled", unblocker: retryTask }
    ],
    {
      information: [
        `Last good checkpoint: frame 29. Resume in place with \`${resume}\` or replay from the checkpoint with \`smithers replay ${workflow} --run-id ${workflowRunId} --frame 29\`.`
      ]
    }
  );
  assert.deepEqual(
    failed.blockers.map((blocker) => blocker.unblocker),
    ["ultrafuzz resume smithers-probe --retry-failed", "ultrafuzz resume smithers-probe --retry-failed"]
  );
  assert.deepEqual(failed.notes, [
    "Last good checkpoint: frame 29. Resume in place with `ultrafuzz resume smithers-probe --retry-failed` or replay from the checkpoint with `ultrafuzz fork smithers-probe --frame 29`."
  ]);

  const running = await diagnose(
    "running",
    `Run ${workflowRunId} is running`,
    [
      {
        kind: "side-effect-boundary-crossed",
        nodeId: "(run-level)",
        iteration: null,
        unblocker: `smithers inspect ${workflowRunId}`
      },
      { kind: "stale-task-heartbeat", unblocker: `${retryTask} --force true` },
      { kind: "engine-busy", nodeId: "(run-level)", iteration: null, unblocker: `smithers logs ${workflowRunId}` }
    ],
    {
      warnings: [
        "Concurrency ceiling saturated: requested demand 8, effective cap 4. Remediation: `smithers up --max-concurrency 8`."
      ]
    }
  );
  assert.deepEqual(
    running.blockers.map((blocker) => blocker.unblocker),
    [
      "ultrafuzz inspect smithers-probe",
      "ultrafuzz resume smithers-probe --reset-node node:project-discovery",
      "ultrafuzz events smithers-probe --watch --history"
    ]
  );
  // An `up` without `--resume` starts a run rather than resuming this one, so it is not rebuilt and
  // keeps the limit it raises.
  assert.deepEqual(running.notes, [
    "Concurrency ceiling saturated: requested demand 8, effective cap 4. Remediation: `workflow runner up --max-concurrency 8`."
  ]);

  const paused = await diagnose("paused", "Run was gracefully paused; resume with `smithers up --resume <runId>`.", []);
  assert.equal(paused.summary, "Run was gracefully paused; resume with `ultrafuzz resume smithers-probe`.");
});

test("diagnoseRun rejects an unexpected engine response", async () => {
  const { project, env } = await inspectedRun({});
  fs.writeFileSync(path.join(project, "fake-why.json"), "not json\n", "utf8");

  const diagnosis = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(diagnosis.ok, false);
  assert.equal(diagnosis.diagnostics.at(-1)?.code, "WORKFLOW_DIAGNOSIS_INVALID");
});

test("diagnoseRun rejects aliases, extra fields, and duplicate keys instead of normalizing them", async () => {
  const { project, env } = await inspectedRun({
    why: {
      runId: WORKFLOW_RUN_ID,
      status: "running",
      summary: "blocked",
      generatedAtMs: 1_700_000_000_000,
      currentNodeId: "node:project-discovery",
      warnings: [],
      information: [],
      blockers: [
        {
          kind: "side-effect-boundary-crossed",
          nodeId: "node:project-discovery",
          iteration: 0,
          reason: "boundary crossed",
          waitingSince: 1_699_999_000_000,
          unblocker: "review"
        }
      ]
    }
  });
  const fixturePath = path.join(project, "fake-why.json");
  const exactText = fs.readFileSync(fixturePath, "utf8");
  const exact = JSON.parse(exactText) as { data: { blockers: Array<Record<string, unknown>> } } & Record<
    string,
    unknown
  >;

  exact.data.blockers[0]!.kind = "side-effect-boundary";
  fs.writeFileSync(fixturePath, `${JSON.stringify(exact)}\n`, "utf8");
  const alias = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });
  assert.equal(alias.ok, false);
  assert.equal(alias.diagnostics.at(-1)?.code, "WORKFLOW_DIAGNOSIS_INVALID");

  const withExtra = JSON.parse(exactText) as Record<string, unknown>;
  withExtra.legacy = true;
  fs.writeFileSync(fixturePath, `${JSON.stringify(withExtra)}\n`, "utf8");
  const extra = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });
  assert.equal(extra.ok, false);
  assert.equal(extra.diagnostics.at(-1)?.code, "WORKFLOW_DIAGNOSIS_INVALID");

  fs.writeFileSync(fixturePath, exactText.replace('{"ok":true,', '{"ok":true,"ok":true,'), "utf8");
  const duplicate = await diagnoseRun({ projectRoot: project, runId: "inspect-run", env });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.diagnostics.at(-1)?.code, "WORKFLOW_DIAGNOSIS_INVALID");
});

test("getRunTimeline adapts frames and fork lineage in tree mode", async () => {
  const { project, env } = await inspectedRun({
    timeline: {
      timeline: {
        runId: WORKFLOW_RUN_ID,
        branch: null,
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
            branch: {
              runId: `${WORKFLOW_RUN_ID}-forked`,
              parentRunId: WORKFLOW_RUN_ID,
              parentFrameNo: 4,
              branchLabel: "retry",
              forkDescription: "smithers fork",
              createdAtMs: 1_700_000_650_000
            },
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
  const { project, env, runRoot } = await inspectedRun({
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
  const { project, env } = await inspectedRun({
    snapshots: {
      snapshots: [
        {
          runId: WORKFLOW_RUN_ID,
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

test("queryWorkflowEvents returns lifecycle events while execution holds the control lock", async () => {
  const { project, env, runRoot } = await inspectedRun({
    events: [
      smithersEventLine({
        seq: 1,
        timestampMs: 1_700_000_000_000,
        type: "NodeStarted",
        payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
      }),
      smithersEventLine({
        seq: 2,
        timestampMs: 1_700_000_060_000,
        type: "AgentTraceSummary",
        payload: {
          nodeId: "node:project-discovery",
          iteration: 0,
          attempt: 1,
          agentId: "fixture-agent"
        }
      }),
      smithersEventLine({
        seq: 3,
        timestampMs: 1_700_000_120_000,
        type: "NodeCancelled",
        payload: {
          nodeId: "node:project-discovery",
          iteration: 0,
          attempt: 1,
          reason: "smithers finished the run"
        }
      })
    ].join("\n")
  });

  const linkJournalPath = path.join(runRoot, "smithers", "workflow-run-link-journal.json");
  const linkJournalBefore = fs.readFileSync(linkJournalPath);
  const release = await acquireWorkflowControlLock(layoutForRunRoot(runRoot, "inspect-run"));
  const eventsPromise = queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 50 });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const winner = await Promise.race([
      eventsPromise.then(() => "events" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), 10_000);
      })
    ]);
    assert.equal(winner, "events", "events waited on the execution-only workflow control lock");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await release();
  }
  const events = await eventsPromise;

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.limit, 50);
  assert.equal(events.value?.truncated, false);
  assert.equal(events.value?.events.length, 3);
  assert.equal(events.value?.events[0]?.category, "NodeStarted");
  assert.equal(events.value?.events[0]?.node_id, "node:project-discovery");
  assert.equal(events.value?.events[0]?.attempt, 1);
  assert.equal(events.value?.events[0]?.timestamp, new Date(1_700_000_000_000).toISOString());
  assert.equal(events.value?.events[1]?.category, "AgentTraceSummary");
  assert.equal(events.value?.events[1]?.node_id, "node:project-discovery");
  assert.equal(events.value?.events[1]?.detail, null);
  assert.equal(events.value?.events[2]?.detail, "workflow runner finished the run");
  assertNoEngineBranding(events.value);
  const log = smithersLog(project);
  assert.match(log, new RegExp(`events ${WORKFLOW_RUN_ID} --limit 50 --json`, "u"));
  assert.doesNotMatch(log, /--raw/u);
  assert.doesNotMatch(log, /--watch/u);
  assert.deepEqual(fs.readFileSync(linkJournalPath), linkJournalBefore);
});

test("queryWorkflowEvents rejects malformed, aliased, mismatched, extra-field, duplicate-key, and blank records", async () => {
  const { project, env } = await inspectedRun({ events: "" });
  const fixturePath = path.join(project, "fake-events.ndjson");
  const exactLine = smithersEventLine({
    seq: 1,
    timestampMs: 1_700_000_000_000,
    type: "NodeStarted",
    payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
  });
  const mismatched = JSON.parse(exactLine) as { payload: Record<string, unknown> };
  mismatched.payload.runId = "another-run";
  const extra = JSON.parse(exactLine) as Record<string, unknown>;
  extra.legacy = true;
  const duplicate = exactLine.replace('{"runId":', '{"runId":"duplicate","runId":');
  const secondLine = smithersEventLine({
    seq: 2,
    timestampMs: 1_700_000_000_001,
    type: "NodeFinished",
    payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
  });
  const cases = [
    "not json",
    smithersEventLine({
      seq: 1,
      timestampMs: 1_700_000_000_000,
      type: "node.started",
      payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
    }),
    JSON.stringify(mismatched),
    JSON.stringify(extra),
    duplicate,
    `${exactLine}\n\n${secondLine}`
  ];

  for (const records of cases) {
    fs.writeFileSync(fixturePath, `${records}\n`, "utf8");
    const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });
    assert.equal(events.ok, false, records);
    assert.equal(events.diagnostics[0]?.code, "WORKFLOW_EVENTS_INVALID", records);
  }
});

test("queryWorkflowEvents retries an unterminated final record from a live append snapshot", async () => {
  const exactLine = smithersEventLine({
    seq: 1,
    timestampMs: 1_700_000_000_000,
    type: "NodeStarted",
    payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
  });
  const { project, env } = await inspectedRun({
    eventsFirstRead: exactLine.slice(0, -1),
    events: `${exactLine}\n`
  });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.events.length, 1);
  assert.equal(events.value?.events[0]?.sequence, 1);
  assert.equal(smithersLog(project).match(/events ultrafuzz-inspect-run/gu)?.length, 2);
});

test("queryWorkflowEvents does not retry malformed non-final records", async () => {
  const exactLine = smithersEventLine({
    seq: 2,
    timestampMs: 1_700_000_000_001,
    type: "NodeFinished",
    payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
  });
  const { project, env } = await inspectedRun({ events: `{"unterminated":"value\n${exactLine}\n` });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(events.ok, false);
  assert.equal(events.diagnostics[0]?.code, "WORKFLOW_EVENTS_INVALID");
  assert.equal(smithersLog(project).match(/events ultrafuzz-inspect-run/gu)?.length, 1);
});

test("queryWorkflowEvents bounds retries for a persistently malformed final record", async () => {
  const { project, env } = await inspectedRun({ events: '{"unterminated":"value' });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(events.ok, false);
  assert.equal(events.diagnostics[0]?.code, "WORKFLOW_EVENTS_INVALID");
  assert.equal(smithersLog(project).match(/events ultrafuzz-inspect-run/gu)?.length, 3);
});

test("queryWorkflowEvents caps the limit and reports truncation", async () => {
  const lines = Array.from({ length: 5 }, (_, index) =>
    smithersEventLine({
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "NodePending",
      payload: { nodeId: "node:project-discovery", iteration: 0 }
    })
  );
  const { project, env } = await inspectedRun({ events: lines.join("\n") });

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
  const { project, env } = await inspectedRun({ events: "" });

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
  const { project, env } = await inspectedRun({
    events: [
      smithersEventLine({
        seq: 1,
        timestampMs: 1_700_000_000_000,
        type: "NodeStarted",
        payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
      }),
      smithersEventLine({
        seq: 2,
        timestampMs: 1_700_000_030_000,
        type: "NodeFinished",
        payload: { nodeId: "node:project-discovery", iteration: 0, attempt: 1 }
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
  assert.equal(streamed[1]?.detail, null);
  assert.match(smithersLog(project), /events ultrafuzz-inspect-run --limit 200 --watch --json --interval 1/u);
});

test("watchWorkflowEvents stops streaming when the caller aborts", async () => {
  const { project, env } = await inspectedRun({ events: "" });
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
  const { project, env } = await inspectedRun({ events: "" });
  failFakeInspectionRunner(project, "run not found", 4);

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
  const { project, env } = await inspectedRun({ events: "" });
  // An OOM-style external kill leaves no exit code, which must still be a
  // failure rather than an empty success.
  enableFakeInspectionControl(project, "kill-self");

  const queried = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(queried.ok, false);
  assert.equal(queried.diagnostics[0]?.code, "WORKFLOW_EVENTS_QUERY_FAILED");
  assert.match(queried.diagnostics[0]?.message ?? "", /terminated by SIGKILL/u);
  assertNoEngineBranding(queried.diagnostics);
});

test("a truncated event stream stays successful even though the process is killed", async () => {
  const lines = Array.from({ length: 4 }, (_, index) =>
    smithersEventLine({
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "NodePending",
      payload: { nodeId: "node:project-discovery", iteration: 0 }
    })
  );
  const { project, env } = await inspectedRun({ events: lines.join("\n") });

  const events = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 2 });

  assert.equal(events.ok, true, JSON.stringify(events.diagnostics));
  assert.equal(events.value?.truncated, true);
  assert.equal(events.value?.events.length, 2);
});

test("getWorkflowNode returns focused status without attempt or tool detail by default", async () => {
  const { project, env } = await inspectedRun({ node: nodeDetailFixture() });

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
  assert.equal(node.value?.status, "finished");
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

test("getWorkflowNode accepts a reset current attempt below retained history", async () => {
  const detail = nodeDetailFixture() as {
    node: { lastAttempt: number };
    attempts: Array<{
      attempt: number;
      state: string;
      tokenUsage: Record<string, unknown>;
      toolCalls: Array<{ attempt: number }>;
    }>;
    toolCalls: Array<{ attempt: number }>;
    tokenUsage: { byAttempt: Array<{ attempt: number; usage: Record<string, unknown> }> };
  };
  const [historical, current] = detail.attempts;
  assert.ok(historical);
  assert.ok(current);
  // The runner presents retained attempts in numeric order, while lastAttempt
  // identifies the current occurrence after a reset reuses the counter.
  const retained = {
    ...historical,
    attempt: 2,
    toolCalls: historical.toolCalls.map((call) => ({ ...call, attempt: 2 }))
  };
  detail.attempts = [{ ...current, attempt: 1 }, retained];
  detail.toolCalls = retained.toolCalls;
  detail.tokenUsage.byAttempt = detail.attempts.map((attempt) => ({
    attempt: attempt.attempt,
    usage: attempt.tokenUsage
  }));
  detail.node.lastAttempt = 1;
  const { project, env } = await inspectedRun({ node: detail });

  const node = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    attempts: true,
    env
  });

  assert.equal(node.ok, true, JSON.stringify(node.diagnostics));
  assert.deepEqual(
    node.value?.attempts.map((attempt) => attempt.attempt),
    [1, 2]
  );
  assert.deepEqual(
    node.value?.attempts.map((attempt) => attempt.state),
    ["finished", "failed"]
  );
});

test("getWorkflowNode includes attempts on request and tool payloads only with --tools", async () => {
  const { project, env } = await inspectedRun({ node: nodeDetailFixture() });

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

test("watchWorkflowNode accepts clean raw JSONL records", async () => {
  const detail = JSON.stringify(nodeDetailFixture());
  const { project, env } = await inspectedRun({
    nodeWatchLines: `${detail}\n${detail}\n${detail}\n`
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

test("watchWorkflowNode rejects terminal control bytes instead of repairing JSONL", async () => {
  const detail = JSON.stringify(nodeDetailFixture());
  const { project, env } = await inspectedRun({
    nodeWatchLines: `${detail}\n\u001B[2J\u001B[0f${detail}\n`
  });

  const watched = await watchWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    env,
    onSnapshot: () => undefined
  });

  assert.equal(watched.ok, false);
  assert.equal(watched.diagnostics[0]?.code, "WORKFLOW_NODE_INVALID");
});

test("cancelRun converges when the engine reports the run is already terminal", async () => {
  const { project, env, runRoot } = await launchedProject({});
  // The engine answers RUN_NOT_ACTIVE with exit 4 once a run is cancelled, so
  // rerunning cancel to confirm an in-flight request must not error.
  enableFakeInspectionControl(project, "cancel-terminal");

  const confirmed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(confirmed.ok, true, JSON.stringify(confirmed.diagnostics));
  assert.equal(confirmed.value?.status, "canceled");
  assert.equal(confirmed.value?.confirmed, true);
  const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8")) as { status: string };
  assert.equal(state.status, "canceled");
});

test("cancelRun still fails on an unrelated engine error exit", async () => {
  const { project, env } = await inspectedRun({});
  failFakeInspectionRunner(project, "database is locked", 4);

  const failed = await cancelRun({ projectRoot: project, runId: "inspect-run", env });

  assert.equal(failed.ok, false);
  assert.equal(failed.diagnostics[0]?.code, "WORKFLOW_CANCEL_FAILED");
});

test("queryWorkflowEvents does not call an exact-limit result truncated", async () => {
  const lines = Array.from({ length: 2 }, (_, index) =>
    smithersEventLine({
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "NodePending",
      payload: { nodeId: "node:project-discovery", iteration: 0 }
    })
  );
  const { project, env } = await inspectedRun({ events: lines.join("\n") });

  const exact = await queryWorkflowEvents({ projectRoot: project, runId: "inspect-run", env, limit: 2 });

  assert.equal(exact.ok, true, JSON.stringify(exact.diagnostics));
  assert.equal(exact.value?.events.length, 2);
  assert.equal(exact.value?.truncated, false);
});

test("watchWorkflowEvents stops the stream when the caller aborts mid-stream", async () => {
  const lines = Array.from({ length: 200 }, (_, index) =>
    smithersEventLine({
      seq: index,
      timestampMs: 1_700_000_000_000 + index,
      type: "NodePending",
      payload: { nodeId: "node:project-discovery", iteration: 0 }
    })
  );
  const { project, env } = await inspectedRun({ events: lines.join("\n") });
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
  const { project, env } = await inspectedRun({ node: { status: "succeeded" } });

  const node = await getWorkflowNode({
    projectRoot: project,
    runId: "inspect-run",
    nodeId: "node:project-discovery",
    env
  });

  assert.equal(node.ok, false);
  assert.equal(node.diagnostics[0]?.code, "WORKFLOW_NODE_INVALID");
});

test("diagnoseProject reports the installed runner that commands after launch execute", async () => {
  const { project, env } = projectWithFakeRunner();
  // A project-local engine is target-owned and never becomes controller authority.
  writeFakeInstalledEngine(project, { version: "0.29.0" });

  const doctor = await diagnoseProject({ projectRoot: project, env, offline: true });

  assert.equal(doctor.value?.workflow_engine.installed_version, SMITHERS_VERSION);
  assert.equal(doctor.value?.workflow_engine.required_version, SMITHERS_VERSION);
  assert.equal(doctor.value?.workflow_engine.bin_path, installedWorkflowRunner().executable);
  assert.equal(doctor.value?.workflow_engine.layout_status, "ok");
  assert.equal(doctor.value?.workflow_engine.layout_detail, null);
  for (const name of ["workflow-engine-install", "workflow-engine-patches"]) {
    assert.equal(doctor.value?.checks.find((check) => check.name === name)?.status, "ok", name);
  }
  assert.equal(typeof doctor.value?.validation.policy_posture.config?.status, "string");
  assert.ok(doctor.value?.toolchain.some((entry) => entry.name === "forge"));
});

test("diagnoseProject reports an installed runner inside the target project as refused, as launch and resume do", async () => {
  // Ultrafuzz's own checkout audited as the target: its installed runner lies
  // inside the project, so launch and resume refuse to bind it.
  const checkout = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."));
  assert.ok(
    installedWorkflowRunner().executable.startsWith(`${checkout}${path.sep}`),
    "the runner is in this checkout"
  );
  const refusal = "workflow runner cannot be inside the target project";
  assert.throws(() => bindInstalledWorkflowRunner({}, checkout), { message: refusal });

  const doctor = await diagnoseProject({
    projectRoot: checkout,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: allAvailable
  });

  assert.deepEqual(
    doctor.value?.checks.find((check) => check.name === "workflow-engine-install"),
    {
      name: "workflow-engine-install",
      status: "error",
      summary: `launch and resume refuse the installed workflow engine for this project: ${refusal}`
    }
  );
  assert.equal(doctor.value?.workflow_engine.layout_status, "error");
  assert.equal(doctor.value?.workflow_engine.layout_detail, refusal);
  // Only its location is refused: the runner carries every patch.
  assert.equal(doctor.value?.checks.find((check) => check.name === "workflow-engine-patches")?.status, "ok");
  assert.equal(doctor.value?.ok, false);
});

test("diagnoseProject reports a missing credential for a selected OpenRouter profile", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const configPath = path.join(project, "ultrafuzz.toml");
  fs.writeFileSync(
    configPath,
    fs
      .readFileSync(configPath, "utf8")
      .replace(
        'agent = "CodexAgent"\nmodel = "gpt-5.5"\nreasoning = "xhigh"',
        'agent = "OpenRouterAgent"\nmodel = "~anthropic/claude-sonnet-latest:free"\nreasoning = "high"'
      ),
    "utf8"
  );
  const probe = async (names: readonly string[]) =>
    names.map((name) => ({ name, available: true, path: `/usr/bin/${name}`, version: "test" }));

  const missing = await diagnoseProject({
    projectRoot: project,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: probe
  });
  assert.equal(missing.value?.checks.find((check) => check.name === "agent-credentials")?.status, "error");
  assert.ok(missing.diagnostics.some((entry) => entry.code === "DOCTOR_AGENT_CREDENTIAL_MISSING"));

  const ready = await diagnoseProject({
    projectRoot: project,
    env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "test-key" },
    offline: true,
    requiredCommandProbe: probe
  });
  assert.equal(ready.value?.checks.find((check) => check.name === "agent-credentials")?.status, "ok");
  assert.equal(
    ready.diagnostics.some((entry) => entry.code === "DOCTOR_AGENT_CREDENTIAL_MISSING"),
    false
  );
});

test("diagnoseProject checks an OpenRouter profile selected only by topology", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  addOpenRouterProfile(project);
  writeSmallTopology(project);
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    model_profiles:\n      - openrouter\n"
      ),
    "utf8"
  );
  const probe = async (names: readonly string[]) =>
    names.map((name) => ({ name, available: true, path: `/usr/bin/${name}`, version: "test" }));

  const missing = await diagnoseProject({
    projectRoot: project,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: probe
  });

  assert.equal(missing.value?.checks.find((check) => check.name === "agent-credentials")?.status, "error");
  assert.ok(missing.diagnostics.some((entry) => entry.code === "DOCTOR_AGENT_CREDENTIAL_MISSING"));
});

test("diagnoseProject checks an OpenRouter profile selected by a runtime topology override", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  addOpenRouterProfile(project);
  writeSmallTopology(project);
  const configuredTopologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  const overrideTopologyPath = path.join(project, ".ultrafuzz", "openrouter-topology.yml");
  fs.writeFileSync(
    overrideTopologyPath,
    fs
      .readFileSync(configuredTopologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    model_profiles:\n      - openrouter\n"
      ),
    "utf8"
  );
  const probe = async (names: readonly string[]) =>
    names.map((name) => ({ name, available: true, path: `/usr/bin/${name}`, version: "test" }));

  const configured = await diagnoseProject({
    projectRoot: project,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: probe
  });
  assert.equal(configured.value?.checks.find((check) => check.name === "agent-credentials")?.status, "ok");

  const overridden = await diagnoseProject({
    projectRoot: project,
    topologyPath: overrideTopologyPath,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: probe
  });
  assert.equal(overridden.value?.validation.policy_posture.topology?.status, "pass");
  assert.equal(overridden.value?.checks.find((check) => check.name === "agent-credentials")?.status, "error");
  assert.ok(overridden.diagnostics.some((entry) => entry.code === "DOCTOR_AGENT_CREDENTIAL_MISSING"));
});

test("diagnoseProject reports commands required by the active topology", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");

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

test("diagnoseProject requires only the CLIs of agents the selected topology can dispatch to", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  // The scaffold also configures Claude, DeepSeek, Kimi, and Pi profiles; only Codex is installed.
  const installed = new Set(["git", "node", "forge", "codex"]);
  const diagnose = () =>
    diagnoseProject({
      projectRoot: project,
      env: { PATH: "/usr/bin" },
      offline: true,
      requiredCommandProbe: async (names) =>
        names.map((name) => ({
          name,
          available: installed.has(name),
          path: installed.has(name) ? `/usr/bin/${name}` : null,
          version: null
        }))
    });

  const codexOnly = await diagnose();
  const toolchainCheck = codexOnly.value?.checks.find((check) => check.name === "toolchain");
  assert.equal(toolchainCheck?.status, "ok");
  assert.match(toolchainCheck?.summary ?? "", /^4 required commands available /u);
  assert.deepEqual(
    codexOnly.value?.toolchain.map((entry) => [entry.name, entry.required]),
    [
      ["git", true],
      ["node", true],
      ["forge", true],
      ["claude", false],
      ["codex", true],
      ["kimi", false],
      ["pi", false]
    ]
  );

  // A retry fallback is dispatched to as well.
  const configPath = path.join(project, "ultrafuzz.toml");
  const config = fs.readFileSync(configPath, "utf8");
  fs.writeFileSync(configPath, `${config}\n[retry]\nagents = ["default", "kimi"]\n`, "utf8");
  const withFallback = await diagnose();
  assert.equal(withFallback.value?.toolchain.find((entry) => entry.name === "kimi")?.required, true);
  assert.ok(
    withFallback.diagnostics.some(
      (entry) => entry.code === "DOCTOR_TOOLCHAIN_MISSING" && entry.message.endsWith(": kimi")
    )
  );

  // Codex also runs OpenRouterAgent, so an unselected profile of either agent cannot waive
  // the requirement the selected one makes.
  fs.writeFileSync(configPath, config, "utf8");
  addOpenRouterProfile(project);
  const codexWithUnusedOpenRouter = await diagnose();
  assert.equal(codexWithUnusedOpenRouter.value?.toolchain.find((entry) => entry.name === "codex")?.required, true);
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    model_profiles:\n      - openrouter\n"
      ),
    "utf8"
  );
  const openRouterOnly = await diagnose();
  assert.equal(openRouterOnly.value?.toolchain.find((entry) => entry.name === "codex")?.required, true);
});

test("diagnoseProject reports controller roots in the temporary directory and leaves them in place", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const temporary = temporaryRoot("ufz-doctor-tmpdir-");
  for (const [name, mebibytes] of [
    ["ultrafuzz-controller-first", 1],
    ["ultrafuzz-controller-second", 2],
    ["unrelated", 4]
  ] as const) {
    fs.mkdirSync(path.join(temporary, name, ".smithers"), { recursive: true });
    fs.writeFileSync(path.join(temporary, name, ".smithers", "engine.js"), Buffer.alloc(mebibytes * 1024 * 1024));
  }

  const doctor = await withTemporaryDirectory(temporary, () =>
    diagnoseProject({
      projectRoot: project,
      env: { PATH: "/usr/bin" },
      offline: true,
      requiredCommandProbe: allAvailable
    })
  );

  assert.match(
    doctor.value?.checks.find((check) => check.name === "temporary-directory")?.summary ?? "",
    /; 2 ultrafuzz-controller-\* directories hold 3 MiB/u
  );
  assert.ok(fs.existsSync(path.join(temporary, "ultrafuzz-controller-first", ".smithers", "engine.js")));
  assert.ok(fs.existsSync(path.join(temporary, "ultrafuzz-controller-second", ".smithers", "engine.js")));
});

const devShmIsTmpfs = (() => {
  try {
    return fs.statfsSync("/dev/shm").type === 0x01021994;
  } catch {
    return false;
  }
})();

test(
  "diagnoseProject warns, without failing, when the temporary directory is RAM-backed",
  { skip: devShmIsTmpfs ? false : "/dev/shm is not a tmpfs mount on this host" },
  async () => {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project);
    const temporary = registerTemporaryPath(fs.mkdtempSync("/dev/shm/ufz-doctor-"));

    const doctor = await withTemporaryDirectory(temporary, () =>
      diagnoseProject({
        projectRoot: project,
        env: { PATH: "/usr/bin" },
        offline: true,
        requiredCommandProbe: allAvailable
      })
    );

    assert.equal(doctor.value?.checks.find((check) => check.name === "temporary-directory")?.status, "warning");
    const warning = doctor.diagnostics.find((entry) => entry.code === "DOCTOR_TEMPORARY_DIRECTORY_CONSTRAINED");
    assert.equal(warning?.severity, "warning");
    assert.match(warning?.message ?? "", /is a RAM-backed tmpfs/u);
  }
);

test("diagnoseProject warns when the temporary directory has little free space", async (context) => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const temporary = temporaryRoot("ufz-doctor-full-");
  const statfsSync = fs.statfsSync;
  context.mock.method(fs, "statfsSync", (target: fs.PathLike) => ({ ...statfsSync(target), bavail: 1 }));

  const doctor = await withTemporaryDirectory(temporary, () =>
    diagnoseProject({
      projectRoot: project,
      env: { PATH: "/usr/bin" },
      offline: true,
      requiredCommandProbe: allAvailable
    })
  );

  assert.equal(doctor.value?.checks.find((check) => check.name === "temporary-directory")?.status, "warning");
  assert.match(
    doctor.diagnostics.find((entry) => entry.code === "DOCTOR_TEMPORARY_DIRECTORY_CONSTRAINED")?.message ?? "",
    /has less than 2 GiB free/u
  );
});

test("diagnoseProject reports a lower bound once sizing many controller roots runs out of time", async (context) => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const temporary = temporaryRoot("ufz-doctor-many-roots-");
  for (let index = 0; index < 100; index += 1) {
    const root = path.join(temporary, `ultrafuzz-controller-${String(index)}`);
    fs.mkdirSync(root);
    // A sparse 1 MiB file, so the size is counted without writing the bytes.
    fs.writeFileSync(path.join(root, "engine.js"), "");
    fs.truncateSync(path.join(root, "engine.js"), 1024 * 1024);
  }
  // A slow filesystem: each clock reading is 100 ms after the previous one, so
  // sizing all 100 roots would take far longer than doctor's budget.
  let now = 0;
  context.mock.method(performance, "now", () => (now += 100));
  const readdirSync = context.mock.method(fs, "readdirSync");

  const doctor = await withTemporaryDirectory(temporary, () =>
    diagnoseProject({
      projectRoot: project,
      env: { PATH: "/usr/bin" },
      offline: true,
      requiredCommandProbe: allAvailable
    })
  );

  const summary = doctor.value?.checks.find((check) => check.name === "temporary-directory")?.summary ?? "";
  const sized = /; 100 ultrafuzz-controller-\* directories hold at least (\d+) MiB/u.exec(summary);
  assert.ok(sized !== null, summary);
  assert.ok(Number(sized[1]) < 100, summary);
  // Each root holds 1 MiB, so every root doctor opens is counted except the
  // one being read when the budget runs out. No root is opened after that.
  const opened = readdirSync.mock.calls.filter((call) => path.dirname(String(call.arguments[0])) === temporary);
  assert.ok(opened.length <= Number(sized[1]) + 1, `${String(opened.length)} roots opened; ${summary}`);
});

async function allAvailable(names: readonly string[]) {
  return names.map((name) => ({ name, available: true, path: `/usr/bin/${name}`, version: null }));
}

async function withTemporaryDirectory<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

test("diagnoseProject rejects cwd-dependent PATH entries that are unavailable in task worktrees", async () => {
  for (const searchPath of ["bin", ""]) {
    const project = tempProject();
    initProject({ projectRoot: project, force: true });
    writeSmallTopology(project, "recon");
    const executableDir = searchPath === "" ? project : path.join(project, searchPath);
    fs.mkdirSync(executableDir, { recursive: true });
    const executable = path.join(executableDir, "recon");
    fs.writeFileSync(executable, "#!/bin/sh\necho recon test\n", "utf8");
    fs.chmodSync(executable, 0o755);

    const doctor = await diagnoseProject({ projectRoot: project, env: { PATH: searchPath }, offline: true });

    assert.equal(doctor.value?.toolchain.find((entry) => entry.name === "recon")?.available, false);
    assert.ok(doctor.diagnostics.some((entry) => entry.code === "DOCTOR_TOOLCHAIN_MISSING"));
  }
});

test("diagnoseProject still probes the local toolchain when the project config does not resolve", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  const configPath = path.join(project, "ultrafuzz.toml");
  const scaffold = fs.readFileSync(configPath, "utf8");
  assert.ok(scaffold.includes('[execution]\nmode = "local"'), scaffold);
  fs.writeFileSync(configPath, scaffold.replace('[execution]\nmode = "local"', '[execution]\nmode = "cloud"'), "utf8");
  let probed: readonly string[] = [];

  const doctor = await diagnoseProject({
    projectRoot: project,
    env: { PATH: "/usr/bin" },
    offline: true,
    requiredCommandProbe: async (names) => {
      probed = names;
      return allAvailable(names);
    }
  });

  assert.ok(doctor.diagnostics.some((entry) => entry.code === "CONFIG_EXECUTION_CLOUD_REMOVED"));
  for (const name of ["git", "node", "forge"]) assert.ok(probed.includes(name), `${name} probed: ${probed.join(",")}`);
  assert.equal(doctor.value?.checks.find((check) => check.name === "toolchain")?.status, "ok");
  assert.equal(
    doctor.diagnostics.some((entry) => entry.code === "DOCTOR_TOOLCHAIN_MISSING"),
    false
  );
});

test("diagnoseProject never executes a target-local required-command shim", async () => {
  const project = tempProject();
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project, "recon");
  const executable = path.join(project, ".smithers", "node_modules", ".bin", "recon");
  const marker = path.join(project, "target-recon-ran");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, `#!/bin/sh\nprintf hostile > ${shellQuote(marker)}\necho recon test\n`, "utf8");
  fs.chmodSync(executable, 0o755);

  const doctor = await diagnoseProject({ projectRoot: project, env: { PATH: undefined }, offline: true });

  assert.equal(doctor.value?.toolchain.find((entry) => entry.name === "recon")?.available, false);
  assert.equal(fs.existsSync(marker), false);
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
  assert.match(run.diagnostics[0]?.message ?? "", /recon \(required by project-discovery\)/u);
  assert.deepEqual(run.diagnostics[0]?.details, {
    commands: ["recon"],
    requirements: [{ command: "recon", node_ids: ["project-discovery"] }]
  });
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
    required_commands: [covg-eval]
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
  assert.deepEqual(validation.value?.topology?.required_commands, ["covg-eval"]);

  let probed: readonly string[] = [];
  const run = await startRun({
    projectRoot: project,
    runId: "transformed-command-requirements",
    topologyTransform: { excludedNodeIds: ["required-branch"] },
    requiredCommandProbe: async (commands) => {
      probed = commands;
      return commands.map((name) => ({ name, available: false, path: null, version: null }));
    }
  });

  assert.deepEqual(probed, ["covg-eval"]);
  assert.equal(run.diagnostics[0]?.code, "RUN_REQUIRED_COMMAND_MISSING");
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "runs", "transformed-command-requirements")), false);
});

// The scheduler and engine workarounds are the two that carry durable resume
// progress, and an unreported posture reads as healthy. Cover every tracked
// workaround, not just the CLI pair.
test("installation inspection reports a posture for every tracked compatibility patch", async () => {
  const project = tempProject();
  writeFakeInstalledEngine(project, { version: SMITHERS_VERSION });
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
  // Every whole-file posture must be exercised at least once; additional
  // single-workaround sources cycle back through the rotation.
  assert.ok(
    singleSources.length >= wholeFilePostures.length,
    "not enough single-workaround sources to exercise every whole-file posture"
  );
  const expected: Record<string, string> = {};
  let singleIndex = 0;
  for (const [source, patches] of bySource) {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    if (patches.length === 1) {
      const patch = patches[0]!;
      const posture = wholeFilePostures[singleIndex % wholeFilePostures.length]!;
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

  const runnerRoot = path.join(nodeModules, "smthrs");
  const reported = inspectSmithersInstallation(runnerRoot).compatibility_patches;
  assert.deepEqual(reported, expected);
  // Named explicitly: these two were previously omitted from the posture report.
  assert.ok(Object.hasOwn(reported, "terminal_state_restore"));
  assert.ok(Object.hasOwn(reported, "resume_hydration"));
  // Commands never run a runner that lacks a patch.
  const unapplied = Object.values(expected).filter((posture) => posture !== "applied").length;
  assert.throws(
    () => patchedWorkflowRunner(runnerRoot),
    new RegExp(
      `lacks ${String(unapplied)} of ${String(Object.keys(expected).length)} Ultrafuzz compatibility patches \\(ultrafuzz doctor lists them\\); reinstall and rebuild Ultrafuzz in its repository checkout: pnpm install --frozen-lockfile && pnpm -w build$`,
      "u"
    )
  );
});

test("installation inspection refuses a missing, mismatched or retargeted runner", () => {
  const project = tempProject();
  const runnerRoot = path.join(project, ".smithers", "node_modules", "smthrs");

  const missing = inspectSmithersInstallation(runnerRoot);
  assert.equal(missing.installed_version, null);
  assert.notEqual(missing.layout_error, null);

  writeFakeInstalledEngine(project, { version: "0.29.0" });
  const mismatched = inspectSmithersInstallation(runnerRoot);
  assert.equal(mismatched.installed_version, "0.29.0");
  assert.match(mismatched.layout_error ?? "", /is not the pinned release 0\.35\.0/u);

  writeFakeInstalledEngine(project, { version: SMITHERS_VERSION, binTarget: "dist/other.js" });
  const retargeted = inspectSmithersInstallation(runnerRoot);
  assert.equal(retargeted.installed_bin_target, "dist/other.js");
  assert.match(retargeted.layout_error ?? "", /unexpected workflow runner target/u);
  assert.throws(
    () => patchedWorkflowRunner(runnerRoot),
    /unexpected workflow runner target; reinstall and rebuild Ultrafuzz in its repository checkout: pnpm install --frozen-lockfile && pnpm -w build$/u
  );
});

test("diagnoseProject keeps an offline registry lookup non-fatal", async () => {
  const { project, env } = projectWithFakeRunner();
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

function writeFakeInstalledEngine(project: string, input: { version: string; binTarget?: string }): void {
  const packageRoot = path.join(project, ".smithers", "node_modules", "smthrs");
  const target = path.join(packageRoot, ...SMITHERS_BIN_PATH.split("/"));
  const shim = path.join(project, ".smithers", "node_modules", ".bin", "smithers");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "smthrs",
      version: input.version,
      bin: { smithers: input.binTarget ?? SMITHERS_BIN_PATH }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(target, "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n", "utf8");
  fs.chmodSync(target, 0o755);
  fs.rmSync(shim, { force: true });
  fs.symlinkSync(path.relative(path.dirname(shim), target), shim);
}

function nodeTokenUsage(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    inputTokens,
    // New in Smithers 0.35.0's node detail. `emptyTokenUsage()` seeds it and every
    // parse, merge and aggregate carries it, so it is on every node of every run.
    freshInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    eventCount: 1,
    models: ["gpt-test"],
    agents: ["codex"]
  };
}

function nodeDetailFixture(): unknown {
  const firstUsage = nodeTokenUsage(10, 5);
  const secondUsage = nodeTokenUsage(12, 6);
  const firstToolCall = {
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
  };
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
    status: "finished",
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
        tokenUsage: firstUsage,
        toolCalls: [firstToolCall],
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
        tokenUsage: secondUsage,
        toolCalls: [],
        meta: null,
        responseText: null,
        cached: true,
        jjPointer: null,
        jjCwd: null
      }
    ],
    toolCalls: [firstToolCall],
    tokenUsage: {
      inputTokens: 22,
      freshInputTokens: 22,
      outputTokens: 11,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      eventCount: 2,
      models: ["gpt-test"],
      agents: ["codex"],
      byAttempt: [
        { attempt: 1, usage: firstUsage },
        { attempt: 2, usage: secondUsage }
      ]
    },
    scorers: [],
    output: { validated: { ok: true }, raw: null, source: "cache", cacheKey: "cache-test" },
    approval: null,
    limits: { toolPayloadBytesHuman: 1_024, validatedOutputBytesHuman: 10_240 }
  };
}
