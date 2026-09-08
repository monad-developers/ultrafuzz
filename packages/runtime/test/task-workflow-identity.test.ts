import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as ts from "typescript";
import type { SmithersTaskManifestTask } from "@ultrafuzz/artifacts";

import { initProject, planRun } from "../src/index.js";
import { compileSmithersWorkflow } from "../src/smithers.js";
import { reconcileSmithersAttemptAgentSelection, smithersTaskAgentId } from "../src/smithers-attempt-authority.js";
import { temporaryRoot } from "./temporary-root.js";

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

async function compileStaticTask(mode: "local" | "cloud") {
  const projectRoot = temporaryRoot("ultrafuzz-static-task-identity-");
  initProject({ projectRoot, force: true });
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "prompts", "identity.md"),
    "---\nid: identity\ndisplay_name: Identity\n---\nWrite {{artifact_path}}/report.md.\n"
  );
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: report
    kind: agentic
    max_attempts: ${mode === "cloud" ? 1 : 3}
    prompt: identity.md
    depends_on: [__start__]
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [report]
`
  );
  const plan = await planRun({ projectRoot, runId: "static-identity", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.ok(plan.value);
  plan.value.resolved_config.execution.mode = mode;
  if (mode === "cloud") {
    plan.value.resolved_config.execution.provider = "modal";
    plan.value.resolved_config.execution.providers.modal = {
      app: "ultrafuzz-test",
      image: "ultrafuzz-test",
      credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
    };
  }
  const compiled = compileSmithersWorkflow({
    projectRoot,
    config: plan.value.resolved_config,
    graph: plan.value.expanded_graph,
    runLayout: plan.value.layout,
    workflowName: "ultrafuzz-static-identity",
    renderedPrompts: plan.value.rendered_prompts
  });
  assert.equal(compiled.dynamicGroups.length, 0);
  return compiled;
}

function hydrateSerializedTask(source: string) {
  const literal = source.match(/const serializedTaskSpecs = ([\s\S]*?) as const;/u)?.[1];
  assert.ok(literal);
  const start = source.indexOf("function hydrateTaskSpec");
  const end = source.indexOf("\nlet taskSpecs =", start);
  assert.ok(start >= 0 && end > start);
  const helper = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  // Execute the actual compiler literal and hydration; only control-path
  // admission is stubbed because no sealed execution snapshot is needed here.
  return new Function(
    "path",
    "taskWorkflowControlPaths",
    "admittedWorkflowControls",
    "sealedTaskPromptPath",
    `const serializedTaskSpecs = ${literal}; ${helper}; return hydrateTaskSpec(serializedTaskSpecs[0]);`
  )(
    path,
    () => ({}),
    {},
    () => undefined
  ) as SmithersTaskManifestTask & { id: string; smithersRunId: string };
}

for (const mode of ["local", "cloud"] as const) {
  test(`serialized ${mode} tasks retain identities through hydration and durable attempt reconciliation`, async () => {
    const compiled = await compileStaticTask(mode);
    const task = hydrateSerializedTask(fs.readFileSync(compiled.workflowPath, "utf8"));
    const sealed = compiled.tasks[0];
    assert.ok(sealed);
    const profile = sealed.agentChain[0];
    assert.ok(profile);
    assert.equal(task.execution.mode, mode);
    assert.equal(task.smithersRunId, compiled.smithersRunId);
    assert.equal(task.smithersNodeId, sealed.smithersNodeId);
    assert.equal(task.id, task.smithersNodeId);
    assert.equal(task.logicalNodeId, sealed.logicalNodeId);
    const detail = {
      node: { nodeId: sealed.smithersNodeId, lastAttempt: 2 },
      attempts: [
        {
          nodeId: sealed.smithersNodeId,
          attempt: 2,
          state: "finished",
          meta: {
            agentChainIndex: 0,
            agentId: smithersTaskAgentId(sealed, 0),
            agentModel: profile.modelName ?? null
          }
        }
      ]
    };
    assert.equal(reconcileSmithersAttemptAgentSelection(task, detail, 2).chainIndex, 0);
    assert.throws(
      () => reconcileSmithersAttemptAgentSelection({ ...task, smithersNodeId: "node:wrong" }, detail, 2),
      /does not match sealed task/u
    );
  });
}
