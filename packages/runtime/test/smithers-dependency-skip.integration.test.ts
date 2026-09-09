import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { temporaryRoot } from "./temporary-root.js";

interface Inspection {
  status?: string;
  run?: { status?: string };
  steps?: Array<{ id?: string; nodeId?: string; state?: string }>;
}

test("failed and stalled required inputs skip dependent attempts while independent work and review finish", async () => {
  const root = temporaryRoot("ufz-skip-required-");
  const packageRoot = runtimePackageRoot();
  const smithers = path.join(packageRoot, "node_modules", ".bin", "smithers");
  const runId = `skip-required-${process.pid}-${Date.now()}`;
  const workflow = path.join(root, ".smithers", "workflows", "required-inputs.tsx");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  const dependencyRoot = path.dirname(fs.realpathSync(path.join(packageRoot, "node_modules", "smthrs")));
  fs.symlinkSync(dependencyRoot, path.join(root, ".smithers", "node_modules"), "dir");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  fs.writeFileSync(workflow, syntheticWorkflowSource(root, packageRoot));
  execFileSync(
    smithers,
    ["up", workflow, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, SMITHERS_POST_FAILURE: "0" } }
  );

  let inspected: Inspection = {};
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    inspected = JSON.parse(
      execFileSync(smithers, ["inspect", runId, "--format", "json"], { cwd: root, encoding: "utf8" })
    ) as Inspection;
    const status = inspected.status ?? inspected.run?.status;
    if (status === "finished" || status === "failed" || status === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(inspected.status ?? inspected.run?.status, "finished", JSON.stringify(inspected));
  const state = (nodeId: string) => inspected.steps?.find((step) => (step.id ?? step.nodeId) === nodeId)?.state;
  assert.equal(state("verify:producer"), "failed");
  assert.equal(state("prepare:dependent"), "skipped");
  assert.equal(state("node:dependent"), "skipped");
  assert.equal(state("verify:dependent"), "skipped");
  assert.equal(state("prepare:own-failure"), "stalled");
  assert.equal(state("node:own-failure"), "skipped");
  assert.equal(state("verify:own-failure"), "skipped");
  assert.equal(state("independent"), "finished");
  assert.equal(state("review"), "finished");
  assert.deepEqual(fs.readFileSync(path.join(root, "executed.log"), "utf8").trim().split("\n"), [
    "independent",
    "review"
  ]);
});

function syntheticWorkflowSource(root: string, packageRoot: string): string {
  const source = fs.readFileSync(
    path.join(packageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx"),
    "utf8"
  );
  const start = source.indexOf("type WorkflowTaskStateContext =");
  const end = source.indexOf("type DependencyVerificationProducer =", start);
  assert.ok(start >= 0 && end > start);
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
${source.slice(start, end)}
const evidence = ${JSON.stringify(path.join(root, "executed.log"))};
const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
const record = (value: string) => { fs.appendFileSync(evidence, value + "\\n"); return { value }; };
export default smithers((ctx) => {
  const missing = failedWorkflowPrerequisites(ctx, ["verify:producer"]);
  const preparation = failedWorkflowPrerequisites(ctx, ["prepare:own-failure"]);
  return <Workflow name="required-inputs"><Parallel>
    <Task id="verify:producer" output={outputs.result} continueOnFail retries={0}>
      {() => { throw new Error("synthetic producer failure"); }}
    </Task>
    <Task id="prepare:dependent" output={outputs.result} dependsOn={["verify:producer"]}
      skipIf={shouldSkipWorkflowTask(ctx, "prepare:dependent", missing)} continueOnFail retries={0}>
      {() => record("forbidden-preparation")}
    </Task>
    <Task id="node:dependent" output={outputs.result} dependsOn={["prepare:dependent"]}
      skipIf={shouldSkipWorkflowTask(ctx, "node:dependent", missing)} continueOnFail retries={0}>
      {() => record("forbidden-dependent")}
    </Task>
    <Task id="verify:dependent" output={outputs.result} dependsOn={["node:dependent"]}
      skipIf={shouldSkipWorkflowTask(ctx, "verify:dependent", missing)} continueOnFail retries={0}>
      {() => record("forbidden-dependent-verifier")}
    </Task>
    <Task id="prepare:own-failure" output={outputs.result} continueOnFail retries={3}
      retryPolicy={{ initialDelayMs: 0, maxIdenticalFailures: 1 }}>
      {() => { throw new Error("synthetic preparation failure"); }}
    </Task>
    <Task id="node:own-failure" output={outputs.result} dependsOn={["prepare:own-failure"]}
      skipIf={shouldSkipWorkflowTask(ctx, "node:own-failure", preparation)} continueOnFail retries={0}>
      {() => record("forbidden-after-preparation")}
    </Task>
    <Task id="verify:own-failure" output={outputs.result} dependsOn={["node:own-failure"]}
      skipIf={shouldSkipWorkflowTask(ctx, "verify:own-failure", preparation)} continueOnFail retries={0}>
      {() => record("forbidden-preparation-verifier")}
    </Task>
    <Task id="independent" output={outputs.result} retries={0}>{() => record("independent")}</Task>
    <Task id="review" output={outputs.result}
      dependsOn={["verify:dependent", "verify:own-failure", "independent"]} retries={0}>
      {() => record("review")}
    </Task>
  </Parallel></Workflow>;
});
`;
}

function runtimePackageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      const metadata = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
      if (metadata.name === "@ultrafuzz/runtime") return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error("runtime package root not found");
}
