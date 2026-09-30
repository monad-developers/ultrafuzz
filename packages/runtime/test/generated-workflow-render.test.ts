import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initProject, planRun } from "../src/index.js";
import { compileSmithersWorkflow, type CompiledSmithersWorkflow } from "../src/smithers.js";
import { renderedComponents, renderWorkflowInProcess } from "./in-process-workflow.js";
import { temporaryRoot } from "./temporary-root.js";

async function compileTwoNodeWorkflow(): Promise<CompiledSmithersWorkflow> {
  const projectRoot = temporaryRoot("ufz-workflow-render-");
  initProject({ projectRoot, force: true });
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "prompts", "render.md"),
    "---\nid: render\ndisplay_name: Render\n---\nWrite {{artifact_path}}/report.md.\n"
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
  - id: discovery
    kind: agentic
    prompt: render.md
    depends_on: [__start__]
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: review
    kind: agentic
    prompt: render.md
    depends_on: [discovery]
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on: [review]
`
  );
  const plan = await planRun({ projectRoot, runId: "workflow-render", env: {} });
  assert.ok(plan.value, JSON.stringify(plan.diagnostics));
  return compileSmithersWorkflow({
    projectRoot,
    config: plan.value.resolved_config,
    graph: plan.value.expanded_graph,
    runLayout: plan.value.layout,
    workflowName: "ultrafuzz-workflow-render",
    renderedPrompts: plan.value.rendered_prompts
  });
}

test("a compiled local workflow renders in process into one worktree of prepare, agent, and verify tasks per attempt", async () => {
  const compiled = await compileTwoNodeWorkflow();
  // The generated workflow renders for its own compiled dispatch input, against the built runtime and
  // artifacts modules.
  const rendered = renderedComponents(
    await renderWorkflowInProcess({
      workflowPath: compiled.workflowPath,
      projectRoot: compiled.projectRoot,
      dispatchInput: JSON.parse(fs.readFileSync(compiled.inputPath, "utf8")) as unknown,
      agentRefs: compiled.tasks.flatMap((task) => task.agentChain.map((entry) => entry.agentRef)),
      artifactsModule: import.meta.resolve("@ultrafuzz/artifacts"),
      runtimeModule: new URL("../../dist/index.js", import.meta.url).href
    })
  );

  assert.deepEqual(
    rendered.filter((entry) => entry.component !== "Task").map((entry) => entry.component),
    ["Workflow", "Parallel", "Worktree", "Worktree"]
  );
  const tasks = new Map(
    rendered.filter((entry) => entry.component === "Task").map((entry) => [entry.props.id as string, entry.props])
  );
  assert.deepEqual(
    [...tasks.keys()].sort(),
    compiled.tasks
      .flatMap((task) => [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId])
      .sort()
  );
  const discovery = compiled.tasks.find((task) => task.logicalNodeId === "discovery");
  const review = compiled.tasks.find((task) => task.logicalNodeId === "review");
  assert.ok(discovery && review);
  // Each attempt's agent runs after its own preparation, and its verifier after the agent; a
  // dependent attempt's preparation waits for the verified dependency.
  assert.deepEqual(tasks.get(discovery.smithersNodeId)?.dependsOn, [discovery.preparationSmithersNodeId]);
  assert.deepEqual(tasks.get(discovery.verifierSmithersNodeId)?.dependsOn, [discovery.smithersNodeId]);
  assert.deepEqual(tasks.get(review.preparationSmithersNodeId)?.dependsOn, [discovery.verifierSmithersNodeId]);
  assert.match(String(tasks.get(review.smithersNodeId)?.children), /report\.md/u);
});
