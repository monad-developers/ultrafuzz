import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRunLayout } from "@ultrafuzz/artifacts";
import { createDefaultResolvedConfig } from "@ultrafuzz/config";
import { expandTopology, type ProjectTopology } from "@ultrafuzz/topology";
import * as ts from "typescript";

import { compileSmithersWorkflow } from "../src/smithers.js";
import { temporaryRoot } from "./temporary-root.js";

function workflowTemplateSource(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.existsSync(path.join(root, "src", "templates")) ? root : path.resolve(root, "..");
  return fs.readFileSync(path.join(source, "src", "templates", "smithers", "workflows", "workflow.tsx"), "utf8");
}

interface StateContext {
  iteration: number;
  _taskStates?: Map<string, unknown> | Record<string, unknown>;
  _taskIterations?: Map<string, number> | Record<string, number>;
}

function dependencyStateHelpers(): {
  failedWorkflowPrerequisites: (ctx: StateContext, ids: readonly string[]) => string[];
  shouldSkipWorkflowTask: (ctx: StateContext, nodeId: string, failed: readonly string[]) => boolean;
} {
  const source = workflowTemplateSource();
  const start = source.indexOf("type WorkflowTaskStateContext =");
  const end = source.indexOf("type DependencyVerificationProducer =", start);
  assert.ok(start >= 0 && end > start);
  const emitted = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(`${emitted}; return { failedWorkflowPrerequisites, shouldSkipWorkflowTask };`)() as ReturnType<
    typeof dependencyStateHelpers
  >;
}

test("workflow dependency policy preserves required strategy inputs and partial review fan-in", () => {
  const projectRoot = temporaryRoot("ufz-dependency-policy-");
  const runId = "dependency-policy";
  const runLayout = createRunLayout({ outputRoot: path.join(projectRoot, "runs"), runId });
  const topology: ProjectTopology = {
    version: 2,
    defaults: { strategy_loops: 1 },
    groups: { strategies: { defaults: { failure_policy: "continue" } }, review: {} },
    nodes: [
      { id: "__start__", kind: "meta", role: "start", depends_on: [] },
      ...[
        { id: "producer", group: "strategies", depends_on: ["__start__"] },
        { id: "dependent", group: "strategies", depends_on: ["producer"] },
        { id: "independent", group: "strategies", depends_on: ["__start__"] },
        { id: "review", group: "review", depends_on: ["dependent", "independent"] }
      ].map((node) => ({
        ...node,
        kind: "agentic" as const,
        prompt: "fixture.md",
        outputs: [{ path: "result.md", contract: "ultrafuzz/nonempty-markdown@1" as const, primary: true }]
      })),
      { id: "__finish__", kind: "meta", role: "finish", depends_on: ["review"] }
    ]
  };
  const config = createDefaultResolvedConfig();
  const graph = expandTopology(topology, {
    projectRoot,
    runId,
    promptTexts: { "fixture.md": "Write fixture output." }
  });
  const compiled = compileSmithersWorkflow({
    projectRoot,
    config,
    graph,
    runLayout,
    renderedPrompts: [],
    controllerSourceDigest: "0".repeat(64)
  });
  assert.deepEqual(compiled.nonBlockingAttemptIds, ["dependent", "independent", "producer"]);
  const dependent = compiled.tasks.find((task) => task.attemptId === "dependent");
  const independent = compiled.tasks.find((task) => task.attemptId === "independent");
  const review = compiled.tasks.find((task) => task.attemptId === "review");
  assert.ok(dependent && independent && review);
  assert.deepEqual(dependent.dependencySmithersNodeIds, ["verify:producer"]);
  assert.deepEqual(dependent.optionalDependencyArtifactDirs, []);
  assert.deepEqual(independent.dependencySmithersNodeIds, []);
  assert.deepEqual(review.optionalDependencyArtifactDirs?.map((directory) => path.basename(directory)).sort(), [
    "dependent",
    "independent",
    "producer"
  ]);
});

test("workflow skip policy follows only the current attempt iteration", () => {
  const { failedWorkflowPrerequisites, shouldSkipWorkflowTask } = dependencyStateHelpers();
  for (const useMap of [true, false]) {
    const states = { "verify:producer::0": "failed", "verify:producer::1": "pending" };
    const ctx: StateContext = { iteration: 1, _taskStates: useMap ? new Map(Object.entries(states)) : states };
    assert.deepEqual(failedWorkflowPrerequisites(ctx, ["verify:producer"]), []);
    ctx._taskIterations = useMap ? new Map([["verify:producer", 0]]) : { "verify:producer": 0 };
    const failed = failedWorkflowPrerequisites(ctx, ["verify:producer"]);
    assert.deepEqual(failed, ["verify:producer"]);
    assert.equal(shouldSkipWorkflowTask(ctx, "node:dependent", failed), true);
  }
});

test("workflow skip policy preserves running and terminal attempt evidence", () => {
  const { failedWorkflowPrerequisites, shouldSkipWorkflowTask } = dependencyStateHelpers();
  for (const prerequisiteState of ["failed", "stalled", "skipped", "cancelled"]) {
    const ctx: StateContext = { iteration: 0, _taskStates: { "prepare:dependent::0": prerequisiteState } };
    const failed = failedWorkflowPrerequisites(ctx, ["prepare:dependent"]);
    assert.deepEqual(failed, ["prepare:dependent"]);
    assert.equal(shouldSkipWorkflowTask(ctx, "node:dependent", failed), true);
    for (const ownState of ["finished", "failed", "in-progress", "stalled", "cancelled", "bound-stale"]) {
      ctx._taskStates = { "node:dependent::0": ownState };
      assert.equal(shouldSkipWorkflowTask(ctx, "node:dependent", failed), false, ownState);
    }
  }
  assert.equal(shouldSkipWorkflowTask({ iteration: 0 }, "node:independent", []), false);
});
