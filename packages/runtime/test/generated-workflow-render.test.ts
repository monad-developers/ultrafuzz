import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

import { initProject, planRun } from "../src/index.js";
import { compileSmithersWorkflow, type CompiledSmithersWorkflow } from "../src/smithers.js";
import { temporaryRoot } from "./temporary-root.js";

interface RenderedElement {
  type: unknown;
  props: Record<string, unknown>;
}

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

/**
 * Imports the generated workflow in process and renders it for its own compiled dispatch input.
 * Only the orchestration primitives are stubbed: components record the element tree, and the
 * project agent registry returns inert agents. Module-scope admission, task hydration, dispatch
 * parsing, prompt reading, and rendering run as generated, against the built runtime and
 * artifacts modules.
 */
async function renderGeneratedWorkflow(compiled: CompiledSmithersWorkflow): Promise<RenderedElement> {
  const stubs = temporaryRoot("ufz-workflow-render-stubs-");
  const stub = (name: string, contents: string): string => {
    fs.writeFileSync(path.join(stubs, name), contents, "utf8");
    return pathToFileURL(path.join(stubs, name)).href;
  };
  const jsxRuntime = stub(
    "jsx-runtime.mjs",
    "export const jsx = (type, props) => ({ type, props: props ?? {} });\nexport const jsxs = jsx;\n"
  );
  const orchestrator = stub(
    "smthrs.mjs",
    `const component = (name) => ({ component: name });
export function createSmithers() {
  return {
    Workflow: component("Workflow"),
    Parallel: component("Parallel"),
    Worktree: component("Worktree"),
    Task: component("Task"),
    smithers: (render) => render,
    outputs: { agentProcess: {}, preparation: {}, verification: {} }
  };
}
`
  );
  const agentRefs = [...new Set(compiled.tasks.flatMap((task) => task.agentChain.map((entry) => entry.agentRef)))];
  const agents = stub(
    "agents.mjs",
    `export const agentFactories = { ${agentRefs.map((ref) => `${ref}: () => ({ id: "inert-agent" })`).join(", ")} };\n`
  );
  const transpiled = ts.transpileModule(fs.readFileSync(compiled.workflowPath, "utf8"), {
    fileName: compiled.workflowPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "smthrs",
      verbatimModuleSyntax: true
    }
  }).outputText;
  const program = transpiled
    .replaceAll('"smthrs/jsx-runtime"', JSON.stringify(jsxRuntime))
    .replaceAll('"smthrs"', JSON.stringify(orchestrator))
    .replaceAll('"zod/v4"', JSON.stringify(import.meta.resolve("zod/v4")))
    .replaceAll('"../agents/index.ts"', JSON.stringify(agents));
  const programPath = path.join(path.dirname(compiled.workflowPath), "render-harness.mjs");
  fs.writeFileSync(programPath, program, "utf8");

  const previousCwd = process.cwd();
  const previousArtifactsModule = process.env.ULTRAFUZZ_ARTIFACTS_MODULE;
  const previousRuntimeModule = process.env.ULTRAFUZZ_RUNTIME_MODULE;
  process.env.ULTRAFUZZ_ARTIFACTS_MODULE = import.meta.resolve("@ultrafuzz/artifacts");
  process.env.ULTRAFUZZ_RUNTIME_MODULE = new URL("../../dist/index.js", import.meta.url).href;
  process.chdir(compiled.projectRoot);
  try {
    const workflow = (await import(pathToFileURL(programPath).href)) as {
      default: (ctx: { input: unknown; outputMaybe: () => undefined }) => RenderedElement;
    };
    return workflow.default({
      input: JSON.parse(fs.readFileSync(compiled.inputPath, "utf8")) as unknown,
      outputMaybe: () => undefined
    });
  } finally {
    process.chdir(previousCwd);
    if (previousArtifactsModule === undefined) delete process.env.ULTRAFUZZ_ARTIFACTS_MODULE;
    else process.env.ULTRAFUZZ_ARTIFACTS_MODULE = previousArtifactsModule;
    if (previousRuntimeModule === undefined) delete process.env.ULTRAFUZZ_RUNTIME_MODULE;
    else process.env.ULTRAFUZZ_RUNTIME_MODULE = previousRuntimeModule;
  }
}

function renderedComponents(root: unknown): Array<{ component: string; props: Record<string, unknown> }> {
  if (Array.isArray(root)) return root.flatMap(renderedComponents);
  if (root === null || typeof root !== "object") return [];
  const element = root as RenderedElement;
  const component = (element.type as { component?: unknown } | undefined)?.component;
  assert.equal(typeof component, "string", "the workflow rendered an element outside the stubbed components");
  return [{ component: component as string, props: element.props }, ...renderedComponents(element.props.children)];
}

test("a compiled local workflow renders in process into one worktree of prepare, agent, and verify tasks per attempt", async () => {
  const compiled = await compileTwoNodeWorkflow();
  const rendered = renderedComponents(await renderGeneratedWorkflow(compiled));

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
