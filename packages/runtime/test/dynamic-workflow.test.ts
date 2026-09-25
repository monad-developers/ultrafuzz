import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import * as ts from "typescript";

import { initProject, materializeDynamicRuntime, planRun } from "../src/index.js";
import { compileSmithersWorkflow } from "../src/smithers.js";

function tempProject(): string {
  return temporaryRoot("ufz-dynamic-workflow-");
}

function writePrompt(project: string, relativePath: string, id: string, body: string): void {
  const promptPath = path.join(project, ".ultrafuzz", "prompts", relativePath);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, `---\nid: ${id}\ndisplay_name: ${id}\n---\n\n${body}\n`, "utf8");
}

/**
 * `excludableContextNode` adds a node that exists only so a run-scoped topology transform has
 * something real to exclude; the default graph stays exactly as the other tests expect it.
 */
function writeDynamicProject(project: string, options: { excludableContextNode?: boolean } = {}): void {
  initProject({ projectRoot: project, force: true });
  writePrompt(project, "dynamic/planner.md", "dynamic-planner", "Write the plan to {{artifact_path}}/plan.json.");
  if (options.excludableContextNode === true) {
    writePrompt(project, "dynamic/context.md", "dynamic-context", "Collect context into {{artifact_path}}/notes.json.");
  }
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    "Your /goal is {{item.goal_prompt}} using {{context:detail}}.\n{{finding_reachability_vocabulary}}\n{{finding_note_key_vocabulary}}"
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
${
  options.excludableContextNode === true
    ? `  - id: context
    kind: agentic
    prompt: dynamic/context.md
    depends_on: [__start__]
    outputs:
      - path: notes.json
        contract: ultrafuzz/goal-plan@1
        primary: true
`
    : ""
}  - id: planner
    kind: agentic
    prompt: dynamic/planner.md
    depends_on: [__start__]
    outputs:
      - path: plan.json
        contract: ultrafuzz/goal-plan@1
        primary: true
  - id: fanout
    kind: agentic
    prompt: dynamic/worker.md
    depends_on: [planner${options.excludableContextNode === true ? ", context" : ""}]
    dynamic:
      from:
        node: planner
        path: $.goals
      key: id
      node_id: "dynamic:item:{{ item.id }}"
    outputs:
      - path: findings.json
        contract: ultrafuzz/findings@2
        primary: true
  - id: join
    kind: agentic
    prompt: dynamic/join.md
    depends_on: [fanout${options.excludableContextNode === true ? ", context" : ""}]
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
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Ultrafuzz Test"]);
  git(["config", "user.email", "test@invalid"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "dynamic source"]);
  const sourceRevision = git(["rev-parse", "HEAD"]);
  const plan = await planRun({ projectRoot: project, runId: "dynamic-compile", env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.value!.source_revision, sourceRevision);
  assert.deepEqual(
    plan.value!.rendered_prompts.map((prompt) => prompt.logical_node_id),
    ["planner"]
  );

  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value!.resolved_config,
    graph: plan.value!.expanded_graph,
    runLayout: plan.value!.layout,
    sourceRevision: plan.value!.source_revision,
    sourceRef: plan.value!.source_ref,
    workflowName: "ultrafuzz-dynamic-compile",
    renderedPrompts: plan.value!.rendered_prompts
  });
  assert.equal(compiled.dynamicGroups.length, 1);
  assert.equal(compiled.sourceRevision, sourceRevision);
  assert.equal(compiled.sourceRef, plan.value!.source_ref);
  assert.ok(compiled.tasks.every((task) => task.sourceRevision === sourceRevision));
  assert.ok(compiled.tasks.every((task) => task.sourceRef === plan.value!.source_ref));
  assert.ok(compiled.dynamicGroups[0]!.taskTemplates.every((task) => task.sourceRevision === sourceRevision));
  assert.ok(compiled.dynamicGroups[0]!.taskTemplates.every((task) => task.sourceRef === plan.value!.source_ref));
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
  assert.match(source, /function taskSpecsFromCompiled[\s\S]*?\.\.\.compiledTaskSourceIdentity\(task\)/u);
  assert.match(source, /smithersRunId: controllerSettings\.smithers_run_id/u);
  assert.match(source, /smithersNodeId: task\.smithersNodeId/u);
  assert.match(source, /logicalNodeId: task\.logicalNodeId/u);
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

  const sourceArtifactPath = path.resolve(project, compiled.dynamicGroups[0]!.source.artifactPath);
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
  assert.ok(materialized.tasks.every((task) => task.sourceRevision === sourceRevision));
  assert.ok(materialized.tasks.every((task) => task.sourceRef === plan.value!.source_ref));

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
  writeDynamicProject(project, { excludableContextNode: true });
  // A run-scoped prompt transform drops every line referencing an excluded node's artifacts, so the
  // project bytes and the bytes the plan is bound to deliberately differ. `context` exists only to be
  // excluded: an empty exclusion list would leave the transform a no-op and prove nothing.
  const excludedLine = "Excluded context: {{artifact_path:context}}/notes.json";
  writePrompt(
    project,
    "dynamic/worker.md",
    "dynamic-worker",
    [
      "Your /goal is {{item.goal_prompt}} using {{context:detail}}.",
      "{{finding_reachability_vocabulary}}",
      "{{finding_note_key_vocabulary}}",
      excludedLine
    ].join("\n")
  );
  writePrompt(project, "dynamic/join.md", "dynamic-join", ["Summarize all completed work.", excludedLine].join("\n"));

  const plan = await planRun({
    projectRoot: project,
    runId: "dynamic-transform",
    topologyTransform: { excludedNodeIds: ["context"] },
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
    assert.equal(
      path.resolve(project, snapshotPath).startsWith(path.join(plan.value!.layout.root, "dynamic-prompt-templates")),
      true
    );
  }
  // Both snapshots carry the transformed bytes: the excluded reference is gone and the surviving body
  // is intact. Asserting only the path would pass even if a snapshot held the untransformed project
  // file, which is the substitution the run-scoped transform exists to prevent.
  const snapshots: Array<[string, string, string]> = [
    ["dynamic group", templatePath, "Your /goal is {{item.goal_prompt}}"],
    ["deferred join", deferredJoinTemplatePath, "Summarize all completed work"]
  ];
  for (const [label, snapshotPath, survivingBody] of snapshots) {
    const absoluteSnapshotPath = path.resolve(project, snapshotPath);
    const bytes = fs.readFileSync(absoluteSnapshotPath, "utf8");
    assert.doesNotMatch(bytes, /artifact_path:context/u, `${label} snapshot must hold the transformed bytes`);
    assert.match(bytes, new RegExp(survivingBody.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), label);
    assert.notEqual(
      bytes,
      fs.readFileSync(
        path.join(project, ".ultrafuzz", "prompts", "dynamic", label === "dynamic group" ? "worker.md" : "join.md"),
        "utf8"
      ),
      `${label} snapshot must differ from the untransformed project prompt`
    );
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
  assert.doesNotMatch(
    fs.readFileSync(path.resolve(project, recompiledJoinTemplate), "utf8"),
    /Divergent project bytes/u
  );
  assert.match(fs.readFileSync(path.resolve(project, recompiledJoinTemplate), "utf8"), /Summarize all completed work/u);
});
