import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadReferenceCatalog } from "@ultrafuzz/references";

import { initProject, planRun } from "../src/index.js";
import { compileSmithersWorkflow, type CompiledSmithersWorkflow } from "../src/smithers.js";
import { writeShippedDocumentReferenceCaches, writeShippedVulnerabilityDatabaseCache } from "./reference-fixtures.js";
import { privateHomeEnv, temporaryRoot } from "./temporary-root.js";

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

// One failed property lens used to halt the whole default campaign: the lenses shared a halting
// group with the fan-in, and only the review group could consume a continuing producer's output.
test("a failed property lens leaves the packaged default fan-in, strategies and review to finish", async () => {
  const compiled = await compilePackagedDefaultTopology();
  const lenses = compiled.tasks.filter((task) =>
    task.metadata.artifacts.outputs.some((output) => output.contract === "ultrafuzz/property-lens@2")
  );
  const lensDirs = new Set(lenses.map((task) => task.artifactDir));
  assert.equal(lenses.length, 8);
  for (const task of compiled.tasks) {
    const optional = task.optionalDependencyArtifactDirs ?? [];
    // No attempt requires a lens's output, so a failed lens fails no downstream input admission.
    assert.deepEqual(
      task.dependencyArtifactDirs.filter((directory) => lensDirs.has(directory) && !optional.includes(directory)),
      [],
      task.attemptId
    );
    // Outside review nothing else became optional: the strategies still require the fan-in, and
    // each stateful stage still requires the one before it.
    if (task.metadata.node.group !== "review") {
      assert.deepEqual(
        optional.filter((directory) => !lensDirs.has(directory)),
        [],
        task.attemptId
      );
    }
  }

  const failing = "property-specification-a16z";
  assert.ok(lenses.some((task) => task.attemptId === failing));
  const { state } = await runSyntheticWorkflow("lens-failure", (root, template) =>
    compiledSchedulingWorkflowSource(root, template, compiled, failing)
  );
  assert.equal(state(`verify:${failing}`), "failed");
  for (const task of compiled.tasks) {
    if (task.attemptId !== failing) assert.equal(state(task.verifierSmithersNodeId), "finished", task.attemptId);
  }
});

async function compilePackagedDefaultTopology(): Promise<CompiledSmithersWorkflow> {
  const project = temporaryRoot("ufz-lens-failure-project-");
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeShippedDocumentReferenceCaches(xdgCacheHome, loadReferenceCatalog(project));
  writeShippedVulnerabilityDatabaseCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  try {
    const runId = "lens-failure";
    const plan = await planRun({
      projectRoot: project,
      runId,
      env: privateHomeEnv(),
      runtimeOverrides: { auditProfile: "default" }
    });
    assert.ok(plan.ok && plan.value, JSON.stringify(plan.diagnostics));
    return compileSmithersWorkflow({
      projectRoot: project,
      config: plan.value.resolved_config,
      graph: plan.value.expanded_graph,
      runLayout: plan.value.layout,
      workflowName: `ultrafuzz-${runId}`,
      renderedPrompts: plan.value.rendered_prompts
    });
  } finally {
    if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
  }
}

/**
 * Each compiled attempt becomes one engine task with the generated workflow's scheduling inputs: its
 * verifier ID, its producers' verifier IDs, continue-on-failure for non-blocking attempts, and the
 * template's own skip decision over required producers. Only `failing` throws.
 */
function compiledSchedulingWorkflowSource(
  root: string,
  template: string,
  compiled: CompiledSmithersWorkflow,
  failing: string
): string {
  const compiledBaseTasks = compiled.tasks.map((task) => ({
    attemptId: task.attemptId,
    verifierId: task.verifierSmithersNodeId,
    dependsOn: task.dependencySmithersNodeIds,
    dependencyArtifactDirs: task.dependencyArtifactDirs,
    optionalDependencyArtifactDirs: task.optionalDependencyArtifactDirs ?? [],
    metadata: { dependencies: task.metadata.dependencies }
  }));
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import path from "node:path";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
${templateSlice(template, "type WorkflowTaskStateContext =", "const agentPromptTemplate =")}
const compiledBaseTasks = ${JSON.stringify(compiledBaseTasks)};
${templateSlice(template, "function dependencyVerificationProducersFromCompiledTask", "\n\nfunction dynamicExecutionMetadata")}
const nonBlocking = new Set(${JSON.stringify(compiled.nonBlockingAttemptIds)});
const evidence = ${JSON.stringify(path.join(root, "executed.log"))};
const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
const record = (value: string) => { fs.appendFileSync(evidence, value + "\\n"); return { value }; };
export default smithers((ctx) => <Workflow name="lens-failure"><Parallel>
  {compiledBaseTasks.map((task) => {
    const required = dependencyVerificationProducersFromCompiledTask(task)
      .filter((producer) => !producer.optional)
      .map((producer) => producer.verifierId);
    return <Task key={task.verifierId} id={task.verifierId} output={outputs.result} dependsOn={task.dependsOn}
      skipIf={shouldSkipWorkflowTask(ctx, task.verifierId, failedWorkflowPrerequisites(ctx, required))}
      continueOnFail={nonBlocking.has(task.attemptId)} retries={0}>
      {() => {
        if (task.attemptId === ${JSON.stringify(failing)}) throw new Error("synthetic lens failure");
        return record(task.attemptId);
      }}
    </Task>;
  })}
</Parallel></Workflow>);
`;
}

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
