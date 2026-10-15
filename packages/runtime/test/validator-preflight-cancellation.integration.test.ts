import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { temporaryRoot } from "./temporary-root.js";

function templateSource(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (path.dirname(directory) !== directory) {
    const template = path.join(directory, "src/templates/smithers/workflows/workflow.tsx");
    if (fs.existsSync(template)) return fs.readFileSync(template, "utf8");
    directory = path.dirname(directory);
  }
  throw new Error("runtime workflow template not found");
}

function generatedPreparation(): string {
  const source = templateSource();
  const slice = (start: string, end: string) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} not found in workflow template`);
    return source.slice(from, to);
  };
  // Exercise the real generated entrypoint and wrappers, not just the helper
  // that already accepted AbortSignal before the missing wiring regression.
  return ts.transpileModule(
    [
      slice("function preparationStep", "\n\nfunction prepareArtifactMirror"),
      slice("async function prepareArtifactMirrorForAgent", "\n\n/**\n * How long the validator preflight"),
      slice("const JSON_VALIDATOR_PREFLIGHT_TIMEOUT_MS", "\n\nfunction taskPublishesWorkspacePatch"),
      slice("function nonRetryableFailure", "\n\nfunction assertVerifiedDependency")
    ].join("\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
}

function live(pid: number): boolean {
  try {
    // An adopted zombie has stopped executing even when a container's PID 1
    // has not reaped it yet.
    return !/^\d+ \(.*\) Z /u.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

for (const entrypoint of ["preparation", "generation"] as const) {
  test(
    `pinned Smithers ${entrypoint} cancellation leaves no validator descendants after engine exit`,
    {
      skip: process.platform !== "linux",
      timeout: 30_000
    },
    async () => {
      const root = temporaryRoot("ultrafuzz-engine-preflight-cancel-");
      const pidsFile = path.join(root, "pids");
      const pids = () =>
        fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, "utf8").trim().split("\n").map(Number) : [];
      const runner = createRequire(import.meta.url).resolve("smthrs");
      fs.symlinkSync(path.dirname(path.dirname(path.dirname(runner))), path.join(root, "node_modules"), "dir");
      const launcher = path.join(root, "trusted-bin", "ultrafuzz");
      fs.mkdirSync(path.dirname(launcher));
      // Four SIGTERM-resistant Node processes in three process groups. The two
      // timeout(1) wrappers reproduce nested groups within the detached session.
      fs.writeFileSync(
        launcher,
        `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const pidsFile = ${JSON.stringify(pidsFile)};
const level = process.argv[2] === "child" ? Number(process.argv[3]) : 0;
process.on("SIGTERM", () => {});
fs.appendFileSync(pidsFile, process.pid + "\\n");
if (level < 3) {
  const args = [__filename, "child", String(level + 1)];
  if (level < 2) {
    const child = spawn("/usr/bin/timeout", ["30s", process.execPath, ...args], { stdio: "inherit" });
    fs.appendFileSync(pidsFile, child.pid + "\\n");
  } else {
    spawn(process.execPath, args, { stdio: "inherit" });
  }
}
setInterval(() => {}, 1000);
`,
        { mode: 0o755 }
      );
      assert.match(templateSource(), /prepareArtifactMirrorForAgent\(task, \{\}, context\?\.ultrafuzzAbortSignal\)/u);
      fs.writeFileSync(
        path.join(root, "workflow.mjs"),
        `
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import React from "react";
import { createSmithers, runWorkflow } from "smthrs";
import { z } from "zod/v4";
import { runProcessGroup as supervise } from ${JSON.stringify(new URL("../src/process-group.js", import.meta.url).href)};
let observedSignal;
const runProcessGroup = (command, args, options) => {
  observedSignal = options.signal;
  fs.writeFileSync("launch.json", JSON.stringify({ command, hasSignal: options.signal instanceof AbortSignal }));
  return supervise(command, args, options);
};
const task = { attemptId: "fixture", workspacePath: process.cwd(), runRoot: process.cwd(), outputs: [{}] };
const prepareArtifactMirror = () => ({ prepared: true });
const isSchemaBackedOutput = () => true;
const plannedSchemaBundle = () => ({ registry: [{ filename: "findings.schema.json", id: "fixture", sha256: "fixture" }], sha256: "fixture" });
const artifactValidatorSmokeFixturePath = () => "fixture.json";
const ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256 = "fixture";
const parseJsonValidatorPreflightSuccessEnvelope = () => {};
${generatedPreparation()}
const { Workflow, Task, smithers, outputs } = createSmithers({ preparation: z.object({ prepared: z.boolean() }) }, { dbPath: "smithers.db" });
const h = React.createElement;
const agent = {
  async generate(options) {
    await prepareArtifactMirrorForAgent(task, {}, options.abortSignal);
    throw new Error("canceled preflight must not reach generation");
  }
};
const workflow = smithers(() => h(Workflow, { name: "preflight-cancellation" },
  ${entrypoint === "preparation" ? 'h(Task, { id: "prepare", output: outputs.preparation, retries: 0 }, (context) => prepareArtifactMirrorForAgent(task, {}, context?.ultrafuzzAbortSignal))' : 'h(Task, { id: "agent", output: outputs.preparation, agent, retries: 0 }, "work")'}));
const controller = new AbortController();
const ready = setInterval(() => {
  if (!fs.existsSync("pids")) return;
  if (fs.readFileSync("pids", "utf8").trim().split("\\n").length !== 6) return;
  clearInterval(ready);
  controller.abort();
}, 5);
setTimeout(() => process.exit(2), 15_000);
const run = await Effect.runPromise(runWorkflow(workflow, {
  input: {}, runId: "cancel-preflight", rootDir: process.cwd(), signal: controller.signal
}));
fs.writeFileSync("result.json", JSON.stringify({ status: run.status, signalAborted: observedSignal?.aborted }));
// Do not await the preflight separately or leave an artificial grace period.
// The runner can return before the canceled compute/generate promise settles.
process.exit(0);
`
      );
      try {
        const engine = spawnSync("bun", [path.join(root, "workflow.mjs")], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 20_000
        });
        assert.equal(engine.status, 0, [engine.error, engine.stdout, engine.stderr].join("\n"));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")), {
          status: "cancelled",
          signalAborted: true
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "launch.json"), "utf8")), {
          command: launcher,
          hasSignal: true
        });
        assert.equal(pids().length, 6, "all descendant levels must have started before cancellation");
        // SIGKILL delivery is synchronous; kernel reaping need not be. Waiting
        // here cannot run the engine's canceled grace timer: it has already exited.
        const deadline = Date.now() + 1_000;
        while (pids().some(live) && Date.now() < deadline) await delay(10);
        assert.deepEqual(pids().filter(live), [], "validator descendants survived the canceled engine");
      } finally {
        for (const pid of pids()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already terminated by the supervisor. */
          }
        }
      }
    }
  );
}
