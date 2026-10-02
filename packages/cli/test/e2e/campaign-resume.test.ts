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
// on the pinned Smithers engine under Bun: `run` installs it from npm into the run's execution
// snapshot, and `resume` runs the copy pnpm patched into Ultrafuzz's own install. Only the model is
// fake: a stub `codex` executable on PATH. Other runtime and CLI tests drive a fake `smithers` shell
// script, or run the engine on hand-written workflows.

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
const MINUTE = 60_000;
const AGENT_NODES = ["project-discovery", "summarize", "final-report"] as const;
const INTERRUPTED_NODE = "summarize";
// Appended before resume to the project prompt the interrupted node and a finished node were both
// rendered from, as an operator's edit; the stub records whether each call's prompt carries it.
const PROMPT_EDIT_MARKER = "Operator note added before resume: keep the summary to one line.";

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

interface StubConfig {
  logPath: string;
  holdPath: string;
  holdNode: string;
  promptMarker: string;
}

interface AgentCall {
  node: string;
  pid: number;
  event: "started" | "held" | "completed" | "failed";
  error?: string;
  /** Whether the prompt the engine delivered carries `PROMPT_EDIT_MARKER`. */
  edited?: boolean;
}

/**
 * The fake `codex` binary. The engine spawns it exactly as it spawns Codex (`codex exec ... --json
 * -`, prompt on stdin). It writes the `text@1` and `report@3` outputs that the prompt's output
 * contract names, renders the final report's markdown with the `ultrafuzz report render` command
 * the prompt gives, and prints the Codex JSONL the engine parses. While `holdPath` exists, it holds
 * `holdNode` open for up to 10 minutes, so the test can kill the controller in the middle of it. It
 * fails, and logs why, when the prompt no longer has the shape it parses. The function is
 * serialized into the binary, so it may use only globals.
 */
function stubCodex(config: StubConfig): void {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const { execFileSync } = process.getBuiltinModule("node:child_process");
  const args = process.argv.slice(2);
  const prompt = fs.readFileSync(0, "utf8");
  const node = (process.env.SMITHERS_NODE_ID ?? "").replace(/^node:/u, "");
  const edited = prompt.includes(config.promptMarker);
  const log = (event: AgentCall["event"], error?: string): void =>
    fs.appendFileSync(config.logPath, `${JSON.stringify({ node, pid: process.pid, event, error, edited })}\n`);
  log("started");
  if (node === config.holdNode && fs.existsSync(config.holdPath)) {
    log("held");
    setTimeout(() => process.exit(1), 10 * 60_000);
    return;
  }
  try {
    const outputs = new Map<string, string>();
    for (const [, file, contract] of prompt.matchAll(/^- Path: `([^`]+)`.*\n\s+Contract: `([^`]+)`/gmu)) {
      if (file === undefined || contract === undefined) continue;
      if (!["ultrafuzz/text@1", "ultrafuzz/report@3", "ultrafuzz/nonempty-markdown@1"].includes(contract)) {
        throw new Error(`stub codex cannot write ${contract}`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      outputs.set(contract, file);
    }
    if (outputs.size === 0) throw new Error("stub codex found no output contract in the prompt");
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
      // Every argument must be a `--flag 'value'` pair, so none is silently dropped.
      if (render === undefined || !/^(?:--[a-z-]+ '[^']+' ?)+$/u.test(render)) {
        throw new Error(`stub codex cannot parse the report render command: ${render}`);
      }
      const renderArgs = [...render.matchAll(/(--[a-z-]+) '([^']+)'/gu)].flatMap(([, flag, value]) => [
        flag ?? "",
        value ?? ""
      ]);
      // The renderer writes report.md; its stdout must not interleave with the JSONL below.
      execFileSync("ultrafuzz", ["report", "render", ...renderArgs], { stdio: ["ignore", "ignore", "inherit"] });
    }
  } catch (error) {
    log("failed", String(error));
    throw error;
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
    failure_categories: string[] | null;
  }>;
  totals: { node_count: number; status_counts: Record<string, number> };
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
      ULTRAFUZZ_PRICING_CATALOG_URL: "off"
    }
  };
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "stub" } })}\n`
  );
  const stubConfig: StubConfig = {
    logPath: campaign.logPath,
    holdPath: campaign.holdPath,
    holdNode: INTERRUPTED_NODE,
    promptMarker: PROMPT_EDIT_MARKER
  };
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

/** A Linux process's command line; empty for a zombie, and undefined once it has been reaped. */
function commandLine(pid: number | string): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
}

/** Linux PIDs whose command line mentions `needle`. */
function processesMentioning(needle: string): number[] {
  return fs.readdirSync("/proc").flatMap((entry) => {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) return [];
    return commandLine(entry)?.includes(needle) === true ? [Number(entry)] : [];
  });
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
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

/** Waits for the stub to hold `INTERRUPTED_NODE` in a process other than the `earlier` ones. */
async function heldCall(campaign: Campaign, workflowRunId: string, label: string, earlier: number[] = []) {
  return waitFor(label, 15 * MINUTE, () => {
    const calls = agentCalls(campaign);
    const call = calls.find(
      (entry) => entry.node === INTERRUPTED_NODE && entry.event === "held" && !earlier.includes(entry.pid)
    );
    if (call === undefined && processesMentioning(workflowRunId).length === 0) {
      assert.fail(`the workflow stopped while waiting for ${label}; agent calls: ${JSON.stringify(calls)}`);
    }
    return call;
  });
}

/**
 * Launches the campaign and SIGKILLs its detached engine while `INTERRUPTED_NODE` runs. Once the
 * supervisor has relaunched the engine and the node runs again, SIGKILLs the whole controller.
 */
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

  const first = await heldCall(campaign, workflowRunId, `${INTERRUPTED_NODE} to start`);
  // An engine killed on its own, as by the OOM killer, leaves its supervisor running. The supervisor
  // relaunches it from the run's sealed execution snapshot with no `ultrafuzz` command.
  const engines = processesMentioning(workflowRunId).filter((pid) => {
    const argv = commandLine(pid) ?? "";
    return argv.includes("\0up\0") && !argv.includes("\0supervise\0");
  });
  assert.ok(engines.length > 0, "no detached engine process is running the workflow");
  for (const pid of engines) kill(pid);
  const held = await heldCall(campaign, workflowRunId, `the relaunched engine to rerun ${INTERRUPTED_NODE}`, [
    first.pid
  ]);
  mark("engine relaunched");
  // A host crash takes down the detached engine and the supervisor that would otherwise restart it.
  const controller = processesMentioning(workflowRunId);
  assert.ok(controller.length > 0, "no detached controller process is running the workflow");
  for (const pid of controller) kill(pid);
  // The held agent is reparented once the engine dies; a zombie counts as exited.
  await waitFor("the controller and its agent to exit", MINUTE, () =>
    processesMentioning(workflowRunId).length === 0 && (commandLine(held.pid) ?? "") === "" ? true : undefined
  );
  mark("controller killed");
}

test(
  "a campaign whose engine and then whole controller are SIGKILLed mid-node resumes on the pinned engine without re-running finished nodes",
  { timeout: 45 * MINUTE, skip: process.platform === "linux" ? false : "finds the detached controller through /proc" },
  async (t) => {
    const campaign = prepareCampaign();
    const { runId } = campaign;
    const cleanUp = (): void => {
      // The supervisor's command line names only the run ID; everything else names the fixture root.
      for (const pid of [...processesMentioning(campaign.root), ...processesMentioning(runId)]) kill(pid);
      removeTree(campaign.root);
    };
    // The campaign runs detached, so an interrupted test must stop it before dying of the signal.
    const interrupted = (name: NodeJS.Signals): void => {
      cleanUp();
      process.kill(process.pid, name);
    };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    process.once("exit", cleanUp);
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
      // Every engine reads the attempt's own prompt file, and the attempt reset keeps it, so the file
      // survives two engines that ran the node. The operator then edits the project prompt that
      // project-discovery, which finished, and the interrupted node were both rendered from.
      const runRoot = path.join(campaign.project, ".ultrafuzz", "runs", runId);
      const promptFile = (node: string): string => path.join(runRoot, "artifacts", node, "prompt.rendered.md");
      assert.equal(
        fs.existsSync(promptFile(INTERRUPTED_NODE)),
        true,
        `${promptFile(INTERRUPTED_NODE)} did not survive the interrupted attempts`
      );
      const finishedPrompt = fs.readFileSync(promptFile("project-discovery"), "utf8");
      fs.appendFileSync(
        path.join(campaign.project, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
        `\n${PROMPT_EDIT_MARKER}\n`
      );
      const resumed = await ultrafuzz<{ submitted: boolean }>(campaign, ["resume", runId], 15 * MINUTE);
      mark("resume submitted");
      assert.equal(resumed.submitted, true);
      // Resume applied the edit to the unfinished node only; the finished node's file stays the record
      // of the prompt it ran with, and prompt-history/ keeps the file the refresh replaced.
      assert.ok(fs.readFileSync(promptFile(INTERRUPTED_NODE), "utf8").includes(PROMPT_EDIT_MARKER));
      assert.equal(fs.readFileSync(promptFile("project-discovery"), "utf8"), finishedPrompt);
      const [entry, ...others] = fs.readdirSync(path.join(runRoot, "prompt-history"));
      assert.ok(entry !== undefined && others.length === 0);
      const refresh = JSON.parse(
        fs.readFileSync(path.join(runRoot, "prompt-history", entry, "refresh.json"), "utf8")
      ) as { files: Array<{ attempt_id?: string }> };
      assert.deepEqual(
        refresh.files.map((file) => file.attempt_id),
        [INTERRUPTED_NODE]
      );

      // `events` reads the engine's event log without synchronizing the run, so it is the cheaper poll.
      const ended = ["RunFinished", "RunFailed", "RunCancelled"];
      const events = await waitFor("the resumed workflow to end", 15 * MINUTE, async () => {
        const current = await ultrafuzz<{ events: WorkflowEvent[]; truncated: boolean }>(campaign, ["events", runId]);
        return current.events.some((event) => ended.includes(event.category)) ? current : undefined;
      });
      mark("run ended");
      const calls = agentCalls(campaign);
      assert.equal(
        events.events.find((event) => ended.includes(event.category))?.category,
        "RunFinished",
        `agent calls: ${JSON.stringify(calls)}`
      );
      // Every agent ran once, except the node the kills interrupted, which ran again in the relaunched
      // engine and after resume.
      const starts = calls.filter((call) => call.event === "started");
      assert.deepEqual(
        AGENT_NODES.map((node) => [node, starts.filter((call) => call.node === node).length]),
        AGENT_NODES.map((node) => [node, node === INTERRUPTED_NODE ? 3 : 1])
      );
      // Only the resumed attempt of the interrupted node started after the edit, and it ran with it.
      const resumedAttempt = starts.map((call) => call.node).lastIndexOf(INTERRUPTED_NODE);
      assert.deepEqual(
        starts.map((call) => [call.node, call.edited]),
        starts.map((call, index) => [call.node, index === resumedAttempt])
      );
      assert.equal(events.truncated, false);
      assert.equal(events.events.filter((event) => event.category === "RunStarted").length, 3);
      assert.ok(
        events.events.some((event) => event.category === "RunAutoResumed"),
        "no supervisor relaunch event"
      );
      assertNoFinishedTaskRestarted(events.events);

      const health = await ultrafuzz<HealthValue>(campaign, ["status", runId]);
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

      // `status` counts engine tasks and `stats` counts topology nodes; both must describe the same
      // complete run.
      const { finished, in_progress, pending, failed, skipped } = health.progress;
      assert.deepEqual(
        { finished, in_progress, pending, failed, skipped },
        { finished: health.progress.total, in_progress: 0, pending: 0, failed: 0, skipped: 0 }
      );
      const stats = await ultrafuzz<StatsValue>(campaign, ["stats", runId]);
      assert.equal(stats.status, "succeeded");
      assert.deepEqual(
        stats.nodes.map((node) => [node.node_id, node.status]),
        AGENT_NODES.map((node) => [node, "succeeded"])
      );
      assert.equal(stats.totals.node_count, AGENT_NODES.length);
      assert.equal(stats.totals.status_counts.succeeded, AGENT_NODES.length);
      assert.equal(stats.nodes.find((node) => node.node_id === "project-discovery")?.executed_attempt_count, 1);
      // status and stats count every agent invocation, including the one the kill interrupted, which
      // stats records as canceled.
      const statusAttempts = health.model_mix.reduce((total, entry) => total + entry.attempts, 0);
      assert.equal(statusAttempts, starts.length);
      assert.equal(
        stats.nodes.reduce((total, node) => total + (node.attempt_count ?? 0), 0),
        statusAttempts
      );
      assert.deepEqual(stats.nodes.find((node) => node.node_id === INTERRUPTED_NODE)?.failure_categories, ["canceled"]);
      mark("checks done");
    } finally {
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      process.removeListener("exit", cleanUp);
      cleanUp();
    }
  }
);
