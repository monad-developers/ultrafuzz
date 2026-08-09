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
  assertRegularFileInside,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES,
  normalizeNodeAttemptFailureMessage,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  writeFileDurable
} from "@ultrafuzz/artifacts";

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function loadRetryFailureAwareArgs(): (
  args: { prompt?: unknown } | undefined,
  previousFailure: string | undefined
) => { prompt?: unknown } | undefined {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const helperStart = source.indexOf("function retryFailureAwareArgs");
  const helperEnd = source.indexOf("\n\nfunction isStrictlyInsideDirectory", helperStart);
  assert.ok(helperStart >= 0, source);
  assert.ok(helperEnd > helperStart, source);
  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("untrustedContentBoundary", `${helper}; return retryFailureAwareArgs;`)(
    "UNTRUSTED CONTENT BOUNDARY"
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

  const helper = ts.transpileModule(source.slice(helperStart, helperEnd), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function(
    "path",
    "existsSync",
    "writeFileSync",
    "mkdirSync",
    "realpathSync",
    "isStrictlyInsideDirectory",
    "resolveNonEmptyRegularArtifactFile",
    "readBoundedRegularArtifactSnapshot",
    "decodeStrictUtf8Snapshot",
    "MAX_VERIFIED_COMPANION_BYTES",
    "INVARIANT_TEST_ROOT_NAMES",
    `${helper}; return materializeGeneratedTestCompanion;`
  )(
    path,
    fs.existsSync,
    fs.writeFileSync,
    fs.mkdirSync,
    fs.realpathSync,
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, missingMessage: string, emptyMessage: string) => {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(missingMessage);
      const resolved = fs.realpathSync(candidate);
      assertRegularFileInside(root, resolved, missingMessage);
      if (fs.statSync(resolved).size === 0) throw new Error(emptyMessage);
      return resolved;
    },
    (root: string, candidate: string, failureMessage: string, maxBytes: number, requireNonEmpty: boolean) => {
      assertRegularFileInside(root, candidate, failureMessage);
      const resolved = fs.realpathSync(candidate);
      const bytes = readRegularFileSnapshot(resolved, maxBytes);
      if (requireNonEmpty && bytes.length === 0) throw new Error(`${failureMessage}: file is empty`);
      return { path: resolved, bytes };
    },
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not valid UTF-8`, { cause: error });
      }
    },
    16 * 1024 * 1024,
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
  const helperEnd = source.indexOf("\n\nfunction materializeGeneratedTestCompanions", helperStart);
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
    outputs: readonly { path: string }[];
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
    "writeFileDurable",
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
    fs.lstatSync,
    fs.realpathSync,
    fs.mkdirSync,
    () => "0000000000000000000000000000000000000000\n",
    createHash,
    writeFileDurable,
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
    outputs: readonly { path: string }[];
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
  fs.mkdirSync(path.join(artifactDir, "setup"), { recursive: true });
  const ledgerPath = path.join(artifactDir, "setup", "invariant-evidence-ledger.json");
  const ledger = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    inventory_rows: [],
    scan_probes: probes
  };
  const contents = JSON.stringify(ledger);
  const bytes = Buffer.from(contents, "utf8");
  fs.writeFileSync(ledgerPath, bytes);
  return {
    root,
    task: {
      attemptId: "attempt-project-discovery",
      workspacePath,
      outputs: [{ path: "setup/invariant-evidence-ledger.json" }],
      metadata: { node: { logicalNodeId: "project-discovery" }, artifacts: { dir: artifactDir } }
    },
    verifiedOutputs: new Map([
      [
        "setup/invariant-evidence-ledger.json",
        { artifactRoot: artifactDir, file: { path: ledgerPath, bytes }, contents, value: ledger }
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
  assert.match(source, /artifactContractDefinition,[\s\S]*assertRegularFileInside,[\s\S]*validateArtifactContract/u);
  assert.match(source, /validateArtifactContract,[\s\S]*writeFileDurable[\s\S]*= await import/u);
  assert.match(source, /assertRegularFileInside\(artifactDir, artifactPath, failureMessage\)/u);
  assert.match(helper, /readRegularFileSnapshot\(resolvedPath, maxBytes\)/u);
  assert.match(helper, /requireNonEmpty && bytes\.length === 0/u);
  assert.match(helper, /file is empty/u);

  const generatedTestVerifier = source.slice(verifierStart, workflowStart);
  assert.match(generatedTestVerifier, /readBoundedRegularArtifactSnapshot\(/u);
  assert.match(generatedTestVerifier, /MAX_VERIFIED_COMPANION_BYTES,\s*true/u);
  assert.match(generatedTestVerifier, /decodeStrictUtf8Snapshot\(snapshot/u);
});

type VerifyArtifactsTask = {
  attemptId: string;
  metadata: { artifacts: { dir: string }; node: { logicalNodeId: string } };
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

function loadVerifyArtifactsHarness(): {
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
} {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const captureStart = source.indexOf("function captureTaskOutputs");
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts", captureStart);
  const verifierStart = source.indexOf("function verifyArtifacts", finalizerStart);
  const verifierEnd = source.indexOf("function readInvariantSourceSnapshot", verifierStart);
  assert.ok(captureStart >= 0 && finalizerStart > captureStart, source);
  assert.ok(verifierStart > finalizerStart && verifierEnd > verifierStart, source);
  const emitted = ts.transpileModule(
    `${source.slice(captureStart, finalizerStart)}\n${source.slice(verifierStart, verifierEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const publications = new Map<string, Buffer>();
  const remember = (values: Map<string, Buffer>, relativePath: string, bytes: Buffer): void => {
    const previous = values.get(relativePath);
    if (previous !== undefined && !previous.equals(bytes)) throw new Error(`conflicting ${relativePath}`);
    values.set(relativePath, bytes);
  };
  const factory = new Function(
    "path",
    "realpathSync",
    "taskArtifactRoots",
    "isStrictlyInsideDirectory",
    "readBoundedRegularArtifactSnapshot",
    "MAX_VERIFIED_ARTIFACT_BYTES",
    "clearArtifactVerificationMarker",
    "decodeStrictUtf8Snapshot",
    "artifactContractDefinition",
    "parseStrictJsonSnapshot",
    "validateArtifactContract",
    "formatSchemaValidationIssues",
    "rememberVerifiedPublication",
    "verifyGeneratedTestFiles",
    "verifyInvariantLedgerSourceEvidence",
    "invariantSuiteNodeIds",
    "rememberInvariantSuitePublications",
    "createHash",
    "publishVerifiedArtifacts",
    "writeArtifactVerificationMarker",
    `${emitted}; return { captureTaskOutputs, verifyArtifacts };`
  )(
    path,
    fs.realpathSync,
    (_task: VerifyArtifactsTask, artifactDir: string) => [artifactDir],
    (root: string, candidate: string) => candidate !== root && candidate.startsWith(`${root}${path.sep}`),
    (root: string, candidate: string, failureMessage: string, maxBytes: number) => {
      if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error(failureMessage);
      const resolved = fs.realpathSync(candidate);
      return Object.freeze({ path: resolved, bytes: readRegularFileSnapshot(resolved, maxBytes) });
    },
    64 * 1024 * 1024,
    () => undefined,
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not valid UTF-8`, { cause: error });
      }
    },
    (contract: string) => ({ format: contract === "ultrafuzz/text@1" ? "text" : "json" }),
    (snapshot: { bytes: Buffer }, failureMessage: string) => {
      try {
        return parseStrictJsonBytes(snapshot.bytes);
      } catch (error) {
        throw new Error(`${failureMessage}: file is not strict JSON`, { cause: error });
      }
    },
    (contract: string, contents: string) => ({
      ok: true,
      issues: [],
      value: contract === "ultrafuzz/text@1" ? contents : parseStrictJsonBytes(Buffer.from(contents, "utf8"))
    }),
    () => "invalid",
    remember,
    () => [],
    () => undefined,
    new Set<string>(),
    () => undefined,
    createHash,
    (_artifactDir: string, values: ReadonlyMap<string, Buffer>) => {
      for (const [relativePath, bytes] of values) publications.set(relativePath, Buffer.from(bytes));
    },
    () => undefined
  ) as {
    captureTaskOutputs: ReturnType<typeof loadVerifyArtifactsHarness>["captureTaskOutputs"];
    verifyArtifacts: ReturnType<typeof loadVerifyArtifactsHarness>["verifyArtifacts"];
  };
  return { ...factory, publications };
}

function singleOutputVerificationTask(root: string, contract: string): VerifyArtifactsTask {
  return {
    attemptId: "attempt-one",
    metadata: { artifacts: { dir: root }, node: { logicalNodeId: "node-one" } },
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

test("generated Smithers hashes and publishes the captured output after its path changes", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-output-snapshot-")));
  try {
    const outputPath = path.join(root, "result.json");
    const original = Buffer.from("captured bytes\n", "utf8");
    fs.writeFileSync(outputPath, original);
    const harness = loadVerifyArtifactsHarness();
    const task = singleOutputVerificationTask(root, "ultrafuzz/text@1");
    const captured = harness.captureTaskOutputs(task);
    fs.writeFileSync(outputPath, "mutated after capture\n", "utf8");

    const result = harness.verifyArtifacts(task, captured);

    assert.equal(result.artifacts[0]?.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(harness.publications.get("result.json")?.equals(original), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test("generated Smithers workflow binds every planned output to the preflighted schema bundle before agent work", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const preparationStart = source.indexOf("function prepareArtifactMirror");
  const bindingStart = source.indexOf("function assertTaskOutputSchemaBindings", preparationStart);
  const preflightStart = source.indexOf("function preflightJsonValidator", bindingStart);
  const preparation = source.slice(preparationStart, bindingStart);
  const binding = source.slice(bindingStart, preflightStart);

  assert.ok(preparationStart >= 0, source);
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
  assert.match(source, /parsed = parseStrictJsonBytes\(Buffer\.from\(stdout, "utf8"\)\)/u);
  assert.doesNotMatch(
    source.slice(preflightStart, source.indexOf("function taskPublishesWorkspacePatch")),
    /JSON\.parse/u
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
  const proofEnd = source.indexOf("\n\nfunction materializeGeneratedTestCompanions", proofStart);
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
  assert.match(source, /ultrafuzz\.agent-source-proof\.v1/u);
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
    const canonicalProof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as { refs: unknown[] };
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
  assert.match(reset, /output\.contract === "ultrafuzz\/generated-tests@2"/u);
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
  const agentEnd = source.indexOf("\n\nfunction retryFailureText", agentStart);

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
    /canonicalEmptyArtifact|materializeMissingMarkdownArtifacts|materializeMissingDedupeArtifact|materializeMissingFinalReportArtifacts|normalizeLegacyFinding|normalizeLegacyReportProvenance|normalizeLegacyGeneratedTest/u
  );
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

test("generated Smithers agent rejects legacy generated-test string lists without conversion", () => {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  assert.doesNotMatch(source, /normalizeLegacyGeneratedTestManifests|typeof entry === "string" \? \{ path: entry \}/u);
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
  assert.match(materializer, /readBoundedRegularArtifactSnapshot\(/u);
  assert.match(materializer, /MAX_VERIFIED_COMPANION_BYTES,\s*true/u);
  assert.match(materializer, /decodeStrictUtf8Snapshot\(snapshot/u);
  assert.match(materializer, /writeFileSync\(anchoredArtifactPath, source\.bytes, \{ flag: "wx", mode: 0o600 \}\)/u);
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
  assert.match(source, /invariant-workspace-snapshot\.v1/u);
  assert.match(source, /loadInvariantSuiteWorkspaceSnapshot/u);
  assert.match(source, /readStableWorkspaceSnapshotFile/u);
  assert.match(source, /const runRootCandidate = path\.resolve\(process\.cwd\(\), task\.runRoot\)/u);
  assert.match(source, /runRootStat = lstatSync\(runRootCandidate\)/u);
  assert.match(source, /realpathSync\(runRootCandidate\) !== runRootCandidate/u);
  assert.match(source, /readRegularFileSnapshot\(resolvedPath, maxBytes\)/u);
  assert.match(source, /parseStrictJsonBytes\(manifestBytes\)/u);
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
  assert.match(verifier, /rememberVerifiedPublication\(publications, output\.path, file\.bytes\)/u);
  assert.match(verifier, /verifyGeneratedTestFiles\(artifactRoot, value\)/u);
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
    schemaId: "urn:ultrafuzz:schema:artifacts:generated-tests:2",
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
      metadata: { node: { logicalNodeId: "generated-tests-fanin" } },
      outputs: [
        {
          path: "generated-tests.json",
          contract: "ultrafuzz/generated-tests@2",
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
    "validateArtifactContract",
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
    (contract: string) => ({
      ok: true,
      issues: [],
      value:
        contract === "ultrafuzz/generated-tests@2"
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
  assert.doesNotThrow(() => assertVerifiedDependency(task, dependency));
  fs.mkdirSync(path.join(generatedDependency, "generated-tests"), { recursive: true });
  const generatedBytes = Buffer.from('{"generated_tests":[{"path":"generated-tests/Property.t.sol"}]}\n');
  fs.writeFileSync(path.join(generatedDependency, "generated-tests.json"), generatedBytes);
  const generatedArtifact = {
    path: "generated-tests.json",
    contract: "ultrafuzz/generated-tests@2",
    contract_digest: "a".repeat(64),
    ...markerSchemaBinding,
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
  assert.match(helper, /for \(const capture of captures\) validateWorkspacePatchCapture\(workspaceRoot, capture\);/u);
  // The skip is only sound when the skipped prefix is a real chain; a sibling fan-in must replay.
  assert.match(source, /return chained \? index \+ 1 : 0;/u);
  assert.match(helper, /captures\.slice\(replayFrom\)/u);
  const finalizerStart = source.indexOf("function finalizeAndVerifyArtifacts");
  const verifierStart = source.indexOf("\n\nfunction verifyArtifacts", finalizerStart);
  assert.ok(finalizerStart >= 0, source);
  assert.ok(verifierStart > finalizerStart, source);
  assert.match(
    source.slice(finalizerStart, verifierStart),
    /prepareArtifactMirror\(task, \{ replayWorkspacePatches: false, evidenceMode: "require" \}\);/u
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
