import { createRequire } from "node:module";
import { temporaryRoot } from "./temporary-root.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import type { CompiledSmithersWorkflow } from "../src/smithers.js";

export interface RenderedElement {
  type: unknown;
  props: Record<string, unknown>;
}

export interface RenderedTask {
  component: string;
  id: string;
  props: Record<string, unknown>;
}

export interface HarnessTaskSpecSummary {
  id: string;
  attemptId: string;
  artifactDir: string;
  dependencyArtifactDirs: string[];
  referenceArtifactDirs: string[];
  logicalNodeId: string;
  modelProfileId: string;
  modelName: string | null;
  reasoningEffort: string | null;
  outputs: unknown[];
}

/** Builds the minimum faithful execution-snapshot layout needed by the in-process workflow harness. */
export function materializeHarnessWorkflowSnapshot(compiled: CompiledSmithersWorkflow): string {
  const snapshotRoot = path.join(compiled.runRoot, "smithers", "harness-execution-snapshot");
  const workflowPath = path.join(snapshotRoot, ".smithers", "workflows", path.basename(compiled.workflowPath));
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.copyFileSync(compiled.workflowPath, workflowPath);
  fs.copyFileSync(compiled.controllerDataPath, `${workflowPath}.data.json`);
  const agentsRoot = path.join(snapshotRoot, ".smithers", "agents");
  fs.mkdirSync(agentsRoot, { recursive: true });
  for (const name of ["resource-limit.ts", "worker-resource-guard.ts"]) {
    fs.copyFileSync(path.join(compiled.projectRoot, ".smithers", "agents", name), path.join(agentsRoot, name));
  }
  const dependencies = path.join(snapshotRoot, "dependencies", "manifest.json");
  const controls = path.join(snapshotRoot, "controls");
  fs.mkdirSync(path.dirname(dependencies), { recursive: true });
  fs.mkdirSync(path.join(controls, "rendered-prompts"), { recursive: true });
  fs.writeFileSync(dependencies, "{}\n", "utf8");
  fs.writeFileSync(path.join(controls, "plan.json"), "{}\n", "utf8");
  fs.copyFileSync(path.join(compiled.runRoot, "graph.json"), path.join(controls, "runtime-base-graph.json"));
  fs.copyFileSync(compiled.tasksPath, path.join(controls, "runtime-base-tasks.json"));
  for (const task of compiled.tasks) {
    if (task.renderedPromptPath === undefined) continue;
    fs.copyFileSync(task.renderedPromptPath, path.join(controls, "rendered-prompts", `${task.attemptId}.md`));
  }
  return workflowPath;
}

let harnessCounter = 0;

/**
 * Executes a generated Smithers workflow in-process.
 *
 * The generated workflow is real product code that decides which concrete attempt a cloud worker
 * runs, so relocation and handoff behaviour must be exercised rather than asserted against source
 * text. Only the orchestration primitives are stubbed: `createSmithers` and the JSX runtime record
 * the rendered element tree, and the project agent registry returns inert agents. Everything else --
 * task selection, path hydration, prompt reading and relocation, and the artifact/runtime module
 * imports -- runs unmodified.
 */
export async function renderGeneratedWorkflow(input: {
  workflowPath: string;
  cwd: string;
  workflowInput: Record<string, unknown>;
  /** Fails the render if the workflow reaches controller-owned dynamic materialization. */
  forbidDynamicMaterialization?: boolean;
  /** Receives the task-spec inventory after the workflow has applied cloud-worker narrowing. */
  captureTaskSpecs?: HarnessTaskSpecSummary[];
  /** Simulates previously durable Smithers outputs for dependency-gated controller renders. */
  allOutputsAvailable?: boolean;
}): Promise<RenderedTask[]> {
  const source = fs.readFileSync(input.workflowPath, "utf8");
  // #779 rooted the module fallbacks in the workflow's own snapshot: the template now renders
  // `new URL("<relative>", import.meta.url).href` instead of an absolute string literal, so the
  // harness reconstructs the same href by resolving that relative path against the workflow file.
  const runtimeModule =
    /const runtimeModule =\s*process\.env\.ULTRAFUZZ_RUNTIME_MODULE \?\?\s*new URL\("([^"]+)", import\.meta\.url\)\.href;/u.exec(
      source
    );
  if (runtimeModule === null) throw new Error("generated workflow does not resolve a runtime module");
  // Fixture snapshots do not materialize the modules/ tree the fallback points into; the harness
  // supplies the workspace's real modules through the template's primary path, the environment
  // overrides, exactly as a controller that forwards its environment does.
  const harnessRequire = createRequire(import.meta.url);
  const realRuntimeModuleHref = pathToFileURL(
    path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "dist", "index.js")
  ).href;
  const realArtifactsModuleHref = pathToFileURL(harnessRequire.resolve("@ultrafuzz/artifacts")).href;
  const realModalModuleHref = pathToFileURL(
    path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "modal", "dist", "index.js")
  ).href;
  const stubs = writeHarnessStubs(realRuntimeModuleHref);

  const transpiled = ts.transpileModule(source, {
    fileName: input.workflowPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "smthrs",
      verbatimModuleSyntax: true
    }
  });
  const productSource = transpiled.outputText
    .replaceAll('"smthrs/jsx-runtime"', JSON.stringify(stubs.jsxRuntime))
    .replaceAll('"smthrs"', JSON.stringify(stubs.orchestrator))
    .replaceAll('"smithers-orchestrator/jsx-runtime"', JSON.stringify(stubs.jsxRuntime))
    .replaceAll('"smithers-orchestrator"', JSON.stringify(stubs.orchestrator))
    .replaceAll('"react"', JSON.stringify(stubs.react))
    .replaceAll('"zod/v4"', JSON.stringify(stubs.zod))
    .replaceAll('"../agents/index.ts"', JSON.stringify(stubs.agents))
    // The harness executes a transpiled sibling, while production executes the admitted workflow
    // itself. Preserve the product workflow's identity so the persisted-path equality check is real
    // rather than comparing the temporary harness filename.
    .replace(
      "const loadedWorkflowPath = fileURLToPath(import.meta.url);",
      `const loadedWorkflowPath = ${JSON.stringify(path.resolve(input.workflowPath))};`
    );
  const rewritten = `${productSource}\nexport function __ultrafuzzHarnessTaskSpecs() {
  return taskSpecs.map((task) => ({
    id: task.id,
    attemptId: task.attemptId,
    artifactDir: task.artifactDir,
    dependencyArtifactDirs: [...task.dependencyArtifactDirs],
    referenceArtifactDirs: [...task.referenceArtifactDirs],
    logicalNodeId: task.metadata.node.logicalNodeId,
    modelProfileId: task.metadata.model.profileId,
    modelName: task.modelName ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
    outputs: task.outputs
  }));
}\n`;
  const harnessPath = path.join(path.dirname(input.workflowPath), `harness-${(harnessCounter += 1)}.mjs`);
  fs.writeFileSync(harnessPath, rewritten, "utf8");

  const previousCwd = process.cwd();
  const previousWorker = process.env.ULTRAFUZZ_CLOUD_WORKER;
  const previousRuntime = process.env.ULTRAFUZZ_RUNTIME_MODULE;
  const previousArtifacts = process.env.ULTRAFUZZ_ARTIFACTS_MODULE;
  const previousModal = process.env.ULTRAFUZZ_MODAL_MODULE;
  const previousPersistedWorkflow = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH;
  process.chdir(input.cwd);
  if (input.workflowInput.cloud_worker === true) process.env.ULTRAFUZZ_CLOUD_WORKER = "1";
  process.env.ULTRAFUZZ_RUNTIME_MODULE =
    input.forbidDynamicMaterialization === true ? stubs.runtimeGuard : realRuntimeModuleHref;
  process.env.ULTRAFUZZ_ARTIFACTS_MODULE = realArtifactsModuleHref;
  process.env.ULTRAFUZZ_MODAL_MODULE = realModalModuleHref;
  if (isHarnessExecutionSnapshotWorkflow(input.workflowPath)) {
    process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = input.workflowPath;
  }
  try {
    const module = (await import(`${pathToFileURL(harnessPath).href}?harness=${harnessCounter}`)) as {
      default: (ctx: unknown) => RenderedElement;
      __ultrafuzzHarnessTaskSpecs: () => HarnessTaskSpecSummary[];
    };
    const rendered = module.default({
      input: input.workflowInput,
      outputMaybe: () =>
        input.allOutputsAvailable === true
          ? {
              verification_marker_sha256: "a".repeat(64),
              verification_marker_size_bytes: 1,
              artifacts: [],
              primary_artifact: "fixture"
            }
          : undefined
    });
    input.captureTaskSpecs?.push(...module.__ultrafuzzHarnessTaskSpecs());
    return collectTasks(rendered);
  } finally {
    process.chdir(previousCwd);
    restoreEnv("ULTRAFUZZ_CLOUD_WORKER", previousWorker);
    restoreEnv("ULTRAFUZZ_RUNTIME_MODULE", previousRuntime);
    restoreEnv("ULTRAFUZZ_ARTIFACTS_MODULE", previousArtifacts);
    restoreEnv("ULTRAFUZZ_MODAL_MODULE", previousModal);
    restoreEnv("ULTRAFUZZ_WORKFLOW_PERSISTED_PATH", previousPersistedWorkflow);
    fs.rmSync(harnessPath, { force: true });
  }
}

function isHarnessExecutionSnapshotWorkflow(workflowPath: string): boolean {
  const snapshotRoot = path.dirname(path.dirname(path.dirname(path.resolve(workflowPath))));
  return (
    fs.existsSync(path.join(snapshotRoot, "dependencies", "manifest.json")) &&
    fs.existsSync(path.join(snapshotRoot, "controls", "plan.json"))
  );
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function collectTasks(root: unknown): RenderedTask[] {
  const collected: RenderedTask[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const element = node as RenderedElement;
    const component = componentName(element.type);
    const props = element.props ?? {};
    if (component !== undefined && typeof props.id === "string") {
      collected.push({ component, id: props.id, props });
    }
    visit(props.children);
  };
  visit(root);
  return collected;
}

function componentName(type: unknown): string | undefined {
  return type !== null &&
    typeof type === "object" &&
    typeof (type as { __component?: unknown }).__component === "string"
    ? (type as { __component: string }).__component
    : undefined;
}

function writeHarnessStubs(runtimeModuleUrl: string): {
  jsxRuntime: string;
  orchestrator: string;
  react: string;
  zod: string;
  agents: string;
  runtimeGuard: string;
} {
  const root = temporaryRoot("ufz-workflow-harness-");
  const write = (name: string, contents: string): string => {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, contents, "utf8");
    return pathToFileURL(filePath).href;
  };
  return {
    jsxRuntime: write(
      "jsx-runtime.mjs",
      [
        'export const Fragment = { __component: "Fragment" };',
        "export function jsx(type, props, key) {",
        "  return { type, props: props ?? {}, key };",
        "}",
        "export const jsxs = jsx;",
        "export const jsxDEV = jsx;",
        ""
      ].join("\n")
    ),
    orchestrator: write(
      "smithers-orchestrator.mjs",
      [
        "const component = (name) => ({ __component: name });",
        "export function createSmithers() {",
        "  return {",
        '    Workflow: component("Workflow"),',
        '    Task: component("Task"),',
        '    Worktree: component("Worktree"),',
        '    Parallel: component("Parallel"),',
        '    Sandbox: component("Sandbox"),',
        "    smithers: (definition) => definition,",
        '    outputs: { agentProcess: { __output: "agentProcess" }, preparation: { __output: "preparation" }, verification: { __output: "verification" } }',
        "  };",
        "}",
        ""
      ].join("\n")
    ),
    react: write("react.mjs", 'export const Fragment = { __component: "Fragment" };\n'),
    zod: write("zod.mjs", `export * from ${JSON.stringify(zodEsmUrl())};\n`),
    agents: write(
      "agents.mjs",
      [
        'const agent = { name: "harness-agent" };',
        "export const CodexAgent = agent;",
        "export const ClaudeAgent = agent;",
        "export const agentFactories = { CodexAgent: () => agent, ClaudeAgent: () => agent };",
        ""
      ].join("\n")
    ),
    runtimeGuard: write(
      "runtime-guard.mjs",
      [
        `export * from ${JSON.stringify(runtimeModuleUrl)};`,
        "export function materializeDynamicRuntime() {",
        '  throw new Error("cloud worker reached controller-owned dynamic materialization");',
        "}",
        ""
      ].join("\n")
    )
  };
}

function zodEsmUrl(): string {
  // zod is a transitive dependency through @ultrafuzz/artifacts, so resolve it from there.
  const artifactsEntry = fileURLToPath(import.meta.resolve("@ultrafuzz/artifacts"));
  const cjs = createRequire(artifactsEntry).resolve("zod/v4");
  const esm = cjs.replace(/\.cjs$/u, ".js");
  if (!fs.existsSync(esm)) throw new Error(`unable to locate the zod ESM entry next to ${cjs}`);
  return pathToFileURL(esm).href;
}
