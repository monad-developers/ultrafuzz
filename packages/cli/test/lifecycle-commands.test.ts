import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/index.js";

const WORKFLOW_RUN_ID = "ultrafuzz-lifecycle-cli-run";
const RUN_ID = "lifecycle-cli-run";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-lifecycle-cli-"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function cli(project: string, argv: string[], env: Record<string, string | undefined>): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...argv, "--project", project], {
    cwd: project,
    env,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { stdout, stderr, code };
}

function parseJson(capture: Capture): Record<string, unknown> {
  return JSON.parse(capture.stdout) as Record<string, unknown>;
}

function assertNoEngineBranding(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /smithers/iu);
  // The abbreviated package name needs its own operator-facing branding check.
  assert.doesNotMatch(JSON.stringify(value), /smthrs/iu);
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
${requiredCommand === undefined ? "" : `    required_commands: [${requiredCommand}]`}
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function disablePromptReview(project: string): void {
  const configPath = path.join(project, "ultrafuzz.toml");
  const config = fs.readFileSync(configPath, "utf8");
  const withoutReview = config.replace("prompt_review_required = true", "prompt_review_required = false");
  if (withoutReview !== config) fs.writeFileSync(configPath, withoutReview, "utf8");
}

function addOpenRouterProfile(project: string): void {
  fs.appendFileSync(
    path.join(project, "ultrafuzz.toml"),
    '\n[models.openrouter]\nagent = "OpenRouterAgent"\nmodel = "~anthropic/claude-sonnet-latest:free"\nreasoning = "high"\n',
    "utf8"
  );
}

function fakeEnv(project: string, options: { cancelStatus?: string } = {}): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const whyPath = path.join(project, "fake-why.json");
  const timelinePath = path.join(project, "fake-timeline.json");
  const snapshotsPath = path.join(project, "fake-snapshots.json");
  const nodePath = path.join(project, "fake-node.json");
  const nodeWatchPath = path.join(project, "fake-node-watch.ndjson");
  const eventsPath = path.join(project, "fake-events.ndjson");
  const nodeUsage = {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    eventCount: 1,
    models: ["gpt-test"],
    agents: ["codex"]
  };
  const nodeToolCall = {
    attempt: 1,
    seq: 1,
    name: "shell",
    status: "ok",
    startedAtMs: 1_700_000_501_000,
    finishedAtMs: 1_700_000_502_000,
    durationMs: 1_000,
    input: { command: "forge build" },
    output: { note: "ok" },
    error: null
  };
  const nodeDetail = {
    node: {
      runId: WORKFLOW_RUN_ID,
      nodeId: "node:project-discovery",
      iteration: 0,
      state: "in-progress",
      lastAttempt: 1,
      updatedAtMs: 1_700_000_600_000,
      outputTable: null,
      label: null
    },
    status: "in-progress",
    durationMs: 65_000,
    attemptsSummary: { total: 1, failed: 0, cancelled: 0, succeeded: 0, waiting: 1 },
    attempts: [
      {
        runId: WORKFLOW_RUN_ID,
        nodeId: "node:project-discovery",
        attempt: 1,
        iteration: 0,
        state: "in-progress",
        startedAtMs: 1_700_000_500_000,
        finishedAtMs: null,
        durationMs: null,
        error: null,
        errorDetail: null,
        tokenUsage: nodeUsage,
        toolCalls: [nodeToolCall],
        meta: null,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: null
      }
    ],
    toolCalls: [nodeToolCall],
    tokenUsage: { ...nodeUsage, byAttempt: [{ attempt: 1, usage: nodeUsage }] },
    scorers: [],
    output: { validated: null, raw: null, source: "none", cacheKey: null },
    approval: null,
    limits: { toolPayloadBytesHuman: 1_024, validatedOutputBytesHuman: 10_240 }
  };

  fs.writeFileSync(
    whyPath,
    `${JSON.stringify({
      ok: true,
      data: {
        runId: WORKFLOW_RUN_ID,
        status: "running",
        summary: "1 node is waiting for approval",
        generatedAtMs: 1_700_000_000_000,
        currentNodeId: "node:project-discovery",
        information: [],
        blockers: [
          {
            kind: "waiting-approval",
            nodeId: "node:project-discovery",
            iteration: 0,
            reason: "waiting on a human approval",
            waitingSince: 1_699_999_000_000,
            unblocker: "approve the pending request",
            attempt: 1,
            maxAttempts: 3
          }
        ]
      },
      meta: { command: "why", duration: "1ms" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    timelinePath,
    `${JSON.stringify({
      timeline: {
        runId: WORKFLOW_RUN_ID,
        branch: null,
        frames: [
          { frameNo: 2, createdAtMs: 1_700_000_000_000, contentHash: "hash-2", forks: [] },
          { frameNo: 7, createdAtMs: 1_700_000_500_000, contentHash: "hash-7", forks: [] }
        ],
        children: []
      }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    snapshotsPath,
    `${JSON.stringify({
      snapshots: [
        {
          runId: WORKFLOW_RUN_ID,
          seq: 4,
          nodeId: "node:project-discovery",
          iteration: 0,
          attempt: 1,
          tier: 1,
          source: "node-finish",
          label: null,
          commitId: "commit-1",
          operationId: "op-1",
          cwd: "/workspace",
          createdAtMs: 1_700_000_400_000
        }
      ]
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    nodePath,
    `${JSON.stringify({
      ok: true,
      data: nodeDetail,
      meta: { command: "node", duration: "1ms" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(nodeWatchPath, `${JSON.stringify(nodeDetail)}\n`, "utf8");
  fs.writeFileSync(
    eventsPath,
    `${[
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 1,
        timestampMs: 1_700_000_000_000,
        type: "NodeStarted",
        payload: {
          runId: WORKFLOW_RUN_ID,
          timestampMs: 1_700_000_000_000,
          type: "NodeStarted",
          nodeId: "node:project-discovery",
          iteration: 0,
          attempt: 1,
          state: "in-progress"
        }
      }),
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        seq: 2,
        timestampMs: 1_700_000_060_000,
        type: "RunStatusChanged",
        payload: {
          runId: WORKFLOW_RUN_ID,
          timestampMs: 1_700_000_060_000,
          type: "RunStatusChanged",
          status: "running"
        }
      })
    ].join("\n")}\n`,
    "utf8"
  );

  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"; fi',
      'case "$1" in',
      `  why) cat ${shellQuote(whyPath)} ;;`,
      `  timeline) cat ${shellQuote(timelinePath)} ;;`,
      `  snapshots) cat ${shellQuote(snapshotsPath)} ;;`,
      "  node)",
      '    case "$*" in',
      `      *"--format jsonl"*) cat ${shellQuote(nodeWatchPath)} ;;`,
      `      *) cat ${shellQuote(nodePath)} ;;`,
      "    esac",
      "    ;;",
      `  events) cat ${shellQuote(eventsPath)} ;;`,
      "  inspect)",
      `    printf '{"ok":true,"data":{"run":{"id":"%s","workflow":"workflow","status":"running","started":"2026-08-09T00:00:00.000Z","elapsed":"1s"},"runState":{"runId":"%s","state":"running","computedAt":"2026-08-09T00:00:01.000Z"},"steps":[],"nodes":[]},"meta":{"command":"inspect","duration":"1ms"}}\\n' "$2" "$2"`,
      "    ;;",
      "  status)",
      `    printf '%s\\n' ${shellQuote(
        JSON.stringify({
          ok: true,
          data: {
            status: "running",
            verdict: "blocked",
            reason: "run `smithers why` for the blocking node",
            counts: {
              finished: 1,
              inProgress: 0,
              pending: 5,
              failed: 0,
              waitingApproval: 1,
              waitingEvent: 0,
              waitingTimer: 0,
              skipped: 0,
              other: 0,
              total: 6
            },
            modelMix: [],
            throughput: { recentFinished: 0, windowMs: 600_000, totalFinished: 1, lastFinishedAtMs: 1_000 },
            bottleneck: [],
            bottleneckOmitted: 0,
            quota: null,
            generatedAtMs: 2_000
          },
          meta: { command: "status", duration: "1ms" }
        })
      )}`,
      "    ;;",
      "  cancel)",
      `    printf '%s\\n' '{"ok":true,"data":{"status":"${options.cancelStatus ?? "cancel-requested"}"},"meta":{"command":"cancel","duration":"1ms"}}'`,
      "    exit 2",
      "    ;;",
      "  *) printf '%s\\n' '{\"ok\":true}' ;;",
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
    ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "SMITHERS_FAKE_LOG"
  };
}

async function launchedProject(
  options: { cancelStatus?: string } = {}
): Promise<{ project: string; env: Record<string, string | undefined>; runRoot: string }> {
  const project = tempProject();
  const env = fakeEnv(project, options);
  const init = await cli(project, ["init", "--json"], env);
  assert.equal(init.code, 0, init.stderr);
  disablePromptReview(project);
  writeSmallTopology(project);
  const run = await cli(project, ["run", "--run-id", RUN_ID, "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_root: string };
  return { project, env, runRoot: runData.run_root };
}

test("why reports the diagnosis in human and JSON output", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["why", RUN_ID], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Diagnosis: 1 node is waiting for approval$/mu);
  assert.match(human.stdout, /^Current node: node:project-discovery$/mu);
  assert.match(human.stdout, /waiting-approval: waiting on a human approval \(attempt 1\/3\)/u);
  assert.match(human.stdout, /unblock with: approve the pending request/u);
  assert.doesNotMatch(human.stdout, /smithers/iu);

  const json = await cli(project, ["why", RUN_ID, "--json"], env);
  assert.equal(json.code, 0, json.stderr);
  const body = parseJson(json);
  assertNoEngineBranding(body);
  assert.equal(body.command, "why");
  const data = body.data as { blockers: Array<{ kind: string; node_id: string }>; current_node_id: string };
  assert.equal(data.current_node_id, "node:project-discovery");
  assert.equal(data.blockers[0]?.kind, "waiting-approval");
});

test("timeline surfaces frame numbers for fork --frame", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["timeline", RUN_ID], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Frames: 2$/mu);
  assert.match(human.stdout, /^Latest frame: 7$/mu);
  assert.match(human.stdout, /ultrafuzz fork <run-id> --frame <n>/u);
  assert.match(human.stdout, /^frame 2: /mu);

  const json = await cli(project, ["timeline", RUN_ID, "--tree", "--json"], env);
  assert.equal(json.code, 0, json.stderr);
  const data = parseJson(json).data as { tree: boolean; latest_frame: number; frames: Array<{ frame: number }> };
  assert.equal(data.tree, true);
  assert.equal(data.latest_frame, 7);
  assert.deepEqual(
    data.frames.map((frame) => frame.frame),
    [2, 7]
  );
});

test("snapshots lists checkpoints without engine-internal identifiers", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["snapshots", RUN_ID], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Snapshots: 1$/mu);
  assert.match(human.stdout, /seq 4: node:project-discovery#0 attempt 1 \[tier1\]/u);

  const json = await cli(project, ["snapshots", RUN_ID, "--json"], env);
  assert.equal(json.code, 0, json.stderr);
  const body = parseJson(json);
  assertNoEngineBranding(body);
  assert.doesNotMatch(JSON.stringify(body), /commit-1|op-1|workspace/u);
});

test("events returns bounded lifecycle events in human and JSON output", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["events", RUN_ID], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Events: 2$/mu);
  assert.match(human.stdout, /NodeStarted node:project-discovery#0 attempt 1 - in-progress/u);

  const json = await cli(project, ["events", RUN_ID, "--limit", "1", "--json"], env);
  assert.equal(json.code, 0, json.stderr);
  const data = parseJson(json).data as { events: Array<{ category: string }>; truncated: boolean };
  assert.equal(data.events.length, 1);
  assert.equal(data.truncated, true);
  assert.doesNotMatch(fs.readFileSync(path.join(project, "smithers-commands.log"), "utf8"), /--raw/u);
});

test("events --watch streams one line per event and terminates", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["events", RUN_ID, "--watch", "--interval", "1"], env);
  assert.equal(human.code, 0, human.stderr);
  const humanLines = human.stdout.split("\n").filter(Boolean);
  assert.equal(humanLines.length, 2);
  assert.match(humanLines[0]!, /NodeStarted node:project-discovery/u);

  const json = await cli(project, ["events", RUN_ID, "--watch", "--json"], env);
  assert.equal(json.code, 0, json.stderr);
  const lines = json.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const envelope = JSON.parse(line) as Record<string, unknown>;
    assertNoEngineBranding(envelope);
    assert.equal(envelope.command, "events");
    assert.equal(envelope.ok, true);
    assert.equal(typeof envelope.schema_version, "string");
  }
});

test("node reports focused status and only expands tool payloads with --tools", async () => {
  const { project, env } = await launchedProject();

  const human = await cli(project, ["node", RUN_ID, "node:project-discovery"], env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Node: node:project-discovery#0$/mu);
  assert.match(human.stdout, /^State: in-progress \(in-progress\)$/mu);
  assert.match(human.stdout, /^Duration: 65s$/mu);
  assert.match(human.stdout, /^Attempts: 1 total, 0 succeeded, 0 failed, 0 cancelled, 1 waiting$/mu);
  assert.match(human.stdout, /^Output: not recorded$/mu);
  assert.doesNotMatch(human.stdout, /forge build/u);

  const attempts = await cli(project, ["node", RUN_ID, "node:project-discovery", "--attempts"], env);
  assert.equal(attempts.code, 0, attempts.stderr);
  assert.match(attempts.stdout, /- attempt 1: in-progress/u);
  assert.match(attempts.stdout, /tool 1 shell: ok/u);
  assert.doesNotMatch(attempts.stdout, /forge build/u);

  const tools = await cli(project, ["node", RUN_ID, "node:project-discovery", "--tools", "--json"], env);
  assert.equal(tools.code, 0, tools.stderr);
  const data = parseJson(tools).data as {
    tool_details_included: boolean;
    attempts: Array<{ tool_calls: Array<{ input?: unknown }> }>;
  };
  assert.equal(data.tool_details_included, true);
  assert.deepEqual(data.attempts[0]?.tool_calls[0]?.input, { command: "forge build" });
});

test("node --watch emits NDJSON envelopes and terminates", async () => {
  const { project, env } = await launchedProject();

  const watched = await cli(project, ["node", RUN_ID, "node:project-discovery", "--watch", "--json"], env);

  assert.equal(watched.code, 0, watched.stderr);
  const lines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(envelope.command, "node");
  assertNoEngineBranding(envelope);
  assert.match(
    fs.readFileSync(path.join(project, "smithers-commands.log"), "utf8"),
    /node node:project-discovery --run-id ultrafuzz-lifecycle-cli-run --format jsonl --watch/u
  );
});

test("events rejects a raw event category instead of widening the view", async () => {
  const { project, env } = await launchedProject();

  const rejected = await cli(project, ["events", RUN_ID, "--type", "agent", "--json"], env);

  assert.equal(rejected.code, 1);
  const body = parseJson(rejected);
  assert.equal(body.ok, false);
  assert.equal((body.diagnostics as Array<{ code: string }>)[0]?.code, "WORKFLOW_EVENTS_TYPE_UNSUPPORTED");
  // The engine must never have been asked.
  assert.equal(fs.existsSync(path.join(project, "smithers-commands.log")), true);
  assert.doesNotMatch(fs.readFileSync(path.join(project, "smithers-commands.log"), "utf8"), /--type agent/u);

  const accepted = await cli(project, ["events", RUN_ID, "--type", "node", "--json"], env);
  assert.equal(accepted.code, 0, accepted.stderr);
});

test("events --watch --json keeps a stream failure on one NDJSON line", async () => {
  const { project, env } = await launchedProject();
  fs.writeFileSync(env.SMITHERS_BIN!, "#!/bin/sh\nprintf '%s\\n' 'stream broke' >&2\nexit 3\n", "utf8");
  fs.chmodSync(env.SMITHERS_BIN!, 0o755);

  const watched = await cli(project, ["events", RUN_ID, "--watch", "--json"], env);

  assert.equal(watched.code, 1);
  const lines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.command, "events");
  assertNoEngineBranding(body);
});

test("cancel distinguishes a submitted request from a confirmed cancellation", async () => {
  const requested = await launchedProject({ cancelStatus: "cancel-requested" });

  const human = await cli(requested.project, ["cancel", RUN_ID], requested.env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Cancellation requested: lifecycle-cli-run is stopping$/mu);
  const runningState = JSON.parse(fs.readFileSync(path.join(requested.runRoot, "state.json"), "utf8")) as {
    status: string;
  };
  assert.equal(runningState.status, "running");

  const confirmed = await launchedProject({ cancelStatus: "cancelled" });
  const json = await cli(confirmed.project, ["cancel", RUN_ID, "--json"], confirmed.env);
  assert.equal(json.code, 0, json.stderr);
  const body = parseJson(json);
  assertNoEngineBranding(body);
  const data = body.data as { status: string; confirmed: boolean; run_status: string };
  assert.equal(data.status, "canceled");
  assert.equal(data.confirmed, true);
  assert.equal(data.run_status, "canceled");

  const humanConfirmed = await cli(confirmed.project, ["cancel", RUN_ID], confirmed.env);
  assert.match(humanConfirmed.stdout, /^Cancellation confirmed: lifecycle-cli-run is canceled$/mu);
});

test("doctor reports install posture in human and JSON output", async () => {
  const { project, env } = await launchedProject();
  writeSmallTopology(project, "recon");
  const doctorEnv = { ...env, PATH: path.dirname(env.SMITHERS_BIN!) };

  const human = await cli(project, ["doctor"], doctorEnv);
  assert.match(human.stdout + human.stderr, /^Project: /mu);
  assert.match(human.stdout + human.stderr, /^Workflow engine:$/mu);
  assert.match(human.stdout + human.stderr, /- bundled: \d+\.\d+\.\d+/u);
  assert.match(human.stdout + human.stderr, /- latest published stable: /u);
  assert.match(human.stdout + human.stderr, /- compatibility patches: detached snapshot transfer /u);
  // Every tracked workaround has to reach the operator, not just the first one.
  // The two resume-durability patches are the ones whose absence silently costs
  // durable resume progress, so assert them by name.
  assert.match(human.stdout + human.stderr, /- compatibility patches: .*supervisor descriptor /u);
  assert.match(human.stdout + human.stderr, /- compatibility patches: .*terminal state restore /u);
  assert.match(human.stdout + human.stderr, /- compatibility patches: .*resume hydration /u);
  assert.match(human.stdout + human.stderr, /- recon: missing from execution environment/u);
  assert.doesNotMatch(human.stdout + human.stderr, /smthrs/u);
  assert.doesNotMatch(human.stdout + human.stderr, /smthrs/iu);

  const json = await cli(project, ["doctor", "--json"], doctorEnv);
  const body = parseJson(json);
  assert.notEqual(body.data, null, `${json.stdout}${json.stderr}`);
  const data = body.data as {
    checks: Array<{ name: string; status: string }>;
    toolchain: Array<{ name: string; available: boolean }>;
    workflow_engine: { required_version: string; latest_published_version: string };
  };
  assert.ok(data.checks.some((check) => check.name === "workflow-engine-install"));
  assert.ok(data.checks.some((check) => check.name === "workflow-engine-registry"));
  assert.ok(data.toolchain.some((entry) => entry.name === "forge"));
  assert.equal(data.toolchain.find((entry) => entry.name === "recon")?.available, false);
  assert.match(data.workflow_engine.required_version, /^\d+\.\d+\.\d+$/u);
  assert.equal(typeof data.workflow_engine.latest_published_version, "string");

  addOpenRouterProfile(project);
  const topologyOverride = path.join(project, ".ultrafuzz", "openrouter-topology.yml");
  fs.writeFileSync(
    topologyOverride,
    fs
      .readFileSync(path.join(project, ".ultrafuzz", "topology.yml"), "utf8")
      .replace(
        "    prompt: setup/project-discovery.md\n",
        "    prompt: setup/project-discovery.md\n    model_profiles:\n      - openrouter\n"
      ),
    "utf8"
  );
  const override = await cli(
    project,
    ["doctor", "--topology-path", ".ultrafuzz/openrouter-topology.yml", "--json"],
    doctorEnv
  );
  const overrideBody = parseJson(override) as { diagnostics: Array<{ code?: string }> };
  assert.equal(override.code, 1);
  assert.ok(overrideBody.diagnostics.some((diagnostic) => diagnostic.code === "DOCTOR_AGENT_CREDENTIAL_MISSING"));
});

test("status recommends ultrafuzz why instead of the engine command", async () => {
  const project = tempProject();
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  inspect)",
      `    printf '{"ok":true,"data":{"run":{"id":"%s","workflow":"workflow","status":"running","started":"2026-08-09T00:00:00.000Z","elapsed":"1s"},"runState":{"runId":"%s","state":"running","computedAt":"2026-08-09T00:00:01.000Z"},"steps":[],"nodes":[]},"meta":{"command":"inspect","duration":"1ms"}}\\n' "$2" "$2"`,
      "    ;;",
      "  events)",
      "    ;;",
      "  status)",
      `    printf '%s\\n' ${shellQuote(
        JSON.stringify({
          ok: true,
          data: {
            status: "running",
            verdict: "blocked",
            reason: "run `smithers why` for the blocking node",
            counts: {
              finished: 1,
              inProgress: 0,
              pending: 5,
              failed: 0,
              waitingApproval: 1,
              waitingEvent: 0,
              waitingTimer: 0,
              skipped: 0,
              other: 0,
              total: 6
            },
            modelMix: [],
            throughput: { recentFinished: 0, windowMs: 600_000, totalFinished: 1, lastFinishedAtMs: 1_000 },
            bottleneck: [],
            bottleneckOmitted: 0,
            quota: null,
            generatedAtMs: 2_000
          },
          meta: { command: "status", duration: "1ms" }
        })
      )}`,
      "    ;;",
      "  *) printf '%s\\n' '{\"ok\":true}' ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  const env = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers
  };
  const init = await cli(project, ["init", "--json"], env);
  assert.equal(init.code, 0, init.stderr);
  disablePromptReview(project);
  writeSmallTopology(project);
  const run = await cli(project, ["run", "--run-id", RUN_ID, "--json"], env);
  assert.equal(run.code, 0, run.stderr);

  const status = await cli(project, ["status", RUN_ID, "--json"], env);

  assert.equal(status.code, 0, status.stderr);
  const data = parseJson(status).data as { reason: string };
  assert.equal(data.reason, "run `ultrafuzz why` for the blocking node");
  assertNoEngineBranding(parseJson(status));
});
