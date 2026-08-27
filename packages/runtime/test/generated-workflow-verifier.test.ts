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
import { z } from "zod/v4";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  assertArtifactPublicationsContainNoSecrets,
  assertRegularFileInside,
  assertRunMetadataDocument,
  executeSchemaSemanticGates,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILES,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_TOTAL_BYTES,
  normalizeNodeAttemptFailureMessage,
  parseStrictJsonBytes,
  promptArtifactAuthorityPathSelectorId,
  prepareSafeFilePath,
  PROPERTIES_SCHEMA_VERSION,
  publishFileDurableExclusive,
  readRegularFileSnapshot,
  RUN_METADATA_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  sensitiveEnvironmentValues,
  validateArtifactContract,
  validateArtifactContractBytes,
  validatePropertiesSchema,
  writeFileDurable,
  type ArtifactContractId,
  type InvariantLedgerArtifact,
  type PropertiesArtifact,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestOutput,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import {
  canonicalPropertiesMarkdownParityIssues,
  invariantLedgerMarkdownParityIssues
} from "../src/canonical-properties-markdown.js";
import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
import {
  derivePromptArtifactAuthority,
  parsePromptArtifactAuthorityBytes,
  serializePromptArtifactAuthority,
  type DerivePromptArtifactAuthorityInput,
  type PromptArtifactAuthorityDocument,
  type PromptArtifactAuthoritySelector
} from "../src/prompt-artifact-authority.js";
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
  const schemaEnd = source.indexOf("\n\nconst agentProcessOutput", schemaStart);
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
  const cloud = {
    cloud_worker: true,
    task_id: "node:one",
    attempt_id: "one",
    execution_generation: "base",
    selected_task: {},
    operator_prompt: "focus"
  };
  assert.equal(inputSchema.safeParse(cloud).success, true);

  for (const invalid of [
    { ...local, unexpected: true },
    { ...local, schema_version: "ultrafuzz.smithers.workflow.v1" },
    { ...local, ultrafuzz_run_id: "foreign-run" },
    { ...local, run_id: local.ultrafuzz_run_id },
    { schema_version: local.schema_version, ultrafuzz_run_id: local.ultrafuzz_run_id },
    { ...local, tasks: [{ ...local.tasks[0], extra: true }] },
    { ...cloud, tasks: [{ id: "smuggled" }] },
    { ...cloud, selected_task: undefined },
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

test("generated workflow input accepts the nulls its input table reads back for keys a dispatch never set", () => {
  // The runner tables this schema by walking `shape`, so every declared key
  // becomes a column and a column the submission never set reads back as SQL
  // null, not as undefined. Declaring the envelope keys `.optional()` -- which
  // accepts undefined only -- therefore made a local dispatch, which by
  // definition leaves all five cloud-worker keys unset, fail its own
  // re-validation in parseWorkflowInput before the first task ever rendered.
  const inputSchema = loadGeneratedWorkflowInputSchema();
  const localThroughTheInputTable = {
    schema_version: "ultrafuzz.smithers.workflow.v4",
    ultrafuzz_run_id: "run-1",
    tasks: [{ id: "node:one", prompt_path: ".ultrafuzz/prompts/one.md" }],
    cloud_worker: null,
    task_id: null,
    attempt_id: null,
    execution_generation: null,
    selected_task: null,
    operator_prompt: null,
    operator_input: null
  };
  assert.equal(
    inputSchema.safeParse(localThroughTheInputTable).success,
    true,
    "a local dispatch read back through the input table carries explicit nulls for every cloud-worker key"
  );
  const cloudThroughTheInputTable = {
    cloud_worker: true,
    task_id: "node:one",
    attempt_id: "one",
    execution_generation: "base",
    selected_task: {},
    schema_version: null,
    ultrafuzz_run_id: null,
    tasks: null,
    operator_prompt: null,
    operator_input: null
  };
  assert.equal(
    inputSchema.safeParse(cloudThroughTheInputTable).success,
    true,
    "a cloud dispatch read back through the input table carries explicit nulls for every local key"
  );

  // Null is absence, never a stand-in for a key the selected envelope requires,
  // and a null-filled local input must not read as a cloud dispatch.
  for (const invalid of [
    { ...localThroughTheInputTable, tasks: null },
    { ...localThroughTheInputTable, schema_version: null },
    { ...localThroughTheInputTable, ultrafuzz_run_id: null },
    { ...cloudThroughTheInputTable, selected_task: null },
    { ...cloudThroughTheInputTable, execution_generation: null },
    { ...cloudThroughTheInputTable, schema_version: "ultrafuzz.smithers.workflow.v4" }
  ]) {
    assert.equal(inputSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
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

type ArtifactAwareAgentFixture = {
  cliEngine?: string;
  hijackEngine?: string;
  supportsNativeStructuredOutput?: boolean;
  parseFileChanges?(rawEvent: unknown): unknown[] | undefined;
  checkpointCapabilities?: readonly unknown[];
  checkpointFormats?: readonly unknown[];
  preflight?(args: unknown): Promise<unknown>;
  generate(args: unknown): Promise<unknown>;
};

function loadArtifactAwareAgent(
  options: { onAuthorityCheck?: () => void; onReset?: () => void; onSourceVerify?: () => void } = {}
): (
  task: unknown,
  chainIndex: number,
  originalPrompt: string,
  agent: ArtifactAwareAgentFixture,
  admittedAgent?: () => ArtifactAwareAgentFixture
) => ArtifactAwareAgentFixture {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function artifactAwareAgent");
  const helperEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "assertWorkspaceSourceRevision",
    "resetTaskArtifactsForRetry",
    "authoritativeFinalReportCoverage",
    "materializeFinalReportPromptAuthority",
    "authoritativeFinalReportRunMetadataArgs",
    "authoritativeFinalReportPromptAuthorityArgs",
    "rememberFinalReportAgentExecutionAuthority",
    "finalReportAgentExecution",
    "declaredFinalReportOutputPair",
    "smithersTaskAgentId",
    "normalizeNodeAttemptFailureMessage",
    "sensitiveEnvironmentValues",
    "assertDependencyArtifactAdmissionCurrent",
    "assertPromptArtifactAuthorityUnchanged",
    "assertFinalReportRunMetadataAuthorityUnchanged",
    "assertFinalReportPromptAuthorityUnchanged",
    `${helper}; return artifactAwareAgent;`
  )(
    () => options.onSourceVerify?.(),
    () => options.onReset?.(),
    () => undefined,
    () => undefined,
    (_task: unknown, args: unknown) => args,
    (_task: unknown, args: unknown) => args,
    () => undefined,
    () => ({ planned_chain: [], failed_attempts: [], producer: {} }),
    () => undefined,
    () => "ultrafuzz-agent:test",
    normalizeNodeAttemptFailureMessage,
    sensitiveEnvironmentValues,
    () => undefined,
    () => options.onAuthorityCheck?.(),
    () => undefined,
    () => undefined
  ) as ReturnType<typeof loadArtifactAwareAgent>;
}

function loadSmithersCorrectionResumeSession(): (agent: unknown, meta: Record<string, unknown>) => string | undefined {
  const require = createRequire(import.meta.url);
  const smithersRequire = createRequire(require.resolve("smthrs"));
  const enginePath = smithersRequire.resolve("@smthrs/engine/engine");
  const source = fs.readFileSync(enginePath, "utf8");
  const helperStart = source.indexOf("function resolveCorrectionResumeSession");
  const helperEnd = source.indexOf("\n}\n", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  return new Function(`${source.slice(helperStart, helperEnd + 2)}; return resolveCorrectionResumeSession;`)() as (
    agent: unknown,
    meta: Record<string, unknown>
  ) => string | undefined;
}

type NormalizedAgentFailure = Error & { code?: string; details?: Record<string, unknown> };

async function captureAgentFailure(
  failure: unknown,
  task: unknown = { agentChain: [{}] },
  preflight = false
): Promise<NormalizedAgentFailure> {
  const fail = async (): Promise<never> => {
    throw failure;
  };
  const wrapped = loadArtifactAwareAgent()(task, 0, "prompt", {
    ...(preflight ? { preflight: fail } : {}),
    generate: fail
  });
  try {
    await (preflight ? wrapped.preflight!({}) : wrapped.generate({ taskContext: { attempt: 1 } }));
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  return assert.fail("agent failure was not propagated");
}

test("artifact-aware agents own process completion without constraining terminal responses", async () => {
  const terminalResults: unknown[] = [
    { text: "completed in prose" },
    { text: '{"summary":"model-authored telemetry"}', output: { summary: "model-authored telemetry" } },
    { text: "" },
    undefined
  ];

  for (const terminalResult of terminalResults) {
    const calls: Array<Record<string, unknown>> = [];
    const preflights: Array<Record<string, unknown>> = [];
    const underlying = {
      supportsNativeStructuredOutput: false,
      async preflight(args: unknown): Promise<void> {
        preflights.push(args as Record<string, unknown>);
      },
      async generate(args: unknown): Promise<unknown> {
        calls.push(args as Record<string, unknown>);
        return terminalResult;
      }
    };
    const wrapped = loadArtifactAwareAgent()({ agentChain: [{}] }, 0, "prompt", underlying);
    const outputSchema = { description: "must never reach the model adapter" };

    assert.equal(wrapped.supportsNativeStructuredOutput, true);
    await wrapped.preflight!({ outputSchema });
    const result = (await wrapped.generate({
      outputSchema,
      taskContext: { attempt: 1 }
    })) as Record<string, unknown>;

    assert.equal(Object.hasOwn(preflights[0]!, "outputSchema"), false);
    assert.equal(Object.hasOwn(calls[0]!, "outputSchema"), false);
    assert.deepEqual(result._output, { completed: true });
    if (terminalResult !== null && typeof terminalResult === "object") {
      assert.equal(result.text, (terminalResult as Record<string, unknown>).text);
    }
  }
});

async function withEnvironment(values: Record<string, string>, callback: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function loadFinalReportAgentExecution(): (
  task: unknown,
  producerChainIndex: number,
  observedSelections?: ReadonlyArray<{ attempt: number; chainIndex: number }>
) => unknown {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function finalReportAgentExecution");
  const helperEnd = source.indexOf("\n\ntype FinalReportPromptAuthorityProjection", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(`${helper}; return finalReportAgentExecution;`)() as ReturnType<
    typeof loadFinalReportAgentExecution
  >;
}

function loadPromptWithAuthoritativeFinalReportPromptAuthority(): (
  prompt: string,
  authorityPath: string,
  reportPath: string
) => string {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function promptWithAuthoritativeFinalReportPromptAuthority");
  const helperEnd = source.indexOf("\n\nfunction authoritativeFinalReportPromptAuthorityArgs", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "untrustedContentBoundary",
    `${helper}; return promptWithAuthoritativeFinalReportPromptAuthority;`
  )("UNTRUSTED CONTENT BOUNDARY") as ReturnType<typeof loadPromptWithAuthoritativeFinalReportPromptAuthority>;
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

function loadFinalReportPromptAuthorityHarness(maxAuthorityBytes = 128 * 1024 * 1024): {
  materialize(task: unknown, coverage: unknown, execution: unknown): void;
  assertUnchanged(task: unknown): void;
  relativePath(task: unknown): string;
  prompt(prompt: string, authorityPath: string, reportPath: string): string;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("type FinalReportPromptAuthorityProjection");
  const helperEnd = source.indexOf("\n\nconst finalReportAgentExecutionAuthority", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const readSnapshot = (root: string, filePath: string, _label: string, maxBytes: number, nonEmpty = false) => {
    assert.ok(path.resolve(filePath).startsWith(`${path.resolve(root)}${path.sep}`));
    const resolvedPath = fs.realpathSync(filePath);
    const stat = fs.statSync(resolvedPath, { bigint: true });
    const bytes = fs.readFileSync(resolvedPath);
    assert.ok(bytes.length <= maxBytes);
    if (nonEmpty) assert.ok(bytes.length > 0);
    return {
      path: resolvedPath,
      bytes,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs
      }
    };
  };
  const sameIdentity = (
    left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
    right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
  ) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  return new Function(
    "path",
    "realpathSync",
    "declaredFinalReportOutputPair",
    "prepareTaskLocalAuthorityPath",
    "writeFileDurable",
    "readBoundedRegularArtifactSnapshot",
    "parseStrictJsonSnapshot",
    "isDeepStrictEqual",
    "sameImmutableFileIdentity",
    "Buffer",
    "PROMPT_ARTIFACT_AUTHORITY_DIRECTORY",
    "MAX_FINAL_REPORT_PROMPT_AUTHORITY_BYTES",
    "untrustedContentBoundary",
    `${helper}; return {
      materialize: materializeFinalReportPromptAuthority,
      assertUnchanged: assertFinalReportPromptAuthorityUnchanged,
      relativePath: finalReportPromptAuthorityRelativePath,
      prompt: promptWithAuthoritativeFinalReportPromptAuthority
    };`
  )(
    path,
    fs.realpathSync,
    () => ({}),
    (workspaceRoot: string, relativePath: string) => {
      const authorityPath = prepareSafeFilePath(workspaceRoot, relativePath);
      try {
        if (fs.lstatSync(authorityPath).isDirectory()) {
          fs.rmSync(authorityPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return authorityPath;
    },
    writeFileDurable,
    readSnapshot,
    (snapshot: { bytes: Buffer }) => parseStrictJsonBytes(snapshot.bytes),
    isDeepStrictEqual,
    sameIdentity,
    Buffer,
    ".ultrafuzz/authorities",
    maxAuthorityBytes,
    "UNTRUSTED CONTENT BOUNDARY"
  ) as ReturnType<typeof loadFinalReportPromptAuthorityHarness>;
}

function loadFinalReportRunMetadataAuthorityHarness(
  remote = "https://github.com/example/project.git?session=private-id\n"
): {
  normalize(remoteValue: string): string;
  derive(task: unknown): unknown;
  materialize(task: unknown): void;
  assertUnchanged(task: unknown): void;
  authoritative(task: unknown): unknown;
  relativePath(task: unknown): string;
  prompt(prompt: string, authorityPath: string, reportPath: string): string;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function declaredFinalReportOutputPair");
  const helperEnd = source.indexOf("\n\nfunction configuredInvariantPrioritySelection", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const readSnapshot = (root: string, filePath: string, _label: string, maxBytes: number, nonEmpty = false) => {
    assert.ok(path.resolve(filePath).startsWith(`${path.resolve(root)}${path.sep}`));
    const resolvedPath = fs.realpathSync(filePath);
    const stat = fs.statSync(resolvedPath, { bigint: true });
    const bytes = fs.readFileSync(resolvedPath);
    assert.ok(bytes.length <= maxBytes);
    if (nonEmpty) assert.ok(bytes.length > 0);
    return {
      path: resolvedPath,
      bytes,
      identity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs
      }
    };
  };
  const sameIdentity = (
    left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
    right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
  ) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  return new Function(
    "path",
    "realpathSync",
    "execFileSync",
    "readBoundedRegularArtifactSnapshot",
    "parseStrictJsonSnapshot",
    "isPlainJsonRecord",
    "assertRunMetadataDocument",
    "RUN_METADATA_SCHEMA_VERSION",
    "MAX_FINAL_REPORT_RUN_METADATA_BYTES",
    "MAX_FINAL_REPORT_RUN_METADATA_PROJECTION_BYTES",
    "prepareSafeFilePath",
    "prepareTaskLocalAuthorityPath",
    "writeFileDurable",
    "isDeepStrictEqual",
    "sameImmutableFileIdentity",
    "Buffer",
    "PROMPT_ARTIFACT_AUTHORITY_DIRECTORY",
    "untrustedContentBoundary",
    `${helper}; return {
      normalize: normalizeFinalReportGitHubRemote,
      derive: deriveAuthoritativeFinalReportRunMetadata,
      materialize: materializeFinalReportRunMetadataAuthority,
      assertUnchanged: assertFinalReportRunMetadataAuthorityUnchanged,
      authoritative: authoritativeFinalReportRunMetadata,
      relativePath: finalReportRunMetadataAuthorityRelativePath,
      prompt: promptWithAuthoritativeFinalReportRunMetadata
    };`
  )(
    path,
    fs.realpathSync,
    () => remote,
    readSnapshot,
    (snapshot: { bytes: Buffer }) => parseStrictJsonBytes(snapshot.bytes),
    (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value),
    assertRunMetadataDocument,
    RUN_METADATA_SCHEMA_VERSION,
    64 * 1024 * 1024,
    1024 * 1024,
    prepareSafeFilePath,
    (workspaceRoot: string, relativePath: string) => {
      const authorityPath = prepareSafeFilePath(workspaceRoot, relativePath);
      try {
        if (fs.lstatSync(authorityPath).isDirectory()) {
          fs.rmSync(authorityPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      return authorityPath;
    },
    writeFileDurable,
    isDeepStrictEqual,
    sameIdentity,
    Buffer,
    ".ultrafuzz/authorities",
    "UNTRUSTED CONTENT BOUNDARY"
  ) as ReturnType<typeof loadFinalReportRunMetadataAuthorityHarness>;
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

type GeneratedDependencyVerificationProducer = {
  attemptId: string;
  verifierId: string;
  optional: boolean;
};

type GeneratedVerificationAuthorityOutput = {
  verification_marker_sha256: string;
  verification_marker_size_bytes: number;
};

function loadDependencyVerificationAuthoritiesForTask(): (
  task: { dependencyVerificationProducers: readonly GeneratedDependencyVerificationProducer[] },
  outputForProducer: (
    producer: GeneratedDependencyVerificationProducer
  ) => GeneratedVerificationAuthorityOutput | undefined
) => Array<{ attempt_id: string; marker_sha256: string; size_bytes: number }> | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("type DependencyVerificationProducer");
  const helperEnd = source.indexOf("\nconst usesCloudExecution", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(`${emitted}; return dependencyVerificationAuthoritiesForTask;`)() as ReturnType<
    typeof loadDependencyVerificationAuthoritiesForTask
  >;
}

type GeneratedPromptArtifactAuthorityTask = {
  attemptId: string;
  runRoot: string;
  taskManifestPath: string;
  workspacePath: string;
  promptArtifactAuthoritySelectors?: readonly PromptArtifactAuthoritySelector[];
};

function loadGeneratedPromptArtifactAuthorityHarness(initialAdmittedDependencyArtifactDirs: readonly string[]): {
  assertUnchanged(task: GeneratedPromptArtifactAuthorityTask): void;
  derivationInputs: DerivePromptArtifactAuthorityInput[];
  materialize(task: GeneratedPromptArtifactAuthorityTask): void;
  path(task: GeneratedPromptArtifactAuthorityTask, workspaceRoot: string): string;
  relativePath(task: GeneratedPromptArtifactAuthorityTask): string;
  setAdmittedDependencyArtifactDirs(directories: readonly string[]): void;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const authorityStart = source.indexOf("const promptArtifactAuthoritySnapshotsByTask");
  const authorityEnd = source.indexOf("\n\nfunction verifiedDependencyJsonArtifact", authorityStart);
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");
  const resolverEnd = source.indexOf("\n\nfunction resolveNonEmptyRegularArtifactFile", resolverStart);
  const snapshotStart = source.indexOf("type ImmutableFileSnapshot", resolverEnd);
  const snapshotEnd = source.indexOf("\n\nfunction decodeStrictUtf8Snapshot", snapshotStart);
  assert.ok(authorityStart >= 0 && authorityEnd > authorityStart, source);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, source);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, source);
  const emitted = ts.transpileModule(
    [
      source.slice(authorityStart, authorityEnd),
      source.slice(resolverStart, resolverEnd),
      source.slice(snapshotStart, snapshotEnd)
    ].join("\n\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;

  let admittedDependencyArtifactDirs = [...initialAdmittedDependencyArtifactDirs];
  const derivationInputs: DerivePromptArtifactAuthorityInput[] = [];
  const loaded = new Function(
    "path",
    "realpathSync",
    "statSync",
    "assertRegularFileInside",
    "isStrictlyInsideDirectory",
    "readRegularFileSnapshot",
    "derivePromptArtifactAuthority",
    "admittedDependencyArtifactDirs",
    "serializePromptArtifactAuthority",
    "assertDependencyArtifactAdmissionCurrent",
    "prepareSafeFilePath",
    "writeFileDurable",
    "parsePromptArtifactAuthorityBytes",
    "lstatSync",
    "rmSync",
    "isMissingPathError",
    "MAX_SEALED_TASK_MANIFEST_BYTES",
    "MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES",
    "PROMPT_ARTIFACT_AUTHORITY_DIRECTORY",
    `${emitted}; return {
      assertUnchanged: assertPromptArtifactAuthorityUnchanged,
      materialize: materializePromptArtifactAuthority,
      path: promptArtifactAuthorityPath,
      relativePath: promptArtifactAuthorityRelativePath
    };`
  )(
    path,
    fs.realpathSync,
    fs.statSync,
    assertRegularFileInside,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    readRegularFileSnapshot,
    (input: DerivePromptArtifactAuthorityInput) => {
      derivationInputs.push(input);
      return derivePromptArtifactAuthority(input);
    },
    () => admittedDependencyArtifactDirs,
    serializePromptArtifactAuthority,
    () => ({ directories: admittedDependencyArtifactDirs }),
    prepareSafeFilePath,
    writeFileDurable,
    parsePromptArtifactAuthorityBytes,
    fs.lstatSync,
    fs.rmSync,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    64 * 1024 * 1024,
    32 * 1024 * 1024,
    ".ultrafuzz/authorities"
  ) as Pick<
    ReturnType<typeof loadGeneratedPromptArtifactAuthorityHarness>,
    "assertUnchanged" | "materialize" | "path" | "relativePath"
  >;

  return {
    ...loaded,
    derivationInputs,
    setAdmittedDependencyArtifactDirs(directories) {
      admittedDependencyArtifactDirs = [...directories];
    }
  };
}

function promptAuthorityDeclaredOutput(
  outputPath: string,
  contract: ArtifactContractId,
  primary = false
): SmithersTaskManifestOutput {
  const binding = artifactContractSchemaBinding(contract);
  return {
    path: outputPath,
    contract,
    contractDigest: artifactContractDefinition(contract).digest,
    ...(binding === undefined
      ? {}
      : {
          schemaFile: binding.schema_file,
          schemaId: binding.schema_id,
          schemaSha256: binding.schema_sha256,
          schemaBundleSha256: binding.schema_bundle_sha256,
          validatorBuild: binding.validator_build
        }),
    primary
  };
}

function promptAuthoritySealedTask(input: {
  attemptId: string;
  controllerRunRoot: string;
  dependencies?: readonly SmithersTaskManifestTask[];
  logicalNodeId?: string;
  optionalDependencyAttemptIds?: readonly string[];
  outputs: SmithersTaskManifestOutput[];
  selectors?: PromptArtifactAuthoritySelector[];
}): SmithersTaskManifestTask {
  const dependencies = input.dependencies ?? [];
  const dependencyAttemptIds = dependencies.map((dependency) => dependency.attemptId);
  const dependencySmithersNodeIds = dependencies.map((dependency) => dependency.verifierSmithersNodeId);
  const dependencyArtifactDirs = dependencies.map((dependency) => dependency.artifactDir);
  const optionalDependencyAttemptIds = new Set(input.optionalDependencyAttemptIds ?? []);
  const optionalDependencyArtifactDirs = dependencies
    .filter((dependency) => optionalDependencyAttemptIds.has(dependency.attemptId))
    .map((dependency) => dependency.artifactDir);
  const logicalNodeId = input.logicalNodeId ?? input.attemptId;
  const workspacePath = path.join(input.controllerRunRoot, "workspaces", input.attemptId);
  const artifactDir = path.join(input.controllerRunRoot, "artifacts", input.attemptId);
  const sourceRevision = "a".repeat(40);
  const sourceRef = "refs/ultrafuzz/runs/run-1/source";
  const resources = { cpu: 1, memoryMiB: 1_024, timeoutSeconds: 60 };
  const agentChain = [
    {
      profileId: "private-profile",
      agentRef: "CodexAgent",
      modelName: "controller-model-private",
      reasoningEffort: "controller-reasoning-private",
      role: "primary" as const
    }
  ];
  return {
    attemptId: input.attemptId,
    concreteNodeId: input.attemptId,
    logicalNodeId,
    preparationSmithersNodeId: `prepare:${input.attemptId}`,
    smithersNodeId: `node:${input.attemptId}`,
    verifierSmithersNodeId: `verify:${input.attemptId}`,
    agentRef: "CodexAgent",
    agentChain,
    modelName: "controller-model-private",
    reasoningEffort: "controller-reasoning-private",
    sourceRevision,
    sourceRef,
    dependencies: dependencyAttemptIds,
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    ...(optionalDependencyArtifactDirs.length === 0 ? {} : { optionalDependencyArtifactDirs }),
    ...(input.selectors === undefined ? {} : { promptArtifactAuthoritySelectors: input.selectors }),
    execution: { mode: "local", resources, agentCredentialEnv: [] },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: "run-1",
        smithersWorkflowName: "workflow-run-1",
        graphVersion: "4",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: input.attemptId,
        logicalNodeId,
        attemptId: input.attemptId,
        label: logicalNodeId,
        kind: "agentic"
      },
      dependencies: {
        concreteNodeIds: [...dependencyAttemptIds],
        attemptIds: [...dependencyAttemptIds],
        smithersNodeIds: [...dependencySmithersNodeIds]
      },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      model: {
        profileId: "private-profile",
        agentRef: "CodexAgent",
        modelName: "controller-model-private",
        reasoningEffort: "controller-reasoning-private",
        modelIndex: 0,
        attemptIndex: 0,
        agentChain
      },
      workspace: {
        primitive: "worktree",
        path: workspacePath,
        repoPath: path.dirname(input.controllerRunRoot),
        trustModel: "skip-permissions",
        sourceRevision,
        sourceRef
      },
      artifacts: {
        dir: artifactDir,
        outputs: input.outputs,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources }
    }
  };
}

function promptAuthorityManifestFixture(
  controllerRunRoot: string,
  selectors: PromptArtifactAuthoritySelector[]
): SmithersTaskManifestDocument {
  const required = promptAuthoritySealedTask({
    attemptId: "required-producer",
    controllerRunRoot,
    logicalNodeId: "required-strategy",
    outputs: [
      promptAuthorityDeclaredOutput("findings.json", "ultrafuzz/findings@2", true),
      promptAuthorityDeclaredOutput("generated-tests/manifest.json", "ultrafuzz/generated-tests@3"),
      promptAuthorityDeclaredOutput("controller-notes.txt", "ultrafuzz/text@1")
    ]
  });
  const optional = promptAuthoritySealedTask({
    attemptId: "optional-producer",
    controllerRunRoot,
    logicalNodeId: "optional-strategy",
    outputs: [promptAuthorityDeclaredOutput("findings.json", "ultrafuzz/findings@2", true)]
  });
  const consumer = promptAuthoritySealedTask({
    attemptId: "consumer",
    controllerRunRoot,
    dependencies: [required, optional],
    optionalDependencyAttemptIds: [optional.attemptId],
    outputs: [promptAuthorityDeclaredOutput("report.md", "ultrafuzz/nonempty-markdown@1", true)],
    selectors
  });
  return {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: "run-1",
    smithers_run_id: "ultrafuzz-run-1",
    workflow_name: "workflow-run-1",
    source_revision: "a".repeat(40),
    source_ref: "refs/ultrafuzz/runs/run-1/source",
    pinned_submodules: null,
    tasks: [required, optional, consumer]
  };
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
  ) => {
    artifacts: Array<{ sha256: string }>;
    primary_artifact: string;
    verification_marker_sha256: string;
    verification_marker_size_bytes: number;
  };
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
  // The real template resolver and bounded snapshot reader are lifted rather
  // than stubbed so their failure diagnostics (#693: the resolved candidate,
  // the base it was resolved against, and the chained cause) are pinned
  // against the shipped code.
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");
  const resolverEnd = source.indexOf("\n\nfunction sameImmutableFileIdentity", resolverStart);
  const issueFormatterStart = source.indexOf("function formatSchemaValidationIssues");
  const issueFormatterEnd = source.indexOf("\n\nfunction firstDependencyRequiringReplay", issueFormatterStart);
  const captureStart = source.indexOf("function captureTaskOutputs");
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts", captureStart);
  const verifierStart = source.indexOf("function verifyArtifacts", finalizerStart);
  const verifierEnd = source.indexOf("function readInvariantSourceSnapshot", verifierStart);
  assert.ok(dependencyVerifierStart >= 0 && dependencyVerifierEnd > dependencyVerifierStart, source);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart, source);
  assert.ok(issueFormatterStart >= 0 && issueFormatterEnd > issueFormatterStart, source);
  assert.ok(captureStart >= 0 && finalizerStart > captureStart, source);
  assert.ok(verifierStart > finalizerStart && verifierEnd > verifierStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(dependencyVerifierStart, dependencyVerifierEnd)}\n${source.slice(resolverStart, resolverEnd)}\n${source.slice(issueFormatterStart, issueFormatterEnd)}\n${source.slice(captureStart, finalizerStart)}\n${source.slice(verifierStart, verifierEnd)}`,
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
  const authenticateDependency = (task: VerifyArtifactsTask, dependency: string) => {
    const resolved = fs.realpathSync(dependency);
    if (!authenticatedDependencies.has(resolved)) {
      throw new Error(`artifact-contract failure: dependency is not authenticated ${resolved}`);
    }
    authenticatedDependencyChecks.push({ consumerAttemptId: task.attemptId, dependency: resolved });
    const producer = harnessTaskSpecs.find(
      (candidate) =>
        candidate.attemptId === path.basename(resolved) && fs.realpathSync(candidate.artifactDir) === resolved
    );
    if (producer === undefined) {
      throw new Error(`artifact-contract failure: dependency producer is unavailable ${resolved}`);
    }
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
        const stat = fs.statSync(artifactPath, { bigint: true });
        return [
          output.path,
          Object.freeze({
            path: artifactPath,
            relativePath: output.path,
            contract: output.contract,
            bytes: Buffer.from(bytes),
            identity: {
              dev: stat.dev,
              ino: stat.ino,
              size: stat.size,
              mtimeNs: stat.mtimeNs,
              ctimeNs: stat.ctimeNs
            },
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
    const markerBytes = Buffer.from(
      JSON.stringify([...publications].sort(([left], [right]) => left.localeCompare(right))),
      "utf8"
    );
    return Object.freeze({
      attemptId: producer.attemptId,
      artifactDir: resolved,
      marker: {
        path: `${resolved}.marker.json`,
        bytes: markerBytes,
        identity: { dev: 1n, ino: 1n, size: BigInt(markerBytes.length), mtimeNs: 1n, ctimeNs: 1n }
      },
      artifacts,
      publications,
      generatedTestBundles: Object.freeze([])
    });
  };
  const dependencyAdmissions = new Map<string, unknown>();
  const dependencyAdmissionFor = (task: VerifyArtifactsTask) => {
    const existing = dependencyAdmissions.get(task.attemptId);
    if (existing !== undefined) return existing;
    const directories = task.dependencyArtifactDirs.filter((dependency) =>
      authenticatedDependencies.has(fs.realpathSync(dependency))
    );
    const snapshotsByProducerAttempt = new Map(
      directories.map((dependency) => {
        const snapshot = authenticateDependency(task, dependency);
        return [snapshot.attemptId, snapshot] as const;
      })
    );
    const admission = { task, directories, snapshotsByProducerAttempt };
    dependencyAdmissions.set(task.attemptId, admission);
    return admission;
  };
  const assertDependencyAdmissionCurrentFor = (task: VerifyArtifactsTask) => {
    const existing = dependencyAdmissions.get(task.attemptId) as
      | {
          task: VerifyArtifactsTask;
          directories: string[];
          snapshotsByProducerAttempt: Map<string, ReturnType<typeof authenticateDependency>>;
        }
      | undefined;
    if (existing === undefined) return dependencyAdmissionFor(task);
    for (const [attemptId, admitted] of existing.snapshotsByProducerAttempt) {
      const current = authenticateDependency(task, admitted.artifactDir);
      const changed =
        current.attemptId !== attemptId ||
        !current.marker.bytes.equals(admitted.marker.bytes) ||
        [...admitted.artifacts].some(([relativePath, artifact]) => {
          const candidate = current.artifacts.get(relativePath);
          return candidate === undefined || !candidate.bytes.equals(artifact.bytes);
        });
      if (changed) {
        throw new Error(`artifact-contract failure: dependency authority changed after admission ${attemptId}`);
      }
    }
    return existing;
  };
  const factory = new Function(
    "path",
    "realpathSync",
    "taskSpecs",
    "taskArtifactRoots",
    "isStrictlyInsideDirectory",
    "assertRegularFileInside",
    "statSync",
    "readRegularFileSnapshot",
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
    "dependencyArtifactAdmission",
    "assertDependencyArtifactAdmissionCurrent",
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
    assertRegularFileInside,
    fs.statSync,
    readRegularFileSnapshot,
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
    dependencyAdmissionFor,
    assertDependencyAdmissionCurrentFor,
    authenticateDependency,
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
    (...args: unknown[]) => {
      markerWrites.push(args);
      return { marker_sha256: "f".repeat(64), size_bytes: 123 };
    },
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

function loadArtifactVerificationMarkerWriter(
  root: string
): (
  task: { attemptId: string; runRoot: string; metadata: { node: { logicalNodeId: string } } },
  artifacts: readonly Record<string, unknown>[],
  publications: ReadonlyMap<string, Buffer>
) => { marker_sha256: string; size_bytes: number } {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const writerStart = source.indexOf("function writeArtifactVerificationMarker");
  const writerEnd = source.indexOf("\n\nfunction verifyGeneratedTestFiles", writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart, source);
  const emitted = ts.transpileModule(source.slice(writerStart, writerEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "artifactVerificationMarkerLocation",
    "assertSafeVerifiedPublicationPath",
    "createHash",
    "validateArtifactVerificationMarker",
    "assertArtifactVerificationMarkerSemantics",
    "Buffer",
    "publishFileDurableExclusive",
    "ARTIFACT_VERIFICATION_SCHEMA_VERSION",
    "MAX_ARTIFACT_VERIFICATION_MARKER_BYTES",
    "admittedDependencyArtifactDirs",
    "path",
    `${emitted}; return writeArtifactVerificationMarker;`
  )(
    (_runRoot: string, attemptId: string) => ({
      root,
      path: path.join(root, `${attemptId}.json`),
      relativePath: `${attemptId}.json`
    }),
    (relativePath: string) => {
      assert.equal(path.posix.normalize(relativePath), relativePath);
      assert.equal(path.posix.isAbsolute(relativePath), false);
    },
    createHash,
    () => ({ ok: true, issues: [] }),
    () => undefined,
    Buffer,
    publishFileDurableExclusive,
    "ultrafuzz.artifact-verification.v2",
    64 * 1024 * 1024,
    () => [path.join(root, "artifacts", "required-ancestor")],
    path
  ) as ReturnType<typeof loadArtifactVerificationMarkerWriter>;
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
    // A positively identified vendor-format credential: the publication gate
    // scans positive-only (#819), so a bare `token=` keyword assignment is a
    // display-redaction heuristic and no longer fails publication.
    const contaminated = Buffer.from("analysis ghp_AbCdEf1234567890AbCdEf1234567890AbCd\n", "utf8");
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
    assert.equal(result.verification_marker_sha256, "f".repeat(64));
    assert.equal(result.verification_marker_size_bytes, 123);
    assert.equal(harness.publications.get("result.json")?.equals(original), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated verifier returns the exact durable verification-marker byte authority", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-marker-authority-")));
  try {
    const writeMarker = loadArtifactVerificationMarkerWriter(root);
    const alpha = Buffer.from("alpha publication\n", "utf8");
    const zeta = Buffer.from("zeta publication\n", "utf8");
    const artifacts = [
      {
        path: "alpha.txt",
        contract: "ultrafuzz/text@1",
        contract_digest: "a".repeat(64),
        sha256: createHash("sha256").update(alpha).digest("hex"),
        primary: true
      }
    ];
    const authority = writeMarker(
      {
        attemptId: "attempt-one",
        runRoot: root,
        metadata: { node: { logicalNodeId: "node-one" } }
      },
      artifacts,
      new Map([
        ["zeta.txt", zeta],
        ["alpha.txt", alpha]
      ])
    );
    const markerBytes = fs.readFileSync(path.join(root, "attempt-one.json"));
    const marker = JSON.parse(markerBytes.toString("utf8")) as {
      admitted_dependency_attempt_ids: string[];
      publications: Array<{ path: string; sha256: string }>;
    };

    assert.equal(authority.size_bytes, markerBytes.byteLength);
    assert.equal(authority.marker_sha256, createHash("sha256").update(markerBytes).digest("hex"));
    assert.deepEqual(marker.admitted_dependency_attempt_ids, ["required-ancestor"]);
    assert.deepEqual(marker.publications, [
      { path: "alpha.txt", sha256: createHash("sha256").update(alpha).digest("hex") },
      { path: "zeta.txt", sha256: createHash("sha256").update(zeta).digest("hex") }
    ]);

    const rewritten = Buffer.from(markerBytes);
    const digestOffset = rewritten.indexOf(Buffer.from(marker.publications[0]!.sha256, "utf8"));
    assert.ok(digestOffset >= 0);
    rewritten[digestOffset] = rewritten[digestOffset]! ^ 1;
    assert.notEqual(createHash("sha256").update(rewritten).digest("hex"), authority.marker_sha256);
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
    ["node_id", "node-foreign"],
    ["provenance", { producer_node_id: "node-one-attempt-1" }]
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

test("generated Smithers fails closed on missing or duplicate selected-strategies declarations", () => {
  const tupleContracts = [
    "ultrafuzz/dynamic-strategy-plan@1",
    "ultrafuzz/dynamic-enumerator-outputs@1",
    "ultrafuzz/selected-strategies@1",
    "ultrafuzz/generated-tests@3",
    "ultrafuzz/findings@2",
    "ultrafuzz/dynamic-strategy-provenance@1"
  ] as const;
  for (const count of [0, 2] as const) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-dynamic-selected-tuple-${count}-`)));
    try {
      const task = singleOutputVerificationTask(root, "ultrafuzz/text@1");
      task.outputs = tupleContracts
        .filter((contract) => contract !== "ultrafuzz/selected-strategies@1" || count !== 0)
        .map((contract, index) => ({
          path: `dynamic/output-${index}.json`,
          contract,
          contractDigest: String(index + 1).repeat(64),
          primary: index === 0
        }));
      if (count === 2) {
        task.outputs.push({
          path: "dynamic/selected-duplicate.json",
          contract: "ultrafuzz/selected-strategies@1",
          contractDigest: "f".repeat(64),
          primary: false
        });
      }
      const harness = loadVerifyArtifactsHarness({ taskSpecs: [task] });

      assert.throws(
        () => harness.verifyArtifacts(task),
        new RegExp(`exactly one complete dynamic-strategy output tuple.*ultrafuzz/selected-strategies@1=${count}`, "u")
      );
      assert.equal(harness.publications.size, 0);
      assert.equal(harness.markerWrites.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("generated Smithers rejects schema-valid forged timeout evidence before publication", () => {
  const record = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
  const cases: Array<{
    label: string;
    mutate: (plan: Record<string, unknown>, result: Record<string, unknown>, summary: Record<string, unknown>) => void;
    alsoMatches?: RegExp;
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
    },
    {
      // #693 surface 3: the wrong-field bug — execution.deadline copied from
      // the plan's fuzzing_deadline_utc instead of final_artifact_deadline_utc.
      // The gate must name the expected final-artifact value next to the
      // forged one.
      label: "execution deadline from fuzzing deadline",
      mutate: (_plan, result) => {
        record(result.execution).deadline = "2026-01-01T01:00:00Z";
      },
      alsoMatches:
        /Execution deadline must equal plan final artifact deadline \(expected "2026-01-01T01:10:00Z", actual "2026-01-01T01:00:00Z"\) at \$\.execution\.deadline/u
    }
  ];

  for (const { label, mutate, alsoMatches } of cases) {
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
        (error: unknown) => {
          assert.ok(error instanceof Error, label);
          assert.match(error.message, /property-campaign-timeout-evidence failed/u, label);
          if (alsoMatches !== undefined) assert.match(error.message, alsoMatches, label);
          return true;
        },
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
        (error: unknown) => {
          assert.ok(error instanceof Error, mode);
          assert.match(
            error.message,
            /campaign evidence (?:is not an immutable regular file|does not match its manifest)/u,
            mode
          );
          if (mode === "missing") {
            // #693: the resolver preserves the resolution evidence and the
            // underlying cause instead of collapsing every failure into the
            // caller's message.
            assert.match(
              error.message,
              /\(resolved \S*backends\/recon-fuzzer\/results\.json against base \S*campaign-artifacts\)/u,
              mode
            );
            assert.ok(error.cause instanceof Error, mode);
          }
          return true;
        },
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

// #693: the recon-fuzzer campaign backend recorded every path field with a
// workspace/node-directory prefix while the gates expect artifact-dir-relative
// paths and bare declared output paths. One base disagreement surfaced as five
// sequential terminal node failures, each diagnosable only from gate source.
// This one fixture pins all five surfaces at once; the phases are separate
// verifications only because the node-attempt failure message is capped at
// 1,000 bytes, which truncates a single aggregate naming every surface.
test("generated Smithers diagnoses the node-dir campaign path base across all five #693 surfaces", () => {
  const workspacePrefix = "artifacts/attempt-campaign/";
  const nodeDirPrefix = "stateful-invariant-campaign/";
  const prefixedCampaignPaths = Object.fromEntries(
    Object.entries(generatedCampaignPaths).map(([key, value]) => [key, `${workspacePrefix}${value}`])
  );
  const incidentDocuments = (options: {
    workspacePathFields?: boolean;
    workspaceEvidenceManifest?: boolean;
    forgedExecutionDeadline?: boolean;
    nodeDirResultRefs?: boolean;
    nodeDirSummaryRefs?: boolean;
  }): { plan: Record<string, unknown>; result: Record<string, unknown>; summary: Record<string, unknown> } => {
    const plan = generatedCampaignPlanFixture();
    const result = generatedPropertyCampaignFixture();
    const summary = generatedCampaignSummaryFixture([], 0);
    if (options.workspacePathFields === true) {
      plan.paths = prefixedCampaignPaths;
      result.paths = prefixedCampaignPaths;
      (result.coverage as Record<string, unknown>).metrics = [
        {
          name: "executions",
          value: 1,
          unit: "count",
          source_ref: `${workspacePrefix}${generatedCampaignPaths.raw_results}`
        }
      ];
      (result.property_results as Array<Record<string, unknown>>)[0]!.evidence_refs = [
        `${workspacePrefix}${generatedCampaignPaths.raw_results}`
      ];
    }
    if (options.workspaceEvidenceManifest === true) {
      result.evidence_files = generatedCampaignEvidenceFiles().map((entry) => ({
        ...entry,
        path: `${workspacePrefix}${entry.path}`
      }));
    }
    if (options.forgedExecutionDeadline === true) {
      (result.execution as Record<string, unknown>).deadline = "2026-01-01T01:00:00Z";
    }
    if (options.nodeDirResultRefs === true) {
      result.campaign_plan_ref = `${nodeDirPrefix}campaign-plan.json`;
      result.implemented_properties_ref = `${nodeDirPrefix}implemented-properties.json`;
      result.findings_ref = `${nodeDirPrefix}findings.json`;
      result.campaign_summary_ref = `${nodeDirPrefix}campaign-summary.json`;
    }
    if (options.nodeDirSummaryRefs === true) {
      summary.campaign_plan_ref = `${nodeDirPrefix}campaign-plan.json`;
      summary.implemented_property_suite_refs = [`${nodeDirPrefix}implemented-properties.json`];
      summary.backend_results = [
        { fuzzer_backend: "recon", status: "complete", result_ref: `${nodeDirPrefix}campaign.json` }
      ];
    }
    return { plan, result, summary };
  };
  const phases: Array<{
    label: string;
    options: Parameters<typeof incidentDocuments>[0];
    verify: (error: Error) => void;
  }> = [
    {
      // Surface 1: workspace-prefixed evidence_files[].path resolves to a
      // doubled candidate; the resolver must name the candidate, the base,
      // and the underlying cause instead of only the caller's message.
      label: "surface 1: evidence resolution",
      options: {
        workspacePathFields: true,
        workspaceEvidenceManifest: true,
        forgedExecutionDeadline: true,
        nodeDirResultRefs: true,
        nodeDirSummaryRefs: true
      },
      verify: (error) => {
        assert.match(
          error.message,
          /campaign evidence is not an immutable regular file artifacts\/attempt-campaign\/backends\/recon-fuzzer\/run\.log/u
        );
        assert.match(
          error.message,
          /\(resolved \S*campaign-artifacts\/artifacts\/attempt-campaign\/backends\/recon-fuzzer\/run\.log against base \S*campaign-artifacts\)/u
        );
        assert.match(error.message, /does not exist/u);
        assert.ok(error.cause instanceof Error);
      }
    },
    {
      // Surfaces 2 and 3: correcting evidence_files one-sidedly desynchronises
      // the closure set, and execution.deadline carries the plan's
      // fuzzing_deadline_utc. Both gates must name expected next to actual.
      label: "surfaces 2 and 3: evidence closure and timeout evidence",
      options: {
        workspacePathFields: true,
        forgedExecutionDeadline: true,
        nodeDirResultRefs: true,
        nodeDirSummaryRefs: true
      },
      verify: (error) => {
        assert.match(error.message, /property-campaign-evidence-file-closure failed/u);
        assert.match(
          error.message,
          /referenced paths missing from evidence_files: artifacts\/attempt-campaign\/backends\/recon-fuzzer\/results\.json, artifacts\/attempt-campaign\/backends\/recon-fuzzer\/run\.log/u
        );
        assert.match(
          error.message,
          /evidence_files entries nothing references: backends\/recon-fuzzer\/results\.json, backends\/recon-fuzzer\/run\.log/u
        );
        assert.match(error.message, /property-campaign-timeout-evidence failed/u);
        assert.match(
          error.message,
          /Execution deadline must equal plan final artifact deadline \(expected "2026-01-01T01:10:00Z", actual "2026-01-01T01:00:00Z"\) at \$\.execution\.deadline/u
        );
        assert.match(error.message, /property-campaign-context-joins failed/u);
      }
    },
    {
      // Surface 4: the result's four sibling references carry the node-dir
      // prefix; the join must name the expected bare declared output path.
      label: "surface 4: node-dir result references",
      options: { nodeDirResultRefs: true },
      verify: (error) => {
        assert.match(error.message, /property-campaign-context-joins failed/u);
        assert.match(
          error.message,
          /Campaign plan reference does not name the authenticated sibling plan \(expected "campaign-plan\.json", actual "stateful-invariant-campaign\/campaign-plan\.json"\) at \$\.campaign_plan_ref/u
        );
        assert.match(
          error.message,
          /\(expected "implemented-properties\.json", actual "stateful-invariant-campaign\/implemented-properties\.json"\) at \$\.implemented_properties_ref/u
        );
        assert.match(
          error.message,
          /\(expected "findings\.json", actual "stateful-invariant-campaign\/findings\.json"\) at \$\.findings_ref/u
        );
        assert.match(
          error.message,
          /\(expected "campaign-summary\.json", actual "stateful-invariant-campaign\/campaign-summary\.json"\) at \$\.campaign_summary_ref/u
        );
      }
    },
    {
      // Surface 5: campaign-summary.json repeats the pattern in its own
      // references.
      label: "surface 5: node-dir summary references",
      options: { nodeDirSummaryRefs: true },
      verify: (error) => {
        assert.match(error.message, /property-campaign-context-joins failed/u);
        assert.match(
          error.message,
          /\(expected "campaign-plan\.json", actual "stateful-invariant-campaign\/campaign-plan\.json"\) at \$\.campaign_summary_ref#campaign_plan_ref/u
        );
        assert.match(
          error.message,
          /Campaign summary implementation references do not match the authenticated handoff \(expected \["implemented-properties\.json"\], actual \["stateful-invariant-campaign\/implemented-properties\.json"\]\) at \$\.campaign_summary_ref#implemented_property_suite_refs/u
        );
        assert.match(
          error.message,
          /\(expected "campaign\.json", actual "stateful-invariant-campaign\/campaign\.json"\) at \$\.campaign_summary_ref#backend_results\[0\]\.result_ref/u
        );
      }
    }
  ];

  for (const { label, options, verify } of phases) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-campaign-path-base-")));
    try {
      const fixture = generatedCampaignVerificationFixture(root);
      const documents = incidentDocuments(options);
      for (const [relativePath, contract, document] of [
        ["campaign-plan.json", "ultrafuzz/invariant-campaign-plan@2", documents.plan],
        ["campaign.json", "ultrafuzz/property-campaign@3", documents.result],
        ["campaign-summary.json", "ultrafuzz/campaign-summary@2", documents.summary]
      ] as const) {
        const contents = `${JSON.stringify(document)}\n`;
        assert.equal(validateArtifactContract(contract, contents).ok, true, `${label}: ${relativePath}`);
        fs.writeFileSync(path.join(fixture.task.artifactDir, relativePath), contents, "utf8");
      }
      const harness = loadVerifyArtifactsHarness({
        taskSpecs: [fixture.implementationProducer, fixture.task],
        authenticatedDependencyDirs: [fixture.implementationArtifactDir]
      });

      assert.throws(
        () => harness.verifyArtifacts(fixture.task, harness.captureTaskOutputs(fixture.task)),
        (error: unknown) => {
          assert.ok(error instanceof Error, label);
          verify(error);
          return true;
        },
        label
      );
      assert.equal(harness.publications.size, 0, label);
      assert.equal(harness.markerWrites.length, 0, label);
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
      /verified dependency authority changed during semantic verification: artifact-contract failure: dependency authority changed after admission attempt-implemented-properties/u
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

    assert.throws(
      () => harness.verifyArtifacts(task, captured),
      /ultrafuzz\/property-campaign@3\): .*must be equal to constant/u
    );
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
    () => ({ severityClassifiedFindings: null, dedupedFindings: null, findingLifecycleLedger: null }),
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
    severityClassifiedFindings: null,
    dedupedFindings: null,
    findingLifecycleLedger: null
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
  const coverageEnd = source.indexOf("\n\ntype FinalReportAgentAttempt", coverageStart);
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
  runRoot: string;
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
    dedupedFindings?: unknown | null;
    findingLifecycleLedger?: unknown | null;
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
  const declaredPathStart = source.indexOf("function declaredDifferentialArtifactPath");
  const declaredPathEnd = source.indexOf("\n\nfunction siblingDifferentialBindings", declaredPathStart);
  assert.ok(singletonStart >= 0 && singletonEnd > singletonStart, source);
  assert.ok(siblingStart >= 0 && siblingEnd > siblingStart, source);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart, source);
  assert.ok(declaredPathStart >= 0 && declaredPathEnd > declaredPathStart, source);
  const emitted = ts.transpileModule(
    [
      source.slice(singletonStart, singletonEnd),
      source.slice(siblingStart, siblingEnd),
      source.slice(declaredPathStart, declaredPathEnd),
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
    "path",
    `${emitted}; return { reviewStage: reviewStageSemanticContext, finalSeverity: verifiedFinalSeverityReviewAuthority };`
  )(taskSpecs, declaredAncestorContractOutputs, verifiedDependencyJsonArtifact, path) as {
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
    runRoot: "/run",
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: ancestorClosure.map((ancestor) => ancestor.artifactDir),
    metadata: {
      node: { logicalNodeId: `renamed-${attemptId}` },
      dependencies: { attemptIds: directDependencies.map((dependency) => dependency.attemptId) }
    },
    outputs
  });
  const raw = task("attempt-raw", [], [], [{ path: "custom/raw.json", contract: "ultrafuzz/findings@2" }]);
  const dedupe = task(
    "attempt-dedupe",
    [raw],
    [raw],
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
  const dedupedFindings = [{ id: "finding-dedupe", title: "Raw finding", dedupe_key: "key-one" }];
  const rawFindings = [{ id: "finding-dedupe", title: "Raw finding" }];
  const rawFindingPath = "artifacts/attempt-raw/custom/raw.json";
  const dedupeLedger = {
    records: [
      {
        dedupe_key: "key-one",
        source_artifacts: [
          {
            path: rawFindingPath,
            node_id: "renamed-attempt-raw",
            finding_id: "finding-dedupe",
            title: "Raw finding",
            relationship: "primary"
          }
        ],
        strategy_hits: [],
        stages: [
          { stage: "raw", artifact_path: rawFindingPath, finding_id: "finding-dedupe" },
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
  remember(raw, "custom/raw.json", "ultrafuzz/findings@2", rawFindings);
  remember(dedupe, "custom/dedupe-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", dedupeLedger);
  remember(dedupe, "custom/detections.json", "ultrafuzz/strategy-detections@1", dedupeDetections);
  remember(triage, "custom/triage-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", triageLedger);
  remember(severity, "custom/severity.json", "ultrafuzz/severity-classified-findings@1", severityFindings);
  remember(severity, "custom/severity-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", severityLedger);
  remember(unrelatedLedger, "other/ledger.json", "ultrafuzz/finding-lifecycle-ledger@1", { records: [] });
  const harness = loadGeneratedReviewAuthorityHarness(
    [raw, dedupe, triage, severity, unrelatedLedger, report],
    documents
  );
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
    strategyDetections: dedupeDetections,
    rawFindingArtifacts: [
      {
        nodeId: "renamed-attempt-raw",
        path: rawFindingPath,
        findings: rawFindings
      }
    ]
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

test("generated bounded final-report authority authenticates one direct dedupe producer and its paired ledger", () => {
  const task = (
    attemptId: string,
    directDependencies: readonly ReviewAuthorityHarnessTask[],
    ancestorClosure: readonly ReviewAuthorityHarnessTask[],
    outputs: ReviewAuthorityHarnessOutput[]
  ): ReviewAuthorityHarnessTask => ({
    attemptId,
    runRoot: "/run",
    artifactDir: path.join("/run/artifacts", attemptId),
    dependencyArtifactDirs: ancestorClosure.map((ancestor) => ancestor.artifactDir),
    metadata: {
      node: { logicalNodeId: `renamed-${attemptId}` },
      dependencies: { attemptIds: directDependencies.map((dependency) => dependency.attemptId) }
    },
    outputs
  });
  const transitive = task(
    "attempt-transitive",
    [],
    [],
    [{ path: "custom/transitive.json", contract: "ultrafuzz/findings@2" }]
  );
  const dedupe = task(
    "attempt-dedupe",
    [transitive],
    [transitive],
    [
      { path: "custom/deduped.json", contract: "ultrafuzz/findings@2" },
      { path: "custom/dedupe-ledger.json", contract: "ultrafuzz/finding-lifecycle-ledger@1" }
    ]
  );
  const report = task(
    "attempt-report",
    [dedupe],
    [transitive, dedupe],
    [{ path: "custom/report.json", contract: "ultrafuzz/report@3" }]
  );
  const dedupedFindings = [{ id: "finding-one", dedupe_key: "root-one" }];
  const lifecycle = { records: [{ dedupe_key: "root-one" }] };
  const harness = loadGeneratedReviewAuthorityHarness(
    [transitive, dedupe, report],
    new Map<string, unknown>([
      [reviewAuthorityDocumentKey(dedupe, "custom/deduped.json", "ultrafuzz/findings@2"), dedupedFindings],
      [
        reviewAuthorityDocumentKey(dedupe, "custom/dedupe-ledger.json", "ultrafuzz/finding-lifecycle-ledger@1"),
        lifecycle
      ]
    ])
  );

  assert.deepEqual(harness.finalSeverity(report), {
    severityClassifiedFindings: null,
    dedupedFindings,
    findingLifecycleLedger: lifecycle
  });
  assert.deepEqual(harness.authenticatedReads, [
    { producer: "attempt-dedupe", path: "custom/deduped.json", contract: "ultrafuzz/findings@2" },
    {
      producer: "attempt-dedupe",
      path: "custom/dedupe-ledger.json",
      contract: "ultrafuzz/finding-lifecycle-ledger@1"
    }
  ]);

  const producerFreeReport = task(
    "attempt-producer-free-report",
    [],
    [],
    [{ path: "custom/report.json", contract: "ultrafuzz/report@3" }]
  );
  const producerFree = loadGeneratedReviewAuthorityHarness([producerFreeReport], new Map());
  assert.deepEqual(producerFree.finalSeverity(producerFreeReport), {
    severityClassifiedFindings: null,
    dedupedFindings: null,
    findingLifecycleLedger: null
  });
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
    runRoot: "/run",
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
    runRoot: "/run",
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
      marker: {
        path: "/run/.ultrafuzz-verification/attempt-severity.json",
        bytes: Buffer.from(`marker-generation-${authorityGeneration}\n`, "utf8"),
        identity: {
          dev: 1n,
          ino: BigInt(authorityGeneration),
          size: 1n,
          mtimeNs: 1n,
          ctimeNs: 1n
        }
      },
      artifacts,
      publications,
      generatedTestBundles: Object.freeze([])
    });
  };
  const admittedAuthority = authority();
  const admission = Object.freeze({
    task: consumer,
    directories: Object.freeze([producer.artifactDir]),
    snapshotsByProducerAttempt: new Map([[producer.attemptId, admittedAuthority]])
  });
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
    "dependencyArtifactAdmission",
    "assertDependencyArtifactAdmissionCurrent",
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
    () => admission,
    () => {
      authenticationCount += 1;
      const current = authority();
      if (!current.marker.bytes.equals(admittedAuthority.marker.bytes)) {
        throw new Error(
          `artifact-contract failure: dependency authority changed after admission ${producer.attemptId}`
        );
      }
      return admission;
    },
    declaredAncestorContractOutputs
  ) as {
    begin: (task: ReviewAuthorityHarnessTask) => {
      snapshotsByProducerAttempt: Map<
        string,
        { artifacts: ReadonlyMap<string, { bytes: Buffer }>; marker: { bytes: Buffer } }
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
      /verified dependency authority changed during semantic verification:[\s\S]*attempt-severity/u
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

test("generated dynamic verification passes the resolved policy and exact declared recipe and finding ancestors", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function siblingDynamicStrategySemanticArtifacts");
  const helperEnd = source.indexOf("\n\ntype ReviewStageSemanticContext", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, source);
  const emitted = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;

  const boundaryProducer = {
    attemptId: "attempt-boundary",
    logicalNodeId: "renamed-boundary-producer",
    artifactDir: "/run/artifacts/attempt-boundary"
  };
  const findingProducer = {
    attemptId: "attempt-findings",
    logicalNodeId: "renamed-finding-producer",
    artifactDir: "/run/artifacts/attempt-findings"
  };
  const consumer = {
    attemptId: "attempt-dynamic",
    logicalNodeId: "renamed-dynamic-consumer",
    agentRef: "CodexAgent",
    modelName: "gpt-current",
    artifactDir: "/run/artifacts/attempt-dynamic",
    runRoot: "/run",
    dynamicStrategiesEnumeratorPolicy: 0,
    outputs: [
      { path: "custom/plan.json", contract: "ultrafuzz/dynamic-strategy-plan@1" },
      { path: "custom/enumerators.json", contract: "ultrafuzz/dynamic-enumerator-outputs@1" },
      { path: "custom/generated-manifest.json", contract: "ultrafuzz/generated-tests@3" },
      { path: "custom/findings.json", contract: "ultrafuzz/findings@2" },
      { path: "custom/provenance.json", contract: "ultrafuzz/dynamic-strategy-provenance@1" }
    ]
  };
  const taskSpecs = [boundaryProducer, findingProducer, consumer];
  const boundaryDocument = {
    schema_version: "ultrafuzz.boundary-recipes.v1",
    recipes: [{ id: "alpha", expected_classification_if_red: "production-bug" }]
  };
  const ancestorFindings = [{ id: "finding-alpha" }];
  const generatedTests = {
    generated_tests: [{ path: "generated-tests/StrategyA.t.sol" }],
    support_files: []
  };
  const declared = {
    "ultrafuzz/boundary-recipes@1": [
      {
        ...boundaryProducer,
        path: "declared/recipes.json",
        contract: "ultrafuzz/boundary-recipes@1"
      }
    ],
    "ultrafuzz/findings@2": [
      {
        ...findingProducer,
        path: "declared/findings.json",
        contract: "ultrafuzz/findings@2"
      }
    ]
  } as const;
  const authenticatedValues = new Map<string, unknown>([
    ["attempt-boundary\u0000declared/recipes.json", boundaryDocument],
    ["attempt-findings\u0000declared/findings.json", ancestorFindings]
  ]);
  const authenticationCalls: string[] = [];
  const dependencyAdmission = {
    snapshotsByProducerAttempt: new Map([
      [
        boundaryProducer.attemptId,
        {
          artifactDir: boundaryProducer.artifactDir,
          publications: new Map([
            ["declared/recipes.json", "a".repeat(64)],
            ["generated-tests/BoundaryCompanion.t.sol", "b".repeat(64)]
          ])
        }
      ],
      [
        findingProducer.attemptId,
        {
          artifactDir: findingProducer.artifactDir,
          publications: new Map([["declared/findings.json", "c".repeat(64)]])
        }
      ]
    ])
  };
  const helper = new Function(
    "taskSpecs",
    "declaredAncestorContractOutputs",
    "verifiedDependencyJsonArtifact",
    "dependencyArtifactAdmission",
    "path",
    `${emitted}; return siblingDynamicStrategySemanticArtifacts;`
  )(
    taskSpecs,
    (_task: unknown, contract: keyof typeof declared) => declared[contract] ?? [],
    (_task: unknown, _artifactDir: string, producer: { attemptId: string }, outputPath: string, contract: string) => {
      const key = `${producer.attemptId}\u0000${outputPath}`;
      authenticationCalls.push(`${key}\u0000${contract}`);
      assert.ok(authenticatedValues.has(key), key);
      return { value: authenticatedValues.get(key) };
    },
    () => dependencyAdmission,
    path
  ) as (task: typeof consumer, verifiedOutputs: ReadonlyMap<string, { value: unknown }>) => Record<string, unknown>;

  const siblings = new Map<string, { value: unknown }>([
    ["custom/plan.json", { value: { dynamic_strategies_enumerator: 0 } }],
    ["custom/enumerators.json", { value: { enumerators: [] } }],
    ["custom/generated-manifest.json", { value: generatedTests }],
    ["generated-tests.json", { value: { generated_tests: [], support_files: [] } }],
    ["custom/findings.json", { value: [] }],
    ["custom/provenance.json", { value: { generated_files: [{ source_path: "generated-tests/StrategyA.t.sol" }] } }]
  ]);
  const result = helper(consumer, siblings);
  assert.equal(result.dynamicStrategiesEnumeratorPolicy, 0);
  assert.equal(result.generatedTests, generatedTests);
  assert.deepEqual(result.currentAttempt, {
    attemptId: "attempt-dynamic",
    logicalNodeId: "renamed-dynamic-consumer",
    agentRef: "CodexAgent",
    modelName: "gpt-current"
  });
  assert.deepEqual(result.authenticatedCurrentRunArtifactPaths, [
    "artifacts/attempt-boundary/declared/recipes.json",
    "artifacts/attempt-boundary/generated-tests/BoundaryCompanion.t.sol",
    "artifacts/attempt-findings/declared/findings.json"
  ]);
  assert.deepEqual(result.boundaryRecipeArtifacts, [
    {
      attemptId: "attempt-boundary",
      logicalNodeId: "renamed-boundary-producer",
      path: "artifacts/attempt-boundary/declared/recipes.json",
      contract: "ultrafuzz/boundary-recipes@1",
      document: boundaryDocument
    }
  ]);
  assert.deepEqual(result.ancestorFindingArtifacts, [
    {
      attemptId: "attempt-findings",
      logicalNodeId: "renamed-finding-producer",
      path: "artifacts/attempt-findings/declared/findings.json",
      contract: "ultrafuzz/findings@2",
      document: ancestorFindings
    }
  ]);
  assert.deepEqual(authenticationCalls, [
    "attempt-boundary\u0000declared/recipes.json\u0000ultrafuzz/boundary-recipes@1",
    "attempt-findings\u0000declared/findings.json\u0000ultrafuzz/findings@2"
  ]);

  const compilerSource = fs.readFileSync(path.join(runtimePackageRoot, "src", "smithers.ts"), "utf8");
  assert.match(compilerSource, /dynamicStrategiesEnumeratorPolicy:\s*config\.dynamicStrategiesEnumerator/u);
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

test("generated cloud handoff derives durable marker authorities on pre-sync and restart rerenders", () => {
  const derive = loadDependencyVerificationAuthoritiesForTask();
  const producers = [
    {
      attemptId: "required-root__model_0__attempt_0",
      verifierId: "verify:required-root__model_0__attempt_0",
      optional: false
    },
    { attemptId: "optional-branch", verifierId: "verify:optional-branch", optional: true },
    {
      attemptId: "required-root__model_1__attempt_1",
      verifierId: "verify:required-root__model_1__attempt_1",
      optional: false
    }
  ] as const;
  const task = { dependencyVerificationProducers: producers };
  const first = {
    verification_marker_sha256: "a".repeat(64),
    verification_marker_size_bytes: 1_024
  };
  const second = {
    verification_marker_sha256: "b".repeat(64),
    verification_marker_size_bytes: 2_048
  };
  const optional = {
    verification_marker_sha256: "c".repeat(64),
    verification_marker_size_bytes: 4_096
  };
  const durableRows = new Map<string, GeneratedVerificationAuthorityOutput>();
  const reads: string[] = [];
  const outputForProducer = (producer: GeneratedDependencyVerificationProducer) => {
    reads.push(producer.verifierId);
    return durableRows.get(producer.verifierId);
  };

  assert.equal(derive(task, outputForProducer), undefined, "the pre-sync frame must wait for required output");
  assert.deepEqual(reads, [producers[0].verifierId]);

  durableRows.set(producers[0].verifierId, first);
  durableRows.set(producers[2].verifierId, second);
  reads.length = 0;
  const preSyncHandoff = derive(task, outputForProducer);
  assert.deepEqual(preSyncHandoff, [
    { attempt_id: producers[0].attemptId, marker_sha256: first.verification_marker_sha256, size_bytes: 1_024 },
    { attempt_id: producers[2].attemptId, marker_sha256: second.verification_marker_sha256, size_bytes: 2_048 }
  ]);
  assert.deepEqual(
    reads,
    producers.map((producer) => producer.verifierId)
  );

  durableRows.set(producers[1].verifierId, optional);
  const completeHandoff = derive(task, outputForProducer);
  assert.deepEqual(completeHandoff, [
    { attempt_id: producers[0].attemptId, marker_sha256: first.verification_marker_sha256, size_bytes: 1_024 },
    { attempt_id: producers[1].attemptId, marker_sha256: optional.verification_marker_sha256, size_bytes: 4_096 },
    { attempt_id: producers[2].attemptId, marker_sha256: second.verification_marker_sha256, size_bytes: 2_048 }
  ]);

  const restartedRows = new Map([...durableRows].map(([nodeId, output]) => [nodeId, structuredClone(output)] as const));
  assert.deepEqual(
    derive(task, (producer) => restartedRows.get(producer.verifierId)),
    completeHandoff,
    "a fresh render process must reproduce the authority array from durable outputs"
  );

  restartedRows.delete(producers[2].verifierId);
  assert.equal(
    derive(task, (producer) => restartedRows.get(producer.verifierId)),
    undefined,
    "an absent required fanout verifier must suppress the cloud handoff"
  );

  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /ctx\.outputMaybe\(outputs\.verification, \{ nodeId: producer\.verifierId \}\)/u);
  assert.match(source, /if \(dependencyVerificationAuthorities === undefined\) return null/u);
  assert.match(source, /dependency_verification_authorities: dependencyVerificationAuthorities/u);
  assert.match(source, /schema_version: "ultrafuzz\.modal\.node\.v2"/u);
});

test("Smithers rerenders a cloud Sandbox only after its required verifier output is persisted", async () => {
  type ModalAuthorityInput = {
    schema_version: "ultrafuzz.modal.node.v2";
    dependency_verification_authorities: Array<{
      attempt_id: string;
      marker_sha256: string;
      size_bytes: number;
    }>;
  };
  type EngineTask = { nodeId: string; meta?: Record<string, unknown> };
  type EngineTestWorkflow = { tasks: EngineTask[] };
  type EngineSimulation = {
    run(): Promise<unknown>;
    status: string;
    executed: string[];
    outputs: Record<string, unknown[]>;
  };
  const derive = loadDependencyVerificationAuthoritiesForTask();
  const producer = {
    attemptId: "required-producer__model_0__attempt_0",
    verifierId: "verify:required-producer__model_0__attempt_0",
    optional: false
  } as const;
  const marker = {
    verification_marker_sha256: "d".repeat(64),
    verification_marker_size_bytes: 12_345
  } as const;
  const expectedSandboxInput: ModalAuthorityInput = {
    schema_version: "ultrafuzz.modal.node.v2",
    dependency_verification_authorities: [
      {
        attempt_id: producer.attemptId,
        marker_sha256: marker.verification_marker_sha256,
        size_bytes: marker.verification_marker_size_bytes
      }
    ]
  };

  const require = createRequire(import.meta.url);
  const testing = (await import(pathToFileURL(require.resolve("smthrs/testing")).href)) as {
    renderWorkflow(
      workflow: unknown,
      options?: { runId?: string; outputs?: Record<string, unknown[]> }
    ): Promise<EngineTestWorkflow>;
    simulate(workflow: unknown, options?: { mocks?: Record<string, unknown> }): EngineSimulation;
  };
  const smithersRoot = packageRootForEntry(require.resolve("smthrs"));
  const smithersRequire = createRequire(path.join(smithersRoot, "package.json"));
  const React = smithersRequire("react") as {
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
  };
  const components = (await import(pathToFileURL(smithersRequire.resolve("@smthrs/components")).href)) as {
    Workflow: unknown;
    Task: unknown;
    Sandbox: unknown;
  };
  const verificationSchema = z.strictObject({
    verification_marker_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    verification_marker_size_bytes: z.number().int().positive()
  });
  const sandboxResultSchema = z.strictObject({ summary: z.string() });
  const renderedSandboxInputs: Array<ModalAuthorityInput | undefined> = [];
  const workflow = {
    opts: {},
    schemaRegistry: new Map([
      ["verification", { table: { name: "verification" }, zodSchema: verificationSchema }],
      ["sandbox_result", { table: { name: "sandbox_result" }, zodSchema: sandboxResultSchema }]
    ]),
    build: (ctx: {
      outputMaybe(output: string, key: { nodeId: string }): GeneratedVerificationAuthorityOutput | undefined;
    }) => {
      const authorities = derive({ dependencyVerificationProducers: [producer] }, (candidate) =>
        ctx.outputMaybe("verification", { nodeId: candidate.verifierId })
      );
      const sandboxInput =
        authorities === undefined
          ? undefined
          : {
              schema_version: "ultrafuzz.modal.node.v2" as const,
              dependency_verification_authorities: authorities
            };
      renderedSandboxInputs.push(sandboxInput === undefined ? undefined : structuredClone(sandboxInput));
      return React.createElement(
        components.Workflow,
        { name: "verification-authority-rerender" },
        React.createElement(components.Task, { id: producer.verifierId, output: "verification" }, marker),
        sandboxInput === undefined
          ? null
          : React.createElement(components.Sandbox, {
              id: "cloud-consumer",
              output: "sandbox_result",
              provider: { id: "modal-test-provider" },
              input: sandboxInput,
              meta: { executionMode: "cloud" }
            })
      );
    }
  };

  const beforeVerification = await testing.renderWorkflow(workflow, { runId: "authority-rerender" });
  assert.deepEqual(
    beforeVerification.tasks.map((task) => task.nodeId),
    [producer.verifierId],
    "the cloud Sandbox must not exist before its required verifier row"
  );

  renderedSandboxInputs.length = 0;
  const simulation = testing.simulate(workflow, {
    mocks: { "cloud-consumer": { summary: "cloud handoff accepted" } }
  });
  await simulation.run();
  assert.equal(simulation.status, "finished");
  assert.deepEqual(simulation.executed, [producer.verifierId, "cloud-consumer"]);
  assert.deepEqual(simulation.outputs.verification, [marker]);
  assert.equal(renderedSandboxInputs[0], undefined, "the scheduler's initial frame must omit the Sandbox");
  assert.ok(renderedSandboxInputs.length > 1, "persisting verifier output must trigger a rerender");
  for (const input of renderedSandboxInputs.slice(1)) {
    assert.deepEqual(input, expectedSandboxInput);
  }

  const persistedOutputs = {
    verification: [
      {
        runId: "authority-rerender",
        nodeId: producer.verifierId,
        iteration: 0,
        ...marker
      }
    ]
  };
  const afterVerification = await testing.renderWorkflow(workflow, {
    runId: "authority-rerender",
    outputs: persistedOutputs
  });
  const cloudTask = afterVerification.tasks.find((task) => task.nodeId === "cloud-consumer");
  assert.ok(cloudTask, "the persisted verifier row must mount the cloud Sandbox without workflow sync");
  assert.deepEqual(cloudTask.meta?.__sandboxInput, expectedSandboxInput);

  const restarted = await testing.renderWorkflow(workflow, {
    runId: "authority-rerender",
    outputs: structuredClone(persistedOutputs)
  });
  const restartedCloudTask = restarted.tasks.find((task) => task.nodeId === "cloud-consumer");
  assert.ok(restartedCloudTask, "a fresh renderer must recover the Sandbox solely from durable verifier rows");
  assert.deepEqual(restartedCloudTask.meta?.__sandboxInput, expectedSandboxInput);
  assert.deepEqual(restartedCloudTask.meta?.__sandboxInput, cloudTask.meta?.__sandboxInput);
});

test("generated Smithers workflow quarantines optional tasks and reads only verified optional ancestors", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const taskProjectionStart = source.indexOf("function hydrateTaskSpec");
  const taskProjectionEnd = source.indexOf("\n\ntype AuthenticatedAggregationSourceEntry", taskProjectionStart);
  const baseAgentStart = source.indexOf("function baseAgentForProfile");
  const baseAgentEnd = source.indexOf("\n\nfunction agentForTask", baseAgentStart);
  const ancestorStart = source.indexOf("function declaredAncestorContractOutputs");
  const ancestorEnd = source.indexOf("\n\nfunction verifiedSingletonAncestorJsonArtifact", ancestorStart);
  const optionalStart = source.indexOf("function optionalDependencyIsUnavailable");
  const optionalEnd = source.indexOf("\n\nfunction assertVerifiedDependency", optionalStart);
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(taskProjectionStart >= 0 && taskProjectionEnd > taskProjectionStart, source);
  assert.ok(baseAgentStart >= 0 && baseAgentEnd > baseAgentStart, source);
  assert.ok(ancestorStart >= 0 && ancestorEnd > ancestorStart, source);
  assert.ok(optionalStart >= 0 && optionalEnd > optionalStart, source);
  const taskProjection = source.slice(taskProjectionStart, taskProjectionEnd);
  const baseAgent = source.slice(baseAgentStart, baseAgentEnd);
  const ancestor = source.slice(ancestorStart, ancestorEnd);
  const optional = source.slice(optionalStart, optionalEnd);
  const workflow = source.slice(workflowStart);

  assert.match(ancestor, /admittedDependencyArtifactDirs\(task\)/u);
  assert.match(ancestor, /admittedDirectories\.has\(path\.resolve\(output\.artifactDir\)\)/u);
  assert.match(optional, /optionalDependencyArtifactDirs/u);
  assert.match(optional, /artifactVerificationMarkerLocation/u);
  assert.match(optional, /pathEntryExists\(marker\.path\)/u);
  assert.match(optional, /const dependencyArtifactAdmissionsByTask/u);
  assert.match(optional, /function selectDependencyArtifactDirs/u);
  assert.match(optional, /function dependencyArtifactAdmission/u);
  assert.match(optional, /function admittedDependencyArtifactDirs/u);
  assert.match(optional, /function assertDependencyArtifactAdmissionCurrent/u);
  assert.match(optional, /task\.dependencyArtifactDirs\.filter/u);
  assert.match(optional, /dependencyArtifactAdmissionsByTask\.get\(task\.attemptId\)/u);
  assert.match(
    source,
    /preflightJsonValidator\(schemaDirectory\)[\s\S]{0,120}?assertTaskInputs\(task, workspaceRoot\)/u
  );
  assert.match(
    source,
    /materializeWorkspacePatchDependencies[\s\S]*?assertDependencyArtifactAdmissionCurrent\(task\)/u
  );
  assert.match(
    source,
    /assertDependencyArtifactAdmissionCurrent\(task\);\s*const admitted = baseAgentForProfile\(task, profile, admittedDependencyArtifactDirs\(task\)\)/u
  );
  assert.match(taskProjection, /const dependencyArtifactRelativeDirs = \[\.\.\.task\.dependencyArtifactDirs\]/u);
  assert.match(
    taskProjection,
    /dependencyArtifactDirs: task\.dependencyArtifactDirs\.map\(\(directory\) =>\s*path\.resolve\(process\.cwd\(\), directory\)/u
  );
  assert.match(
    taskProjection,
    /const optionalDependencyArtifactRelativeDirs = \[\.\.\.task\.optionalDependencyArtifactDirs\]/u
  );
  assert.match(
    taskProjection,
    /optionalDependencyArtifactDirs: task\.optionalDependencyArtifactDirs\.map\(\(directory\) =>\s*path\.resolve\(process\.cwd\(\), directory\)/u
  );
  assert.match(baseAgent, /addDir: \[task\.artifactDir, \.\.\.dependencyArtifactDirs\]/u);
  assert.doesNotMatch(baseAgent, /taskManifestPath|executionSnapshotRoot|path\.dirname|controls/u);
  assert.doesNotMatch(source, /addDir:\s*\[task\.artifactDir, \.\.\.task\.dependencyArtifactDirs\]/u);
  assert.match(workflow, /dependency_artifact_dirs: task\.dependencyArtifactRelativeDirs/u);
  assert.match(workflow, /optional_dependency_artifact_dirs: task\.optionalDependencyArtifactRelativeDirs/u);
  assert.doesNotMatch(workflow, /optional_dependency_artifact_dirs: task\.optionalDependencyArtifactDirs/u);
  assert.match(workflow, /continueOnFail=\{task\.continueOnFail\}/u);
  assert.equal(workflow.match(/continueOnFail=\{task\.continueOnFail\}/gu)?.length, 5);
});

test("generated optional admission rejects a present malformed marker before publishing agent access", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const admissionStart = source.indexOf("function assertTaskInputs");
  const admissionEnd = source.indexOf("\n\nfunction assertVerifiedDependency", admissionStart);
  const baseAgentStart = source.indexOf("function baseAgentForProfile");
  const baseAgentEnd = source.indexOf("\n\nfunction agentForTask", baseAgentStart);
  assert.ok(admissionStart >= 0 && admissionEnd > admissionStart, source);
  assert.ok(baseAgentStart >= 0 && baseAgentEnd > baseAgentStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(admissionStart, admissionEnd)}\n${source.slice(baseAgentStart, baseAgentEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;

  const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-optional-admission-")));
  try {
    const producerAttemptId = "optional-producer";
    const producerDir = path.join(runRoot, "artifacts", producerAttemptId);
    const markerPath = path.join(runRoot, ".ultrafuzz-verification", `${producerAttemptId}.json`);
    fs.mkdirSync(producerDir, { recursive: true });
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "{malformed-json\n", "utf8");
    const producer = { attemptId: producerAttemptId, artifactDir: producerDir };
    const consumer = {
      attemptId: "optional-consumer",
      runRoot,
      artifactDir: path.join(runRoot, "artifacts", "optional-consumer"),
      dependencyArtifactDirs: [producerDir],
      optionalDependencyArtifactDirs: [producerDir]
    };
    let dependencyAuthenticationCount = 0;
    const factoryAddDirs: string[][] = [];
    const harness = new Function(
      "path",
      "assertRegularFileInside",
      "authenticatedAggregationSourcesByTask",
      "artifactVerificationMarkerLocation",
      "pathEntryExists",
      "taskSpecs",
      "lstatSync",
      "realpathSync",
      "isStrictlyInsideDirectory",
      "assertVerifiedDependency",
      "sameImmutableFileIdentity",
      "agentFactories",
      `${emitted}; return {
        prepareAndBuild(task, workspaceRoot, profile) {
          assertTaskInputs(task, workspaceRoot);
          assertDependencyArtifactAdmissionCurrent(task);
          return baseAgentForProfile(task, profile, admittedDependencyArtifactDirs(task));
        },
        buildFromPublishedAdmission(task, profile) {
          return baseAgentForProfile(task, profile, admittedDependencyArtifactDirs(task));
        },
        hasAdmission(attemptId) {
          return dependencyArtifactAdmissionsByTask.has(attemptId);
        }
      };`
    )(
      path,
      () => undefined,
      new Map(),
      (_runRoot: string, attemptId: string) => ({
        path: path.join(runRoot, ".ultrafuzz-verification", `${attemptId}.json`)
      }),
      (candidate: string) => fs.existsSync(candidate),
      [producer, consumer],
      fs.lstatSync,
      fs.realpathSync,
      (root: string, candidate: string) => {
        const relative = path.relative(root, candidate);
        return (
          relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      },
      () => {
        dependencyAuthenticationCount += 1;
        assert.equal(fs.readFileSync(markerPath, "utf8"), "{malformed-json\n");
        throw new Error(`artifact-contract failure: verification marker is schema-invalid ${producerAttemptId}`);
      },
      () => true,
      {
        codex: (options: { addDir?: string[] }) => {
          factoryAddDirs.push([...(options.addDir ?? [])]);
          return { generate: async () => ({}) };
        }
      }
    ) as {
      prepareAndBuild(task: typeof consumer, workspaceRoot: string, profile: { agentRef: string }): unknown;
      buildFromPublishedAdmission(task: typeof consumer, profile: { agentRef: string }): unknown;
      hasAdmission(attemptId: string): boolean;
    };

    assert.throws(
      () => harness.prepareAndBuild(consumer, runRoot, { agentRef: "codex" }),
      /verification marker is schema-invalid optional-producer/u
    );
    assert.equal(dependencyAuthenticationCount, 1, "a present optional marker must be authenticated");
    assert.equal(harness.hasAdmission(consumer.attemptId), false, "failed authentication must not publish admission");
    assert.throws(
      () => harness.buildFromPublishedAdmission(consumer, { agentRef: "codex" }),
      /dependency admission is unavailable optional-consumer/u
    );
    assert.deepEqual(factoryAddDirs, [], "the malformed optional directory must never reach addDir");
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }

  assert.match(
    source,
    /admitted_dependency_attempt_ids:\s*admittedDependencyArtifactDirs\(task\)\.map\(\(directory\) => path\.basename\(directory\)\)/u
  );
});

test("rerenders retain one dependency admission epoch and fresh modules reauthenticate", async () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const workflowSource = source.slice(source.indexOf("export default smithers"));
  assert.equal(
    workflowSource.match(/taskSpecs = reconcileTaskSpecIdentities\(/gu)?.length,
    2,
    "dynamic controller and cloud-worker rerenders must both retain stable task identities"
  );
  const reconciliationStart = source.indexOf("function reconcileTaskSpecIdentities");
  const reconciliationEnd = source.indexOf("\n\nconst INVARIANT_CAMPAIGN_RUNTIME_CONTRACTS", reconciliationStart);
  const admissionStart = source.indexOf("function assertTaskInputs");
  const admissionEnd = source.indexOf("\n\nfunction assertVerifiedDependency", admissionStart);
  const agentStart = source.indexOf("function baseAgentForProfile");
  const agentEnd = source.indexOf("\n\nfunction artifactAwareAgent", agentStart);
  assert.ok(reconciliationStart >= 0 && reconciliationEnd > reconciliationStart, source);
  assert.ok(admissionStart >= 0 && admissionEnd > admissionStart, source);
  assert.ok(agentStart >= 0 && agentEnd > agentStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(reconciliationStart, reconciliationEnd)}
${source.slice(admissionStart, admissionEnd)}
${source.slice(agentStart, agentEnd)}
function prepareArtifactMirror(task: (typeof taskSpecs)[number]): void {
  counters.preparations += 1;
  assertTaskInputs(task, task.workspacePath);
}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;

  const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-rerender-admission-")));
  try {
    const producerAttemptId = "dependency-producer";
    const producerDir = path.join(runRoot, "artifacts", producerAttemptId);
    const consumerDir = path.join(runRoot, "artifacts", "dependency-consumer");
    fs.mkdirSync(producerDir, { recursive: true });
    fs.mkdirSync(consumerDir, { recursive: true });
    const markerBytes = Buffer.from("verified-marker\n", "utf8");
    const artifactBytes = Buffer.from("authenticated-artifact\n", "utf8");
    const artifactIdentity = Object.freeze({
      dev: 1n,
      ino: 2n,
      size: BigInt(artifactBytes.length),
      mtimeNs: 3n,
      ctimeNs: 4n
    });
    const markerIdentity = Object.freeze({
      dev: 1n,
      ino: 5n,
      size: BigInt(markerBytes.length),
      mtimeNs: 6n,
      ctimeNs: 7n
    });
    const makeTaskSpecs = () => {
      const producer = { attemptId: producerAttemptId, artifactDir: producerDir };
      const consumer = {
        attemptId: "dependency-consumer",
        runRoot,
        workspacePath: runRoot,
        artifactDir: consumerDir,
        promptPath: undefined,
        dependencyArtifactDirs: [producerDir],
        optionalDependencyArtifactDirs: [],
        agentChain: [{ agentRef: "test-agent" }]
      };
      return { producer, consumer, taskSpecs: [producer, consumer] };
    };
    const loadRenderModule = (taskSpecs: ReturnType<typeof makeTaskSpecs>["taskSpecs"]) => {
      const counters = { authentications: 0, preparations: 0, replaceArtifact: false };
      const factoryAddDirs: string[][] = [];
      const module = new Function(
        "path",
        "Buffer",
        "isDeepStrictEqual",
        "taskSpecs",
        "counters",
        "assertRegularFileInside",
        "authenticatedAggregationSourcesByTask",
        "artifactVerificationMarkerLocation",
        "pathEntryExists",
        "lstatSync",
        "realpathSync",
        "isStrictlyInsideDirectory",
        "assertVerifiedDependency",
        "sameImmutableFileIdentity",
        "agentFactories",
        "assertGovernedWorkspaceSource",
        "artifactAwareAgent",
        `${emitted}; return {
          prepare(task) {
            prepareArtifactMirror(task);
          },
          agent(task) {
            return agentForTask(task, "prompt");
          },
          rerender(candidates) {
            taskSpecs = reconcileTaskSpecIdentities(taskSpecs, candidates);
            return taskSpecs;
          }
        };`
      )(
        path,
        Buffer,
        isDeepStrictEqual,
        taskSpecs,
        counters,
        () => undefined,
        new Map(),
        () => undefined,
        () => false,
        fs.lstatSync,
        fs.realpathSync,
        (root: string, candidate: string) => {
          const relative = path.relative(root, candidate);
          return (
            relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          );
        },
        (_task: unknown, artifactDir: string) => {
          counters.authentications += 1;
          const currentArtifactBytes = counters.replaceArtifact
            ? Buffer.from("replacement-artifact\n", "utf8")
            : artifactBytes;
          const currentArtifactIdentity = counters.replaceArtifact
            ? Object.freeze({ ...artifactIdentity, ino: 8n, size: BigInt(currentArtifactBytes.length) })
            : artifactIdentity;
          return {
            attemptId: producerAttemptId,
            artifactDir,
            marker: {
              path: path.join(runRoot, ".ultrafuzz-verification", `${producerAttemptId}.json`),
              bytes: markerBytes,
              identity: markerIdentity
            },
            artifacts: new Map([
              [
                "result.json",
                {
                  path: path.join(producerDir, "result.json"),
                  relativePath: "result.json",
                  contract: "ultrafuzz/test@1",
                  bytes: currentArtifactBytes,
                  identity: currentArtifactIdentity
                }
              ]
            ]),
            publications: new Map([["result.json", createHash("sha256").update(currentArtifactBytes).digest("hex")]]),
            generatedTestBundles: []
          };
        },
        (left: unknown, right: unknown) => isDeepStrictEqual(left, right),
        {
          "test-agent": (options: { addDir?: string[] }) => {
            factoryAddDirs.push([...(options.addDir ?? [])]);
            return {
              preflight: async () => undefined,
              generate: async () => ({ summary: "ok" })
            };
          }
        },
        () => undefined,
        (
          _task: unknown,
          _chainIndex: number,
          _prompt: string,
          _metadataAgent: unknown,
          admittedAgent: () => { preflight?: (args: unknown) => Promise<unknown> }
        ) => ({
          preflight: async (args: unknown) => admittedAgent().preflight?.(args),
          generate: async () => ({ summary: "ok" })
        })
      ) as {
        prepare(task: ReturnType<typeof makeTaskSpecs>["consumer"]): void;
        agent(task: ReturnType<typeof makeTaskSpecs>["consumer"]): {
          preflight?(args: unknown): Promise<unknown>;
        };
        rerender(
          candidates: ReturnType<typeof makeTaskSpecs>["taskSpecs"]
        ): ReturnType<typeof makeTaskSpecs>["taskSpecs"];
      };
      return { counters, factoryAddDirs, module };
    };

    const firstRenderTasks = makeTaskSpecs();
    const firstRender = loadRenderModule(firstRenderTasks.taskSpecs);
    firstRender.module.prepare(firstRenderTasks.consumer);
    assert.equal(firstRender.counters.preparations, 1);
    assert.equal(firstRender.counters.authentications, 1);

    // Dynamic and cloud-worker materialization construct equivalent task
    // objects on every frame. Reconciliation must retain the object carrying
    // the exact prepared snapshot epoch.
    const rerenderTasks = makeTaskSpecs();
    const reconciledTasks = firstRender.module.rerender(rerenderTasks.taskSpecs);
    const reconciledConsumer = reconciledTasks.find(
      (task) => task.attemptId === firstRenderTasks.consumer.attemptId
    ) as typeof firstRenderTasks.consumer | undefined;
    assert.equal(reconciledConsumer, firstRenderTasks.consumer);
    const rehydratedAgent = firstRender.module.agent(reconciledConsumer!);
    assert.ok(rehydratedAgent.preflight);
    await rehydratedAgent.preflight({});
    assert.equal(firstRender.counters.preparations, 1, "an ordinary rerender must not replace the prepared epoch");
    assert.ok(firstRender.counters.authentications >= 2, "preflight must recheck the admitted snapshot");
    assert.deepEqual(firstRender.factoryAddDirs, [[consumerDir], [consumerDir, producerDir]]);

    firstRender.counters.replaceArtifact = true;
    const replacementCheck = firstRender.module.agent(reconciledConsumer!);
    assert.ok(replacementCheck.preflight);
    await assert.rejects(
      replacementCheck.preflight({}),
      /dependency artifact changed after admission dependency-producer/u
    );
    assert.equal(firstRender.counters.preparations, 1, "replacement detection must retain the original epoch");
    firstRender.counters.replaceArtifact = false;

    const changedTasks = makeTaskSpecs();
    changedTasks.consumer.runRoot = path.join(runRoot, "changed-run-root");
    const changedRender = firstRender.module.rerender(changedTasks.taskSpecs);
    const changedConsumer = changedRender.find((task) => task.attemptId === changedTasks.consumer.attemptId) as
      typeof changedTasks.consumer | undefined;
    assert.notEqual(changedConsumer, firstRenderTasks.consumer);
    const changedAgent = firstRender.module.agent(changedConsumer!);
    assert.ok(changedAgent.preflight);
    await assert.rejects(changedAgent.preflight({}), /dependency admission is unavailable dependency-consumer/u);
    assert.equal(firstRender.counters.preparations, 1, "a semantic task change must fail closed");

    // A new generated-workflow module has neither the first module's Map nor
    // its task object identities, even though Smithers can retain the durable
    // prepare:* output and go directly to this task's preflight.
    const freshRenderTasks = makeTaskSpecs();
    const freshRender = loadRenderModule(freshRenderTasks.taskSpecs);
    assert.notEqual(freshRenderTasks.consumer, firstRenderTasks.consumer);
    const agent = freshRender.module.agent(freshRenderTasks.consumer);
    assert.ok(agent.preflight);
    await agent.preflight({});

    assert.equal(freshRender.counters.preparations, 1);
    assert.ok(freshRender.counters.authentications >= 2, "admission and currentness must both authenticate");
    assert.deepEqual(freshRender.factoryAddDirs, [[consumerDir], [consumerDir, producerDir]]);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("generated verifiers require the runtime-owned process marker before publishing artifacts", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts");
  const finalizerEnd = source.indexOf("\n\nfunction verifyArtifacts", finalizerStart);
  const workflow = source.slice(source.indexOf("export default smithers"));
  assert.ok(finalizerStart >= 0 && finalizerEnd > finalizerStart, source);
  const finalizer = source.slice(finalizerStart, finalizerEnd);

  assert.match(finalizer, /agentProcess: z\.infer<typeof agentProcessOutput> \| undefined/u);
  assert.match(finalizer, /agentProcessOutput\.safeParse\(agentProcess\)\.success/u);
  assert.ok(
    finalizer.indexOf("clearArtifactVerificationMarker(task)") < finalizer.indexOf("agentProcessOutput.safeParse")
  );
  assert.ok(finalizer.indexOf("agentProcessOutput.safeParse") < finalizer.indexOf("prepareArtifactMirror(task"));
  assert.equal(workflow.match(/needs=\{\{ agent: task\.id \}\}/gu)?.length, 2);
  assert.equal(workflow.match(/deps=\{\{ agent: outputs\.agentProcess \}\}/gu)?.length, 2);
  assert.equal(workflow.match(/depsOptional/gu)?.length, 2);
  assert.equal(workflow.match(/\{\(deps\) => finalizeAndVerifyArtifacts\(task, deps\.agent\)\}/gu)?.length, 2);
  assert.doesNotMatch(workflow, /\{\(\) => finalizeAndVerifyArtifacts\(task\)\}/u);
});

test("generated dependency admission retains one exact snapshot epoch and never hydrates a replacement patch pair", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const admissionStart = source.indexOf("type DependencyArtifactAdmission");
  const admissionEnd = source.indexOf("\n\nfunction assertVerifiedDependency", admissionStart);
  const hydrationStart = source.indexOf("function materializeWorkspacePatchDependencies");
  const hydrationEnd = source.indexOf("\n\nfunction workspacePatchBaselinePath", hydrationStart);
  assert.ok(admissionStart >= 0 && admissionEnd > admissionStart, source);
  assert.ok(hydrationStart >= 0 && hydrationEnd > hydrationStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(admissionStart, admissionEnd)}\n${source.slice(hydrationStart, hydrationEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;

  const producerDir = "/run/artifacts/patch-producer";
  const producer = { attemptId: "patch-producer", artifactDir: producerDir };
  const consumer = {
    attemptId: "patch-consumer",
    dependencyArtifactDirs: [producerDir],
    optionalDependencyArtifactDirs: [],
    productionSourceRoots: ["src"]
  };
  const identity = (inode: bigint) => ({
    dev: 9_007_199_254_740_992n,
    ino: inode,
    size: 64n,
    mtimeNs: inode + 10n,
    ctimeNs: inode + 20n
  });
  const snapshot = (generation: "A" | "B", inode: bigint) => {
    const patchBytes = Buffer.from(`valid-patch-${generation}\n`, "utf8");
    const manifestValue = { base_tree: `${generation}0`, result_tree: `${generation}1` };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`, "utf8");
    return {
      attemptId: producer.attemptId,
      artifactDir: producerDir,
      marker: {
        path: "/run/.ultrafuzz-verification/patch-producer.json",
        bytes: Buffer.from(`valid-marker-${generation}\n`, "utf8"),
        identity: identity(inode)
      },
      artifacts: new Map([
        [
          "workspace.patch",
          {
            path: `${producerDir}/workspace.patch`,
            relativePath: "workspace.patch",
            contract: "ultrafuzz/text@1",
            bytes: patchBytes,
            identity: identity(inode + 1n),
            value: patchBytes.toString("utf8")
          }
        ],
        [
          "workspace-patch.json",
          {
            path: `${producerDir}/workspace-patch.json`,
            relativePath: "workspace-patch.json",
            contract: "ultrafuzz/workspace-patch@1",
            bytes: manifestBytes,
            identity: identity(inode + 2n),
            value: manifestValue
          }
        ]
      ]),
      publications: new Map([
        ["workspace.patch", createHash("sha256").update(patchBytes).digest("hex")],
        ["workspace-patch.json", createHash("sha256").update(manifestBytes).digest("hex")]
      ]),
      generatedTestBundles: []
    };
  };
  const admittedA = snapshot("A", 9_007_199_254_740_993n);
  let current = admittedA;
  const applied: string[] = [];
  const validated: string[] = [];
  const preparationTrees = new Map<string, string>();
  const harness = new Function(
    "path",
    "taskSpecs",
    "artifactVerificationMarkerLocation",
    "pathEntryExists",
    "assertVerifiedDependency",
    "sameImmutableFileIdentity",
    "readWorkspacePatchPreparation",
    "workspacePatchPreparationTrees",
    "validateWorkspacePatchCapture",
    "captureWorkspaceTree",
    "firstDependencyRequiringReplay",
    "applyWorkspacePatch",
    "taskPublishesWorkspacePatch",
    "readWorkspacePatchBaseline",
    "workspacePatchBaselineTrees",
    "writeWorkspacePatchPreparation",
    "writeWorkspacePatchBaseline",
    `${emitted}; return {
      admit(task, directories, snapshotsByProducerAttempt) {
        dependencyArtifactAdmissionsByTask.set(task.attemptId, Object.freeze({
          task,
          directories: Object.freeze([...directories]),
          snapshotsByProducerAttempt
        }));
      },
      current: assertDependencyArtifactAdmissionCurrent,
      directories: admittedDependencyArtifactDirs,
      hydrate: materializeWorkspacePatchDependencies
    };`
  )(
    path,
    [producer, consumer],
    () => undefined,
    () => false,
    () => current,
    (left: Record<string, bigint>, right: Record<string, bigint>) =>
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs,
    (task: { attemptId: string }) => preparationTrees.get(task.attemptId),
    preparationTrees,
    (_root: string, capture: { patch: string }) => validated.push(capture.patch),
    () => "workspace-tree",
    () => 0,
    (_root: string, capture: { patch: string }) => applied.push(capture.patch),
    () => false,
    () => undefined,
    new Map(),
    () => undefined,
    () => undefined
  ) as {
    admit(task: typeof consumer, directories: string[], snapshots: Map<string, typeof admittedA>): void;
    current(task: typeof consumer): unknown;
    directories(task: typeof consumer): readonly string[];
    hydrate(task: typeof consumer, workspaceRoot: string, replay: boolean, evidence: "create" | "require"): void;
  };

  harness.admit(consumer, [producerDir], new Map([[producer.attemptId, admittedA]]));
  assert.deepEqual(harness.directories(consumer), [producerDir]);
  harness.hydrate(consumer, "/workspace", true, "create");
  assert.deepEqual(validated, ["valid-patch-A\n"]);
  assert.deepEqual(applied, ["valid-patch-A\n"]);

  current = snapshot("B", 9_007_199_254_741_100n);
  validated.length = 0;
  applied.length = 0;
  assert.throws(
    () => harness.hydrate(consumer, "/workspace", true, "create"),
    /dependency authority changed after admission patch-producer/u
  );
  assert.deepEqual(validated, [], "replacement B must fail before patch validation or hydration");
  assert.deepEqual(applied, [], "replacement B must never be applied");

  current = {
    ...admittedA,
    marker: { ...admittedA.marker, identity: identity(9_007_199_254_741_200n) }
  };
  assert.throws(
    () => harness.current(consumer),
    /dependency authority changed after admission patch-producer/u,
    "an identical-byte marker replacement must not inherit the admitted identity"
  );

  current = {
    ...admittedA,
    artifacts: new Map(admittedA.artifacts).set("workspace.patch", {
      ...admittedA.artifacts.get("workspace.patch")!,
      identity: identity(9_007_199_254_741_300n)
    })
  };
  assert.throws(
    () => harness.current(consumer),
    /dependency artifact changed after admission patch-producer\/workspace\.patch/u,
    "an identical-byte selected-output replacement must fail before model access"
  );

  const hydration = source.slice(hydrationStart, hydrationEnd);
  assert.match(hydration, /const admission = assertDependencyArtifactAdmissionCurrent\(task\)/u);
  assert.match(hydration, /authority\.artifacts\.get\("workspace\.patch"\)/u);
  assert.match(hydration, /patch: patch\.value/u);
  assert.doesNotMatch(hydration, /readBoundedRegularArtifactSnapshot|readFileSync|resolveRegularArtifactFile/u);
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

test("generated local and cloud prompt relocation rebases task-local authority paths without exposing controls", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const promptStart = source.indexOf("function promptForTask");
  const helperStart = source.indexOf("function relocatePromptPath");
  const helperEnd = source.indexOf("\n\nconst promptArtifactAuthoritySnapshotsByTask", helperStart);
  assert.ok(promptStart >= 0 && promptStart < helperStart, source);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const promptForTask = source.slice(promptStart, helperStart);
  assert.ok(
    promptForTask.indexOf("task.sourceProjectRoot, process.cwd()") <
      promptForTask.indexOf("task.artifactDir, mirroredArtifactDir(task)"),
    promptForTask
  );
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const relocatePromptPath = new Function(`${helper}; return relocatePromptPath;`)() as (
    prompt: string,
    sourcePath: string,
    destinationPath: string
  ) => string;

  const sourceRoot = "/tmp/controller-a's-`project";
  const localRoot = "/tmp/local-b's-`project";
  const cloudRoot = "/workspace/cloud-b's-`project";
  const sourceArtifactDir = `${sourceRoot}/.ultrafuzz/runs/run-1/artifacts/task-0`;
  const sourceWorkspace = `${sourceRoot}/.ultrafuzz/runs/run-1/workspaces/task-0`;
  const sourceAuthority = `${sourceWorkspace}/.ultrafuzz/authorities/task-0.json`;
  const sourceSchema = `${sourceWorkspace}/.ultrafuzz/schemas/findings.schema.json`;
  const encodedSourceRoot = sourceRoot.replaceAll("'", `'"'"'`);
  const commandSpan = (command: string): string => (command.includes("`") ? `\`\` ${command} \`\`` : `\`${command}\``);
  const rendered = [
    `- Path: \`${sourceArtifactDir}/findings.json\``,
    `- Artifact authority: \`${sourceAuthority}\``,
    `  Validate against: \`${sourceSchema}\``,
    `  Validation command: ${commandSpan(`ultrafuzz json validate --schema '${encodedSourceRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/.ultrafuzz/schemas/findings.schema.json' --file '${encodedSourceRoot}/.ultrafuzz/runs/run-1/artifacts/task-0/findings.json'`)}`,
    `  Contract validation command: ${commandSpan(`ultrafuzz artifact validate 'ultrafuzz/findings@2' '${encodedSourceRoot}/.ultrafuzz/runs/run-1/artifacts/task-0/findings.json'`)}`,
    `  Task-context validation command: ${commandSpan(`ultrafuzz artifact validate 'ultrafuzz/generated-tests@3' '${encodedSourceRoot}/.ultrafuzz/runs/run-1/artifacts/task-0/generated-tests.json' --run-id 'run-1' --logical-node-id 'task-logical' --artifact-root '${encodedSourceRoot}/.ultrafuzz/runs/run-1/artifacts/task-0'`)}`
  ].join("\n");
  assert.doesNotMatch(rendered, /tasks\.json|execution-snapshots|\/controls\//u);

  for (const [label, destinationRoot] of [
    ["local", localRoot],
    ["cloud", cloudRoot]
  ] as const) {
    const destinationArtifactDir = `${destinationRoot}/.ultrafuzz/runs/run-1/artifacts/task-0`;
    const mirroredTaskArtifactDir = `${destinationRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/artifacts/task-0`;
    const expectedAuthority = `${destinationRoot}/.ultrafuzz/runs/run-1/workspaces/task-0/.ultrafuzz/authorities/task-0.json`;
    let relocated = relocatePromptPath(rendered, sourceRoot, destinationRoot);
    relocated = relocatePromptPath(relocated, destinationArtifactDir, mirroredTaskArtifactDir);
    const encodedDestinationRoot = destinationRoot.replaceAll("'", `'"'"'`);
    const encodedExpectedArtifactDir = mirroredTaskArtifactDir.replaceAll("'", `'"'"'`);

    assert.ok(relocated.includes(mirroredTaskArtifactDir), `${label}: ${relocated}`);
    assert.ok(relocated.includes(expectedAuthority), `${label}: ${relocated}`);
    assert.equal(relocated.includes(sourceRoot), false, label);
    assert.doesNotMatch(relocated, /tasks\.json|execution-snapshots|\/controls\//u);
    assert.ok(
      relocated.includes(`--schema '${encodedDestinationRoot}/.ultrafuzz/runs/run-1/workspaces/task-0`),
      `${label}: ${relocated}`
    );
    assert.ok(relocated.includes(`--file '${encodedExpectedArtifactDir}/findings.json'`), `${label}: ${relocated}`);
    assert.ok(
      relocated.includes(
        `ultrafuzz artifact validate 'ultrafuzz/findings@2' '${encodedExpectedArtifactDir}/findings.json'`
      ),
      `${label}: ${relocated}`
    );
    assert.ok(
      relocated.includes(
        `ultrafuzz artifact validate 'ultrafuzz/generated-tests@3' '${encodedExpectedArtifactDir}/generated-tests.json' --run-id 'run-1' --logical-node-id 'task-logical' --artifact-root '${encodedExpectedArtifactDir}'`
      ),
      `${label}: ${relocated}`
    );
    assert.equal(relocated.includes(encodedSourceRoot), false, `${label}: stale encoded controller root`);
    assert.equal(
      relocated.includes(`'${encodedDestinationRoot}/.ultrafuzz/runs/run-1/artifacts`),
      false,
      `${label}: stale canonical artifact root`
    );
  }
});

test("generated prompt authority is derived from sealed controls immediately before each first generation", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const runtimeImportStart = source.indexOf("const {", source.indexOf("await import(artifactsModule)"));
  const runtimeImportEnd = source.indexOf("} = await import(runtimeModule);", runtimeImportStart);
  const authorityStart = source.indexOf("const promptArtifactAuthoritySnapshotsByTask");
  const authorityEnd = source.indexOf("\n\nfunction verifiedDependencyJsonArtifact", authorityStart);
  const agentStart = source.indexOf("function artifactAwareAgent");
  const agentEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", agentStart);
  const resetStart = source.indexOf("function resetTaskArtifactsForRetry");
  const resetEnd = source.indexOf("\n\nfunction resetTaskArtifactContents", resetStart);
  assert.ok(runtimeImportStart >= 0 && runtimeImportEnd > runtimeImportStart, source);
  assert.ok(authorityStart >= 0 && authorityEnd > authorityStart, source);
  assert.ok(agentStart >= 0 && agentEnd > agentStart, source);
  assert.ok(resetStart >= 0 && resetEnd > resetStart, source);
  const runtimeImport = source.slice(runtimeImportStart, runtimeImportEnd);
  const authority = source.slice(authorityStart, authorityEnd);
  const agent = source.slice(agentStart, agentEnd);
  const reset = source.slice(resetStart, resetEnd);

  for (const runtimeHelper of [
    "derivePromptArtifactAuthority",
    "parsePromptArtifactAuthorityBytes",
    "serializePromptArtifactAuthority"
  ]) {
    assert.match(runtimeImport, new RegExp(`\\b${runtimeHelper}\\b`, "u"));
  }
  assert.match(authority, /PROMPT_ARTIFACT_AUTHORITY_DIRECTORY, `\$\{task\.attemptId\}\.json`/u);
  assert.match(authority, /const manifestPath = path\.resolve\(task\.taskManifestPath\)/u);
  assert.match(
    authority,
    /readBoundedRegularArtifactSnapshot\([\s\S]*?manifestPath[\s\S]*?MAX_SEALED_TASK_MANIFEST_BYTES[\s\S]*?true/u
  );
  assert.match(
    authority,
    /const admission = assertDependencyArtifactAdmissionCurrent\(task\);[\s\S]*?derivePromptArtifactAuthority\(\{[\s\S]*?sealedTaskManifestBytes: manifest\.bytes,[\s\S]*?currentAttemptId: task\.attemptId,[\s\S]*?relocatedRunRoot: realpathSync\(task\.runRoot\),[\s\S]*?admittedDependencyArtifactDirs: admission\.directories,[\s\S]*?selectors[\s\S]*?\}\)/u
  );
  assert.match(
    authority,
    /const expected = serializePromptArtifactAuthority\(authority\);[\s\S]*?prepareTaskLocalAuthorityPath\(workspaceRoot, promptArtifactAuthorityRelativePath\(task\)\)[\s\S]*?writeFileDurable\(authorityPath, expected\)/u
  );
  assert.match(authority, /writeFileDurable\(authorityPath, expected\)/u);
  assert.match(authority, /parsePromptArtifactAuthorityBytes\(captured\.bytes\)/u);
  assert.match(authority, /captured\.bytes\.equals\(expected\)/u);
  assert.match(authority, /sameImmutableFileIdentity\(captured\.identity, expected\.identity\)/u);
  assert.match(authority, /captured\.bytes\.equals\(expected\.bytes\)/u);
  assert.doesNotMatch(authority, /task\.metadata|task\.modelName|task\.workspacePath\s*[,}]/u);

  assert.match(
    reset,
    /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, evidenceMode: "require" \}\);\s*materializePromptArtifactAuthority\(task\);\s*materializeFinalReportRunMetadataAuthority\(task\);\s*\}/u
  );
  assert.ok(
    agent.indexOf("resetTaskArtifactsForRetry(task)") < agent.indexOf("executionAgent.generate(unstructuredArgs)")
  );
  assert.match(agent, /if \(firstGenerationForAttempt\)[\s\S]*?resetTaskArtifactsForRetry\(task\)/u);
  assert.match(
    agent,
    /else \{\s*assertPromptArtifactAuthorityUnchanged\(task\);\s*assertFinalReportRunMetadataAuthorityUnchanged\(task\);\s*assertFinalReportPromptAuthorityUnchanged\(task\);\s*\}/u
  );
  assert.match(
    agent,
    /assertDependencyArtifactAdmissionCurrent\(task\);[\s\S]*?Reflect\.deleteProperty\(unstructuredArgs, "outputSchema"\);\s*const result = await executionAgent\.generate\(unstructuredArgs\);\s*assertDependencyArtifactAdmissionCurrent\(task\);\s*assertPromptArtifactAuthorityUnchanged\(task\);\s*assertFinalReportRunMetadataAuthorityUnchanged\(task\);\s*assertFinalReportPromptAuthorityUnchanged\(task\);[\s\S]*?_output: \{ completed: true \}/u
  );
  assert.match(
    agent,
    /catch \(error\) \{\s*try \{\s*assertDependencyArtifactAdmissionCurrent\(task\);\s*assertPromptArtifactAuthorityUnchanged\(task\)/u
  );
  assert.equal(source.match(/materializePromptArtifactAuthority\(task\);/gu)?.length, 1);
});

test("generated immutable file identities preserve bigint device, inode, size, and nanosecond precision", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const identityStart = source.indexOf("type ImmutableFileIdentity");
  const comparatorStart = source.indexOf("function sameImmutableFileIdentity", identityStart);
  const comparatorEnd = source.indexOf("\n\nfunction decodeStrictUtf8Snapshot", comparatorStart);
  assert.ok(identityStart >= 0 && comparatorStart > identityStart && comparatorEnd > comparatorStart, source);
  const emitted = ts.transpileModule(source.slice(comparatorStart, comparatorEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sameIdentity = new Function(`${emitted}; return sameImmutableFileIdentity;`)() as (
    left: Record<string, bigint>,
    right: Record<string, bigint>
  ) => boolean;
  const base = {
    dev: 9_007_199_254_740_992n,
    ino: 9_007_199_254_740_993n,
    size: 9_007_199_254_740_994n,
    mtimeNs: 9_007_199_254_740_995n,
    ctimeNs: 9_007_199_254_740_996n
  };

  assert.equal(sameIdentity(base, { ...base }), true);
  assert.equal(
    sameIdentity(base, { ...base, ino: 9_007_199_254_740_992n }),
    false,
    "values that collapse to the same IEEE-754 number must remain distinguishable"
  );
  assert.match(source.slice(identityStart, comparatorEnd), /dev: bigint[\s\S]*ino: bigint[\s\S]*size: bigint/u);
  assert.match(source, /statSync\(resolvedPath, \{ bigint: true \}\)/u);
  assert.match(source, /before\.mtimeNs !== after\.mtimeNs/u);
  assert.match(source, /before\.ctimeNs !== after\.ctimeNs/u);
  assert.match(source, /BigInt\(bytes\.length\) !== after\.size/u);
});

test("generated task-local prompt authority is minimized, tamper-evident, and restored for retries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-prompt-authority-"));
  try {
    const controllerRunRoot = path.join(root, "controller-host-private", ".ultrafuzz", "runs", "run-1");
    const relocatedRunRoot = path.join(root, "execution-b", ".ultrafuzz", "runs", "run-1");
    const workspacePath = path.join(relocatedRunRoot, "workspaces", "consumer");
    const requiredDir = path.join(relocatedRunRoot, "artifacts", "required-producer");
    const optionalDir = path.join(relocatedRunRoot, "artifacts", "optional-producer");
    const controlsDir = path.join(root, "sealed-snapshot", "controls");
    const taskManifestPath = path.join(controlsDir, "tasks.json");
    for (const directory of [workspacePath, requiredDir, optionalDir, controlsDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const selectors: PromptArtifactAuthoritySelector[] = [
      { kind: "contract", contract: "ultrafuzz/generated-tests@3" },
      {
        kind: "path",
        id: promptArtifactAuthorityPathSelectorId(["findings.json"]),
        paths: ["findings.json"]
      }
    ];
    const manifest = promptAuthorityManifestFixture(controllerRunRoot, selectors);
    const sealedManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileDurable(taskManifestPath, sealedManifestBytes);
    const task: GeneratedPromptArtifactAuthorityTask & { agentChain: [Record<string, never>] } = {
      attemptId: "consumer",
      runRoot: relocatedRunRoot,
      taskManifestPath,
      workspacePath,
      promptArtifactAuthoritySelectors: selectors,
      agentChain: [{}]
    };
    const harness = loadGeneratedPromptArtifactAuthorityHarness([requiredDir]);
    const authorityPath = path.join(workspacePath, ".ultrafuzz", "authorities", "consumer.json");

    harness.materialize(task);
    assert.equal(harness.relativePath(task), ".ultrafuzz/authorities/consumer.json");
    assert.equal(harness.path(task, fs.realpathSync(workspacePath)), authorityPath);
    assert.equal(harness.derivationInputs.length, 1);
    assert.equal(harness.derivationInputs[0]!.selectors, selectors);
    assert.deepEqual(harness.derivationInputs[0]!.admittedDependencyArtifactDirs, [requiredDir]);
    assert.deepEqual(Buffer.from(harness.derivationInputs[0]!.sealedTaskManifestBytes), sealedManifestBytes);

    const originalBytes = fs.readFileSync(authorityPath);
    const original = parsePromptArtifactAuthorityBytes(originalBytes);
    assert.deepEqual(original.selectors, selectors);
    assert.equal(original.artifact_path_base, fs.realpathSync(relocatedRunRoot));
    assert.deepEqual(
      original.producers.map((producer) => producer.attempt_id),
      ["required-producer"]
    );
    assert.deepEqual(original.producers[0]?.outputs, [
      { path: "findings.json", contract: "ultrafuzz/findings@2" },
      { path: "generated-tests/manifest.json", contract: "ultrafuzz/generated-tests@3" }
    ]);
    const exposedJson = originalBytes.toString("utf8");
    assert.equal(exposedJson.includes(controllerRunRoot), false);
    assert.equal(exposedJson.includes(taskManifestPath), false);
    assert.doesNotMatch(
      exposedJson,
      /controller-(?:host|model|reasoning)|private-profile|source_revision|source_ref|workspacePath|workspace_path|dependencyArtifactDirs|tasks\.json/u
    );

    harness.setAdmittedDependencyArtifactDirs([requiredDir, optionalDir]);
    harness.materialize(task);
    assert.deepEqual(
      parsePromptArtifactAuthorityBytes(fs.readFileSync(authorityPath)).producers.map(
        (producer) => producer.attempt_id
      ),
      ["optional-producer", "required-producer"]
    );
    harness.setAdmittedDependencyArtifactDirs([requiredDir]);
    harness.materialize(task);
    assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);

    fs.writeFileSync(taskManifestPath, "{}\n", "utf8");
    assert.throws(() => harness.materialize(task), /Smithers task manifest violates its registered schema/u);
    assert.ok(harness.derivationInputs.length >= 4);
    writeFileDurable(taskManifestPath, sealedManifestBytes);
    harness.materialize(task);
    assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);

    const lifecycle: string[] = [];
    let generation = 0;
    const wrapped = loadArtifactAwareAgent({
      onAuthorityCheck: () => {
        lifecycle.push("check");
        harness.assertUnchanged(task);
      },
      onReset: () => {
        lifecycle.push("materialize");
        harness.materialize(task);
      },
      onSourceVerify: () => lifecycle.push("source")
    })(task, 0, "prompt", {
      async generate(): Promise<unknown> {
        generation += 1;
        lifecycle.push(`generate-${generation}`);
        assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);
        if (generation === 3) throw new Error("provider failed after reading exact authority");
        return { summary: `generation-${generation}` };
      }
    });
    assert.deepEqual(await wrapped.generate({ taskContext: { attempt: 1 } }), {
      summary: "generation-1",
      _output: { completed: true }
    });
    assert.deepEqual(
      await wrapped.generate({
        messages: [{ role: "user", content: "correct the schema" }],
        taskContext: { attempt: 1 }
      }),
      { summary: "generation-2", _output: { completed: true } }
    );
    await assert.rejects(
      () => wrapped.generate({ taskContext: { attempt: 2 } }),
      /provider failed after reading exact authority/u
    );
    assert.deepEqual(lifecycle, [
      "source",
      "materialize",
      "generate-1",
      "check",
      "check",
      "generate-2",
      "check",
      "source",
      "materialize",
      "generate-3",
      "check"
    ]);

    const tamperedDocument = structuredClone(original) as PromptArtifactAuthorityDocument;
    tamperedDocument.run_id = "tampered-run";
    const tamperedBytes = serializePromptArtifactAuthority(tamperedDocument);
    for (const outcome of ["success", "failure", "schema-correction"] as const) {
      let calls = 0;
      const tamperAware = loadArtifactAwareAgent({
        onAuthorityCheck: () => harness.assertUnchanged(task),
        onReset: () => harness.materialize(task)
      })(task, 0, "prompt", {
        async generate(): Promise<unknown> {
          calls += 1;
          const shouldTamper = outcome !== "schema-correction" || calls === 2;
          if (shouldTamper) fs.writeFileSync(authorityPath, tamperedBytes);
          if (outcome === "failure") throw new Error("provider failure must not hide authority tampering");
          return { summary: "candidate" };
        }
      });
      if (outcome === "schema-correction") {
        assert.deepEqual(await tamperAware.generate({ taskContext: { attempt: 1 } }), {
          summary: "candidate",
          _output: { completed: true }
        });
      }
      await assert.rejects(
        () =>
          tamperAware.generate({
            ...(outcome === "schema-correction" ? { messages: [{ role: "user", content: "schema correction" }] } : {}),
            taskContext: { attempt: 1 }
          }),
        /prompt artifact authority was modified consumer/u,
        outcome
      );
    }

    harness.materialize(task);
    fs.writeFileSync(authorityPath, tamperedBytes);
    assert.throws(() => harness.assertUnchanged(task), /prompt artifact authority was modified consumer/u);
    harness.materialize(task);
    assert.deepEqual(fs.readFileSync(authorityPath), originalBytes, "retry rematerialization restores exact bytes");

    const identicalReplacementPath = path.join(workspacePath, ".ultrafuzz", "identical-authority.json");
    fs.writeFileSync(identicalReplacementPath, originalBytes);
    fs.renameSync(identicalReplacementPath, authorityPath);
    assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);
    assert.throws(
      () => harness.assertUnchanged(task),
      /prompt artifact authority was modified consumer/u,
      "an identical-byte inode replacement must not preserve authority"
    );
    harness.materialize(task);

    fs.rmSync(authorityPath);
    assert.throws(() => harness.assertUnchanged(task), /prompt artifact authority is unavailable consumer/u);
    harness.materialize(task);
    const linkedAuthorityTarget = path.join(workspacePath, ".ultrafuzz", "linked-authority.json");
    fs.writeFileSync(linkedAuthorityTarget, originalBytes);
    fs.rmSync(authorityPath);
    fs.symlinkSync(linkedAuthorityTarget, authorityPath);
    assert.throws(() => harness.assertUnchanged(task), /prompt artifact authority is unavailable consumer/u);
    harness.materialize(task);
    assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);
    assert.equal(fs.lstatSync(authorityPath).isSymbolicLink(), false);

    for (const directoryContents of [undefined, "hostile/retained.txt"] as const) {
      fs.rmSync(authorityPath);
      fs.mkdirSync(authorityPath);
      if (directoryContents !== undefined) {
        const retainedPath = path.join(authorityPath, ...directoryContents.split("/"));
        fs.mkdirSync(path.dirname(retainedPath), { recursive: true });
        fs.writeFileSync(retainedPath, "model-owned directory entry\n", "utf8");
      }
      harness.materialize(task);
      assert.equal(fs.lstatSync(authorityPath).isFile(), true);
      assert.deepEqual(fs.readFileSync(authorityPath), originalBytes);
      assert.doesNotThrow(() => harness.assertUnchanged(task));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test("generated workflow controls admit the same persisted native workflow outside a snapshot", () => {
  const { admitWorkflowControls, taskWorkflowControlPaths } = loadWorkflowControlPathResolvers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-native-workflow-controls-"));
  const workflowPath = path.join(root, ".smithers", "continuations", "current", "workflows", "workflow.tsx");
  const differentWorkflowPath = path.join(root, ".smithers", "workflows", "different.tsx");
  const snapshotRoot = path.join(root, "snapshots", "a".repeat(64));
  const snapshotWorkflowPath = path.join(snapshotRoot, ".smithers", "workflows", "workflow.tsx");
  const nativeAliasPath = path.join(root, "native-alias.tsx");

  try {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.mkdirSync(path.dirname(differentWorkflowPath), { recursive: true });
    fs.mkdirSync(path.dirname(snapshotWorkflowPath), { recursive: true });
    fs.mkdirSync(path.join(snapshotRoot, "dependencies"), { recursive: true });
    fs.mkdirSync(path.join(snapshotRoot, "controls"), { recursive: true });
    fs.writeFileSync(workflowPath, "export default function Workflow() {}\n", "utf8");
    fs.writeFileSync(differentWorkflowPath, "export default function Different() {}\n", "utf8");
    fs.writeFileSync(snapshotWorkflowPath, "export default function Snapshot() {}\n", "utf8");
    fs.writeFileSync(path.join(snapshotRoot, "dependencies", "manifest.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(snapshotRoot, "controls", "plan.json"), "{}\n", "utf8");
    fs.symlinkSync(snapshotWorkflowPath, nativeAliasPath);

    const admitted = admitWorkflowControls(workflowPath, workflowPath);
    assert.equal(admitted.loadedWorkflowPath, workflowPath);
    assert.equal(admitted.persistedWorkflowPath, workflowPath);
    assert.equal(admitted.loadedExecutionSnapshotRoot, undefined);
    assert.equal(admitted.persistedExecutionSnapshotRoot, undefined);
    assert.deepEqual(taskWorkflowControlPaths("local", admitted), {
      promptExecutionSnapshotRoot: undefined,
      workflowPath: undefined,
      executionSnapshotRoot: undefined
    });
    assert.throws(
      () => admitWorkflowControls(workflowPath, differentWorkflowPath),
      /persisted workflow path does not identify the loaded execution snapshot/u
    );
    assert.throws(
      () => admitWorkflowControls(snapshotWorkflowPath, nativeAliasPath),
      /persisted workflow path does not identify the loaded execution snapshot/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  assert.match(source, /const baseBranch = worktreeBaseBranch\(task\)/u);
  assert.match(source, /baseBranch === undefined \? \{\} : \{ baseBranch \}/u);
  assert.match(source, /function assertWorkspaceSourceRevision/u);
  assert.match(source, /git\("HEAD\^\{commit\}"\)/u);
  assert.match(source, /head !== task\.sourceRevision \|\| sourceRef !== task\.sourceRevision/u);
  assert.match(source, /if \(firstGenerationForAttempt\) \{\s*assertWorkspaceSourceRevision\(task\)/u);
  assert.match(
    source,
    /replayWorkspacePatches !== false\) \{\s*preparationStep\(task\.attemptId, "assert-workspace-source-revision", \(\) => assertWorkspaceSourceRevision\(task\)\)/u
  );
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

test("runtime task reconstruction preserves source identity and rejects undefined worktree bases", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.match(source, /function taskSpecsFromCompiled[\s\S]*?\.\.\.compiledTaskSourceIdentity\(task\)/u);
  const identityStart = source.indexOf("function compiledTaskSourceIdentity");
  const identityEnd = source.indexOf("\n\nfunction taskSpecsFromCompiled", identityStart);
  assert.ok(identityStart >= 0, source);
  assert.ok(identityEnd > identityStart, source);
  const identitySource = ts.transpileModule(source.slice(identityStart, identityEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sourceIdentity = new Function(`${identitySource}; return compiledTaskSourceIdentity;`)() as (task: {
    attemptId: string;
    sourceRevision?: string | null;
    sourceRef?: string | null;
  }) => { sourceRevision: string | null; sourceRef: string | null };

  const revision = "a".repeat(40);
  const ref = "refs/ultrafuzz/runs/run-one/source";
  assert.deepEqual(sourceIdentity({ attemptId: "dynamic-one", sourceRevision: revision, sourceRef: ref }), {
    sourceRevision: revision,
    sourceRef: ref
  });
  assert.deepEqual(sourceIdentity({ attemptId: "dynamic-one" }), { sourceRevision: null, sourceRef: null });
  assert.throws(
    () => sourceIdentity({ attemptId: "dynamic-one", sourceRevision: revision }),
    /incomplete source identity/u
  );

  const baseStart = source.indexOf("function worktreeBaseBranch");
  const baseEnd = source.indexOf("\nfunction readCloudExecutionGeneration", baseStart);
  assert.ok(baseStart >= 0, source);
  assert.ok(baseEnd > baseStart, source);
  const baseSource = ts.transpileModule(source.slice(baseStart, baseEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const resolveBase = (
    task: {
      attemptId: string;
      sourceRevision?: string | null;
      sourceRef?: string | null;
      execution: { mode: string };
    },
    pinned: boolean,
    governedCommit?: string
  ): string | undefined =>
    new Function(
      "task",
      "usesPinnedSource",
      "pinnedSourceBranch",
      "governedSource",
      `${baseSource}; return worktreeBaseBranch(task);`
    )(task, pinned, "ultrafuzz-pinned", governedCommit === undefined ? undefined : { commit: governedCommit });

  assert.equal(
    resolveBase(
      { attemptId: "dynamic-one", sourceRevision: revision, sourceRef: ref, execution: { mode: "local" } },
      false
    ),
    revision
  );
  assert.equal(
    resolveBase(
      { attemptId: "dynamic-one", sourceRevision: revision, sourceRef: ref, execution: { mode: "local" } },
      true
    ),
    "ultrafuzz-pinned"
  );
  assert.equal(
    resolveBase(
      { attemptId: "dynamic-one", sourceRevision: null, sourceRef: null, execution: { mode: "local" } },
      false,
      "b".repeat(40)
    ),
    "b".repeat(40)
  );
  assert.throws(
    () => resolveBase({ attemptId: "dynamic-one", execution: { mode: "local" } }, false),
    /unnormalized source identity/u
  );
});

test("recorded source identity, not later ref creation, selects pinned worktree mode", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function sourceUsesPinnedBranch");
  const helperEnd = source.indexOf("\nfunction readGovernedSource", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const evaluate = (refs: Array<string | null>, mutablePinnedRefExists: boolean): boolean =>
    new Function(
      "taskSpecs",
      "pinnedSourceRef",
      "invariantPinnedSourceRefExists",
      `${helper}; return sourceUsesPinnedBranch();`
    )(
      refs.map((sourceRef) => ({ sourceRef })),
      "refs/heads/ultrafuzz-pinned",
      () => mutablePinnedRefExists
    ) as boolean;

  assert.equal(evaluate(["refs/ultrafuzz/runs/run-one/source"], true), false);
  assert.equal(evaluate(["refs/heads/ultrafuzz-pinned"], false), true);
  assert.equal(evaluate([null], true), true);
  assert.throws(
    () => evaluate(["refs/ultrafuzz/runs/run-one/source", "refs/heads/ultrafuzz-pinned"], true),
    /disagree on their recorded source ref/u
  );
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

test("artifact-aware agents preserve Smithers continuation and checkpoint capabilities", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const capturedResumeSession = "captured-session-929";
  const attemptMeta: Record<string, unknown> = {};
  const checkpointCapabilities = [{ codec: "fixture", versions: [1], modes: ["resume", "fork"] }] as const;
  const checkpointFormats = [{ codec: "fixture", versions: [1] }] as const;
  const sourceAgent: ArtifactAwareAgentFixture = {
    cliEngine: "pi",
    hijackEngine: "fallback-fixture",
    checkpointCapabilities,
    checkpointFormats,
    parseFileChanges(this: { cliEngine?: string }, rawEvent: unknown): unknown[] {
      return [{ path: `${this.cliEngine}:${String(rawEvent)}` }];
    },
    async generate(args: unknown): Promise<unknown> {
      const call = args as Record<string, unknown>;
      calls.push(call);
      if (calls.length === 1) {
        const onEvent = call.onEvent as ((event: Record<string, unknown>) => unknown) | undefined;
        await onEvent?.({ type: "started", engine: "pi", resume: capturedResumeSession });
      }
      return { text: "ok" };
    }
  };
  const wrapped = loadArtifactAwareAgent()({ agentChain: [{}] }, 0, "prompt", sourceAgent);

  assert.equal(wrapped.cliEngine, "pi");
  assert.equal(wrapped.hijackEngine, "fallback-fixture");
  assert.equal(wrapped.checkpointCapabilities, checkpointCapabilities);
  assert.equal(wrapped.checkpointFormats, checkpointFormats);
  assert.deepEqual(wrapped.parseFileChanges?.("change"), [{ path: "pi:change" }]);

  await wrapped.generate({
    prompt: "prompt",
    taskContext: { attempt: 1 },
    onEvent: (event: Record<string, unknown>) => {
      attemptMeta.agentEngine = event.engine;
      attemptMeta.agentResume = event.resume;
    }
  });
  const correctionResumeSession = loadSmithersCorrectionResumeSession()(wrapped, attemptMeta);
  assert.equal(correctionResumeSession, capturedResumeSession);

  const correctionMessages = [{ role: "user", content: "return corrected JSON" }];
  await wrapped.generate({
    prompt: "schema correction",
    messages: correctionMessages,
    resumeSession: correctionResumeSession,
    taskContext: { attempt: 1 }
  });
  assert.equal(calls[1]?.resumeSession, capturedResumeSession);
  assert.equal(calls[1]?.messages, correctionMessages);
});

test("agent retries are error-agnostic fresh generations with Smithers' effective prompt", async () => {
  let resets = 0;
  let sourceVerifications = 0;
  const calls: Array<Record<string, unknown> | undefined> = [];
  const arbitraryFailure = new Error("opaque provider failure 731");
  const artifactAwareAgent = loadArtifactAwareAgent({
    onReset: () => (resets += 1),
    onSourceVerify: () => (sourceVerifications += 1)
  });
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
    (error) => error instanceof Error && error !== arbitraryFailure && error.message === "opaque provider failure 731"
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

  assert.deepEqual(result, { ok: true, _output: { completed: true } });
  assert.equal(resets, 2);
  assert.equal(sourceVerifications, 2);
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

test("agent failures redact configured credentials before Smithers can retain them", async () => {
  const agentCredentialName = "ULTRAFUZZ_TEST_AGENT_CREDENTIAL";
  const modalCredentialName = "ULTRAFUZZ_TEST_MODAL_CREDENTIAL";
  const agentCredential = "agent credential value that rotated";
  const modalCredential = "modal credential value that rotated";
  await withEnvironment(
    { [agentCredentialName]: agentCredential, [modalCredentialName]: modalCredential },
    async () => {
      const originalFailure = Object.assign(
        new Error(`provider echoed ${agentCredential}; modal echoed ${modalCredential}`, {
          cause: { response: agentCredential }
        }),
        {
          code: "AGENT_QUOTA_EXCEEDED",
          details: {
            failureQuota: true,
            quotaResetAtMs: 1_800_000_000_000,
            failureRetryable: true,
            retryAfterMs: 2_500,
            discardResumeSession: false,
            discardAgentCheckpoint: true,
            underlying: agentCredential
          },
          summary: `raw summary ${agentCredential}`,
          docsUrl: `https://example.invalid/${agentCredential}`,
          custom: agentCredential
        }
      );
      originalFailure.stack = `raw provider stack ${agentCredential}`;
      const normalized = await captureAgentFailure(originalFailure, {
        agentChain: [{}],
        execution: {
          agentCredentialEnv: [agentCredentialName],
          modal: { credentialEnv: [modalCredentialName] }
        }
      });
      assert.notEqual(normalized, originalFailure);
      assert.equal(normalized.message, "provider echoed <redacted>; modal echoed <redacted>");
      assert.equal(normalized.code, "AGENT_QUOTA_EXCEEDED");
      assert.deepEqual(normalized.details, {
        failureQuota: true,
        failureRetryable: true,
        discardResumeSession: false,
        discardAgentCheckpoint: true,
        quotaResetAtMs: 1_800_000_000_000,
        retryAfterMs: 2_500
      });
      assert.deepEqual(Object.keys(normalized).sort(), ["code", "details"]);
      for (const key of ["cause", "summary", "docsUrl", "custom"]) assert.equal(key in normalized, false);
      assert.doesNotMatch(
        `${normalized.stack}\n${normalized.message}`,
        /raw provider stack|credential value that rotated/u
      );
    }
  );
});

test("agent failure normalization preserves only validated Smithers recovery controls", async () => {
  for (const [code, details] of [
    ["AGENT_SESSION_LOST", { failureRetryable: true, discardResumeSession: true }],
    ["AGENT_CHECKPOINT_INVALID", { failureRetryable: true, discardAgentCheckpoint: true }],
    ["AGENT_CONFIG_INVALID", { failureRetryable: false }]
  ] as const) {
    const failure = Object.assign(new Error("controlled failure"), { code, details });
    const normalized = await captureAgentFailure(failure);
    assert.equal(normalized.code, code);
    assert.deepEqual(normalized.details, details);
  }

  const abort = new Error("operation aborted") as Error & { code: string };
  abort.name = "AbortError";
  abort.code = "TASK_ABORTED";
  abort.stack = "raw abort stack";
  const normalizedAbort = await captureAgentFailure(abort);
  assert.equal(normalizedAbort.name, "AbortError");
  assert.equal(normalizedAbort.code, "TASK_ABORTED");
  assert.equal(Object.prototype.propertyIsEnumerable.call(normalizedAbort, "name"), false);
  assert.doesNotMatch(normalizedAbort.stack ?? "", /raw abort stack/u);

  const credentialName = "ULTRAFUZZ_TEST_STATEFUL_FAILURE_CREDENTIAL";
  const credential = "credential removed by hostile message getter";
  await withEnvironment({ [credentialName]: credential }, async () => {
    let messageReads = 0;
    let throwingDetailReads = 0;
    const invalid = Object.assign(new Error("unused"), {
      code: "AGENT_UNKNOWN",
      details: {
        failureQuota: "true",
        failureRetryable: 1,
        discardResumeSession: null,
        quotaResetAtMs: Number.POSITIVE_INFINITY,
        retryAfterMs: -1,
        get discardAgentCheckpoint(): never {
          throwingDetailReads += 1;
          throw new Error("trapped detail");
        }
      }
    });
    Object.defineProperty(invalid, "message", {
      configurable: true,
      get() {
        messageReads += 1;
        delete process.env[credentialName];
        return `provider echoed ${credential}`;
      }
    });
    const normalizedInvalid = await captureAgentFailure(invalid, {
      agentChain: [{}],
      execution: { agentCredentialEnv: [credentialName] }
    });
    assert.equal(normalizedInvalid.message, "provider echoed <redacted>");
    assert.equal(messageReads, 1);
    assert.equal(throwingDetailReads, 1);
    assert.equal("code" in normalizedInvalid, false);
    assert.equal("details" in normalizedInvalid, false);
  });
});

test("agent preflight failures redact configured credentials without retaining their cause", async () => {
  const credentialName = "ULTRAFUZZ_TEST_PREFLIGHT_CREDENTIAL";
  const credential = "preflight credential value that rotated";
  await withEnvironment({ [credentialName]: credential }, async () => {
    const originalFailure = new Error(`preflight provider echoed ${credential}`, {
      cause: { response: credential }
    });
    const normalized = await captureAgentFailure(
      originalFailure,
      { agentChain: [{}], execution: { agentCredentialEnv: [credentialName] } },
      true
    );
    assert.notEqual(normalized, originalFailure);
    assert.equal(normalized.message, "preflight provider echoed <redacted>");
    assert.equal("cause" in normalized, false);
    assert.doesNotMatch(normalized.message, /credential value that rotated/u);
  });
});

test("402 gateway failures are promoted to Smithers quota parking controls", async () => {
  // The exact status line from the #677 incident: 41 NodeFailed events whose
  // message began this way burned their attempts instead of parking the run.
  const incidentMessage = "unexpected status 402 Payment Required: This request requires more credits";

  // The pinned engine throws the CLI's stderr as a plain SmithersError with an
  // unlisted code; the normalizer sees code AGENT_CLI_ERROR (dropped by the
  // allowlist) or no code at all. Both must classify as a quota failure.
  for (const failure of [
    new Error(incidentMessage),
    Object.assign(new Error(incidentMessage), { code: "AGENT_CLI_ERROR" })
  ]) {
    const normalized = await captureAgentFailure(failure);
    assert.equal(normalized.code, "AGENT_QUOTA_EXCEEDED");
    // Exactly the scheduler's park predicate — and no fabricated quotaResetAtMs:
    // a 402 has no reset time, so the run stays parked until `ultrafuzz resume`.
    assert.deepEqual(normalized.details, { failureQuota: true });
  }

  // Preflight failures route through the same normalizer and must promote too.
  const preflight = await captureAgentFailure(new Error(incidentMessage), { agentChain: [{}] }, true);
  assert.equal(preflight.code, "AGENT_QUOTA_EXCEEDED");
  assert.deepEqual(preflight.details, { failureQuota: true });

  // Every accepted spelling is a status-code token, never provider prose.
  for (const message of [
    "HTTP 402 from the routed gateway",
    "provider request failed with HTTP status 402",
    "gateway replied 402 Payment Required"
  ]) {
    const normalized = await captureAgentFailure(new Error(message));
    assert.equal(normalized.code, "AGENT_QUOTA_EXCEEDED", message);
    assert.deepEqual(normalized.details, { failureQuota: true });
  }

  // Non-402 statuses, credit prose without a status token, and incidental 402
  // digits must stay unclassified so real failures keep failing.
  for (const message of [
    "unexpected status 400 Bad Request: malformed tool call",
    "unexpected status 429 Too Many Requests: slow down",
    "This request requires more credits, or fewer max_tokens",
    "wrote 402 bytes to the provider socket before EOF"
  ]) {
    const normalized = await captureAgentFailure(new Error(message));
    assert.equal("code" in normalized, false, message);
    assert.equal("details" in normalized, false, message);
  }

  // A source-classified control error is never overridden by the 402 matcher.
  const configFailure = Object.assign(new Error(incidentMessage), {
    code: "AGENT_CONFIG_INVALID",
    details: { failureRetryable: false }
  });
  const normalizedConfig = await captureAgentFailure(configFailure);
  assert.equal(normalizedConfig.code, "AGENT_CONFIG_INVALID");
  assert.deepEqual(normalizedConfig.details, { failureRetryable: false });
});

test("agent preflight and generation share one lazily admitted agent instance", async () => {
  let metadataPreflights = 0;
  let admittedFactories = 0;
  let admittedPreflights = 0;
  let admittedGenerations = 0;
  const metadataAgent = {
    preflight: async () => {
      metadataPreflights += 1;
    },
    generate: async () => ({ summary: "metadata agent must not execute" })
  };
  const admittedAgent = {
    preflight: async () => {
      admittedPreflights += 1;
    },
    generate: async () => {
      admittedGenerations += 1;
      return { summary: "admitted" };
    }
  };
  const wrapped = loadArtifactAwareAgent()({ agentChain: [{}] }, 0, "prompt", metadataAgent, () => {
    admittedFactories += 1;
    return admittedAgent;
  });

  await wrapped.preflight!({});
  assert.deepEqual(await wrapped.generate({ taskContext: { attempt: 1 } }), {
    summary: "admitted",
    _output: { completed: true }
  });
  assert.equal(metadataPreflights, 0);
  assert.equal(admittedFactories, 1);
  assert.equal(admittedPreflights, 1);
  assert.equal(admittedGenerations, 1);
});

test("agent failure normalization never stringifies arbitrary thrown objects", async () => {
  const normalized = await captureAgentFailure({
    toString(): never {
      throw new Error("attacker-controlled toString must not execute");
    }
  });
  assert.equal(normalized.message, "agent execution failed");
  assert.equal("cause" in normalized, false);
});

test("final-report prompt authority is bounded, tamper-evident, and constant-size across large projections", () => {
  const workflowSource = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentSource = workflowSource.slice(
    workflowSource.indexOf("function artifactAwareAgent"),
    workflowSource.indexOf("function isStrictlyInsideDirectory")
  );
  assert.doesNotMatch(workflowSource, /JSON\.stringify\((?:coverage|execution), null, 2\)/u);
  assert.match(workflowSource, /const MAX_FINAL_REPORT_PROMPT_AUTHORITY_BYTES = MAX_PRE_AGENT_EVIDENCE_BYTES;/u);
  assert.ok(
    agentSource.indexOf("materializeFinalReportPromptAuthority(task") <
      agentSource.indexOf("executionAgent.generate(unstructuredArgs)")
  );
  assert.match(
    agentSource,
    /if \(firstGenerationForAttempt\)[\s\S]*?resetTaskArtifactsForRetry\(task\)[\s\S]*?materializeFinalReportPromptAuthority\(task, authoritativeFinalReportCoverage\(task\), execution\)[\s\S]*?authoritativeFinalReportPromptAuthorityArgs\([\s\S]*?assertFinalReportPromptAuthorityUnchanged\(task\);[\s\S]*?const result = await executionAgent\.generate\(unstructuredArgs\)/u
  );
  const coverageSource = workflowSource.slice(
    workflowSource.indexOf("function authoritativeFinalReportCoverage"),
    workflowSource.indexOf("type FinalReportAgentAttempt")
  );
  assert.match(coverageSource, /verifiedSingletonAncestorJsonArtifact/u);
  assert.match(coverageSource, /verifiedCanonicalPropertyCatalog/u);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-prompt-authority-"));
  try {
    const workspacePath = path.join(root, "workspaces", "final-report");
    fs.mkdirSync(workspacePath, { recursive: true });
    const task = { attemptId: "final-report", workspacePath };
    const authority = loadFinalReportPromptAuthorityHarness();
    const renderedPrompt = "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task";
    const reportPath = "custom/final-report.json";
    const largeCoverage = {
      selected_property_ids: Array.from({ length: 10_000 }, (_, index) => `property-${index}`),
      blocker_summaries: Array.from({ length: 1_000 }, (_, index) => `property-${index}: blocked`)
    };
    const attempts = Array.from({ length: 100 }, (_, index) => ({
      attempt: index + 1,
      profile_id: `profile-${index}`,
      agent_ref: "CodexAgent",
      model_name: "gpt-test",
      role: index === 0 ? "primary" : "fallback"
    }));
    const largeExecution = {
      planned_chain: attempts,
      failed_attempts: attempts.slice(0, -1),
      producer: attempts.at(-1)
    };

    authority.materialize(task, largeCoverage, largeExecution);
    const relativePath = authority.relativePath(task);
    assert.equal(relativePath, ".ultrafuzz/authorities/final-report.final-report-prompt.json");
    const authorityPath = path.join(workspacePath, ...relativePath.split("/"));
    assert.deepEqual(JSON.parse(fs.readFileSync(authorityPath, "utf8")), {
      schema_version: "ultrafuzz.final-report-prompt-authority.v1",
      property_implementation_coverage: largeCoverage,
      agent_execution: largeExecution
    });

    const injected = authority.prompt(renderedPrompt, relativePath, reportPath);
    assert.ok(injected.startsWith("trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\n"), injected);
    assert.match(injected, /## Authoritative final-report data/u);
    assert.match(injected, /bounded host-generated JSON object/u);
    assert.match(injected, /final-report\.final-report-prompt\.json/u);
    assert.match(injected, /property_implementation_coverage/u);
    assert.match(injected, /run_metadata\.agent_execution/u);
    assert.doesNotMatch(injected, /property-9999|profile-99/u);
    assert.ok(Buffer.byteLength(injected) - Buffer.byteLength(renderedPrompt) < 1_500, injected);
    assert.equal(authority.prompt(renderedPrompt, relativePath, reportPath), injected);
    authority.assertUnchanged(task);

    fs.writeFileSync(authorityPath, '{"forged":true}\n', "utf8");
    assert.throws(() => authority.assertUnchanged(task), /final-report prompt authority was modified/u);
    authority.materialize(task, largeCoverage, largeExecution);
    authority.assertUnchanged(task);

    const tinyBudgetAuthority = loadFinalReportPromptAuthorityHarness(1_024);
    assert.throws(
      () => tinyBudgetAuthority.materialize(task, { oversized: "x".repeat(1_024) }, largeExecution),
      /final-report prompt authority exceeds its byte budget/u
    );
    assert.throws(
      () => authority.prompt("prompt without boundary", relativePath, reportPath),
      /cannot locate the untrusted-content boundary/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final-report repository normalization strips private URL suffixes and rejects ambiguous remotes", () => {
  const normalize = loadFinalReportRunMetadataAuthorityHarness().normalize;
  const canonical = "https://github.com/example/project";
  for (const remote of [
    "https://github.com/example/project.git?session=private-id",
    "https://github.com/example/project.git#private-fragment",
    "https://github.com/example/project?session=private-id#private-fragment",
    "ssh://git@github.com/example/project.git#private-fragment",
    "git@github.com:example/project.git?session=private-id"
  ]) {
    const normalized = normalize(remote);
    assert.equal(normalized, canonical, remote);
    assert.equal(normalized.includes("private-id"), false, remote);
    assert.equal(normalized.includes("private-fragment"), false, remote);
  }

  for (const remote of [
    "https://credential@github.com/example/project.git?session=private-id",
    "https://credential:secret@github.com/example/project.git",
    "ssh://other-user@github.com/example/project.git",
    "https://github.com:443/example/project.git",
    "https://github.com/example/project.git/private-id",
    "https://github.com/example%2fprivate/project.git",
    "https://github.com/example/project%2fprivate.git",
    "https://github.com.evil/example/project.git",
    "https://github.com/example/../private.git",
    "github.com/example/project.git"
  ]) {
    assert.equal(normalize(remote), "unavailable", remote);
  }
});

test("final-report Run summary authority is allowlisted, path-injected, tamper-evident, and retry-restored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-run-summary-"));
  try {
    const runRoot = path.join(root, ".ultrafuzz", "runs", "run-1");
    const workspacePath = path.join(runRoot, "workspaces", "final-report");
    fs.mkdirSync(workspacePath, { recursive: true });
    const metadata = {
      schema_version: "ultrafuzz.run-metadata.v2",
      run_id: "run-1",
      source_run_id: "source-run",
      created_at: "2026-08-20T00:00:00.000Z",
      mode: "run",
      workflow_ids: [],
      redacted_config_fingerprint: "1".repeat(64),
      prompt_digest: "2".repeat(64),
      forge_guard: {
        enabled: true,
        active: true,
        virtual_memory_limit_kb: 1_048_576,
        rayon_threads: 4
      },
      audit_profile: {
        requested: "exhaustive",
        effective: "exhaustive",
        catalog_schema_version: 1,
        settings: { controller_private_setting: "must-not-project" },
        catalog_digest: "3".repeat(64),
        effective_topology_path: "private/controller/topology.yml",
        topology_path_origin: "audit-profile",
        topology_digest: "4".repeat(64),
        prompt_digest: "5".repeat(64),
        expanded_graph_fingerprint: "6".repeat(64),
        effective_settings: { strategy_loops: 3, private_model_chain: ["must-not-project"] },
        setting_origins: { strategy_loops: "audit-profile" },
        overridden_settings: [],
        topology_overridden: false
      }
    };
    fs.writeFileSync(path.join(runRoot, "run.json"), `${JSON.stringify(metadata)}\n`, "utf8");
    const task = {
      attemptId: "final-report",
      runRoot,
      workspacePath,
      metadata: { run: { ultrafuzzRunId: "run-1" } },
      outputs: [
        { path: "custom/report.json", contract: "ultrafuzz/report@3" },
        { path: "custom/report.md", contract: "ultrafuzz/nonempty-markdown@1" }
      ]
    };
    const authority = loadFinalReportRunMetadataAuthorityHarness();
    authority.materialize(task);

    const relativePath = ".ultrafuzz/authorities/final-report.final-report-run-metadata.json";
    const authorityPath = path.join(workspacePath, ...relativePath.split("/"));
    assert.equal(authority.relativePath(task), relativePath);
    const projection = JSON.parse(fs.readFileSync(authorityPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(projection, {
      run_id: "run-1",
      source_run_id: "source-run",
      repository: "https://github.com/example/project",
      elapsed_time: "unavailable",
      models_used: [],
      tokens_used: "unavailable",
      estimated_spend: "unavailable",
      partial_pricing: false,
      strategy_loops: 3,
      audit_profile: "exhaustive",
      audit_profile_catalog_digest: "3".repeat(64),
      topology_digest: "4".repeat(64),
      prompt_digest: "5".repeat(64),
      expanded_graph_fingerprint: "6".repeat(64)
    });
    assert.equal(JSON.stringify(projection).includes("must-not-project"), false);
    assert.equal(JSON.stringify(projection).includes("private-id"), false);
    assert.deepEqual(authority.authoritative(task), projection);
    assert.doesNotThrow(() => authority.assertUnchanged(task));

    const prompt = authority.prompt(
      "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task",
      relativePath,
      "custom/report.json"
    );
    assert.ok(prompt.indexOf(relativePath) < prompt.indexOf("trusted runtime"), prompt);
    assert.match(prompt, /bounded host-generated JSON object/u);
    assert.match(prompt, /add only agent_execution from the separate final-report data authority/u);
    assert.equal(prompt.includes('"models_used"'), false, "projection arrays must not expand into the prompt");
    assert.equal(prompt.includes("must-not-project"), false);

    fs.writeFileSync(authorityPath, `${JSON.stringify({ ...projection, repository: "tampered" })}\n`, "utf8");
    assert.throws(() => authority.assertUnchanged(task), /run metadata authority was modified/u);
    authority.materialize(task);
    assert.deepEqual(JSON.parse(fs.readFileSync(authorityPath, "utf8")), projection);
    assert.doesNotThrow(() => authority.assertUnchanged(task));

    for (const directoryContents of [undefined, "nested/retained.txt"] as const) {
      fs.rmSync(authorityPath);
      fs.mkdirSync(authorityPath);
      if (directoryContents !== undefined) {
        const retainedPath = path.join(authorityPath, ...directoryContents.split("/"));
        fs.mkdirSync(path.dirname(retainedPath), { recursive: true });
        fs.writeFileSync(retainedPath, "model-owned directory entry\n", "utf8");
      }
      authority.materialize(task);
      assert.equal(fs.lstatSync(authorityPath).isFile(), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(authorityPath, "utf8")), projection);
      assert.doesNotThrow(() => authority.assertUnchanged(task));
    }

    fs.writeFileSync(path.join(runRoot, "run.json"), `${JSON.stringify({ run_id: "run-1" })}\n`, "utf8");
    assert.deepEqual(authority.derive(task), {
      run_id: "run-1",
      source_run_id: "unavailable",
      repository: "https://github.com/example/project",
      elapsed_time: "unavailable",
      models_used: [],
      tokens_used: "unavailable",
      estimated_spend: "unavailable",
      partial_pricing: false,
      strategy_loops: "unavailable",
      audit_profile: "unavailable",
      audit_profile_catalog_digest: "unavailable",
      topology_digest: "unavailable",
      prompt_digest: "unavailable",
      expanded_graph_fingerprint: "unavailable"
    });

    fs.writeFileSync(
      path.join(runRoot, "run.json"),
      `${JSON.stringify({ run_id: "run-1", created_at: "not-a-timestamp" })}\n`,
      "utf8"
    );
    assert.throws(() => authority.derive(task), /final-report elapsed-time metadata is malformed/u);

    const wrongRunTask = { ...task, metadata: { run: { ultrafuzzRunId: "other-run" } } };
    assert.throws(() => authority.derive(wrongRunTask), /final-report run metadata has the wrong run ID/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

  const promptWithAuthority = loadPromptWithAuthoritativeFinalReportPromptAuthority();
  const originalPrompt = "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task";
  const authorityPath = ".ultrafuzz/authorities/final-report.final-report-prompt.json";
  const firstAttemptPrompt = promptWithAuthority(originalPrompt, authorityPath, "report.json");
  const fallbackAttemptPrompt = promptWithAuthority(originalPrompt, authorityPath, "report.json");
  assert.equal(fallbackAttemptPrompt, firstAttemptPrompt);
  assert.match(firstAttemptPrompt, /bounded host-generated JSON object/u);
  assert.doesNotMatch(firstAttemptPrompt, /gpt55-xhigh|failed_attempts/u);
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
  assert.doesNotMatch(source, /retryFailureAwareArgs|retryFailureText|Untrusted prior-attempt failure/u);
  assert.doesNotMatch(agent, /previousFailure|error\.message|String\(error\)/u);
  assert.match(agent, /prompt: typeof args\?\.prompt === "string" \? args\.prompt : originalPrompt/u);
  assert.match(agent, /resumeSession: undefined/u);
  assert.match(agent, /continueSession: false/u);
  assert.match(agent, /lastHeartbeat: undefined/u);
  assert.match(agent, /Reflect\.deleteProperty\(freshArgs, "messages"\)/u);
  assert.match(
    agent,
    /assertDependencyArtifactAdmissionCurrent\(task\);[\s\S]*?Reflect\.deleteProperty\(unstructuredArgs, "outputSchema"\);\s*const result = await executionAgent\.generate\(unstructuredArgs\);\s*assertDependencyArtifactAdmissionCurrent\(task\);\s*assertPromptArtifactAuthorityUnchanged\(task\);\s*assertFinalReportRunMetadataAuthorityUnchanged\(task\);\s*assertFinalReportPromptAuthorityUnchanged\(task\);[\s\S]*?_output: \{ completed: true \}/u
  );
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
    agent.indexOf("resetTaskArtifactsForRetry(task)") < agent.indexOf("executionAgent.generate(unstructuredArgs)"),
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
  assert.match(reset, /materializePromptArtifactAuthority\(task\)/u);
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

test("generated Smithers agent boundary performs only task-local authority checks after completion", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const agentEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", agentStart);

  assert.ok(agentStart >= 0, source);
  assert.ok(agentEnd > agentStart, source);

  const agent = source.slice(agentStart, agentEnd);
  assert.match(
    agent,
    /assertDependencyArtifactAdmissionCurrent\(task\);[\s\S]*?Reflect\.deleteProperty\(unstructuredArgs, "outputSchema"\);\s*const result = await executionAgent\.generate\(unstructuredArgs\);\s*assertDependencyArtifactAdmissionCurrent\(task\);\s*assertPromptArtifactAuthorityUnchanged\(task\);\s*assertFinalReportRunMetadataAuthorityUnchanged\(task\);\s*assertFinalReportPromptAuthorityUnchanged\(task\);[\s\S]*?_output: \{ completed: true \}/u
  );
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
  assert.match(verifier, /authoritativeFinalReportRunMetadata\(task\)/u);
  assert.match(verifier, /projectCanonicalFinalReport\(report\.value,\s*\{/u);
  assert.match(verifier, /goalSearchCoverage: readGoalSearchCoverage\(task\.runRoot\)/u);
  assert.match(verifier, /isDeepStrictEqual\(projection\.report, report\.value\)/u);
  assert.match(verifier, /markdown\.file\.bytes\.equals\(Buffer\.from\(projection\.markdown, "utf8"\)\)/u);
  assert.match(verifier, /agent-owned bytes were left unchanged/u);
  assert.doesNotMatch(verifier, /writeFile|writeJson|rename|unlink|rmSync/u);
  assert.doesNotMatch(source, /ultrafuzz\/implemented-properties@1|ultrafuzz\/implemented-properties@2/u);
  assert.match(source, /status: "not-planned",\s+reason: "property-implementation-track-not-declared"/u);
});

const FINAL_REPORT_AGENT_EXECUTION_FIXTURE = {
  planned_chain: [{ attempt: 1, profile_id: "default", agent_ref: "CodexAgent", role: "primary" }],
  failed_attempts: [],
  producer: { attempt: 1, profile_id: "default", agent_ref: "CodexAgent", role: "primary" }
};

const FINAL_REPORT_RUN_METADATA_FIXTURE = {
  run_id: "run-1",
  source_run_id: "none",
  repository: "https://github.com/example/project",
  elapsed_time: "1m 00s",
  models_used: ["model-a"],
  tokens_used: "100",
  estimated_spend: "$0.01",
  partial_pricing: false,
  strategy_loops: 1,
  audit_profile: "exhaustive",
  audit_profile_catalog_digest: "a".repeat(64),
  topology_digest: "b".repeat(64),
  prompt_digest: "c".repeat(64),
  expanded_graph_fingerprint: "d".repeat(64)
};

function loadFinalReportCanonicalProjectionHarness(
  overrides: {
    projectCanonicalFinalReport?: typeof projectCanonicalFinalReport;
    readGoalSearchCoverage?: (runRoot: string) => unknown;
  } = {}
): (
  task: { outputs: Array<{ path: string; contract: string }>; runRoot?: string },
  verifiedOutputs: ReadonlyMap<string, { value: unknown; file: { bytes: Buffer } }>
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const declarationStart = source.indexOf("function declaredFinalReportOutputPair");
  const declarationEnd = source.indexOf("\n\ntype FinalReportRunMetadataProjection", declarationStart);
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
    "authoritativeFinalReportRunMetadata",
    "readGoalSearchCoverage",
    "Buffer",
    `${emitted}; return verifyFinalReportCanonicalProjection;`
  )(
    () => ({ status: "not-planned", reason: "property-implementation-track-not-declared" }),
    isDeepStrictEqual,
    overrides.projectCanonicalFinalReport ??
      ((report: unknown) => ({ report, markdown: "# Canonical custom report\n" })),
    () => FINAL_REPORT_AGENT_EXECUTION_FIXTURE,
    () => FINAL_REPORT_RUN_METADATA_FIXTURE,
    overrides.readGoalSearchCoverage ?? (() => undefined),
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
    run_metadata: { ...FINAL_REPORT_RUN_METADATA_FIXTURE, agent_execution: FINAL_REPORT_AGENT_EXECUTION_FIXTURE },
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

  const rewrittenRunMetadata = structuredClone(report);
  rewrittenRunMetadata.run_metadata.repository = "https://github.com/forged/project";
  const withRewrittenRunMetadata = new Map(verified);
  withRewrittenRunMetadata.set("deliverables/security-audit.json", {
    value: rewrittenRunMetadata,
    file: { bytes: Buffer.from("rewritten JSON") }
  });
  assert.throws(
    () => verifyProjection(task, withRewrittenRunMetadata),
    /run_metadata differs from the authoritative sanitized projection/u
  );

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

test("generated canonical report verification enforces census-rendered goal coverage bytes", () => {
  const census = {
    schema_version: "ultrafuzz.goal-search-coverage.v1",
    run_id: "run-1",
    totals: { planned: 2 },
    goals: [
      {
        node_id: "dynamic:class:1",
        logical_node_id: "class-goals",
        attempt_id: "attempt-001",
        status: "completed-no-findings",
        finding_count: 0
      },
      {
        node_id: "dynamic:class:2",
        logical_node_id: "class-goals",
        attempt_id: "attempt-002",
        status: "completed-with-findings",
        finding_count: 1
      }
    ]
  };
  const report = {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: { ...FINAL_REPORT_RUN_METADATA_FIXTURE, agent_execution: FINAL_REPORT_AGENT_EXECUTION_FIXTURE },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  };
  const censusProjection = projectCanonicalFinalReport(report, { goalSearchCoverage: census });
  const unknownProjection = projectCanonicalFinalReport(report, {});
  assert.match(censusProjection.markdown, /All 2 targeted goal searches completed and published a verified result/u);
  assert.match(unknownProjection.markdown, /\*\*Goal search coverage is unknown\.\*\*/u);

  const task = {
    runRoot: "run-root-fixture",
    outputs: [
      { path: "report.json", contract: "ultrafuzz/report@3" },
      { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" }
    ]
  };
  const verifiedWith = (markdown: string): Map<string, { value: unknown; file: { bytes: Buffer } }> =>
    new Map([
      ["report.json", { value: report, file: { bytes: Buffer.from(`${JSON.stringify(report)}\n`) } }],
      ["report.md", { value: markdown, file: { bytes: Buffer.from(markdown, "utf8") } }]
    ]);

  const censusRunRoots: string[] = [];
  const verifyWithCensus = loadFinalReportCanonicalProjectionHarness({
    projectCanonicalFinalReport,
    readGoalSearchCoverage: (runRoot) => {
      censusRunRoots.push(runRoot);
      return census;
    }
  });

  // The census-rendered projection is the only publishable report.md once the run recorded a census.
  assert.doesNotThrow(() => verifyWithCensus(task, verifiedWith(censusProjection.markdown)));
  assert.deepEqual(censusRunRoots, ["run-root-fixture"]);

  // A census-less "unknown" rendering must not publish against a recorded census (issues #684/#702).
  assert.throws(
    () => verifyWithCensus(task, verifiedWith(unknownProjection.markdown)),
    /is not the canonical projection of report\.json/u
  );

  // Without a census, unknown is the only publishable statement: agent Markdown claiming completed
  // goal searches fails byte equality, so unknown never reads as full coverage on the runtime path.
  const verifyWithoutCensus = loadFinalReportCanonicalProjectionHarness({
    projectCanonicalFinalReport,
    readGoalSearchCoverage: () => undefined
  });
  assert.doesNotThrow(() => verifyWithoutCensus(task, verifiedWith(unknownProjection.markdown)));
  assert.throws(
    () => verifyWithoutCensus(task, verifiedWith(censusProjection.markdown)),
    /is not the canonical projection of report\.json/u
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
    "gitTestTreePaths",
    "removeStaleWorkspaceFiles"
  ]) {
    const start = source.indexOf(`function ${enumeration}(`);
    assert.ok(start >= 0, enumeration);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /invariantSuiteGitPaths\(/u, enumeration);
    assert.doesNotMatch(body, /execFileSync\(\s*"git",\s*\["ls-files"/u, enumeration);
  }
  // The stale-file cleanup (#691) captures nothing outside the bounded helper -- not even its ls-tree.
  const staleCleanupStart = source.indexOf("function removeStaleWorkspaceFiles(");
  const staleCleanup = source.slice(staleCleanupStart, source.indexOf("\n}\n", staleCleanupStart));
  assert.doesNotMatch(staleCleanup, /execFileSync\(/u);
});

test("#691 every git capture in the generated workflow states an explicit maxBuffer", () => {
  // #323 bounded the three enumeration sites it happened to list and missed a fourth,
  // `removeStaleWorkspaceFiles`, whose `--ignored` listing overflows Node's 1 MB default on any
  // workspace with a populated node_modules. This scan is the exhaustive version of that criterion:
  // every `execFileSync("git", ...)` call in the template must state a bound, so a future bare site
  // fails here instead of dying in production as an anonymous `spawnSync git ENOBUFS`. Discovery is
  // whitespace-tolerant: prettier renders long-argument calls as `execFileSync(\n  "git", ...)` --
  // this template already carries that shape at its smithers and ultrafuzz sites -- so anchoring on
  // the single-line `execFileSync("git"` literal would skip exactly the sites it exists to catch.
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const callSpans: string[] = [];
  for (let from = source.indexOf("execFileSync("); from >= 0; from = source.indexOf("execFileSync(", from + 1)) {
    let depth = 0;
    for (let index = source.indexOf("(", from); index < source.length; index += 1) {
      const character = source[index];
      if (character === '"' || character === "'" || character === "`") {
        for (index += 1; index < source.length && source[index] !== character; index += 1) {
          if (source[index] === "\\") index += 1;
        }
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          callSpans.push(source.slice(from, index + 1));
          break;
        }
      }
    }
  }
  // Every occurrence must parse to one balanced span: a site the scanner cannot delimit fails here
  // instead of silently dropping out of the criterion.
  assert.equal(callSpans.length, source.split("execFileSync(").length - 1);
  const gitCallSpans = callSpans.filter((span) => /^execFileSync\(\s*"git"/u.test(span));
  // The template invokes git from several fixed sites plus the one bounded helper; if this floor is no
  // longer met the scanner itself has broken, which must fail rather than vacuously pass. (#727 moved
  // the read-tree reset into the runtime's lock-recovering helper, taking the template from 8 to 7.)
  assert.ok(gitCallSpans.length >= 7, `${gitCallSpans.length}`);
  for (const span of gitCallSpans) {
    assert.match(span, /maxBuffer:/u, span);
  }
  // The criterion covers every spawn flavor: nothing else in the template shells out to git at all.
  assert.doesNotMatch(source, /(?:^|[^.\w])execSync\(/u);
  assert.doesNotMatch(source, /spawnSync\(/u);
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
  const preparationReset = preparationRestore.indexOf(
    "restoreWorkspaceTreeWithIndexLockRecovery(workspaceRoot, preparationTree)"
  );
  assert.ok(
    preparationReset >= 0 &&
      preparationReset < preparationRestore.indexOf("removeStaleWorkspaceFiles(workspaceRoot, preparationTree)"),
    preparationRestore
  );
  // #691: both stale-cleanup listings exclude the runtime roots in the pathspec itself -- git never
  // enumerates node_modules only for the loop to discard it -- and keep the explicit `--`, `.`.
  assert.match(
    preparationRestore,
    /\["ls-files", "--others", "--exclude-standard", "-z", "--", "\.", \.\.\.staleExclusionPathspecs\]/u
  );
  assert.match(
    preparationRestore,
    /\["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "\.", \.\.\.staleExclusionPathspecs\]/u
  );
  assert.match(source, /const WORKSPACE_RUNTIME_ROOTS = \["\.ultrafuzz", "\.smithers", "node_modules", "artifacts"\]/u);
  assert.match(preparationRestore, /WORKSPACE_RUNTIME_ROOTS\.map\(\(root\) => `:\(exclude\)\$\{root\}`\)/u);
  // The last gate before rmSync stays: the pathspec aligns the producer with it, it does not replace it.
  assert.match(preparationRestore, /isWorkspaceRuntimePath\(relativePath\)/u);
  // #727: the one-shot reset was terminal on a transient `index.lock` collision. The lock-recovering
  // runtime helper is the only permitted producer of this reset; no raw one-shot may return anywhere.
  assert.ok(!source.includes('execFileSync("git", ["read-tree", "--reset", "-u"'), source);
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
      verifier.indexOf("const verificationMarker = writeArtifactVerificationMarker(task, artifacts, publications)")
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
  assert.match(source, /marker:\s*Object\.freeze\(\{[\s\S]*?bytes: Buffer\.from\(markerSnapshot\.bytes\)/u);
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
    marker: { path: string; bytes: Buffer; identity: Record<string, bigint> };
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

test("generated Smithers preparation names its failing step and carries a retry budget", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function preparationStep");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const preparationEnd = source.indexOf("\n\nfunction assertTaskOutputSchemaBindings", preparationStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(preparationStart > helperStart, source);
  assert.ok(preparationEnd > preparationStart, source);

  // #672: Bun erases the user frames of an error thrown inside a task body, so every one of the
  // 53 prepare:* failures in the measured run arrived with a stack of only
  // `at run (node:async_hooks:68:37)`. The wrapper must rebuild the fact the stack cannot carry
  // -- which step threw -- and keep the original error reachable as `cause`.
  const helper = source.slice(helperStart, preparationStart);
  assert.match(helper, /`prepare:\$\{attemptId\} failed at step \$\{step\}: \$\{[\s\S]*?\}`/u);
  assert.match(helper, /\{ cause: error \}/u);

  const preparation = source.slice(preparationStart, preparationEnd);
  const steps = [
    "resolve-workspace-root",
    "assert-workspace-source-revision",
    "restore-persisted-workspace-preparation",
    "verify-pinned-submodules",
    "hydrate-pinned-submodules",
    "preserve-pinned-source-proof",
    "materialize-prompt-schemas",
    "assert-task-output-schema-bindings",
    "preflight-json-validator",
    "assert-task-inputs",
    "materialize-workspace-patch-dependencies",
    "require-invariant-suite-snapshot",
    "restore-invariant-suite-snapshot",
    "materialize-invariant-suite",
    "capture-invariant-suite-snapshot",
    "require-invariant-suite-dependency-handoff",
    "create-artifact-mirror",
    "resolve-artifact-mirror",
    "capture-invariant-suite-baseline",
    "verify-invariant-suite-baseline",
    "prepare-output-paths"
  ];
  for (const step of steps) {
    assert.match(preparation, new RegExp(`preparationStep\\(task\\.attemptId, "${step}", \\(\\) =>`, "u"), step);
  }

  // #949: retry-failed reopens a producer onto its durable worktree, which can still contain that
  // producer's earlier source output. Restore the runtime-owned pre-agent tree before replaying the
  // first dependency patch; doing this later leaves the strict base-tree guard no safe classification
  // for task-local drift. The post-agent require path must never take this branch.
  const restorePersisted = preparation.indexOf("restorePersistedWorkspacePatchPreparationBeforeReplay(");
  const replayDependencies = preparation.indexOf("materializeWorkspacePatchDependencies(");
  assert.ok(restorePersisted >= 0 && restorePersisted < replayDependencies, preparation);
  const restoreHelperStart = source.indexOf("function restorePersistedWorkspacePatchPreparationBeforeReplay");
  const restorePreparationStart = source.indexOf("function restoreWorkspacePatchPreparation", restoreHelperStart + 1);
  assert.ok(restoreHelperStart >= 0 && restorePreparationStart > restoreHelperStart, source);
  const restoreHelper = source.slice(restoreHelperStart, restorePreparationStart);
  assert.match(restoreHelper, /if \(evidenceMode !== "create"\) return;/u);
  assert.match(restoreHelper, /const persistedPreparation = readWorkspacePatchPreparation\(task\);/u);
  assert.match(restoreHelper, /if \(persistedPreparation === undefined\) return;/u);
  assert.match(restoreHelper, /workspace preparation was modified/u);
  assert.match(restoreHelper, /restoreWorkspacePatchPreparation\(task, workspaceRoot, persistedPreparation\);/u);

  // #672: a preparation failure was terminal because the preparation Task hardcoded retries={0},
  // out of reach of the topology's max_attempts. The compiled budget must never drop below one
  // retry and never reduce an inherited budget. The verifier Task's retries={0} model-replay seal
  // is pinned separately and must stay at zero.
  const preparationTaskStart = source.indexOf("id={task.preparationId}");
  assert.ok(preparationTaskStart >= 0, source);
  const preparationTask = source.slice(preparationTaskStart, source.indexOf(">", preparationTaskStart));
  assert.match(preparationTask, /retries=\{Math\.max\(task\.retries, 1\)\}/u);
  assert.doesNotMatch(preparationTask, /retries=\{0\}/u);
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
