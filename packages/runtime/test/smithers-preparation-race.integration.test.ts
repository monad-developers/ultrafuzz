import assert from "node:assert/strict";
import { writeLocalResolvedConfig } from "./local-resolved-config.js";
import { temporaryRoot } from "./temporary-root.js";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const PARALLEL_LANES = 6;

// #672: concurrently dispatched `prepare:*` worktree tasks failed nondeterministically with a
// Bun-erased `TypeError: undefined is not an object (evaluating 'get')`, and every failure was
// terminal because the preparation Task compiled with retries={0}. These tests drive a real
// `smithers up` (the same Bun-run engine binary production uses) to pin the two engine-level
// facts the fix relies on: simultaneous worktree preparations all succeed, and a preparation
// retry budget of one is honored inside <Worktree> so a single transient hit is absorbed.
test("simultaneously dispatched worktree preparations all succeed under a real Smithers run", async () => {
  const root = temporaryRoot("ultrafuzz-smithers-prep-race-");
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "preparation-race.tsx");
  const evidenceRoot = path.join(root, ".ultrafuzz", "preparation-race");
  const runId = `preparation-race-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(evidenceRoot, { recursive: true });
    initFixtureRepository(root);

    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(workflowPath, parallelPreparationWorkflowSource({ root, evidenceRoot }), "utf8");

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SMITHERS_KEEP_WORKTREES: "", SMITHERS_POST_FAILURE: "0" }
      }
    );

    await waitForSuccessfulCompletion(root, runId, 120_000);

    for (let lane = 0; lane < PARALLEL_LANES; lane += 1) {
      const evidencePath = path.join(evidenceRoot, `lane-${lane}.json`);
      assert.ok(fs.existsSync(evidencePath), `lane ${lane} never finished its preparation`);
      const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as { lane: number; head: string };
      assert.equal(evidence.lane, lane);
      assert.match(evidence.head, /^[0-9a-f]{40}$/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree preparation that fails once is retried and the node succeeds", async () => {
  const root = temporaryRoot("ultrafuzz-smithers-prep-retry-");
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "preparation-retry.tsx");
  const evidenceRoot = path.join(root, ".ultrafuzz", "preparation-retry");
  const attemptsPath = path.join(evidenceRoot, "attempts.log");
  const runId = `preparation-retry-${process.pid}-${Date.now()}`;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(evidenceRoot, { recursive: true });
    initFixtureRepository(root);

    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(workflowPath, retriedPreparationWorkflowSource({ root, attemptsPath }), "utf8");

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SMITHERS_KEEP_WORKTREES: "", SMITHERS_POST_FAILURE: "0" }
      }
    );

    // With retries={0} this run ends `failed` on the sentinel throw and the wait rejects; the
    // retry budget the #672 fix compiles into preparation Tasks is what lets it finish.
    await waitForSuccessfulCompletion(root, runId, 60_000);

    const attempts = fs
      .readFileSync(attemptsPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    assert.deepEqual(attempts, ["attempt", "attempt"], "the preparation body must run exactly twice");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native continuation keeps a finished producer and runs only a newly rendered downstream task", async () => {
  const root = temporaryRoot("ultrafuzz-smithers-continuation-");
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "native-continuation.tsx");
  const runId = `native-continuation-${process.pid}-${Date.now()}`;
  const runRoot = path.join(root, ".ultrafuzz", "runs", runId);
  const executionLog = path.join(root, "execution.log");
  const producerArtifact = path.join(runRoot, "artifacts", "producer", "generated-test-manifest.json");
  const downstreamArtifact = path.join(root, "downstream.json");
  const historicalWorkflowEvidence = path.join(runRoot, "smithers", "workflow.tsx");
  const historicalProducerBytes = Buffer.from(
    `${JSON.stringify({ run_id: "historical-embedded-run-id", value: "original" })}\n`,
    "utf8"
  );
  let registry: net.Server | undefined;

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.mkdirSync(path.join(runRoot, "smithers"), { recursive: true });
    fs.mkdirSync(path.dirname(producerArtifact), { recursive: true });
    initFixtureRepository(root);
    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    const historicalWorkflowSource = nativeContinuationWorkflowSource({
      executionLog,
      producerArtifact,
      downstreamArtifact,
      withDownstream: false
    });
    fs.writeFileSync(workflowPath, historicalWorkflowSource, "utf8");
    fs.writeFileSync(historicalWorkflowEvidence, historicalWorkflowSource, "utf8");

    execFileSync(
      smithersBinary(),
      ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, SMITHERS_POST_FAILURE: "0" } }
    );
    await waitForSuccessfulCompletion(root, runId, 60_000);
    assert.deepEqual(fs.readFileSync(producerArtifact), historicalProducerBytes);
    assert.deepEqual(fs.readFileSync(executionLog, "utf8").trim().split("\n"), ["producer"]);
    const historicalSmithersOutput = smithersNodeOutput(root, runId, "producer");
    const historicalProducerAttempt = smithersNodeAttempt(root, runId, "producer");
    // Production launches from the immutable execution snapshot and never
    // install controller packages into the target. Keep the symlink only for
    // this fixture's direct initial `smithers up`; native continuation must
    // resolve them from Ultrafuzz's own installed runner instead (#973).
    fs.unlinkSync(path.join(root, ".smithers", "node_modules"));

    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      `${JSON.stringify({
        run_id: runId,
        workflow_ids: [runId],
        workflow: { run_id: runId, path: path.relative(root, workflowPath).split(path.sep).join("/") }
      })}\n`,
      "utf8"
    );
    writeLocalResolvedConfig(runRoot);
    fs.writeFileSync(
      workflowPath,
      nativeContinuationWorkflowSource({ executionLog, producerArtifact, downstreamArtifact, withDownstream: true }),
      "utf8"
    );

    const runtimeModule = pathToFileURL(path.join(runtimePackageRoot(), "dist", "start-run.js")).href;
    // Resume must neither reach a package registry nor leave a controller
    // install behind in TMPDIR. Every proxy and the registry point at a local
    // listener that counts each connection and drops it.
    const resumeTmpdir = temporaryRoot("ultrafuzz-resume-tmpdir-");
    let registryConnections = 0;
    const listener = net.createServer((socket) => {
      registryConnections += 1;
      socket.destroy();
    });
    registry = listener;
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const registryUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    const offline = Object.fromEntries(
      ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "npm_config_registry"].map((name) => [
        name,
        registryUrl
      ])
    );
    const resumed = JSON.parse(
      (
        await promisify(execFile)(
          "node",
          [
            "--input-type=module",
            "--eval",
            `import { resumeRun } from ${JSON.stringify(runtimeModule)};
const result = await resumeRun({
  projectRoot: ${JSON.stringify(root)},
  runId: ${JSON.stringify(runId)},
  env: { PATH: process.env.PATH, SMITHERS_POST_FAILURE: "0" }
});
process.stdout.write(JSON.stringify(result));`
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              ...offline,
              NO_PROXY: "",
              no_proxy: "",
              TMPDIR: resumeTmpdir,
              SMITHERS_POST_FAILURE: "0"
            }
          }
        )
      ).stdout
    ) as {
      ok: boolean;
      diagnostics?: unknown;
      value?: { run_id?: string; workflow_run_id?: string };
    };

    assert.equal(registryConnections, 0, "resume reached the package registry");
    assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
    assert.equal(resumed.value?.run_id, runId);
    assert.equal(resumed.value?.workflow_run_id, runId);
    try {
      await waitForFile(downstreamArtifact, 15_000);
    } catch (error) {
      const inspected = execFileSync(smithersBinary(), ["inspect", runId, "--format", "json", "--full-output"], {
        cwd: root,
        encoding: "utf8"
      });
      const logsRoot = path.join(runRoot, "smithers", "logs");
      const logs = fs.existsSync(logsRoot)
        ? fs
            .readdirSync(logsRoot)
            .map((name) => `${name}:\n${fs.readFileSync(path.join(logsRoot, name), "utf8")}`)
            .join("\n")
        : "no logs";
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${inspected}\n${logs}`, {
        cause: error
      });
    }
    await waitForSuccessfulCompletion(root, runId, 60_000);
    assert.deepEqual(fs.readFileSync(producerArtifact), historicalProducerBytes);
    assert.deepEqual(smithersNodeOutput(root, runId, "producer"), historicalSmithersOutput);
    assert.equal(smithersNodeAttempt(root, runId, "producer"), historicalProducerAttempt);
    assert.equal(historicalProducerAttempt, 1);
    assert.deepEqual(fs.readFileSync(executionLog, "utf8").trim().split("\n"), ["producer", "downstream"]);
    assert.equal(fs.readFileSync(historicalWorkflowEvidence, "utf8"), historicalWorkflowSource);
    const downstream = JSON.parse(fs.readFileSync(downstreamArtifact, "utf8")) as {
      producer_run_id: string;
      controller_node_path: string;
    };
    assert.equal(downstream.producer_run_id, "historical-embedded-run-id");
    assert.equal(downstream.controller_node_path, path.dirname(smithersPackageRoot));
    assert.deepEqual(fs.readdirSync(resumeTmpdir), []);
    assert.equal(registryConnections, 0, "the resumed run reached the package registry");
  } finally {
    registry?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// #1153 asked Ultrafuzz for its own controller-generation fence around pause
// and continuation handoff. The pinned engine already provides the guarantee:
// a graceful pause lets in-flight tasks finish instead of aborting them, a
// second controller is refused while the owner is alive (`--force` does not
// take ownership), and a resume after the park runs only the remaining work.
// Pin those facts so an engine bump that regresses them fails here.
test("graceful pause drains in-flight tasks and refuses a second controller until the run parks", async () => {
  const root = temporaryRoot("ultrafuzz-smithers-pause-handoff-");
  const workflowDir = path.join(root, ".smithers", "workflows");
  const workflowPath = path.join(workflowDir, "pause-handoff.tsx");
  const traceLog = path.join(root, "trace.log");
  const releasePath = path.join(root, "release-in-flight");
  const runId = `pause-handoff-${process.pid}-${Date.now()}`;
  const runner = (args: string[]) =>
    spawnSync(smithersBinary(), args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SMITHERS_POST_FAILURE: "0" }
    });
  const trace = (): string[] =>
    fs.existsSync(traceLog) ? fs.readFileSync(traceLog, "utf8").trim().split("\n").filter(Boolean) : [];
  const pidOf = (lines: readonly string[], event: string) =>
    lines.find((line) => line.endsWith(` ${event}`))?.split(" ")[0];

  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    initFixtureRepository(root);
    const smithersPackageRoot = fs.realpathSync(path.join(runtimePackageRoot(), "node_modules", "smthrs"));
    fs.symlinkSync(path.dirname(smithersPackageRoot), path.join(root, ".smithers", "node_modules"), "dir");
    fs.writeFileSync(workflowPath, pauseHandoffWorkflowSource({ traceLog, releasePath }), "utf8");

    const launched = runner([
      "up",
      workflowPath,
      "--detach",
      "--run-id",
      runId,
      "--root",
      root,
      "--input",
      "{}",
      "--format",
      "json"
    ]);
    assert.equal(launched.status, 0, launched.stderr);
    await waitUntil(() => trace().filter((line) => line.endsWith(" start")).length === 2, 60_000, "a and b start");

    const pause = runner(["pause", runId, "--format", "json"]);
    assert.match(pause.stdout, /"pause-requested"/u, pause.stderr);
    // Both in-flight tasks are held open, so the owner is still draining: a
    // replacement controller and a node reset are refused despite `--force`.
    for (const takeover of [
      ["up", workflowPath, "--resume", runId, "--run-id", runId, "--force", "--detach", "--format", "json"],
      ["timetravel", workflowPath, "--run-id", runId, "--node-id", "a", "--no-vcs", "--force", "--format", "json"]
    ]) {
      const refused = runner(takeover);
      assert.notEqual(refused.status, 0, takeover.join(" "));
      assert.match(refused.stdout + refused.stderr, /RUN_OWNER_ALIVE/u, takeover.join(" "));
    }
    // The draining run still reports an active state, so `ultrafuzz resume`
    // only attaches to it instead of starting a controller.
    const draining = JSON.parse(runner(["inspect", runId, "--format", "json", "--full-output"]).stdout) as {
      data?: { runState?: { state?: string } };
    };
    assert.equal(draining.data?.runState?.state, "running");
    assert.equal(trace().length, 2, "no task ended or started while the pause drained");

    fs.writeFileSync(releasePath, "", "utf8");
    await waitForStatus(root, runId, "paused", 60_000);
    const parked = trace();
    const ownerPid = pidOf(parked, "a start");
    assert.equal(pidOf(parked, "a end"), ownerPid, "the draining owner finished a");
    assert.equal(pidOf(parked, "b end"), ownerPid, "the draining owner finished b");
    assert.equal(pidOf(parked, "c start"), undefined, "the pause stopped new scheduling");

    const resumed = runner(["up", workflowPath, "--resume", runId, "--run-id", runId, "--detach", "--format", "json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    await waitForSuccessfulCompletion(root, runId, 60_000);
    const finished = trace();
    for (const event of ["a start", "b start", "c start"]) {
      const runs = finished.filter((line) => line.endsWith(` ${event}`)).length;
      assert.equal(runs, 1, `${event} ran ${runs} times: ${JSON.stringify(finished)}`);
    }
    assert.notEqual(pidOf(finished, "c start"), ownerPid, "only the replacement controller ran c");
  } finally {
    // Release any task still held, then give every engine that ran a task
    // time to exit. Deleting the root first would delete the release marker
    // too, leaving a detached engine polling until its 120 s hold expires and
    // writing its logs back under the deleted root.
    fs.writeFileSync(releasePath, "", "utf8");
    await waitUntil(
      () => !trace().some((line) => processIsAlive(Number(line.split(" ")[0]))),
      30_000,
      "the detached engines exit"
    ).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function initFixtureRepository(root: string): void {
  execGit(root, ["init", "--quiet", "--initial-branch=main"]);
  execGit(root, ["config", "user.name", "Ultrafuzz Synthetic Test"]);
  execGit(root, ["config", "user.email", "synthetic@example.invalid"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "/artifacts/\n/.smithers/\n/.ultrafuzz/\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Synthetic preparation fixture\n", "utf8");
  execGit(root, ["add", ".gitignore", "README.md"]);
  execGit(root, ["commit", "--quiet", "-m", "synthetic fixture"]);
}

function parallelPreparationWorkflowSource(input: { root: string; evidenceRoot: string }): string {
  return `/** @jsxImportSource smthrs */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const root = ${JSON.stringify(input.root)};
const evidenceRoot = ${JSON.stringify(input.evidenceRoot)};
const lanes = [0, 1, 2, 3, 4, 5];
const { Workflow, Worktree, Task, Parallel, smithers, outputs } = createSmithers({
  input: z.object({}),
  preparation: z.object({ prepared: z.literal(true) })
});

export default smithers(() => (
  <Workflow name="synthetic-preparation-race">
    <Parallel id="synthetic-preparation-lanes">
      {lanes.map((lane) => {
        const worktreePath = path.join(root, ".smithers", "worktrees", "prep-race-" + lane);
        return (
          <Worktree key={"lane-" + lane} path={worktreePath} branch={"synthetic-prep-race-" + lane}>
            <Task id={"prepare:lane-" + lane} output={outputs.preparation} retries={1}>
              {() => {
                const head = execFileSync("git", ["rev-parse", "HEAD"], {
                  cwd: worktreePath,
                  encoding: "utf8"
                }).trim();
                const mirror = path.join(worktreePath, "artifacts", "lane-" + lane);
                fs.mkdirSync(mirror, { recursive: true });
                fs.writeFileSync(path.join(mirror, "prepared.txt"), head + "\\n", "utf8");
                fs.writeFileSync(
                  path.join(evidenceRoot, "lane-" + lane + ".json"),
                  JSON.stringify({ lane, head }),
                  "utf8"
                );
                return { prepared: true };
              }}
            </Task>
          </Worktree>
        );
      })}
    </Parallel>
  </Workflow>
));
`;
}

function retriedPreparationWorkflowSource(input: { root: string; attemptsPath: string }): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const root = ${JSON.stringify(input.root)};
const attemptsPath = ${JSON.stringify(input.attemptsPath)};
const worktreePath = path.join(root, ".smithers", "worktrees", "prep-retry");
const { Workflow, Worktree, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  preparation: z.object({ prepared: z.literal(true) })
});

export default smithers(() => (
  <Workflow name="synthetic-preparation-retry">
    <Worktree path={worktreePath} branch="synthetic-prep-retry">
      <Task id="prepare:retried" output={outputs.preparation} retries={1}>
        {() => {
          const firstAttempt = !fs.existsSync(attemptsPath);
          fs.appendFileSync(attemptsPath, "attempt\\n", "utf8");
          if (firstAttempt) throw new Error("synthetic transient preparation failure");
          return { prepared: true };
        }}
      </Task>
    </Worktree>
  </Workflow>
));
`;
}

function nativeContinuationWorkflowSource(input: {
  executionLog: string;
  producerArtifact: string;
  downstreamArtifact: string;
  withDownstream: boolean;
}): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const executionLog = ${JSON.stringify(input.executionLog)};
const producerArtifact = ${JSON.stringify(input.producerArtifact)};
const downstreamArtifact = ${JSON.stringify(input.downstreamArtifact)};
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  producer: z.object({ embedded_run_id: z.string(), value: z.string() }),
  downstream: z.object({ producer_run_id: z.string() })
});

export default smithers((ctx) => (
  <Workflow name="native-continuation">
    <Task id="producer" output={outputs.producer} retries={0}>
      {() => {
        const value = { run_id: "historical-embedded-run-id", value: "original" };
        fs.appendFileSync(executionLog, "producer\\n", "utf8");
        fs.writeFileSync(producerArtifact, JSON.stringify(value) + "\\n", "utf8");
        return { embedded_run_id: value.run_id, value: value.value };
      }}
    </Task>
    ${
      input.withDownstream
        ? `<Task id="downstream" output={outputs.downstream} dependsOn={["producer"]} retries={0}>
      {() => {
        const producer = ctx.latest(outputs.producer, "producer");
        if (!producer) throw new Error("persisted producer output is unavailable");
        fs.appendFileSync(executionLog, "downstream\\n", "utf8");
        fs.writeFileSync(downstreamArtifact, JSON.stringify({
          producer_run_id: producer.embedded_run_id,
          controller_node_path: process.env.NODE_PATH
        }) + "\\n", "utf8");
        return { producer_run_id: producer.embedded_run_id };
      }}
    </Task>`
        : ""
    }
  </Workflow>
));
`;
}

function pauseHandoffWorkflowSource(input: { traceLog: string; releasePath: string }): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const traceLog = ${JSON.stringify(input.traceLog)};
const releasePath = ${JSON.stringify(input.releasePath)};
const trace = (event) => fs.appendFileSync(traceLog, process.pid + " " + event + "\\n", "utf8");
const { Workflow, Task, Parallel, Sequence, smithers, outputs } = createSmithers({
  input: z.object({}),
  step: z.object({ done: z.literal(true) })
});
// Hold each in-flight task until the test releases it, bounded so a failed
// test cannot leave the detached engine polling forever.
const held = (id) => async () => {
  trace(id + " start");
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(releasePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  trace(id + " end");
  return { done: true };
};

export default smithers(() => (
  <Workflow name="pause-handoff">
    <Sequence>
      <Parallel id="in-flight">
        <Task id="a" output={outputs.step} retries={0}>{held("a")}</Task>
        <Task id="b" output={outputs.step} retries={0}>{held("b")}</Task>
      </Parallel>
      <Task id="c" output={outputs.step} retries={0}>{() => (trace("c start"), { done: true })}</Task>
    </Sequence>
  </Workflow>
));
`;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting until ${label}`);
}

async function waitForSuccessfulCompletion(root: string, runId: string, timeoutMs: number): Promise<void> {
  await waitForStatus(root, runId, "finished", timeoutMs);
}

async function waitForStatus(root: string, runId: string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    try {
      const inspected = JSON.parse(
        execFileSync(smithersBinary(), ["inspect", runId, "--format", "json"], {
          cwd: root,
          encoding: "utf8"
        })
      ) as { status?: string; run?: { status?: string } };
      status = inspected.status ?? inspected.run?.status ?? status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (status === expected) return;
    if (["failed", "cancelled", "canceled"].includes(status)) {
      throw new Error(`synthetic Smithers workflow ended with status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`synthetic Smithers workflow did not reach ${expected}; final status ${status}`);
}

function smithersNodeOutput(root: string, runId: string, nodeId: string): Buffer {
  return Buffer.from(
    execFileSync(smithersBinary(), ["output", runId, nodeId, "--format", "json"], {
      cwd: root,
      encoding: "utf8"
    }),
    "utf8"
  );
}

function smithersNodeAttempt(root: string, runId: string, nodeId: string): number {
  const inspected = JSON.parse(
    execFileSync(smithersBinary(), ["inspect", runId, "--format", "json"], {
      cwd: root,
      encoding: "utf8"
    })
  ) as { steps?: Array<{ id?: string; nodeId?: string; node_id?: string; attempt?: number }> };
  const step = inspected.steps?.find((candidate) => (candidate.id ?? candidate.nodeId ?? candidate.node_id) === nodeId);
  assert.ok(step, `Smithers inspect omitted ${nodeId}`);
  assert.equal(Number.isSafeInteger(step.attempt), true, `Smithers inspect omitted ${nodeId} attempt`);
  return step.attempt!;
}

function smithersBinary(): string {
  return path.join(
    runtimePackageRoot(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "smithers.cmd" : "smithers"
  );
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function runtimePackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const value = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (value.name === "@ultrafuzz/runtime") return current;
    }
    current = path.dirname(current);
  }
  throw new Error("runtime package root not found");
}
