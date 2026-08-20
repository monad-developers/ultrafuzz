import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";

import {
  artifactContractDefinition,
  assertRegularFileInside,
  derivePropertyImplementationCoverage,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES,
  normalizeEvidenceLineRangeCardinality,
  normalizeNodeAttemptFailureMessage,
  PROPERTIES_SCHEMA_VERSION,
  publishFileDurableExclusive,
  validateArtifactContract,
  writeFileDurable
} from "@ultrafuzz/artifacts";
import { loadTopology } from "@ultrafuzz/topology";
import {
  GOAL_SEARCH_COVERAGE_FILE,
  GOAL_SEARCH_COVERAGE_SCHEMA_VERSION,
  projectCanonicalFinalReport
} from "../src/final-report-markdown.js";

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.resolve(runtimePackageRoot, "../..");
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function loadBoundedFinalReportReader(): (reportPath: string) => string {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function readBoundedFinalReportJson");
  const helperEnd = source.indexOf("\n\nfunction reconstructAuthoritativeReportImplementationCoverage", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "openSync",
    "fsConstants",
    "fstatSync",
    "readFileSync",
    "closeSync",
    "MAX_FINAL_REPORT_JSON_BYTES",
    `${helper}; return readBoundedFinalReportJson;`
  )(fs.openSync, fs.constants, fs.fstatSync, fs.readFileSync, fs.closeSync, 64 * 1024 * 1024) as ReturnType<
    typeof loadBoundedFinalReportReader
  >;
}

function loadReportImplementationCoverageReplacer(): (contents: string, coverage: unknown) => string | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function replaceReportImplementationCoverage");
  const helperEnd = source.indexOf("\n\nfunction normalizeLegacyReportProvenance", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("isPlainRecord", `${helper}; return replaceReportImplementationCoverage;`)(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
  ) as ReturnType<typeof loadReportImplementationCoverageReplacer>;
}

function loadReportImplementationCoverageReconstructor(
  taskSpecs: Array<{
    attemptId: string;
    metadata: { node: { logicalNodeId: string } };
    outputs: Array<{ path: string; contract: string }>;
  }>,
  verifiedAncestorJsonArtifact: (
    task: unknown,
    logicalNodeId: string,
    relativePath: string,
    contract: string,
    historicalContract?: string
  ) => { path: string; value: unknown } | undefined
): (task: {
  metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  outputs: Array<{ path: string; contract: string }>;
}) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function reconstructAuthoritativeReportImplementationCoverage");
  const helperEnd = source.indexOf("\n\nfunction verifiedAncestorJsonArtifact", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const unexpectedAuthorityRead = (): never => {
    throw new Error("producer-free reconstruction must not read current implementation authority");
  };
  return new Function(
    "path",
    "taskSpecs",
    "realpathSync",
    "taskArtifactRoots",
    "resolveRegularArtifactFile",
    "verifiedAncestorJsonArtifact",
    "validatePropertiesSchema",
    "validateImplementedPropertiesSchema",
    "configuredInvariantPrioritySelection",
    "derivePropertyImplementationCoverage",
    "formatSchemaValidationIssues",
    "readBoundedFinalReportJson",
    "replaceReportImplementationCoverage",
    "writeFileDurable",
    `${helper}; return reconstructAuthoritativeReportImplementationCoverage;`
  )(
    path,
    taskSpecs,
    fs.realpathSync,
    (_task: unknown, artifactDir: string) => [artifactDir],
    (_artifactRoot: string, candidate: string) => candidate,
    verifiedAncestorJsonArtifact,
    unexpectedAuthorityRead,
    unexpectedAuthorityRead,
    unexpectedAuthorityRead,
    unexpectedAuthorityRead,
    unexpectedAuthorityRead,
    (reportPath: string) => fs.readFileSync(reportPath, "utf8"),
    loadReportImplementationCoverageReplacer(),
    writeFileDurable
  ) as ReturnType<typeof loadReportImplementationCoverageReconstructor>;
}

function loadVerifiedAncestorJsonArtifact(
  taskSpecs: Array<{
    attemptId: string;
    metadata: { node: { logicalNodeId: string } };
    outputs: Array<{ path: string; contract: string }>;
  }>,
  assertVerifiedDependency: (task: unknown, dependency: string) => void
): (
  task: { dependencyArtifactDirs: string[] },
  logicalNodeId: string,
  relativePath: string,
  contract: string,
  historicalContract?: string
) => { path: string; value: unknown } | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifiedAncestorJsonArtifact");
  const helperEnd = source.indexOf("\n\nfunction configuredInvariantPrioritySelection", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "taskSpecs",
    "assertVerifiedDependency",
    "realpathSync",
    "resolveRegularArtifactFile",
    "readFileSync",
    `${helper}; return verifiedAncestorJsonArtifact;`
  )(
    path,
    taskSpecs,
    assertVerifiedDependency,
    fs.realpathSync,
    (_root: string, candidate: string) => candidate,
    fs.readFileSync
  ) as ReturnType<typeof loadVerifiedAncestorJsonArtifact>;
}

function loadFinalReportProducerNormalizers(): {
  normalizeReport: (contents: string) => string | undefined;
  normalizeFindings: (value: unknown) => unknown[] | undefined;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const findingArrayStart = source.indexOf("function normalizedFindingArray");
  const findingArrayEnd = source.indexOf("\n\nfunction writeNormalizedFindings", findingArrayStart);
  const findingStart = source.indexOf("function normalizeLegacyFindingRecord");
  const findingEnd = source.indexOf("\n\nfunction normalizeLegacyReportProvenance", findingStart);
  const reportStart = source.indexOf("function normalizeLegacyReportProvenanceFields");
  const reportEnd = source.indexOf("\n\nfunction normalizeLegacyGeneratedTestManifests", reportStart);
  assert.ok(findingArrayStart >= 0 && findingArrayEnd > findingArrayStart, source);
  assert.ok(findingStart >= 0 && findingEnd > findingStart, source);
  assert.ok(reportStart >= 0 && reportEnd > reportStart, source);

  const helper = ts.transpileModule(
    [
      source.slice(findingArrayStart, findingArrayEnd),
      source.slice(findingStart, findingEnd),
      source.slice(reportStart, reportEnd)
    ].join("\n\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return new Function(
    "normalizeEvidenceLineRangeCardinality",
    "normalizeFinalReportSeverityRecord",
    "validateArtifactContract",
    `${helper}; return { normalizeReport: normalizeLegacyReportProvenanceFields, normalizeFindings: normalizedFindingArray };`
  )(
    normalizeEvidenceLineRangeCardinality,
    (value: unknown) => ({ value, changed: false }),
    validateArtifactContract
  ) as ReturnType<typeof loadFinalReportProducerNormalizers>;
}

function loadValidatedTaskArtifactWriter(
  durableWriter: (filePath: string, contents: string | Uint8Array) => void = writeFileDurable
): (
  task: {
    metadata: { artifacts: { dir: string } };
    mirrorRoot: string;
  },
  output: { path: string; contract: string },
  contents: string
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const writerStart = source.indexOf("function writeValidatedTaskArtifactContents");
  const writerEnd = source.indexOf("\n\nfunction isPlainRecord", writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart, source);
  const helper = ts.transpileModule(source.slice(writerStart, writerEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "realpathSync",
    "existsSync",
    "validateArtifactContract",
    "isStrictlyInsideDirectory",
    "resolveRegularArtifactFile",
    "mirroredArtifactDir",
    "writeFileDurable",
    `${helper}; return writeValidatedTaskArtifactContents;`
  )(
    path,
    fs.realpathSync,
    fs.existsSync,
    validateArtifactContract,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, message: string) => {
      assertRegularFileInside(root, candidate, message);
      const resolved = fs.realpathSync(candidate);
      if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile()) {
        throw new Error(message);
      }
      return resolved;
    },
    (task: { mirrorRoot: string }) => task.mirrorRoot,
    durableWriter
  ) as ReturnType<typeof loadValidatedTaskArtifactWriter>;
}

function loadFinalReportArtifactMaterializer(
  options: {
    maximumJsonBytes?: number;
    open?: (filePath: string, flags: number) => number;
    fstat?: (descriptor: number) => { size: number; isFile: () => boolean };
    read?: (descriptor: number) => Buffer;
    close?: (descriptor: number) => void;
  } = {}
): (task: {
  metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  outputs: Array<{ path: string; contract: string }>;
  mirrorRoot: string;
}) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const materializerStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const helperEnd = source.indexOf("\n\nfunction normalizeLegacyFindingFields", materializerStart);
  const reportReaderStart = source.indexOf("function readBoundedFinalReportJson", helperEnd);
  const reportReaderEnd = source.indexOf(
    "\n\nfunction reconstructAuthoritativeReportImplementationCoverage",
    reportReaderStart
  );
  assert.ok(materializerStart >= 0 && helperEnd > materializerStart, source);
  assert.ok(reportReaderStart > helperEnd && reportReaderEnd > reportReaderStart, source);
  const helper = ts.transpileModule(
    [source.slice(materializerStart, helperEnd), source.slice(reportReaderStart, reportReaderEnd)].join("\n\n"),
    {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
    }
  ).outputText;
  return new Function(
    "path",
    "realpathSync",
    "openSync",
    "fstatSync",
    "readFileSync",
    "closeSync",
    "fsConstants",
    "existsSync",
    "taskArtifactRoots",
    "resolveRegularArtifactFile",
    "MAX_FINAL_REPORT_JSON_BYTES",
    "validateArtifactContract",
    "projectCanonicalFinalReport",
    "normalizeLegacyFindingRecord",
    "isStrictlyInsideDirectory",
    "mirroredArtifactDir",
    "writeFileDurable",
    `${helper}; return materializeMissingFinalReportArtifacts;`
  )(
    path,
    fs.realpathSync,
    options.open ?? ((filePath: string, flags: number) => fs.openSync(filePath, flags)),
    options.fstat ?? ((descriptor: number) => fs.fstatSync(descriptor)),
    options.read ?? ((descriptor: number) => fs.readFileSync(descriptor)),
    options.close ?? ((descriptor: number) => fs.closeSync(descriptor)),
    fs.constants,
    fs.existsSync,
    (task: { mirrorRoot: string }, canonicalRoot: string) => [canonicalRoot, task.mirrorRoot],
    (root: string, candidate: string, message: string) => {
      assertRegularFileInside(root, candidate, message);
      const resolved = fs.realpathSync(candidate);
      if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isFile()) {
        throw new Error(message);
      }
      return resolved;
    },
    options.maximumJsonBytes ?? 64 * 1024 * 1024,
    validateArtifactContract,
    projectCanonicalFinalReport,
    (value: unknown) => ({ value, changed: false }),
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (task: { mirrorRoot: string }) => task.mirrorRoot,
    writeFileDurable
  ) as ReturnType<typeof loadFinalReportArtifactMaterializer>;
}

function generatedFinalReportFixture(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_metadata: { run_id: "generated-final-report" },
    issues: [
      {
        schema_version: "1.0",
        id: "source-finding",
        title: "Generated projection mismatch",
        status: "confirmed",
        severity: "Medium",
        severity_guess: "Medium",
        confidence: "high",
        summary: "A bounded transition violates the expected relationship.",
        description: "A caller can trigger the bounded state mismatch.",
        impact: "Medium",
        impact_rationale: "The affected state remains bounded.",
        likelihood: "Low",
        likelihood_rationale: "The transition requires uncommon preconditions.",
        proof_of_concept: {
          scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."]
        },
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 4 }]
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: []
  };
}

function loadRetryFailureAwareArgs(): (
  args: { prompt?: unknown } | undefined,
  previousFailure: string | undefined
) => { prompt?: unknown } | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function renderEmbeddedPromptTemplate");
  const helperEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const retryFailureTemplate = fs
    .readFileSync(
      path.join(repositoryRoot, ".ultrafuzz", "prompts", "_templates", "agent-preamble", "retry-failure.mdx"),
      "utf8"
    )
    .trimEnd();
  return new Function("untrustedContentBoundary", "retryFailureTemplate", `${helper}; return retryFailureAwareArgs;`)(
    "UNTRUSTED CONTENT BOUNDARY",
    retryFailureTemplate
  ) as ReturnType<typeof loadRetryFailureAwareArgs>;
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

function loadMaterializeGeneratedTestCompanion(): (
  workspaceRoot: string,
  artifactRoot: string,
  nodeIds: readonly string[],
  relativePath: string
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function materializeGeneratedTestCompanion(");
  const helperEnd = source.indexOf("\n\n/**\n * Preserve the complete invariant suite", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source
    .slice(helperStart, helperEnd)
    .replaceAll("workspaceRoot: string", "workspaceRoot")
    .replaceAll("artifactRoot: string", "artifactRoot")
    .replaceAll("nodeIds: readonly string[]", "nodeIds")
    .replaceAll("relativePath: string", "relativePath")
    .replace("): void {", ") {");
  return new Function(
    "path",
    "existsSync",
    "readFileSync",
    "writeFileSync",
    "mkdirSync",
    "realpathSync",
    "statSync",
    "createHash",
    "isStrictlyInsideDirectory",
    "resolveNonEmptyRegularArtifactFile",
    "INVARIANT_TEST_ROOT_NAMES",
    `${helper}; return materializeGeneratedTestCompanion;`
  )(
    path,
    fs.existsSync,
    fs.readFileSync,
    fs.writeFileSync,
    fs.mkdirSync,
    fs.realpathSync,
    fs.statSync,
    createHash,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, missingMessage: string, emptyMessage: string) => {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(missingMessage);
      const resolved = fs.realpathSync(candidate);
      assertRegularFileInside(root, resolved, missingMessage);
      if (fs.statSync(resolved).size === 0) throw new Error(emptyMessage);
      return resolved;
    },
    ["test", "tests"] as const
  ) as (workspaceRoot: string, artifactRoot: string, nodeIds: readonly string[], relativePath: string) => void;
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
}) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const commandStart = source.indexOf("const unreachableCommitCountCommand");
  const commandEnd = source.indexOf("\n\nconst { Workflow", commandStart);
  const helperStart = source.indexOf("function preservePinnedSourceProof");
  const helperEnd = source.indexOf("\n\nfunction canonicalEmptyArtifact", helperStart);
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
    "existsSync",
    "readFileSync",
    "Buffer",
    "writeFileDurable",
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
    fs.existsSync,
    fs.readFileSync,
    Buffer,
    writeFileDurable,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    true,
    "refs/heads/ultrafuzz-pinned",
    command
  ) as (task: { attemptId: string; workspacePath: string; metadata: { artifacts: { dir: string } } }) => void;
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

  const helper = source
    .slice(helperStart, helperEnd)
    .replace(
      'workspaceRoot: string,\n  relativePath: string,\n  label: "scan probe" | "invariant source"\n): { bytes: Buffer; content: string } {',
      "workspaceRoot, relativePath, label) {"
    )
    .replace("let sourcePath: string;", "let sourcePath;")
    .replace("let content: string;", "let content;");
  return new Function(
    "path",
    "readFileSync",
    "isStrictlyInsideDirectory",
    "resolveRegularArtifactFile",
    "usesPinnedSource",
    "checkInvariantSourcePinned",
    "pinnedSourceRef",
    `${helper}; return readInvariantSourceSnapshot;`
  )(
    path,
    fs.readFileSync,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (_root: string, candidate: string) => candidate,
    usesPinnedSource,
    checkInvariantSourcePinned,
    "refs/heads/ultrafuzz-pinned"
  ) as (workspaceRoot: string, relativePath: string, label: string) => { bytes: Buffer; content: string };
}

function loadVerifyInvariantLedgerSourceEvidence(snapshotPaths: string[]): (
  task: {
    attemptId: string;
    workspacePath: string;
    outputs: readonly { path: string }[];
    metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  },
  artifactRoots: readonly string[]
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function verifyInvariantLedgerSourceEvidence");
  const helperEnd = source.indexOf("\n\nfunction normalizeInvariantSourceLines", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source
    .slice(helperStart, helperEnd)
    .replace("task: (typeof taskSpecs)[number], artifactRoots: readonly string[]): void {", "task, artifactRoots) {")
    .replace("let ledgerPath: string | undefined;", "let ledgerPath;")
    .replace("let parsed: unknown;", "let parsed;")
    .replace(" as unknown;", ";")
    .replaceAll(/new Map<[^>]*>\(\)/gu, "new Map()")
    .replaceAll("let probeStat: ReturnType<typeof lstatSync>;", "let probeStat;")
    .replaceAll("entry.source_location)!", "entry.source_location)")
    .replaceAll(")!.split(", ").split(");

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
    "readFileSync",
    "lstatSync",
    "realpathSync",
    "mkdirSync",
    "execFileSync",
    "createHash",
    "writeFileDurable",
    "resolveRegularArtifactFile",
    "validateInvariantLedgerSchema",
    "validateInvariantSourceProofSchema",
    "isSafeInvariantProbePath",
    "isStrictlyInsideDirectory",
    "invariantPathParentsInsideWorkspace",
    "readInvariantSourceSnapshot",
    "normalizeInvariantSourceLines",
    "symbolFromInvariantLocation",
    "invariantSymbolDeclaration",
    `${helper}; return verifyInvariantLedgerSourceEvidence;`
  )(
    path,
    fs.readFileSync,
    fs.lstatSync,
    fs.realpathSync,
    fs.mkdirSync,
    () => "0000000000000000000000000000000000000000\n",
    createHash,
    writeFileDurable,
    (_root: string, candidate: string) => candidate,
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
    () => undefined
  ) as (
    task: {
      attemptId: string;
      workspacePath: string;
      outputs: readonly { path: string }[];
      metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
    },
    artifactRoots: readonly string[]
  ) => void;
}

function invariantLedgerProbeFixture(probes: readonly Record<string, string>[]): {
  root: string;
  task: {
    attemptId: string;
    workspacePath: string;
    outputs: readonly { path: string }[];
    metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
  };
  artifactRoots: string[];
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-ledger-probe-")));
  const workspacePath = path.join(root, "workspace");
  const artifactDir = path.join(root, "run", "artifacts", "project-discovery");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(path.join(artifactDir, "setup"), { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "setup", "invariant-evidence-ledger.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [],
      inventory_rows: [],
      scan_probes: probes
    }),
    "utf8"
  );
  return {
    root,
    task: {
      attemptId: "attempt-project-discovery",
      workspacePath,
      outputs: [{ path: "setup/invariant-evidence-ledger.json" }],
      metadata: { node: { logicalNodeId: "project-discovery" }, artifacts: { dir: artifactDir } }
    },
    artifactRoots: [artifactDir]
  };
}

test("generated Smithers invariant ledger accepts a directory scan probe", () => {
  const snapshotPaths: string[] = [];
  const verify = loadVerifyInvariantLedgerSourceEvidence(snapshotPaths);
  const fixture = invariantLedgerProbeFixture([
    { id: "probe-tests-directory", source_path: "tests", query: "invariant harness scan", result: "Scanned tests" }
  ]);
  fs.mkdirSync(path.join(fixture.task.workspacePath, "tests"), { recursive: true });

  verify(fixture.task, fixture.artifactRoots);

  // A directory probe must never reach the regular-file snapshot; that call is what killed R45.
  assert.deepEqual(snapshotPaths, []);
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
  assert.throws(() => verify(fixture.task, fixture.artifactRoots), /scan probe is not a regular file/u);
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
  const helperStart = source.indexOf("function resolveNonEmptyRegularArtifactFile");
  const verifierStart = source.indexOf("function verifyGeneratedTestFiles");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(helperStart >= 0, source);
  assert.ok(verifierStart > helperStart, source);
  assert.ok(workflowStart > verifierStart, source);

  const helper = source.slice(helperStart, verifierStart);
  assert.match(source, /artifactContractDefinition,[\s\S]*assertRegularFileInside,[\s\S]*validateArtifactContract/u);
  assert.match(source, /validateArtifactContract,[\s\S]*writeFileDurable[\s\S]*= await import/u);
  assert.match(source, /assertRegularFileInside\(artifactDir, artifactPath, failureMessage\)/u);
  assert.match(helper, /resolveRegularArtifactFile\(artifactDir, artifactPath, missingFailureMessage\)/u);
  assert.match(helper, /statSync\(resolvedPath\)\.size === 0/u);
  assert.match(helper, /throw new Error\(emptyFailureMessage\)/u);

  const generatedTestVerifier = source.slice(verifierStart, workflowStart);
  assert.match(generatedTestVerifier, /resolveNonEmptyRegularArtifactFile\(/u);
  assert.match(generatedTestVerifier, /generated test file is empty \$\{relativePath\}/u);
});

test("generated Smithers workflow prepares canonical empty sidecars and primary findings", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const verifierStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(preparationStart >= 0, source);
  assert.ok(verifierStart > preparationStart, source);

  const preparation = source.slice(preparationStart, verifierStart);
  assert.match(preparation, /function canonicalEmptyArtifact/u);
  assert.match(preparation, /output\.primary && output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(
    preparation,
    /output\.contract === "ultrafuzz\/invariant-ledger@1" \|\| output\.contract === "ultrafuzz\/properties@1"/u
  );
  assert.match(preparation, /source-completeness and provenance joins/u);
  assert.match(preparation, /artifactContractDefinition\(output\.contract\)\.validEmptyExample/u);
  assert.match(source, /id=\{task\.preparationId\}/u);
  assert.match(source, /dependsOn=\{\[task\.preparationId\]\}/u);
});

test("generated Smithers restores sealed submodules before inputs and only verifies them after agent work", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const preparationEnd = source.indexOf("\n\nfunction preservePinnedSourceProof", preparationStart);
  const agentStart = source.indexOf("function artifactAwareAgent");
  const agentEnd = source.indexOf("function resetTaskArtifactsForRetry", agentStart);
  assert.ok(preparationStart >= 0, source);
  assert.ok(preparationEnd > preparationStart, source);
  assert.ok(agentStart >= 0, source);
  assert.ok(agentEnd > agentStart, source);

  const preparation = source.slice(preparationStart, preparationEnd);
  const agent = source.slice(agentStart, agentEnd);
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
  assert.match(
    agent,
    /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, pinnedSubmodules: "verify" \}\)/u
  );
});

test("generated Smithers workflow leaves runtime-owned workspace patch outputs unmaterialized", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function canonicalEmptyArtifact");
  const helperEnd = source.indexOf("\n\nfunction materializeMissingMarkdownArtifacts", helperStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /output\.path === "workspace\.patch" \|\| output\.path === "workspace-patch\.json"/u);
  assert.match(helper, /runtime-owned workspace patch outputs/u);
});

test("generated Smithers workflow leaves the runtime-owned vulnerability-db snapshot manifest unmaterialized", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function canonicalEmptyArtifact");
  const helperEnd = source.indexOf("\n\nfunction materializeMissingMarkdownArtifacts", helperStart);

  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);

  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /output\.path === "vulnerability-db-manifest\.json"/u);
  assert.match(helper, /conflict with the exclusive canonical bytes the snapshot publishes/u);
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

test("generated Smithers input avoids runner-reserved persistence fields", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const schemaStart = source.indexOf("const inputSchema = z.strictObject");
  const schemaEnd = source.indexOf("const taskOutput", schemaStart);

  assert.ok(schemaStart >= 0, source);
  assert.ok(schemaEnd > schemaStart, source);
  assert.doesNotMatch(source.slice(schemaStart, schemaEnd), /\brun_id\s*:/u);
  assert.match(source, /Smithers reserves `run_id`/u);
  assert.match(source, /Smithers persistence represents absent top-level workflow inputs as null/u);
  assert.match(source.slice(schemaStart, schemaEnd), /\.nullish\(\)[\s\S]*?value \?\? undefined/u);
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
  const workflowStart = source.indexOf("export default smithers");
  assert.ok(helperStart >= 0, source);
  assert.ok(workflowStart > helperStart, source);
  assert.match(source.slice(helperStart, workflowStart), /\.join\("\\n"\)/u);
  assert.match(source, /invariantSymbolDeclaration[\s\S]*?\.split\(\/\\r\?\\n\/u\)/u);
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
  const proofEnd = source.indexOf("\n\nfunction canonicalEmptyArtifact", proofStart);
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(proofStart > preparationStart, source);
  assert.ok(proofEnd > proofStart, source);
  assert.ok(workflowStart > proofStart, source);
  assert.match(source, /const pinnedSourceBranch = "ultrafuzz-pinned"/u);
  assert.match(source, /baseBranch=\{usesPinnedSource \? pinnedSourceBranch : localSourceCommit\}/u);
  assert.match(source, /function resolveLocalSourceCommit\(\): string \| undefined/u);
  assert.match(source, /if \(usesPinnedSource\) return undefined/u);
  assert.match(source, /\/\^\[0-9a-f\]\{40\}\$\/u\.test\(commit\)/u);
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

test("generated Smithers pinned source proof ignores unrelated same-commit Ultrafuzz refs", () => {
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

    fs.writeFileSync(proofPath, JSON.stringify(canonicalProof));
    assert.throws(() => preservePinnedSourceProof(task), /pinned source proof property-specification-certora changed/u);

    const legacyNoisyProof = {
      ...canonicalProof,
      refs: [
        { name: "refs/heads/ultrafuzz-pinned", object: pinnedCommit },
        { name: "refs/heads/ultrafuzz/test-run/actors-flows", object: pinnedCommit }
      ]
    };
    fs.writeFileSync(proofPath, `${JSON.stringify(legacyNoisyProof, null, 2)}\n`);
    git(["branch", "ultrafuzz/test-run/property-specification-crytic", pinnedCommit]);
    assert.doesNotThrow(() => preservePinnedSourceProof(task));

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

test("retry feedback changes only the execution-time prompt section inside the untrusted boundary", () => {
  const retryFailureAwareArgs = loadRetryFailureAwareArgs();
  const renderedPrompt = "trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\ntrusted runtime\n\nrendered task";
  const firstAttempt = retryFailureAwareArgs({ prompt: renderedPrompt }, undefined);
  const secondAttempt = retryFailureAwareArgs({ prompt: renderedPrompt }, "Error: deterministic verifier failure");

  assert.deepEqual(firstAttempt, { prompt: renderedPrompt });
  assert.equal(typeof secondAttempt?.prompt, "string");
  const injected = String(secondAttempt?.prompt);
  assert.ok(injected.startsWith("trusted preamble\n\nUNTRUSTED CONTENT BOUNDARY\n\n"), injected);
  assert.match(injected, /## Untrusted prior-attempt failure[\s\S]*deterministic verifier failure/u);
  assert.ok(injected.indexOf("deterministic verifier failure") < injected.indexOf("trusted runtime"), injected);
  assert.equal(
    injected.replace(/## Untrusted prior-attempt failure[\s\S]*?## Current task instructions\n\n/u, ""),
    renderedPrompt
  );
  assert.throws(
    () => retryFailureAwareArgs({ prompt: "prompt without boundary" }, "failure"),
    /cannot locate the untrusted-content boundary/u
  );
});

test("retry feedback diagnostics are secret-redacted and UTF-8 byte bounded before prompt injection", () => {
  const diagnostic = normalizeNodeAttemptFailureMessage(
    `verifier rejected token=sk-${"x".repeat(48)} ${"界".repeat(MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES)}`
  );
  assert.ok(diagnostic);
  assert.match(diagnostic, /<redacted>/u);
  assert.doesNotMatch(diagnostic, /sk-x/u);
  assert.ok(Buffer.byteLength(diagnostic, "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES);

  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agent = source.slice(
    source.indexOf("function artifactAwareAgent"),
    source.indexOf("function retryFailureText")
  );
  assert.match(agent, /catch \(error\)[\s\S]*normalizeNodeAttemptFailureMessage\(retryFailureText\(error\)\)/u);
  assert.ok(
    agent.indexOf("retryFailureAwareArgs(args, previousFailure)") < agent.indexOf("agent.generate(attemptArgs)")
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

test("generated Smithers retries reset exact task-owned artifact contents after the first attempt", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const rootsStart = source.indexOf("function resetTaskArtifactsForRetry");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(rootsStart > agentStart, source);
  assert.ok(preparationStart > rootsStart, source);

  const agent = source.slice(agentStart, rootsStart);
  assert.match(agent, /if \(\(args\?\.taskContext\?\.attempt \?\? 1\) > 1\)/u);
  assert.ok(
    agent.indexOf("resetTaskArtifactsForRetry(task)") < agent.indexOf("await agent.generate(attemptArgs)"),
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
  assert.match(reset, /output\.contract === "ultrafuzz\/generated-tests@1"/u);
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
  assert.match(reset, /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false \}\)/u);
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

test("generated Smithers agent preserves its final response as missing non-report Markdown", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const preparationStart = source.indexOf("function prepareArtifactMirror");

  assert.ok(agentStart >= 0, source);
  assert.ok(preparationStart > agentStart, source);

  const agent = source.slice(agentStart, preparationStart);
  assert.match(agent, /const result = await agent\.generate\(attemptArgs\)/u);
  assert.match(
    agent,
    /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, pinnedSubmodules: "verify" \}\)/u
  );
  assert.match(agent, /materializeMissingMarkdownArtifacts\(task, result\)/u);
  assert.match(agent, /materializeCanonicalThreatModelArtifact\(task\)/u);
  assert.match(agent, /reconstructAuthoritativeReportImplementationCoverage\(task\)/u);
  assert.match(agent, /materializeMissingFinalReportArtifacts\(task\)/u);
  assert.match(agent, /normalizeFindingProvenance\(task\)/u);
  assert.match(agent, /normalizeLegacyReportProvenance\(task\)/u);
  assert.match(agent, /normalizeLegacyGeneratedTestManifests\(task\)/u);
  assert.match(agent, /materializeGeneratedTestCompanions\(task\)/u);
  assert.match(agent, /verifyArtifacts\(task, \{ agentReturned: true \}\)/u);
  assert.ok(
    agent.indexOf("normalizeLegacyFindingFields(task)") <
      agent.indexOf("reconstructAuthoritativeReportImplementationCoverage(task)")
  );
  assert.ok(
    agent.indexOf("reconstructAuthoritativeReportImplementationCoverage(task)") <
      agent.indexOf("normalizeLegacyReportProvenance(task)")
  );
  assert.ok(
    agent.indexOf("normalizeLegacyReportProvenance(task)") <
      agent.indexOf("materializeMissingFinalReportArtifacts(task)")
  );
  assert.ok(
    agent.indexOf("materializeMissingFinalReportArtifacts(task)") <
      agent.indexOf("verifyArtifacts(task, { agentReturned: true })")
  );
  assert.match(source, /output\.contract !== "ultrafuzz\/nonempty-markdown@1"/u);
  assert.match(source, /const fallback = `# \$\{title\}\\n\\n\$\{summary\}\\n`/u);
});

test("generated Smithers verifier serializes human producer IDs and preserves review source unions", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const resetStart = source.indexOf("function resetTaskArtifactsForRetry");
  const provenanceStart = source.indexOf("function normalizeFindingProvenance");
  const legacyArrayStart = source.indexOf("function normalizeLegacyFindingArray");
  assert.ok(agentStart >= 0 && resetStart > agentStart, source);
  assert.ok(provenanceStart > agentStart && legacyArrayStart > provenanceStart, source);
  const agent = source.slice(agentStart, resetStart);
  assert.ok(
    agent.indexOf("normalizeFindingProvenance(task)") < agent.indexOf("verifyArtifacts(task, { agentReturned: true })"),
    agent
  );
  const provenance = source.slice(provenanceStart, legacyArrayStart);
  assert.match(provenance, /producerNodeId = task\.metadata\.node\.producerNodeId \?\? task\.attemptId/u);
  assert.match(provenance, /relativePath: output\.path/u);
  assert.match(provenance, /preserveSourceNodes/u);
  assert.match(provenance, /requireSourceNodes: preserveSourceNodes/u);
  assert.match(provenance, /buildFindingSourceExpectations/u);
  assert.match(provenance, /requireLifecycleCoverage/u);
  assert.match(provenance, /sourceExpectations: sourceProvenance\?\.expectations/u);
  assert.match(provenance, /requireSourceExpectation: preserveSourceNodes/u);
  assert.match(provenance, /"dedupe-findings", "triage", "severity-classification", "final-report"/u);
  assert.match(source, /normalizeReportFindingSourceNodes/u);
  assert.match(source, /report finding does not match dependency provenance/u);
});

test("generated Smithers verifier canonicalizes threat Markdown and materializes verified selected database records before sealing outputs", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const agentStart = source.indexOf("function artifactAwareAgent");
  const resetStart = source.indexOf("function resetTaskArtifactsForRetry");
  const canonicalStart = source.indexOf("function materializeCanonicalThreatModelArtifact");
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");

  assert.ok(agentStart >= 0 && resetStart > agentStart, source);
  assert.ok(canonicalStart > agentStart && canonicalStart < verifierStart, source);
  assert.ok(workflowStart > verifierStart, source);

  const agent = source.slice(agentStart, resetStart);
  assert.ok(
    agent.indexOf("materializeCanonicalThreatModelArtifact(task)") <
      agent.indexOf("verifyArtifacts(task, { agentReturned: true })"),
    agent
  );
  assert.ok(
    agent.indexOf("materializeGoalPlanDatabaseArtifacts(task)") <
      agent.indexOf("verifyArtifacts(task, { agentReturned: true })"),
    agent
  );
  const canonical = source.slice(canonicalStart, verifierStart);
  assert.match(canonical, /logicalNodeId !== "threat-model"/u);
  assert.match(canonical, /const runRoot = realpathSync\(path\.resolve\(artifactDir, "\.\.", "\.\."\)\)/u);
  assert.match(canonical, /const workspaceRoot = realpathSync\(task\.workspacePath\)/u);
  assert.match(canonical, /verifyThreatModelVulnerabilityDatabaseCapabilities\(artifactRoot, runRoot\)/u);
  assert.match(canonical, /verifyThreatModelEvidenceFiles\(model, workspaceRoot\)/u);
  assert.match(canonical, /materializeCanonicalThreatModelMarkdown\(artifactRoot\)/u);
  assert.match(canonical, /logicalNodeId !== "goal-plan"/u);
  assert.match(
    canonical,
    /materializeGoalPlanVulnerabilityDatabaseSnapshots\(artifactRoot, \{\s*threatModelArtifactDirs,\s*runRoot,\s*maxDynamicNodes\s*\}\)/u
  );

  const verifier = source.slice(verifierStart, workflowStart);
  assert.match(verifier, /output\.contract === "ultrafuzz\/goal-plan@1"/u);
  assert.match(verifier, /verifyGoalPlanSelectedRecordSnapshots\(artifactRoot, validation\.value\)/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, selected\.path, selected\.contents\)/u);
});

test("generated Smithers coverage reconstruction bounds report JSON before parsing", () => {
  const readReport = loadBoundedFinalReportReader();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-bounded-report-json-"));
  const small = path.join(root, "small.json");
  const oversized = path.join(root, "oversized.json");
  const symlink = path.join(root, "symlink.json");
  try {
    fs.writeFileSync(small, '{"schema_version":"1.0"}\n');
    fs.writeFileSync(oversized, "{}");
    fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);
    fs.symlinkSync(small, symlink);

    assert.equal(readReport(small), '{"schema_version":"1.0"}\n');
    assert.throws(readReport.bind(undefined, oversized), /exceeds the 67108864-byte read limit/u);
    assert.throws(readReport.bind(undefined, symlink));

    const source = fs.readFileSync(workflowTemplatePath, "utf8");
    assert.match(source, /openSync\(reportPath, fsConstants\.O_RDONLY \| fsConstants\.O_NOFOLLOW\)/u);
    assert.match(source, /contents\.byteLength > MAX_FINAL_REPORT_JSON_BYTES/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers final-report producer replaces model coverage with canonical handoff coverage", () => {
  const replaceCoverage = loadReportImplementationCoverageReplacer();
  const catalog = {
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-high",
        description: "The high-priority accounting relation holds.",
        category: "accounting",
        priority: "high" as const,
        sources: [{ source_node_id: "lens-high", source_property_id: "accounting-relation" }]
      },
      {
        id: "property-low-reference",
        description: "The below-threshold reference behavior remains reachable.",
        category: "liveness",
        priority: "low" as const,
        reference_expectations: ["benchmark:low-reference"],
        sources: [{ source_node_id: "lens-low", source_property_id: "reference-behavior" }]
      }
    ]
  };
  const implementation = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    selection: {
      priority_threshold: "high" as const,
      priorities: ["high" as const],
      property_ids: ["property-high", "property-low-reference"]
    },
    properties: [
      {
        property_id: "property-high",
        status: "implemented" as const,
        implementation_paths: ["src/Properties.sol"],
        test_paths: []
      },
      {
        property_id: "property-low-reference",
        status: "implemented" as const,
        implementation_paths: [],
        test_paths: ["test/ReferenceProperty.t.sol"],
        reference_expectations: ["benchmark:low-reference"]
      }
    ]
  };
  const derived = derivePropertyImplementationCoverage(catalog, implementation, {
    configuredSelection: { priority_threshold: "high", priorities: ["high"] },
    requireConfiguredSelection: true
  });
  assert.equal(derived.ok, true, JSON.stringify(derived.issues));
  assert.ok(derived.value);
  assert.deepEqual(derived.value, {
    priority_threshold: "high",
    priorities: ["high"],
    selected_property_ids: ["property-high", "property-low-reference"],
    implemented_property_ids: ["property-high", "property-low-reference"],
    blocked_property_ids: [],
    pending_property_ids: [],
    deferred_property_ids: [],
    reference_expected_property_ids: ["property-low-reference"],
    reference_expectation_ids: ["benchmark:low-reference"],
    blocker_summaries: []
  });
  assert.ok(derived.value.priorities.length > 0, "authoritative priorities must never collapse to an empty set");
  for (const field of [
    "selected_property_ids",
    "implemented_property_ids",
    "blocked_property_ids",
    "pending_property_ids",
    "deferred_property_ids",
    "reference_expected_property_ids",
    "reference_expectation_ids",
    "blocker_summaries"
  ] as const) {
    assert.ok(Array.isArray(derived.value[field]), `authoritative coverage must always emit ${field}`);
  }

  // Exact recurrence of run 31315460119: the model supplied an invalid
  // threshold, no priorities, and omitted deferred_property_ids entirely.
  const modelReport = {
    schema_version: "1.0",
    run_metadata: { run_id: "31315460119" },
    issues: [],
    non_production_outcomes: [],
    property_implementation_coverage: {
      priority_threshold: "critical",
      priorities: [],
      selected_property_ids: ["model-owned-value"],
      implemented_property_ids: [],
      blocked_property_ids: [],
      pending_property_ids: []
    }
  };
  const modelBytes = `${JSON.stringify(modelReport, null, 2)}\n`;
  assert.equal(validateArtifactContract("ultrafuzz/report@1", modelBytes, "report.json").ok, false);

  const replaced = replaceCoverage(modelBytes, derived.value);
  assert.ok(replaced);
  assert.equal(validateArtifactContract("ultrafuzz/report@1", replaced, "report.json").ok, true);
  assert.equal(
    replaced,
    `${JSON.stringify({ ...modelReport, property_implementation_coverage: derived.value }, null, 2)}\n`
  );
  assert.deepEqual(JSON.parse(replaced).property_implementation_coverage, derived.value);
  assert.equal(replaceCoverage(replaced, derived.value), replaced, "canonical replacement must be byte-idempotent");
  assert.equal(replaceCoverage("{malformed", derived.value), undefined);

  const unrelatedInvalid = replaceCoverage(JSON.stringify({ ...modelReport, run_metadata: [] }), derived.value);
  assert.ok(unrelatedInvalid);
  assert.equal(
    validateArtifactContract("ultrafuzz/report@1", unrelatedInvalid, "report.json").ok,
    false,
    "coverage reconstruction must not forgive unrelated report violations"
  );
});

test("generated Smithers coverage authority preserves the shipped smoke topology without a producer", () => {
  const topology = loadTopology(repositoryRoot, {
    topologyPath: path.join(repositoryRoot, "packages", "config", "topologies", "smoke.yml"),
    requirePromptFiles: true
  });
  const finalReport = topology.nodes.find((node) => node.id === "final-report");
  assert.ok(finalReport);
  const taskSpecs = topology.nodes
    .filter((node) => node.kind === "agentic")
    .map((node) => ({
      attemptId: node.id,
      metadata: { node: { logicalNodeId: node.id } },
      outputs: (node.outputs ?? []).map((output) => ({ path: output.path, contract: output.contract }))
    }));
  assert.equal(
    taskSpecs.some((candidate) => candidate.metadata.node.logicalNodeId === "stateful-invariant-implement-properties"),
    false,
    "the shipped smoke topology must exercise the genuinely absent-producer path"
  );

  const ancestors = new Set<string>();
  const nodesById = new Map(topology.nodes.map((node) => [node.id, node]));
  const pending = [...finalReport.depends_on];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    pending.push(...(nodesById.get(candidate)?.depends_on ?? []));
  }
  let verificationCount = 0;
  const readAncestor = loadVerifiedAncestorJsonArtifact(taskSpecs, () => {
    verificationCount += 1;
  });
  assert.equal(
    readAncestor(
      {
        dependencyArtifactDirs: [...ancestors].map((ancestor) =>
          path.join(repositoryRoot, ".ultrafuzz", "runs", "smoke", "artifacts", ancestor)
        )
      },
      "stateful-invariant-implement-properties",
      "implemented-properties.json",
      "ultrafuzz/implemented-properties@2",
      "ultrafuzz/implemented-properties@1"
    ),
    undefined
  );
  assert.equal(verificationCount, 0, "absent authority must not reinterpret another smoke artifact as coverage");

  const replaceCoverage = loadReportImplementationCoverageReplacer();
  let reconstructionAuthorityReads = 0;
  const reconstructCoverage = loadReportImplementationCoverageReconstructor(
    taskSpecs,
    (_task, logicalNodeId, relativePath, contract, historicalContract) => {
      reconstructionAuthorityReads += 1;
      assert.equal(logicalNodeId, "stateful-invariant-implement-properties");
      assert.equal(relativePath, "implemented-properties.json");
      assert.equal(contract, "ultrafuzz/implemented-properties@2");
      assert.equal(historicalContract, "ultrafuzz/implemented-properties@1");
      return undefined;
    }
  );
  const invalidCoverageCases = [
    {
      runId: "31338426579",
      coverage: {
        priority_threshold: "high",
        priorities: [],
        selected_property_ids: [],
        implemented_property_ids: [],
        blocked_property_ids: [],
        pending_property_ids: [],
        deferred_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: []
      },
      failure: /Too small: expected array to have >=1 items/u
    },
    {
      runId: "31339777943",
      coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: [],
        implemented_property_ids: [],
        blocked_property_ids: [],
        pending_property_ids: [],
        reference_expected_property_ids: [],
        reference_expectation_ids: [],
        blocker_summaries: []
      },
      failure: /expected array, received undefined/u
    }
  ];
  for (const fixture of invalidCoverageCases) {
    const modelReport = {
      schema_version: "1.0",
      run_metadata: { run_id: fixture.runId },
      issues: [],
      non_production_outcomes: [],
      property_implementation_coverage: fixture.coverage
    };
    const modelBytes = `${JSON.stringify(modelReport, null, 2)}\n`;
    const modelValidation = validateArtifactContract("ultrafuzz/report@1", modelBytes, "report.json");
    assert.equal(modelValidation.ok, false, fixture.runId);
    assert.match(modelValidation.issues.map((issue) => issue.message).join("; "), fixture.failure, fixture.runId);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ultrafuzz-producer-free-coverage-${fixture.runId}-`));
    const reportPath = path.join(root, "report.json");
    try {
      fs.writeFileSync(reportPath, modelBytes);
      reconstructCoverage({
        metadata: { node: { logicalNodeId: "final-report" }, artifacts: { dir: root } },
        outputs: [{ path: "report.json", contract: "ultrafuzz/report@1" }]
      });
      const canonical = fs.readFileSync(reportPath, "utf8");
      assert.equal(validateArtifactContract("ultrafuzz/report@1", canonical, "report.json").ok, true, fixture.runId);
      assert.equal(
        JSON.parse(canonical).property_implementation_coverage,
        "unavailable",
        `${fixture.runId} must use the canonical no-coverage sentinel`
      );
      assert.equal(
        replaceCoverage(canonical, "unavailable"),
        canonical,
        "canonical no-coverage replacement must be byte-idempotent"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(reconstructionAuthorityReads, invalidCoverageCases.length);
});

test("generated Smithers coverage authority fails closed except for an explicit historical handoff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-report-coverage-authority-"));
  const dependency = path.join(root, "implementation-attempt");
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, "implemented-properties.json"), JSON.stringify({ authoritative: true }));
  const producer = {
    attemptId: "implementation-attempt",
    metadata: { node: { logicalNodeId: "stateful-invariant-implement-properties" } },
    outputs: [
      {
        path: "implemented-properties.json",
        contract: "ultrafuzz/implemented-properties@2"
      }
    ]
  };
  let verificationFailure = false;
  let verificationCount = 0;
  const producers = [producer];
  const readAncestor = loadVerifiedAncestorJsonArtifact(producers, (_task, verifiedDependency) => {
    verificationCount += 1;
    assert.equal(verifiedDependency, dependency);
    if (verificationFailure) throw new Error("unverified dependency");
  });
  const finalReportTask = { dependencyArtifactDirs: [dependency] };
  const readCurrent = (): { path: string; value: unknown } | undefined =>
    readAncestor(
      finalReportTask,
      "stateful-invariant-implement-properties",
      "implemented-properties.json",
      "ultrafuzz/implemented-properties@2",
      "ultrafuzz/implemented-properties@1"
    );

  try {
    assert.deepEqual(readCurrent()?.value, { authoritative: true });
    assert.equal(verificationCount, 1);

    producer.outputs[0]!.contract = "ultrafuzz/implemented-properties@1";
    assert.equal(readCurrent(), undefined, "a declared historical @1 handoff keeps legacy behavior");
    assert.equal(verificationCount, 1, "historical bytes are not reinterpreted as current coverage authority");

    const historicalReportRoot = path.join(root, "historical-report");
    fs.mkdirSync(historicalReportRoot);
    const historicalReportPath = path.join(historicalReportRoot, "report.json");
    const historicalReport = `${JSON.stringify(
      { schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] },
      null,
      2
    )}\n`;
    fs.writeFileSync(historicalReportPath, historicalReport);
    const reconstructHistorical = loadReportImplementationCoverageReconstructor([producer], () => undefined);
    reconstructHistorical({
      metadata: { node: { logicalNodeId: "final-report" }, artifacts: { dir: historicalReportRoot } },
      outputs: [{ path: "report.json", contract: "ultrafuzz/report@1" }]
    });
    assert.equal(
      fs.readFileSync(historicalReportPath, "utf8"),
      historicalReport,
      "a declared historical producer must not be rewritten as a producer-free topology"
    );

    producer.outputs = [];
    assert.throws(readCurrent, /authoritative implemented-properties\.json handoff is unavailable/u);

    producer.outputs = [
      { path: "implemented-properties.json", contract: "ultrafuzz/implemented-properties@unexpected" }
    ];
    assert.throws(readCurrent, /declares unexpected contract/u);

    producer.outputs[0]!.contract = "ultrafuzz/implemented-properties@2";
    finalReportTask.dependencyArtifactDirs = [];
    assert.throws(readCurrent, /authoritative implemented-properties\.json handoff is unavailable/u);

    finalReportTask.dependencyArtifactDirs = [dependency];
    const alternateDependency = path.join(root, "implementation-attempt-alternate");
    fs.mkdirSync(alternateDependency);
    fs.writeFileSync(
      path.join(alternateDependency, "implemented-properties.json"),
      JSON.stringify({ authoritative: "alternate" })
    );
    producers.push({
      attemptId: "implementation-attempt-alternate",
      metadata: { node: { logicalNodeId: "stateful-invariant-implement-properties" } },
      outputs: [
        {
          path: "implemented-properties.json",
          contract: "ultrafuzz/implemented-properties@2"
        }
      ]
    });
    finalReportTask.dependencyArtifactDirs = [dependency, alternateDependency];
    assert.throws(readCurrent, /authoritative implemented-properties\.json handoff is ambiguous/u);

    producers.pop();
    finalReportTask.dependencyArtifactDirs = [dependency];
    fs.writeFileSync(path.join(dependency, "implemented-properties.json"), "{malformed");
    assert.throws(readCurrent, /authoritative implemented-properties\.json handoff is malformed/u);

    fs.writeFileSync(path.join(dependency, "implemented-properties.json"), JSON.stringify({ authoritative: true }));
    verificationFailure = true;
    assert.throws(readCurrent, /unverified dependency/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers final-report normalization emits canonical report and sidecar bytes", () => {
  const { normalizeReport, normalizeFindings } = loadFinalReportProducerNormalizers();
  const independentDetail = "  The source span establishes the bounded StableSwap loop.  ";
  const report = {
    schema_version: "1.0",
    run_metadata: { run_id: "stableswap-singleton-range" },
    issues: [
      {
        schema_version: "1.0",
        id: "M-01",
        title: "[M-01] - StableSwap loop boundary",
        status: "confirmed",
        severity_guess: "Medium",
        confidence: "medium",
        summary: "A bounded loop is anchored to one source span.",
        evidence: [
          "scope",
          {
            kind: "source",
            path: "contracts/main/CurveStableSwapNG.vy",
            detail: independentDetail,
            line_ranges: [{ line: 318, end_line: 337 }]
          }
        ]
      }
    ],
    non_production_outcomes: []
  };
  const rawReportBytes = `${JSON.stringify(report, null, 2)}\n`;
  assert.equal(validateArtifactContract("ultrafuzz/report@1", rawReportBytes, "report.json").ok, false);

  const canonicalReport = {
    ...report,
    issues: [
      {
        ...report.issues[0]!,
        evidence: [
          "scope",
          {
            kind: "source",
            path: "contracts/main/CurveStableSwapNG.vy",
            detail: independentDetail,
            line: 318,
            end_line: 337
          }
        ]
      }
    ]
  };
  const expectedReportBytes = `${JSON.stringify(canonicalReport, null, 2)}\n`;

  const normalizedReportBytes = normalizeReport(rawReportBytes);
  assert.equal(normalizedReportBytes, expectedReportBytes);
  assert.equal(
    createHash("sha256").update(normalizedReportBytes!).digest("hex"),
    "4c6b608ee8e06f5b96afc145ef64030d1e3a1fc81602308a8a3474c93146b21b"
  );
  const normalizedFindings = normalizeFindings(JSON.parse(normalizedReportBytes!).issues);
  assert.deepEqual(normalizedFindings, canonicalReport.issues);
  const normalizedSidecarBytes = `${JSON.stringify(normalizedFindings, null, 2)}\n`;
  assert.equal(normalizedSidecarBytes, `${JSON.stringify(canonicalReport.issues, null, 2)}\n`);
  assert.equal(
    createHash("sha256").update(normalizedSidecarBytes).digest("hex"),
    "21413a3a47d1253ca7ef4f5af0950f7884d1ba5a8b3bd740d6e85f5a400e925c"
  );
  assert.equal(validateArtifactContract("ultrafuzz/report@1", normalizedReportBytes!, "report.json").ok, true);
  assert.equal(
    validateArtifactContract("ultrafuzz/findings@1", normalizedSidecarBytes, "findings.normalized.json").ok,
    true
  );
  assert.deepEqual(JSON.parse(normalizedReportBytes!).issues[0].evidence[1], canonicalReport.issues[0]!.evidence[1]);
  assert.equal(JSON.parse(normalizedReportBytes!).issues[0].evidence[1].detail, independentDetail);
  assert.equal(normalizeReport(normalizedReportBytes!), undefined, "canonical bytes are idempotent");
});

test("generated Smithers agent retains validated strategy findings when dedupe output is missing", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const fallbackStart = source.indexOf("function materializeMissingDedupeArtifact");
  const finalReportStart = source.indexOf("function materializeMissingFinalReportArtifacts");

  assert.ok(fallbackStart >= 0, source);
  assert.ok(finalReportStart > fallbackStart, source);

  const fallback = source.slice(fallbackStart, finalReportStart);
  assert.match(fallback, /logicalNodeId !== "dedupe-findings"/u);
  assert.match(fallback, /candidate\.primary && candidate\.path === "deduped-findings\.json"/u);
  assert.match(fallback, /output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(fallback, /validation\.value\.length > 0/u);
  assert.match(fallback, /task\.metadata\.dependencies\.attemptIds/u);
  assert.match(fallback, /validateArtifactContract\(\s*"ultrafuzz\/findings@1"/u);
  assert.match(fallback, /normalizeLegacyFindingArray\(contents\)/u);
  assert.match(fallback, /writeFileDurable\(candidatePath, normalized\)/u);
  assert.match(fallback, /retained\.push\(\.\.\.validation\.value\)/u);
  assert.match(fallback, /JSON\.stringify\(retained, null, 2\)/u);
  assert.match(fallback, /writeFileDurable\(outputPath, serialized\)/u);
  assert.doesNotMatch(fallback, /writeFileSync\(/u);
});

test("durable dedupe recovery replaces a symlink without overwriting its target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dedupe-recovery-"));
  try {
    const symlinkTarget = path.join(root, "target.json");
    const recoveredOutput = path.join(root, "deduped-findings.json");
    fs.writeFileSync(symlinkTarget, "target remains unchanged\n");
    fs.symlinkSync(symlinkTarget, recoveredOutput);

    writeFileDurable(recoveredOutput, "[]\n");

    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "target remains unchanged\n");
    assert.equal(fs.lstatSync(recoveredOutput).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(recoveredOutput, "utf8"), "[]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers agent fails closed instead of promoting dedupe findings into a final report", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const fallbackStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const reportReaderStart = source.indexOf("function validatedFinalReport");

  assert.ok(fallbackStart >= 0, source);
  assert.ok(reportReaderStart > fallbackStart, source);

  const fallback = source.slice(fallbackStart, reportReaderStart);
  assert.match(fallback, /logicalNodeId !== "final-report"/u);
  assert.match(fallback, /candidate\.path === "report\.json" && candidate\.contract === "ultrafuzz\/report@1"/u);
  assert.match(
    fallback,
    /candidate\.path === "report\.md" && candidate\.contract === "ultrafuzz\/nonempty-markdown@1"/u
  );
  assert.match(fallback, /candidate\.path === "findings\.normalized\.json"/u);
  assert.match(fallback, /recoverableOutputs\.some\(\(output\) => finalReportOutputNeedsRecovery/u);
  assert.match(fallback, /if \(report === undefined\) \{[\s\S]*?return;\s*\}/u);
  assert.match(fallback, /const projection = projectCanonicalFinalReport\(report\)/u);
  assert.match(fallback, /writeValidatedTaskArtifact\(task, reportOutput, projection\.report\)/u);
  assert.match(fallback, /const findings = normalizedFindingArray\(projection\.report\.issues\)/u);
  assert.match(fallback, /writeValidatedTaskArtifactContents\(task, markdownOutput, projection\.markdown\)/u);
  assert.doesNotMatch(
    fallback,
    /dedupe-findings|retainedDedupeFindings|normalizedFindingsArtifact|recoveredReport|artifact_recovery/u
  );
  assert.ok(
    fallback.indexOf("finalReportOutputNeedsRecovery(artifactRoots, output)") <
      fallback.indexOf("projectCanonicalFinalReport(report)"),
    fallback
  );
  assert.doesNotMatch(source, /function normalizedFallbackReportIssue|issue\.impact =|issue\.likelihood =/u);
});

test("generated Smithers agent projects final-report Markdown only from validated final-review JSON", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const markdownStart = source.indexOf("function materializeMissingMarkdownArtifacts");
  const summaryStart = source.indexOf("function agentResultSummary");
  const finalReportStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const reportReaderStart = source.indexOf("function validatedFinalReport");
  const reportReaderEnd = source.indexOf("\n\nfunction normalizedFindingArray", reportReaderStart);

  assert.ok(markdownStart >= 0, source);
  assert.ok(summaryStart > markdownStart, source);
  assert.ok(finalReportStart > summaryStart, source);
  assert.ok(reportReaderStart > finalReportStart, source);
  assert.ok(reportReaderEnd > reportReaderStart, source);

  const markdownFallback = source.slice(markdownStart, summaryStart);
  assert.match(
    markdownFallback,
    /task\.metadata\.node\.logicalNodeId === "final-report" && output\.path === "report\.md"/u
  );
  assert.match(markdownFallback, /continue;/u);

  const finalReportFallback = source.slice(finalReportStart, reportReaderStart);
  assert.match(finalReportFallback, /projectCanonicalFinalReport\(report\)/u);
  assert.match(finalReportFallback, /projection\.report/u);
  assert.match(finalReportFallback, /projection\.markdown/u);
  assert.doesNotMatch(finalReportFallback, /agentResultSummary|dedupe-findings|retainedDedupeFindings/u);
  const reportReader = source.slice(reportReaderStart, reportReaderEnd);
  assert.match(reportReader, /readBoundedFinalReportJson\(reportPath\)/u);
  assert.doesNotMatch(reportReader, /openSync|fstatSync|readFileSync|closeSync/u);
});

test("generated Smithers rejects canonical-empty final review before touching existing report artifacts", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const materializerStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const readerStart = source.indexOf("function validatedFinalReport");
  const readerEnd = source.indexOf("\n\nfunction normalizedFindingArray", readerStart);
  assert.ok(materializerStart >= 0 && readerStart > materializerStart && readerEnd > readerStart, source);
  const materializer = source.slice(materializerStart, readerStart);
  const reader = source.slice(readerStart, readerEnd);
  assert.doesNotMatch(reader, /isCanonicalEmptyReport/u);
  assert.ok(
    materializer.indexOf("projectCanonicalFinalReport(report)") <
      materializer.indexOf("writeValidatedTaskArtifact(task, reportOutput"),
    materializer
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-empty-final-report-"));
  const markdownPath = path.join(root, "report.md");
  const findingsPath = path.join(root, "findings.normalized.json");
  fs.writeFileSync(markdownPath, "# Existing model report\n");
  fs.writeFileSync(findingsPath, "[]\n");
  try {
    assert.throws(
      () =>
        projectCanonicalFinalReport({
          schema_version: "1.0",
          run_metadata: {},
          issues: [],
          non_production_outcomes: []
        }),
      /canonical empty final report/u
    );
    assert.equal(fs.readFileSync(markdownPath, "utf8"), "# Existing model report\n");
    assert.equal(fs.readFileSync(findingsPath, "utf8"), "[]\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers derives an exact empty sidecar from a meaningful zero-issue projection", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const materializerStart = source.indexOf("function materializeMissingFinalReportArtifacts");
  const readerStart = source.indexOf("function validatedFinalReport");
  const materializer = source.slice(materializerStart, readerStart);
  assert.match(materializer, /normalizedFindingArray\(projection\.report\.issues\)/u);
  assert.doesNotMatch(materializer, /normalizedFindingsArtifact|findings\.length/u);

  const { normalizeFindings } = loadFinalReportProducerNormalizers();
  const projection = projectCanonicalFinalReport({
    schema_version: "1.0",
    run_metadata: { run_id: "zero-issue-sidecar" },
    issues: [],
    non_production_outcomes: [],
    property_provenance: []
  });
  assert.deepEqual(normalizeFindings(projection.report.issues), []);
  assert.equal(`${JSON.stringify(normalizeFindings(projection.report.issues), null, 2)}\n`, "[]\n");
});

test("generated Smithers materializes one canonical JSON, Markdown, and findings projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-materializer-"));
  const canonicalRoot = path.join(root, "canonical");
  const mirrorRoot = path.join(root, "mirror");
  fs.mkdirSync(canonicalRoot, { recursive: true });
  fs.mkdirSync(mirrorRoot, { recursive: true });
  const report = generatedFinalReportFixture();
  fs.writeFileSync(path.join(canonicalRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(
    path.join(canonicalRoot, "findings.normalized.json"),
    `${JSON.stringify([{ id: "stale-independent-sidecar" }], null, 2)}\n`
  );
  const materialize = loadFinalReportArtifactMaterializer();
  const task = {
    metadata: { node: { logicalNodeId: "final-report" }, artifacts: { dir: canonicalRoot } },
    outputs: [
      { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" },
      { path: "report.json", contract: "ultrafuzz/report@1" },
      { path: "findings.normalized.json", contract: "ultrafuzz/findings@1" }
    ],
    mirrorRoot
  };

  try {
    materialize(task);
    const projection = projectCanonicalFinalReport(report);
    assert.equal(
      fs.readFileSync(path.join(canonicalRoot, "report.json"), "utf8"),
      `${JSON.stringify(projection.report, null, 2)}\n`
    );
    assert.equal(fs.readFileSync(path.join(canonicalRoot, "report.md"), "utf8"), projection.markdown);
    assert.equal(
      fs.readFileSync(path.join(canonicalRoot, "findings.normalized.json"), "utf8"),
      `${JSON.stringify(projection.report.issues, null, 2)}\n`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers reads final-report JSON through a bounded no-follow descriptor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-bounded-read-"));
  const canonicalRoot = path.join(root, "canonical");
  const mirrorRoot = path.join(root, "mirror");
  fs.mkdirSync(canonicalRoot, { recursive: true });
  fs.mkdirSync(mirrorRoot, { recursive: true });
  const reportPath = path.join(canonicalRoot, "report.json");
  const reportBytes = `${JSON.stringify(generatedFinalReportFixture(), null, 2)}\n`;
  fs.writeFileSync(reportPath, reportBytes);

  let openedDescriptor: number | undefined;
  let readDescriptor: number | undefined;
  let closedDescriptor: number | undefined;
  const materialize = loadFinalReportArtifactMaterializer({
    maximumJsonBytes: 32,
    open: (filePath, flags) => {
      assert.equal(filePath, reportPath);
      assert.notEqual(flags & fs.constants.O_NOFOLLOW, 0);
      openedDescriptor = fs.openSync(filePath, flags);
      return openedDescriptor;
    },
    fstat: (descriptor) => {
      assert.equal(descriptor, openedDescriptor);
      assert.equal(fs.fstatSync(descriptor).isFile(), true);
      // Simulate a file that passed the pre-read bound and then grew. The
      // byteLength check on the descriptor read must still reject it.
      return { size: 1, isFile: () => true };
    },
    read: (descriptor) => {
      readDescriptor = descriptor;
      return fs.readFileSync(descriptor);
    },
    close: (descriptor) => {
      closedDescriptor = descriptor;
      fs.closeSync(descriptor);
    }
  });
  const task = {
    metadata: { node: { logicalNodeId: "final-report" }, artifacts: { dir: canonicalRoot } },
    outputs: [
      { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" },
      { path: "report.json", contract: "ultrafuzz/report@1" },
      { path: "findings.normalized.json", contract: "ultrafuzz/findings@1" }
    ],
    mirrorRoot
  };

  try {
    materialize(task);
    assert.equal(readDescriptor, openedDescriptor);
    assert.equal(closedDescriptor, openedDescriptor);
    assert.equal(fs.existsSync(path.join(canonicalRoot, "report.md")), false);
    assert.equal(fs.readFileSync(reportPath, "utf8"), reportBytes);
  } finally {
    if (openedDescriptor !== undefined && closedDescriptor !== openedDescriptor) {
      fs.closeSync(openedDescriptor);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers bounds canonical final-report projection to artifact recovery", async (t) => {
  const materialize = loadFinalReportArtifactMaterializer();
  const runCase = (
    reportContents: string | undefined,
    options: { existingMarkdown?: string; existingFindings?: string } = {}
  ): {
    root: string;
    canonicalRoot: string;
    task: {
      metadata: { node: { logicalNodeId: string }; artifacts: { dir: string } };
      outputs: Array<{ path: string; contract: string }>;
      mirrorRoot: string;
    };
  } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-fail-closed-"));
    const canonicalRoot = path.join(root, "canonical");
    const mirrorRoot = path.join(root, "mirror");
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.mkdirSync(mirrorRoot, { recursive: true });
    if (reportContents !== undefined) fs.writeFileSync(path.join(canonicalRoot, "report.json"), reportContents);
    if (options.existingMarkdown !== undefined) {
      fs.writeFileSync(path.join(canonicalRoot, "report.md"), options.existingMarkdown);
    }
    if (options.existingFindings !== undefined) {
      fs.writeFileSync(path.join(canonicalRoot, "findings.normalized.json"), options.existingFindings);
    }
    return {
      root,
      canonicalRoot,
      task: {
        metadata: { node: { logicalNodeId: "final-report" }, artifacts: { dir: canonicalRoot } },
        outputs: [
          { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" },
          { path: "report.json", contract: "ultrafuzz/report@1" },
          { path: "findings.normalized.json", contract: "ultrafuzz/findings@1" }
        ],
        mirrorRoot
      }
    };
  };

  await t.test("missing and malformed JSON do not recover Markdown", () => {
    for (const contents of [undefined, "{ malformed\n"]) {
      const fixture = runCase(contents);
      try {
        materialize(fixture.task);
        assert.equal(fs.existsSync(path.join(fixture.canonicalRoot, "report.md")), false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  await t.test("complete canonical-empty artifacts bypass recovery unchanged", () => {
    const empty = `${JSON.stringify(
      { schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] },
      null,
      2
    )}\n`;
    const fixture = runCase(empty, { existingMarkdown: "# Existing final report\n", existingFindings: "[]\n" });
    try {
      materialize(fixture.task);
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "report.json"), "utf8"), empty);
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "report.md"), "utf8"), "# Existing final report\n");
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "findings.normalized.json"), "utf8"), "[]\n");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("complete schema-valid but unrenderable artifacts bypass recovery unchanged", () => {
    const report = generatedFinalReportFixture();
    const issue = (report.issues as Array<Record<string, unknown>>)[0]!;
    issue.strategy_provenance = { detection_rates: [{ strategy: "stateful-invariant" }] };
    const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
    const findingsBytes = `${JSON.stringify(report.issues, null, 2)}\n`;
    assert.equal(validateArtifactContract("ultrafuzz/report@1", reportBytes, "report.json").ok, true);
    assert.equal(validateArtifactContract("ultrafuzz/findings@1", findingsBytes, "findings.normalized.json").ok, true);
    const fixture = runCase(reportBytes, {
      existingMarkdown: "# Existing final report\n",
      existingFindings: findingsBytes
    });
    try {
      materialize(fixture.task);
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "report.json"), "utf8"), reportBytes);
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "report.md"), "utf8"), "# Existing final report\n");
      assert.equal(
        fs.readFileSync(path.join(fixture.canonicalRoot, "findings.normalized.json"), "utf8"),
        findingsBytes
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("canonical-empty JSON still fails closed when Markdown needs recovery", () => {
    const empty = `${JSON.stringify(
      { schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] },
      null,
      2
    )}\n`;
    for (const existingMarkdown of [undefined, " \n"]) {
      const fixture = runCase(empty, { existingMarkdown, existingFindings: "[]\n" });
      try {
        assert.throws(() => materialize(fixture.task), /canonical empty final report/u);
        assert.equal(fs.existsSync(path.join(fixture.canonicalRoot, "report.md")), existingMarkdown !== undefined);
        if (existingMarkdown !== undefined) {
          assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "report.md"), "utf8"), existingMarkdown);
        }
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  await t.test("schema-valid but unrenderable JSON does not recover Markdown", () => {
    const report = generatedFinalReportFixture();
    const issue = (report.issues as Array<Record<string, unknown>>)[0]!;
    issue.strategy_provenance = { detection_rates: [{ strategy: "stateful-invariant" }] };
    const fixture = runCase(`${JSON.stringify(report, null, 2)}\n`);
    try {
      assert.throws(() => materialize(fixture.task), /not renderable/u);
      assert.equal(fs.existsSync(path.join(fixture.canonicalRoot, "report.md")), false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("meaningful zero-issue JSON replaces a stale nonempty sidecar with exact empty bytes", () => {
    const report = {
      schema_version: "1.0",
      run_metadata: { run_id: "meaningful-zero" },
      issues: [],
      non_production_outcomes: [],
      property_provenance: []
    };
    const fixture = runCase(`${JSON.stringify(report, null, 2)}\n`, {
      existingFindings: `${JSON.stringify([{ id: "stale" }], null, 2)}\n`
    });
    try {
      materialize(fixture.task);
      assert.equal(fs.readFileSync(path.join(fixture.canonicalRoot, "findings.normalized.json"), "utf8"), "[]\n");
      assert.equal(
        fs.readFileSync(path.join(fixture.canonicalRoot, "report.md"), "utf8"),
        projectCanonicalFinalReport(report).markdown
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

test("generated Smithers final-report writes preserve strict canonical and mirror path handling", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const writerStart = source.indexOf("function writeValidatedTaskArtifactContents");
  const writerEnd = source.indexOf("\n\nfunction isPlainRecord", writerStart);
  assert.ok(writerStart >= 0, source);
  assert.ok(writerEnd > writerStart, source);

  const writer = source.slice(writerStart, writerEnd);
  assert.match(writer, /validateArtifactContract\(output\.contract, contents, output\.path\)/u);
  assert.match(writer, /isStrictlyInsideDirectory\(canonicalRoot, canonicalPath\)/u);
  assert.match(writer, /resolveRegularArtifactFile\([\s\S]*canonicalRoot,[\s\S]*canonicalPath/u);
  assert.match(writer, /if \(!existsSync\(canonicalPath\)\)/u);
  assert.match(writer, /isStrictlyInsideDirectory\(mirrorRoot, mirrorPath\)/u);
  assert.match(writer, /resolveRegularArtifactFile\([\s\S]*mirrorRoot,[\s\S]*mirrorPath/u);
  assert.match(writer, /writeFileDurable\(existingCanonical, contents\)/u);
  assert.match(writer, /writeFileDurable\(canonicalPath, contents\)/u);
  assert.match(writer, /writeFileDurable\(mirrorPath, contents\)/u);
  assert.doesNotMatch(writer, /writeFileSync/u);
});

test("generated Smithers recovered-artifact writer handles regular and unsafe paths without target writes", async (t) => {
  const output = { path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" };
  const contents = "# Canonical final report\n";
  const fixture = (): {
    root: string;
    canonicalRoot: string;
    mirrorRoot: string;
    task: { metadata: { artifacts: { dir: string } }; mirrorRoot: string };
  } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-final-report-writer-"));
    const canonicalRoot = path.join(root, "canonical");
    const mirrorRoot = path.join(root, "mirror");
    fs.mkdirSync(canonicalRoot, { recursive: true });
    fs.mkdirSync(mirrorRoot, { recursive: true });
    return { root, canonicalRoot, mirrorRoot, task: { metadata: { artifacts: { dir: canonicalRoot } }, mirrorRoot } };
  };

  await t.test("invalid regular output is replaced durably", () => {
    const value = fixture();
    try {
      fs.writeFileSync(path.join(value.canonicalRoot, "report.md"), "");
      loadValidatedTaskArtifactWriter()(value.task, output, contents);
      assert.equal(fs.readFileSync(path.join(value.canonicalRoot, "report.md"), "utf8"), contents);
      assert.equal(fs.existsSync(path.join(value.mirrorRoot, "report.md")), false);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await t.test("canonical symlink is untouched and projection is written to the exact mirror", () => {
    const value = fixture();
    const target = path.join(value.root, "symlink-target.md");
    try {
      fs.writeFileSync(target, "target remains unchanged\n");
      fs.symlinkSync(target, path.join(value.canonicalRoot, "report.md"));
      loadValidatedTaskArtifactWriter()(value.task, output, contents);
      assert.equal(fs.lstatSync(path.join(value.canonicalRoot, "report.md")).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(target, "utf8"), "target remains unchanged\n");
      assert.equal(fs.readFileSync(path.join(value.mirrorRoot, "report.md"), "utf8"), contents);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await t.test("canonical hard link is atomically replaced without modifying its peer", () => {
    const value = fixture();
    const target = path.join(value.root, "hardlink-peer.md");
    const canonical = path.join(value.canonicalRoot, "report.md");
    try {
      fs.writeFileSync(target, "peer remains unchanged\n");
      fs.linkSync(target, canonical);
      const originalPeerIdentity = fs.statSync(target).ino;
      assert.equal(fs.statSync(canonical).ino, originalPeerIdentity);
      loadValidatedTaskArtifactWriter()(value.task, output, contents);
      assert.equal(fs.readFileSync(target, "utf8"), "peer remains unchanged\n");
      assert.equal(fs.readFileSync(canonical, "utf8"), contents);
      assert.notEqual(fs.statSync(canonical).ino, originalPeerIdentity);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await t.test("canonical directory is untouched and projection is written to the exact mirror", () => {
    const value = fixture();
    try {
      fs.mkdirSync(path.join(value.canonicalRoot, "report.md"));
      loadValidatedTaskArtifactWriter()(value.task, output, contents);
      assert.equal(fs.statSync(path.join(value.canonicalRoot, "report.md")).isDirectory(), true);
      assert.equal(fs.readFileSync(path.join(value.mirrorRoot, "report.md"), "utf8"), contents);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await t.test("unsafe canonical and mirror paths fail without modifying either target", () => {
    const value = fixture();
    const canonicalTarget = path.join(value.root, "canonical-target.md");
    const mirrorTarget = path.join(value.root, "mirror-target.md");
    try {
      fs.writeFileSync(canonicalTarget, "canonical target\n");
      fs.writeFileSync(mirrorTarget, "mirror target\n");
      fs.symlinkSync(canonicalTarget, path.join(value.canonicalRoot, "report.md"));
      fs.symlinkSync(mirrorTarget, path.join(value.mirrorRoot, "report.md"));
      assert.throws(
        () => loadValidatedTaskArtifactWriter()(value.task, output, contents),
        /output is not a regular file report\.md/u
      );
      assert.equal(fs.readFileSync(canonicalTarget, "utf8"), "canonical target\n");
      assert.equal(fs.readFileSync(mirrorTarget, "utf8"), "mirror target\n");
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });

  await t.test("durable canonical write failures propagate instead of falling through to stale canonical bytes", () => {
    const value = fixture();
    try {
      fs.writeFileSync(path.join(value.canonicalRoot, "report.md"), "# Stale model report\n");
      const writer = loadValidatedTaskArtifactWriter(() => {
        throw new Error("injected durable write failure");
      });
      assert.throws(() => writer(value.task, output, contents), /injected durable write failure/u);
      assert.equal(fs.readFileSync(path.join(value.canonicalRoot, "report.md"), "utf8"), "# Stale model report\n");
      assert.equal(fs.existsSync(path.join(value.mirrorRoot, "report.md")), false);
    } finally {
      fs.rmSync(value.root, { recursive: true, force: true });
    }
  });
});

test("generated Smithers agent normalizes legacy generated-test string lists", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(resolverStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, resolverStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/generated-tests@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /manifest\.generated_tests\.some\(\(entry\) => typeof entry === "string"\)/u);
  assert.match(normalizer, /typeof entry === "string" \? \{ path: entry \} : entry/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent strips line suffixes from safe finding path fields", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyFindingFields");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /\["affected_files", "patch_refs"\] as const/u);
  assert.match(normalizer, /normalizeLegacyPathReferences\(finding\[key\]\)/u);
  assert.match(normalizer, /finding\[key\] = normalizedPaths\.value/u);
  assert.match(normalizer, /function normalizeLegacyPathReference/u);
  assert.ok(normalizer.includes("trimmed.match(/^(.+?)#L\\d+(?:-L?\\d+)?$/u)"));
  assert.ok(normalizer.includes("withoutHashLineSuffix.match(/^(.+?):\\d+(?::\\d+)?$/u)"));
});

test("generated Smithers agent normalizes legacy finding field shapes", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyFindingFields");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/findings@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /typeof finding\.confidence === "number"/u);
  assert.match(normalizer, /Number\.isFinite\(finding\.confidence\)/u);
  assert.match(normalizer, /finding\.confidence = String\(finding\.confidence\)/u);
  assert.match(normalizer, /typeof strategy === "object" && strategy !== null && !Array\.isArray\(strategy\)/u);
  assert.match(normalizer, /\(strategy as Record<string, unknown>\)\.origin/u);
  assert.match(normalizer, /finding\.strategy = legacyStrategy\.trim\(\)/u);
  assert.match(normalizer, /"affected_files"/u);
  assert.match(normalizer, /"affected_functions"/u);
  assert.match(normalizer, /"patch_refs"/u);
  assert.match(normalizer, /"property_ids"/u);
  assert.match(normalizer, /"notes"/u);
  assert.match(normalizer, /finding\[key\] = \[value\.trim\(\)\]/u);
  assert.match(normalizer, /typeof evidence === "string"/u);
  assert.match(normalizer, /finding\.evidence = \[evidence\]/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent normalizes legacy unavailable report provenance fields", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const normalizerStart = source.indexOf("function normalizeLegacyReportProvenance");
  const generatedTestNormalizerStart = source.indexOf("function normalizeLegacyGeneratedTestManifests");

  assert.ok(normalizerStart >= 0, source);
  assert.ok(generatedTestNormalizerStart > normalizerStart, source);

  const normalizer = source.slice(normalizerStart, generatedTestNormalizerStart);
  assert.match(normalizer, /output\.contract !== "ultrafuzz\/report@1"/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, contents, output\.path\)\.ok/u);
  assert.match(normalizer, /report\.issues\.map/u);
  assert.match(normalizer, /normalizeLegacyFindingRecord\(entry\)/u);
  assert.match(normalizer, /normalizeFinalReportSeverityRecord\(normalized\.value\)/u);
  assert.match(normalizer, /originalIsValid/u);
  assert.match(normalizer, /\["implementation_paths", "test_paths"\]/u);
  assert.match(normalizer, /provenance\[field\] = \[\]/u);
  assert.match(normalizer, /\["fuzzer_backend", "fuzzer_backends"\]/u);
  assert.match(normalizer, /delete provenance\[field\]/u);
  assert.match(normalizer, /validateArtifactContract\(output\.contract, normalized, output\.path\)\.ok/u);
  assert.match(normalizer, /writeFileSync\(resolvedPath, normalized/u);
});

test("generated Smithers agent mirrors declared workspace tests before strict verification", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const materializerStart = source.indexOf("function materializeGeneratedTestCompanions");
  const resolverStart = source.indexOf("function resolveRegularArtifactFile");

  assert.ok(materializerStart >= 0, source);
  assert.ok(resolverStart > materializerStart, source);

  const materializer = source.slice(materializerStart, resolverStart);
  assert.match(materializer, /const generatedPrefix = "generated-tests\/"/u);
  assert.match(materializer, /INVARIANT_TEST_ROOT_NAMES\.flatMap/u);
  assert.match(
    materializer,
    /nodeIds\.map\(\(nodeId\) => path\.resolve\(workspaceRoot, testRoot, "foundry", nodeId, workspaceRelativePath\)\)/u
  );
  assert.match(
    materializer,
    /const existingCandidates = sourceCandidates\.filter\(\(candidate\) => existsSync\(candidate\)\)/u
  );
  assert.match(materializer, /generated test sources conflict/u);
  assert.match(materializer, /resolveNonEmptyRegularArtifactFile\(workspaceRoot, sourceCandidate/u);
  assert.match(materializer, /sourceBefore\.nlink !== 1/u);
  assert.match(materializer, /writeFileSync\(anchoredArtifactPath, contents, \{ flag: "wx", mode: 0o600 \}\)/u);
  assert.match(materializer, /generated test copy mismatch/u);
});

test("generated Smithers companions accept the logical node directory the prompt mandates", () => {
  // `strategy_attempt_test_dir` renders `<workspace>/test/foundry/<logical id>`
  // (packages/prompts/src/render.ts). Any node the topology expands -- every
  // `strategies` node in the production topology, which carries `loops: 3` --
  // has a concrete id like `externalized-state-accounting-0`, so a lookup keyed
  // only on the concrete id never visits the directory the prompt named and an
  // obedient agent's test is rejected as missing. Issue #348.
  const materialize = loadMaterializeGeneratedTestCompanion();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-test-companion-"));
  try {
    const workspaceRoot = fs.realpathSync(root);
    const artifactRoot = path.join(workspaceRoot, "artifacts");
    const mandatedDir = path.join(workspaceRoot, "test", "foundry", "externalized-state-accounting");
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(mandatedDir, { recursive: true });
    fs.writeFileSync(path.join(mandatedDir, "Esa.t.sol"), "contract EsaTest {}\n", "utf8");

    materialize(
      workspaceRoot,
      artifactRoot,
      ["externalized-state-accounting", "externalized-state-accounting-0"],
      "generated-tests/Esa.t.sol"
    );

    assert.equal(
      fs.readFileSync(path.join(artifactRoot, "generated-tests", "Esa.t.sol"), "utf8"),
      "contract EsaTest {}\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers companions still reject a test that reached no accepted directory", () => {
  const materialize = loadMaterializeGeneratedTestCompanion();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-generated-test-companion-"));
  try {
    const workspaceRoot = fs.realpathSync(root);
    const artifactRoot = path.join(workspaceRoot, "artifacts");
    fs.mkdirSync(artifactRoot, { recursive: true });
    // The conventional Foundry location, not one the companion contract accepts.
    fs.mkdirSync(path.join(workspaceRoot, "test"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "test", "Esa.t.sol"), "contract EsaTest {}\n", "utf8");

    assert.throws(
      () =>
        materialize(
          workspaceRoot,
          artifactRoot,
          ["externalized-state-accounting", "externalized-state-accounting-0"],
          "generated-tests/Esa.t.sol"
        ),
      /generated test file is missing generated-tests\/Esa\.t\.sol/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated Smithers retries clear every generated-test directory the companion lookup accepts", () => {
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
  assert.match(source, /materializeInvariantSuiteCompanions\(task\)/u);
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
  assert.match(source, /ultrafuzz\.invariant-suite-baseline\.v1/u);
  assert.match(source, /gitTestTreePaths/u);
  assert.match(source, /INVARIANT_SUITE_SENSITIVE_SEGMENTS/u);
  assert.match(source, /assertSafeInvariantSuiteTestPath/u);
  assert.match(source, /record\.implementation_paths/u);
  assert.match(source, /record\.test_paths/u);
  assert.match(source, /pinnedSourceRef, "HEAD\^"/u);
  assert.match(source, /\$\{baseRef\}\.\.\.HEAD/u);
  assert.match(source, /implemented properties JSON is malformed/u);
  assert.match(source, /selectedSources/u);
  assert.match(source, /ancestor invariant suite sources conflict/u);
  assert.match(source, /src\/contracts/u);
  assert.match(source, /invariant suite source is hard-linked/u);
  assert.match(source, /unable to enumerate changed invariant suite sources/u);
  assert.match(source, /writeFileDurable\(anchoredDestination/u);
  assert.match(source, /copyDependencyInvariantSuiteToArtifact/u);
  assert.match(source, /invariantSuiteDependencySnapshots/u);
  assert.match(source, /invariant suite dependency changed/u);
  assert.match(source, /captureInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /restoreInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /INVARIANT_SUITE_MANIFEST_FILE/u);
  assert.match(source, /invariant-suite-manifest\.v1/u);
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
  assert.match(source, /invariant-workspace-snapshot\.v1/u);
  assert.match(source, /loadInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /readStableWorkspaceSnapshotFile/u);
  assert.match(source, /const runRootCandidate = path\.resolve\(process\.cwd\(\), task\.runRoot\)/u);
  assert.match(source, /runRootStat = lstatSync\(runRootCandidate\)/u);
  assert.match(source, /realpathSync\(runRootCandidate\) !== runRootCandidate/u);
  assert.match(source, /before\.dev !== after\.dev/u);
  assert.match(source, /before\.ino !== after\.ino/u);
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
  assert.match(verifier, /rememberVerifiedPublication\(publications, output\.path, bytes\)/u);
  assert.match(verifier, /verifyGeneratedTestFiles\(artifactRoot, validation\.value\)/u);
  assert.match(verifier, /rememberVerifiedPublication\(publications, companion\.path, companion\.contents\)/u);
  assert.match(verifier, /publishFileDurableExclusive\(artifactDir, relativePath, contents\)/u);
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") > verifier.indexOf("primary === undefined")
  );
  assert.ok(
    verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)") <
      verifier.indexOf("return { artifacts, primary_artifact: primary.path }")
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
  assert.match(verifier, /clearArtifactVerificationMarker\(task\)/u);
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
  const helper = source
    .slice(helperStart, helperEnd)
    .replace("task: (typeof taskSpecs)[number]", "task")
    .replace("dependency: string", "dependency")
    .replace("): void {", ") {")
    .replace(
      /\s+as \{\s*schema_version\?: unknown;\s*attempt_id\?: unknown;\s*artifacts\?: unknown;\s*publications\?: unknown;\s*\};/u,
      ";"
    )
    .replace(
      /\s+as \{\s*path\?: unknown;\s*contract\?: unknown;\s*contract_digest\?: unknown;\s*sha256\?: unknown;\s*primary\?: unknown;\s*\};/u,
      ";"
    )
    .replace(/const entry = publication as \{[\s\S]*?\};/u, "const entry = publication;")
    .replaceAll(/\(artifact as \{[^}]+\}\)\./gu, "artifact.")
    .replaceAll(/\(publication as \{[^}]+\}\)\./gu, "publication.")
    .replaceAll(/\(entry as \{[^}]+\}\)\./gu, "entry.")
    .replace(/const entry = artifact as \{[\s\S]*?\};/u, "const entry = artifact;")
    .replace("const seenPaths = new Set<string>();", "const seenPaths = new Set();")
    .replace("const declaredArtifactShas = new Map<string, string>();", "const declaredArtifactShas = new Map();")
    .replace("const expectedPublicationShas = new Map<string, string>();", "const expectedPublicationShas = new Map();")
    .replace("const publicationPaths = new Set<string>();", "const publicationPaths = new Set();")
    .replace("const markerPublicationShas = new Map<string, string>();", "const markerPublicationShas = new Map();")
    .replace(
      /function rememberExpectedVerifiedPublication\(\s*publications: Map<string, string>,\s*relativePath: string,\s*contents: Buffer\s*\): void \{/u,
      "function rememberExpectedVerifiedPublication(publications, relativePath, contents) {"
    )
    .replace(/\)\s+as \{ sha256\?: unknown \} \| undefined;/u, ");")
    .replace(
      "function assertSafeVerifiedPublicationPath(relativePath: string): void {",
      "function assertSafeVerifiedPublicationPath(relativePath) {"
    )
    .replaceAll(" as Parameters<typeof artifactContractDefinition>[0]", "")
    .replaceAll(" as Parameters<typeof validateArtifactContract>[0]", "");
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verification-gate-"));
  const dependency = path.join(runRoot, "property-specification-fanin");
  const generatedDependency = path.join(runRoot, "generated-tests-fanin");
  const invariantDependency = path.join(runRoot, "stateful-invariant-setup");
  fs.mkdirSync(dependency);
  fs.mkdirSync(generatedDependency);
  fs.mkdirSync(invariantDependency);
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
      metadata: { node: { logicalNodeId: "generated-tests-fanin" } },
      outputs: [
        {
          path: "generated-tests.json",
          contract: "ultrafuzz/generated-tests@1",
          contractDigest: "a".repeat(64),
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
    "resolveRegularArtifactFile",
    "readFileSync",
    "taskSpecs",
    "artifactContractDefinition",
    "validateArtifactContract",
    "createHash",
    "invariantSuiteNodeIds",
    "verifyGeneratedTestFiles",
    "rememberExpectedInvariantSuitePublications",
    `const ARTIFACT_VERIFICATION_MARKER = ".ultrafuzz-artifact-verification.json";
   const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v1";
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
      return candidate;
    },
    fs.readFileSync,
    taskSpecs,
    () => ({ digest: "a".repeat(64) }),
    (contract: string) => ({
      ok: true,
      issues: [],
      value:
        contract === "ultrafuzz/generated-tests@1"
          ? { generated_tests: [{ path: "generated-tests/Property.t.sol" }] }
          : undefined
    }),
    createHash,
    new Set(["stateful-invariant-setup"]),
    (artifactDir: string, value: unknown) =>
      ((value as { generated_tests?: Array<{ path: string }> }).generated_tests ?? []).map((entry) => ({
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
  ) as (task: { attemptId: string; runRoot: string }, dependency: string) => void;

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
        schema_version: "ultrafuzz.artifact-verification.v1",
        attempt_id: attemptId,
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
  const verifiedBytes = Buffer.from([0xff, 0x0a, 0x76]);
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
        contract: "ultrafuzz/json-object@1"
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
  assert.doesNotThrow(() => assertVerifiedDependency(task, dependency));
  fs.mkdirSync(path.join(generatedDependency, "generated-tests"), { recursive: true });
  const generatedBytes = Buffer.from('{"generated_tests":[{"path":"generated-tests/Property.t.sol"}]}\n');
  fs.writeFileSync(path.join(generatedDependency, "generated-tests.json"), generatedBytes);
  const generatedArtifact = {
    path: "generated-tests.json",
    contract: "ultrafuzz/generated-tests@1",
    contract_digest: "a".repeat(64),
    sha256: createHash("sha256").update(generatedBytes).digest("hex"),
    primary: true
  };
  const companionPath = path.join(generatedDependency, "generated-tests", "Property.t.sol");
  fs.writeFileSync(companionPath, "contract Property {}\n", "utf8");
  const companionPublication = {
    path: "generated-tests/Property.t.sol",
    sha256: createHash("sha256").update("contract Property {}\n").digest("hex")
  };
  writeAttemptMarker("generated-tests-fanin", [generatedArtifact]);
  assert.throws(
    () => assertVerifiedDependency(task, generatedDependency),
    /artifact dependency has not passed verification generated-tests-fanin/u
  );
  writeAttemptMarker(
    "generated-tests-fanin",
    [generatedArtifact],
    [{ path: generatedArtifact.path, sha256: generatedArtifact.sha256 }, companionPublication]
  );
  assert.doesNotThrow(() => assertVerifiedDependency(task, generatedDependency));
  fs.writeFileSync(companionPath, "contract Tampered {}\n", "utf8");
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
      schema_version: "ultrafuzz.artifact-verification.v1",
      attempt_id: "property-specification-fanin"
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
  assert.match(helper, /if \(!replayWorkspacePatches\)/u);
  assert.match(helper, /!workspacePatchBaselineTrees\.has\(task\.attemptId\)/u);
  assert.match(helper, /readWorkspacePatchBaseline\(task\)/u);
  assert.match(helper, /writeWorkspacePatchBaseline\(task, baselineTree\)/u);
  assert.match(helper, /persistedPreparation === undefined && !replayWorkspacePatches/u);
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
  assert.match(helper, /for \(const capture of captures\) validateWorkspacePatchCapture\(workspaceRoot, capture\);/u);
  // The skip is only sound when the skipped prefix is a real chain; a sibling fan-in must replay.
  assert.match(source, /return chained \? index \+ 1 : 0;/u);
  assert.match(helper, /captures\.slice\(replayFrom\)/u);
  assert.match(
    source,
    /const result = await agent\.generate\(attemptArgs\);[\s\S]*?prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, pinnedSubmodules: "verify" \}\);/u
  );
});

/**
 * Loads the goal-search predicates as executable functions.
 *
 * They sit between `assertTaskInputs` and `assertVerifiedDependency` in the template, deliberately
 * outside the `assertVerifiedDependency` slice that the fail-closed test above type-strips by hand.
 */
function loadGoalSearchPredicates(
  artifactVerificationMarkerLocation: (
    runRoot: string,
    attemptId: string,
    createRoot: boolean
  ) => { path: string } | undefined
): {
  isGoalSearchTask: (task: { metadata: { node: { group?: string } } }) => boolean;
  goalSearchDependencyIsUnverified: (
    task: { runRoot: string },
    dependencyTask: { attemptId: string; metadata: { node: { group?: string } } }
  ) => boolean;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function isGoalSearchTask");
  const helperEnd = source.indexOf("\n\nfunction assertVerifiedDependency", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "GOAL_SEARCH_TOPOLOGY_GROUP",
    "artifactVerificationMarkerLocation",
    "lstatSync",
    "isMissingPathError",
    `${helper}; return { isGoalSearchTask, goalSearchDependencyIsUnverified };`
  )(
    "goals",
    artifactVerificationMarkerLocation,
    fs.lstatSync,
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  ) as ReturnType<typeof loadGoalSearchPredicates>;
}

function loadGoalSearchCoverageRecorder(
  coveragePath: (runRoot: string) => string | undefined,
  findingCount: (task: { attemptId: string }) => number | undefined
): (
  tasks: ReadonlyArray<unknown>,
  hasAgentOutput: (nodeId: string) => boolean,
  hasVerification: (nodeId: string) => boolean
) => void {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("/** Last recorded lane-state signature");
  // `readGoalSearchCoverage` carries its own doc comment, so the slice ends at that comment rather
  // than at the `function` keyword.
  const helperEnd = source.indexOf("\n\n/**\n * Read the census back", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "GOAL_SEARCH_COVERAGE_SCHEMA_VERSION",
    "__ULTRAFUZZ_RUN_ID_LITERAL__",
    "isGoalSearchTask",
    "goalSearchCoveragePath",
    "verifiedGoalSearchFindingCount",
    "writeFileDurable",
    `${helper}; return recordGoalSearchCoverage;`
  )(
    "ultrafuzz.goal-search-coverage.v1",
    "run-goal-coverage",
    (task: { metadata: { node: { group?: string } } }) => task.metadata.node.group === "goals",
    coveragePath,
    findingCount,
    writeFileDurable
  ) as ReturnType<typeof loadGoalSearchCoverageRecorder>;
}

function loadReportGoalSearchCoverageReplacer(): (contents: string, coverage: unknown) => string | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function replaceReportGoalSearchCoverage");
  const helperEnd = source.indexOf("function reconstructAuthoritativeGoalSearchCoverage", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("isPlainRecord", `${helper}; return replaceReportGoalSearchCoverage;`)(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
  ) as ReturnType<typeof loadReportGoalSearchCoverageReplacer>;
}

// #672/#677. Finding no bug for an assigned goal is a NEGATIVE RESULT, and `goal-hunter` already
// contracts it as `[]`, but a goal node killed at its timeout still became a failed node -- and
// `dynamic-strategy-generator` and `dedupe-findings` depend on every goal node, so both fan-ins failed
// with it. That produced 97 downstream `artifact dependency has not passed verification` events in an
// 18-hour local default-profile run, the largest single failure class. The tolerance that fixes it is
// dangerous in exactly one direction: it must stay confined to goal searches, or an absent artifact
// stops being a broken contract everywhere.
test("generated Smithers scopes goal-search fault tolerance to the goals topology group", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");

  // The discriminator is the topology GROUP, not a list of logical node IDs, so a fourth goal lane
  // inherits the behavior and a node moved out of the group loses it.
  assert.match(source, /const GOAL_SEARCH_TOPOLOGY_GROUP = "goals";/u);
  assert.match(source, /function isGoalSearchTask\(task: \(typeof taskSpecs\)\[number\]\): boolean \{/u);
  assert.match(source, /return task\.metadata\.node\.group === GOAL_SEARCH_TOPOLOGY_GROUP;/u);
  assert.match(source, /const goalSearch = isGoalSearchTask\(task\);/u);

  // Every tolerance site is gated on that one predicate, and there are exactly four of them: the cloud
  // sandbox task, the cloud verifier, the local agent task, and the local verifier. A bare
  // `continueOnFail` or one gated on anything else would let a non-goal node fail silently, so the
  // count and the spelling are both asserted rather than just the presence.
  //
  // The two local-path sites additionally exclude `cloudWorker`. That branch is what the relocated
  // worker renders for its own single task, and tolerating a failure there would let the inner run
  // exit 0, record a "completed" durability checkpoint, and make the sandbox retry skip re-running the
  // agent entirely -- spending the lane's second attempt on a publication retry. A worker render has
  // one task and no siblings to protect, so it has nothing to gain from the tolerance and a retry to
  // lose. The controller-path sites keep the bare predicate because there the tolerance is what stops
  // one goal lane from taking its siblings and the fan-ins down with it.
  const tolerated = [...source.matchAll(/continueOnFail=\{[^}]*\}/gu)].map((match) => match[0]);
  assert.deepEqual(tolerated, [
    "continueOnFail={goalSearch}",
    "continueOnFail={goalSearch}",
    "continueOnFail={goalSearch && !cloudWorker}",
    "continueOnFail={goalSearch && !cloudWorker}"
  ]);

  // Preparation must stay fatal. It is synchronous, deterministic, model-free work, so a failure there
  // is a real defect rather than a negative result, and a lane whose mirror was never prepared cannot
  // produce a defensible negative result anyway.
  const preparationStart = source.indexOf("id={task.preparationId}");
  const preparationEnd = source.indexOf("{() => prepareArtifactMirror(task)}", preparationStart);
  assert.ok(preparationStart >= 0, source);
  assert.ok(preparationEnd > preparationStart, source);
  assert.doesNotMatch(source.slice(preparationStart, preparationEnd), /continueOnFail/u);

  // `depsOptional` is not the lever: it relaxes `deps`, the typed render-time output wiring, and this
  // template expresses dependencies as `dependsOn` plus its own artifact handoff. The equivalent
  // tolerance therefore has to live in `assertTaskInputs`, and it must present as MISSING (skipped),
  // never as an unverified dependency that still gets read.
  // The prop, not the word: the template explains in a comment why `depsOptional` is not the lever,
  // and that explanation is the thing keeping a future editor from reaching for it.
  assert.doesNotMatch(source, /depsOptional[=:]/u);
  assert.match(
    source,
    /const unverifiedGoalSearch = \s*dependencyTask !== undefined && goalSearchDependencyIsUnverified\(task, dependencyTask\);/u
  );
  assert.match(source, /if \(unverifiedGoalSearch && !existsSync\(dependency\)\) \{\s*continue;/u);
  assert.match(
    source,
    /if \(dependencyTask !== undefined\) \{\s*if \(unverifiedGoalSearch\) \{\s*continue;\s*\}\s*assertVerifiedDependency\(task, dependency\);/u
  );

  // Tolerating a MISSING goal lane must not become consuming an UNVERIFIED one. These are the two
  // places that read dependency findings bytes directly -- provenance joins, and the dedupe recovery
  // path that falls back to a dependency's unpublished worktree mirror -- so both exclude a goal lane
  // that never passed verification.
  const provenanceStart = source.indexOf("function dependencyFindingSources");
  const provenanceEnd = source.indexOf("\n\nfunction ", provenanceStart + 1);
  assert.ok(provenanceStart >= 0, source);
  assert.match(
    source.slice(provenanceStart, provenanceEnd),
    /if \(goalSearchDependencyIsUnverified\(task, dependency\)\) continue;/u
  );
  const dedupeStart = source.indexOf("function materializeMissingDedupeArtifact");
  const dedupeEnd = source.indexOf("\n\nfunction ", dedupeStart + 1);
  assert.ok(dedupeStart >= 0, source);
  const dedupeRecovery = source.slice(dedupeStart, dedupeEnd);
  assert.match(dedupeRecovery, /if \(goalSearchDependencyIsUnverified\(task, dependency\)\) \{\s*continue;/u);
  assert.ok(
    dedupeRecovery.indexOf("goalSearchDependencyIsUnverified") <
      dedupeRecovery.indexOf("mirroredArtifactDir(dependency)"),
    dedupeRecovery
  );
});

test("goal-search dependency tolerance reads only the marker's presence and only for goal lanes", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-goal-tolerance-"));
  try {
    const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
    fs.mkdirSync(markerRoot);
    const markerLocations: string[] = [];
    const predicates = loadGoalSearchPredicates((_runRoot, attemptId) => {
      const markerPath = path.join(markerRoot, `${attemptId}.json`);
      markerLocations.push(markerPath);
      if (attemptId === "unsafe-lane") {
        // Stands in for `artifactVerificationMarkerLocation`'s own safety check. A hostile symlink over
        // the verification directory must surface as an error, never be reinterpreted as "this goal
        // simply found nothing" -- which is why the predicate does not catch it.
        throw new Error("artifact-contract failure: unsafe artifact verification marker root");
      }
      if (attemptId === "unmaterialized-lane") {
        return undefined;
      }
      return { path: markerPath };
    });

    const goalLane = (attemptId: string) => ({ attemptId, metadata: { node: { group: "goals" } } });
    const task = { runRoot };

    assert.equal(predicates.isGoalSearchTask({ metadata: { node: { group: "goals" } } }), true);
    assert.equal(predicates.isGoalSearchTask({ metadata: { node: { group: "strategies" } } }), false);
    assert.equal(predicates.isGoalSearchTask({ metadata: { node: {} } }), false);

    // A killed or contract-failing goal lane leaves no marker: tolerated as missing.
    assert.equal(predicates.goalSearchDependencyIsUnverified(task, goalLane("killed-lane")), true);

    // A completed goal lane has one: NOT tolerated, so it still goes through the unchanged
    // `assertVerifiedDependency`, which is what re-checks the digests and the contract. The predicate
    // deliberately reads presence only and must not be mistaken for a verification of its own.
    fs.writeFileSync(path.join(markerRoot, "completed-lane.json"), "{}\n");
    assert.equal(predicates.goalSearchDependencyIsUnverified(task, goalLane("completed-lane")), false);

    // A marker that is not a regular file is not a marker.
    fs.mkdirSync(path.join(markerRoot, "directory-lane.json"));
    assert.equal(predicates.goalSearchDependencyIsUnverified(task, goalLane("directory-lane")), true);
    assert.equal(predicates.goalSearchDependencyIsUnverified(task, goalLane("unmaterialized-lane")), true);

    // Every other dependency class fails closed exactly as before, marker or no marker.
    assert.equal(
      predicates.goalSearchDependencyIsUnverified(task, {
        attemptId: "killed-lane",
        metadata: { node: { group: "strategies" } }
      }),
      false
    );
    assert.equal(
      predicates.goalSearchDependencyIsUnverified(task, { attemptId: "killed-lane", metadata: { node: {} } }),
      false
    );
    // A non-goal dependency must not even be probed for a marker; only its group decides.
    assert.equal(markerLocations.includes(path.join(markerRoot, "never-probed.json")), false);

    assert.throws(
      () => predicates.goalSearchDependencyIsUnverified(task, goalLane("unsafe-lane")),
      /unsafe artifact verification marker root/u
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

// #677. Once a goal lane may end with nothing and the run still finishes, "no vulnerabilities found"
// stops being a statement about the target unless something records how many of the planned searches
// ran. It cannot be read from the artifacts: preparation seeds every goal lane with the canonical
// empty findings array, so a lane killed at 7200000ms and a lane that genuinely found nothing leave
// the same valid empty `findings.json` behind. The distinguishing evidence is Smithers' own durable
// output rows, which is why the two probes are passed in from the render.
test("generated Smithers records goal-search coverage from durable output rows, not from artifacts", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-goal-coverage-"));
  try {
    const coveragePath = path.join(runRoot, "goal-search-coverage.json");
    const findingCounts = new Map<string, number | undefined>([
      ["with-findings", 2],
      ["no-findings", 0],
      ["uncountable", undefined]
    ]);
    const record = loadGoalSearchCoverageRecorder(
      () => coveragePath,
      (task) => findingCounts.get(task.attemptId)
    );
    const lane = (attemptId: string, group: string) => ({
      id: `task:${attemptId}`,
      verifierId: `verify:${attemptId}`,
      attemptId,
      runRoot,
      metadata: {
        node: { group, concreteNodeId: `dynamic:class:${attemptId}`, logicalNodeId: "class-goals" }
      }
    });
    const tasks = [
      lane("with-findings", "goals"),
      lane("no-findings", "goals"),
      lane("uncountable", "goals"),
      lane("killed", "goals"),
      lane("contract-failed", "goals"),
      lane("not-a-goal", "strategies")
    ];
    const returned = new Set(["task:with-findings", "task:no-findings", "task:uncountable", "task:contract-failed"]);
    const verified = new Set(["verify:with-findings", "verify:no-findings", "verify:uncountable"]);
    const hasAgentOutput = (nodeId: string) => returned.has(nodeId);
    const hasVerification = (nodeId: string) => verified.has(nodeId);

    record(tasks, hasAgentOutput, hasVerification);
    const census = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as {
      schema_version: string;
      run_id: string;
      totals: Record<string, number>;
      goals: Array<{ attempt_id: string; status: string; finding_count: number | null; node_id: string }>;
    };
    assert.equal(census.schema_version, "ultrafuzz.goal-search-coverage.v1");
    assert.equal(census.run_id, "run-goal-coverage");

    // Only `goals`-group lanes are the census, so a strategy node cannot pad the coverage numbers.
    assert.deepEqual(
      census.goals.map((goal) => goal.attempt_id),
      ["contract-failed", "killed", "no-findings", "uncountable", "with-findings"]
    );
    assert.deepEqual(Object.fromEntries(census.goals.map((goal) => [goal.attempt_id, goal.status])), {
      // The agent never returned: timed out or killed. This is the case that must never read as
      // coverage, and it is the one the 18-hour run produced 9 times at exactly the node timeout.
      killed: "stopped-early",
      // The agent returned but its artifacts failed their contract. Also not coverage, and a
      // different defect with a different fix, so it is a distinct status rather than a lumped one.
      "contract-failed": "unverified",
      "with-findings": "completed-with-findings",
      "no-findings": "completed-no-findings",
      // An unreadable count is reported as unknown. Reporting it as zero is precisely the mistake
      // this record exists to prevent.
      uncountable: "completed"
    });
    assert.deepEqual(Object.fromEntries(census.goals.map((goal) => [goal.attempt_id, goal.finding_count])), {
      killed: null,
      "contract-failed": null,
      "with-findings": 2,
      "no-findings": 0,
      uncountable: null
    });
    assert.deepEqual(census.totals, {
      planned: 5,
      completed: 3,
      completed_with_findings: 1,
      completed_no_findings: 1,
      stopped_early: 1,
      unverified: 1
    });

    // The census runs on every render pass, of which a long run has thousands, so it is gated on a
    // lane-state signature. The gate has to be exact and not merely cheap: an unchanged lane state
    // writes nothing, and any lane settling further must write again.
    fs.rmSync(coveragePath);
    record(tasks, hasAgentOutput, hasVerification);
    assert.equal(fs.existsSync(coveragePath), false, "an unchanged lane state must not rewrite the census");
    verified.add("verify:contract-failed");
    record(tasks, hasAgentOutput, hasVerification);
    assert.equal(fs.existsSync(coveragePath), true, "a lane that settles further must rewrite the census");
    const updated = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as { totals: Record<string, number> };
    assert.equal(updated.totals.unverified, 0);
    assert.equal(updated.totals.completed, 4);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("generated Smithers report coverage stamp replaces any model-authored goal coverage", () => {
  const replace = loadReportGoalSearchCoverageReplacer();
  const coverage = { schema_version: "ultrafuzz.goal-search-coverage.v1", totals: { planned: 77, completed: 3 } };

  // The added key survives because `ultrafuzz/report@1` is a loose object, the same mechanism that
  // already carries authoritative property-implementation coverage into the report.
  const stamped = replace(
    `${JSON.stringify({ schema_version: "ultrafuzz.report@1", findings: [] }, null, 2)}\n`,
    coverage
  );
  assert.ok(stamped);
  assert.deepEqual(JSON.parse(stamped), {
    schema_version: "ultrafuzz.report@1",
    findings: [],
    goal_search_coverage: coverage
  });
  assert.equal(stamped.endsWith("\n"), true, "the stamped report must stay newline-terminated");

  // Whatever the report agent claimed about its own coverage is discarded, not merged. A model that
  // ran out of budget is the last thing that should be describing how much budget it had.
  const overwritten = replace(
    `${JSON.stringify({ schema_version: "ultrafuzz.report@1", goal_search_coverage: "all goals completed" })}\n`,
    coverage
  );
  assert.ok(overwritten);
  assert.deepEqual((JSON.parse(overwritten) as { goal_search_coverage: unknown }).goal_search_coverage, coverage);

  // Unknown coverage is stamped as an explicit sentinel by the caller, so the report can still say
  // "unknown" rather than silently omitting the claim.
  const sentinel = replace(`${JSON.stringify({ schema_version: "ultrafuzz.report@1" })}\n`, "unavailable");
  assert.ok(sentinel);
  assert.equal((JSON.parse(sentinel) as { goal_search_coverage: unknown }).goal_search_coverage, "unavailable");

  // A report that is not a JSON object is left entirely alone rather than rewritten.
  assert.equal(replace("not json", coverage), undefined);
  assert.equal(replace("[]", coverage), undefined);
});

/**
 * The one goal-lane task-spec shape the #677 behavioural chain below drives end to end.
 *
 * Deliberately the real thing rather than a reduction: two outputs (`findings.json` primary plus
 * `generated-tests.json`), exactly what `class-goals` declares in the shipped topology, because both
 * are pre-seeded into the lane's worktree mirror and both are therefore available to be laundered.
 */
type GoalLaneTaskSpec = {
  attemptId: string;
  runRoot: string;
  workspacePath: string;
  artifactDir: string;
  outputs: Array<{ path: string; contract: string; contractDigest: string; primary: boolean }>;
  metadata: {
    artifacts: { dir: string };
    dependencies: { attemptIds: string[] };
    node: { group: string; logicalNodeId: string; concreteNodeId: string; producerNodeId?: string };
    run: { ultrafuzzRunId: string };
  };
};

/**
 * Loads the whole #677 attestation chain as executable code over a real filesystem.
 *
 * Source-text assertions cannot decide this one. The defect was not a missing string, it was that
 * `verifyArtifacts` was a pure function of the filesystem while preparation pre-seeded that same
 * filesystem with contract-valid empty artifacts, so a lane that never ran produced bytes
 * indistinguishable from a lane that ran and found nothing. Proving that is fixed means running the
 * seeding, the verification, the marker write and the dedupe provenance read against real files.
 *
 * Nothing here is a mock of behaviour under test: `canonicalEmptyArtifact` is the real seeder,
 * `publishFileDurableExclusive` and `validateArtifactContract` are the real `@ultrafuzz/artifacts`
 * implementations, and the marker helpers, `verifyArtifacts`, the goal-search predicates and
 * `dependencyFindingSources` are all transpiled from the template. Only three collaborators a goal
 * lane can never reach are injected, and each asserts it was not reached rather than returning a
 * convenient value.
 */
function loadGoalLaneVerificationChain(taskSpecs: readonly GoalLaneTaskSpec[]): {
  canonicalEmptyArtifact: (task: GoalLaneTaskSpec, output: GoalLaneTaskSpec["outputs"][number]) => string | undefined;
  verifyArtifacts: (
    task: GoalLaneTaskSpec,
    evidence: { agentReturned: boolean }
  ) => { artifacts: Array<{ path: string; sha256: string; primary: boolean }>; primary_artifact: string };
  goalSearchDependencyIsUnverified: (task: GoalLaneTaskSpec, dependencyTask: GoalLaneTaskSpec) => boolean;
  dependencyFindingSources: (
    task: GoalLaneTaskSpec,
    artifactDir: string
  ) => Array<{ node_id: string; artifact_path: string; finding: unknown }>;
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const slice = (start: string, end: string): string => {
    const startIndex = source.indexOf(start);
    assert.ok(startIndex >= 0, `missing template slice start ${start}`);
    const endIndex = source.indexOf(end, startIndex);
    assert.ok(endIndex > startIndex, `missing template slice end ${end}`);
    return source.slice(startIndex, endIndex);
  };
  const helper = ts.transpileModule(
    [
      slice("function isStrictlyInsideDirectory", "\n\nfunction mirroredArtifactDir"),
      slice("function mirroredArtifactDir", "\n\nfunction taskPromptPathForArtifactReset"),
      slice("function isMissingPathError", "\n\nfunction taskArtifactRoots"),
      slice("function taskArtifactRoots", "\n\n/**\n * Name the preparation step that threw"),
      slice("function formatSchemaValidationIssues", "\n\n"),
      slice("function isGoalSearchTask", "\n\nfunction assertVerifiedDependency"),
      slice("function assertSafeVerifiedPublicationPath", "\n\n"),
      slice("function canonicalEmptyArtifact", "\n\nfunction materializeMissingMarkdownArtifacts"),
      slice("function dependencyFindingSources", "\n\nfunction currentFindingLifecycleLedger"),
      slice("function resolveRegularArtifactFile", "\n\n/**\n * Validate, publish, and attest"),
      slice("function rememberVerifiedPublication", "\n\nfunction verifyGeneratedTestFiles"),
      slice("function verifyGeneratedTestFiles", "\n\n/**\n * Where the run-level goal-search census lives"),
      slice("function verifyArtifacts", "\n\nfunction readInvariantSourceSnapshot")
    ].join("\n\n"),
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const unreachableForGoalLane = (name: string) => (): never => {
    throw new Error(`a goal lane must not reach ${name}`);
  };
  return new Function(
    "path",
    "createHash",
    "existsSync",
    "lstatSync",
    "mkdirSync",
    "readFileSync",
    "realpathSync",
    "rmSync",
    "statSync",
    "assertRegularFileInside",
    "publishFileDurableExclusive",
    "validateArtifactContract",
    "artifactContractDefinition",
    "taskSpecs",
    "GOAL_SEARCH_TOPOLOGY_GROUP",
    "ARTIFACT_VERIFICATION_DIRECTORY",
    "ARTIFACT_VERIFICATION_SCHEMA_VERSION",
    "invariantSuiteNodeIds",
    "verifyInvariantLedgerSourceEvidence",
    "verifyGoalPlanSelectedRecordSnapshots",
    "rememberInvariantSuitePublications",
    `${helper};
     return {
       canonicalEmptyArtifact,
       verifyArtifacts,
       goalSearchDependencyIsUnverified,
       dependencyFindingSources
     };`
  )(
    path,
    createHash,
    fs.existsSync,
    fs.lstatSync,
    fs.mkdirSync,
    fs.readFileSync,
    fs.realpathSync,
    fs.rmSync,
    fs.statSync,
    assertRegularFileInside,
    publishFileDurableExclusive,
    validateArtifactContract,
    artifactContractDefinition,
    taskSpecs,
    "goals",
    ".ultrafuzz-verification",
    "ultrafuzz.artifact-verification.v1",
    new Set<string>(),
    // Guards on `logicalNodeId !== "project-discovery"` and returns immediately for everything else,
    // so a goal lane never reaches its body. Asserted rather than assumed: if that guard ever widens
    // to cover goal lanes, this fails loudly instead of quietly testing a different function.
    (task: GoalLaneTaskSpec) => {
      assert.notEqual(task.metadata.node.logicalNodeId, "project-discovery");
    },
    unreachableForGoalLane("verifyGoalPlanSelectedRecordSnapshots"),
    unreachableForGoalLane("rememberInvariantSuitePublications")
  ) as ReturnType<typeof loadGoalLaneVerificationChain>;
}

/**
 * #677, the whole laundering chain, executed.
 *
 * The round that made goal searches non-fatal was right about the intent and wrong about the
 * mechanism. `continueOnFail={goalSearch}` on the agent task makes a lane killed at its timeout
 * TERMINAL, which is what makes its verifier runnable at all; `prepareArtifactMirror` has already
 * written `canonicalEmptyArtifact` into that lane's worktree mirror, and for a goal lane that is a
 * contract-valid `findings.json` of `[]` (the seeder deliberately permits a PRIMARY
 * `ultrafuzz/findings@1`) plus a `generated-tests.json` with no tests. A verifier that reads only the
 * filesystem therefore finds a complete, valid output set for work that never happened, publishes it
 * into the canonical artifact directory, and writes a verification marker over it. From there
 * `goalSearchDependencyIsUnverified` reports the lane verified and `dependencyFindingSources` counts
 * it as a legitimate zero-finding source: an attestation of a search nobody ran, which for a security
 * audit is worse than the 97-event dependency cascade the tolerance replaced.
 *
 * So this test seeds with the real seeder, verifies with the real verifier, and then asks the three
 * questions that decide whether a phantom lane can still reach a report:
 *   1. is there a marker?
 *   2. were the seeded bytes published into the canonical artifact directory?
 *   3. does the dedupe stage count the lane as a zero-finding source?
 * All three must be no for a lane with no durable agent output row, and all three must be yes for the
 * lane beside it that genuinely ran and genuinely found nothing -- the negative result the tolerance
 * exists to protect.
 */
test("a goal lane with no durable agent output row is never published, attested, or counted as a zero-finding source", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-goal-attestation-"));
  try {
    const lane = (attemptId: string): GoalLaneTaskSpec => {
      const artifactDir = path.join(runRoot, "artifacts", attemptId);
      const workspacePath = path.join(runRoot, "workspaces", attemptId);
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.mkdirSync(path.join(workspacePath, "artifacts", attemptId), { recursive: true });
      return {
        attemptId,
        runRoot,
        workspacePath,
        artifactDir,
        outputs: [
          { path: "findings.json", contract: "ultrafuzz/findings@1", contractDigest: "findings-digest", primary: true },
          {
            path: "generated-tests.json",
            contract: "ultrafuzz/generated-tests@1",
            contractDigest: "generated-tests-digest",
            primary: false
          }
        ],
        metadata: {
          artifacts: { dir: artifactDir },
          dependencies: { attemptIds: [] },
          node: {
            group: "goals",
            logicalNodeId: "class-goals",
            concreteNodeId: `dynamic:class:${attemptId}`,
            producerNodeId: `dynamic:class:${attemptId}`
          },
          run: { ultrafuzzRunId: "run-goal-attestation" }
        }
      };
    };

    const killed = lane("killed-goal-lane");
    const searched = lane("searched-goal-lane");
    const dedupe: GoalLaneTaskSpec = {
      ...lane("dedupe"),
      metadata: {
        ...lane("dedupe").metadata,
        dependencies: { attemptIds: [killed.attemptId, searched.attemptId] },
        node: {
          group: "review",
          logicalNodeId: "dedupe-findings",
          concreteNodeId: "dedupe-findings",
          producerNodeId: "dedupe-findings"
        }
      }
    };
    const chain = loadGoalLaneVerificationChain([killed, searched, dedupe]);

    // Preparation, verbatim: every declared output of every goal lane gets its contract's canonical
    // empty representation written into the lane's worktree mirror BEFORE the agent starts. This is
    // the pre-seeding half of the laundering machine, and it is asserted here rather than assumed
    // because the gate below is only load-bearing while it keeps happening.
    for (const task of [killed, searched]) {
      const mirrorRoot = path.join(task.workspacePath, "artifacts", task.attemptId);
      for (const output of task.outputs) {
        const seeded = chain.canonicalEmptyArtifact(task, output);
        assert.ok(
          seeded !== undefined,
          `#677 depends on ${output.path} being pre-seeded for a goal lane; if it no longer is, this test is checking the wrong thing`
        );
        fs.writeFileSync(path.join(mirrorRoot, output.path), seeded);
      }
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(mirrorRoot, "findings.json"), "utf8")),
        [],
        "the seeded primary findings artifact must be a valid empty findings array"
      );
    }

    // The stale-marker case, which is the reason the refusal is ordered AFTER the clear. In-agent
    // verification writes the marker inside the agent task, before Smithers commits that task's row,
    // so an attempt killed in exactly that window leaves a marker with no row behind it. Declining to
    // write a new one would not be enough -- the old one would still answer for the lane.
    const markerRoot = path.join(runRoot, ".ultrafuzz-verification");
    fs.mkdirSync(markerRoot, { recursive: true, mode: 0o700 });
    const killedMarkerPath = path.join(markerRoot, `${killed.attemptId}.json`);
    fs.writeFileSync(killedMarkerPath, `${JSON.stringify({ attempt_id: killed.attemptId })}\n`);

    assert.throws(
      () => chain.verifyArtifacts(killed, { agentReturned: false }),
      /artifact-contract failure: refusing to verify killed-goal-lane because its agent produced no output row/u
    );

    // 1. No attestation, and the stale one is gone rather than merely un-refreshed.
    assert.equal(fs.existsSync(killedMarkerPath), false, "a lane with no output row must not keep a marker");

    // 2. Nothing published. The canonical artifact directory is what every downstream consumer reads
    // and what a cloud worker copies back, so a phantom lane must leave it exactly as empty as the
    // agent left it -- including the non-primary output, which is just as forgeable as the primary.
    assert.deepEqual(fs.readdirSync(killed.artifactDir), [], "no seeded artifact may reach the canonical dir");

    // 3. The lane is invisible to the dedupe stage. Not "contributes zero findings" -- absent. A lane
    // counted as a zero-finding source is a lane whose silence is reported as a searched negative.
    assert.equal(chain.goalSearchDependencyIsUnverified(dedupe, killed), true);

    // The other side of the bargain, and the regression this must not cause: a lane that really ran
    // and really found nothing still verifies, still publishes, still attests. Its evidence is the
    // durable output row, which is why an empty `findings.json` is enough here and not enough above --
    // the bytes are byte-for-byte identical in both cases.
    const verification = chain.verifyArtifacts(searched, { agentReturned: true });
    assert.equal(verification.primary_artifact, "findings.json");
    assert.deepEqual(verification.artifacts.map((artifact) => artifact.path).sort(), [
      "findings.json",
      "generated-tests.json"
    ]);
    assert.equal(fs.existsSync(path.join(markerRoot, `${searched.attemptId}.json`)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(searched.artifactDir, "findings.json"), "utf8")), []);
    assert.equal(chain.goalSearchDependencyIsUnverified(dedupe, searched), false);

    // Provenance, read the way `dedupe-findings` reads it. This is the third question, and it is asked
    // twice on purpose. The publication gate above already keeps the seeded bytes out of the canonical
    // directory this reader scans, but relying on that alone would make the exclusion an accident of
    // one code path: a cloud worker copies its whole artifact directory back on success, a retry
    // re-seeds, and a resumed run inherits whatever the volume holds. So the killed lane is given a
    // fully contract-valid `findings.json` in its canonical directory -- exactly what the defect
    // published there -- and must still contribute nothing, because the decision belongs to the
    // marker and not to the bytes.
    const finding = (id: string, node: string) => ({
      id,
      title: "example goal finding",
      status: "open",
      severity_guess: "low",
      confidence: "low",
      summary: "example",
      source_node_id: node
    });
    fs.writeFileSync(
      path.join(killed.artifactDir, "findings.json"),
      `${JSON.stringify([finding("GOAL-PHANTOM", killed.metadata.node.producerNodeId!)])}\n`
    );
    assert.deepEqual(
      chain.dependencyFindingSources(dedupe, dedupe.artifactDir),
      [],
      "an unattested goal lane must contribute no provenance even when its canonical findings validate"
    );

    // ...and the reader is not simply blind: the attested lane's findings do come through, so the
    // emptiness above is the marker probe working rather than the scan failing.
    fs.rmSync(path.join(searched.artifactDir, "findings.json"));
    fs.writeFileSync(
      path.join(searched.artifactDir, "findings.json"),
      `${JSON.stringify([finding("GOAL-1", searched.metadata.node.producerNodeId!)])}\n`
    );
    const sources = chain.dependencyFindingSources(dedupe, dedupe.artifactDir);
    assert.deepEqual(
      sources.map((source) => source.node_id),
      [searched.metadata.node.producerNodeId]
    );
    assert.deepEqual(
      sources.map((source) => (source.finding as { id: string }).id),
      ["GOAL-1"],
      "the phantom lane's finding must never appear in dedupe provenance"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

/**
 * The half of the #677 gate that lives in the render and that no executable test of `verifyArtifacts`
 * can reach.
 *
 * `verifyArtifacts` refusing without evidence is only worth anything while the evidence is real. A
 * render that passed `{ agentReturned: true }` unconditionally, or that derived the flag from anything
 * in the workspace, would satisfy every behavioural assertion above and restore the defect exactly.
 * So the source of the evidence is asserted here, and it has to be the one fact in the run a model
 * cannot author: Smithers' own durable output row for the agent task.
 *
 * The literal `true` is allowed at exactly one site -- the in-agent call, which sits after
 * `await agent.generate(...)` and therefore cannot be reached unless the agent returned. That is why
 * the count of literal-true call sites is asserted rather than just their presence.
 */
test("the #677 evidence for a goal lane's verifier is Smithers' own durable agent output row", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");

  // Mandatory second parameter, no default and no optional marker: omitting it must be a call-site
  // error rather than a silent `undefined` that the `!== true` check then happens to reject. The
  // template is not covered by `tsc`, so the shape is asserted as text.
  assert.match(
    source,
    /function verifyArtifacts\(\s*task: \(typeof taskSpecs\)\[number\],\s*evidence: \{ agentReturned: boolean \}\s*\): z\.infer<typeof verificationOutput> \{/u
  );
  assert.doesNotMatch(source, /evidence\?: \{ agentReturned/u);
  assert.doesNotMatch(source, /agentReturned: boolean = /u);

  // The probe, read once per render and passed into both execution modes' verifiers.
  assert.match(
    source,
    /const agentReturned = ctx\.outputMaybe\(outputs\.task, \{ nodeId: task\.id \}\) !== undefined;/u
  );
  assert.deepEqual(
    [...source.matchAll(/verifyArtifacts\(task, \{ agentReturned[^)]*\}\)/gu)].map((match) => match[0]),
    [
      // The in-agent call: reachable only after `agent.generate` resolved.
      "verifyArtifacts(task, { agentReturned: true })",
      // The cloud verifier node and the local verifier node, both fed by the render-time probe.
      "verifyArtifacts(task, { agentReturned })",
      "verifyArtifacts(task, { agentReturned })"
    ],
    "the only literal-true evidence may be the in-agent call; both verifier nodes must read the row"
  );
  const agentStart = source.indexOf("function artifactAwareAgent");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  assert.ok(agentStart >= 0 && preparationStart > agentStart, source);
  const agent = source.slice(agentStart, preparationStart);
  assert.ok(
    agent.indexOf("const result = await agent.generate(attemptArgs)") <
      agent.indexOf("verifyArtifacts(task, { agentReturned: true })"),
    "the in-agent call may claim the agent returned only because it runs after `agent.generate` resolved"
  );

  // The census and the verifier must never be able to disagree about whether a lane ran, because the
  // census is what the report quotes and the verifier is what the artifacts attest. Same probe,
  // spelled the same way, against the same output.
  assert.match(
    source,
    /recordGoalSearchCoverage\(\s*taskSpecs,\s*\(nodeId\) => ctx\.outputMaybe\(outputs\.task, \{ nodeId \}\) !== undefined,\s*\(nodeId\) => ctx\.outputMaybe\(outputs\.verification, \{ nodeId \}\) !== undefined\s*\);/u
  );

  // Ordering inside the verifier, which the behavioural test proves and this pins in the source so a
  // reordering reads as a deliberate edit: clear the stale marker, refuse, and only then touch the
  // filesystem or publish anything.
  const verifierStart = source.indexOf("function verifyArtifacts");
  const workflowStart = source.indexOf("export default smithers");
  assert.ok(verifierStart >= 0 && workflowStart > verifierStart, source);
  const verifier = source.slice(verifierStart, workflowStart);
  assert.match(verifier, /because its agent produced no output row/u);
  assert.ok(
    verifier.indexOf("clearArtifactVerificationMarker(task)") < verifier.indexOf("evidence.agentReturned !== true")
  );
  assert.ok(
    verifier.indexOf("evidence.agentReturned !== true") <
      verifier.indexOf("publishVerifiedArtifacts(artifactDir, publications)")
  );
  assert.ok(
    verifier.indexOf("evidence.agentReturned !== true") <
      verifier.indexOf("writeArtifactVerificationMarker(task, artifacts, publications)")
  );
});

/**
 * The census-to-report path, end to end, with the runtime writing the census and the renderer reading
 * it (#677).
 *
 * The pieces are each tested in isolation elsewhere: `recordGoalSearchCoverage` against handcrafted
 * output rows, `appendGoalSearchCoverage` against handcrafted censuses. Neither catches the failure
 * that matters most here, which is the two halves disagreeing. They are written in different files by
 * different edits and connected only by field names and status spellings, so a renamed status or a
 * renamed file makes a run that measured its coverage perfectly report that coverage as unknown --
 * silently, and in the direction of looking cleaner than it is. So this drives the real recorder into
 * a real file, stamps the bytes it wrote into a report the way the runtime does, and renders it.
 *
 * The scenario is the measured one: of 77 targeted class-goal lanes, 3 returned and verified and 74
 * were killed at their timeout, plus one untargeted roaming lane that was also killed. A report built
 * on that evidence describes roughly 4% of its plan, and every one of the 74 silent lanes is holding a
 * contract-valid empty findings array.
 */
test("the runtime's own goal-search census renders as partial coverage in report.md", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-census-report-"));
  try {
    // The file name and the schema version are the join between the runtime that writes the census and
    // the CLI and renderer that read it, and `workflow.tsx` declares its own copies of both because a
    // generated template cannot import a value it renders before the package is built. A divergence
    // renders as "coverage unknown" on a run that measured coverage exactly, so the copies are pinned
    // to the exported constants rather than to each other.
    const template = fs.readFileSync(workflowTemplatePath, "utf8");
    assert.match(
      template,
      new RegExp(`const GOAL_SEARCH_COVERAGE_FILE = ${JSON.stringify(GOAL_SEARCH_COVERAGE_FILE)};`, "u")
    );
    assert.match(
      template,
      new RegExp(
        `const GOAL_SEARCH_COVERAGE_SCHEMA_VERSION = ${JSON.stringify(GOAL_SEARCH_COVERAGE_SCHEMA_VERSION)};`,
        "u"
      )
    );

    // The same join reaches the two review prompts, which tell the report and dedupe agents where the
    // census is and what its schema version is. `packages/prompts` cannot import from
    // `@ultrafuzz/runtime` (the dependency runs the other way), so the comparison against the exported
    // constants has to happen here. A rename that updated the runtime and the CLI but not the prompts
    // would leave both agents looking for a file that no longer exists.
    for (const relativePath of ["review/final-report.md", "review/dedupe-findings.md"]) {
      const promptBody = fs.readFileSync(path.join(repositoryRoot, ".ultrafuzz", "prompts", relativePath), "utf8");
      assert.ok(promptBody.includes(GOAL_SEARCH_COVERAGE_FILE), `${relativePath} must name the census file`);
      assert.ok(
        promptBody.includes(GOAL_SEARCH_COVERAGE_SCHEMA_VERSION),
        `${relativePath} must name the census schema version`
      );
    }

    const coveragePath = path.join(runRoot, GOAL_SEARCH_COVERAGE_FILE);
    const searched = new Set(["lane-00", "lane-01", "lane-02"]);
    const record = loadGoalSearchCoverageRecorder(
      () => coveragePath,
      (task) => (searched.has(task.attemptId) ? 0 : undefined)
    );
    const lanes = Array.from({ length: 77 }, (_unused, index) => {
      const attemptId = `lane-${String(index).padStart(2, "0")}`;
      return {
        id: `task:${attemptId}`,
        verifierId: `verify:${attemptId}`,
        attemptId,
        runRoot,
        metadata: {
          node: { group: "goals", concreteNodeId: `dynamic:class:${attemptId}`, logicalNodeId: "class-goals" }
        }
      };
    });
    // The roaming pass shares the `goals` group, so it is in the census, but it is not a targeted goal
    // and must not be able to move the targeted numerator or denominator in either direction.
    const roaming = {
      id: "task:goal-roaming",
      verifierId: "verify:goal-roaming",
      attemptId: "goal-roaming",
      runRoot,
      metadata: { node: { group: "goals", concreteNodeId: "goal-roaming", logicalNodeId: "goal-roaming" } }
    };
    record(
      [...lanes, roaming],
      (nodeId) => searched.has(nodeId.replace(/^task:/u, "")),
      (nodeId) => searched.has(nodeId.replace(/^verify:/u, ""))
    );

    const census = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as {
      schema_version: string;
      totals: Record<string, number>;
    };
    assert.equal(census.schema_version, GOAL_SEARCH_COVERAGE_SCHEMA_VERSION);
    assert.equal(census.totals.stopped_early, 75);

    // Stamped exactly as the runtime stamps it: the field is runtime-owned, so whatever the report
    // agent claimed about its own coverage is discarded rather than merged.
    const stamp = loadReportGoalSearchCoverageReplacer();
    const stamped = stamp(
      `${JSON.stringify(
        {
          schema_version: "1.0",
          run_metadata: { run_id: "census-to-report" },
          issues: [],
          non_production_outcomes: [],
          property_provenance: [],
          goal_search_coverage: "every goal search completed"
        },
        null,
        2
      )}\n`,
      census
    );
    assert.ok(stamped);
    const markdown = projectCanonicalFinalReport(JSON.parse(stamped)).markdown;

    // The section exists, leads with the shortfall in bold, and states the numbers the census records
    // rather than any number the agent authored.
    assert.match(markdown, /\n## Goal search coverage\n/u);
    assert.match(markdown, /\*\*Partial goal search coverage: only 3 of 77 targeted goal searches completed\.\*\*/u);
    assert.match(markdown, /- Targeted goal search lanes: `77`\n/u);
    assert.match(markdown, /- Completed with a verified result: `3`\n/u);
    assert.match(markdown, /- Stopped early without returning: `74`\n/u);
    // 74 targeted lanes were killed, and the 75th `stopped-early` entry is the roaming pass. It is
    // reported on its own line, so it neither pads the targeted denominator nor dilutes the shortfall.
    assert.match(markdown, /- Untargeted roaming passes, counted separately: `0` of `1` completed\n/u);
    assert.doesNotMatch(markdown, /of 78 targeted goal searches/u);

    // An empty issue list under partial coverage is not a result, and the sentence that would otherwise
    // read as one carries the numbers and a link instead.
    assert.match(
      markdown,
      /No issues were reported, but only 3 of 77 targeted goal searches completed, so this is not a result\. See \[Goal search coverage\]\(#goal-search-coverage\)\./u
    );
    assert.doesNotMatch(markdown, /\nNo issues reported\.\n/u);
    // A killed lane is never described as a searched one, whatever its seeded artifacts look like.
    assert.doesNotMatch(markdown, /all 77 targeted goal searches completed/iu);

    // The other half of item 4: an unreadable census must SAY unknown. Rendering nothing is the failure
    // mode that matters, because a report with no coverage section reads exactly like a report whose
    // coverage was complete, and that is the inversion this whole section exists to prevent.
    for (const [label, value] of [
      ["the CLI's explicit sentinel", "unavailable"],
      ["a census from a future schema", { ...census, schema_version: "ultrafuzz.goal-search-coverage.v2" }],
      ["a census with no lanes", { ...census, goals: [], totals: { ...census.totals, planned: 0 } }]
    ] as const) {
      const unknown = projectCanonicalFinalReport({
        schema_version: "1.0",
        run_metadata: { run_id: "census-to-report" },
        issues: [],
        non_production_outcomes: [],
        property_provenance: [],
        goal_search_coverage: value
      }).markdown;
      assert.match(unknown, /\n## Goal search coverage\n/u, label);
      assert.match(unknown, /\*\*Goal search coverage is unknown\.\*\*/u, label);
      assert.match(unknown, /Unknown coverage is not full coverage\./u, label);
      // No count bullets at all, so an unknown census can never be misread as a run of zeros or as a
      // run that completed everything.
      assert.doesNotMatch(unknown, /- Targeted goal search lanes: /u, label);
      assert.doesNotMatch(unknown, /- Stopped early without returning: /u, label);
    }

    // A report with no `goal_search_coverage` field at all is the same case, and it is the one a
    // relocated cloud worker and every pre-#677 historical report produce.
    const absent = projectCanonicalFinalReport({
      schema_version: "1.0",
      run_metadata: { run_id: "census-to-report" },
      issues: [],
      non_production_outcomes: [],
      property_provenance: []
    }).markdown;
    assert.match(absent, /\*\*Goal search coverage is unknown\.\*\*/u);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
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
