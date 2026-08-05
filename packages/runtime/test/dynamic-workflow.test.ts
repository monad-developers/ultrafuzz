import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as ts from "typescript";

import { initProject, materializeDynamicRuntime, planRun } from "../src/index.js";
import { compileSmithersWorkflow } from "../src/smithers.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-dynamic-workflow-"));
}

function writePrompt(project: string, relativePath: string, id: string, body: string): void {
  const promptPath = path.join(project, ".ultrafuzz", "prompts", relativePath);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, `---\nid: ${id}\ndisplay_name: ${id}\n---\n\n${body}\n`, "utf8");
}

function writeDynamicProject(project: string): void {
  initProject({ projectRoot: project, force: true });
  writePrompt(project, "dynamic/planner.md", "dynamic-planner", "Write the plan to {{artifact_path}}/plan.json.");
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    "Your /goal is {{item.goal_prompt}} using {{context:detail}}."
  );
  writePrompt(project, "dynamic/join.md", "dynamic-join", "Summarize all completed work.");
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: planner
    kind: agentic
    prompt: dynamic/planner.md
    depends_on: [__start__]
    outputs:
      - path: plan.json
        contract: ultrafuzz/json-object@1
        primary: true
  - id: fanout
    kind: agentic
    prompt: dynamic/worker.md
    depends_on: [planner]
    dynamic:
      from:
        node: planner
        path: $.goals
      key: id
      node_id: "dynamic:item:{{ item.id }}"
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@1
        primary: true
  - id: join
    kind: agentic
    prompt: dynamic/join.md
    depends_on: [fanout]
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [join]
`,
    "utf8"
  );
}

test("compiled dynamic workflow defers templates and emits executable Smithers TypeScript", async () => {
  const project = tempProject();
  writeDynamicProject(project);
  const plan = await planRun({ projectRoot: project, runId: "dynamic-compile", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.deepEqual(
    plan.value!.rendered_prompts.map((prompt) => prompt.logical_node_id),
    ["planner"]
  );

  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-dynamic-compile",
    renderedPrompts: plan.value!.rendered_prompts
  });
  assert.equal(compiled.dynamicGroups.length, 1);
  assert.equal(compiled.dynamicGroups[0]?.groupNodeId, "fanout");
  assert.equal(compiled.dynamicGroups[0]?.taskTemplates.length, 1);
  assert.equal(
    compiled.tasks.some((task) => task.concreteNodeId === "fanout"),
    false
  );
  assert.deepEqual(compiled.tasks.find((task) => task.concreteNodeId === "join")?.dynamicDependencies, ["fanout"]);
  assert.deepEqual(compiled.tasks.find((task) => task.concreteNodeId === "join")?.deferredPromptGroups, ["fanout"]);

  const source = fs.readFileSync(compiled.workflowPath, "utf8");
  assert.doesNotMatch(source, /__ULTRAFUZZ_/u);
  assert.match(source, /materializeDynamicRuntime/u);
  assert.match(source, /ctx\.outputMaybe/u);
  const transpiled = ts.transpileModule(source, {
    fileName: compiled.workflowPath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: true
    }
  });
  const syntaxErrors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(
    syntaxErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    []
  );

  const sourceArtifactPath = compiled.dynamicGroups[0]!.source.artifactPath;
  fs.mkdirSync(path.dirname(sourceArtifactPath), { recursive: true });
  fs.writeFileSync(
    sourceArtifactPath,
    `${JSON.stringify({
      goals: Array.from({ length: 100 }, (_, index) => ({
        id: `threat-${index}`,
        goal_prompt: `find threat ${index}`,
        replacements: { "context:detail": `threat-model area ${index}` }
      }))
    })}\n`,
    "utf8"
  );
  const materialized = materializeDynamicRuntime({
    runId: plan.value!.run_id,
    projectRoot: project,
    runRoot: plan.value!.run_root,
    graphPath: path.join(plan.value!.run_root, "graph.json"),
    tasksPath: compiled.tasksPath,
    baseTasks: compiled.tasks,
    groups: compiled.dynamicGroups,
    readyGroupIds: ["fanout"]
  });
  assert.equal(materialized.tasks.filter((task) => task.metadata.node.dynamic !== undefined).length, 100);
  assert.equal(materialized.tasks.find((task) => task.concreteNodeId === "join")?.dependencies.length, 100);

  const smithersModules = findSmithersModules();
  if (smithersModules !== undefined && smithersGraphAvailable()) {
    fs.symlinkSync(smithersModules, path.join(project, ".smithers", "node_modules"), "dir");
    const graph = spawnSync(
      "smithers",
      [
        "graph",
        compiled.evidenceWorkflowPath,
        "--run-id",
        compiled.smithersRunId,
        "--root",
        project,
        "--input",
        fs.readFileSync(compiled.inputPath, "utf8"),
        "--compact",
        "--format",
        "json"
      ],
      {
        cwd: project,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, OPENAI_API_KEY: "test-openai-api-key" }
      }
    );
    assert.equal(graph.status, 0, `${graph.stderr}\n${graph.stdout}`);
    const parsed = JSON.parse(graph.stdout) as { tasks?: Array<{ nodeId?: string }> };
    const nodeIds =
      parsed.tasks?.map((task) => task.nodeId).filter((nodeId): nodeId is string => nodeId !== undefined) ?? [];
    assert.equal(nodeIds.includes("node:planner"), true);
    assert.equal(nodeIds.filter((nodeId) => /^node:dynamic-fanout-/u.test(nodeId)).length, 100);
    assert.equal(nodeIds.includes("node:join"), true);
  }
});

function smithersGraphAvailable(): boolean {
  return spawnSync("smithers", ["graph", "--help"], { stdio: "ignore" }).status === 0;
}

function findSmithersModules(): string | undefined {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, ".smithers", "node_modules");
    if (fs.existsSync(path.join(candidate, "smithers-orchestrator"))) return candidate;
    current = path.dirname(current);
  }
  return undefined;
}

test("compilation snapshots the exact transformed prompt body used during planning", async () => {
  const project = tempProject();
  writeDynamicProject(project);
  // A run-scoped prompt transform excludes an artifact reference, so the project bytes and the
  // bytes the plan is bound to deliberately differ.
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    [
      "Your /goal is {{item.goal_prompt}} using {{context:detail}}.",
      "Excluded planner context: {{artifact_path:planner}}/plan.json"
    ].join("\n")
  );
  writePrompt(
    project,
    "dynamic/join.md",
    "dynamic-join",
    ["Summarize all completed work.", "Excluded planner context: {{artifact_path:planner}}/plan.json"].join("\n")
  );

  const plan = await planRun({
    projectRoot: project,
    runId: "dynamic-transform",
    topologyTransform: { excludedNodeIds: [] },
    env: {}
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));

  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-dynamic-transform",
    renderedPrompts: plan.value!.rendered_prompts
  });

  const templatePath = compiled.dynamicGroups[0]!.templatePath;
  const deferredJoinTemplatePath = compiled.tasks.find((task) => task.concreteNodeId === "join")!.promptTemplatePath!;
  // Both deferred templates resolve to immutable run-root snapshots, never to the project file.
  for (const snapshotPath of [templatePath, deferredJoinTemplatePath]) {
    assert.equal(snapshotPath.startsWith(path.join(plan.value!.layout.root, "dynamic-prompt-templates")), true);
  }

  // Mutating the project prompt after planning must not change what compilation snapshots.
  writePrompt(project, "dynamic/join.md", "dynamic-join", "Divergent project bytes.");
  const recompiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    workflowName: "ultrafuzz-dynamic-transform",
    renderedPrompts: plan.value!.rendered_prompts
  });
  const recompiledJoinTemplate = recompiled.tasks.find((task) => task.concreteNodeId === "join")!.promptTemplatePath!;
  assert.equal(recompiledJoinTemplate, deferredJoinTemplatePath);
  assert.doesNotMatch(fs.readFileSync(recompiledJoinTemplate, "utf8"), /Divergent project bytes/u);
  assert.match(fs.readFileSync(recompiledJoinTemplate, "utf8"), /Summarize all completed work/u);
});
