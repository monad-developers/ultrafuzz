import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

import { temporaryRoot } from "./temporary-root.js";

const WORKFLOW_MODULE_ENVIRONMENT = [
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
] as const;

/**
 * Imports a rendered project workflow in this process and renders it for `dispatchInput`, from
 * `projectRoot`. Only the orchestration primitives are stubbed: components record the element tree,
 * and the project agent registry returns, for each of `agentRefs`, an inert agent whose `generate`
 * does nothing. Module-scope admission, task hydration, dispatch parsing, prompt reading, and
 * rendering run as rendered, against `artifactsModule` and `runtimeModule`, the way a native
 * `resume` runs a persisted workflow against the installed packages.
 */
export async function renderWorkflowInProcess(input: {
  workflowPath: string;
  projectRoot: string;
  dispatchInput: unknown;
  agentRefs: readonly string[];
  artifactsModule: string;
  runtimeModule: string;
}): Promise<unknown> {
  const stubs = temporaryRoot("ufz-in-process-workflow-stubs-");
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
  const agents = stub(
    "agents.mjs",
    `export const agentFactories = { ${[...new Set(input.agentRefs)].map((ref) => `${ref}: () => ({ id: "inert-agent", generate: async () => ({}) })`).join(", ")} };\n`
  );
  const program = ts
    .transpileModule(fs.readFileSync(input.workflowPath, "utf8"), {
      fileName: input.workflowPath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        jsxImportSource: "smthrs",
        verbatimModuleSyntax: true
      }
    })
    .outputText.replaceAll('"smthrs/jsx-runtime"', JSON.stringify(jsxRuntime))
    .replaceAll('"smthrs"', JSON.stringify(orchestrator))
    .replaceAll('"zod/v4"', JSON.stringify(import.meta.resolve("zod/v4")))
    .replaceAll('"../agents/index.ts"', JSON.stringify(agents));
  const programPath = path.join(path.dirname(input.workflowPath), `in-process-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(programPath, program, "utf8");

  const previousCwd = process.cwd();
  const previousEnvironment = WORKFLOW_MODULE_ENVIRONMENT.map((name) => [name, process.env[name]] as const);
  for (const name of WORKFLOW_MODULE_ENVIRONMENT) Reflect.deleteProperty(process.env, name);
  process.env.ULTRAFUZZ_ARTIFACTS_MODULE = input.artifactsModule;
  process.env.ULTRAFUZZ_RUNTIME_MODULE = input.runtimeModule;
  process.chdir(input.projectRoot);
  try {
    const workflow = (await import(pathToFileURL(programPath).href)) as {
      default: (ctx: { input: unknown; outputMaybe: () => undefined }) => unknown;
    };
    return workflow.default({ input: input.dispatchInput, outputMaybe: () => undefined });
  } finally {
    process.chdir(previousCwd);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

/** The components of a rendered element tree, in document order; every element must be a stubbed one. */
export function renderedComponents(root: unknown): Array<{ component: string; props: Record<string, unknown> }> {
  if (Array.isArray(root)) return root.flatMap(renderedComponents);
  if (root === null || typeof root !== "object") return [];
  const element = root as { type: unknown; props: Record<string, unknown> };
  const component = (element.type as { component?: unknown } | undefined)?.component;
  assert.equal(typeof component, "string", "the workflow rendered an element outside the stubbed components");
  return [{ component: component as string, props: element.props }, ...renderedComponents(element.props.children)];
}
