import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadReferenceCatalog } from "@ultrafuzz/references";

import { compileSmithersWorkflow, initProject, planRun } from "../src/index.js";
import { writeShippedDocumentReferenceCaches, writeShippedVulnerabilityDatabaseCache } from "./reference-fixtures.js";
import { temporaryRoot } from "./temporary-root.js";

/**
 * Every Smithers engine process parses and transpiles the whole generated workflow (#1146). With a
 * fixed-length project root the packaged default topology compiles to about 2.06-2.07 MB (the exact
 * size varies between environments), 1.59 MB of it the same 65 tasks serialized twice (as compiled
 * tasks and as task specs). Raise this only deliberately: #1146 asks for the file to shrink.
 */
const GENERATED_DEFAULT_WORKFLOW_BUDGET_BYTES = 2_300_000;

test("the packaged default topology compiles to a generated workflow under its byte budget", async () => {
  const project = temporaryRoot("ufz-footprint-");
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const xdgCacheHome = path.join(project, "xdg-cache");
  writeShippedDocumentReferenceCaches(xdgCacheHome, loadReferenceCatalog(project));
  writeShippedVulnerabilityDatabaseCache(xdgCacheHome);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = xdgCacheHome;
  let plan: Awaited<ReturnType<typeof planRun>>;
  try {
    plan = await planRun({ projectRoot: project, runId: "footprint", env: {} });
  } finally {
    if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
  }
  assert.ok(plan.ok && plan.value, JSON.stringify(plan.diagnostics));
  const compiled = compileSmithersWorkflow({
    projectRoot: project,
    config: plan.value.resolved_config,
    graph: plan.value.expanded_graph,
    runLayout: plan.value.layout,
    workflowName: "ultrafuzz-footprint",
    renderedPrompts: plan.value.rendered_prompts
  });

  // The absolute project root appears thousands of times, so measure with a fixed-length root.
  // Otherwise the budget would depend on how long the machine's temporary directory path is.
  const source = fs.readFileSync(compiled.workflowPath, "utf8");
  const bytes = Buffer.byteLength(source.replaceAll(project, "/project"));
  assert.ok(
    bytes <= GENERATED_DEFAULT_WORKFLOW_BUDGET_BYTES,
    `generated default workflow is ${bytes} bytes, over its ${GENERATED_DEFAULT_WORKFLOW_BUDGET_BYTES}-byte budget`
  );
});

test("importing the runtime package does not load the TypeScript compiler", () => {
  // Every ultrafuzz CLI process, including each agent's validator call, imports this package's index.
  // (Engine processes load TypeScript through smthrs regardless.) Run the import in a fresh process so
  // this test file's own TypeScript import cannot mask it.
  const project = temporaryRoot("ufz-footprint-registry-");
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const runtimeIndex = new URL("../src/index.js", import.meta.url).href;
  const agentRegistry = new URL("../src/agent-registry.js", import.meta.url).href;
  const probe = `
    import { createRequire } from "node:module";
    await import(${JSON.stringify(runtimeIndex)});
    const require = createRequire(${JSON.stringify(runtimeIndex)});
    const compiler = require.resolve("typescript");
    const afterImport = compiler in require.cache;
    const registry = await import(${JSON.stringify(agentRegistry)});
    const inspection = registry.inspectAgentRegistry(${JSON.stringify(project)});
    console.log(JSON.stringify({
      afterImport,
      afterInspection: compiler in require.cache,
      registersCodex: registry.agentRegistryRegisters(inspection, "CodexAgent")
    }));
  `;
  const observed = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", probe], { encoding: "utf8" })
  ) as { afterImport: boolean; afterInspection: boolean; registersCodex: boolean };
  assert.deepEqual(observed, { afterImport: false, afterInspection: true, registersCodex: true });
});
