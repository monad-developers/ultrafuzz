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
  const { root, state } = await runSyntheticWorkflow("required-inputs", syntheticWorkflowSource);
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

test("a dependency admission failure fails its preparation once while a transient failure is retried", async () => {
  const { root, state } = await runSyntheticWorkflow("non-retryable", nonRetryableWorkflowSource);
  // #1144: the default three-attempt budget used to re-read the same producer
  // bytes three times and then stall; the attempt now fails once.
  assert.equal(state("prepare:consumer"), "failed");
  assert.equal(state("node:consumer"), "skipped");
  // #672: an engine-boundary TypeError still spends the preparation retry.
  assert.equal(state("prepare:transient"), "finished");
  assert.deepEqual(fs.readFileSync(path.join(root, "executed.log"), "utf8").trim().split("\n").sort(), [
    "consumer",
    "transient",
    "transient"
  ]);
});

async function runSyntheticWorkflow(
  name: string,
  workflowSource: (root: string, template: string) => string
): Promise<{ root: string; state: (nodeId: string) => string | undefined }> {
  const root = temporaryRoot(`ufz-${name}-`);
  const packageRoot = runtimePackageRoot();
  const smithers = path.join(packageRoot, "node_modules", ".bin", "smithers");
  const runId = `${name}-${process.pid}-${Date.now()}`;
  const workflow = path.join(root, ".smithers", "workflows", `${name}.tsx`);
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  const dependencyRoot = path.dirname(fs.realpathSync(path.join(packageRoot, "node_modules", "smthrs")));
  fs.symlinkSync(dependencyRoot, path.join(root, ".smithers", "node_modules"), "dir");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  const template = fs.readFileSync(
    path.join(packageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx"),
    "utf8"
  );
  fs.writeFileSync(workflow, workflowSource(root, template));
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
  return {
    root,
    state: (nodeId) => inspected.steps?.find((step) => (step.id ?? step.nodeId) === nodeId)?.state
  };
}

function templateSlice(template: string, startMarker: string, endMarker: string): string {
  const start = template.indexOf(startMarker);
  const end = template.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} is missing from the workflow template`);
  return template.slice(start, end);
}

function nonRetryableWorkflowSource(root: string, template: string): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
${templateSlice(template, "type WorkflowTaskStateContext =", "const agentPromptTemplate =")}
${templateSlice(template, "function preparationStep", "\n\nfunction prepareArtifactMirror")}
${templateSlice(template, "function nonRetryableFailure", "\n\nfunction assertVerifiedDependency")}
const evidence = ${JSON.stringify(path.join(root, "executed.log"))};
const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
const executions = (value: string) =>
  fs.existsSync(evidence) ? fs.readFileSync(evidence, "utf8").split("\\n").filter((line) => line === value).length : 0;
const record = (value: string) => { fs.appendFileSync(evidence, value + "\\n"); return { value }; };
export default smithers((ctx) => {
  const preparation = failedWorkflowPrerequisites(ctx, ["prepare:consumer"]);
  return <Workflow name="non-retryable"><Parallel>
    <Task id="prepare:consumer" output={outputs.result} continueOnFail retries={2}>
      {() => preparationStep("consumer", "assert-task-inputs", () => {
        record("consumer");
        throw nonRetryableFailure(new Error("artifact-contract failure: artifact dependency has not passed verification producer"));
      })}
    </Task>
    <Task id="node:consumer" output={outputs.result} dependsOn={["prepare:consumer"]}
      skipIf={shouldSkipWorkflowTask(ctx, "node:consumer", preparation)} continueOnFail retries={0}>
      {() => record("forbidden-consumer")}
    </Task>
    <Task id="prepare:transient" output={outputs.result} continueOnFail retries={2}>
      {() => preparationStep("transient", "resolve-workspace-root", () => {
        if (executions("transient") === 0) {
          record("transient");
          throw new TypeError("undefined is not an object (evaluating 'get')");
        }
        return record("transient");
      })}
    </Task>
  </Parallel></Workflow>;
});
`;
}

function syntheticWorkflowSource(root: string, template: string): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
${templateSlice(template, "type WorkflowTaskStateContext =", "const agentPromptTemplate =")}
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
