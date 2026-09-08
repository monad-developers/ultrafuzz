import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as ts from "typescript";

function reconstructTaskIdentity(matchingStaticTask: boolean) {
  const template = fs.readFileSync(
    new URL("../../src/templates/smithers/workflows/workflow.tsx", import.meta.url),
    "utf8"
  );
  const start = template.indexOf("function compiledTaskSourceIdentity");
  const end = template.indexOf("\nfunction projectRelativePath", start);
  assert.ok(start >= 0 && end > start);
  const compiled = ts.transpileModule(template.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const task = {
    smithersNodeId: "node:report-attempt",
    logicalNodeId: "report",
    attemptId: "report-attempt",
    execution: { mode: "local" },
    workspacePath: "workspaces/report-attempt",
    artifactDir: "artifacts/report-attempt",
    dependencyArtifactDirs: [],
    referenceArtifactDirs: [],
    metadata: { node: {}, artifacts: { outputs: [] } }
  };
  // Execute the complete reconstruction function. Unrelated path and policy
  // helpers are stubbed; workflow identity must come from the supplied tasks.
  const bindings = {
    path,
    sourceProjectRoot: process.cwd(),
    serializedTaskSpecs: [
      { id: "node:planner", smithersRunId: "ultrafuzz-shared-run" },
      ...(matchingStaticTask ? [{ id: task.smithersNodeId, smithersRunId: "ultrafuzz-static-run" }] : [])
    ],
    admittedWorkflowControls: {},
    taskWorkflowControlPaths: () => ({}),
    dynamicExecutionPath: (_task: unknown, value: string) => value,
    compiledBaseTasks: [task],
    dynamicGroupSpecs: [],
    topologyRuntimeContextForTimeout: () => ({}),
    dependencyVerificationProducersFromCompiledTask: () => [],
    INVARIANT_CAMPAIGN_RUNTIME_CONTRACTS: new Set(),
    dynamicExecutionMetadata: () => task.metadata,
    __ULTRAFUZZ_WORKFLOW_PATH_RELATIVE__: "workflow.tsx",
    __ULTRAFUZZ_RUN_ROOT_RELATIVE__: ".ultrafuzz/runs/synthetic",
    __ULTRAFUZZ_RUN_ID_LITERAL__: "synthetic"
  };
  return new Function(
    "bindings",
    `const { ${Object.keys(bindings).join(", ")} } = bindings;
     ${compiled}
     return taskSpecsFromCompiled(compiledBaseTasks)[0];`
  )(bindings) as { id: string; smithersNodeId: string; smithersRunId: string; logicalNodeId: string };
}

test("reconstructed static tasks retain the matching workflow identity", () => {
  const task = reconstructTaskIdentity(true);
  assert.equal(task.id, "node:report-attempt");
  assert.equal(task.smithersNodeId, task.id);
  assert.equal(task.logicalNodeId, "report");
  assert.equal(task.smithersRunId, "ultrafuzz-static-run");
});

test("generated tasks inherit the sealed workflow run identity without a static task match", () => {
  const task = reconstructTaskIdentity(false);
  assert.equal(task.smithersNodeId, "node:report-attempt");
  assert.equal(task.logicalNodeId, "report");
  assert.equal(task.smithersRunId, "ultrafuzz-shared-run");
});
