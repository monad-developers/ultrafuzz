import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// One campaign through the shipped product path: `init`, `run`, `resume`, `status`, `stats`,
// `report`, and `events` each run as their own `ultrafuzz` process, and the generated workflow runs
// on the pinned Smithers engine that `run` and `resume` install from npm and start under Bun. Only
// the model is fake: a stub `codex` executable on PATH. Other runtime and CLI tests drive a fake
// `smithers` shell script, or run the engine on hand-written workflows.

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
const MINUTE = 60_000;
const AGENT_NODES = ["project-discovery", "summarize", "final-report"] as const;
const INTERRUPTED_NODE = "summarize";

const TOPOLOGY = `version: 2
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
    depends_on:
      - __start__
    outputs:
      - path: discovery.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: summarize
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - project-discovery
    outputs:
      - path: summary.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: final-report
    kind: agentic
    prompt: review/final-report.md
    depends_on:
      - summarize
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: report.json
        contract: ultrafuzz/report@3
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
`;

// A public campaign needs no disclosure acknowledgement. CodexAgent routes to model:openai.
const PUBLIC_DATA_GOVERNANCE_POLICY = {
  schema_version: "ultrafuzz.data-governance-policy.v1",
  sensitivity: "public",
  source_destinations: ["model:openai"],
  artifact_destinations: [],
  destination_policies: [
    {
      destination: "model:openai",
      processor: "stub codex",
      region: "local",
      retention_policy: "test fixture",
      training_policy: "none",
      dpa_status: "not-required",
      minimization_policy: "synthetic fixture only",
      data_handling_basis: "public test fixture"
    }
  ],
  openrouter_model_allowlist: []
};

interface StubConfig {
  logPath: string;
  holdPath: string;
  holdNode: string;
}

interface AgentCall {
  node: string;
  pid: number;
  event: "started" | "held" | "completed";
}

/**
 * The fake `codex` binary. The engine spawns it exactly as it spawns Codex (`codex exec ... --json
 * -`, prompt on stdin). It writes every artifact the prompt's output contract names, renders the
 * final report with the `ultrafuzz report render` command the prompt gives, and prints the Codex
 * JSONL the engine parses. While `holdPath` exists, `holdNode` never finishes, so the test can kill
 * the controller in the middle of it. The function is serialized into the binary, so it may use
 * only globals.
 */
function stubCodex(config: StubConfig): void {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const { execFileSync } = process.getBuiltinModule("node:child_process");
  const args = process.argv.slice(2);
  const prompt = fs.readFileSync(0, "utf8");
  const node = (process.env.SMITHERS_NODE_ID ?? "").replace(/^node:/u, "");
  const log = (event: AgentCall["event"]): void =>
    fs.appendFileSync(config.logPath, `${JSON.stringify({ node, pid: process.pid, event })}\n`);
  log("started");
  if (node === config.holdNode && fs.existsSync(config.holdPath)) {
    log("held");
    setTimeout(() => process.exit(1), 10 * 60_000);
    return;
  }
  const outputs = new Map<string, string>();
  for (const [, file, contract] of prompt.matchAll(/^- Path: `([^`]+)`.*\n\s+Contract: `([^`]+)`/gmu)) {
    if (file === undefined || contract === undefined) continue;
    if (!["ultrafuzz/text@1", "ultrafuzz/report@3", "ultrafuzz/nonempty-markdown@1"].includes(contract)) {
      throw new Error(`stub codex cannot write ${contract}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    outputs.set(contract, file);
  }
  const text = outputs.get("ultrafuzz/text@1");
  if (text !== undefined) fs.writeFileSync(text, `stub output for ${node}\n`);
  const report = outputs.get("ultrafuzz/report@3");
  if (report !== undefined) {
    // Copy the host-injected authorities the prompt names, as the final-report prompt instructs.
    const authority = (suffix: string): Record<string, unknown> => {
      const file = [...prompt.matchAll(/workspace-relative file "([^"]+)"/gu)]
        .map((match) => match[1])
        .find((candidate) => candidate?.endsWith(suffix) === true);
      if (file === undefined) throw new Error(`stub codex found no ${suffix} authority in the prompt`);
      return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Record<string, unknown>;
    };
    const data = authority(".final-report-prompt.json");
    const document = {
      schema_version: "ultrafuzz.report.v3",
      run_metadata: { ...authority(".final-report-run-metadata.json"), agent_execution: data.agent_execution },
      issues: [],
      non_production_outcomes: [],
      property_provenance: [],
      property_implementation_coverage: data.property_implementation_coverage
    };
    fs.writeFileSync(report, `${JSON.stringify(document, null, 2)}\n`);
    const render = /^ultrafuzz report render (.+)$/mu.exec(prompt)?.[1];
    if (render === undefined) throw new Error("stub codex found no report render command in the prompt");
    const renderArgs = [...render.matchAll(/(--[a-z-]+) '([^']+)'/gu)].flatMap(([, flag, value]) => [
      flag ?? "",
      value ?? ""
    ]);
    // The renderer writes report.md; its stdout must not interleave with the JSONL below.
    execFileSync("ultrafuzz", ["report", "render", ...renderArgs], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const emit = (event: object): boolean => process.stdout.write(`${JSON.stringify(event)}\n`);
  emit({ type: "thread.started", thread_id: `stub-${node}` });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: `stub completed ${node}` } });
  const lastMessage = args.indexOf("--output-last-message");
  if (lastMessage >= 0) fs.writeFileSync(args[lastMessage + 1] ?? "", `stub completed ${node}`);
  emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } });
  log("completed");
}

interface Campaign {
  root: string;
  project: string;
  runId: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  holdPath: string;
}

interface HealthValue {
  status: string;
  verdict: string;
  ended: boolean;
  progress: { finished: number; in_progress: number; pending: number; failed: number; skipped: number; total: number };
  model_mix: Array<{ attempts: number }>;
  report: { status: string; completion: string; verification: string };
}

interface StatsValue {
  status: string;
  nodes: Array<{
    node_id: string;
    status: string;
    attempt_count: number | null;
    executed_attempt_count: number | null;
  }>;
  totals: { node_count: number; status_counts: Record<string, number>; attempts_complete: boolean };
}

interface WorkflowEvent {
  sequence: number;
  category: string;
  node_id: string | null;
}

function prepareCampaign(): Campaign {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-e2e-"));
  const project = path.join(root, "target");
  const bin = path.join(root, "bin");
  const codexHome = path.join(root, "codex-home");
  const tmp = path.join(root, "tmp");
  for (const directory of [project, bin, codexHome, tmp]) fs.mkdirSync(directory, { mode: 0o700 });
  const campaign: Campaign = {
    root,
    project,
    runId: `e2e-${process.pid}-${Date.now().toString(36)}`,
    logPath: path.join(root, "agent-calls.jsonl"),
    holdPath: path.join(root, `hold-${INTERRUPTED_NODE}`),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== "NODE_TEST_CONTEXT" && !/^(?:ULTRAFUZZ|SMITHERS|CODEX|OPENAI)_/u.test(name)
        )
      ),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      // Subscription auth reads auth.json here, so the engine's agent preflight stays offline.
      CODEX_HOME: codexHome,
      // Keeps the operator controller that each engine command installs inside the fixture root.
      TMPDIR: tmp,
      ULTRAFUZZ_DATA_GOVERNANCE_POLICY: JSON.stringify(PUBLIC_DATA_GOVERNANCE_POLICY),
      ULTRAFUZZ_PRICING_CATALOG_URL: "off"
    }
  };
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "stub" } })}\n`
  );
  const stubConfig: StubConfig = { logPath: campaign.logPath, holdPath: campaign.holdPath, holdNode: INTERRUPTED_NODE };
  const stub = `#!/usr/bin/env node\n(${String(stubCodex)})(${JSON.stringify(stubConfig)});\n`;
  fs.writeFileSync(path.join(bin, "codex"), stub, { mode: 0o755 });
  fs.writeFileSync(path.join(project, "README.md"), "# Target\n");
  for (const args of [
    ["init", "-q"],
    ["add", "README.md"],
    ["commit", "-q", "-m", "fixture"]
  ]) {
    execFileSync("git", ["-c", "user.name=Ultrafuzz", "-c", "user.email=e2e@ultrafuzz.invalid", ...args], {
      cwd: project,
      stdio: "ignore"
    });
  }
  return campaign;
}

async function ultrafuzz<T>(campaign: Campaign, args: string[], timeoutMs = 5 * MINUTE): Promise<T> {
  const command = `ultrafuzz ${args.join(" ")}`;
  const { error, stdout, stderr } = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
    (resolve) => {
      execFile(
        process.execPath,
        [CLI_ENTRYPOINT, ...args, "--project", campaign.project, "--json"],
        { cwd: campaign.project, env: campaign.env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 << 20 },
        // A failed envelope exits non-zero; the envelope itself is the evidence.
        (failure, out, err) => resolve({ error: failure, stdout: out, stderr: err })
      );
    }
  );
  let envelope: { ok: boolean; data: unknown; diagnostics: unknown[] };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch {
    assert.fail(`${command} printed no JSON envelope (${error?.message ?? "exit 0"})\nstderr: ${stderr}`);
  }
  assert.equal(envelope.ok, true, `${command}: ${JSON.stringify(envelope.diagnostics)}`);
  return envelope.data as T;
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs / MINUTE} minutes waiting for ${label}`);
    await delay(1_000);
  }
}

function agentCalls(campaign: Campaign): AgentCall[] {
  if (!fs.existsSync(campaign.logPath)) return [];
  // The last element is empty or a line the stub is still appending.
  const lines = fs.readFileSync(campaign.logPath, "utf8").split("\n").slice(0, -1);
  return lines.map((line) => JSON.parse(line) as AgentCall);
}

/** Linux PIDs whose command line mentions `needle`. */
function processesMentioning(needle: string): number[] {
  return fs.readdirSync("/proc").flatMap((entry) => {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) return [];
    try {
      return fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(needle) ? [Number(entry)] : [];
    } catch {
      return [];
    }
  });
}

function signal(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

function removeTree(root: string): void {
  // Sealed execution snapshots are read-only directories; a leaked fixture must not fail the test.
  const restore = (directory: string): void => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) restore(path.join(directory, entry.name));
    }
  };
  try {
    restore(root);
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/** A task the engine finished must not start again: resume reuses it. */
function assertNoFinishedTaskRestarted(events: WorkflowEvent[]): void {
  const finished = new Set<string>();
  for (const event of events) {
    if (event.node_id === null) continue;
    if (event.category === "NodeStarted") {
      assert.equal(finished.has(event.node_id), false, `${event.node_id} started again at event ${event.sequence}`);
    }
    if (event.category === "NodeFinished") finished.add(event.node_id);
  }
  assert.ok(finished.size > 0, "the workflow event stream has no finished tasks");
}

/** Launches the campaign and SIGKILLs its detached controller while `INTERRUPTED_NODE` runs. */
async function interruptMidRun(campaign: Campaign, mark: (phase: string) => void): Promise<void> {
  await ultrafuzz(campaign, ["init"], 2 * MINUTE);
  const configPath = path.join(campaign.project, "ultrafuzz.toml");
  const generated = fs.readFileSync(configPath, "utf8");
  // init configures Codex API-key auth, whose preflight calls api.openai.com.
  const config = generated.replace(
    /^\[agents\.CodexAgent\]\n(?:[^[\n].*\n)*/mu,
    '[agents.CodexAgent]\nauth = "subscription"\n'
  );
  assert.notEqual(config, generated, "init no longer writes an [agents.CodexAgent] table");
  fs.writeFileSync(configPath, config);
  fs.writeFileSync(path.join(campaign.project, ".ultrafuzz", "topology.yml"), TOPOLOGY);
  fs.writeFileSync(campaign.holdPath, "");

  const launched = await ultrafuzz<{ status: string; workflow_ids: string[] }>(
    campaign,
    ["run", "--run-id", campaign.runId],
    20 * MINUTE
  );
  mark("run submitted");
  assert.equal(launched.status, "running");
  const [workflowRunId] = launched.workflow_ids;
  assert.ok(workflowRunId !== undefined, "run did not report its workflow run ID");

  const held = await waitFor(`${INTERRUPTED_NODE} to start`, 15 * MINUTE, () => {
    const call = agentCalls(campaign).find((entry) => entry.node === INTERRUPTED_NODE && entry.event === "held");
    if (call === undefined && processesMentioning(workflowRunId).length === 0) {
      assert.fail(`the workflow stopped before ${INTERRUPTED_NODE} started`);
    }
    return call;
  });
  // A host crash takes down the detached engine and the supervisor that would otherwise restart it.
  const controller = processesMentioning(workflowRunId);
  assert.ok(controller.length > 0, "no detached controller process is running the workflow");
  for (const pid of controller) signal(pid, "SIGKILL");
  await waitFor("the controller and its agent to exit", MINUTE, () =>
    processesMentioning(workflowRunId).length === 0 && !signal(held.pid, 0) ? true : undefined
  );
  mark("controller killed");
}

test(
  "a campaign whose controller is SIGKILLed mid-node resumes on the pinned engine without re-running finished nodes",
  { timeout: 45 * MINUTE, skip: process.platform === "linux" ? false : "finds the detached controller through /proc" },
  async (t) => {
    const campaign = prepareCampaign();
    const { runId } = campaign;
    // The supervisor's command line names only the run ID; everything else names the fixture root.
    const killLeftovers = (): void => {
      for (const pid of [...processesMentioning(campaign.root), ...processesMentioning(runId)]) signal(pid, "SIGKILL");
    };
    process.once("exit", killLeftovers);
    // Phase timings in the test output show where CI time goes.
    const started = Date.now();
    const mark = (phase: string): void => t.diagnostic(`${phase} after ${Math.round((Date.now() - started) / 1000)} s`);
    try {
      await interruptMidRun(campaign, mark);

      // Until the dead engine's heartbeat lease lapses, the engine still reports the run as
      // running, and resume leaves a running run alone (`submitted: false`).
      await waitFor("status to report the run orphaned", 5 * MINUTE, async () => {
        const health = await ultrafuzz<HealthValue>(campaign, ["status", runId]);
        assert.equal(health.ended, false);
        return health.verdict === "orphaned" ? health : undefined;
      });
      fs.rmSync(campaign.holdPath);
      const resumed = await ultrafuzz<{ submitted: boolean }>(campaign, ["resume", runId], 15 * MINUTE);
      mark("resume submitted");
      assert.equal(resumed.submitted, true);

      // `events` reads the engine's event log without synchronizing the run, so it is the cheaper poll.
      const events = await waitFor("the resumed workflow to finish", 15 * MINUTE, async () => {
        const current = await ultrafuzz<{ events: WorkflowEvent[]; truncated: boolean }>(campaign, ["events", runId]);
        const ended = ["RunFinished", "RunFailed", "RunCancelled"];
        return current.events.some((event) => ended.includes(event.category)) ? current : undefined;
      });
      const health = await ultrafuzz<HealthValue>(campaign, ["status", runId]);
      mark("run ended");
      assert.equal(health.ended, true);
      assert.equal(health.status, "succeeded");
      assert.deepEqual(
        {
          status: health.report.status,
          completion: health.report.completion,
          verification: health.report.verification
        },
        { status: "available", completion: "complete", verification: "verified" }
      );

      const report = await ultrafuzz<{ source: string; json_path: string; markdown_path: string }>(campaign, [
        "report",
        runId
      ]);
      assert.equal(report.source, "verified-runtime-report");
      const reportJson = JSON.parse(fs.readFileSync(report.json_path, "utf8")) as { run_metadata: { run_id: string } };
      assert.equal(reportJson.run_metadata.run_id, runId);
      assert.match(fs.readFileSync(report.markdown_path, "utf8"), /\S/u);

      // Every agent ran once, except the node the kill interrupted, which ran again after resume.
      const starts = agentCalls(campaign).filter((call) => call.event === "started");
      assert.deepEqual(
        AGENT_NODES.map((node) => [node, starts.filter((call) => call.node === node).length]),
        AGENT_NODES.map((node) => [node, node === INTERRUPTED_NODE ? 2 : 1])
      );
      assert.equal(events.truncated, false);
      assert.equal(events.events.filter((event) => event.category === "RunStarted").length, 2);
      assertNoFinishedTaskRestarted(events.events);

      // `status` counts engine tasks and `stats` counts topology nodes; both must describe the same
      // complete run.
      const { finished, in_progress, pending, failed, skipped } = health.progress;
      assert.deepEqual(
        { finished, in_progress, pending, failed, skipped },
        { finished: health.progress.total, in_progress: 0, pending: 0, failed: 0, skipped: 0 }
      );
      const stats = await ultrafuzz<StatsValue>(campaign, ["stats", runId]);
      assert.equal(stats.status, "succeeded");
      assert.equal(stats.totals.attempts_complete, true);
      assert.deepEqual(
        stats.nodes.map((node) => [node.node_id, node.status]),
        AGENT_NODES.map((node) => [node, "succeeded"])
      );
      assert.equal(stats.totals.node_count, AGENT_NODES.length);
      assert.equal(stats.totals.status_counts.succeeded, AGENT_NODES.length);
      assert.equal(stats.nodes.find((node) => node.node_id === "project-discovery")?.executed_attempt_count, 1);
      // status counts every agent invocation, including the one the kill interrupted.
      const statusAttempts = health.model_mix.reduce((total, entry) => total + entry.attempts, 0);
      assert.equal(statusAttempts, starts.length);
      mark("checks done");

      await t.test(
        "stats counts the agent attempt the controller crash interrupted",
        {
          todo: "attempts.jsonl is built from NodeFinished/NodeFailed events, and resume cancels this attempt without one"
        },
        () => {
          const statsAttempts = stats.nodes.reduce((total, node) => total + (node.attempt_count ?? 0), 0);
          assert.equal(statsAttempts, statusAttempts);
        }
      );
    } finally {
      killLeftovers();
      process.removeListener("exit", killLeftovers);
      removeTree(campaign.root);
    }
  }
);
