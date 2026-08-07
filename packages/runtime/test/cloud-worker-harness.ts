import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

export interface RenderedElement {
  type: unknown;
  props: Record<string, unknown>;
}

export interface RenderedTask {
  component: string;
  id: string;
  props: Record<string, unknown>;
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
}): Promise<RenderedTask[]> {
  const source = fs.readFileSync(input.workflowPath, "utf8");
  const runtimeModule = /const runtimeModule = process\.env\.ULTRAFUZZ_RUNTIME_MODULE \?\? "([^"]+)"/u.exec(source);
  if (runtimeModule === null) throw new Error("generated workflow does not resolve a runtime module");
  const stubs = writeHarnessStubs(runtimeModule[1]!);

  const transpiled = ts.transpileModule(source, {
    fileName: input.workflowPath,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "smithers-orchestrator",
      verbatimModuleSyntax: true
    }
  });
  const rewritten = transpiled.outputText
    .replaceAll('"smithers-orchestrator/jsx-runtime"', JSON.stringify(stubs.jsxRuntime))
    .replaceAll('"smithers-orchestrator"', JSON.stringify(stubs.orchestrator))
    .replaceAll('"react"', JSON.stringify(stubs.react))
    .replaceAll('"zod/v4"', JSON.stringify(stubs.zod))
    .replaceAll('"../agents/index.ts"', JSON.stringify(stubs.agents));
  const harnessPath = path.join(path.dirname(input.workflowPath), `harness-${(harnessCounter += 1)}.mjs`);
  fs.writeFileSync(harnessPath, rewritten, "utf8");

  const previousCwd = process.cwd();
  const previousWorker = process.env.ULTRAFUZZ_CLOUD_WORKER;
  const previousRuntime = process.env.ULTRAFUZZ_RUNTIME_MODULE;
  process.chdir(input.cwd);
  if (input.workflowInput.cloud_worker === true) process.env.ULTRAFUZZ_CLOUD_WORKER = "1";
  if (input.forbidDynamicMaterialization === true) process.env.ULTRAFUZZ_RUNTIME_MODULE = stubs.runtimeGuard;
  try {
    const module = (await import(`${pathToFileURL(harnessPath).href}?harness=${harnessCounter}`)) as {
      default: (ctx: unknown) => RenderedElement;
    };
    return collectTasks(module.default({ input: input.workflowInput, outputMaybe: () => undefined }));
  } finally {
    process.chdir(previousCwd);
    restoreEnv("ULTRAFUZZ_CLOUD_WORKER", previousWorker);
    restoreEnv("ULTRAFUZZ_RUNTIME_MODULE", previousRuntime);
    fs.rmSync(harnessPath, { force: true });
  }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-workflow-harness-"));
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
        '    outputs: { task: { __output: "task" }, preparation: { __output: "preparation" }, verification: { __output: "verification" } }',
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
