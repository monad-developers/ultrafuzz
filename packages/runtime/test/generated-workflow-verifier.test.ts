import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as ts from "typescript";

import {
  assertArtifactPublicationsContainNoSecrets,
  assertRegularFileInside,
  executeSchemaSemanticGates,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILES,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES,
  normalizeNodeAttemptFailureMessage,
  parseStrictJsonBytes,
  prepareSafeFilePath,
  PROPERTIES_SCHEMA_VERSION,
  publishFileDurableExclusive,
  readRegularFileSnapshot,
  validateArtifactContract,
  validateArtifactContractBytes,
  validatePropertiesSchema,
  writeFileDurable,
  type InvariantLedgerArtifact,
  type PropertiesArtifact
} from "@ultrafuzz/artifacts";
import {
  canonicalPropertiesMarkdownParityIssues,
  invariantLedgerMarkdownParityIssues
} from "../src/canonical-properties-markdown.js";
import { declaredAncestorOutputsByContract } from "../src/semantic-artifact-context.js";

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function generatedTestEntry(
  entryPath: string,
  contents: string | Buffer
): {
  path: string;
  size_bytes: number;
  sha256: string;
} {
  return {
    path: entryPath,
    size_bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex")
  };
}

function loadGeneratedWorkflowInputSchema(): { safeParse(value: unknown): { success: boolean } } {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const schemaStart = source.indexOf("const inputTaskSchema");
  const schemaEnd = source.indexOf("\n\nconst taskOutput", schemaStart);
  assert.ok(schemaStart >= 0, source);
  assert.ok(schemaEnd > schemaStart, source);
  const schemaSource = source
    .slice(schemaStart, schemaEnd)
    .replaceAll("__ULTRAFUZZ_RUN_ID_LITERAL__", JSON.stringify("run-1"));
  const compiled = ts.transpileModule(schemaSource, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const require = createRequire(import.meta.url);
  const smithersRoot = packageRootForEntry(require.resolve("smthrs"));
  const z = (createRequire(path.join(smithersRoot, "package.json"))("zod/v4") as { z: unknown }).z;
  return new Function("z", `${compiled}; return inputSchema;`)(z) as ReturnType<
    typeof loadGeneratedWorkflowInputSchema
  >;
}

test("generated workflow input is an exact current-only envelope with bounded JSON operator data", () => {
  const inputSchema = loadGeneratedWorkflowInputSchema();
  const local = {
    schema_version: "ultrafuzz.smithers.workflow.v4",
    ultrafuzz_run_id: "run-1",
    tasks: [{ id: "node:one", prompt_path: ".ultrafuzz/prompts/one.md" }],
    operator_prompt: "focus",
    operator_input: { tickets: [1, true, null, "three"] }
  };
  assert.equal(inputSchema.safeParse(local).success, true);
  assert.equal(
    inputSchema.safeParse({ cloud_worker: true, task_id: "node:one", operator_prompt: "focus" }).success,
    true
  );

  for (const invalid of [
    { ...local, unexpected: true },
    { ...local, schema_version: "ultrafuzz.smithers.workflow.v1" },
    { ...local, ultrafuzz_run_id: "foreign-run" },
    { ...local, run_id: local.ultrafuzz_run_id },
    { schema_version: local.schema_version, ultrafuzz_run_id: local.ultrafuzz_run_id },
    { ...local, tasks: [{ ...local.tasks[0], extra: true }] },
    { cloud_worker: true, task_id: "node:one", tasks: [] },
    { cloud_worker: false, task_id: "node:one" }
  ]) {
    assert.equal(inputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  }

  let tooDeep: unknown = null;
  for (let depth = 0; depth <= 128; depth += 1) tooDeep = [tooDeep];
  assert.equal(inputSchema.safeParse({ ...local, operator_input: tooDeep }).success, false);

  const template = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(template, /z\.looseObject|\.default\(|z\.unknown\(\)/u);
  assert.match(template, /const inputSchema = z\n {2}\.strictObject\(\{/u);
});

test("generated prompt sources reject one byte over before reading or concatenating", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-prompt-budget-"));
  try {
    const promptPath = path.join(root, "prompt.md");
    fs.writeFileSync(promptPath, "12345", "utf8");
    let reads = 0;
    const exhaustions: unknown[][] = [];
    const harness = loadPromptBudgetHarness({
      onRead: () => (reads += 1),
      onExhaustion: (details) => {
        exhaustions.push(details);
        return new Error("ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED");
      }
    });
    const task = {
      prompt: "",
      promptPath,
      artifactDir: root,
      sourceProjectRoot: process.cwd(),
      resourceBudget: { maxAttemptContextBytes: 5 }
    };

    assert.equal(harness.promptForTask(task), "12345");
    assert.equal(reads, 1);
    assert.equal(harness.boundedFullTaskPrompt(task, ["12", "345"]), "12345");

    fs.writeFileSync(promptPath, "123456", "utf8");
    assert.throws(() => harness.promptForTask(task), /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED/u);
    assert.equal(reads, 1, "oversized prompt must fail before its bounded reader is called");
    assert.throws(() => harness.boundedFullTaskPrompt(task, ["123", "456"]), /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED/u);
    assert.deepEqual(
      exhaustions.map((details) => details.slice(1)),
      [
        ["context_bytes", "attempt", 5, 6],
        ["context_bytes", "attempt", 5, 6]
      ]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the workflow runner can project the generated workflow input into its input table", async () => {
  // The runner tables this schema by walking `shape` while it creates the
  // workflow, so a shapeless schema such as a union fails preflight on every
  // detached submission instead of failing any test.
  const inputSchema = loadGeneratedWorkflowInputSchema();
  const require = createRequire(import.meta.url);
  // The runner's own entry is Bun-only; its table projection is not.
  const runnerRequire = createRequire(require.resolve("smthrs"));
  const { zodToTable } = (await import(pathToFileURL(runnerRequire.resolve("@smthrs/db/zodToTable")).href)) as {
    zodToTable: (tableName: string, schema: unknown, opts?: { isInput?: boolean }) => unknown;
  };
  assert.notEqual(zodToTable("ultrafuzz_workflow_input", inputSchema, { isInput: true }), undefined);
});

function loadArtifactAwareAgent(
  options: {
    onReset?: () => void;
    onBudgetEvidence?: (filePath: string, contents: string) => void;
    persistedBudgetStates?: Map<string, string>;
  } = {}
): (
  task: unknown,
  chainIndex: number,
  originalPrompt: string,
  agent: { generate(args: unknown): Promise<unknown> }
) => { generate(args: unknown): Promise<unknown> } {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("type BudgetCounter");
  const helperEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const persistedBudgetStates = options.persistedBudgetStates ?? new Map<string, string>();
  return new Function(
    "resetTaskArtifactsForRetry",
    "authoritativeFinalReportCoverageArgs",
    "authoritativeFinalReportAgentExecutionArgs",
    "rememberFinalReportAgentExecutionAuthority",
    "finalReportAgentExecution",
    "declaredFinalReportOutputPair",
    "smithersTaskAgentId",
    "writeFileDurable",
    "prepareSafeFilePath",
    "createHash",
    "mkdirSync",
    "realpathSync",
    "readdirSync",
    "readRegularFileSnapshot",
    "parseStrictJsonBytes",
    "path",
    `${helper}; return artifactAwareAgent;`
  )(
    () => options.onReset?.(),
    (_task: unknown, args: unknown) => args,
    (_task: unknown, args: unknown) => args,
    () => undefined,
    () => ({ planned_chain: [], failed_attempts: [], producer: {} }),
    () => undefined,
    () => "ultrafuzz-agent:test",
    (filePath: string, contents: string) => {
      if (path.basename(filePath) === "resource-budget-exhausted.json") {
        options.onBudgetEvidence?.(filePath, contents);
      } else {
        persistedBudgetStates.set(filePath, contents);
      }
    },
    prepareSafeFilePath,
    createHash,
    () => undefined,
    (filePath: string) => filePath,
    (directory: string) =>
      [...persistedBudgetStates.keys()]
        .filter((filePath) => path.dirname(filePath) === directory)
        .map((filePath) => path.basename(filePath)),
    (filePath: string, maxBytes: number) => {
      const contents = persistedBudgetStates.get(filePath);
      if (contents === undefined) throw new Error(`missing persisted budget state ${filePath}`);
      const bytes = Buffer.from(contents, "utf8");
      if (bytes.length > maxBytes) throw new Error("persisted budget state exceeds test read bound");
      return bytes;
    },
    parseStrictJsonBytes,
    path
  ) as ReturnType<typeof loadArtifactAwareAgent>;
}

function loadPromptBudgetHarness(options: { onExhaustion?: (details: unknown[]) => Error; onRead?: () => void } = {}): {
  promptForTask: (task: unknown, inputTask?: { prompt?: string; prompt_path?: string }) => string;
  boundedFullTaskPrompt: (task: unknown, parts: readonly string[]) => string;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function boundedPromptText");
  const helperEnd = source.indexOf("\n\nfunction verifiedDependencyJsonArtifact", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "resourceBudgetExhaustionError",
    "readRegularFileSnapshot",
    "lstatSync",
    "mirroredArtifactDir",
    "path",
    `${helper}; return { promptForTask, boundedFullTaskPrompt };`
  )(
    (...details: unknown[]) => options.onExhaustion?.(details) ?? new Error("resource budget exhausted"),
    (filePath: string, maxBytes: number) => {
      options.onRead?.();
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("bounded read rejected");
      return fs.readFileSync(filePath);
    },
    fs.lstatSync,
    (task: { artifactDir: string }) => task.artifactDir,
    path
  ) as ReturnType<typeof loadPromptBudgetHarness>;
}

function loadFinalReportAgentExecution(): (
  task: unknown,
  producerChainIndex: number,
  observedSelections?: ReadonlyArray<{ attempt: number; chainIndex: number }>
) => unknown {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function finalReportAgentExecution");
  const helperEnd = source.indexOf("\n\nfunction promptWithAuthoritativeFinalReportAgentExecution", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(`${helper}; return finalReportAgentExecution;`)() as ReturnType<
    typeof loadFinalReportAgentExecution
  >;
}

function loadPromptWithAuthoritativeFinalReportAgentExecution(): (
  prompt: string,
  execution: unknown,
  reportPath: string
) => string {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function promptWithAuthoritativeFinalReportAgentExecution");
  const helperEnd = source.indexOf("\n\nfunction authoritativeFinalReportAgentExecutionArgs", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "untrustedContentBoundary",
    `${helper}; return promptWithAuthoritativeFinalReportAgentExecution;`
  )("UNTRUSTED CONTENT BOUNDARY") as ReturnType<typeof loadPromptWithAuthoritativeFinalReportAgentExecution>;
}

function loadFinalReportAgentExecutionAuthority(
  options: {
    smithersDetail?: unknown;
    chainIndex?: number;
    execution?: unknown;
  } = {}
): {
  remember(task: unknown, execution: unknown): void;
  read(task: unknown): unknown;
  smithersReads(): number;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("const finalReportAgentExecutionAuthority");
  const helperEnd = source.indexOf("\n\nfunction baseAgentForProfile", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  let reads = 0;
  const loaded = new Function(
    "declaredFinalReportOutputPair",
    "execFileSync",
    "parseStrictJsonBytes",
    "isPlainJsonRecord",
    "reconcileSmithersAttemptAgentSelection",
    "finalReportAgentExecution",
    `${helper}; return {
      remember: rememberFinalReportAgentExecutionAuthority,
      read: authoritativeFinalReportAgentExecution
    };`
  )(
    () => ({}),
    () => {
      reads += 1;
      if (options.smithersDetail === undefined) {
        throw new Error("Smithers fallback should not be needed");
      }
      return JSON.stringify(options.smithersDetail);
    },
    (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8")),
    (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
    () => ({ chainIndex: options.chainIndex ?? 0 }),
    () => options.execution ?? {}
  ) as { remember(task: unknown, execution: unknown): void; read(task: unknown): unknown };
  return { ...loaded, smithersReads: () => reads };
}

function loadPromptWithAuthoritativeFinalReportCoverage(): (
  prompt: string,
  coverage: unknown,
  reportPath: string
) => string {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function promptWithAuthoritativeFinalReportCoverage");
  const helperEnd = source.indexOf("\n\nfunction authoritativeFinalReportCoverageArgs", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("untrustedContentBoundary", `${helper}; return promptWithAuthoritativeFinalReportCoverage;`)(
    "UNTRUSTED CONTENT BOUNDARY"
  ) as ReturnType<typeof loadPromptWithAuthoritativeFinalReportCoverage>;
}

function loadTaskPromptPathForArtifactReset(): (
  artifactDir: string,
  promptPath: string | undefined
) => string | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function taskPromptPathForArtifactReset");
  const helperEnd = source.indexOf("\n\nfunction resetTaskArtifactsForRetry", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("path", `${helper}; return taskPromptPathForArtifactReset;`)(path) as ReturnType<
    typeof loadTaskPromptPathForArtifactReset
  >;
}

function loadCanonicalTaskArtifactRetryReset(): (
  artifactDir: string,
  attemptId: string,
  promptPath: string | undefined
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const selectorStart = source.indexOf("function taskPromptPathForArtifactReset");
  const selectorEnd = source.indexOf("\n\nfunction resetTaskArtifactsForRetry", selectorStart);
  const resetStart = source.indexOf("function resetTaskArtifactContents");
  const resetEnd = source.indexOf("\n\nfunction isMissingPathError", resetStart);
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");
  const resolverEnd = source.indexOf("\n\nfunction resolveNonEmptyRegularArtifactFile", resolverStart);
  assert.ok(selectorStart >= 0 && selectorEnd > selectorStart, source);
  assert.ok(resetStart >= 0 && resetEnd > resetStart, source);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, source);
  const helpers = ts.transpileModule(
    [
      source.slice(selectorStart, selectorEnd),
      source.slice(resetStart, resetEnd),
      source.slice(resolverStart, resolverEnd)
    ].join("\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return new Function(
    "path",
    "realpathSync",
    "lstatSync",
    "readdirSync",
    "rmSync",
    "statSync",
    "assertRegularFileInside",
    "isStrictlyInsideDirectory",
    "isMissingPathError",
    "INVARIANT_SUITE_BASELINE_FILE",
    "WORKSPACE_PATCH_BASELINE_FILE",
    "WORKSPACE_PATCH_PREPARATION_FILE",
    `${helpers}; return (artifactDir, attemptId, promptPath) => resetTaskArtifactContents(artifactDir, attemptId, "canonical", taskPromptPathForArtifactReset(artifactDir, promptPath));`
  )(
    path,
    fs.realpathSync,
    fs.lstatSync,
    fs.readdirSync,
    fs.rmSync,
    fs.statSync,
    assertRegularFileInside,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    "invariant-suite-baseline.json",
    "workspace-patch-baseline.json",
    "workspace-patch-preparation.json"
  ) as ReturnType<typeof loadCanonicalTaskArtifactRetryReset>;
}

function loadWorkflowControlPathResolvers(): {
  admitWorkflowControls: (
    loadedPath: string,
    persistedPath: string | undefined
  ) => {
    loadedWorkflowPath: string;
    loadedExecutionSnapshotRoot: string | undefined;
    persistedWorkflowPath: string | undefined;
    persistedExecutionSnapshotRoot: string | undefined;
  };
  taskWorkflowControlPaths: (
    executionMode: "local" | "cloud",
    controls: {
      loadedWorkflowPath: string;
      loadedExecutionSnapshotRoot: string | undefined;
      persistedWorkflowPath: string | undefined;
      persistedExecutionSnapshotRoot: string | undefined;
    }
  ) => {
    promptExecutionSnapshotRoot: string | undefined;
    workflowPath: string | undefined;
    executionSnapshotRoot: string | undefined;
  };
  sealedTaskPromptPath: (attemptId: string, snapshotRoot: string | undefined) => string | undefined;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("type AdmittedWorkflowControls");
  const helperEnd = source.indexOf("\n\nfunction cloudSnapshotRelativePath", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return new Function(
    "path",
    "existsSync",
    "realpathSync",
    `${helper}; return { admitWorkflowControls, taskWorkflowControlPaths, sealedTaskPromptPath };`
  )(path, fs.existsSync, fs.realpathSync) as ReturnType<typeof loadWorkflowControlPathResolvers>;
}

function loadRestoreInvariantSuiteWorkspaceSnapshot(
  snapshots: Map<string, Map<string, Buffer>>
): (
  task: { attemptId: string; workspacePath: string; runRoot: string },
  options?: { preserveCurrentSources?: boolean }
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function restoreInvariantSuiteWorkspaceSnapshot");
  const helperEnd = source.indexOf("function assertTaskInputs", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = source
    .slice(helperStart, helperEnd)
    .replace("task: (typeof taskSpecs)[number]", "task")
    .replace("options: { preserveCurrentSources?: boolean } = {}", "options = {}")
    .replace("): void {", ") {")
    .replaceAll("let stat: ReturnType<typeof lstatSync>;", "let stat;");
  return new Function(
    "path",
    "lstatSync",
    "realpathSync",
    "rmSync",
    "isStrictlyInsideDirectory",
    "invariantSuiteWorkspaceSnapshots",
    "loadInvariantSuiteWorkspaceSnapshot",
    "invariantWorkspaceSourcePaths",
    "assertSafeInvariantSuitePath",
    "safeInvariantSuiteDirectory",
    "isMissingPathError",
    "writeFileDurable",
    "readStableWorkspaceSnapshotFile",
    "createHash",
    `${helper}; return restoreInvariantSuiteWorkspaceSnapshot;`
  )(
    path,
    fs.lstatSync,
    fs.realpathSync,
    fs.rmSync,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    snapshots,
    () => undefined,
    (_workspaceRoot: string) => ["test/baseline.t.sol", "test/new.t.sol"],
    (value: string) => value,
    (root: string, candidate: string) => {
      fs.mkdirSync(candidate, { recursive: true });
      return fs.realpathSync(candidate);
    },
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    writeFileDurable,
    () => Buffer.alloc(0),
    createHash
  ) as (
    task: { attemptId: string; workspacePath: string; runRoot: string },
    options?: { preserveCurrentSources?: boolean }
  ) => void;
}

function loadSafeInvariantSuiteDirectory(): (root: string, candidate: string) => string {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function safeInvariantSuiteDirectory");
  const helperEnd = source.indexOf("\n\n", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  // The workflow template is TypeScript, while this focused test exercises the
  // generated helper's filesystem behavior directly. Strip only its annotations
  // so the extracted function can run in Node's Function constructor.
  const helper = source
    .slice(helperStart, helperEnd)
    .replaceAll("root: string", "root")
    .replaceAll("candidate: string", "candidate")
    .replaceAll(": string {", " {")
    .replaceAll("const missing: string[]", "const missing");
  return new Function(
    "path",
    "lstatSync",
    "mkdirSync",
    "realpathSync",
    "isStrictlyInsideDirectory",
    `${helper}; return safeInvariantSuiteDirectory;`
  )(path, fs.lstatSync, fs.mkdirSync, fs.realpathSync, (root: string, candidate: string) =>
    candidate.startsWith(`${root}${path.sep}`)
  ) as (root: string, candidate: string) => string;
}

function loadPreservePinnedSourceProof(): (task: {
  attemptId: string;
  workspacePath: string;
  metadata: { artifacts: { dir: string } };
  pinnedSubmodules?: unknown;
}) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const commandStart = source.indexOf("const unreachableCommitCountCommand");
  const commandEnd = source.indexOf("\n\nconst { Workflow", commandStart);
  const helperStart = source.indexOf("function preservePinnedSourceProof");
  const helperEnd = source.indexOf(
    "\n\n/** Directory names whose task-owned generated-test work must be cleared before a retry. */",
    helperStart
  );
  assert.ok(commandStart >= 0, source);
  assert.ok(commandEnd > commandStart, source);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const command = new Function(`${source.slice(commandStart, commandEnd)}; return unreachableCommitCountCommand;`)();
  const helper = source
    .slice(helperStart, helperEnd)
    .replace("task: (typeof taskSpecs)[number]", "task")
    .replace("): void {", ") {")
    .replace("const git = (args: string[]): string =>", "const git = (args) =>")
    .replace("const gitUnreachableCommitCount = (): string =>", "const gitUnreachableCommitCount = () =>");

  return new Function(
    "path",
    "execFileSync",
    "realpathSync",
    "mkdirSync",
    "Buffer",
    "publishFileDurableExclusive",
    "isStrictlyInsideDirectory",
    "usesPinnedSource",
    "pinnedSourceRef",
    "unreachableCommitCountCommand",
    `${helper}; return preservePinnedSourceProof;`
  )(
    path,
    execFileSync,
    fs.realpathSync,
    fs.mkdirSync,
    Buffer,
    publishFileDurableExclusive,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    true,
    "refs/heads/ultrafuzz-pinned",
    command
  ) as (task: {
    attemptId: string;
    workspacePath: string;
    metadata: { artifacts: { dir: string } };
    pinnedSubmodules?: unknown;
  }) => void;
}

// The generated template carries its own copy of the invariant-ledger evidence rule, and it is the
// copy that failed Aave run R45 (issue #289) with `invariant scan probe tests is unavailable: scan
// probe is not a regular file`. Extracting it here means the directory allowance is pinned where it
// actually runs, not only in the runtime gate's twin.
type InvariantSourcePinCall = { workspacePath: string; relativePath: string; bytes: Uint8Array; ref?: string };

function loadReadInvariantSourceSnapshot(
  usesPinnedSource: boolean,
  checkInvariantSourcePinned: (options: InvariantSourcePinCall) => { ok: boolean }
): (workspaceRoot: string, relativePath: string, label: string) => { bytes: Buffer; content: string } {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function readInvariantSourceSnapshot");
  const helperEnd = source.indexOf("\n\nfunction verifyInvariantLedgerSourceEvidence", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "isStrictlyInsideDirectory",
    "readBoundedRegularArtifactSnapshot",
    "MAX_VERIFIED_COMPANION_BYTES",
    "TextDecoder",
    "usesPinnedSource",
    "checkInvariantSourcePinned",
    "pinnedSourceRef",
    `${helper}; return readInvariantSourceSnapshot;`
  )(
    path,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (_root: string, candidate: string) => ({ path: candidate, bytes: fs.readFileSync(candidate) }),
    16 * 1024 * 1024,
    TextDecoder,
    usesPinnedSource,
    checkInvariantSourcePinned,
    "refs/heads/ultrafuzz-pinned"
  ) as (workspaceRoot: string, relativePath: string, label: string) => { bytes: Buffer; content: string };
}

function loadVerifyInvariantLedgerSourceEvidence(snapshotPaths: string[]): (
  task: {
    attemptId: string;
    workspacePath: string;
    outputs: readonly { path: string; contract: string }[];
    metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  },
  verifiedOutputs: ReadonlyMap<
    string,
    { artifactRoot: string; file: { path: string; bytes: Buffer }; contents: string; value: unknown }
  >
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifyInvariantLedgerSourceEvidence");
  const helperEnd = source.indexOf("\n\nfunction normalizeInvariantSourceLines", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;

  // `readInvariantSourceSnapshot` is the step that demanded a regular file. Stubbing it records
  // exactly which paths the loop still tries to snapshot, and reproduces R45's error for them.
  const readInvariantSourceSnapshot = (_workspaceRoot: string, sourcePath: string, label: string) => {
    snapshotPaths.push(sourcePath);
    throw new Error(
      `artifact-contract failure: invariant ${label} ${sourcePath} is unavailable: ${label} is not a regular file`
    );
  };

  return new Function(
    "path",
    "lstatSync",
    "realpathSync",
    "mkdirSync",
    "execFileSync",
    "createHash",
    "publishFileDurableExclusive",
    "validateInvariantLedgerSchema",
    "validateInvariantSourceProofSchema",
    "isSafeInvariantProbePath",
    "isStrictlyInsideDirectory",
    "invariantPathParentsInsideWorkspace",
    "readInvariantSourceSnapshot",
    "normalizeInvariantSourceLines",
    "symbolFromInvariantLocation",
    "invariantSymbolDeclaration",
    "invariantLedgerMarkdownParityIssues",
    "declaredInvariantLedgerProducerPair",
    `${helper}; return verifyInvariantLedgerSourceEvidence;`
  )(
    path,
    fs.lstatSync,
    fs.realpathSync,
    fs.mkdirSync,
    () => "0000000000000000000000000000000000000000\n",
    createHash,
    publishFileDurableExclusive,
    (value: unknown) => ({ ok: true, value }),
    () => ({ ok: true }),
    (value: string) => !path.isAbsolute(value) && !value.split(/[\\/]/u).includes(".."),
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string) => {
      let current = path.dirname(candidate);
      while (current !== root) {
        if (!(current !== root && current.startsWith(`${root}${path.sep}`))) return false;
        if (fs.lstatSync(current).isSymbolicLink()) return false;
        current = path.dirname(current);
      }
      return true;
    },
    readInvariantSourceSnapshot,
    (lines: readonly string[]) => lines.join("\n"),
    () => undefined,
    () => undefined,
    invariantLedgerMarkdownParityIssues,
    (task: { outputs: readonly { path: string; contract: string }[] }) => {
      const ledgers = task.outputs.filter((output) => output.contract === "ultrafuzz/invariant-ledger@1");
      const markdown = task.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
      if (ledgers.length !== 1 || markdown.length !== 1) throw new Error("ambiguous invariant declaration");
      return { ledger: ledgers[0], markdown: markdown[0] };
    }
  ) as (
    task: {
      attemptId: string;
      workspacePath: string;
      outputs: readonly { path: string; contract: string }[];
      metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
    },
    verifiedOutputs: ReadonlyMap<
      string,
      { artifactRoot: string; file: { path: string; bytes: Buffer }; contents: string; value: unknown }
    >
  ) => void;
}

function invariantLedgerProbeFixture(probes: readonly Record<string, string>[]): {
  root: string;
  task: {
    attemptId: string;
    workspacePath: string;
    outputs: readonly { path: string; contract: string }[];
    metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  };
  verifiedOutputs: ReadonlyMap<
    string,
    { artifactRoot: string; file: { path: string; bytes: Buffer }; contents: string; value: unknown }
  >;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-ledger-probe-")));
  const workspacePath = path.join(root, "workspace");
  const artifactDir = path.join(root, "run", "artifacts", "project-discovery");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(path.join(artifactDir, "custom"), { recursive: true });
  const ledgerRelativePath = "custom/renamed-ledger.json";
  const ledgerPath = path.join(artifactDir, ledgerRelativePath);
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    inventory_rows: [],
    scan_probes: probes
  };
  const contents = JSON.stringify(ledger);
  const bytes = Buffer.from(contents, "utf8");
  const markdownRelativePath = "custom/renamed-discovery.md";
  const markdownPath = path.join(artifactDir, markdownRelativePath);
  const markdownContents = "# Discovery\n";
  const markdownBytes = Buffer.from(markdownContents, "utf8");
  fs.writeFileSync(ledgerPath, bytes);
  fs.writeFileSync(markdownPath, markdownBytes);
  return {
    root,
    task: {
      attemptId: "attempt-project-discovery",
      workspacePath,
      outputs: [
        { path: ledgerRelativePath, contract: "ultrafuzz/invariant-ledger@1" },
        { path: markdownRelativePath, contract: "ultrafuzz/nonempty-markdown@1" }
      ],
      metadata: { node: { logicalNodeId: "renamed-discovery-role" }, artifacts: { dir: artifactDir } }
    },
    verifiedOutputs: new Map([
      [ledgerRelativePath, { artifactRoot: artifactDir, file: { path: ledgerPath, bytes }, contents, value: ledger }],
      [
        markdownRelativePath,
        {
          artifactRoot: artifactDir,
          file: { path: markdownPath, bytes: markdownBytes },
          contents: markdownContents,
          value: markdownContents
        }
      ]
    ])
  };
}

test("generated Smithers invariant ledger accepts a directory scan probe", () => {
  const snapshotPaths: string[] = [];
  const verify = loadVerifyInvariantLedgerSourceEvidence(snapshotPaths);
  const fixture = invariantLedgerProbeFixture([
    { id: "probe-tests-directory", source_path: "tests", query: "invariant harness scan", result: "Scanned tests" }
  ]);
  fs.mkdirSync(path.join(fixture.task.workspacePath, "tests"), { recursive: true });

  verify(fixture.task, fixture.verifiedOutputs);

  // A directory probe must never reach the regular-file snapshot; that call is what killed R45.
  assert.deepEqual(snapshotPaths, []);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("generated Smithers invariant source proof is immutable and never repairs a present destination", () => {
  const snapshotPaths: string[] = [];
  const verify = loadVerifyInvariantLedgerSourceEvidence(snapshotPaths);
  const fixture = invariantLedgerProbeFixture([]);
  const proofPath = path.join(fixture.root, "run", "source-proofs", `${fixture.task.attemptId}.invariant.json`);

  verify(fixture.task, fixture.verifiedOutputs);
  const canonical = fs.readFileSync(proofPath);
  verify(fixture.task, fixture.verifiedOutputs);
  assert.deepEqual(fs.readFileSync(proofPath), canonical, "exact prior proof bytes are idempotent");

  fs.writeFileSync(proofPath, "{}\n");
  assert.throws(() => verify(fixture.task, fixture.verifiedOutputs), /invariant source proof .* changed/iu);
  assert.equal(fs.readFileSync(proofPath, "utf8"), "{}\n", "conflicting present proof is not overwritten");

  fs.unlinkSync(proofPath);
  fs.symlinkSync("missing-proof.json", proofPath);
  assert.throws(() => verify(fixture.task, fixture.verifiedOutputs), /invariant source proof .* changed/iu);
  assert.equal(fs.lstatSync(proofPath).isSymbolicLink(), true, "dangling proof remains present and invalid");
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("generated Smithers checks the authenticated invariant Markdown before source publication", () => {
  const snapshotPaths: string[] = [];
  const verify = loadVerifyInvariantLedgerSourceEvidence(snapshotPaths);
  const fixture = invariantLedgerProbeFixture([]);
  const ledgerPath = "custom/renamed-ledger.json";
  const markdownPath = "custom/renamed-discovery.md";
  const ledgerSnapshot = fixture.verifiedOutputs.get(ledgerPath)!;
  const markdownSnapshot = fixture.verifiedOutputs.get(markdownPath)!;
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-one",
        source_path: "docs/source.md",
        source_location: "line 1",
        kind: "invariant",
        verbatim: "Balances remain conserved.",
        inventory_ids: ["inventory-one"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-one",
        description: "Balances remain conserved.",
        ledger_ids: ["evidence-one"]
      }
    ],
    scan_probes: []
  };
  ledgerSnapshot.value = ledger;
  ledgerSnapshot.contents = JSON.stringify(ledger);
  ledgerSnapshot.file.bytes = Buffer.from(ledgerSnapshot.contents, "utf8");

  assert.throws(
    () => verify(fixture.task, fixture.verifiedOutputs),
    /invariant ledger JSON\/Markdown parity failed.*INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING/iu
  );
  assert.deepEqual(snapshotPaths, [], "parity fails before any source snapshot is read");

  markdownSnapshot.contents = [
    '### Ledger entry: "evidence-one"',
    'source_path: "docs/source.md"',
    'source_location: "line 1"',
    'kind: "invariant"',
    'verbatim: "Balances remain conserved."',
    'inventory_ids: ["inventory-one"]',
    '### End ledger entry: "evidence-one"',
    '### Inventory row: "inventory-one"',
    'description: "Balances remain conserved."',
    'ledger_ids: ["evidence-one"]',
    '### End inventory row: "inventory-one"'
  ].join("\n");
  markdownSnapshot.file.bytes = Buffer.from(markdownSnapshot.contents, "utf8");
  assert.throws(
    () => verify(fixture.task, fixture.verifiedOutputs),
    /invariant source docs\/source\.md is unavailable/iu
  );
  assert.deepEqual(snapshotPaths, ["docs/source.md"]);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("generated Smithers invariant ledger still snapshots a symlinked-directory scan probe", () => {
  const snapshotPaths: string[] = [];
  const verify = loadVerifyInvariantLedgerSourceEvidence(snapshotPaths);
  const fixture = invariantLedgerProbeFixture([
    { id: "probe-tests-alias", source_path: "tests-alias", query: "invariant harness scan", result: "Scanned tests" }
  ]);
  fs.mkdirSync(path.join(fixture.task.workspacePath, "tests"), { recursive: true });
  fs.symlinkSync(
    path.join(fixture.task.workspacePath, "tests"),
    path.join(fixture.task.workspacePath, "tests-alias"),
    "dir"
  );

  // The directory allowance keys on `lstat`, so a symlink that resolves to a directory is not a
  // directory probe. It stays on the strict path and fails there.
  assert.throws(() => verify(fixture.task, fixture.verifiedOutputs), /scan probe is not a regular file/u);
  assert.deepEqual(snapshotPaths, ["tests-alias"]);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("safe invariant-suite directory permits nested paths under a symlinked root alias", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-invariant-directory-"));
  const realRoot = path.join(root, "files");
  const rootAlias = path.join(root, "files-alias");
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, rootAlias, "dir");

  const safeInvariantSuiteDirectory = loadSafeInvariantSuiteDirectory();
  const resolved = safeInvariantSuiteDirectory(rootAlias, path.join(rootAlias, "src", "access"));

  assert.equal(resolved, path.join(realRoot, "src", "access"));
  assert.equal(fs.statSync(resolved).isDirectory(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("generated Smithers verifier rejects zero-byte generated-test companions", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function readBoundedRegularArtifactSnapshot");
  const verifierStart = source.indexOf("function verifyGeneratedTestFiles");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(helperStart >= 0, source);
  assert.ok(verifierStart > helperStart, source);
  assert.ok(workflowStart > verifierStart, source);

  const helper = source.slice(helperStart, verifierStart);
  assert.match(
    source,
    /artifactContractDefinition,[\s\S]*assertRegularFileInside,[\s\S]*validateArtifactContractBytes/u
  );
  assert.match(source, /validateArtifactContractBytes,[\s\S]*writeFileDurable[\s\S]*= await import/u);
  assert.doesNotMatch(source, /validateArtifactContract\(/u);
  assert.match(source, /validateArtifactContractBytes\([\s\S]*snapshot\.bytes/u);
  assert.match(source, /validateArtifactContractBytes\(output\.contract, file\.bytes, output\.path\)/u);
  assert.match(source, /assertRegularFileInside\(artifactDir, artifactPath, failureMessage\)/u);
  assert.match(helper, /readRegularFileSnapshot\(resolvedPath, maxBytes\)/u);
  assert.match(helper, /requireNonEmpty && bytes\.length === 0/u);
  assert.match(helper, /file is empty/u);

  const generatedTestVerifier = source.slice(verifierStart, workflowStart);
  assert.match(generatedTestVerifier, /readBoundedRegularArtifactSnapshot\(/u);
  assert.match(generatedTestVerifier, /MAX_GENERATED_TEST_COMPANION_BYTES,\s*true/u);
  assert.match(generatedTestVerifier, /companion\.stats\.size === 0/u);
  assert.match(generatedTestVerifier, /decodeStrictUtf8Snapshot\(snapshot/u);
  assert.match(generatedTestVerifier, /snapshot\.bytes\.length !== entry\.size_bytes/u);
  assert.match(generatedTestVerifier, /createHash\("sha256"\)\.update\(snapshot\.bytes\).*entry\.sha256/su);
});

test("generated Smithers authenticates the final generated-test publication snapshot", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verifierStart = source.indexOf("function verifyGeneratedTestFiles");
  const workflowStart = source.indexOf("export default smithers", verifierStart);
  assert.ok(verifierStart >= 0 && workflowStart > verifierStart, source);
  const emitted = ts.transpileModule(source.slice(verifierStart, workflowStart), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const verifyGeneratedTestFiles = new Function(
    "path",
    "isStrictlyInsideDirectory",
    "resolveRegularArtifactFile",
    "statSync",
    "readBoundedRegularArtifactSnapshot",
    "MAX_GENERATED_TEST_BUNDLE_ENTRIES",
    "MAX_GENERATED_TEST_BUNDLE_BYTES",
    "MAX_GENERATED_TEST_COMPANION_BYTES",
    "decodeStrictUtf8Snapshot",
    "createHash",
    `${emitted}; return verifyGeneratedTestFiles;`
  )(
    path,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, failureMessage: string) => {
      try {
        if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error(failureMessage);
        return fs.realpathSync(candidate);
      } catch {
        throw new Error(failureMessage);
      }
    },
    fs.statSync,
    (root: string, candidate: string, failureMessage: string, maxBytes: number, requireNonEmpty: boolean) => {
      try {
        if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error(failureMessage);
        const resolved = fs.realpathSync(candidate);
        const bytes = readRegularFileSnapshot(resolved, maxBytes);
        if (requireNonEmpty && bytes.length === 0) throw new Error(`${failureMessage}: file is empty`);
        return Object.freeze({ path: resolved, bytes });
      } catch {
        throw new Error(failureMessage);
      }
    },
    1_024,
    64 * 1024 * 1024,
    16 * 1024 * 1024,
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not valid UTF-8`, { cause: error });
      }
    },
    createHash
  ) as (artifactDir: string, value: unknown) => Array<{ path: string; contents: Buffer }>;

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-final-snapshot-")));
  try {
    const relativePath = "generated-tests/Replay.t.sol";
    const contents = "contract Replay {}\n";
    fs.mkdirSync(path.join(root, "generated-tests"));
    fs.writeFileSync(path.join(root, relativePath), contents, "utf8");
    const entry = generatedTestEntry(relativePath, contents);
    const manifest = { generated_tests: [entry], support_files: [] };

    assert.deepEqual(verifyGeneratedTestFiles(root, manifest), [
      { path: relativePath, contents: Buffer.from(contents, "utf8") }
    ]);
    assert.throws(
      () =>
        verifyGeneratedTestFiles(root, {
          ...manifest,
          generated_tests: [{ ...entry, size_bytes: entry.size_bytes + 1 }]
        }),
      /file size does not match/u
    );
    assert.throws(
      () =>
        verifyGeneratedTestFiles(root, {
          ...manifest,
          generated_tests: [{ ...entry, sha256: "0".repeat(64) }]
        }),
      /file digest does not match/u
    );
    fs.unlinkSync(path.join(root, relativePath));
    assert.throws(
      () => verifyGeneratedTestFiles(root, manifest),
      /generated-test bundle file is missing generated-tests\/Replay\.t\.sol/u
    );

    let companionReads = 0;
    const countingVerifier = new Function(
      "path",
      "isStrictlyInsideDirectory",
      "resolveRegularArtifactFile",
      "statSync",
      "readBoundedRegularArtifactSnapshot",
      "MAX_GENERATED_TEST_BUNDLE_ENTRIES",
      "MAX_GENERATED_TEST_BUNDLE_BYTES",
      "MAX_GENERATED_TEST_COMPANION_BYTES",
      "decodeStrictUtf8Snapshot",
      "createHash",
      `${emitted}; return verifyGeneratedTestFiles;`
    )(
      path,
      (directory: string, candidate: string) =>
        candidate !== directory && candidate.startsWith(`${directory}${path.sep}`),
      (directory: string, candidate: string, failureMessage: string) => {
        try {
          if (candidate === directory || !candidate.startsWith(`${directory}${path.sep}`)) {
            throw new Error(failureMessage);
          }
          return fs.realpathSync(candidate);
        } catch {
          throw new Error(failureMessage);
        }
      },
      fs.statSync,
      () => {
        companionReads += 1;
        throw new Error("companion content should not be opened before resource preflight passes");
      },
      1_024,
      64 * 1024 * 1024,
      16 * 1024 * 1024,
      () => "",
      createHash
    ) as (artifactDir: string, value: unknown) => Array<{ path: string; contents: Buffer }>;

    const boundedEntry = (entryPath: string, sizeBytes: number) => ({
      path: entryPath,
      size_bytes: sizeBytes,
      sha256: "0".repeat(64)
    });
    assert.throws(
      () =>
        countingVerifier(root, {
          generated_tests: Array.from({ length: 1_025 }, (_, index) =>
            boundedEntry(`generated-tests/count-${index}.sol`, 1)
          ),
          support_files: []
        }),
      /1024-entry combined bundle limit/u
    );
    assert.equal(companionReads, 0);
    assert.throws(
      () =>
        countingVerifier(root, {
          generated_tests: Array.from({ length: 5 }, (_, index) =>
            boundedEntry(`generated-tests/declared-${index}.sol`, 16 * 1024 * 1024)
          ),
          support_files: []
        }),
      /combined declared-size limit/u
    );
    assert.equal(companionReads, 0);

    const actualEntries = Array.from({ length: 5 }, (_, index) => {
      const actualPath = `generated-tests/actual-${index}.sol`;
      fs.writeFileSync(path.join(root, actualPath), "x", "utf8");
      fs.truncateSync(path.join(root, actualPath), 16 * 1024 * 1024);
      return boundedEntry(actualPath, 1);
    });
    assert.throws(
      () => countingVerifier(root, { generated_tests: actualEntries, support_files: [] }),
      /companions exceed the 67108864-byte combined bundle limit/u
    );
    assert.equal(companionReads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type VerifyArtifactsTask = {
  attemptId: string;
  runRoot: string;
  workspacePath: string;
  artifactDir: string;
  dependencyArtifactDirs: string[];
  campaignTimeoutExpectations?: {
    configuredFuzzerTimeoutSeconds: number;
    plannedTimeoutSeconds: number;
    finalizationReserveSeconds: number;
  } | null;
  metadata: {
    run: { ultrafuzzRunId: string };
    artifacts: { dir: string };
    node: { logicalNodeId: string; concreteNodeId: string };
    dependencies: { attemptIds: string[] };
  };
  outputs: Array<{
    path: string;
    contract: string;
    contractDigest: string;
    primary: boolean;
    schemaFile?: string;
    schemaId?: string;
    schemaSha256?: string;
    schemaBundleSha256?: string;
    validatorBuild?: string;
  }>;
};

function loadVerifyArtifactsHarness(
  options: {
    taskSpecs?: readonly VerifyArtifactsTask[];
    authenticatedDependencyDirs?: readonly string[];
    onSemanticGate?: () => void;
    onPublishArtifacts?: () => void;
  } = {}
): {
  captureTaskOutputs: (task: VerifyArtifactsTask) => Array<{
    output: VerifyArtifactsTask["outputs"][number];
    artifactRoot: string;
    file: { path: string; bytes: Buffer };
  }>;
  verifyArtifacts: (
    task: VerifyArtifactsTask,
    captured?: ReadonlyArray<{
      output: VerifyArtifactsTask["outputs"][number];
      artifactRoot: string;
      file: { path: string; bytes: Buffer };
    }>
  ) => { artifacts: Array<{ sha256: string }>; primary_artifact: string };
  publications: Map<string, Buffer>;
  markerWrites: unknown[];
  authenticatedDependencyChecks: Array<{ consumerAttemptId: string; dependency: string }>;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const dependencyVerifierStart = source.indexOf("function verifiedDependencyJsonArtifact");
  const dependencyVerifierEnd = source.indexOf(
    "\n\nfunction configuredInvariantPrioritySelection",
    dependencyVerifierStart
  );
  const captureStart = source.indexOf("function captureTaskOutputs");
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts", captureStart);
  const verifierStart = source.indexOf("function verifyArtifacts", finalizerStart);
  const verifierEnd = source.indexOf("function readInvariantSourceSnapshot", verifierStart);
  assert.ok(dependencyVerifierStart >= 0 && dependencyVerifierEnd > dependencyVerifierStart, source);
  assert.ok(captureStart >= 0 && finalizerStart > captureStart, source);
  assert.ok(verifierStart > finalizerStart && verifierEnd > verifierStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(dependencyVerifierStart, dependencyVerifierEnd)}\n${source.slice(captureStart, finalizerStart)}\n${source.slice(verifierStart, verifierEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const publications = new Map<string, Buffer>();
  const markerWrites: unknown[] = [];
  const authenticatedDependencyChecks: Array<{ consumerAttemptId: string; dependency: string }> = [];
  const harnessTaskSpecs = options.taskSpecs ?? [];
  const authenticatedDependencies = new Set(
    (options.authenticatedDependencyDirs ?? []).map((dependency) => fs.realpathSync(dependency))
  );
  const remember = (values: Map<string, Buffer>, relativePath: string, bytes: Buffer): void => {
    const previous = values.get(relativePath);
    if (previous !== undefined && !previous.equals(bytes)) throw new Error(`conflicting ${relativePath}`);
    values.set(relativePath, bytes);
  };
  const factory = new Function(
    "path",
    "realpathSync",
    "taskSpecs",
    "taskArtifactRoots",
    "isStrictlyInsideDirectory",
    "resolveRegularArtifactFile",
    "readBoundedRegularArtifactSnapshot",
    "MAX_VERIFIED_ARTIFACT_BYTES",
    "MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILES",
    "MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES",
    "MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES",
    "assertSafeVerifiedPublicationPath",
    "clearArtifactVerificationMarker",
    "decodeStrictUtf8Snapshot",
    "artifactContractDefinition",
    "parseStrictJsonSnapshot",
    "validateArtifactContractBytes",
    "formatSchemaValidationIssues",
    "assertVerifiedDependency",
    "executeSchemaSemanticGates",
    "normalizeNodeAttemptFailureMessage",
    "materializeInvariantSuiteCompanions",
    "rememberVerifiedPublication",
    "verifyGeneratedTestFiles",
    "verifyInvariantLedgerSourceEvidence",
    "invariantSuiteNodeIds",
    "rememberInvariantSuitePublications",
    "createHash",
    "assertArtifactPublicationsContainNoSecrets",
    "sensitiveEnvironmentValues",
    "publishVerifiedArtifacts",
    "writeArtifactVerificationMarker",
    "taskPublishesWorkspacePatch",
    "declaredAncestorOutputsByContract",
    "declaredFinalReportOutputPair",
    "INVARIANT_LEDGER_CONTRACT",
    "INVARIANT_LEDGER_CONVENTIONAL_PATH",
    "DISCOVERY_MARKDOWN_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_CONTRACT",
    "CANONICAL_PROPERTIES_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_MARKDOWN_CONTRACT",
    "CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH",
    "canonicalPropertiesMarkdownParityIssues",
    "validatePropertiesSchema",
    `${emitted}; return { captureTaskOutputs, verifyArtifacts };`
  )(
    path,
    fs.realpathSync,
    harnessTaskSpecs,
    (_task: VerifyArtifactsTask, artifactDir: string) => [artifactDir],
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, failureMessage: string) => {
      try {
        assertRegularFileInside(root, candidate, failureMessage);
        const resolved = fs.realpathSync(candidate);
        if (resolved === root || !resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile()) {
          throw new Error(failureMessage);
        }
        return resolved;
      } catch {
        throw new Error(failureMessage);
      }
    },
    (root: string, candidate: string, failureMessage: string, maxBytes: number, requireNonEmpty = false) => {
      if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error(failureMessage);
      let before: fs.BigIntStats;
      try {
        before = fs.lstatSync(candidate, { bigint: true });
      } catch {
        throw new Error(failureMessage);
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw new Error(`${failureMessage}: file is not a singly linked regular file`);
      }
      const resolved = fs.realpathSync(candidate);
      const bytes = readRegularFileSnapshot(resolved, maxBytes);
      if (requireNonEmpty && bytes.length === 0) throw new Error(`${failureMessage}: file is empty`);
      const after = fs.lstatSync(candidate, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1n ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        after.size !== BigInt(bytes.byteLength) ||
        resolved !== candidate
      ) {
        throw new Error(`${failureMessage}: file changed while it was captured`);
      }
      return Object.freeze({ path: resolved, bytes });
    },
    64 * 1024 * 1024,
    MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILES,
    MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES,
    MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES,
    (relativePath: string) => {
      if (
        relativePath.length === 0 ||
        path.isAbsolute(relativePath) ||
        relativePath.includes("\u0000") ||
        relativePath.includes("\\") ||
        /^[A-Za-z]:/u.test(relativePath) ||
        relativePath.split("/").some((segment) => segment.length === 0 || segment === "..")
      ) {
        throw new Error(`artifact-contract failure: unsafe verified publication path ${relativePath}`);
      }
    },
    () => undefined,
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not valid UTF-8`, { cause: error });
      }
    },
    (contract: string) => ({
      format: contract === "ultrafuzz/text@1" || contract === "ultrafuzz/nonempty-markdown@1" ? "text" : "json"
    }),
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return parseStrictJsonBytes(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not strict JSON`, { cause: error });
      }
    },
    (contract: Parameters<typeof validateArtifactContractBytes>[0], contents: Uint8Array, artifactPath: string) =>
      validateArtifactContractBytes(contract, contents, artifactPath),
    (issues: readonly { message: string }[]) => {
      const parserIssue = issues.find(
        (issue) => issue.message.includes("not valid UTF-8") || issue.message.includes("not strict JSON")
      );
      return parserIssue?.message ?? "invalid";
    },
    (task: VerifyArtifactsTask, dependency: string) => {
      const resolved = fs.realpathSync(dependency);
      if (!authenticatedDependencies.has(resolved)) {
        throw new Error(`artifact-contract failure: dependency is not authenticated ${resolved}`);
      }
      authenticatedDependencyChecks.push({ consumerAttemptId: task.attemptId, dependency: resolved });
      const producer = harnessTaskSpecs.find(
        (candidate) =>
          candidate.attemptId === path.basename(resolved) && fs.realpathSync(candidate.artifactDir) === resolved
      );
      if (producer === undefined)
        throw new Error(`artifact-contract failure: dependency producer is unavailable ${resolved}`);
      const artifacts = new Map(
        producer.outputs.map((output) => {
          const artifactPath = path.join(resolved, output.path);
          const bytes = fs.readFileSync(artifactPath);
          const validation = validateArtifactContractBytes(
            output.contract as Parameters<typeof validateArtifactContractBytes>[0],
            bytes,
            artifactPath
          );
          if (!validation.ok) throw new Error(`artifact-contract failure: invalid harness dependency ${output.path}`);
          return [
            output.path,
            Object.freeze({
              path: artifactPath,
              relativePath: output.path,
              contract: output.contract,
              bytes: Buffer.from(bytes),
              value: validation.value
            })
          ] as const;
        })
      );
      const publications = new Map(
        [...artifacts].map(([relativePath, artifact]) => [
          relativePath,
          createHash("sha256").update(artifact.bytes).digest("hex")
        ])
      );
      return Object.freeze({
        attemptId: producer.attemptId,
        artifactDir: resolved,
        markerBytes: Buffer.from(
          JSON.stringify([...publications].sort(([left], [right]) => left.localeCompare(right))),
          "utf8"
        ),
        artifacts,
        publications,
        generatedTestBundles: Object.freeze([])
      });
    },
    (...args: Parameters<typeof executeSchemaSemanticGates>) => {
      options.onSemanticGate?.();
      return executeSchemaSemanticGates(...args);
    },
    normalizeNodeAttemptFailureMessage,
    () => undefined,
    remember,
    () => [],
    () => undefined,
    new Set<string>(),
    () => undefined,
    createHash,
    assertArtifactPublicationsContainNoSecrets,
    () => [],
    (_artifactDir: string, values: ReadonlyMap<string, Buffer>) => {
      for (const [relativePath, bytes] of values) publications.set(relativePath, Buffer.from(bytes));
      options.onPublishArtifacts?.();
    },
    (...args: unknown[]) => markerWrites.push(args),
    (task: VerifyArtifactsTask) =>
      task.outputs.some((output) => output.path === "workspace.patch" && output.contract === "ultrafuzz/text@1") &&
      task.outputs.some(
        (output) => output.path === "workspace-patch.json" && output.contract === "ultrafuzz/workspace-patch@1"
      ),
    declaredAncestorOutputsByContract,
    (task: VerifyArtifactsTask) => {
      const report = task.outputs.filter((output) => output.contract === "ultrafuzz/report@3");
      const markdown = task.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
      return report.length === 1 && markdown.length === 1 ? { report: report[0]!, markdown: markdown[0]! } : undefined;
    },
    "ultrafuzz/invariant-ledger@1",
    "setup/invariant-evidence-ledger.json",
    "setup/project-discovery.md",
    "ultrafuzz/properties@2",
    "properties.json",
    "ultrafuzz/nonempty-markdown@1",
    "properties.md",
    canonicalPropertiesMarkdownParityIssues,
    validatePropertiesSchema
  ) as {
    captureTaskOutputs: ReturnType<typeof loadVerifyArtifactsHarness>["captureTaskOutputs"];
    verifyArtifacts: ReturnType<typeof loadVerifyArtifactsHarness>["verifyArtifacts"];
  };
  return { ...factory, publications, markerWrites, authenticatedDependencyChecks };
}

function singleOutputVerificationTask(root: string, contract: string): VerifyArtifactsTask {
  return {
    attemptId: "attempt-one",
    runRoot: root,
    workspacePath: root,
    artifactDir: root,
    dependencyArtifactDirs: [],
    metadata: {
      run: { ultrafuzzRunId: "run-one" },
      artifacts: { dir: root },
      node: { logicalNodeId: "node-one", concreteNodeId: "node-one" },
      dependencies: { attemptIds: [] }
    },
    outputs: [
      {
        path: "result.json",
        contract,
        contractDigest: "a".repeat(64),
        primary: true
      }
    ]
  };
}

const generatedCampaignPaths = {
  corpus: "backends/recon-fuzzer/corpus",
  cache: "backends/recon-fuzzer/cache",
  log: "backends/recon-fuzzer/run.log",
  raw_results: "backends/recon-fuzzer/results.json",
  reproducers: "backends/recon-fuzzer/reproducers"
} as const;
const GENERATED_CAMPAIGN_COMMAND =
  "timeout --preserve-status --signal=INT --kill-after=300s 3600s recon fuzz . --workers 1 --test-limit 18446744073709551615 --timeout 3600 --seq-len 100";

const generatedCampaignEvidenceContents = new Map<string, Buffer>([
  [generatedCampaignPaths.log, Buffer.from("recon campaign completed\n", "utf8")],
  [generatedCampaignPaths.raw_results, Buffer.from('{"executions":1}\n', "utf8")]
]);

function generatedCampaignEvidenceFiles(): Array<{ path: string; size_bytes: number; sha256: string }> {
  return [...generatedCampaignEvidenceContents].map(([evidencePath, contents]) => ({
    path: evidencePath,
    size_bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex")
  }));
}

function generatedCampaignPlanFixture(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.invariant-campaign-plan.v2",
    available_vcpus: 1,
    workers: 1,
    configured_budget_seconds: 4200,
    deadline: "2026-01-01T01:10:00Z",
    finalization_reserve_seconds: 300,
    configured_fuzzer_timeout_seconds: 3600,
    recon_internal_timeout_seconds: 3600,
    recon_test_limit: "18446744073709551615",
    recon_sequence_length: 100,
    host_soft_timeout_seconds: 3600,
    host_force_kill_grace_seconds: 300,
    artifact_finalization_reserve_seconds: 300,
    backend_started_at: "2026-01-01T00:00:00Z",
    fuzzing_deadline_utc: "2026-01-01T01:00:00Z",
    force_kill_deadline_utc: "2026-01-01T01:05:00Z",
    final_artifact_deadline_utc: "2026-01-01T01:10:00Z",
    backend: { name: "recon", version: null, exact_shell_escaped_command: GENERATED_CAMPAIGN_COMMAND },
    command_plan: [{ phase: "campaign", command: GENERATED_CAMPAIGN_COMMAND }],
    paths: generatedCampaignPaths
  };
}

function generatedImplementedPropertiesFixture(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.implemented-properties.v3",
    properties: [
      {
        property_id: "property-one",
        status: "implemented",
        implementation_paths: ["src/InvariantHarness.sol"],
        test_paths: []
      }
    ],
    selection: {
      priority_threshold: "high",
      priorities: ["high"],
      property_ids: ["property-one"]
    }
  };
}

function generatedPropertyCampaignFixture(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.property-campaign.v3",
    campaign_plan_ref: "campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: "recon",
    backend_version: null,
    configured_timeout_seconds: 3600,
    sequence_length: 100,
    exact_command: GENERATED_CAMPAIGN_COMMAND,
    start_timestamp: "2026-01-01T00:00:00Z",
    end_timestamp: "2026-01-01T01:00:00Z",
    termination_reason: "configured-timeout",
    campaign_outcome: "complete",
    usable_results: true,
    execution: {
      status: "complete",
      usable_results: true,
      command: GENERATED_CAMPAIGN_COMMAND,
      config_path: null,
      workers: 1,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T01:00:00Z",
      deadline: "2026-01-01T01:10:00Z",
      exit_code: 0,
      failure: null
    },
    paths: generatedCampaignPaths,
    evidence_files: generatedCampaignEvidenceFiles(),
    coverage: {
      status: "reported",
      metrics: [
        {
          name: "executions",
          value: 1,
          unit: "count",
          source_ref: generatedCampaignPaths.raw_results
        }
      ],
      unavailable_reason: null
    },
    property_results: [
      {
        property_id: "property-one",
        status: "passed",
        failure_ids: [],
        coverage_metric_names: ["executions"],
        evidence_refs: [generatedCampaignPaths.raw_results],
        reason: null
      }
    ],
    failures: []
  };
}

function generatedCampaignFindingFixture(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id: "finding-one",
    title: "Finding one",
    status: "candidate",
    severity_guess: "Medium",
    confidence: "medium",
    summary: "A schema-valid non-property campaign finding."
  };
}

function generatedCampaignSummaryFixture(
  findingIds: readonly string[],
  postDeduplication: number
): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.campaign-summary.v2",
    outcome: "complete",
    sequence_length: 100,
    implemented_property_suite_refs: ["implemented-properties.json"],
    campaign_plan_ref: "campaign-plan.json",
    backend_results: [{ fuzzer_backend: "recon", status: "complete", result_ref: "campaign.json" }],
    finding_refs: findingIds,
    reproducer_refs: findingIds.map((findingId) => ({ finding_id: findingId, path: null, blocker: null })),
    failure_counts: { pre_deduplication: 0, post_deduplication: postDeduplication }
  };
}

function generatedCampaignVerificationFixture(
  root: string,
  options: { includeNonPropertyFinding?: boolean; summaryPostDeduplication?: number } = {}
): {
  task: VerifyArtifactsTask;
  implementationProducer: VerifyArtifactsTask;
  implementationArtifactDir: string;
} {
  const artifactDir = path.join(root, "campaign-artifacts");
  const implementationArtifactDir = path.join(root, "dependencies", "attempt-implemented-properties");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(implementationArtifactDir, { recursive: true });

  const findings = options.includeNonPropertyFinding ? [generatedCampaignFindingFixture()] : [];
  const findingIds = findings.map((finding) => String(finding.id));
  const documents = new Map<string, unknown>([
    ["campaign-plan.json", generatedCampaignPlanFixture()],
    ["campaign.json", generatedPropertyCampaignFixture()],
    ["findings.json", findings],
    [
      "campaign-summary.json",
      generatedCampaignSummaryFixture(findingIds, options.summaryPostDeduplication ?? findingIds.length)
    ]
  ]);
  for (const [relativePath, document] of documents) {
    fs.writeFileSync(path.join(artifactDir, relativePath), `${JSON.stringify(document)}\n`, "utf8");
  }
  for (const [relativePath, contents] of generatedCampaignEvidenceContents) {
    const evidencePath = path.join(artifactDir, relativePath);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, contents);
  }
  fs.writeFileSync(
    path.join(implementationArtifactDir, "implemented-properties.json"),
    `${JSON.stringify(generatedImplementedPropertiesFixture())}\n`,
    "utf8"
  );

  const implementationProducer: VerifyArtifactsTask = {
    attemptId: "attempt-implemented-properties",
    runRoot: root,
    workspacePath: root,
    artifactDir: implementationArtifactDir,
    dependencyArtifactDirs: [],
    metadata: {
      run: { ultrafuzzRunId: "run-one" },
      artifacts: { dir: implementationArtifactDir },
      node: {
        logicalNodeId: "stateful-invariant-implement-properties",
        concreteNodeId: "stateful-invariant-implement-properties"
      },
      dependencies: { attemptIds: [] }
    },
    outputs: [
      {
        path: "implemented-properties.json",
        contract: "ultrafuzz/implemented-properties@3",
        contractDigest: "e".repeat(64),
        schemaFile: "implemented-properties.schema.json",
        primary: true
      }
    ]
  };
  const task: VerifyArtifactsTask = {
    attemptId: "attempt-campaign",
    runRoot: root,
    workspacePath: root,
    artifactDir,
    dependencyArtifactDirs: [implementationArtifactDir],
    campaignTimeoutExpectations: {
      configuredFuzzerTimeoutSeconds: 3600,
      plannedTimeoutSeconds: 7200,
      finalizationReserveSeconds: 300
    },
    metadata: {
      run: { ultrafuzzRunId: "run-one" },
      artifacts: { dir: artifactDir },
      node: { logicalNodeId: "stateful-invariant-campaign", concreteNodeId: "stateful-invariant-campaign" },
      dependencies: { attemptIds: [implementationProducer.attemptId] }
    },
    outputs: [
      {
        path: "campaign-plan.json",
        contract: "ultrafuzz/invariant-campaign-plan@2",
        contractDigest: "a".repeat(64),
        schemaFile: "invariant-campaign-plan-v2.schema.json",
        primary: false
      },
      {
        path: "campaign.json",
        contract: "ultrafuzz/property-campaign@3",
        contractDigest: "b".repeat(64),
        schemaFile: "property-campaign.schema.json",
        primary: true
      },
      {
        path: "findings.json",
        contract: "ultrafuzz/findings@2",
        contractDigest: "c".repeat(64),
        schemaFile: "findings.schema.json",
        primary: false
      },
      {
        path: "campaign-summary.json",
        contract: "ultrafuzz/campaign-summary@2",
        contractDigest: "d".repeat(64),
        schemaFile: "campaign-summary.schema.json",
        primary: false
      }
    ]
  };
  return { task, implementationProducer, implementationArtifactDir };
}

test("generated Smithers verifier rejects invalid UTF-8 and duplicate JSON keys from captured bytes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-output-snapshot-")));
  try {
    const outputPath = path.join(root, "result.json");
    const invalidUtf8Harness = loadVerifyArtifactsHarness();
    fs.writeFileSync(outputPath, Buffer.from([0x7b, 0xff, 0x7d]));
    const textTask = singleOutputVerificationTask(root, "ultrafuzz/text@1");
    const invalidUtf8 = invalidUtf8Harness.captureTaskOutputs(textTask);
    assert.throws(() => invalidUtf8Harness.verifyArtifacts(textTask, invalidUtf8), /not valid UTF-8/u);
    assert.equal(invalidUtf8Harness.publications.size, 0);

    const duplicateHarness = loadVerifyArtifactsHarness();
    fs.writeFileSync(outputPath, '{"schema_version":"one","schema_version":"two"}\n', "utf8");
    const jsonTask = singleOutputVerificationTask(root, "ultrafuzz/findings@2");
    const duplicate = duplicateHarness.captureTaskOutputs(jsonTask);
    assert.throws(() => duplicateHarness.verifyArtifacts(jsonTask, duplicate), /not strict JSON/u);
    assert.equal(duplicateHarness.publications.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers verifier rejects secret-bearing captured bytes before publication", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-secret-output-")));
  try {
    const outputPath = path.join(root, "result.json");
    const contaminated = Buffer.from("analysis token=otherwise-unknown-secret\n", "utf8");
    fs.writeFileSync(outputPath, contaminated);
    const task = singleOutputVerificationTask(root, "ultrafuzz/text@1");
    const harness = loadVerifyArtifactsHarness();
    const captured = harness.captureTaskOutputs(task);

    assert.throws(() => harness.verifyArtifacts(task, captured), /contains sensitive data/u);
    assert.deepEqual(fs.readFileSync(outputPath), contaminated);
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers hashes and publishes the captured output after its path changes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-output-snapshot-")));
  try {
    const outputPath = path.join(root, "result.json");
    const original = Buffer.from("captured bytes\n", "utf8");
    fs.writeFileSync(outputPath, original);
    const task = singleOutputVerificationTask(root, "ultrafuzz/text@1");
    const harness = loadVerifyArtifactsHarness();
    const captured = harness.captureTaskOutputs(task);
    fs.writeFileSync(outputPath, "mutated after capture\n", "utf8");

    const result = harness.verifyArtifacts(task, captured);

    assert.equal(result.artifacts[0]?.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(harness.publications.get("result.json")?.equals(original), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers fails closed on schema-valid document semantic violations", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-semantic-output-")));
  try {
    const document = {
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-one",
      node_id: "node-one",
      framework: "foundry",
      generated_tests: [generatedTestEntry("generated-tests/Duplicate.t.sol", "duplicate\n")],
      support_files: [generatedTestEntry("generated-tests/Duplicate.t.sol", "duplicate\n")]
    };
    const contents = `${JSON.stringify(document)}\n`;
    assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", contents).ok, true);
    fs.writeFileSync(path.join(root, "result.json"), contents, "utf8");

    const harness = loadVerifyArtifactsHarness();
    const task = singleOutputVerificationTask(root, "ultrafuzz/generated-tests@3");
    task.outputs[0]!.schemaFile = "generated-tests.schema.json";

    assert.throws(
      () => harness.verifyArtifacts(task, harness.captureTaskOutputs(task)),
      /generated-test-bundle-path-uniqueness failed/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers rejects non-UTF-8 generated-test support companions", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-support-utf8-")));
  try {
    fs.mkdirSync(path.join(root, "generated-tests"));
    const replayContents = "contract Replay {}\n";
    const supportContents = Buffer.from([0xff]);
    fs.writeFileSync(path.join(root, "generated-tests", "Replay.t.sol"), replayContents, "utf8");
    fs.writeFileSync(path.join(root, "generated-tests", "fixture.dat"), supportContents);
    const document = {
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-one",
      node_id: "node-one",
      framework: "foundry",
      generated_tests: [generatedTestEntry("generated-tests/Replay.t.sol", replayContents)],
      support_files: [generatedTestEntry("generated-tests/fixture.dat", supportContents)]
    };
    const contents = `${JSON.stringify(document)}\n`;
    assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", contents).ok, true);
    fs.writeFileSync(path.join(root, "result.json"), contents, "utf8");

    const harness = loadVerifyArtifactsHarness();
    const task = singleOutputVerificationTask(root, "ultrafuzz/generated-tests@3");
    task.outputs[0]!.schemaFile = "generated-tests.schema.json";

    assert.throws(
      () => harness.verifyArtifacts(task, harness.captureTaskOutputs(task)),
      /generated-test-file-integrity failed/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers rejects hard-linked generated-test manifests and companions before publication", async (t) => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const snapshotStart = source.indexOf("function readBoundedRegularArtifactSnapshot");
  const snapshotEnd = source.indexOf("\n\nfunction decodeStrictUtf8Snapshot", snapshotStart);
  const generatedStart = source.indexOf("function verifyGeneratedTestFiles");
  const generatedEnd = source.indexOf("\n\nexport default smithers", generatedStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, source);
  assert.ok(generatedStart >= 0 && generatedEnd > generatedStart, source);
  const snapshotHelper = source.slice(snapshotStart, snapshotEnd);
  const generatedVerifier = source.slice(generatedStart, generatedEnd);
  assert.match(snapshotHelper, /before\.nlink !== 1/u);
  assert.match(snapshotHelper, /after\.nlink !== 1/u);
  assert.match(generatedVerifier, /readBoundedRegularArtifactSnapshot\([\s\S]*true\s*\)/u);

  await t.test("manifest", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-manifest-link-")));
    try {
      const manifestPath = path.join(root, "result.json");
      fs.writeFileSync(
        manifestPath,
        `${JSON.stringify({
          schema_version: "ultrafuzz.generated-tests.v3",
          run_id: "run-one",
          node_id: "node-one",
          framework: "foundry",
          generated_tests: [],
          support_files: []
        })}\n`,
        "utf8"
      );
      fs.linkSync(manifestPath, path.join(root, "result.alias.json"));
      const harness = loadVerifyArtifactsHarness();
      const task = singleOutputVerificationTask(root, "ultrafuzz/generated-tests@3");
      task.outputs[0]!.schemaFile = "generated-tests.schema.json";

      assert.throws(() => harness.captureTaskOutputs(task), /output is not a regular file/u);
      assert.equal(harness.publications.size, 0);
      assert.equal(harness.markerWrites.length, 0);
      assert.equal(fs.lstatSync(manifestPath).nlink, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("companion", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-companion-link-")));
    try {
      const generatedTestsDirectory = path.join(root, "generated-tests");
      fs.mkdirSync(generatedTestsDirectory);
      const companionContents = "contract Replay {}\n";
      const companionPath = path.join(generatedTestsDirectory, "Replay.t.sol");
      fs.writeFileSync(companionPath, companionContents, "utf8");
      fs.linkSync(companionPath, path.join(root, "Replay.alias.t.sol"));
      fs.writeFileSync(
        path.join(root, "result.json"),
        `${JSON.stringify({
          schema_version: "ultrafuzz.generated-tests.v3",
          run_id: "run-one",
          node_id: "node-one",
          framework: "foundry",
          generated_tests: [generatedTestEntry("generated-tests/Replay.t.sol", companionContents)],
          support_files: []
        })}\n`,
        "utf8"
      );
      const harness = loadVerifyArtifactsHarness();
      const task = singleOutputVerificationTask(root, "ultrafuzz/generated-tests@3");
      task.outputs[0]!.schemaFile = "generated-tests.schema.json";

      assert.throws(
        () => harness.verifyArtifacts(task, harness.captureTaskOutputs(task)),
        /generated-test-file-integrity failed/u
      );
      assert.equal(harness.publications.size, 0);
      assert.equal(harness.markerWrites.length, 0);
      assert.equal(fs.lstatSync(companionPath).nlink, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("generated Smithers binds generated-test manifests to the current run and logical producer", () => {
  for (const [field, value] of [
    ["run_id", "run-foreign"],
    ["node_id", "node-foreign"]
  ] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-identity-")));
    try {
      const document = {
        schema_version: "ultrafuzz.generated-tests.v3",
        run_id: "run-one",
        node_id: "node-one",
        framework: "foundry",
        generated_tests: [],
        support_files: [],
        [field]: value
      };
      const contents = `${JSON.stringify(document)}\n`;
      assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", contents).ok, true);
      fs.writeFileSync(path.join(root, "result.json"), contents, "utf8");

      const harness = loadVerifyArtifactsHarness();
      const task = singleOutputVerificationTask(root, "ultrafuzz/generated-tests@3");
      task.outputs[0]!.schemaFile = "generated-tests.schema.json";

      assert.throws(
        () => harness.verifyArtifacts(task, harness.captureTaskOutputs(task)),
        /generated-test-current-identity failed/u,
        field
      );
      assert.equal(harness.publications.size, 0);
      assert.equal(harness.markerWrites.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generated Smithers verifies a v3 property campaign against authenticated semantic context", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-semantic-siblings-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root);
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir]
    });

    const result = harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task));

    assert.equal(result.primary_artifact, "campaign.json");
    assert.equal(result.artifacts.length, 4);
    assert.equal(harness.publications.size, 6);
    for (const [relativePath, contents] of generatedCampaignEvidenceContents) {
      assert.deepEqual(harness.publications.get(relativePath), contents);
    }
    assert.equal(harness.markerWrites.length, 1);
    assert.deepEqual(harness.authenticatedDependencyChecks, [
      { consumerAttemptId: "attempt-campaign", dependency: fixture.implementationArtifactDir },
      { consumerAttemptId: "attempt-campaign", dependency: fixture.implementationArtifactDir }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers requires exactly one declaration for every current campaign tuple member", () => {
  const tupleMembers = [
    ["plan", "ultrafuzz/invariant-campaign-plan@2"],
    ["result", "ultrafuzz/property-campaign@3"],
    ["summary", "ultrafuzz/campaign-summary@2"],
    ["findings", "ultrafuzz/findings@2"]
  ] as const;
  for (const [label, contract] of tupleMembers) {
    for (const count of [0, 2] as const) {
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-campaign-tuple-${label}-${count}-`))
      );
      try {
        const fixture = generatedCampaignVerificationFixture(root);
        const output = fixture.task.outputs.find((candidate) => candidate.contract === contract);
        assert.notEqual(output, undefined, label);
        if (count === 0) {
          fixture.task.outputs = fixture.task.outputs.filter((candidate) => candidate.contract !== contract);
        } else {
          const duplicatePath = `duplicate-${output!.path}`;
          fs.copyFileSync(
            path.join(fixture.task.artifactDir, output!.path),
            path.join(fixture.task.artifactDir, duplicatePath)
          );
          fixture.task.outputs.push({ ...output!, path: duplicatePath, primary: false });
        }
        const harness = loadVerifyArtifactsHarness({
          taskSpecs: [fixture.implementationProducer, fixture.task],
          authenticatedDependencyDirs: [fixture.implementationArtifactDir]
        });
        const escapedContract = contract.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

        assert.throws(
          () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
          new RegExp(`exactly one complete campaign output tuple.*${escapedContract}=${count}`, "u"),
          `${label}:${count}`
        );
        assert.equal(harness.publications.size, 0, `${label}:${count}`);
        assert.equal(harness.markerWrites.length, 0, `${label}:${count}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("generated Smithers rejects schema-valid forged timeout evidence before publication", () => {
  const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
  const cases: Array<{
    label: string;
    mutate: (plan: Record<string, unknown>, result: Record<string, unknown>, summary: Record<string, unknown>) => void;
  }> = [
    {
      label: "configured timeout",
      mutate: (plan, result) => {
        plan.configured_fuzzer_timeout_seconds = 3300;
        plan.recon_internal_timeout_seconds = 3300;
        plan.host_soft_timeout_seconds = 3300;
        result.configured_timeout_seconds = 3300;
      }
    },
    {
      label: "campaign command",
      mutate: (plan, result) => {
        const command = GENERATED_CAMPAIGN_COMMAND.replaceAll("3600", "3300");
        record(plan.backend).exact_shell_escaped_command = command;
        record((plan.command_plan as unknown[])[0]).command = command;
        result.exact_command = command;
        record(result.execution).command = command;
      }
    },
    {
      label: "deadline arithmetic",
      mutate: (plan, result) => {
        plan.fuzzing_deadline_utc = "2026-01-01T00:59:00Z";
        plan.force_kill_deadline_utc = "2026-01-01T01:04:00Z";
        plan.final_artifact_deadline_utc = "2026-01-01T01:09:00Z";
        plan.deadline = "2026-01-01T01:09:00Z";
        record(result.execution).deadline = "2026-01-01T01:09:00Z";
      }
    },
    {
      label: "campaign outcome",
      mutate: (_plan, result) => {
        result.campaign_outcome = "partial";
      }
    }
  ];

  for (const { label, mutate } of cases) {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-forged-timeout-${label.replaceAll(" ", "-")}-`))
    );
    try {
      const fixture = generatedCampaignVerificationFixture(root);
      const plan = generatedCampaignPlanFixture();
      const result = generatedPropertyCampaignFixture();
      const summary = generatedCampaignSummaryFixture([], 0);
      mutate(plan, result, summary);
      for (const [relativePath, contract, document] of [
        ["campaign-plan.json", "ultrafuzz/invariant-campaign-plan@2", plan],
        ["campaign.json", "ultrafuzz/property-campaign@3", result],
        ["campaign-summary.json", "ultrafuzz/campaign-summary@2", summary]
      ] as const) {
        const contents = `${JSON.stringify(document)}\n`;
        assert.equal(validateArtifactContract(contract, contents).ok, true, label);
        fs.writeFileSync(path.join(fixture.task.artifactDir, relativePath), contents, "utf8");
      }
      const harness = loadVerifyArtifactsHarness({
        taskSpecs: [fixture.implementationProducer, fixture.task],
        authenticatedDependencyDirs: [fixture.implementationArtifactDir]
      });

      assert.throws(
        () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
        /property-campaign-timeout-evidence failed/u,
        label
      );
      assert.equal(harness.publications.size, 0, label);
      assert.equal(harness.markerWrites.length, 0, label);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generated Smithers fails closed without sealed campaign timeout expectations", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-missing-timeout-authority-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root);
    fixture.task.campaignTimeoutExpectations = null;
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir]
    });

    assert.throws(
      () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
      /property-campaign-timeout-evidence requires trusted context: propertyCampaignTimeout/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers rejects mixed implementation and campaign producers", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-mixed-property-role-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root);
    const implementationOutput = fixture.implementationProducer.outputs[0]!;
    fixture.task.outputs.push({ ...implementationOutput, primary: false });
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir]
    });

    assert.throws(
      () => harness.verifyArtifacts(fixture.task),
      /must not declare both ultrafuzz\/implemented-properties@3 and ultrafuzz\/property-campaign@3/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers fails closed when declared campaign evidence is missing or digest-mismatched", () => {
  for (const mode of ["missing", "mismatched"] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-campaign-evidence-${mode}-`)));
    try {
      const fixture = generatedCampaignVerificationFixture(root);
      const harness = loadVerifyArtifactsHarness({
        taskSpecs: [fixture.implementationProducer, fixture.task],
        authenticatedDependencyDirs: [fixture.implementationArtifactDir]
      });
      const captured = harness.captureTaskOutputs(fixture.task);
      const evidencePath = path.join(fixture.task.metadata.artifacts.dir, generatedCampaignPaths.raw_results);
      if (mode === "missing") fs.rmSync(evidencePath);
      else fs.writeFileSync(evidencePath, '{"executions":2}\n', "utf8");

      assert.throws(
        () => harness.verifyArtifacts(fixture.task, captured),
        /campaign evidence (?:is not an immutable regular file|does not match its manifest)/u,
        mode
      );
      assert.equal(harness.publications.size, 0, mode);
      assert.equal(harness.markerWrites.length, 0, mode);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generated Smithers rejects symlinked and hard-linked campaign evidence", () => {
  for (const mode of ["symlink", "hardlink"] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-campaign-evidence-${mode}-`)));
    try {
      const fixture = generatedCampaignVerificationFixture(root);
      const harness = loadVerifyArtifactsHarness({
        taskSpecs: [fixture.implementationProducer, fixture.task],
        authenticatedDependencyDirs: [fixture.implementationArtifactDir]
      });
      const captured = harness.captureTaskOutputs(fixture.task);
      const evidencePath = path.join(fixture.task.metadata.artifacts.dir, generatedCampaignPaths.raw_results);
      if (mode === "symlink") {
        const originalPath = `${evidencePath}.original`;
        fs.renameSync(evidencePath, originalPath);
        fs.symlinkSync(originalPath, evidencePath);
      } else {
        fs.linkSync(evidencePath, `${evidencePath}.alias`);
      }

      assert.throws(
        () => harness.verifyArtifacts(fixture.task, captured),
        /campaign evidence is not an immutable regular file|hard-linked/u,
        mode
      );
      assert.equal(harness.publications.size, 0, mode);
      assert.equal(harness.markerWrites.length, 0, mode);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generated Smithers publishes the one immutable campaign evidence snapshot used for verification", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-campaign-evidence-snapshot-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root);
    const evidencePath = path.join(fixture.task.metadata.artifacts.dir, generatedCampaignPaths.raw_results);
    const expected = Buffer.from(generatedCampaignEvidenceContents.get(generatedCampaignPaths.raw_results)!);
    let changed = false;
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir],
      onSemanticGate: () => {
        if (changed) return;
        changed = true;
        fs.writeFileSync(evidencePath, '{"executions":999}\n', "utf8");
      }
    });

    harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task));

    assert.equal(changed, true);
    assert.notDeepEqual(fs.readFileSync(evidencePath), expected);
    assert.deepEqual(harness.publications.get(generatedCampaignPaths.raw_results), expected);
    const markerPublications = (harness.markerWrites[0] as unknown[])[2] as ReadonlyMap<string, Buffer>;
    assert.deepEqual(markerPublications.get(generatedCampaignPaths.raw_results), expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers rejects a dependency epoch swap after publication construction and before success", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dependency-final-recheck-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root);
    const dependencyPath = path.join(fixture.implementationArtifactDir, "implemented-properties.json");
    let publicationConstructed = false;
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir],
      onPublishArtifacts: () => {
        publicationConstructed = true;
        fs.writeFileSync(
          dependencyPath,
          `${JSON.stringify(generatedImplementedPropertiesFixture(), null, 2)}\n`,
          "utf8"
        );
      }
    });

    assert.throws(
      () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
      /verified dependency authority changed during semantic verification attempt-implemented-properties/u
    );
    assert.equal(publicationConstructed, true);
    assert.ok(harness.publications.size > 0, "publication construction completed before the dependency swap");
    assert.equal(harness.markerWrites.length, 0, "the swapped dependency never receives a consumer success marker");
    assert.deepEqual(harness.authenticatedDependencyChecks, [
      { consumerAttemptId: "attempt-campaign", dependency: fixture.implementationArtifactDir },
      { consumerAttemptId: "attempt-campaign", dependency: fixture.implementationArtifactDir }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers fails closed when v3 campaign sibling semantic counts disagree", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-semantic-siblings-")));
  try {
    const fixture = generatedCampaignVerificationFixture(root, {
      includeNonPropertyFinding: true,
      summaryPostDeduplication: 0
    });
    const harness = loadVerifyArtifactsHarness({
      taskSpecs: [fixture.implementationProducer, fixture.task],
      authenticatedDependencyDirs: [fixture.implementationArtifactDir]
    });

    assert.throws(
      () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
      /campaign-summary-count-coupling failed/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
    assert.deepEqual(harness.authenticatedDependencyChecks, [
      { consumerAttemptId: "attempt-campaign", dependency: fixture.implementationArtifactDir }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers rejects property-campaign v2 bytes without converting them", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-campaign-v2-rejection-")));
  try {
    const artifactPath = path.join(root, "result.json");
    const legacyBytes = Buffer.from(
      `${JSON.stringify({ schema_version: "ultrafuzz.property-campaign.v2", fuzzer_backend: "recon", failures: [] })}\n`,
      "utf8"
    );
    fs.writeFileSync(artifactPath, legacyBytes);
    const task = singleOutputVerificationTask(root, "ultrafuzz/property-campaign@3");
    task.outputs[0]!.schemaFile = "property-campaign.schema.json";
    const harness = loadVerifyArtifactsHarness();
    const captured = harness.captureTaskOutputs(task);

    assert.throws(() => harness.verifyArtifacts(task, captured), /ultrafuzz\/property-campaign@3\): invalid/u);
    assert.equal(captured[0]?.file.bytes.equals(legacyBytes), true);
    assert.equal(fs.readFileSync(artifactPath).equals(legacyBytes), true);
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers fails closed when a contextual gate lacks verified ancestors", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-semantic-context-")));
  try {
    const contents = `${JSON.stringify({ schema_version: "ultrafuzz.properties.v2", properties: [] })}\n`;
    assert.equal(validateArtifactContract("ultrafuzz/properties@2", contents).ok, true);
    fs.writeFileSync(path.join(root, "result.json"), contents, "utf8");
    fs.writeFileSync(path.join(root, "result.md"), "# Canonical properties\n", "utf8");

    const task = singleOutputVerificationTask(root, "ultrafuzz/properties@2");
    task.outputs[0]!.schemaFile = "properties.schema.json";
    task.outputs.push({
      path: "result.md",
      contract: "ultrafuzz/nonempty-markdown@1",
      contractDigest: "b".repeat(64),
      primary: false
    });
    const harness = loadVerifyArtifactsHarness({ taskSpecs: [task] });

    assert.throws(
      () => harness.verifyArtifacts(task, harness.captureTaskOutputs(task)),
      /property-source-join requires trusted context: artifactSet\.propertyLenses/u
    );
    assert.equal(harness.publications.size, 0);
    assert.equal(harness.markerWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type ExactPairHarnessTask = {
  attemptId: string;
  metadata: { node: { logicalNodeId: string } };
  outputs: Array<{ path: string; contract: string }>;
};

function loadGeneratedExactPairResolvers(): {
  invariant(
    task: ExactPairHarnessTask
  ): { ledger: { path: string; contract: string }; markdown: { path: string; contract: string } } | undefined;
  properties(
    task: ExactPairHarnessTask
  ): { catalog: { path: string; contract: string }; markdown: { path: string; contract: string } } | undefined;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function declaredInvariantLedgerProducerPair");
  const helperEnd = source.indexOf("\n\nfunction declaredAncestorContractOutputs", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "INVARIANT_LEDGER_CONTRACT",
    "INVARIANT_LEDGER_CONVENTIONAL_PATH",
    "DISCOVERY_MARKDOWN_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_CONTRACT",
    "CANONICAL_PROPERTIES_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_MARKDOWN_CONTRACT",
    "CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH",
    `${emitted}; return { invariant: declaredInvariantLedgerProducerPair, properties: declaredCanonicalPropertiesPair };`
  )(
    "ultrafuzz/invariant-ledger@1",
    "setup/invariant-evidence-ledger.json",
    "setup/project-discovery.md",
    "ultrafuzz/properties@2",
    "properties.json",
    "ultrafuzz/nonempty-markdown@1",
    "properties.md"
  ) as ReturnType<typeof loadGeneratedExactPairResolvers>;
}

test("generated verifier derives discovery and canonical-property roles from exact typed declarations", () => {
  const resolve = loadGeneratedExactPairResolvers();
  const discovery: ExactPairHarnessTask = {
    attemptId: "renamed-discovery-attempt",
    metadata: { node: { logicalNodeId: "noncanonical-discovery-logical-id" } },
    outputs: [
      { path: "custom/evidence.json", contract: "ultrafuzz/invariant-ledger@1" },
      { path: "custom/discovery.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };
  const properties: ExactPairHarnessTask = {
    attemptId: "renamed-canonicalizer-attempt",
    metadata: { node: { logicalNodeId: "noncanonical-canonicalizer-logical-id" } },
    outputs: [
      { path: "custom/catalog.json", contract: "ultrafuzz/properties@2" },
      { path: "custom/catalog.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };

  assert.equal(resolve.invariant(discovery)?.ledger.path, "custom/evidence.json");
  assert.equal(resolve.invariant(discovery)?.markdown.path, "custom/discovery.md");
  assert.equal(resolve.properties(properties)?.catalog.path, "custom/catalog.json");
  assert.equal(resolve.properties(properties)?.markdown.path, "custom/catalog.md");
});

test("generated verifier rejects wrong-contract lookalikes and ambiguous typed discovery/property outputs", () => {
  const resolve = loadGeneratedExactPairResolvers();
  const task = (outputs: ExactPairHarnessTask["outputs"]): ExactPairHarnessTask => ({
    attemptId: "attempt",
    metadata: { node: { logicalNodeId: "renamed-role" } },
    outputs
  });

  assert.throws(
    () =>
      resolve.invariant(
        task([
          { path: "setup/invariant-evidence-ledger.json", contract: "ultrafuzz/text@1" },
          { path: "setup/project-discovery.md", contract: "ultrafuzz/nonempty-markdown@1" }
        ])
      ),
    /wrong-contract lookalike.*invariant-evidence-ledger\.json/iu
  );
  assert.throws(
    () =>
      resolve.invariant(
        task([
          { path: "custom/ledger.json", contract: "ultrafuzz/invariant-ledger@1" },
          { path: "setup/project-discovery.md", contract: "ultrafuzz/text@1" }
        ])
      ),
    /wrong-contract lookalike.*project-discovery\.md/iu
  );
  assert.throws(
    () =>
      resolve.invariant(
        task([
          { path: "custom/a.json", contract: "ultrafuzz/invariant-ledger@1" },
          { path: "custom/b.json", contract: "ultrafuzz/invariant-ledger@1" },
          { path: "custom/discovery.md", contract: "ultrafuzz/nonempty-markdown@1" }
        ])
      ),
    /exactly one ultrafuzz\/invariant-ledger@1.*found 2/iu
  );
  assert.throws(
    () =>
      resolve.properties(
        task([
          { path: "properties.json", contract: "ultrafuzz/text@1" },
          { path: "properties.md", contract: "ultrafuzz/nonempty-markdown@1" }
        ])
      ),
    /wrong-contract lookalike.*properties\.json/iu
  );
  assert.throws(
    () =>
      resolve.properties(
        task([
          { path: "custom/catalog.json", contract: "ultrafuzz/properties@2" },
          { path: "custom/a.md", contract: "ultrafuzz/nonempty-markdown@1" },
          { path: "custom/b.md", contract: "ultrafuzz/nonempty-markdown@1" }
        ])
      ),
    /exactly one ultrafuzz\/nonempty-markdown@1 companion.*found 2/iu
  );
  assert.throws(
    () =>
      resolve.properties(
        task([
          { path: "custom/catalog.json", contract: "ultrafuzz/properties@2" },
          { path: "custom/catalog.md", contract: "ultrafuzz/nonempty-markdown@1" },
          { path: "properties.md", contract: "ultrafuzz/text@1" }
        ])
      ),
    /wrong-contract lookalike.*properties\.md/iu
  );
});

function loadGeneratedCurrentPropertiesParity(): (
  task: ExactPairHarnessTask,
  verifiedOutputs: ReadonlyMap<string, { file: { path: string }; contents: string; value: unknown }>
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifyCanonicalPropertiesMarkdownPair");
  const helperEnd = source.indexOf("\n\nfunction verifyFinalReportCanonicalProjection", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const resolve = loadGeneratedExactPairResolvers();
  return new Function(
    "declaredCanonicalPropertiesPair",
    "validatePropertiesSchema",
    "formatSchemaValidationIssues",
    "canonicalPropertiesMarkdownParityIssues",
    `${emitted}; return verifyCanonicalPropertiesMarkdownPair;`
  )(
    resolve.properties,
    (value: unknown) => ({ ok: true, issues: [], value }),
    () => "invalid",
    canonicalPropertiesMarkdownParityIssues
  ) as ReturnType<typeof loadGeneratedCurrentPropertiesParity>;
}

test("generated verifier applies host-identical semantic parity to authenticated custom property snapshots", () => {
  const verify = loadGeneratedCurrentPropertiesParity();
  const task: ExactPairHarnessTask = {
    attemptId: "renamed-canonicalizer-attempt",
    metadata: { node: { logicalNodeId: "noncanonical-canonicalizer" } },
    outputs: [
      { path: "custom/catalog.json", contract: "ultrafuzz/properties@2" },
      { path: "custom/catalog.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };
  const catalog = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "renamed-lens", source_property_id: "lens-one" }],
        ledger_ids: ["evidence-one"]
      }
    ]
  };
  const validMarkdown = [
    '### Canonical property: "property-one"',
    'description: "Balances remain conserved."',
    'category: "accounting"',
    'priority: "high"',
    'sources: [{"source_node_id":"renamed-lens","source_property_id":"lens-one"}]',
    'ledger_ids: ["evidence-one"]',
    '### End canonical property: "property-one"'
  ].join("\n");
  const snapshots = (markdown: string) =>
    new Map<string, { file: { path: string }; contents: string; value: unknown }>([
      [
        "custom/catalog.json",
        { file: { path: "/run/custom/catalog.json" }, contents: JSON.stringify(catalog), value: catalog }
      ],
      ["custom/catalog.md", { file: { path: "/run/custom/catalog.md" }, contents: markdown, value: markdown }]
    ]);

  assert.doesNotThrow(() => verify(task, snapshots(validMarkdown)));
  assert.throws(
    () => verify(task, snapshots(validMarkdown.replace('priority: "high"\n', ""))),
    /PROPERTY_MARKDOWN_PARITY_MISSING.*priority/iu
  );
});

test("canonical property parity is exact and JSON-safe for every schema-valid delimiter", () => {
  const propertyId = "property,;\n`:/";
  const description = "Exact `description` | with\na second line";
  const category = "category,;`:/";
  const sources = [
    {
      source_node_id: "node,;\n`:/",
      source_property_id: "source-property,;\n`:/"
    }
  ];
  const referenceExpectations = ["expectation,;\n`:/"];
  const catalog: PropertiesArtifact = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: propertyId,
        description,
        category,
        priority: "high",
        sources,
        ledger_ids: ["evidence-one"],
        reference_expectations: referenceExpectations
      }
    ]
  };
  const markdown = [
    `### Canonical property: ${JSON.stringify(propertyId)}`,
    `description: ${JSON.stringify(description)}`,
    `category: ${JSON.stringify(category)}`,
    'priority: "high"',
    `sources: ${JSON.stringify(sources)}`,
    'ledger_ids: ["evidence-one"]',
    `reference_expectations: ${JSON.stringify(referenceExpectations)}`,
    `### End canonical property: ${JSON.stringify(propertyId)}`
  ].join("\n");
  assert.deepEqual(canonicalPropertiesMarkdownParityIssues(catalog, markdown, "properties.md"), []);

  for (const [field, expected] of [
    ["description", description],
    ["category", category],
    ["priority", "high"]
  ] as const) {
    const exactLine = `${field}: ${JSON.stringify(expected)}`;
    const altered = markdown.replace(exactLine, `${field}: ${JSON.stringify(`${expected} Ledger evidence: forged`)}`);
    assert.ok(
      canonicalPropertiesMarkdownParityIssues(catalog, altered, "properties.md").some(
        (issue) => issue.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && issue.message.includes(field)
      ),
      field
    );
  }

  const ambiguousSources = markdown.replace(
    `sources: ${JSON.stringify(sources)}`,
    `sources: ${sources[0]!.source_node_id}:${sources[0]!.source_property_id}`
  );
  assert.ok(
    canonicalPropertiesMarkdownParityIssues(catalog, ambiguousSources, "properties.md").some(
      (issue) => issue.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && issue.message.includes("sources")
    )
  );

  const reordered = markdown.replace(
    `description: ${JSON.stringify(description)}\ncategory: ${JSON.stringify(category)}`,
    `category: ${JSON.stringify(category)}\ndescription: ${JSON.stringify(description)}`
  );
  assert.ok(
    canonicalPropertiesMarkdownParityIssues(catalog, reordered, "properties.md").some(
      (issue) => issue.code === "PROPERTY_MARKDOWN_PARITY_MISSING" && issue.message.includes("field order")
    )
  );

  const blankLine = markdown.replace('priority: "high"', 'priority: "high"\n');
  assert.ok(
    canonicalPropertiesMarkdownParityIssues(catalog, blankLine, "properties.md").some(
      (issue) => issue.code === "PROPERTY_MARKDOWN_PARITY_MISSING"
    )
  );
});

test("canonical property parity rejects explicit empty optional Markdown arrays", () => {
  const catalog: PropertiesArtifact = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Exact description",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "lens", source_property_id: "source" }]
      }
    ]
  };
  const markdown = [
    '### Canonical property: "property-one"',
    'description: "Exact description"',
    'category: "accounting"',
    'priority: "high"',
    'sources: [{"source_node_id":"lens","source_property_id":"source"}]',
    "ledger_ids: []",
    "reference_expectations: []",
    '### End canonical property: "property-one"'
  ].join("\n");
  const issues = canonicalPropertiesMarkdownParityIssues(catalog, markdown, "properties.md");
  assert.ok(issues.some((issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA"));
  assert.ok(issues.some((issue) => issue.code === "PROPERTY_MARKDOWN_PARITY_EXTRA"));
});

test("invariant Markdown parity assigns exact fields and rejects duplicate or extra blocks", () => {
  const ledger: InvariantLedgerArtifact = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [
      {
        id: "evidence-one",
        source_path: "docs/source.md",
        source_location: "line 7",
        kind: "invariant",
        verbatim: "line 7",
        inventory_ids: ["inventory-one"]
      }
    ],
    inventory_rows: [{ id: "inventory-one", description: "Exact inventory row", ledger_ids: ["evidence-one"] }],
    scan_probes: []
  };
  const entryBlock = [
    '### Ledger entry: "evidence-one"',
    'source_path: "docs/source.md"',
    'source_location: "line 7"',
    'kind: "invariant"',
    'verbatim: "line 7"',
    'inventory_ids: ["inventory-one"]',
    '### End ledger entry: "evidence-one"'
  ].join("\n");
  const inventoryBlock = [
    '### Inventory row: "inventory-one"',
    'description: "Exact inventory row"',
    'ledger_ids: ["evidence-one"]',
    '### End inventory row: "inventory-one"'
  ].join("\n");
  const valid = `${entryBlock}\n${inventoryBlock}`;
  assert.deepEqual(invariantLedgerMarkdownParityIssues(ledger, valid, "discovery.md"), []);

  const crossedFields = valid
    .replace('source_path: "docs/source.md"', 'source_path: "line 7"')
    .replace('source_location: "line 7"', 'source_location: "docs/source.md"');
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, crossedFields, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"
    )
  );

  const reorderedFields = valid.replace(
    'source_path: "docs/source.md"\nsource_location: "line 7"',
    'source_location: "line 7"\nsource_path: "docs/source.md"'
  );
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, reorderedFields, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"
    )
  );

  const blankEntryLine = valid.replace('kind: "invariant"', 'kind: "invariant"\n');
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, blankEntryLine, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"
    )
  );

  const duplicate = `${valid}\n${entryBlock}`;
  const duplicateIssues = invariantLedgerMarkdownParityIssues(ledger, duplicate, "discovery.md");
  assert.ok(duplicateIssues.some((issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA"));
  assert.ok(duplicateIssues.some((issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"));

  const duplicateEntryField = valid.replace('kind: "invariant"', 'kind: "invariant"\nkind: "invariant"');
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, duplicateEntryField, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING"
    )
  );

  const duplicateInventoryField = valid.replace(
    'description: "Exact inventory row"',
    'description: "Exact inventory row"\ndescription: "Exact inventory row"'
  );
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, duplicateInventoryField, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_INVENTORY_MISSING"
    )
  );

  const extraEntry = `${valid}\n### Ledger entry: "evidence-extra"\nsource_path: "docs/source.md"\nsource_location: "line 7"\nkind: "invariant"\nverbatim: "line 7"\ninventory_ids: ["inventory-one"]\n### End ledger entry: "evidence-extra"`;
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, extraEntry, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA"
    )
  );

  const extraInventory = `${valid}\n### Inventory row: "inventory-extra"\ndescription: "extra"\nledger_ids: ["evidence-one"]\n### End inventory row: "inventory-extra"`;
  assert.ok(
    invariantLedgerMarkdownParityIssues(ledger, extraInventory, "discovery.md").some(
      (issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_INVENTORY_EXTRA"
    )
  );

  const emptyLedger = { ...ledger, entries: [], inventory_rows: [] };
  const unexpectedEmptyBlocks = invariantLedgerMarkdownParityIssues(emptyLedger, valid, "discovery.md");
  assert.ok(unexpectedEmptyBlocks.some((issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_EXTRA"));
  assert.ok(unexpectedEmptyBlocks.some((issue) => issue.code === "INVARIANT_LEDGER_MARKDOWN_INVENTORY_EXTRA"));
});

type PropertyLensHarnessProducer = {
  attemptId: string;
  artifactDir: string;
  dependencyArtifactDirs: string[];
  metadata: { node: { logicalNodeId: string }; dependencies: { attemptIds: string[] } };
  outputs: Array<{ path: string; contract: string }>;
};

type PropertyLensHarnessTask = PropertyLensHarnessProducer;

function loadVerifiedSingletonAncestorJsonArtifactHarness(
  taskSpecs: readonly PropertyLensHarnessProducer[],
  documents: ReadonlyMap<string, unknown>
): (
  task: PropertyLensHarnessTask,
  contract: string,
  label: string,
  options?: { directOnly?: boolean }
) => { path: string; value: unknown } | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function semanticArtifactTaskDeclarations");
  const helperEnd = source.indexOf("\n\nfunction configuredInvariantPrioritySelection", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "taskSpecs",
    "declaredAncestorOutputsByContract",
    "verifiedDependencyJsonArtifact",
    `${emitted}; return verifiedSingletonAncestorJsonArtifact;`
  )(
    path,
    taskSpecs,
    declaredAncestorOutputsByContract,
    (
      _task: unknown,
      dependency: string,
      producer: PropertyLensHarnessProducer,
      outputPath: string,
      contract: string
    ) => ({
      path: path.join(dependency, outputPath),
      value: documents.get(`${producer.attemptId}\u0000${contract}\u0000${outputPath}`)
    })
  ) as (
    task: PropertyLensHarnessTask,
    contract: string,
    label: string,
    options?: { directOnly?: boolean }
  ) => { path: string; value: unknown } | undefined;
}

test("generated Smithers resolves singleton JSON inputs by ancestor contract and custom path", () => {
  const producer = (attemptId: string, logicalNodeId: string, artifactPath: string): PropertyLensHarnessProducer => ({
    attemptId,
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: [],
    metadata: { node: { logicalNodeId }, dependencies: { attemptIds: [] } },
    outputs: [{ path: artifactPath, contract: "ultrafuzz/properties@2" }]
  });
  const selected = producer("catalog-current", "renamed-catalog", "custom/current-properties.json");
  const unrelated = producer("catalog-unrelated", "same-logical-name-is-irrelevant", "properties.json");
  const consumer: PropertyLensHarnessTask = {
    attemptId: "report-current",
    artifactDir: "/run/artifacts/report-current",
    dependencyArtifactDirs: [selected.artifactDir],
    metadata: { node: { logicalNodeId: "renamed-report" }, dependencies: { attemptIds: [selected.attemptId] } },
    outputs: []
  };
  const isolatedConsumer: PropertyLensHarnessTask = {
    ...consumer,
    attemptId: "report-isolated",
    artifactDir: "/run/artifacts/report-isolated",
    dependencyArtifactDirs: [],
    metadata: { ...consumer.metadata, dependencies: { attemptIds: [] } }
  };
  const document = { schema_version: "ultrafuzz.properties.v2", properties: [] };
  const resolve = loadVerifiedSingletonAncestorJsonArtifactHarness(
    [selected, unrelated, consumer, isolatedConsumer],
    new Map([[`${selected.attemptId}\u0000ultrafuzz/properties@2\u0000custom/current-properties.json`, document]])
  );

  assert.deepEqual(resolve(consumer, "ultrafuzz/properties@2", "canonical property catalog"), {
    path: "custom/current-properties.json",
    value: document
  });
  assert.equal(resolve(isolatedConsumer, "ultrafuzz/properties@2", "canonical property catalog"), undefined);
});

function loadVerifiedCanonicalPropertyCatalogHarness(
  taskSpecs: readonly PropertyLensHarnessProducer[],
  documents: ReadonlyMap<string, unknown>,
  markdownDocuments: ReadonlyMap<string, string>
): (task: PropertyLensHarnessTask) => { path: string; value: unknown } | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function semanticArtifactTaskDeclarations");
  const helperEnd = source.indexOf("\n\nfunction declaredFinalReportOutputPair", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "taskSpecs",
    "declaredAncestorOutputsByContract",
    "verifiedDependencyJsonArtifact",
    "verifiedDependencyTextArtifact",
    "assertVerifiedDependency",
    "validatePropertiesSchema",
    "formatSchemaValidationIssues",
    "canonicalPropertiesMarkdownParityIssues",
    "INVARIANT_LEDGER_CONTRACT",
    "INVARIANT_LEDGER_CONVENTIONAL_PATH",
    "DISCOVERY_MARKDOWN_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_CONTRACT",
    "CANONICAL_PROPERTIES_CONVENTIONAL_PATH",
    "CANONICAL_PROPERTIES_MARKDOWN_CONTRACT",
    "CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH",
    `${emitted}; return verifiedCanonicalPropertyCatalog;`
  )(
    path,
    taskSpecs,
    declaredAncestorOutputsByContract,
    (
      _task: unknown,
      _dependency: string,
      producer: PropertyLensHarnessProducer,
      outputPath: string,
      _contract: string
    ) => {
      const value = documents.get(`${producer.attemptId}\u0000${outputPath}`);
      return {
        path: `/run/${producer.attemptId}/${outputPath}`,
        relativePath: outputPath,
        bytes: Buffer.from(JSON.stringify(value), "utf8"),
        value
      };
    },
    (
      _task: unknown,
      _dependency: string,
      producer: PropertyLensHarnessProducer,
      outputPath: string,
      _contract: string
    ) => {
      const contents = markdownDocuments.get(`${producer.attemptId}\u0000${outputPath}`) ?? "";
      return {
        path: `/run/${producer.attemptId}/${outputPath}`,
        relativePath: outputPath,
        bytes: Buffer.from(contents, "utf8"),
        contents
      };
    },
    (_task: unknown, _dependency: string, captured: unknown) => {
      assert.ok(Array.isArray(captured));
      assert.equal(captured.length, 2);
    },
    (value: unknown) => ({ ok: true, issues: [], value }),
    () => "invalid",
    canonicalPropertiesMarkdownParityIssues,
    "ultrafuzz/invariant-ledger@1",
    "setup/invariant-evidence-ledger.json",
    "setup/project-discovery.md",
    "ultrafuzz/properties@2",
    "properties.json",
    "ultrafuzz/nonempty-markdown@1",
    "properties.md"
  ) as (task: PropertyLensHarnessTask) => { path: string; value: unknown } | undefined;
}

test("generated canonical-property consumers authenticate one same-producer custom JSON/Markdown pair", () => {
  const catalog: PropertyLensHarnessProducer = {
    attemptId: "catalog-attempt",
    artifactDir: "/run/artifacts/catalog-attempt",
    dependencyArtifactDirs: [],
    metadata: { node: { logicalNodeId: "renamed-catalog" }, dependencies: { attemptIds: [] } },
    outputs: [
      { path: "custom/catalog.json", contract: "ultrafuzz/properties@2" },
      { path: "custom/catalog.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };
  const consumer: PropertyLensHarnessTask = {
    attemptId: "consumer-attempt",
    artifactDir: "/run/artifacts/consumer-attempt",
    dependencyArtifactDirs: [catalog.artifactDir],
    metadata: { node: { logicalNodeId: "renamed-consumer" }, dependencies: { attemptIds: [catalog.attemptId] } },
    outputs: []
  };
  const document = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "renamed-lens", source_property_id: "lens-one" }]
      }
    ]
  };
  const markdown = [
    '### Canonical property: "property-one"',
    'description: "Balances remain conserved."',
    'category: "accounting"',
    'priority: "high"',
    'sources: [{"source_node_id":"renamed-lens","source_property_id":"lens-one"}]',
    '### End canonical property: "property-one"'
  ].join("\n");
  const resolve = loadVerifiedCanonicalPropertyCatalogHarness(
    [catalog, consumer],
    new Map([["catalog-attempt\u0000custom/catalog.json", document]]),
    new Map([["catalog-attempt\u0000custom/catalog.md", markdown]])
  );

  assert.deepEqual(resolve(consumer), { path: "custom/catalog.json", value: document });

  catalog.outputs.push({ path: "properties.md", contract: "ultrafuzz/text@1" });
  const rejectLookalike = loadVerifiedCanonicalPropertyCatalogHarness(
    [catalog, consumer],
    new Map([["catalog-attempt\u0000custom/catalog.json", document]]),
    new Map([["catalog-attempt\u0000custom/catalog.md", markdown]])
  );
  assert.throws(() => rejectLookalike(consumer), /wrong-contract lookalike.*properties\.md/iu);
});

test("generated severity authority excludes unrelated transitive triaged outputs", () => {
  const producer = (
    attemptId: string,
    outputPath: string,
    dependencies: readonly PropertyLensHarnessProducer[] = []
  ): PropertyLensHarnessProducer => ({
    attemptId,
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: dependencies.map((dependency) => dependency.artifactDir),
    metadata: {
      node: { logicalNodeId: `renamed-${attemptId}` },
      dependencies: { attemptIds: dependencies.map((dependency) => dependency.attemptId) }
    },
    outputs: [{ path: outputPath, contract: "ultrafuzz/triaged-findings@1" }]
  });
  const transitive = producer("triaged-transitive", "custom/transitive-triaged.json");
  const direct = producer("triaged-direct", "custom/direct-triaged.json", [transitive]);
  const severity: PropertyLensHarnessTask = {
    attemptId: "severity-current",
    artifactDir: "/run/artifacts/severity-current",
    dependencyArtifactDirs: [transitive.artifactDir, direct.artifactDir],
    metadata: {
      node: { logicalNodeId: "renamed-severity" },
      dependencies: { attemptIds: [direct.attemptId] }
    },
    outputs: []
  };
  const directDocument = [{ id: "direct" }];
  const transitiveDocument = [{ id: "transitive" }];
  const resolve = loadVerifiedSingletonAncestorJsonArtifactHarness(
    [transitive, direct, severity],
    new Map([
      [`${direct.attemptId}\u0000ultrafuzz/triaged-findings@1\u0000custom/direct-triaged.json`, directDocument],
      [
        `${transitive.attemptId}\u0000ultrafuzz/triaged-findings@1\u0000custom/transitive-triaged.json`,
        transitiveDocument
      ]
    ])
  );

  assert.deepEqual(resolve(severity, "ultrafuzz/triaged-findings@1", "triaged findings", { directOnly: true }), {
    path: "custom/direct-triaged.json",
    value: directDocument
  });
  assert.throws(
    () => resolve(severity, "ultrafuzz/triaged-findings@1", "triaged findings"),
    /must resolve to exactly one declared ultrafuzz\/triaged-findings@1 ancestor output; found 2/u
  );
});

function loadProducerFreeSemanticContextHarness(): (
  task: {
    metadata: { run: { ultrafuzzRunId: string }; node: { logicalNodeId: string } };
  },
  output: { path: string; schemaFile: string },
  verifiedOutputs: ReadonlyMap<string, { artifactRoot: string }>
) => {
  artifactSet?: {
    campaignSummary?: unknown;
    campaignSummaryPath?: string;
    propertyCatalog?: unknown;
    implementedProperties?: unknown;
  };
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function semanticGateContextForVerifiedOutput");
  const helperEnd = source.indexOf("\n\nfunction verifyOutputSemanticGates", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "verifiedSingletonAncestorJsonArtifact",
    "verifiedCanonicalPropertyCatalog",
    "UNPLANNED_PROPERTY_CATALOG_CONTEXT",
    "UNPLANNED_IMPLEMENTED_PROPERTIES_CONTEXT",
    "siblingCampaignSemanticArtifacts",
    "verifiedAncestorPropertyLenses",
    "verifiedFinalSeverityReviewAuthority",
    "workspacePatchSemanticGitContext",
    `${emitted}; return semanticGateContextForVerifiedOutput;`
  )(
    () => undefined,
    () => undefined,
    { schema_version: PROPERTIES_SCHEMA_VERSION, properties: [] },
    {
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    },
    () => ({}),
    () => undefined,
    () => ({ severityClassifiedFindings: null }),
    () => undefined
  ) as ReturnType<typeof loadProducerFreeSemanticContextHarness>;
}

test("generated semantic contexts match host semantics when property producers are deliberately absent", () => {
  const contextFor = loadProducerFreeSemanticContextHarness();
  const task = {
    metadata: { run: { ultrafuzzRunId: "run-no-property-track" }, node: { logicalNodeId: "custom-report" } }
  };
  const verifiedOutputs = new Map([["custom/report.json", { artifactRoot: "/run/artifacts/custom-report" }]]);

  const report = contextFor(task, { path: "custom/report.json", schemaFile: "report.schema.json" }, verifiedOutputs);
  assert.deepEqual(report.artifactSet, {
    campaignSummary: null,
    propertyCatalog: { schema_version: PROPERTIES_SCHEMA_VERSION, properties: [] },
    implementedProperties: {
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    },
    severityClassifiedFindings: null
  });

  const implementation = contextFor(
    task,
    { path: "custom/report.json", schemaFile: "implemented-properties.schema.json" },
    verifiedOutputs
  );
  assert.deepEqual(implementation.artifactSet, {
    propertyCatalog: { schema_version: PROPERTIES_SCHEMA_VERSION, properties: [] }
  });
});

function loadVerifiedAncestorPropertyLensesHarness(
  taskSpecs: readonly PropertyLensHarnessProducer[],
  documents: ReadonlyMap<string, unknown>
): (
  task: PropertyLensHarnessTask
) => Array<{ sourceNodeId: string; projectionRequired: boolean; document: unknown }> | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifiedAncestorPropertyLenses");
  const helperEnd = source.indexOf("\n\nfunction workspacePatchSemanticGitContext", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "taskSpecs",
    "verifiedDependencyJsonArtifact",
    "verifiedDependencyTextArtifact",
    "assertVerifiedDependency",
    "validateInvariantLedgerSchema",
    "formatSchemaValidationIssues",
    "invariantLedgerMarkdownParityIssues",
    "isPlainJsonRecord",
    "declaredAncestorContractOutputs",
    "declaredInvariantLedgerProducerPair",
    `${emitted}; return verifiedAncestorPropertyLenses;`
  )(
    path,
    taskSpecs,
    (_task: unknown, _dependency: string, producer: { attemptId: string }, outputPath: string, _contract: string) => {
      const value = documents.get(`${producer.attemptId}\u0000${outputPath}`);
      return {
        path: `/run/${producer.attemptId}/${outputPath}`,
        relativePath: outputPath,
        bytes: Buffer.from(JSON.stringify(value), "utf8"),
        value
      };
    },
    (
      _task: unknown,
      _dependency: string,
      producer: PropertyLensHarnessProducer,
      outputPath: string,
      _contract: string
    ) => {
      const ledgerOutput = producer.outputs.find((output) => output.contract === "ultrafuzz/invariant-ledger@1");
      assert.ok(ledgerOutput);
      const ledger = documents.get(`${producer.attemptId}\u0000${ledgerOutput.path}`) as {
        entries: Array<{
          id: string;
          source_path: string;
          source_location: string;
          kind: string;
          verbatim: string;
          inventory_ids: string[];
        }>;
        inventory_rows?: Array<{ id: string; description: string; ledger_ids: string[] }>;
      };
      const lines = ledger.entries.flatMap((entry) => [
        `### Ledger entry: ${JSON.stringify(entry.id)}`,
        `source_path: ${JSON.stringify(entry.source_path)}`,
        `source_location: ${JSON.stringify(entry.source_location)}`,
        `kind: ${JSON.stringify(entry.kind)}`,
        `verbatim: ${JSON.stringify(entry.verbatim)}`,
        `inventory_ids: ${JSON.stringify(entry.inventory_ids)}`,
        `### End ledger entry: ${JSON.stringify(entry.id)}`
      ]);
      for (const row of ledger.inventory_rows ?? []) {
        lines.push(
          `### Inventory row: ${JSON.stringify(row.id)}`,
          `description: ${JSON.stringify(row.description)}`,
          `ledger_ids: ${JSON.stringify(row.ledger_ids)}`,
          `### End inventory row: ${JSON.stringify(row.id)}`
        );
      }
      const contents = lines.join("\n");
      return {
        path: `/run/${producer.attemptId}/${outputPath}`,
        relativePath: outputPath,
        bytes: Buffer.from(contents, "utf8"),
        contents
      };
    },
    (_task: unknown, _dependency: string, captured: unknown) => {
      assert.ok(Array.isArray(captured));
      assert.equal(captured.length, 2);
    },
    (value: unknown) => ({ ok: true, issues: [], value }),
    () => "invalid",
    invariantLedgerMarkdownParityIssues,
    (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
    (task: PropertyLensHarnessTask, contract: string, options: { directOnly?: boolean } = {}) => {
      const declarations = taskSpecs.map((candidate) => ({
        attemptId: candidate.attemptId,
        logicalNodeId: candidate.metadata.node.logicalNodeId,
        artifactDir: candidate.artifactDir,
        dependencies: candidate.metadata.dependencies.attemptIds,
        dependencyArtifactDirs: candidate.dependencyArtifactDirs,
        outputs: candidate.outputs
      }));
      const current = declarations.find((candidate) => candidate.attemptId === task.attemptId);
      assert.ok(current);
      return declaredAncestorOutputsByContract(current, declarations, contract, options);
    },
    (producer: PropertyLensHarnessProducer) => {
      const ledger = producer.outputs.filter((output) => output.contract === "ultrafuzz/invariant-ledger@1");
      const markdown = producer.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
      if (ledger.length !== 1 || markdown.length !== 1) throw new Error("invalid invariant producer pair");
      return { ledger: ledger[0], markdown: markdown[0] };
    }
  ) as (
    task: PropertyLensHarnessTask
  ) => Array<{ sourceNodeId: string; projectionRequired: boolean; document: unknown }> | undefined;
}

test("generated Smithers accepts direct lenses, excludes transitive lenses, and projects a renamed ledger", () => {
  const producer = (
    attemptId: string,
    logicalNodeId: string,
    contract: string,
    outputPath: string
  ): PropertyLensHarnessProducer => ({
    attemptId,
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: [],
    metadata: { node: { logicalNodeId }, dependencies: { attemptIds: [] } },
    outputs: [{ path: outputPath, contract }]
  });
  const ledgerProducer = producer(
    "attempt-ledger",
    "custom-evidence-root",
    "ultrafuzz/invariant-ledger@1",
    "custom/ledger.json"
  );
  ledgerProducer.outputs.push({ path: "custom/discovery.md", contract: "ultrafuzz/nonempty-markdown@1" });
  const producers = [
    ledgerProducer,
    producer("attempt-direct", "direct-review", "ultrafuzz/property-lens@2", "custom/direct.json"),
    producer("attempt-transitive", "transitive-review", "ultrafuzz/property-lens@2", "custom/transitive.json")
  ];
  const consumer: PropertyLensHarnessProducer = {
    attemptId: "attempt-consumer",
    artifactDir: "/run/artifacts/attempt-consumer",
    dependencyArtifactDirs: producers.map((candidate) => candidate.artifactDir),
    metadata: {
      node: { logicalNodeId: "property-fanin" },
      dependencies: { attemptIds: ["attempt-direct"] }
    },
    outputs: []
  };
  const taskSpecs = [...producers, consumer];
  const documents = new Map<string, unknown>([
    [
      "attempt-ledger\u0000custom/ledger.json",
      {
        schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
        entries: [
          {
            id: "evidence-one",
            source_path: "docs/source.md",
            source_location: "line 1",
            kind: "invariant",
            verbatim: "source",
            inventory_ids: []
          }
        ],
        inventory_rows: [],
        scan_probes: []
      }
    ],
    ["attempt-direct\u0000custom/direct.json", { properties: [{ id: "direct-one" }] }],
    ["attempt-transitive\u0000custom/transitive.json", { properties: [{ id: "transitive-one" }] }]
  ]);
  const resolve = loadVerifiedAncestorPropertyLensesHarness(taskSpecs, documents);
  const result = resolve(consumer);

  assert.deepEqual(result, [
    {
      sourceNodeId: "custom-evidence-root",
      projectionRequired: false,
      document: { properties: [{ id: "evidence-one" }] }
    },
    {
      sourceNodeId: "direct-review",
      projectionRequired: true,
      document: { properties: [{ id: "direct-one" }] }
    }
  ]);
});

test("generated Smithers selects property and discovery inputs by their declared contracts", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifiedAncestorPropertyLenses");
  const helperEnd = source.indexOf("\n\nfunction workspacePatchSemanticGitContext", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /declaredAncestorContractOutputs/u);
  assert.match(helper, /"ultrafuzz\/property-lens@2", \{/u);
  assert.match(helper, /directOnly: true/u);
  assert.match(helper, /seenLensProducers/u);
  assert.doesNotMatch(helper, /logicalNodeId\.startsWith\("property-specification-"\)/u);
  assert.match(helper, /declaredInvariantLedgerProducerPair/u);
  assert.match(helper, /"ultrafuzz\/invariant-ledger@1"/u);
  assert.doesNotMatch(helper, /logicalNodeId === "project-discovery"/u);
  assert.match(helper, /output\.artifactDir/u);
  assert.match(helper, /projectionRequired: false/u);
  assert.match(helper, /projectionRequired: true/u);
  assert.doesNotMatch(helper, /setup\/invariant-evidence-ledger\.json/u);
  assert.doesNotMatch(helper, /\bcatch\b/u);

  const singletonStart = source.indexOf("function semanticArtifactTaskDeclarations");
  const singletonEnd = source.indexOf("\n\nfunction configuredInvariantPrioritySelection", singletonStart);
  assert.ok(singletonStart >= 0 && singletonEnd > singletonStart, source);
  const singleton = source.slice(singletonStart, singletonEnd);
  assert.match(singleton, /declaredAncestorOutputsByContract/u);
  assert.doesNotMatch(singleton, /property-specification-fanin|stateful-invariant-implement-properties/u);
  assert.doesNotMatch(singleton, /properties\.json|implemented-properties\.json/u);

  const coverageStart = source.indexOf("function authoritativeFinalReportCoverage");
  const coverageEnd = source.indexOf("\n\nfunction promptWithAuthoritativeFinalReportCoverage", coverageStart);
  assert.ok(coverageStart >= 0 && coverageEnd > coverageStart, source);
  const coverage = source.slice(coverageStart, coverageEnd);
  assert.match(coverage, /verifiedCanonicalPropertyCatalog/u);
  assert.match(coverage, /"ultrafuzz\/implemented-properties@3"/u);
  assert.doesNotMatch(coverage, /property-specification-fanin|stateful-invariant-implement-properties/u);

  const companionStart = source.indexOf("function materializeInvariantSuiteCompanions");
  const companionEnd = source.indexOf("\n\nfunction resetInvariantSuiteArtifactRoot", companionStart);
  assert.ok(companionStart >= 0 && companionEnd > companionStart, source);
  const companion = source.slice(companionStart, companionEnd);
  assert.match(companion, /output\.contract === "ultrafuzz\/implemented-properties@3"/u);
  assert.doesNotMatch(companion, /output\.path === "implemented-properties\.json"/u);

  const expectationsStart = source.indexOf("function assertInvariantSuiteDependencyExpectations");
  const expectationsEnd = source.indexOf("function reconcileInvariantSuiteWorkspace", expectationsStart);
  assert.ok(expectationsStart >= 0 && expectationsEnd > expectationsStart, source);
  const expectations = source.slice(expectationsStart, expectationsEnd);
  assert.match(expectations, /verifiedDependencyJsonArtifact/u);
  assert.match(expectations, /output\.contract === "ultrafuzz\/implemented-properties@3"/u);
  assert.doesNotMatch(expectations, /path\.join\(dependencyRoot, "implemented-properties\.json"\)/u);
});

test("generated severity verification authenticates the triaged finding preservation context", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function semanticGateContextForVerifiedOutput");
  const helperEnd = source.indexOf("\n\nfunction verifyOutputSemanticGates", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /output\.schemaFile === "severity-classified-findings\.schema\.json"/u);
  assert.match(
    helper,
    /verifiedSingletonAncestorJsonArtifact\(\s*task,\s*"ultrafuzz\/triaged-findings@1",\s*"triaged findings",\s*\{ directOnly: true \}\s*\)/u
  );
  assert.doesNotMatch(helper, /"triage"|"triaged-findings\.json"/u);
  assert.match(helper, /\{ triagedFindings: triagedFindings\.value \}/u);
});

function loadGeneratedReviewContextProjectionHarness(): (
  task: {
    attemptId: string;
    metadata: { run: { ultrafuzzRunId: string }; node: { logicalNodeId: string } };
  },
  output: { path: string; schemaFile: string },
  verifiedOutputs: ReadonlyMap<string, { artifactRoot: string }>
) => { artifactSet?: Record<string, unknown> } {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function semanticGateContextForVerifiedOutput");
  const helperEnd = source.indexOf("\n\nfunction verifyOutputSemanticGates", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const dedupedFindings = [{ id: "deduped" }];
  const triagedFindings = [{ id: "triaged" }];
  const reviewStage = {
    stage: "triage",
    findingsArtifactPath: "custom/triaged.json",
    findings: triagedFindings,
    lifecycleLedger: { records: [] },
    upstreamLifecycleLedger: { records: [] }
  };
  const finalAuthority = {
    severityClassifiedFindings: [{ id: "severity" }],
    findingLifecycleLedger: { records: [{ dedupe_key: "one" }] }
  };
  return new Function(
    "verifiedSingletonAncestorJsonArtifact",
    "verifiedCanonicalPropertyCatalog",
    "UNPLANNED_PROPERTY_CATALOG_CONTEXT",
    "UNPLANNED_IMPLEMENTED_PROPERTIES_CONTEXT",
    "reviewStageSemanticContext",
    "verifiedFinalSeverityReviewAuthority",
    "siblingCampaignSemanticArtifacts",
    "verifiedAncestorPropertyLenses",
    "workspacePatchSemanticGitContext",
    `${emitted}; return semanticGateContextForVerifiedOutput;`
  )(
    (_task: unknown, contract: string) => {
      if (contract === "ultrafuzz/findings@2") return { path: "custom/deduped.json", value: dedupedFindings };
      if (contract === "ultrafuzz/triaged-findings@1") {
        return { path: "custom/triaged.json", value: triagedFindings };
      }
      if (contract === "ultrafuzz/campaign-summary@2") {
        return {
          path: "custom/campaign-summary.json",
          value: { outcome: "blocked", reason: "recon was unavailable" }
        };
      }
      return undefined;
    },
    () => undefined,
    { schema_version: PROPERTIES_SCHEMA_VERSION, properties: [] },
    {
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    },
    () => reviewStage,
    () => finalAuthority,
    () => ({}),
    () => undefined,
    () => undefined
  ) as ReturnType<typeof loadGeneratedReviewContextProjectionHarness>;
}

test("generated semantic context projects every required review authority field", () => {
  const contextFor = loadGeneratedReviewContextProjectionHarness();
  const task = {
    attemptId: "attempt-review",
    metadata: { run: { ultrafuzzRunId: "run-review" }, node: { logicalNodeId: "renamed-review" } }
  };
  const verifiedOutputs = new Map([["custom/output.json", { artifactRoot: "/mirror/review" }]]);
  const context = (schemaFile: string) =>
    contextFor(task, { path: "custom/output.json", schemaFile }, verifiedOutputs).artifactSet;

  assert.deepEqual(context("triaged-findings.schema.json"), { dedupedFindings: [{ id: "deduped" }] });
  assert.deepEqual(context("severity-classified-findings.schema.json"), {
    triagedFindings: [{ id: "triaged" }]
  });
  for (const schemaFile of ["finding-lifecycle-ledger.schema.json", "strategy-detections.schema.json"]) {
    assert.deepEqual(context(schemaFile), {
      reviewStage: {
        stage: "triage",
        findingsArtifactPath: "custom/triaged.json",
        findings: [{ id: "triaged" }],
        lifecycleLedger: { records: [] },
        upstreamLifecycleLedger: { records: [] }
      }
    });
  }
  assert.deepEqual(context("report.schema.json"), {
    campaignSummary: { outcome: "blocked", reason: "recon was unavailable" },
    campaignSummaryPath: "custom/campaign-summary.json",
    propertyCatalog: { schema_version: PROPERTIES_SCHEMA_VERSION, properties: [] },
    implementedProperties: {
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    },
    severityClassifiedFindings: [{ id: "severity" }],
    findingLifecycleLedger: { records: [{ dedupe_key: "one" }] }
  });
});

type ReviewAuthorityHarnessOutput = { path: string; contract: string };
type ReviewAuthorityHarnessTask = {
  attemptId: string;
  artifactDir: string;
  dependencyArtifactDirs: string[];
  metadata: {
    node: { logicalNodeId: string };
    dependencies: { attemptIds: string[] };
  };
  outputs: ReviewAuthorityHarnessOutput[];
};
type ReviewAuthoritySnapshot = { file: { path: string }; value: unknown };

function reviewAuthorityDocumentKey(
  producer: ReviewAuthorityHarnessTask,
  outputPath: string,
  contract: string
): string {
  return `${producer.attemptId}\u0000${contract}\u0000${outputPath}`;
}

function loadGeneratedReviewAuthorityHarness(
  taskSpecs: readonly ReviewAuthorityHarnessTask[],
  documents: ReadonlyMap<string, unknown>
): {
  reviewStage: (
    task: ReviewAuthorityHarnessTask,
    verifiedOutputs: ReadonlyMap<string, ReviewAuthoritySnapshot>
  ) => {
    stage: "dedupe" | "triage" | "severity-classification";
    findingsArtifactPath: string;
    findings: unknown;
    lifecycleLedger: unknown;
    strategyDetections?: unknown;
    upstreamLifecycleLedger?: unknown;
    upstreamStrategyDetections?: unknown;
  };
  finalSeverity: (task: ReviewAuthorityHarnessTask) => {
    severityClassifiedFindings: unknown | null;
    findingLifecycleLedger?: unknown;
  };
  authenticatedReads: Array<{ producer: string; path: string; contract: string }>;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const singletonStart = source.indexOf("function verifiedSingletonAncestorJsonArtifact");
  const singletonEnd = source.indexOf("\n\nfunction declaredFinalReportOutputPair", singletonStart);
  const siblingStart = source.indexOf("function verifiedSiblingJsonArtifact");
  const siblingEnd = source.indexOf("\n\nfunction siblingDynamicStrategySemanticArtifacts", siblingStart);
  const reviewStart = source.indexOf("type ReviewStageSemanticContext");
  const reviewEnd = source.indexOf("\n\ntype DifferentialSemanticArtifactBinding", reviewStart);
  assert.ok(singletonStart >= 0 && singletonEnd > singletonStart, source);
  assert.ok(siblingStart >= 0 && siblingEnd > siblingStart, source);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, source);
  const emitted = ts.transpileModule(
    [
      source.slice(singletonStart, singletonEnd),
      source.slice(siblingStart, siblingEnd),
      source.slice(reviewStart, reviewEnd)
    ].join("\n\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const declarations = taskSpecs.map((candidate) => ({
    attemptId: candidate.attemptId,
    logicalNodeId: candidate.metadata.node.logicalNodeId,
    artifactDir: candidate.artifactDir,
    dependencies: candidate.metadata.dependencies.attemptIds,
    dependencyArtifactDirs: candidate.dependencyArtifactDirs,
    outputs: candidate.outputs
  }));
  const declaredAncestorContractOutputs = (
    task: ReviewAuthorityHarnessTask,
    contract: string,
    options: { directOnly?: boolean } = {}
  ) => {
    const current = declarations.find((candidate) => candidate.attemptId === task.attemptId);
    assert.ok(current);
    return declaredAncestorOutputsByContract(current, declarations, contract, options);
  };
  const authenticatedReads: Array<{ producer: string; path: string; contract: string }> = [];
  const verifiedDependencyJsonArtifact = (
    _task: ReviewAuthorityHarnessTask,
    _artifactDir: string,
    producer: ReviewAuthorityHarnessTask,
    outputPath: string,
    contract: string
  ) => {
    const declared = producer.outputs.filter((output) => output.path === outputPath && output.contract === contract);
    if (declared.length !== 1) throw new Error("authenticated dependency declaration mismatch");
    const key = reviewAuthorityDocumentKey(producer, outputPath, contract);
    if (!documents.has(key)) throw new Error(`authenticated dependency unavailable ${key}`);
    const value = documents.get(key);
    if (value instanceof Error) throw value;
    authenticatedReads.push({ producer: producer.attemptId, path: outputPath, contract });
    return { path: outputPath, relativePath: outputPath, value };
  };
  const loaded = new Function(
    "taskSpecs",
    "declaredAncestorContractOutputs",
    "verifiedDependencyJsonArtifact",
    `${emitted}; return { reviewStage: reviewStageSemanticContext, finalSeverity: verifiedFinalSeverityReviewAuthority };`
  )(taskSpecs, declaredAncestorContractOutputs, verifiedDependencyJsonArtifact) as {
    reviewStage: ReturnType<typeof loadGeneratedReviewAuthorityHarness>["reviewStage"];
    finalSeverity: ReturnType<typeof loadGeneratedReviewAuthorityHarness>["finalSeverity"];
  };
  return { ...loaded, authenticatedReads };
}

test("generated review authority uses declared relative identity across snapshot publication relocation", () => {
  const task = (
    attemptId: string,
    directDependencies: readonly ReviewAuthorityHarnessTask[],
    ancestorClosure: readonly ReviewAuthorityHarnessTask[],
    outputs: ReviewAuthorityHarnessOutput[]
  ): ReviewAuthorityHarnessTask => ({
    attemptId,
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: ancestorClosure.map((ancestor) => ancestor.artifactDir),
    metadata: {
      node: { logicalNodeId: `renamed-${attemptId}` },
      dependencies: { attemptIds: directDependencies.map((dependency) => dependency.attemptId) }
    },
    outputs
  });
  const dedupe = task(
    "attempt-dedupe",
    [],
    [],
    [
      { path: "custom/deduped.json", contract: "ultrafuzz/findings@2" },
      { path: "custom/detections.json", contract: "ultrafuzz/strategy-detections@1" },
      { path: "custom/dedupe-ledger.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" }
    ]
  );
  const triage = task(
    "attempt-triage",
    [dedupe],
    [dedupe],
    [
      { path: "custom/triaged.json", contract: "ultrafuzz/triaged-findings@1" },
      { path: "custom/triage-ledger.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" }
    ]
  );
  const severity = task(
    "attempt-severity",
    [triage],
    [triage, dedupe],
    [
      { path: "custom/severity.json", contract: "ultrafuzz/severity-classified-findings@1" },
      { path: "custom/severity-detections.json", contract: "ultrafuzz/strategy-detections@1" },
      { path: "custom/severity-ledger.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" }
    ]
  );
  const unrelatedLedger = task(
    "attempt-unrelated-ledger",
    [],
    [],
    [{ path: "other/ledger.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" }]
  );
  const report = task(
    "attempt-report",
    [severity],
    [severity, unrelatedLedger, triage, dedupe],
    [{ path: "deliverables/report.json", contract: "ultrafuzz/report@3" }]
  );
  const documents = new Map<string, unknown>();
  const remember = (producer: ReviewAuthorityHarnessTask, outputPath: string, contract: string, value: unknown) => {
    documents.set(reviewAuthorityDocumentKey(producer, outputPath, contract), value);
  };
  const dedupedFindings = [{ id: "finding-dedupe", dedupe_key: "key-one" }];
  const dedupeLedger = {
    records: [
      {
        dedupe_key: "key-one",
        source_artifacts: [{ path: "custom/raw.json", finding_id: "raw-finding" }],
        strategy_hits: [],
        stages: [
          { stage: "raw", artifact_path: "custom/raw.json", finding_id: "raw-finding" },
          { stage: "deduped", artifact_path: "custom/deduped.json", finding_id: "finding-dedupe" }
        ]
      }
    ]
  };
  const dedupeDetections = [{ finding_id: "finding-dedupe" }];
  const triagedFindings = [{ id: "finding-triage" }];
  const triageLedger = { records: [{ dedupe_key: "key-one", triage_classification: "true-positive" }] };
  const severityFindings = [{ id: "finding-severity", severity: "High" }];
  const severityLedger = { records: [{ dedupe_key: "key-one", final_disposition: "promoted" }] };
  const severityDetections = [{ finding_id: "finding-dedupe" }];
  remember(dedupe, "custom/dedupe-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", dedupeLedger);
  remember(dedupe, "custom/detections.json", "ultrafuzz/strategy-detections@1", dedupeDetections);
  remember(triage, "custom/triage-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", triageLedger);
  remember(severity, "custom/severity.json", "ultrafuzz/severity-classified-findings@1", severityFindings);
  remember(severity, "custom/severity-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", severityLedger);
  remember(unrelatedLedger, "other/ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", { records: [] });
  const harness = loadGeneratedReviewAuthorityHarness([dedupe, triage, severity, unrelatedLedger, report], documents);
  const snapshots = (...entries: Array<[string, string, unknown]>) =>
    new Map(entries.map(([outputPath, artifactPath, value]) => [outputPath, { file: { path: artifactPath }, value }]));

  const mirrorDedupeContext = harness.reviewStage(
    dedupe,
    snapshots(
      ["custom/deduped.json", "/mirror/dedupe/custom/deduped.json", dedupedFindings],
      ["custom/detections.json", "/mirror/dedupe/custom/detections.json", dedupeDetections],
      ["custom/dedupe-ledger.json", "/mirror/dedupe/custom/dedupe-ledger.json", dedupeLedger]
    )
  );
  assert.deepEqual(mirrorDedupeContext, {
    stage: "dedupe",
    findingsArtifactPath: "custom/deduped.json",
    findings: dedupedFindings,
    lifecycleLedger: dedupeLedger,
    strategyDetections: dedupeDetections
  });
  const publishedDedupeContext = harness.reviewStage(
    dedupe,
    snapshots(
      ["custom/deduped.json", "/run/artifacts/attempt-dedupe/custom/deduped.json", dedupedFindings],
      ["custom/detections.json", "/run/artifacts/attempt-dedupe/custom/detections.json", dedupeDetections],
      ["custom/dedupe-ledger.json", "/run/artifacts/attempt-dedupe/custom/dedupe-ledger.json", dedupeLedger]
    )
  );
  assert.deepEqual(publishedDedupeContext, mirrorDedupeContext);
  const mirrorAcceptance = executeSchemaSemanticGates("finding-lifecycle-ledger.schema.json", {
    document: dedupeLedger,
    context: { artifactSet: { reviewStage: mirrorDedupeContext } }
  });
  const publishedAcceptance = executeSchemaSemanticGates("finding-lifecycle-ledger.schema.json", {
    document: dedupeLedger,
    context: { artifactSet: { reviewStage: publishedDedupeContext } }
  });
  assert.equal(
    mirrorAcceptance.every((result) => result.status === "passed"),
    true,
    JSON.stringify(mirrorAcceptance)
  );
  assert.deepEqual(publishedAcceptance, mirrorAcceptance);
  assert.deepEqual(
    harness.reviewStage(
      triage,
      snapshots(
        ["custom/triaged.json", "/mirror/triage/custom/triaged.json", triagedFindings],
        ["custom/triage-ledger.json", "/mirror/triage/custom/triage-ledger.json", triageLedger]
      )
    ),
    {
      stage: "triage",
      findingsArtifactPath: "custom/triaged.json",
      findings: triagedFindings,
      lifecycleLedger: triageLedger,
      upstreamLifecycleLedger: dedupeLedger
    }
  );
  assert.deepEqual(
    harness.reviewStage(
      severity,
      snapshots(
        ["custom/severity.json", "/mirror/severity/custom/severity.json", severityFindings],
        ["custom/severity-detections.json", "/mirror/severity/custom/detections.json", severityDetections],
        ["custom/severity-ledger.json", "/mirror/severity/custom/ledger.json", severityLedger]
      )
    ),
    {
      stage: "severity-classification",
      findingsArtifactPath: "custom/severity.json",
      findings: severityFindings,
      lifecycleLedger: severityLedger,
      strategyDetections: severityDetections,
      upstreamLifecycleLedger: triageLedger,
      upstreamStrategyDetections: dedupeDetections
    }
  );

  const readCountBeforeFinal = harness.authenticatedReads.length;
  assert.deepEqual(harness.finalSeverity(report), {
    severityClassifiedFindings: severityFindings,
    findingLifecycleLedger: severityLedger
  });
  assert.deepEqual(harness.authenticatedReads.slice(readCountBeforeFinal), [
    {
      producer: severity.attemptId,
      path: "custom/severity.json",
      contract: "ultrafuzz/severity-classified-findings@1"
    },
    {
      producer: severity.attemptId,
      path: "custom/severity-ledger.json",
      contract: "ultrafuzz/finding-lifecycle-ledger@1"
    }
  ]);

  assert.throws(
    () =>
      harness.reviewStage(
        dedupe,
        snapshots(
          ["custom/deduped.json", "/mirror/dedupe/custom/deduped.json", dedupedFindings],
          ["custom/detections.json", "/mirror/dedupe/custom/detections.json", dedupeDetections]
        )
      ),
    /verified dedupe lifecycle ledger sibling is unavailable/u
  );

  documents.set(
    reviewAuthorityDocumentKey(severity, "custom/severity.json", "ultrafuzz/severity-classified-findings@1"),
    new Error("verification marker digest mismatch")
  );
  assert.throws(() => harness.finalSeverity(report), /verification marker digest mismatch/u);

  const wrongLedgerSeverity = task(
    "attempt-wrong-ledger-severity",
    [],
    [],
    [
      { path: "custom/severity.json", contract: "ultrafuzz/severity-classified-findings@1" },
      { path: "custom/severity-ledger.json", contract: "ultrafuzz/text@1" }
    ]
  );
  const wrongLedgerReport = task(
    "attempt-wrong-ledger-report",
    [wrongLedgerSeverity],
    [wrongLedgerSeverity],
    [{ path: "deliverables/report.json", contract: "ultrafuzz/report@3" }]
  );
  const wrongLedgerHarness = loadGeneratedReviewAuthorityHarness(
    [wrongLedgerSeverity, wrongLedgerReport],
    new Map([
      [
        reviewAuthorityDocumentKey(
          wrongLedgerSeverity,
          "custom/severity.json",
          "ultrafuzz/severity-classified-findings@1"
        ),
        severityFindings
      ]
    ])
  );
  assert.throws(
    () => wrongLedgerHarness.finalSeverity(wrongLedgerReport),
    /must declare exactly one ultrafuzz\/finding-lifecycle-ledger@1 sibling; found 0/u
  );
});

test("generated final-severity gates share one producer epoch and reject a cross-gate authority swap", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const dependencyStart = source.indexOf("function verifiedDependencyJsonArtifact");
  const dependencyEnd = source.indexOf("\n\nfunction semanticArtifactTaskDeclarations", dependencyStart);
  const finalSeverityStart = source.indexOf("function verifiedFinalSeverityReviewAuthority");
  const finalSeverityEnd = source.indexOf("\n\ntype DifferentialSemanticArtifactBinding", finalSeverityStart);
  assert.ok(dependencyStart >= 0 && dependencyEnd > dependencyStart, source);
  assert.ok(finalSeverityStart >= 0 && finalSeverityEnd > finalSeverityStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(dependencyStart, dependencyEnd)}\n${source.slice(finalSeverityStart, finalSeverityEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const producer: ReviewAuthorityHarnessTask = {
    attemptId: "attempt-severity",
    artifactDir: "/run/artifacts/attempt-severity",
    dependencyArtifactDirs: [],
    metadata: { node: { logicalNodeId: "severity" }, dependencies: { attemptIds: [] } },
    outputs: [
      { path: "review/severity.json", contract: "ultrafuzz/severity-classified-findings@1" },
      { path: "review/lifecycle.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" },
      { path: "review/detections.json", contract: "ultrafuzz/strategy-detections@1" }
    ]
  };
  const consumer: ReviewAuthorityHarnessTask = {
    attemptId: "attempt-report",
    artifactDir: "/run/artifacts/attempt-report",
    dependencyArtifactDirs: [producer.artifactDir],
    metadata: { node: { logicalNodeId: "report" }, dependencies: { attemptIds: [producer.attemptId] } },
    outputs: [{ path: "report.json", contract: "ultrafuzz/report@3" }]
  };
  let authorityGeneration = 1;
  let authenticationCount = 0;
  const authority = () => {
    const values = new Map<string, unknown>([
      ["review/severity.json", [{ id: `severity-${authorityGeneration}` }]],
      ["review/lifecycle.json", { records: [{ generation: authorityGeneration }] }],
      ["review/detections.json", [{ id: `detection-${authorityGeneration}` }]]
    ]);
    const artifacts = new Map(
      producer.outputs.map((output) => {
        const value = values.get(output.path);
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
        return [
          output.path,
          Object.freeze({
            path: path.join(producer.artifactDir, output.path),
            relativePath: output.path,
            contract: output.contract,
            bytes,
            value
          })
        ] as const;
      })
    );
    const publications = new Map(
      [...artifacts].map(([relativePath, artifact]) => [
        relativePath,
        createHash("sha256").update(artifact.bytes).digest("hex")
      ])
    );
    return Object.freeze({
      attemptId: producer.attemptId,
      artifactDir: producer.artifactDir,
      markerBytes: Buffer.from(`marker-generation-${authorityGeneration}\n`, "utf8"),
      artifacts,
      publications,
      generatedTestBundles: Object.freeze([])
    });
  };
  const declaredAncestorContractOutputs = (_task: ReviewAuthorityHarnessTask, contract: string) =>
    producer.outputs
      .filter((output) => output.contract === contract)
      .map((output) => ({
        attemptId: producer.attemptId,
        logicalNodeId: producer.metadata.node.logicalNodeId,
        artifactDir: producer.artifactDir,
        path: output.path,
        contract: output.contract
      }));
  const harness = new Function(
    "path",
    "taskSpecs",
    "assertVerifiedDependency",
    "declaredAncestorContractOutputs",
    `${emitted}; return {
      begin: beginVerifiedDependencySnapshotEpoch,
      recheck: assertVerifiedDependencySnapshotEpochRemainedCurrent,
      end: endVerifiedDependencySnapshotEpoch,
      finalSeverity: verifiedFinalSeverityReviewAuthority
    };`
  )(
    path,
    [producer, consumer],
    () => {
      authenticationCount += 1;
      return authority();
    },
    declaredAncestorContractOutputs
  ) as {
    begin: (task: ReviewAuthorityHarnessTask) => {
      snapshotsByProducerAttempt: Map<
        string,
        { artifacts: ReadonlyMap<string, { bytes: Buffer }>; markerBytes: Buffer }
      >;
    };
    recheck: (task: ReviewAuthorityHarnessTask, epoch: unknown) => void;
    end: (task: ReviewAuthorityHarnessTask, epoch: unknown) => void;
    finalSeverity: (task: ReviewAuthorityHarnessTask) => {
      severityClassifiedFindings: unknown;
      findingLifecycleLedger?: unknown;
    };
  };

  const epoch = harness.begin(consumer);
  try {
    assert.deepEqual(harness.finalSeverity(consumer), {
      severityClassifiedFindings: [{ id: "severity-1" }],
      findingLifecycleLedger: { records: [{ generation: 1 }] }
    });
    assert.equal(authenticationCount, 1);
    assert.equal(epoch.snapshotsByProducerAttempt.get(producer.attemptId)?.artifacts.size, 3);

    authorityGeneration = 2;
    assert.deepEqual(harness.finalSeverity(consumer), {
      severityClassifiedFindings: [{ id: "severity-1" }],
      findingLifecycleLedger: { records: [{ generation: 1 }] }
    });
    assert.equal(authenticationCount, 1);
    assert.throws(
      () => harness.recheck(consumer, epoch),
      /verified dependency authority changed during semantic verification attempt-severity/u
    );
    assert.equal(authenticationCount, 2);
  } finally {
    harness.end(consumer, epoch);
  }
});

test("generated review verification uses declared immutable review-stage authority", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("type ReviewStageSemanticContext");
  const helperEnd = source.indexOf("\n\ntype DifferentialSemanticArtifactBinding", helperStart);
  const contextStart = source.indexOf("function semanticGateContextForVerifiedOutput");
  const contextEnd = source.indexOf("\n\nfunction verifyOutputSemanticGates", contextStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  assert.ok(contextStart >= 0 && contextEnd > contextStart, source);
  const helper = source.slice(helperStart, helperEnd);
  const context = source.slice(contextStart, contextEnd);

  assert.match(helper, /verifiedSiblingJsonArtifact/u);
  assert.match(helper, /findingsArtifactPath: findings\.path/u);
  assert.doesNotMatch(helper, /findings\.artifactPath|snapshot\.file\.path/u);
  assert.match(helper, /verifiedSingletonAncestorJsonArtifact/u);
  assert.match(helper, /directOnly: true/u);
  assert.match(helper, /declaredAncestorContractOutputs/u);
  assert.match(helper, /producer\.outputs\.filter/u);
  assert.match(helper, /verifiedDependencyJsonArtifact/u);
  assert.doesNotMatch(helper, /findLogicalNodeArtifact|readFileSync|existsSync|logicalNodeId\s*===/u);
  assert.doesNotMatch(helper, /deduped-findings\.json|triaged-findings\.json|severity-classified-findings\.json/u);

  assert.match(context, /output\.schemaFile === "triaged-findings\.schema\.json"/u);
  assert.match(context, /output\.schemaFile === "finding-lifecycle-ledger\.schema\.json"/u);
  assert.match(context, /output\.schemaFile === "strategy-detections\.schema\.json"/u);
  assert.match(context, /reviewStageSemanticContext\(task, verifiedOutputs\)/u);
  assert.match(context, /verifiedFinalSeverityReviewAuthority\(task\)/u);
  assert.match(context, /\.\.\.finalSeverityAuthority/u);
});

test("generated differential verification uses exact declared siblings and ancestors", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const runtimeImportStart = source.indexOf("const {", source.indexOf("await import(artifactsModule)"));
  const runtimeImportEnd = source.indexOf("} = await import(runtimeModule);", runtimeImportStart);
  const helperStart = source.indexOf("function siblingDynamicStrategySemanticArtifacts");
  const helperEnd = source.indexOf("\n\nfunction verifiedAncestorPropertyLenses", helperStart);
  assert.ok(runtimeImportStart >= 0 && runtimeImportEnd > runtimeImportStart, source);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const runtimeImport = source.slice(runtimeImportStart, runtimeImportEnd);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(runtimeImport, /declaredAncestorOutputsByContract/u);
  assert.match(runtimeImport, /declaredSiblingOutputsByContract/u);
  assert.match(helper, /ancestorDifferentialBindings/u);
  assert.match(helper, /siblingDifferentialBindings/u);
  assert.match(helper, /verifiedDependencyJsonArtifact/u);
  assert.match(helper, /verifiedOutputs/u);
  assert.doesNotMatch(helper, /verifiedCurrentAncestorJsonArtifact|findLogicalNodeArtifact/u);
  for (const schema of [
    "reference-harness.schema.json",
    "audited-differential-lanes.schema.json",
    "differential-lane-result.schema.json",
    "semantic-red-registry.schema.json",
    "differential-red-triage.schema.json",
    "differential-repair-summary.schema.json",
    "differential-gap-review.schema.json",
    "differential-report-review.schema.json"
  ]) {
    assert.match(helper, new RegExp(schema.replaceAll(".", "\\."), "u"), schema);
  }
});

test("generated Smithers workflow prepares output directories without creating agent-owned files", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const verifierStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(preparationStart >= 0, source);
  assert.ok(verifierStart > preparationStart, source);

  const preparation = source.slice(preparationStart, verifierStart);
  assert.match(preparation, /for \(const output of task\.outputs\)/u);
  assert.match(preparation, /mkdirSync\(parentPath, \{ recursive: true \}\)/u);
  assert.doesNotMatch(preparation, /canonicalEmptyArtifact|validEmptyExample|writeFileDurable\(artifactPath/u);
  assert.match(source, /id=\{task\.preparationId\}/u);
  assert.match(source, /dependsOn=\{\[task\.preparationId\]\}/u);
});

test("generated Smithers restores sealed submodules before inputs and verifies them only in the finalizer", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const preparationEnd = source.indexOf("\n\nfunction preservePinnedSourceProof", preparationStart);
  const agentStart = source.indexOf("function artifactAwareAgent");
  const agentEnd = source.indexOf("function resetTaskArtifactsForRetry", agentStart);
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts");
  const finalizerEnd = source.indexOf("\n\nfunction verifyArtifacts", finalizerStart);
  assert.ok(preparationStart >= 0, source);
  assert.ok(preparationEnd > preparationStart, source);
  assert.ok(agentStart >= 0, source);
  assert.ok(agentEnd > agentStart, source);
  assert.ok(finalizerStart >= 0, source);
  assert.ok(finalizerEnd > finalizerStart, source);

  const preparation = source.slice(preparationStart, preparationEnd);
  const agent = source.slice(agentStart, agentEnd);
  const finalizer = source.slice(finalizerStart, finalizerEnd);
  assert.match(preparation, /options\.pinnedSubmodules === "verify"/u);
  assert.match(preparation, /verifyPinnedSubmodulesFromExecutionSnapshot\(/u);
  assert.match(preparation, /hydratePinnedSubmodulesFromExecutionSnapshot\(/u);
  assert.match(preparation, /expectation: task\.pinnedSubmodules \?\? undefined/u);
  assert.ok(
    preparation.indexOf("hydratePinnedSubmodulesFromExecutionSnapshot") <
      preparation.indexOf("assertTaskInputs(task, workspaceRoot)"),
    preparation
  );
  assert.ok(
    preparation.indexOf("verifyPinnedSubmodulesFromExecutionSnapshot") <
      preparation.indexOf("preservePinnedSourceProof(task)"),
    preparation
  );
  assert.doesNotMatch(
    agent,
    /hydratePinnedSubmodulesFromExecutionSnapshot|verifyPinnedSubmodulesFromExecutionSnapshot/u
  );
  assert.match(finalizer, /prepareArtifactMirror\(task, \{[\s\S]*?pinnedSubmodules: "verify"[\s\S]*?\}\);/u);
});

test("generated Smithers workflow binds every planned output to the preflighted schema bundle before agent work", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const artifactsImportStart = source.indexOf("const {");
  const artifactsImportEnd = source.indexOf("} = await import(artifactsModule);", artifactsImportStart);
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const bindingStart = source.indexOf("function assertTaskOutputSchemaBindings", preparationStart);
  const preflightStart = source.indexOf("function preflightJsonValidator", bindingStart);
  const preparation = source.slice(preparationStart, bindingStart);
  const binding = source.slice(bindingStart, preflightStart);

  assert.ok(preparationStart >= 0, source);
  assert.ok(artifactsImportStart >= 0 && artifactsImportEnd > artifactsImportStart, source);
  assert.ok(bindingStart > preparationStart, source);
  assert.ok(preflightStart > bindingStart, source);
  assert.ok(
    preparation.indexOf("assertTaskOutputSchemaBindings(task)") < preparation.indexOf("preflightJsonValidator"),
    preparation
  );
  assert.match(binding, /for \(const output of task\.outputs\)/u);
  assert.match(binding, /artifactContractSchemaBinding\(/u);
  for (const field of ["schemaFile", "schemaId", "schemaSha256", "schemaBundleSha256", "validatorBuild"]) {
    assert.match(binding, new RegExp(`output\\.${field}`, "u"));
  }
  assert.match(source.slice(artifactsImportStart, artifactsImportEnd), /parseJsonValidatorPreflightSuccessEnvelope/u);
  assert.match(source, /parseJsonValidatorPreflightSuccessEnvelope\(Buffer\.from\(stdout, "utf8"\)\)/u);
  assert.doesNotMatch(
    source.slice(preflightStart, source.indexOf("function taskPublishesWorkspacePatch")),
    /JSON\.parse|parseStrictJsonBytes|\bok\??:|\bstatus\??:|registered !== true/u
  );
});

test("generated Smithers workflow does not precreate runtime-owned workspace patch outputs", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function prepareArtifactMirror");
  const helperEnd = source.indexOf("\n\nfunction taskPublishesWorkspacePatch", helperStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /workspace\.patch|workspace-patch\.json|writeFileDurable/u);
});

test("generated Smithers workflow guards runtime-owned workspace patch publication", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function writeWorkspacePatchArtifact");
  const helperEnd = source.indexOf("\n\nfunction captureInvariantSuiteBaseline", helperStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /resolveRegularArtifactFile\(/u);
  assert.match(helper, /These paths are runtime-owned/u);
  assert.match(helper, /existingContents !== "" && existingContents !== "\\n"/u);
  assert.match(helper, /workspace patch artifact was modified/u);
  assert.match(helper, /writeFileDurable\(target, contents\)/u);
  // #357 widened the rule from "replace only an empty placeholder" to "replace an empty placeholder,
  // or a pair this node published in an earlier generation". The rejection must stay gated on the
  // caller's classification rather than becoming unconditional, so pin both halves: the throw is
  // guarded by the flag, and the flag defaults to rejecting.
  assert.match(helper, /replaceSuperseded = false/u);
  assert.match(helper, /if \(!replaceSuperseded\) \{/u);
});

test("generated Smithers verification publishes its exact workspace patch baseline snapshot", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verificationStart = source.indexOf("function verifyArtifacts");
  const verificationEnd = source.indexOf("\n\nfunction isPlainJsonRecord", verificationStart);
  const captureStart = source.indexOf("function captureWorkspacePatchBaselinePublication");
  const captureEnd = source.indexOf("\n\nfunction publishVerifiedArtifacts", captureStart);

  assert.ok(verificationStart >= 0 && verificationEnd > verificationStart, source);
  assert.ok(captureStart >= 0 && captureEnd > captureStart, source);

  const verification = source.slice(verificationStart, verificationEnd);
  const capture = source.slice(captureStart, captureEnd);
  assert.match(verification, /taskPublishesWorkspacePatch\(task\)/u);
  assert.match(verification, /rememberVerifiedPublication\([\s\S]*WORKSPACE_PATCH_BASELINE_FILE/u);
  assert.match(verification, /captureWorkspacePatchBaselinePublication\(task, artifactDir\)/u);
  assert.match(capture, /readBoundedRegularArtifactSnapshot\(/u);
  assert.match(capture, /parseRuntimeDocumentBytes\(/u);
  assert.match(capture, /workspacePatchBaselineTrees\.get\(task\.attemptId\)/u);
  assert.match(capture, /parsed\.baseline_tree !== expectedTree/u);
});

test("generated Smithers workspace handoff enforces declared production source roots", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function materializeWorkspacePatch");
  const helperEnd = source.indexOf("\n\n/**", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /captureWorkspacePatch\(workspaceRoot, baselineTree, task\.productionSourceRoots\)/u);
});

test("runtime workspace patch publication replaces empty placeholders but rejects non-empty agent patches", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function writeWorkspacePatchArtifact");
  const helperEnd = source.indexOf("\n\nfunction captureInvariantSuiteBaseline", helperStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source
    .slice(helperStart, helperEnd)
    .replace(
      /root: string,\n\s*relativePath: string,\n\s*contents: string,\n\s*replaceSuperseded = false\n\): void/u,
      "root, relativePath, contents, replaceSuperseded = false)"
    );
  const writeWorkspacePatchArtifact = new Function(
    "path",
    "isStrictlyInsideDirectory",
    "mkdirSync",
    "existsSync",
    "resolveRegularArtifactFile",
    "readFileSync",
    "writeFileDurable",
    `${helper}; return writeWorkspacePatchArtifact;`
  )(
    path,
    (root: string, candidate: string) => candidate.startsWith(`${root}${path.sep}`),
    fs.mkdirSync,
    fs.existsSync,
    (root: string, target: string, failureMessage: string) => {
      assertRegularFileInside(root, target, failureMessage);
      return fs.realpathSync(target);
    },
    fs.readFileSync,
    writeFileDurable
  ) as (root: string, relativePath: string, contents: string, replaceSuperseded?: boolean) => void;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-workspace-patch-publication-"));
  try {
    const patchPath = path.join(root, "workspace.patch");
    fs.writeFileSync(patchPath, "\n");
    writeWorkspacePatchArtifact(root, "workspace.patch", "captured patch\n");
    assert.equal(fs.readFileSync(patchPath, "utf8"), "captured patch\n");

    fs.writeFileSync(patchPath, "agent-authored patch\n");
    assert.throws(
      () => writeWorkspacePatchArtifact(root, "workspace.patch", "captured patch\n"),
      /workspace patch artifact was modified/u
    );

    // #357: the same non-empty survivor is replaced once the caller has classified it as a pair this
    // node published in an earlier generation. Only the flag differs, so this pins that the widening
    // rides on the classification and not on anything about the bytes.
    writeWorkspacePatchArtifact(root, "workspace.patch", "captured patch\n", true);
    assert.equal(fs.readFileSync(patchPath, "utf8"), "captured patch\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers workflow prefers its relocatable task prompt path", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /const promptPath = task\.promptPath \?\? inputTask\?\.prompt_path/u);
});

test("generated local and cloud prompt relocation preserves quoted validation-command paths", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function relocatePromptPath");
  const helperEnd = source.indexOf("\n\nfunction verifiedDependencyJsonArtifact", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const relocatePromptPath = new Function(`${helper}; return relocatePromptPath;`)() as (
    prompt: string,
    sourcePath: string,
    destinationPath: string
  ) => string;

  const controllerRoot = "/tmp/owner's-project";
  const cloudRoot = "/workspace/cloud's-project";
  const controllerArtifactDir = `${controllerRoot}/.ultrafuzz/runs/run-1/artifacts/task-0`;
  const encodedControllerRoot = controllerRoot.replaceAll("'", `'"'"'`);
  const rendered = [
    `- Path: \`${controllerArtifactDir}/findings.json\``,
    `  Validate against: \`${controllerRoot}/.ultrafuzz/workspaces/task-0/.ultrafuzz/schemas/findings.schema.json\``,
    `  Validation command: \`ultrafuzz json validate --schema '${encodedControllerRoot}/.ultrafuzz/workspaces/task-0/.ultrafuzz/schemas/findings.schema.json' --file '${encodedControllerRoot}/.ultrafuzz/runs/run-1/artifacts/task-0/findings.json'\``
  ].join("\n");

  for (const [label, taskArtifactDir, mirroredTaskArtifactDir, destinationRoot, expectedArtifactDir] of [
    [
      "local",
      controllerArtifactDir,
      `${controllerRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/artifacts/task-0`,
      controllerRoot,
      `${controllerRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/artifacts/task-0`
    ],
    [
      "cloud",
      ".ultrafuzz/runs/run-1/artifacts/task-0",
      ".ultrafuzz/runs/run-1/workspaces/task-0/artifacts/task-0",
      cloudRoot,
      `${cloudRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/artifacts/task-0`
    ]
  ] as const) {
    let relocated = relocatePromptPath(rendered, taskArtifactDir, mirroredTaskArtifactDir);
    relocated = relocatePromptPath(relocated, controllerRoot, destinationRoot);
    const encodedDestinationRoot = destinationRoot.replaceAll("'", `'"'"'`);
    const encodedExpectedArtifactDir = expectedArtifactDir.replaceAll("'", `'"'"'`);

    assert.ok(relocated.includes(expectedArtifactDir), `${label}: ${relocated}`);
    assert.ok(
      relocated.includes(`--schema '${encodedDestinationRoot}/.ultrafuzz/workspaces/task-0`),
      `${label}: ${relocated}`
    );
    assert.ok(relocated.includes(`--file '${encodedExpectedArtifactDir}/findings.json'`), `${label}: ${relocated}`);
    assert.equal(relocated.includes(`--file '${encodedControllerRoot}/.ultrafuzz/runs/run-1/artifacts`), false, label);
  }
});

test(
  "generated local task controls survive closure of their admission descriptor",
  { skip: process.platform === "win32" || !fs.existsSync("/proc/self/fd") },
  () => {
    const source = fs.readFileSync(workflowTemplatePath, "utf8");
    const projectionStart = source.indexOf("const admittedWorkflowControls");
    const projectionEnd = source.indexOf("\n\ntype AdmittedWorkflowControls", projectionStart);
    assert.ok(projectionStart >= 0, source);
    assert.ok(projectionEnd > projectionStart, source);
    const projection = source.slice(projectionStart, projectionEnd);
    assert.match(
      projection,
      /const controlPaths = taskWorkflowControlPaths\(task\.execution\.mode, admittedWorkflowControls\)/u
    );
    assert.match(projection, /sealedTaskPromptPath\(task\.attemptId, controlPaths\.promptExecutionSnapshotRoot\)/u);
    assert.match(projection, /workflowPath: controlPaths\.workflowPath \?\?/u);
    assert.match(projection, /executionSnapshotRoot: controlPaths\.executionSnapshotRoot/u);

    const { admitWorkflowControls, taskWorkflowControlPaths, sealedTaskPromptPath } =
      loadWorkflowControlPathResolvers();
    const snapshotsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-detached-task-paths-"));
    const generationRoot = path.join(snapshotsRoot, "a".repeat(64));
    const workflowRelativePath = path.join(".smithers", "workflows", "detached-paths.tsx");
    const persistedWorkflowPath = path.join(generationRoot, workflowRelativePath);
    const promptRoot = path.join(generationRoot, "controls", "rendered-prompts");
    const persistedPromptPath = path.join(promptRoot, "project-discovery.md");
    fs.mkdirSync(path.dirname(persistedWorkflowPath), { recursive: true });
    fs.mkdirSync(path.join(generationRoot, "dependencies"), { recursive: true });
    fs.mkdirSync(promptRoot, { recursive: true });
    fs.writeFileSync(persistedWorkflowPath, "export default function Workflow() {}\n", "utf8");
    fs.writeFileSync(path.join(generationRoot, "dependencies", "manifest.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(generationRoot, "controls", "plan.json"), "{}\n", "utf8");
    fs.writeFileSync(persistedPromptPath, "SEALED DETACHED PROMPT\n", "utf8");

    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(generationRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const descriptorRoot = `/proc/self/fd/${descriptor}`;
      const loadedWorkflowPath = path.join(descriptorRoot, workflowRelativePath);
      const admitted = admitWorkflowControls(loadedWorkflowPath, persistedWorkflowPath);
      const localControls = taskWorkflowControlPaths("local", admitted);
      const localPromptPath = sealedTaskPromptPath("project-discovery", localControls.promptExecutionSnapshotRoot);
      const directCloudControls = taskWorkflowControlPaths(
        "cloud",
        admitWorkflowControls(loadedWorkflowPath, undefined)
      );

      assert.equal(admitted.loadedExecutionSnapshotRoot, descriptorRoot);
      assert.equal(localControls.promptExecutionSnapshotRoot, generationRoot);
      assert.equal(localControls.workflowPath, persistedWorkflowPath);
      assert.equal(localControls.executionSnapshotRoot, generationRoot);
      assert.equal(localPromptPath, persistedPromptPath);
      assert.doesNotMatch(JSON.stringify(localControls), /\/proc\/(?:self|[1-9][0-9]*)\/fd\//u);
      // Keep the pre-existing cloud rule pinned: without an explicit persisted
      // binding, direct admission may read its sealed prompt but cannot hand a
      // generation root to the provider.
      assert.equal(directCloudControls.promptExecutionSnapshotRoot, descriptorRoot);
      assert.equal(directCloudControls.workflowPath, loadedWorkflowPath);
      assert.equal(directCloudControls.executionSnapshotRoot, undefined);

      fs.closeSync(descriptor);
      descriptor = undefined;
      assert.throws(() => fs.readFileSync(loadedWorkflowPath), /ENOENT|no such file/u);
      assertRegularFileInside(promptRoot, localPromptPath!, "detached rendered prompt");
      assert.equal(fs.readFileSync(localPromptPath!, "utf8"), "SEALED DETACHED PROMPT\n");

      descriptor = fs.openSync(generationRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const replacedLoadedWorkflowPath = path.join(`/proc/self/fd/${descriptor}`, workflowRelativePath);
      const displacedGenerationRoot = `${generationRoot}.displaced`;
      fs.renameSync(generationRoot, displacedGenerationRoot);
      try {
        fs.mkdirSync(path.dirname(persistedWorkflowPath), { recursive: true });
        fs.mkdirSync(path.join(generationRoot, "dependencies"), { recursive: true });
        fs.mkdirSync(path.join(generationRoot, "controls"), { recursive: true });
        fs.writeFileSync(persistedWorkflowPath, "export default function Hostile() {}\n", "utf8");
        fs.writeFileSync(path.join(generationRoot, "dependencies", "manifest.json"), "{}\n", "utf8");
        fs.writeFileSync(path.join(generationRoot, "controls", "plan.json"), "{}\n", "utf8");
        assert.throws(
          () => admitWorkflowControls(replacedLoadedWorkflowPath, persistedWorkflowPath),
          /persisted workflow path does not identify the loaded execution snapshot/u
        );
      } finally {
        fs.rmSync(generationRoot, { recursive: true, force: true });
        fs.renameSync(displacedGenerationRoot, generationRoot);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(snapshotsRoot, { recursive: true, force: true });
    }
  }
);

test("generated Smithers verifier explains byte-preserving invariant evidence", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /Derive verbatim from the cited source with a JSON serializer/u);
  assert.match(source, /repeated backslashes and other literals remain intact/u);
  const helperStart = source.indexOf("function normalizeInvariantSourceLines");
  const helperEnd = source.indexOf("\n\nfunction symbolFromInvariantLocation", helperStart);
  const workflowStart = source.indexOf("export default smithers");
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  assert.ok(workflowStart > helperStart, source);
  assert.match(source.slice(helperStart, workflowStart), /\.join\("\\n"\)/u);
  assert.match(source, /invariantSymbolDeclaration[\s\S]*?\.split\(\/\\r\?\\n\/u\)/u);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const normalize = new Function(`${helper}; return normalizeInvariantSourceLines;`)() as (
    lines: readonly string[]
  ) => string;
  assert.equal(normalize(["- first invariant", "> second invariant"]), "- first invariant\n> second invariant");
  assert.notEqual(normalize(["- first invariant"]), normalize(["first invariant"]));
  assert.notEqual(normalize(["> second invariant"]), normalize(["second invariant"]));
  assert.notEqual(normalize(["- first invariant"]), normalize(["> first invariant"]));
});

// Issue #301: the pinned/tracked/unmodified rule used to be inlined here and absent from the runtime
// gate, so `ultrafuzz validate` and the run enforced different things. The template must now delegate
// to the shared validator in @ultrafuzz/artifacts, which is the only place the rule lives.
test("generated Smithers invariant snapshot delegates the pin check to the shared validator", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-template-pin-")));
  fs.writeFileSync(path.join(root, "Counter.sol"), "contract Counter {}\n");
  const calls: InvariantSourcePinCall[] = [];
  try {
    // The fixture is not a Git repository at all, so an inlined `git ls-files` would fail closed here.
    const snapshot = loadReadInvariantSourceSnapshot(true, (options) => {
      calls.push(options);
      return { ok: true };
    });
    assert.equal(snapshot(root, "Counter.sol", "scan probe").content, "contract Counter {}\n");
    assert.deepEqual(
      calls.map((call) => [call.workspacePath, call.relativePath, call.ref]),
      [[root, "Counter.sol", "refs/heads/ultrafuzz-pinned"]]
    );
    assert.equal(Buffer.from(calls[0]!.bytes).toString("utf8"), "contract Counter {}\n");

    const rejecting = loadReadInvariantSourceSnapshot(true, () => ({ ok: false }));
    assert.throws(
      () => rejecting(root, "Counter.sol", "scan probe"),
      /invariant scan probe Counter\.sol is not pinned and unchanged/u
    );

    // Without the pinned ref neither the gate nor the run enforces the pin, so the validator is not consulted.
    const unpinned = loadReadInvariantSourceSnapshot(false, () => {
      throw new Error("pin check must not run without the pinned ref");
    });
    assert.equal(unpinned(root, "Counter.sol", "scan probe").content, "contract Counter {}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers worktrees fail closed on any source other than the pinned benchmark ref", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const proofStart = source.indexOf("function preservePinnedSourceProof");
  const proofEnd = source.indexOf(
    "\n\n/** Directory names whose task-owned generated-test work must be cleared before a retry. */",
    proofStart
  );
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(proofStart > preparationStart, source);
  assert.ok(proofEnd > proofStart, source);
  assert.ok(workflowStart > proofStart, source);
  assert.match(source, /const pinnedSourceBranch = "ultrafuzz-pinned"/u);
  assert.match(source, /\.\.\.\(usesPinnedSource \? \{ baseBranch: pinnedSourceBranch \} : \{\}\)/u);
  assert.match(source, /if \(!usesPinnedSource\) return/u);
  assert.match(source, /preservePinnedSourceProof\(task\)/u);
  assert.match(source, /git\(\["rev-parse", "HEAD"\]\)/u);
  assert.match(source, /git\(\["rev-parse", pinnedSourceRef\]\)/u);
  assert.match(source, /git\(\["rev-list", "--all", "--count"\]\)/u);
  assert.match(source, /git\(\["rev-list", "--all", "--max-count=1"\]\)/u);
  assert.match(source, /git fsck --connectivity-only --unreachable --no-reflogs --no-progress/u);
  assert.doesNotMatch(source.slice(proofStart, proofEnd), /--batch-all-objects/u);
  assert.match(source, /git\(\["remote"\]\)/u);
  assert.match(source, /source-isolation failure/u);
  assert.match(source, /"source-proofs"/u);
  assert.match(source, /path\.resolve\(process\.cwd\(\), task\.metadata\.artifacts\.dir, "\.\.", "\.\."\)/u);
  assert.doesNotMatch(source.slice(proofStart, proofEnd), /task\.runRoot/u);
  assert.match(source, /ultrafuzz\.agent-source-proof\.v2/u);
  assert.match(source.slice(proofStart, proofEnd), /dependencies: pinnedDependencies/u);
});

test("generated Smithers cloud source proof records the sealed submodule expectation", () => {
  const preservePinnedSourceProof = loadPreservePinnedSourceProof();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-cloud-source-proof-"));
  const workspace = path.join(root, "workspace");
  const artifactDir = path.join(root, "artifacts", "cloud-attempt");
  const proofPath = path.join(root, "source-proofs", "cloud-attempt.json");
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(workspace);
    git(["init", "--quiet", "--initial-branch=ultrafuzz-pinned"]);
    git(["config", "user.name", "Ultrafuzz test"]);
    git(["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(workspace, "source.txt"), "pinned\n");
    git(["add", "source.txt"]);
    git(["commit", "--quiet", "-m", "pinned"]);
    const expectation = {
      schema_version: "ultrafuzz.pinned-submodules-expectation.v1",
      source_commit: git(["rev-parse", "HEAD"]),
      source_tree: git(["rev-parse", "HEAD^{tree}"]),
      manifest_sha256: "c".repeat(64),
      top_level_roots: ["vendor/dependency"],
      recursive_gitlinks: [{ path: "vendor/dependency", commit: "d".repeat(40), tree: "e".repeat(40) }],
      entry_count: 2,
      file_count: 1,
      total_file_bytes: 11
    };

    preservePinnedSourceProof({
      attemptId: "cloud-attempt",
      workspacePath: workspace,
      metadata: { artifacts: { dir: artifactDir } },
      pinnedSubmodules: expectation
    });
    const proof = parseStrictJsonBytes(fs.readFileSync(proofPath)) as { dependencies?: unknown };
    assert.deepEqual(proof.dependencies, expectation);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers pinned source proof counts hidden unreachable commits without batch object output", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const commandStart = source.indexOf("const unreachableCommitCountCommand");
  const commandEnd = source.indexOf("\n\nconst { Workflow", commandStart);
  assert.ok(commandStart >= 0, source);
  assert.ok(commandEnd > commandStart, source);
  const command = new Function(`${source.slice(commandStart, commandEnd)}; return unreachableCommitCountCommand;`)();
  assert.equal(typeof command, "string");
  assert.doesNotMatch(command, /--batch-all-objects/u);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-hidden-commit-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  const countHiddenCommits = (): string =>
    execFileSync("bash", ["-lc", command], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  try {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Ultrafuzz test"]);
    git(["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(root, "source.txt"), "pinned\n");
    git(["add", "source.txt"]);
    git(["commit", "--quiet", "-m", "pinned"]);
    assert.equal(countHiddenCommits(), "0");

    git(["checkout", "--quiet", "-b", "hidden"]);
    fs.writeFileSync(path.join(root, "source.txt"), "hidden\n");
    git(["add", "source.txt"]);
    git(["commit", "--quiet", "-m", "hidden"]);
    git(["checkout", "--quiet", "master"]);
    git(["branch", "-D", "hidden"]);
    assert.equal(countHiddenCommits(), "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers pinned source proof rejects any previously published byte drift", () => {
  const preservePinnedSourceProof = loadPreservePinnedSourceProof();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-source-proof-"));
  const workspace = path.join(root, "workspace");
  const artifactDir = path.join(root, "artifacts", "property-specification-certora");
  const proofPath = path.join(root, "source-proofs", "property-specification-certora.json");
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  const task = {
    attemptId: "property-specification-certora",
    workspacePath: workspace,
    metadata: { artifacts: { dir: artifactDir } }
  };

  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(workspace);
    git(["init", "--quiet", "--initial-branch=ultrafuzz-pinned"]);
    git(["config", "user.name", "Ultrafuzz test"]);
    git(["config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(workspace, "source.txt"), "pinned\n");
    git(["add", "source.txt"]);
    git(["commit", "--quiet", "-m", "pinned"]);
    const pinnedCommit = git(["rev-parse", "HEAD"]);
    git(["branch", "ultrafuzz/test-run/actors-flows", pinnedCommit]);

    preservePinnedSourceProof(task);
    const canonicalProof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as {
      schema_version: unknown;
      refs: unknown[];
      dependencies: unknown;
    };
    assert.equal(canonicalProof.schema_version, "ultrafuzz.agent-source-proof.v2");
    assert.equal(canonicalProof.dependencies, null);
    assert.deepEqual(canonicalProof.refs, [{ name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit }]);
    const canonicalProofBytes = fs.readFileSync(proofPath);
    preservePinnedSourceProof(task);
    assert.deepEqual(fs.readFileSync(proofPath), canonicalProofBytes, "exact prior proof bytes are idempotent");

    fs.writeFileSync(proofPath, JSON.stringify(canonicalProof));
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.unlinkSync(proofPath);
    fs.symlinkSync("missing-proof.json", proofPath);
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);
    assert.equal(fs.lstatSync(proofPath).isSymbolicLink(), true, "dangling proof is not replaced");
    fs.unlinkSync(proofPath);

    const legacyNoisyProof = {
      ...canonicalProof,
      refs: [
        { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit },
        { name: "refs/heads/ultrafuzz/test-run/actors-flows", object: pinnedCommit }
      ]
    };
    fs.writeFileSync(proofPath, `${JSON.stringify(legacyNoisyProof, null, 2)}\n`);
    git(["branch", "ultrafuzz/test-run/property-specification-crytic", pinnedCommit]);
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...legacyNoisyProof,
          injected: "metadata"
        },
        null,
        2
      )}\n`
    );
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...canonicalProof,
          refs: [{ name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit, injected: "metadata" }]
        },
        null,
        2
      )}\n`
    );
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...canonicalProof,
          refs: [
            { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit },
            { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit }
          ]
        },
        null,
        2
      )}\n`
    );
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...canonicalProof,
          refs: [
            { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit },
            { name: "refs/heads/rogue", object: pinnedCommit }
          ]
        },
        null,
        2
      )}\n`
    );
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(
      proofPath,
      `${JSON.stringify(
        {
          ...canonicalProof,
          refs: [
            { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit },
            { name: "refs/heads/ultrafuzz/test-run/actors-flows", object: "0".repeat(40) }
          ]
        },
        null,
        2
      )}\n`
    );
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    fs.writeFileSync(proofPath, `${JSON.stringify(legacyNoisyProof, null, 2)}\n`);
    git(["branch", "rogue", pinnedCommit]);
    assert.throws(
      () => preservePinnedSourceProof(task),
      /final worktree property-specification-certora is not pinned/u
    );
    git(["branch", "-D", "rogue"]);

    git(["checkout", "--quiet", "-b", "ultrafuzz/test-run/bad-ref"]);
    fs.writeFileSync(path.join(workspace, "source.txt"), "changed\n");
    git(["add", "source.txt"]);
    git(["commit", "--quiet", "-m", "bad ref"]);
    git(["checkout", "--quiet", "ultrafuzz-pinned"]);
    assert.throws(
      () => preservePinnedSourceProof(task),
      /final worktree property-specification-certora is not pinned/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("agent retries are error-agnostic fresh generations with Smithers' effective prompt", async () => {
  let resets = 0;
  const calls: Array<Record<string, unknown> | undefined> = [];
  const arbitraryFailure = { provider: "opaque", detail: { code: 731 } };
  const artifactAwareAgent = loadArtifactAwareAgent({ onReset: () => (resets += 1) });
  const prompt = "the original task prompt";
  const wrapped = artifactAwareAgent({ agentChain: [{}] }, 0, prompt, {
    async generate(args: unknown): Promise<unknown> {
      calls.push(args as Record<string, unknown> | undefined);
      if (calls.length === 1) throw arbitraryFailure;
      return { ok: true };
    }
  });
  await assert.rejects(
    () =>
      wrapped.generate({
        prompt,
        resumeSession: "failed-session",
        continueSession: true,
        taskContext: { attempt: 1 }
      }),
    (error) => error === arbitraryFailure
  );
  const result = await wrapped.generate({
    prompt: "worktree isolation\n\nthe original task prompt\n\nstructured output contract",
    messages: [
      { role: "user", content: "prior prompt" },
      { role: "assistant", content: "prior failed response" }
    ],
    resumeSession: "failed-session",
    continueSession: true,
    lastHeartbeat: { agentResume: "failed-session", agentConversation: ["prior"] },
    taskContext: { attempt: 2 }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(resets, 2);
  assert.equal(calls[1]?.prompt, "worktree isolation\n\nthe original task prompt\n\nstructured output contract");
  assert.equal("messages" in (calls[1] ?? {}), false);
  assert.equal(calls[1]?.resumeSession, undefined);
  assert.equal(calls[1]?.continueSession, false);
  assert.equal(calls[1]?.lastHeartbeat, undefined);

  await wrapped.generate({
    messages: [{ role: "user", content: "repair the schema" }],
    taskContext: { attempt: 2 }
  });
  assert.equal(resets, 2);
  assert.deepEqual(calls[2]?.messages, [{ role: "user", content: "repair the schema" }]);
  assert.equal(calls[2]?.prompt, undefined);
});

test("generated agent boundary enforces exact and over run/attempt ceilings", async () => {
  let durableEvidence: Record<string, unknown> | undefined;
  const artifactAwareAgent = loadArtifactAwareAgent({
    onBudgetEvidence: (_filePath, contents) => {
      durableEvidence = JSON.parse(contents) as Record<string, unknown>;
    }
  });
  const prompt = "bounded prompt";
  const exactContextBytes = Buffer.byteLength(prompt, "utf8");
  const resourceBudget = {
    maxCostUsd: 1,
    maxTotalTokens: 100,
    maxRequests: 1,
    maxTurns: 1,
    maxContextBytes: exactContextBytes,
    maxOutputBytes: 2,
    maxAttemptTokens: 100,
    maxAttemptRequests: 1,
    maxAttemptTurns: 1,
    maxAttemptContextBytes: exactContextBytes,
    maxAttemptOutputBytes: 2
  };
  let boundedArgs: Record<string, unknown> | undefined;
  const wrapped = artifactAwareAgent(
    {
      id: "node:budget-boundary",
      smithersRunId: "ultrafuzz-generated-budget-boundary",
      runRoot: ".",
      agentChain: [{}],
      resourceBudget,
      metadata: { run: { ultrafuzzRunId: "generated-budget-boundary" } }
    },
    0,
    prompt,
    {
      async generate(args: unknown): Promise<unknown> {
        boundedArgs = args as Record<string, unknown>;
        await (boundedArgs.onEvent as (event: unknown) => Promise<void>)({
          type: "action",
          phase: "started",
          action: { kind: "turn" }
        });
        return "ok";
      }
    }
  );

  assert.equal(await wrapped.generate({ prompt, taskContext: { attempt: 1 } }), "ok");
  assert.equal(boundedArgs?.maxOutputBytes, 2);
  assert.equal((boundedArgs?.abortSignal as AbortSignal).aborted, false);
  await assert.rejects(
    () => wrapped.generate({ prompt, taskContext: { attempt: 1 } }),
    /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED.*"resource":"requests"/u
  );
  assert.equal((boundedArgs?.abortSignal as AbortSignal).aborted, true);
  assert.equal(durableEvidence?.schema_version, "ultrafuzz.resource-budget-exhaustion.v1");
  assert.equal(durableEvidence?.resource, "requests");
  assert.equal(durableEvidence?.scope, "run");
  assert.equal(durableEvidence?.limit, 1);
  assert.equal(durableEvidence?.observed, 2);
});

test("generated agent boundary counts only normalized adapter turns", async () => {
  const artifactAwareAgent = loadArtifactAwareAgent();
  const nonTurns = [
    { type: "started", engine: "codex" },
    { type: "action", phase: "started", entryType: "thought", action: { kind: "command", title: "tool" } },
    { type: "action", phase: "completed", entryType: "thought", action: { kind: "warning", title: "stderr" } },
    { type: "completed", ok: true }
  ];
  const wrapped = artifactAwareAgent(
    {
      id: "node:budget-turn",
      smithersRunId: "ultrafuzz-generated-budget-turn",
      runRoot: ".",
      agentChain: [{}],
      resourceBudget: {
        maxCostUsd: 1,
        maxTotalTokens: 100,
        maxRequests: 10,
        maxTurns: 1,
        maxContextBytes: 10_000,
        maxOutputBytes: 10_000,
        maxAttemptTokens: 100,
        maxAttemptRequests: 10,
        maxAttemptTurns: 1,
        maxAttemptContextBytes: 10_000,
        maxAttemptOutputBytes: 10_000
      },
      metadata: { run: { ultrafuzzRunId: "generated-budget-turn" } }
    },
    0,
    "prompt",
    {
      async generate(args: unknown): Promise<unknown> {
        const onEvent = (args as { onEvent: (event: unknown) => Promise<void> }).onEvent;
        for (const event of nonTurns) await onEvent(event);
        await onEvent({ type: "action", phase: "started", entryType: "thought", action: { kind: "turn" } });
        for (const event of nonTurns) await onEvent(event);
        await onEvent({
          type: "action",
          phase: "updated",
          entryType: "message",
          action: { kind: "note", title: "assistant" }
        });
        return "unreachable";
      }
    }
  );

  await assert.rejects(
    () => wrapped.generate({ prompt: "prompt", taskContext: { attempt: 1 } }),
    /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED.*"resource":"turns"/u
  );
});

test("generated agent boundary charges each adapter-internal provider retry", async () => {
  const artifactAwareAgent = loadArtifactAwareAgent();
  let providerCalls = 0;
  const wrapped = artifactAwareAgent(
    {
      id: "node:budget-provider-retry",
      smithersRunId: "ultrafuzz-generated-budget-provider-retry",
      runRoot: ".",
      agentChain: [{}],
      resourceBudget: {
        maxCostUsd: 1,
        maxTotalTokens: 100,
        maxRequests: 1,
        maxTurns: 10,
        maxContextBytes: 10_000,
        maxOutputBytes: 10_000,
        maxAttemptTokens: 100,
        maxAttemptRequests: 1,
        maxAttemptTurns: 10,
        maxAttemptContextBytes: 10_000,
        maxAttemptOutputBytes: 10_000
      },
      metadata: { run: { ultrafuzzRunId: "generated-budget-provider-retry" } }
    },
    0,
    "prompt",
    {
      async generate(args: unknown): Promise<unknown> {
        providerCalls += 1;
        (args as { onProviderRetry: () => void }).onProviderRetry();
        providerCalls += 1;
        return "unreachable";
      }
    }
  );

  await assert.rejects(
    () => wrapped.generate({ prompt: "prompt", taskContext: { attempt: 1 } }),
    /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED.*"resource":"requests"/u
  );
  assert.equal(providerCalls, 1, "budget exhaustion must stop the retry before its provider invocation");
});

test("generated agent boundary aborts incrementally on stdout and stderr bytes", async () => {
  const artifactAwareAgent = loadArtifactAwareAgent();
  let abortSignal: AbortSignal | undefined;
  const relayed: string[] = [];
  const wrapped = artifactAwareAgent(
    {
      id: "node:budget-stream",
      smithersRunId: "ultrafuzz-generated-budget-stream",
      runRoot: ".",
      agentChain: [{}],
      resourceBudget: {
        maxCostUsd: 1,
        maxTotalTokens: 100,
        maxRequests: 10,
        maxTurns: 10,
        maxContextBytes: 10_000,
        maxOutputBytes: 3,
        maxAttemptTokens: 100,
        maxAttemptRequests: 10,
        maxAttemptTurns: 10,
        maxAttemptContextBytes: 10_000,
        maxAttemptOutputBytes: 3
      },
      metadata: { run: { ultrafuzzRunId: "generated-budget-stream" } }
    },
    0,
    "prompt",
    {
      async generate(args: unknown): Promise<unknown> {
        const bounded = args as {
          abortSignal: AbortSignal;
          onStdout: (text: string) => void;
          onStderr: (text: string) => void;
        };
        abortSignal = bounded.abortSignal;
        bounded.onStdout("ab");
        bounded.onStderr("c");
        bounded.onStdout("d");
        return "ignored";
      }
    }
  );

  await assert.rejects(
    () =>
      wrapped.generate({
        prompt: "prompt",
        taskContext: { attempt: 1 },
        onStdout: (text: string) => relayed.push(`stdout:${text}`),
        onStderr: (text: string) => relayed.push(`stderr:${text}`)
      }),
    /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED.*"resource":"output_bytes"/u
  );
  assert.equal(abortSignal?.aborted, true);
  assert.deepEqual(relayed, ["stdout:ab", "stderr:c"]);
});

test("generated agent boundary restores durable aggregate counters after a process restart", async () => {
  const persistedBudgetStates = new Map<string, string>();
  const resourceBudget = {
    maxCostUsd: 1,
    maxTotalTokens: 100,
    maxRequests: 1,
    maxTurns: 10,
    maxContextBytes: 10_000,
    maxOutputBytes: 10_000,
    maxAttemptTokens: 100,
    maxAttemptRequests: 10,
    maxAttemptTurns: 10,
    maxAttemptContextBytes: 10_000,
    maxAttemptOutputBytes: 10_000
  };
  const task = (id: string) => ({
    id,
    smithersRunId: "ultrafuzz-generated-budget-restart",
    runRoot: ".",
    agentChain: [{}],
    resourceBudget,
    resourceBudgetPartitioned: false,
    metadata: { run: { ultrafuzzRunId: "generated-budget-restart" } }
  });

  const beforeRestart = loadArtifactAwareAgent({ persistedBudgetStates });
  const first = beforeRestart(task("node:first"), 0, "prompt", {
    async generate(): Promise<unknown> {
      return "";
    }
  });
  assert.equal(await first.generate({ prompt: "prompt", taskContext: { attempt: 1 } }), "");
  assert.equal(persistedBudgetStates.size, 1);

  let invokedAfterRestart = false;
  let durableEvidence: Record<string, unknown> | undefined;
  const afterRestart = loadArtifactAwareAgent({
    persistedBudgetStates,
    onBudgetEvidence: (_filePath, contents) => {
      durableEvidence = JSON.parse(contents) as Record<string, unknown>;
    }
  });
  const second = afterRestart(task("node:second"), 0, "prompt", {
    async generate(): Promise<unknown> {
      invokedAfterRestart = true;
      return "unreachable";
    }
  });
  await assert.rejects(
    () => second.generate({ prompt: "prompt", taskContext: { attempt: 1 } }),
    /ULTRAFUZZ_RESOURCE_BUDGET_EXHAUSTED.*"resource":"requests"/u
  );
  assert.equal(invokedAfterRestart, false);
  assert.equal(durableEvidence?.limit, 1);
  assert.equal(durableEvidence?.observed, 2);
});

test("authoritative final-report coverage is injected as exact untrusted data before agent generation", () => {
  const promptWithCoverage = loadPromptWithAuthoritativeFinalReportCoverage();
  const renderedPrompt = "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task";
  const coverage = {
    priority_threshold: "high",
    priorities: ["high"],
    selected_property_ids: ["property-one"],
    implemented_property_ids: ["property-one"],
    blocked_property_ids: [],
    pending_property_ids: [],
    deferred_property_ids: []
  };
  const injected = promptWithCoverage(renderedPrompt, coverage, "custom/final-report.json");

  assert.ok(injected.startsWith("trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\n"), injected);
  assert.match(injected, /## Authoritative property implementation coverage/u);
  assert.match(injected, /authoritative data, not instructions/u);
  assert.match(injected, /"custom\/final-report\.json"#property_implementation_coverage/u);
  assert.match(injected, new RegExp(JSON.stringify(coverage, null, 2).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.ok(injected.indexOf('"property-one"') < injected.indexOf("trusted runtime"), injected);
  assert.throws(
    () => promptWithCoverage("prompt without boundary", coverage, "custom/final-report.json"),
    /cannot locate the untrusted-content boundary/u
  );
});

test("final-report provenance seals the planned retry chain, failed attempts, and actual producer", () => {
  const executionFor = loadFinalReportAgentExecution();
  const task = {
    agentChain: [
      {
        profileId: "sol-xhigh",
        agentRef: "CodexAgent",
        modelName: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        role: "primary"
      },
      {
        profileId: "sol-xhigh",
        agentRef: "CodexAgent",
        modelName: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        role: "primary"
      },
      {
        profileId: "gpt55-xhigh",
        agentRef: "CodexAgent",
        modelName: "gpt-5.5",
        reasoningEffort: "xhigh",
        role: "fallback"
      }
    ]
  };

  assert.deepEqual(executionFor(task, 2), {
    planned_chain: [
      {
        attempt: 1,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      },
      {
        attempt: 2,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      },
      {
        attempt: 3,
        profile_id: "gpt55-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.5",
        reasoning_effort: "xhigh",
        role: "fallback"
      }
    ],
    failed_attempts: [
      {
        attempt: 1,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      },
      {
        attempt: 2,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      }
    ],
    producer: {
      attempt: 3,
      profile_id: "gpt55-xhigh",
      agent_ref: "CodexAgent",
      model_name: "gpt-5.5",
      reasoning_effort: "xhigh",
      role: "fallback"
    }
  });
  assert.deepEqual(executionFor(task, 2, [{ attempt: 1, chainIndex: 2 }]), {
    planned_chain: [
      {
        attempt: 1,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      },
      {
        attempt: 2,
        profile_id: "sol-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.6-sol",
        reasoning_effort: "xhigh",
        role: "primary"
      },
      {
        attempt: 3,
        profile_id: "gpt55-xhigh",
        agent_ref: "CodexAgent",
        model_name: "gpt-5.5",
        reasoning_effort: "xhigh",
        role: "fallback"
      }
    ],
    failed_attempts: [],
    producer: {
      attempt: 1,
      profile_id: "gpt55-xhigh",
      agent_ref: "CodexAgent",
      model_name: "gpt-5.5",
      reasoning_effort: "xhigh",
      role: "fallback"
    }
  });

  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verification = source.slice(
    source.indexOf("function verifyFinalReportCanonicalProjection"),
    source.indexOf("function readInvariantSourceSnapshot")
  );
  assert.match(verification, /authoritativeFinalReportAgentExecution\(task\)/u);
  assert.match(verification, /controller-observed producer/u);
  assert.doesNotMatch(source, /agent-execution|execution\.json|readFinalReportAgentExecutionRecord/u);
  assert.match(source, /reconcileSmithersAttemptAgentSelection\(task, authorityDetail/u);
  assert.match(source, /detail\.ok === true && isPlainJsonRecord\(detail\.data\)/u);
  assert.match(source, /finalReportAgentExecutionAuthority\.get\(task\.attemptId\)/u);

  const promptWithExecution = loadPromptWithAuthoritativeFinalReportAgentExecution();
  const originalPrompt = "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task";
  const execution = executionFor(task, 2);
  const firstAttemptPrompt = promptWithExecution(originalPrompt, execution, "report.json");
  const fallbackAttemptPrompt = promptWithExecution(originalPrompt, execution, "report.json");
  assert.equal(fallbackAttemptPrompt, firstAttemptPrompt);
  assert.match(firstAttemptPrompt, /controller-derived data/u);
  assert.match(firstAttemptPrompt, /"profile_id": "gpt55-xhigh"/u);
  assert.match(firstAttemptPrompt, /"failed_attempts"/u);
});

test("a non-Codex fallback cannot forge final-report producer authority through the run filesystem", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-forged-producer-"));
  try {
    const task = {
      id: "node:final-report",
      attemptId: "final-report",
      runRoot: root,
      smithersRunId: "ultrafuzz-authority-recovery",
      agentChain: [{ profileId: "primary" }, { profileId: "deepseek" }]
    };
    const actual = {
      planned_chain: [{ attempt: 1, profile_id: "deepseek", agent_ref: "DeepSeekAgent", role: "fallback" }],
      failed_attempts: [],
      producer: { attempt: 1, profile_id: "deepseek", agent_ref: "DeepSeekAgent", role: "fallback" }
    };
    const forged = {
      ...actual,
      producer: { attempt: 1, profile_id: "forged", agent_ref: "CodexAgent", role: "primary" }
    };
    const legacyRecord = path.join(root, "smithers", "agent-execution", "final-report", "execution.json");
    fs.mkdirSync(path.dirname(legacyRecord), { recursive: true });
    fs.writeFileSync(legacyRecord, `${JSON.stringify(forged)}\n`, "utf8");

    const authority = loadFinalReportAgentExecutionAuthority();
    authority.remember(task, actual);
    assert.deepEqual(authority.read(task), actual);
    assert.equal(authority.smithersReads(), 0);
    assert.notDeepEqual(authority.read(task), JSON.parse(fs.readFileSync(legacyRecord, "utf8")));

    const recovered = loadFinalReportAgentExecutionAuthority({
      smithersDetail: {
        ok: true,
        data: {
          node: { nodeId: task.id, lastAttempt: 1 },
          attempts: [
            {
              nodeId: task.id,
              attempt: 1,
              state: "finished",
              meta: {
                agentChainIndex: 0,
                agentId: "ultrafuzz-agent:final-report:0:deepseek",
                agentModel: "deepseek-chat"
              }
            }
          ]
        },
        meta: { command: "node", duration: "1ms" }
      },
      chainIndex: 0,
      execution: actual
    });
    assert.deepEqual(recovered.read(task), actual);
    assert.equal(recovered.smithersReads(), 1);
    assert.notDeepEqual(recovered.read(task), JSON.parse(fs.readFileSync(legacyRecord, "utf8")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("single-rung final-report authority survives a worker restart without a run-ID lookup", () => {
  const execution = {
    planned_chain: [{ attempt: 1, profile_id: "primary", agent_ref: "CodexAgent", role: "primary" }],
    failed_attempts: [],
    producer: { attempt: 1, profile_id: "primary", agent_ref: "CodexAgent", role: "primary" }
  };
  const authority = loadFinalReportAgentExecutionAuthority({ execution });
  assert.deepEqual(authority.read({ attemptId: "final-report", agentChain: [{ profileId: "primary" }] }), execution);
  assert.equal(authority.smithersReads(), 0);
});

test("generated retries do not inspect or inject previous failure text", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agent = source.slice(
    source.indexOf("function artifactAwareAgent"),
    source.indexOf("function isStrictlyInsideDirectory")
  );
  const retryStart = agent.indexOf("const retryArgs =");
  const retryEnd = agent.indexOf("let observedSelections", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart, agent);
  const retry = agent.slice(retryStart, retryEnd);
  assert.doesNotMatch(source, /retryFailureAwareArgs|retryFailureText|Untrusted prior-attempt failure/u);
  assert.doesNotMatch(agent, /previousFailure|error\.message|String\(error\)/u);
  assert.doesNotMatch(retry, /\b(?:catch|error)\b/u);
  assert.match(agent, /prompt: typeof args\?\.prompt === "string" \? args\.prompt : originalPrompt/u);
  assert.match(agent, /resumeSession: undefined/u);
  assert.match(agent, /continueSession: false/u);
  assert.match(agent, /lastHeartbeat: undefined/u);
  assert.match(agent, /delete freshArgs\.messages/u);
  assert.match(agent, /return await agent\.generate\(attemptArgs\)/u);
});

test("retry cleanup preserves only a task-owned prompt and accepts a sealed snapshot prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-retry-prompt-"));
  try {
    const artifactDir = path.join(root, "run", "artifacts", "final-report");
    const taskPrompt = path.join(artifactDir, "prompt.rendered.md");
    const sealedPrompt = path.join(
      root,
      "run",
      "smithers",
      "execution-snapshots",
      "sealed",
      "controls",
      "rendered-prompts",
      "final-report.md"
    );
    fs.mkdirSync(path.dirname(taskPrompt), { recursive: true });
    fs.mkdirSync(path.dirname(sealedPrompt), { recursive: true });
    fs.writeFileSync(taskPrompt, "legacy prompt\n");
    fs.writeFileSync(sealedPrompt, "sealed prompt\n");

    const taskPromptPathForArtifactReset = loadTaskPromptPathForArtifactReset();
    const resetCanonicalArtifacts = loadCanonicalTaskArtifactRetryReset();
    assert.equal(taskPromptPathForArtifactReset(artifactDir, taskPrompt), taskPrompt);
    assert.equal(taskPromptPathForArtifactReset(artifactDir, sealedPrompt), undefined);
    assert.equal(taskPromptPathForArtifactReset(artifactDir, path.join(artifactDir, "nested", "prompt.md")), undefined);

    fs.writeFileSync(path.join(artifactDir, "stale-report.json"), "{}\n");
    resetCanonicalArtifacts(artifactDir, "final-report", taskPrompt);
    assert.equal(fs.readFileSync(taskPrompt, "utf8"), "legacy prompt\n");
    assert.equal(fs.existsSync(path.join(artifactDir, "stale-report.json")), false);

    fs.mkdirSync(path.join(artifactDir, "stale", "nested"), { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "stale", "nested", "report.md"), "stale\n");
    resetCanonicalArtifacts(artifactDir, "final-report", sealedPrompt);
    assert.deepEqual(fs.readdirSync(artifactDir), []);
    assert.equal(fs.readFileSync(sealedPrompt, "utf8"), "sealed prompt\n");

    const linkedPrompt = path.join(artifactDir, "prompt.rendered.md");
    fs.symlinkSync(sealedPrompt, linkedPrompt);
    assert.throws(
      () => resetCanonicalArtifacts(artifactDir, "final-report", linkedPrompt),
      /unsafe canonical task input final-report/u
    );
    assert.equal(fs.readFileSync(sealedPrompt, "utf8"), "sealed prompt\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers resets exact task-owned artifact contents before every selected attempt", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const rootsStart = source.indexOf("function resetTaskArtifactsForRetry");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(rootsStart > agentStart, source);
  assert.ok(preparationStart > rootsStart, source);

  const agent = source.slice(agentStart, rootsStart);
  assert.match(agent, /if \(firstGenerationForAttempt\)/u);
  assert.ok(
    agent.indexOf("resetTaskArtifactsForRetry(task)") < agent.indexOf("return await agent.generate(attemptArgs)"),
    agent
  );

  const reset = source.slice(rootsStart, preparationStart);
  assert.match(
    reset,
    /const promptPath = taskPromptPathForArtifactReset\(task\.metadata\.artifacts\.dir, task\.promptPath\)/u
  );
  assert.match(
    reset,
    /resetTaskArtifactContents\(task\.metadata\.artifacts\.dir, task\.attemptId, "canonical", promptPath\)/u
  );
  assert.match(
    reset,
    /resetTaskArtifactContents\(path\.join\(artifactsParent, task\.attemptId\), task\.attemptId, "mirror"\)/u
  );
  assert.match(reset, /output\.contract === "ultrafuzz\/generated-tests@3"/u);
  assert.match(reset, /for \(const testRoot of invariantTestRoots\(workspaceRoot\)\)/u);
  assert.match(reset, /path\.resolve\(workspaceRoot, testRoot, "foundry"\)/u);
  assert.match(reset, /for \(const nodeId of generatedTestNodeIds\(task\)\)/u);
  assert.match(reset, /path\.join\(foundryParent, nodeId\), nodeId, "generated-test"/u);
  assert.match(reset, /path\.basename\(candidate\) !== attemptId/u);
  assert.match(reset, /const parent = realpathSync\(path\.dirname\(candidate\)\)/u);
  assert.match(reset, /const anchoredRoot = realpathSync\(candidate\)/u);
  assert.match(reset, /anchoredRoot !== path\.join\(parent, attemptId\)/u);
  assert.match(reset, /const preservedInput =/u);
  assert.match(reset, /candidate === preservedInput/u);
  assert.match(reset, /for \(const entry of readdirSync\(anchoredRoot\)\)/u);
  assert.match(reset, /rmSync\(candidate, \{ recursive: true, force: true \}\)/u);
  assert.match(reset, /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, evidenceMode: "require" \}\)/u);
  assert.match(reset, /WORKSPACE_PATCH_BASELINE_FILE/u);
});

test("post-agent preparation preserves newly added invariant sources for workspace-patch capture", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const materializeStart = source.indexOf("function materializeInvariantSuiteFromDependencies");
  const restoreStart = source.indexOf("function restoreInvariantSuiteWorkspaceSnapshot");
  const restoreEnd = source.indexOf("function assertTaskInputs", restoreStart);

  assert.ok(preparationStart >= 0, source);
  assert.ok(materializeStart > preparationStart, source);
  assert.ok(restoreStart >= 0, source);
  assert.ok(restoreEnd > restoreStart, source);

  const preparation = source.slice(preparationStart, materializeStart);
  const restore = source.slice(restoreStart, restoreEnd);

  // The post-agent preparation pass must not delete a source that the agent
  // just authored before materializeWorkspacePatch can capture it.
  assert.match(
    preparation,
    /restoreInvariantSuiteWorkspaceSnapshot\(task, \{[\s\S]*preserveCurrentSources: options\.replayWorkspacePatches === false/u
  );
  assert.match(restore, /preserveCurrentSources\?: boolean/u);
  assert.match(restore, /snapshot\.has\(safePath\) \|\| preserveCurrentSources/u);
  assert.match(restore, /if \(preserveCurrentSources\) return/u);
});

test("post-agent snapshot restoration keeps modified, deleted, and new source state", () => {
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-restore-"));
  const workspace = path.join(runRoot, "workspace");
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  const baselinePath = path.join(workspace, "test", "baseline.t.sol");
  const newPath = path.join(workspace, "test", "new.t.sol");
  const snapshots = new Map<string, Map<string, Buffer>>([
    ["attempt", new Map([["test/baseline.t.sol", Buffer.from("baseline\n")]])]
  ]);
  const restore = loadRestoreInvariantSuiteWorkspaceSnapshot(snapshots);
  const task = {
    attemptId: "attempt",
    workspacePath: workspace,
    runRoot: path.relative(process.cwd(), runRoot)
  };

  try {
    fs.writeFileSync(baselinePath, "agent-modified\n");
    fs.writeFileSync(newPath, "agent-added\n");
    restore(task, { preserveCurrentSources: true });
    assert.equal(fs.readFileSync(baselinePath, "utf8"), "agent-modified\n");
    assert.equal(fs.readFileSync(newPath, "utf8"), "agent-added\n");

    fs.writeFileSync(baselinePath, "retry-modified\n");
    fs.writeFileSync(newPath, "retry-added\n");
    restore(task);
    assert.equal(fs.readFileSync(baselinePath, "utf8"), "baseline\n");
    assert.equal(fs.existsSync(newPath), false);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("generated Smithers agent boundary performs no post-completion artifact work", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const agentEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", agentStart);

  assert.ok(agentStart >= 0, source);
  assert.ok(agentEnd > agentStart, source);

  const agent = source.slice(agentStart, agentEnd);
  assert.match(agent, /return await agent\.generate\(attemptArgs\)/u);
  assert.doesNotMatch(
    agent,
    /prepareArtifactMirror|materializeMissing|normalizeLegacy|materializeGeneratedTestCompanions|verifyArtifacts/u
  );
  assert.match(source, /function finalizeAndVerifyArtifacts/u);
  assert.match(source, /dependsOn=\{\[task\.id\]\}[\s\S]*?retries=\{0\}/u);
});

test("generated Smithers workflow contains no output repair or legacy normalization helpers", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(
    source,
    /canonicalEmptyArtifact|materializeMissingMarkdownArtifacts|materializeMissingDedupeArtifact|materializeMissingFinalReportArtifacts|materializeGeneratedTestCompanion|normalizeLegacyFinding|normalizeLegacyReportProvenance|normalizeLegacyGeneratedTest/u
  );
});

test("durable writer replaces a destination symlink without overwriting its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-durable-writer-"));
  try {
    const symlinkTarget = path.join(root, "target.txt");
    const output = path.join(root, "output.txt");
    fs.writeFileSync(symlinkTarget, "target remains unchanged\n");
    fs.symlinkSync(symlinkTarget, output);

    writeFileDurable(output, "caller-authored bytes\n");

    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "target remains unchanged\n");
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(output, "utf8"), "caller-authored bytes\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers agent never promotes dedupe findings into a final report", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(
    source,
    /materializeMissingFinalReportArtifacts|meaningfulFinalReport|normalizedFallbackReportIssue/u
  );
});

test("generated Smithers agent never synthesizes final-report Markdown", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /materializeMissingMarkdownArtifacts|agentResultSummary|writeRecoveredReportMarkdown/u);
});

test("generated Smithers verifier treats the final-report projector only as a non-mutating oracle", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verifierStart = source.indexOf("function verifyFinalReportCanonicalProjection");
  const verifierEnd = source.indexOf("\n\nfunction readInvariantSourceSnapshot", verifierStart);
  assert.ok(verifierStart >= 0, source);
  assert.ok(verifierEnd > verifierStart, source);
  const verifier = source.slice(verifierStart, verifierEnd);

  assert.match(verifier, /authoritativeFinalReportCoverage\(task\)/u);
  assert.match(verifier, /projectCanonicalFinalReport\(report\.value\)/u);
  assert.match(verifier, /isDeepStrictEqual\(projection\.report, report\.value\)/u);
  assert.match(verifier, /markdown\.file\.bytes\.equals\(Buffer\.from\(projection\.markdown, "utf8"\)\)/u);
  assert.match(verifier, /agent-owned bytes were left unchanged/u);
  assert.doesNotMatch(verifier, /writeFile|writeJson|rename|unlink|rmSync/u);
  assert.doesNotMatch(source, /ultrafuzz\/implemented-properties@1|ultrafuzz\/implemented-properties@2/u);
  assert.match(source, /status: "not-planned",\s+reason: "property-implementation-track-not-declared"/u);
  assert.doesNotMatch(source, /return "unavailable"/u);
});

const FINAL_REPORT_AGENT_EXECUTION_FIXTURE = {
  planned_chain: [{ attempt: 1, profile_id: "default", agent_ref: "CodexAgent", role: "primary" }],
  failed_attempts: [],
  producer: { attempt: 1, profile_id: "default", agent_ref: "CodexAgent", role: "primary" }
};

function loadFinalReportCanonicalProjectionHarness(): (
  task: { outputs: Array<{ path: string; contract: string }> },
  verifiedOutputs: ReadonlyMap<string, { value: unknown; file: { bytes: Buffer } }>
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const declarationStart = source.indexOf("function declaredFinalReportOutputPair");
  const declarationEnd = source.indexOf("\n\nfunction configuredInvariantPrioritySelection", declarationStart);
  const verifierStart = source.indexOf("function isPlainJsonRecord");
  const verifierEnd = source.indexOf("\n\nfunction readInvariantSourceSnapshot", verifierStart);
  assert.ok(declarationStart >= 0 && declarationEnd > declarationStart, source);
  assert.ok(verifierStart >= 0 && verifierEnd > verifierStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(declarationStart, declarationEnd)}\n${source.slice(verifierStart, verifierEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return new Function(
    "authoritativeFinalReportCoverage",
    "isDeepStrictEqual",
    "projectCanonicalFinalReport",
    "authoritativeFinalReportAgentExecution",
    "Buffer",
    `${emitted}; return verifyFinalReportCanonicalProjection;`
  )(
    () => ({ status: "not-planned", reason: "property-implementation-track-not-declared" }),
    isDeepStrictEqual,
    (report: unknown) => ({ report, markdown: "# Canonical custom report\n" }),
    () => FINAL_REPORT_AGENT_EXECUTION_FIXTURE,
    Buffer
  ) as ReturnType<typeof loadFinalReportCanonicalProjectionHarness>;
}

test("generated canonical report verification selects renamed producers and custom declared paths", () => {
  const verifyProjection = loadFinalReportCanonicalProjectionHarness();
  const task = {
    outputs: [
      { path: "deliverables/security-audit.json", contract: "ultrafuzz/report@3" },
      { path: "deliverables/security-audit.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };
  const report = {
    run_metadata: { agent_execution: FINAL_REPORT_AGENT_EXECUTION_FIXTURE },
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  };
  const verified = new Map<string, { value: unknown; file: { bytes: Buffer } }>([
    ["deliverables/security-audit.json", { value: report, file: { bytes: Buffer.from("declared JSON") } }],
    [
      "deliverables/security-audit.md",
      { value: "# Canonical custom report\n", file: { bytes: Buffer.from("# Canonical custom report\n") } }
    ],
    ["report.json", { value: { property_implementation_coverage: null }, file: { bytes: Buffer.from("ignored") } }],
    ["report.md", { value: "ignored", file: { bytes: Buffer.from("ignored") } }]
  ]);

  assert.doesNotThrow(() => verifyProjection(task, verified));

  const withoutDeclaredMarkdown = new Map(verified);
  withoutDeclaredMarkdown.delete("deliverables/security-audit.md");
  assert.throws(() => verifyProjection(task, withoutDeclaredMarkdown), /declared report outputs are unavailable/iu);

  assert.throws(
    () =>
      verifyProjection(
        {
          outputs: [...task.outputs, { path: "deliverables/second-audit.json", contract: "ultrafuzz/report@3" }]
        },
        verified
      ),
    /exactly one current ultrafuzz\/report@3 output/iu
  );
});

test("generated Smithers agent rejects v2 and legacy generated-test lists without conversion", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /normalizeLegacyGeneratedTestManifests|typeof entry === "string" \? \{ path: entry \}/u);
  assert.doesNotMatch(source, /ultrafuzz\/generated-tests@2|support_files\?:|\.support_files\s*\?\?\s*\[\]/u);
});

test("generated Smithers agent does not strip finding path suffixes", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /normalizeLegacyPathReference|withoutHashLineSuffix/u);
});

test("generated Smithers agent does not convert legacy finding field shapes", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(
    source,
    /normalizeLegacyFindingFields|finding\.confidence = String|finding\.evidence = \[evidence\]/u
  );
});

test("generated Smithers agent does not convert legacy report provenance", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /normalizeLegacyReportProvenance|normalizeFinalReportSeverityRecord|originalIsValid/u);
});

test("generated Smithers never infers or repairs missing generated-test companions", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /materializeGeneratedTestCompanion/u);
  assert.doesNotMatch(source, /generated test sources conflict/u);
  assert.match(
    source,
    /Generated-test companions are agent-owned outputs[\s\S]*?verifyOutputSemanticGates\(task, verifiedOutputs, campaignEvidence\)/u
  );
  assert.doesNotMatch(source, /const workspaceRelativePath = relativePath\.slice/u);
});

test("generated Smithers retries clear every task-owned generated-test work directory", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const resetStart = source.indexOf("function resetTaskArtifactsForRetry");
  const resetEnd = source.indexOf("function resetTaskArtifactContents", resetStart);
  assert.ok(resetStart >= 0, source);
  assert.ok(resetEnd > resetStart, source);

  const reset = source.slice(resetStart, resetEnd);
  assert.match(reset, /for \(const nodeId of generatedTestNodeIds\(task\)\) \{/u);
  assert.match(reset, /resetTaskArtifactContents\(path\.join\(foundryParent, nodeId\), nodeId, "generated-test"\)/u);
  assert.match(
    source,
    /function generatedTestNodeIds[\s\S]*new Set\(\[task\.metadata\.node\.logicalNodeId, task\.metadata\.node\.concreteNodeId\]\)/u
  );
});

test("generated Smithers workflow preserves the complete invariant suite across worktree handoffs", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(preparationStart >= 0, source);
  assert.ok(resolverStart > preparationStart, source);
  assert.ok(workflowStart > verifierStart, source);
  assert.match(source, /materializeInvariantSuiteFromDependencies\(task, workspaceRoot\)/u);
  assert.match(source, /materializeInvariantSuiteCompanions\(task, capturedOutputs\)/u);
  assert.match(source, /validateImplementedPropertiesSchema/u);
  assert.match(source, /invariant-suite/u);
  assert.match(source, /changedTestTreePaths/u);
  assert.match(source, /changedInvariantSourcePaths/u);
  assert.match(source, /CryticTester/u);
  assert.match(source, /TargetFunctions/u);
  assert.match(source, /Properties/u);
  assert.match(source, /copyInvariantSuiteIntoWorkspace/u);
  assert.match(source, /rememberInvariantSuitePublications\(task, publications, artifactRoots\)/u);
  assert.match(source, /artifact handoff is missing invariant-suite sources/u);
  assert.match(source, /stateful-invariant-setup/u);
  assert.match(source, /stateful-invariant-handlers/u);
  assert.match(source, /stateful-invariant-coverage/u);
  assert.match(source, /directDependencies/u);
  assert.match(source, /leftDirect \? 1 : -1/u);
  assert.match(source, /safeInvariantSuiteDirectory/u);
  assert.match(source, /invariant suite destination is a symlink/u);
  assert.match(source, /invariant suite directory is unsafe/u);
  assert.match(source, /MAX_INVARIANT_SUITE_PATH_LENGTH/u);
  assert.match(source, /MAX_INVARIANT_SUITE_SEGMENT_LENGTH/u);
  assert.match(source, /MAX_INVARIANT_SUITE_FILES/u);
  assert.match(source, /MAX_INVARIANT_SUITE_SOURCE_BYTES/u);
  assert.match(source, /MAX_INVARIANT_SUITE_TOTAL_BYTES/u);
  assert.match(source, /INVARIANT_SUITE_BASELINE_FILE/u);
  assert.match(source, /captureInvariantSuiteBaseline/u);
  assert.match(source, /invariantSuiteProtectedBaselinePath/u);
  assert.match(source, /protected invariant suite baseline was modified/u);
  assert.match(source, /INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID/u);
  assert.match(source, /parseRuntimeDocumentBytes\(\s*INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,\s*snapshot\.bytes/u);
  assert.match(source, /gitTestTreePaths/u);
  assert.match(source, /INVARIANT_SUITE_SENSITIVE_SEGMENTS/u);
  assert.match(source, /assertSafeInvariantSuiteTestPath/u);
  assert.match(source, /record\.implementation_paths/u);
  assert.match(source, /record\.test_paths/u);
  assert.match(source, /pinnedSourceRef, "HEAD\^"/u);
  assert.match(source, /\$\{baseRef\}\.\.\.HEAD/u);
  assert.match(source, /implemented properties JSON is invalid/u);
  assert.match(source, /selectedSources/u);
  assert.match(source, /ancestor invariant suite sources conflict/u);
  assert.match(source, /src\/contracts/u);
  assert.match(source, /invariant suite source is hard-linked/u);
  assert.match(source, /unable to enumerate changed invariant suite sources/u);
  assert.match(source, /writeFileDurable\(anchoredDestination/u);
  assert.match(source, /for \(const \[relativePath, bytes\] of publicationSnapshot\)/u);
  assert.match(source, /invariantSuiteDependencySnapshots/u);
  assert.match(source, /invariant suite dependency changed/u);
  assert.match(source, /captureInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /restoreInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /INVARIANT_SUITE_MANIFEST_FILE/u);
  assert.match(source, /INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION/u);
  assert.match(source, /assertValidInvariantSuiteManifest\(manifest\)/u);
  assert.match(source, /parseInvariantSuiteManifestBytes\(manifestBytes\)/u);
  assert.doesNotMatch(source, /invariant-suite-manifest\.v1/u);
  assert.match(source, /INVARIANT_SUITE_ALLOWED_ROOTS/u);
  assert.match(source, /ancestor invariant suite sources conflict/u);

  const suiteMaterializerStart = source.indexOf("function materializeInvariantSuiteFromDependencies");
  const suitePublicationStart = source.indexOf("function rememberInvariantSuitePublications");
  assert.ok(suiteMaterializerStart > preparationStart, source);
  assert.ok(suitePublicationStart > suiteMaterializerStart, source);
  assert.ok(resolverStart > suitePublicationStart, source);
  assert.ok(workflowStart > resolverStart, source);
});

test("generated Smithers invariant discovery uses a Git-compatible ls-files invocation", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");

  assert.doesNotMatch(source, /--no-exclude-standard/u);
  assert.match(
    source,
    /invariantSuiteGitPaths\(workspaceRoot, \[\s*"ls-files",\s*"--cached",\s*"--others",\s*"--",\s*"src",\s*"contracts",\s*"test",\s*"tests"\s*\]\)/u
  );
  assert.match(source, /\["ls-files", "--others", "--", "src", "contracts"\]/u);
  assert.match(source, /\["ls-files", "--others", "--", "test", "tests"\]/u);
});

test("generated Smithers invariant discovery bounds every git enumeration it captures", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");

  // Node's `execFileSync` default is 1 MB, and an oversized listing then dies as an anonymous
  // `spawnSync git ENOBUFS` (#310, #323). Each discovery capture goes through the one helper that states
  // the bound, so a new call site that reintroduces a bare `execFileSync` fails here.
  assert.match(source, /const MAX_INVARIANT_SUITE_ENUMERATION_BYTES = /u);
  assert.match(source, /maxBuffer: MAX_INVARIANT_SUITE_ENUMERATION_BYTES/u);
  assert.match(source, /function rethrowOversizedInvariantSuiteEnumeration/u);
  assert.match(source, /listed more than the \$\{MAX_INVARIANT_SUITE_ENUMERATION_BYTES\}-byte enumeration buffer/u);
  for (const enumeration of [
    "captureInvariantSuiteBaseline",
    "invariantWorkspaceSourcePaths",
    "changedTestTreePaths",
    "changedInvariantSourcePaths",
    "gitTestTreePaths"
  ]) {
    const start = source.indexOf(`function ${enumeration}(`);
    assert.ok(start >= 0, enumeration);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /invariantSuiteGitPaths\(/u, enumeration);
    assert.doesNotMatch(body, /execFileSync\("git", \["ls-files"/u, enumeration);
  }
});

test("invariant git discovery includes tracked, untracked, and ignored sources", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-git-discovery-"));
  try {
    execFileSync("git", ["init", "--quiet", workspace]);
    for (const relativePath of [
      "src/tracked.sol",
      "contracts/untracked.sol",
      "test/ignored.sol",
      "tests/visible.sol"
    ]) {
      const filePath = path.join(workspace, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "contract Source {}\n");
    }
    fs.writeFileSync(path.join(workspace, ".gitignore"), "test/ignored.sol\n");
    execFileSync("git", ["add", "--", ".gitignore", "src/tracked.sol", "tests/visible.sol"], { cwd: workspace });

    const sourcePaths = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--", "src", "contracts", "test", "tests"],
      { cwd: workspace, encoding: "utf8" }
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    assert.deepEqual(
      new Set(sourcePaths),
      new Set(["contracts/untracked.sol", "src/tracked.sol", "test/ignored.sol", "tests/visible.sol"])
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("generated Smithers invariant provenance accepts only supported source roots", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const pathStart = source.indexOf("function assertSafeInvariantSuitePath");
  const pathEnd = source.indexOf("function assertSafeInvariantSuiteTestPath", pathStart);

  assert.ok(pathStart >= 0, source);
  assert.ok(pathEnd > pathStart, source);
  const validator = source.slice(pathStart, pathEnd);
  assert.match(validator, /INVARIANT_SUITE_ALLOWED_ROOTS\.some/u);
  assert.match(source, /const INVARIANT_SUITE_ALLOWED_ROOTS = \["src", "contracts", "test", "tests"\]/u);
  assert.match(validator, /unsupported invariant suite source root/u);
  assert.doesNotMatch(validator, /artifacts/u);
  assert.match(validator, /segment === "\.envrc"/u);
});

test("generated Smithers verifier rejects in-root leaf and parent symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-verifier-"));
  const realDirectory = path.join(root, "real");
  fs.mkdirSync(realDirectory);
  const realFile = path.join(realDirectory, "Test.t.sol");
  fs.writeFileSync(realFile, "contract Test {}\n");

  const leafSymlink = path.join(root, "Leaf.t.sol");
  fs.symlinkSync(realFile, leafSymlink);
  assert.throws(() => assertRegularFileInside(root, leafSymlink), /symlink/u);

  const parentSymlink = path.join(root, "linked-parent");
  fs.symlinkSync(realDirectory, parentSymlink, "dir");
  assert.throws(() => assertRegularFileInside(root, path.join(parentSymlink, "Test.t.sol")), /symlink/u);
});

test("generated Smithers retry snapshots are durable and restore through canonical parents", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const prepareStart = source.indexOf("function prepareArtifactMirror");
  const materializeStart = source.indexOf("function materializeInvariantSuiteFromDependencies");
  const restoreStart = source.indexOf("function restoreInvariantSuiteWorkspaceSnapshot");
  const restoreEnd = source.indexOf("function assertTaskInputs", restoreStart);
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(prepareStart >= 0 && materializeStart > prepareStart && restoreStart > prepareStart, source);
  assert.ok(restoreEnd > restoreStart, source);
  const prepare = source.slice(prepareStart, materializeStart);
  const restore = source.slice(restoreStart, restoreEnd);
  assert.ok(
    prepare.indexOf("restoreInvariantSuiteWorkspaceSnapshot(task)") <
      prepare.indexOf("materializeInvariantSuiteFromDependencies(task, workspaceRoot)")
  );
  assert.match(source, /INVARIANT_SUITE_WORKSPACE_SNAPSHOT_DIR/u);
  assert.match(source, /INVARIANT_SUITE_WORKSPACE_SNAPSHOT_FILE/u);
  assert.match(source, /invariantSuiteWorkspaceSnapshotRoot/u);
  assert.match(source, /INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID/u);
  assert.match(source, /loadInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /readStableWorkspaceSnapshotFile/u);
  assert.match(source, /const runRootCandidate = path\.resolve\(process\.cwd\(\), task\.runRoot\)/u);
  assert.match(source, /runRootStat = lstatSync\(runRootCandidate\)/u);
  assert.match(source, /realpathSync\(runRootCandidate\) !== runRootCandidate/u);
  assert.match(source, /readRegularFileSnapshot\(resolvedPath, maxBytes\)/u);
  assert.match(source, /parseRuntimeDocumentBytes\(\s*INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,\s*manifestBytes/u);
  assert.match(source, /writeFileDurable\(\s*path\.join\(snapshotRoot,\s*INVARIANT_SUITE_WORKSPACE_SNAPSHOT_FILE/u);
  const preparationRestoreStart = source.indexOf("function restoreWorkspacePatchPreparation");
  assert.ok(preparationRestoreStart > 0, source);
  const preparationRestore = source.slice(preparationRestoreStart, workflowStart);
  assert.ok(
    preparationRestore.indexOf('["read-tree", "--reset", "-u"') <
      preparationRestore.indexOf("removeStaleWorkspaceFiles(workspaceRoot, preparationTree)"),
    preparationRestore
  );
  assert.match(preparationRestore, /\["ls-files", "--others", "--ignored", "--exclude-standard", "-z"\]/u);
  assert.match(source, /const workspaceCandidate = path\.resolve\(task\.workspacePath\)/u);
  assert.match(source, /const workspaceStat = lstatSync\(workspaceCandidate\)/u);
  assert.match(source, /realpathSync\(workspaceCandidate\) !== workspaceCandidate/u);
  assert.match(source, /isStrictlyInsideDirectory\(runRoot, workspaceCandidate\)/u);
  assert.match(restore, /lstatSync\(workspaceCandidate\)/u);
  assert.match(restore, /safeInvariantSuiteDirectory\(workspaceRoot, path\.dirname\(candidate\)\)/u);
  assert.match(restore, /stat\.isSymbolicLink\(\)/u);
  assert.match(restore, /writeFileDurable\(anchored, bytes\)/u);
});

test("generated Smithers verifier publishes the complete validated set before task success", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(verifierStart >= 0, source);
  assert.ok(workflowStart > verifierStart, source);
  assert.match(source, /publishFileDurableExclusive/u);

  const verifier = source.slice(verifierStart, workflowStart);
  assert.match(verifier, /const publications = new Map<string, Buffer>\(\)/u);
  assert.match(source, /function captureTaskOutputs/u);
  assert.match(source, /return task\.outputs\.map/u);
  assert.match(source, /MAX_VERIFIED_ARTIFACT_BYTES/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, output\.path, verified\.file\.bytes\)/u);
  assert.match(verifier, /verifyGeneratedTestFiles\(verified\.artifactRoot, verified\.value\)/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, companion\.path, companion\.contents\)/u);
  assert.match(verifier, /publishFileDurableExclusive\(artifactDir, relativePath, contents\)/u);
  assert.ok(
    verifier.indexOf("validateCapturedTaskOutputs(task, capturedOutputs)") <
      verifier.indexOf("verifyOutputSemanticGates(task, verifiedOutputs, campaignEvidence)")
  );
  assert.ok(
    verifier.indexOf("verifyOutputSemanticGates(task, verifiedOutputs, campaignEvidence)") <
      verifier.indexOf("const publications = new Map<string, Buffer>()")
  );
  assert.ok(
    verifier.indexOf("assertArtifactPublicationsContainNoSecrets(") > verifier.indexOf("primary === undefined")
  );
  assert.ok(
    verifier.indexOf("assertArtifactPublicationsContainNoSecrets(") <
      verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)")
  );
  assert.match(verifier, /sensitiveEnvironmentValues\(process\.env/u);
  assert.match(verifier, /task\.execution\?\.agentCredentialEnv/u);
  assert.match(verifier, /task\.execution\?\.modal\?\.credentialEnv/u);
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") > verifier.indexOf("primary === undefined")
  );
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") <
      verifier.indexOf("return { artifacts, primary_artifact: primary.path }")
  );
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") <
      verifier.indexOf("assertVerifiedDependencySnapshotEpochRemainedCurrent(task, dependencySnapshotEpoch)")
  );
  assert.ok(
    verifier.indexOf("assertVerifiedDependencySnapshotEpochRemainedCurrent(task, dependencySnapshotEpoch)") <
      verifier.indexOf("writeArtifactVerificationMarker(task, artifacts, publications)")
  );
});

test("generated Smithers preparation requires a successful dependency artifact verification", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const materializeStart = source.indexOf("function materializeInvariantSuiteFromDependencies");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(preparationStart >= 0, source);
  assert.ok(materializeStart > preparationStart, source);
  assert.ok(verifierStart > materializeStart, source);
  assert.ok(workflowStart > verifierStart, source);

  const verifier = source.slice(verifierStart, workflowStart);
  assert.match(source, /ARTIFACT_VERIFICATION_DIRECTORY/u);
  assert.match(source, /function assertVerifiedDependency/u);
  assert.match(source, /artifact dependency has not passed verification/u);
  assert.match(source, /assertVerifiedDependency\(task, dependency\)/u);
  assert.match(source, /verifiedDependencySnapshot\(task, dependency, producer\)/u);
  assert.match(source, /artifacts: authenticatedArtifacts/u);
  assert.match(source, /markerBytes: Buffer\.from\(markerSnapshot\.bytes\)/u);
  assert.match(verifier, /clearArtifactVerificationMarker\(task\)/u);
  assert.match(verifier, /beginVerifiedDependencySnapshotEpoch\(task\)/u);
  assert.match(verifier, /assertVerifiedDependencySnapshotEpochRemainedCurrent\(task, dependencySnapshotEpoch\)/u);
  assert.match(verifier, /endVerifiedDependencySnapshotEpoch\(task, dependencySnapshotEpoch\)/u);
  assert.match(verifier, /writeArtifactVerificationMarker\(task, artifacts, publications\)/u);
  assert.match(source, /publications: publicationEntries/u);
  assert.match(source, /rememberVerifiedPublication\(publications, INVARIANT_SUITE_MANIFEST_FILE/u);
  assert.match(source, /const expectedPublicationShas = new Map/u);
  assert.match(source, /rememberExpectedVerifiedPublication\(expectedPublicationShas, companion\.path/u);
  assert.match(
    source,
    /rememberExpectedInvariantSuitePublications\(dependencyTask, dependency, expectedPublicationShas\)/u
  );
  assert.match(source, /files: manifestFiles/u);
  assert.notEqual(verifier.indexOf("clearArtifactVerificationMarker(task)"), -1, verifier);
  assert.ok(
    verifier.indexOf("clearArtifactVerificationMarker(task)") < verifier.indexOf("const artifactRoots"),
    verifier
  );
  assert.ok(
    verifier.indexOf("writeArtifactVerificationMarker(task, artifacts, publications)") >
      verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)"),
    verifier
  );
});

test("generated Smithers dependency verification fails closed before descendant preparation", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function assertVerifiedDependency");
  const helperEnd = source.indexOf("\n\nfunction preservePinnedSourceProof", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verification-gate-"));
  const dependency = path.join(runRoot, "property-specification-fanin");
  const generatedDependency = path.join(runRoot, "generated-tests-fanin");
  const invariantDependency = path.join(runRoot, "stateful-invariant-setup");
  fs.mkdirSync(dependency);
  fs.mkdirSync(generatedDependency);
  fs.mkdirSync(invariantDependency);
  const schemaBinding = {
    schemaFile: "generated-tests.schema.json",
    schemaId: "urn:ultrafuzz:schema:artifacts:generated-tests:3",
    schemaSha256: "b".repeat(64),
    schemaBundleSha256: "c".repeat(64),
    validatorBuild: `ultrafuzz-json-validator.v1:${"d".repeat(64)}`
  };
  const markerSchemaBinding = {
    schema_file: schemaBinding.schemaFile,
    schema_id: schemaBinding.schemaId,
    schema_sha256: schemaBinding.schemaSha256,
    schema_bundle_sha256: schemaBinding.schemaBundleSha256,
    validator_build: schemaBinding.validatorBuild
  };
  const taskSpecs = [
    {
      attemptId: "property-specification-fanin",
      artifactDir: dependency,
      metadata: { node: { logicalNodeId: "property-specification-fanin" } },
      outputs: [
        {
          path: "properties.json",
          contract: "ultrafuzz/text@1",
          contractDigest: "a".repeat(64),
          primary: true
        }
      ]
    },
    {
      attemptId: "generated-tests-fanin",
      artifactDir: generatedDependency,
      metadata: {
        node: { logicalNodeId: "generated-tests-fanin" },
        run: { ultrafuzzRunId: "run-one" },
        loop: { attemptIndex: 0 }
      },
      outputs: [
        {
          path: "generated-tests.json",
          contract: "ultrafuzz/generated-tests@3",
          contractDigest: "a".repeat(64),
          ...schemaBinding,
          primary: true
        }
      ]
    },
    {
      attemptId: "stateful-invariant-setup",
      artifactDir: invariantDependency,
      metadata: { node: { logicalNodeId: "stateful-invariant-setup" } },
      outputs: [
        {
          path: "implemented-properties.json",
          contract: "ultrafuzz/text@1",
          contractDigest: "a".repeat(64),
          primary: true
        }
      ]
    }
  ];
  const assertVerifiedDependency = new Function(
    "path",
    "artifactVerificationMarkerLocation",
    "readBoundedRegularArtifactSnapshot",
    "parseStrictJsonSnapshot",
    "decodeStrictUtf8Snapshot",
    "MAX_VERIFIED_ARTIFACT_BYTES",
    "MAX_VERIFIED_COMPANION_BYTES",
    "taskSpecs",
    "validateArtifactVerificationMarker",
    "assertArtifactVerificationMarkerSemantics",
    "artifactContractDefinition",
    "artifactContractSchemaBinding",
    "validateArtifactContractBytes",
    "createHash",
    "invariantSuiteNodeIds",
    "verifyGeneratedTestFiles",
    "rememberExpectedInvariantSuitePublications",
    `const ARTIFACT_VERIFICATION_MARKER = ".ultrafuzz-artifact-verification.json";
   const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v2";
   ${helper}; return assertVerifiedDependency;`
  )(
    path,
    (runRoot: string, attemptId: string) => {
      const root = path.join(runRoot, ".ultrafuzz-verification");
      return { root, path: path.join(root, `${attemptId}.json`), relativePath: `${attemptId}.json` };
    },
    (root: string, candidate: string) => {
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
        throw new Error("unsafe path");
      }
      const bytes = fs.readFileSync(candidate);
      return { path: candidate, bytes };
    },
    (snapshot: { bytes: Buffer }) => JSON.parse(snapshot.bytes.toString("utf8")) as unknown,
    (snapshot: { bytes: Buffer }) => new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes),
    64 * 1024 * 1024,
    16 * 1024 * 1024,
    taskSpecs,
    () => ({ ok: true, issues: [] }),
    () => undefined,
    (contract: string) => ({ digest: "a".repeat(64), format: contract === "ultrafuzz/text@1" ? "text" : "json" }),
    (contract: string) => (contract === "ultrafuzz/text@1" ? undefined : markerSchemaBinding),
    (contract: string, contents: Uint8Array) => ({
      ok: true,
      issues: [],
      value:
        contract === "ultrafuzz/generated-tests@3"
          ? (JSON.parse(Buffer.from(contents).toString("utf8")) as unknown)
          : new TextDecoder("utf-8", { fatal: true }).decode(contents)
    }),
    createHash,
    new Set(["stateful-invariant-setup"]),
    (artifactDir: string, value: unknown) =>
      [
        ...(value as { generated_tests: Array<{ path: string }> }).generated_tests,
        ...(value as { support_files: Array<{ path: string }> }).support_files
      ].map((entry) => ({
        path: entry.path,
        contents: fs.readFileSync(path.join(artifactDir, entry.path))
      })),
    (_dependencyTask: unknown, dependencyRoot: string, publications: Map<string, string>) => {
      const relativePath = "invariant-suite/test/CryticTester.sol";
      publications.set(
        relativePath,
        createHash("sha256")
          .update(fs.readFileSync(path.join(dependencyRoot, relativePath)))
          .digest("hex")
      );
    }
  ) as (
    task: { attemptId: string; runRoot: string },
    dependency: string,
    capturedArtifact?:
      Readonly<{ relativePath: string; bytes: Buffer }> | readonly Readonly<{ relativePath: string; bytes: Buffer }>[]
  ) => {
    attemptId: string;
    artifactDir: string;
    markerBytes: Buffer;
    artifacts: ReadonlyMap<string, { contract: string; bytes: Buffer; value: unknown }>;
    publications: ReadonlyMap<string, string>;
    generatedTestBundles: ReadonlyArray<{ framework: string; entries: readonly unknown[] }>;
  };

  const task = { attemptId: "stateful-invariant-setup", runRoot };
  assert.throws(
    () => assertVerifiedDependency(task, dependency),
    /artifact dependency has not passed verification property-specification-fanin/u
  );

  fs.mkdirSync(path.join(runRoot, ".ultrafuzz-verification"));
  const markerPath = path.join(runRoot, ".ultrafuzz-verification", "property-specification-fanin.json");
  const writeAttemptMarker = (
    attemptId: string,
    artifacts: Array<{
      path: string;
      contract: string;
      contract_digest: string;
      sha256: string;
      primary: boolean;
    }>,
    publications = artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))
  ) => {
    fs.writeFileSync(
      path.join(runRoot, ".ultrafuzz-verification", `${attemptId}.json`),
      `${JSON.stringify({
        schema_version: "ultrafuzz.artifact-verification.v2",
        attempt_id: attemptId,
        node_id: attemptId,
        artifacts,
        publications
      })}\n`,
      "utf8"
    );
  };
  const writeMarker = (
    artifacts: Array<{
      path: string;
      contract: string;
      contract_digest: string;
      sha256: string;
      primary: boolean;
    }>,
    publications = artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))
  ) => writeAttemptMarker("property-specification-fanin", artifacts, publications);
  writeMarker([]);
  assert.throws(
    () => assertVerifiedDependency(task, dependency),
    /artifact dependency has not passed verification property-specification-fanin/u
  );
  const verifiedBytes = Buffer.from("verified\n", "utf8");
  fs.writeFileSync(path.join(dependency, "properties.json"), verifiedBytes);
  const sha256 = createHash("sha256").update(verifiedBytes).digest("hex");
  const validArtifact = {
    path: "properties.json",
    contract: "ultrafuzz/text@1",
    contract_digest: "a".repeat(64),
    sha256,
    primary: true
  };
  for (const artifacts of [
    [
      {
        ...validArtifact,
        path: "forged.json"
      }
    ],
    [
      {
        ...validArtifact,
        contract: "ultrafuzz/findings@2"
      }
    ],
    [
      {
        ...validArtifact,
        contract_digest: "b".repeat(64)
      }
    ]
  ]) {
    writeMarker(artifacts);
    assert.throws(
      () => assertVerifiedDependency(task, dependency),
      /artifact dependency has not passed verification property-specification-fanin/u
    );
  }
  writeMarker([validArtifact]);
  fs.writeFileSync(path.join(dependency, "properties.json"), "tampered\n", "utf8");
  assert.throws(
    () => assertVerifiedDependency(task, dependency),
    /artifact dependency has not passed verification property-specification-fanin/u
  );
  fs.writeFileSync(path.join(dependency, "properties.json"), verifiedBytes);
  writeMarker([validArtifact]);
  const verifiedAuthority = assertVerifiedDependency(task, dependency);
  assert.equal(verifiedAuthority.attemptId, "property-specification-fanin");
  assert.equal(verifiedAuthority.artifactDir, dependency);
  assert.deepEqual(verifiedAuthority.artifacts.get("properties.json")?.bytes, verifiedBytes);
  assert.equal(verifiedAuthority.artifacts.get("properties.json")?.value, "verified\n");
  assert.equal(verifiedAuthority.publications.get("properties.json"), sha256);
  const unauthenticatedCapturedBytes = Buffer.from("swapped only while captured\n", "utf8");
  assert.throws(
    () =>
      assertVerifiedDependency(task, dependency, {
        relativePath: "properties.json",
        bytes: unauthenticatedCapturedBytes
      }),
    /artifact dependency has not passed verification property-specification-fanin/u
  );
  fs.writeFileSync(path.join(dependency, "properties.json"), "changed after the authoritative capture\n", "utf8");
  assert.doesNotThrow(() =>
    assertVerifiedDependency(task, dependency, { relativePath: "properties.json", bytes: verifiedBytes })
  );
  fs.writeFileSync(path.join(dependency, "properties.json"), verifiedBytes);
  fs.mkdirSync(path.join(generatedDependency, "generated-tests"), { recursive: true });
  const propertyContents = "contract Property {}\n";
  const propertyHelperContents = "library PropertyHelper {}\n";
  const generatedBytes = Buffer.from(
    `${JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-one",
      node_id: "generated-tests-fanin",
      framework: "foundry",
      generated_tests: [generatedTestEntry("generated-tests/Property.t.sol", propertyContents)],
      support_files: [generatedTestEntry("generated-tests/PropertyHelper.sol", propertyHelperContents)]
    })}\n`
  );
  fs.writeFileSync(path.join(generatedDependency, "generated-tests.json"), generatedBytes);
  const generatedArtifact = {
    path: "generated-tests.json",
    contract: "ultrafuzz/generated-tests@3",
    contract_digest: "a".repeat(64),
    ...markerSchemaBinding,
    sha256: createHash("sha256").update(generatedBytes).digest("hex"),
    primary: true
  };
  const companionPath = path.join(generatedDependency, "generated-tests", "Property.t.sol");
  fs.writeFileSync(companionPath, propertyContents, "utf8");
  const supportPath = path.join(generatedDependency, "generated-tests", "PropertyHelper.sol");
  fs.writeFileSync(supportPath, propertyHelperContents, "utf8");
  const companionPublication = {
    path: "generated-tests/Property.t.sol",
    sha256: createHash("sha256").update(propertyContents).digest("hex")
  };
  const supportPublication = {
    path: "generated-tests/PropertyHelper.sol",
    sha256: createHash("sha256").update(propertyHelperContents).digest("hex")
  };
  writeAttemptMarker("generated-tests-fanin", [generatedArtifact]);
  assert.throws(
    () => assertVerifiedDependency(task, generatedDependency),
    /artifact dependency has not passed verification generated-tests-fanin/u
  );
  writeAttemptMarker(
    "generated-tests-fanin",
    [generatedArtifact],
    [{ path: generatedArtifact.path, sha256: generatedArtifact.sha256 }, companionPublication, supportPublication]
  );
  assert.doesNotThrow(() => assertVerifiedDependency(task, generatedDependency));
  fs.writeFileSync(companionPath, "contract Tampered {}\n", "utf8");
  assert.throws(
    () => assertVerifiedDependency(task, generatedDependency),
    /artifact dependency has not passed verification generated-tests-fanin/u
  );
  const emptyGeneratedBytes = Buffer.from(
    `${JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: "run-one",
      node_id: "generated-tests-fanin",
      framework: "foundry",
      generated_tests: [],
      support_files: []
    })}\n`
  );
  fs.writeFileSync(path.join(generatedDependency, "generated-tests.json"), emptyGeneratedBytes);
  fs.rmSync(companionPath);
  fs.rmSync(supportPath);
  const emptyGeneratedArtifact = {
    ...generatedArtifact,
    sha256: createHash("sha256").update(emptyGeneratedBytes).digest("hex")
  };
  writeAttemptMarker("generated-tests-fanin", [emptyGeneratedArtifact]);
  const emptyAuthority = assertVerifiedDependency(task, generatedDependency);
  assert.equal(emptyAuthority.generatedTestBundles.length, 1);
  assert.equal(emptyAuthority.generatedTestBundles[0]!.framework, "foundry");
  assert.deepEqual(emptyAuthority.generatedTestBundles[0]!.entries, []);
  fs.rmSync(path.join(runRoot, ".ultrafuzz-verification", "generated-tests-fanin.json"));
  assert.throws(
    () => assertVerifiedDependency(task, generatedDependency),
    /artifact dependency has not passed verification generated-tests-fanin/u
  );
  const invariantBytes = Buffer.from("implemented\n");
  fs.writeFileSync(path.join(invariantDependency, "implemented-properties.json"), invariantBytes);
  fs.mkdirSync(path.join(invariantDependency, "invariant-suite", "test"), { recursive: true });
  const invariantSourcePath = path.join(invariantDependency, "invariant-suite", "test", "CryticTester.sol");
  fs.writeFileSync(invariantSourcePath, "contract CryticTester {}\n", "utf8");
  const invariantArtifact = {
    path: "implemented-properties.json",
    contract: "ultrafuzz/text@1",
    contract_digest: "a".repeat(64),
    sha256: createHash("sha256").update(invariantBytes).digest("hex"),
    primary: true
  };
  const invariantPublication = {
    path: "invariant-suite/test/CryticTester.sol",
    sha256: createHash("sha256").update("contract CryticTester {}\n").digest("hex")
  };
  writeAttemptMarker("stateful-invariant-setup", [invariantArtifact]);
  assert.throws(
    () => assertVerifiedDependency(task, invariantDependency),
    /artifact dependency has not passed verification stateful-invariant-setup/u
  );
  writeAttemptMarker(
    "stateful-invariant-setup",
    [invariantArtifact],
    [{ path: invariantArtifact.path, sha256: invariantArtifact.sha256 }, invariantPublication]
  );
  assert.doesNotThrow(() => assertVerifiedDependency(task, invariantDependency));
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      schema_version: "ultrafuzz.artifact-verification.v2",
      attempt_id: "property-specification-fanin",
      node_id: "property-specification-fanin"
    })}\n`,
    "utf8"
  );
  assert.throws(
    () => assertVerifiedDependency(task, dependency),
    /artifact dependency has not passed verification property-specification-fanin/u
  );
  fs.rmSync(runRoot, { recursive: true, force: true });
});

test("generated Smithers verification marker root must be a canonical directory", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function artifactVerificationMarkerLocation");
  const helperEnd = source.indexOf("\n\nfunction clearArtifactVerificationMarker", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = source
    .slice(helperStart, helperEnd)
    .replace("runRoot: string", "runRoot")
    .replace("attemptId: string", "attemptId")
    .replace("createRoot: boolean", "createRoot")
    .replace(/\): \{ root: string; path: string; relativePath: string \} \| undefined \{/u, ") {")
    .replace("let rootStat: ReturnType<typeof lstatSync>;", "let rootStat;");
  const artifactVerificationMarkerLocation = new Function(
    "path",
    "realpathSync",
    "lstatSync",
    "mkdirSync",
    "isStrictlyInsideDirectory",
    "isMissingPathError",
    "ARTIFACT_VERIFICATION_DIRECTORY",
    `${helper}; return artifactVerificationMarkerLocation;`
  )(
    path,
    fs.realpathSync,
    fs.lstatSync,
    fs.mkdirSync,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    ".ultrafuzz-verification"
  ) as (
    runRoot: string,
    attemptId: string,
    createRoot: boolean
  ) => { root: string; path: string; relativePath: string };

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verification-root-"));
  try {
    const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
    const realMarkerRoot = path.join(runRoot, "real-markers");
    fs.mkdirSync(realMarkerRoot);
    fs.symlinkSync(realMarkerRoot, markerRoot, "dir");
    assert.throws(
      () => artifactVerificationMarkerLocation(runRoot, "attempt-one", false),
      /unsafe artifact verification marker root/u
    );
    fs.rmSync(markerRoot, { force: true });
    assert.equal(artifactVerificationMarkerLocation(runRoot, "attempt-one", true).relativePath, "attempt-one.json");
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("generated Smithers preserves setup-patch baselines across post-agent preparation", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function materializeWorkspacePatchDependencies");
  const materializeStart = source.indexOf("function materializeWorkspacePatch(task");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(helperStart >= 0, source);
  assert.ok(materializeStart > helperStart, source);
  assert.ok(workflowStart > materializeStart, source);

  const helper = source.slice(helperStart, materializeStart);
  assert.match(helper, /replayWorkspacePatches: boolean/u);
  assert.match(helper, /evidenceMode: "create" \| "require"/u);
  assert.match(helper, /!workspacePatchBaselineTrees\.has\(task\.attemptId\)/u);
  assert.match(helper, /readWorkspacePatchBaseline\(task\)/u);
  assert.match(helper, /writeWorkspacePatchBaseline\(task, baselineTree\)/u);
  assert.match(helper, /persistedPreparation === undefined && evidenceMode === "require"/u);
  assert.match(helper, /taskPublishesWorkspacePatch\(task\) && !workspacePatchBaselineTrees\.has/u);
  // #312: a RESUMED task worktree can already sit at -- or past -- some dependencies' outputs, because it
  // lives on a durable volume and still holds the previous attempt's state. Replay must therefore start
  // after the prefix the worktree already equals byte for byte, and must do so ONLY on the replay path;
  // post-agent preparation has its own rule and must not be second-guessed. Two production runs (R48,
  // R49) died at `prepare:stateful-invariant-implement-properties` without this.
  assert.match(source, /function firstDependencyRequiringReplay\(/u);
  assert.match(helper, /replayWorkspacePatches && captures\.length > 0/u);
  assert.match(helper, /firstDependencyRequiringReplay\(\s*captureWorkspaceTree\(workspaceRoot\),/u);
  assert.match(helper, /captures\.map\(\(entry\) => entry\.manifest\)/u);
  // Every capture is validated even when replay skips it: the manifest schema, object ids, digest and
  // sensitive-path checks all live inside `applyWorkspacePatch`, so a skipped patch would otherwise go
  // entirely unchecked while its `result_tree` steered the skip decision.
  assert.match(
    helper,
    /for \(const capture of captures\) validateWorkspacePatchCapture\(workspaceRoot, capture, task\.productionSourceRoots\);/u
  );
  // The skip is only sound when the skipped prefix is a real chain; a sibling fan-in must replay.
  assert.match(source, /return chained \? index \+ 1 : 0;/u);
  assert.match(helper, /captures\.slice\(replayFrom\)/u);
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts");
  const verifierStart = source.indexOf("\n\nfunction verifyArtifacts", finalizerStart);
  assert.ok(finalizerStart >= 0, source);
  assert.ok(verifierStart > finalizerStart, source);
  assert.match(
    source.slice(finalizerStart, verifierStart),
    /prepareArtifactMirror\(task, \{[\s\S]*?replayWorkspacePatches: false,[\s\S]*?evidenceMode: "require",[\s\S]*?pinnedSubmodules: "verify"[\s\S]*?\}\);/u
  );
});

function findRuntimePackageRoot(start: string): string {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: string };
      if (packageJson.name === "@ultrafuzz/runtime") {
        return current;
      }
    }
    current = path.dirname(current);
  }
  throw new Error("could not locate @ultrafuzz/runtime package root");
}

function packageRootForEntry(entryPath: string): string {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  throw new Error(`could not locate package root for ${entryPath}`);
}
