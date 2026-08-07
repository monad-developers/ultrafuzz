import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeFileDurable } from "@ultrafuzz/artifacts";
import ts from "typescript";

/**
 * Regression coverage for #217 (invariant-suite deletions must survive the
 * ancestor handoff), #219 (the handoff provenance must be rebuildable from
 * durable run state rather than a module-level Map) and #218 (the source
 * budgets must bound the traversal and the whole ancestor union, not one
 * ancestor at a time and not after the bytes are already on disk).
 *
 * The generated Smithers workflow is a template rather than an importable
 * module, so these tests lift the real top-level helpers out of the template,
 * erase their type annotations with the TypeScript transpiler, and run them
 * against a real filesystem with explicit collaborators.
 */

const runtimePackageRoot = findRuntimePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const workflowTemplatePath = path.join(runtimePackageRoot, "src", "templates", "smithers", "workflows", "workflow.tsx");

function findRuntimePackageRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "@ultrafuzz/runtime") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("unable to locate the @ultrafuzz/runtime package root");
    current = parent;
  }
}

type SuiteEntry = { dependency: string; bytes: Buffer; direct: boolean };

type TaskSpecLike = {
  attemptId: string;
  artifactDir: string;
  workspacePath: string;
  runRoot: string;
  dependencyArtifactDirs: string[];
  outputs: Array<{ path: string; contract: string }>;
  metadata: {
    node: { logicalNodeId: string };
    dependencies: { attemptIds: string[] };
    artifacts: { dir: string };
  };
};

type WorkflowHelpers = {
  materializeInvariantSuiteFromDependencies?: (task: TaskSpecLike, workspaceRoot: string) => void;
  materializeInvariantSuiteCompanions?: (task: TaskSpecLike) => void;
  rememberInvariantSuitePublications?: (
    task: TaskSpecLike,
    publications: Map<string, Buffer>,
    artifactRoots: readonly string[]
  ) => void;
  resetTaskArtifactsForRetry?: (task: TaskSpecLike) => void;
  changedTestTreePaths?: (workspaceRoot: string, baselinePath?: string, protectedBaselinePath?: string) => string[];
  listInvariantSuiteSources?: (suiteRoot: string, relative?: string, budget?: SuiteBudget) => string[];
  captureInvariantSuiteBaseline?: (task: TaskSpecLike, workspaceRoot: string) => void;
  invariantSuiteProtectedBaselinePath?: (task: TaskSpecLike) => string;
  assertSafeInvariantSuitePath?: (value: string) => string;
  assertSafeInvariantSuiteTestPath?: (value: string) => string;
  assertInvariantSuiteSourceBudget?: (fileCount: number, totalBytes: number) => void;
};

/** The running file/byte allowance `listInvariantSuiteSources` spends while it walks. */
type SuiteBudget = { files: number; totalBytes: number };

/** Slice a top-level `function name(...)` declaration out of the template. */
function sliceTopLevelFunction(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  if (start < 0) return "";
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `unterminated helper ${name}`);
  return `${source.slice(start, end + 3)}\n`;
}

type HarnessState = {
  tombstones: Map<string, Set<string>>;
  dependencySnapshots: Map<string, Map<string, SuiteEntry>>;
  publicationSnapshots: Map<string, Map<string, Buffer>>;
  workspaceSnapshots: Map<string, Map<string, Buffer>>;
  baselineSnapshots: Map<string, { contents: string; sha256: string }>;
  protectedBaselineSnapshots: Map<string, { contents: string; sha256: string }>;
  taskSpecs: TaskSpecLike[];
  changedTestTreePaths: string[];
  changedInvariantSourcePaths: string[];
};

const INVARIANT_SUITE_NODE_IDS = new Set([
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-campaign"
]);

function isStrictlyInsideDirectory(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function assertSafeInvariantSuitePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || value.split("/").includes("..")) {
    throw new Error(`artifact-contract failure: unsafe invariant suite source path ${String(value)}`);
  }
  return value;
}

function resolveRegularArtifactFile(root: string, candidate: string, failureMessage: string): string {
  try {
    const resolved = fs.realpathSync(candidate);
    if (!isStrictlyInsideDirectory(root, resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(failureMessage);
    }
    return resolved;
  } catch {
    throw new Error(failureMessage);
  }
}

function resolveNonEmptyRegularArtifactFile(
  root: string,
  candidate: string,
  missingMessage: string,
  emptyMessage: string
): string {
  const resolved = resolveRegularArtifactFile(root, candidate, missingMessage);
  if (fs.statSync(resolved).size === 0) throw new Error(emptyMessage);
  return resolved;
}

function listInvariantSuiteSources(suiteRoot: string, relative = ""): string[] {
  const current = relative.length === 0 ? suiteRoot : path.join(suiteRoot, relative);
  if (fs.lstatSync(current).isFile()) return [relative.split(path.sep).join("/")];
  return fs
    .readdirSync(current)
    .flatMap((entry) =>
      listInvariantSuiteSources(suiteRoot, relative.length === 0 ? entry : path.join(relative, entry))
    );
}

function readInvariantSuiteSourceBytes(suiteRoot: string, relativePath: string, prefix: string): Buffer {
  return fs.readFileSync(
    resolveNonEmptyRegularArtifactFile(
      suiteRoot,
      path.resolve(suiteRoot, relativePath),
      `${prefix} source is missing ${relativePath}`,
      `${prefix} source is empty ${relativePath}`
    )
  );
}

function copyInvariantSuiteIntoWorkspace(workspaceRoot: string, suiteRoot: string, relativePath: string): void {
  const bytes = readInvariantSuiteSourceBytes(suiteRoot, relativePath, "artifact handoff invariant suite");
  const destination = path.resolve(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeFileDurable(destination, bytes);
}

function safeInvariantSuiteDirectory(root: string, candidate: string): string {
  fs.mkdirSync(candidate, { recursive: true });
  const resolved = fs.realpathSync(candidate);
  if (resolved !== fs.realpathSync(root) && !isStrictlyInsideDirectory(fs.realpathSync(root), resolved)) {
    throw new Error(`artifact-contract failure: invariant suite directory escapes root ${candidate}`);
  }
  return resolved;
}

function copyInvariantSuiteSource(workspaceRoot: string, artifactRoot: string, relativePath: string): void {
  const bytes = fs.readFileSync(path.resolve(workspaceRoot, relativePath));
  const destination = path.resolve(artifactRoot, "invariant-suite", relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeFileDurable(destination, bytes);
}

/**
 * Build the requested template helpers with explicit collaborators. Helper
 * names that do not exist yet resolve to nothing, so a test can express the
 * behavior a fix must deliver before the fix introduces its helpers.
 */
function loadWorkflowHelpers(
  names: readonly string[],
  state: HarnessState,
  overrides: Record<string, unknown> = {}
): WorkflowHelpers {
  const source = fs.readFileSync(workflowTemplatePath, "utf8");
  const declarations = names.map((name) => sliceTopLevelFunction(source, name)).join("\n");
  const emitted = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const present = names.filter((name) => new RegExp(`\\bfunction ${name}\\(`, "u").test(declarations));

  const bag: Record<string, unknown> = {
    path,
    Buffer,
    createHash,
    execFileSync,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    realpathSync: fs.realpathSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
    mkdirSync: fs.mkdirSync,
    rmSync: fs.rmSync,
    writeFileDurable,
    isStrictlyInsideDirectory,
    isPlainRecord: (value: unknown): boolean => typeof value === "object" && value !== null && !Array.isArray(value),
    isMissingPathError: (error: unknown): boolean =>
      error instanceof Error && "code" in error && error.code === "ENOENT",
    invariantSuiteNodeIds: INVARIANT_SUITE_NODE_IDS,
    invariantSuiteTombstones: state.tombstones,
    invariantSuiteDependencySnapshots: state.dependencySnapshots,
    invariantSuitePublicationSnapshots: state.publicationSnapshots,
    invariantSuiteWorkspaceSnapshots: state.workspaceSnapshots,
    invariantSuiteBaselineSnapshots: state.baselineSnapshots,
    invariantSuiteProtectedBaselineSnapshots: state.protectedBaselineSnapshots,
    loadInvariantSuiteWorkspaceSnapshot: (task: TaskSpecLike) => state.workspaceSnapshots.get(task.attemptId),
    taskSpecs: state.taskSpecs,
    pinnedSourceRef: "refs/heads/ultrafuzz/pinned-source",
    INVARIANT_SUITE_MANIFEST_FILE: "invariant-suite-manifest.json",
    INVARIANT_SUITE_BASELINE_FILE: "invariant-suite-baseline.json",
    INVARIANT_SUITE_HANDOFF_DIR: "invariant-suite-handoffs",
    INVARIANT_SUITE_HANDOFF_FILE: "handoff.json",
    INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION: "ultrafuzz.invariant-suite-handoff.v1",
    MAX_INVARIANT_SUITE_FILES: 512,
    MAX_INVARIANT_SUITE_SOURCE_BYTES: 16 * 1024 * 1024,
    MAX_INVARIANT_SUITE_TOTAL_BYTES: 64 * 1024 * 1024,
    MAX_INVARIANT_SUITE_SOURCE_DEPTH: 32,
    MAX_INVARIANT_SUITE_PATH_LENGTH: 4_096,
    MAX_INVARIANT_SUITE_SEGMENT_LENGTH: 255,
    INVARIANT_SUITE_SENSITIVE_SEGMENTS: new Set([".git", ".ultrafuzz", ".smithers", "node_modules", ".env"]),
    INVARIANT_SUITE_ALLOWED_ROOTS: ["src", "contracts", "test", "tests"] as const,
    resolveRegularArtifactFile,
    resolveNonEmptyRegularArtifactFile,
    listInvariantSuiteSources,
    readInvariantSuiteSourceBytes,
    copyInvariantSuiteIntoWorkspace,
    copyInvariantSuiteSource,
    safeInvariantSuiteDirectory,
    assertSafeInvariantSuitePath,
    assertSafeInvariantSuiteTestPath: assertSafeInvariantSuitePath,
    assertInvariantSuiteSourceBudget: () => undefined,
    assertInvariantSuiteSourceSize: (relativePath: string, size: number) => {
      if (!Number.isSafeInteger(size) || size < 1) {
        throw new Error(
          `artifact-contract failure: invariant suite source exceeds the file byte limit ${relativePath}`
        );
      }
    },
    validateImplementedPropertiesSchema: () => ({ ok: false, value: undefined }),
    taskArtifactRoots: (task: TaskSpecLike) => [fs.realpathSync(task.metadata.artifacts.dir)],
    invariantSuiteProtectedBaselinePath: (task: TaskSpecLike) =>
      path.join(task.runRoot, "protected", `${task.attemptId}.json`),
    changedTestTreePaths: () => [...state.changedTestTreePaths],
    changedInvariantSourcePaths: () => [...state.changedInvariantSourcePaths],
    recordInvariantSuiteTombstone: (workspaceRoot: string, relativePath: string) => {
      const existing = state.tombstones.get(workspaceRoot) ?? new Set<string>();
      existing.add(relativePath);
      state.tombstones.set(workspaceRoot, existing);
    },
    invariantSuiteHandoffRoot: (task: TaskSpecLike) => {
      const root = path.join(task.runRoot, "invariant-suite-handoffs", task.attemptId);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return fs.realpathSync(root);
    },
    invariantSuiteHandoffRecordPath: (task: TaskSpecLike) =>
      path.join(task.runRoot, "invariant-suite-handoffs", task.attemptId, "handoff.json"),
    // Collaborators of resetTaskArtifactsForRetry that are out of scope here.
    resetTaskArtifactContents: () => undefined,
    restoreInvariantSuiteWorkspaceSnapshot: () => undefined,
    restoreWorkspacePatchPreparation: () => undefined,
    prepareArtifactMirror: () => undefined,
    INVARIANT_TEST_ROOT_NAMES: ["test", "tests"] as const,
    invariantTestRoots: () => [] as readonly string[],
    // The discovery helpers capture through the template's bounded git wrapper (#323). Standing in for
    // it keeps this harness on the same string the generated workflow sees; what the bound does when it
    // is exceeded is pinned in invariant-suite-enumeration-overflow.test.ts.
    invariantSuiteGitPaths: (workspaceRoot: string, args: readonly string[]) =>
      execFileSync("git", [...args], { cwd: workspaceRoot, encoding: "utf8" }),
    gitTestTreePaths: (workspaceRoot: string) =>
      execFileSync("git", ["ls-files", "--cached", "--others", "--", "test", "tests"], {
        cwd: workspaceRoot,
        encoding: "utf8"
      })
        .split(/\r?\n/u)
        .filter((value) => value.startsWith("test/") || value.startsWith("tests/"))
        .filter((value) => fs.existsSync(path.resolve(workspaceRoot, value)))
        .filter((value) => fs.statSync(path.resolve(workspaceRoot, value)).size > 0)
        .sort()
  };

  Object.assign(bag, overrides);
  // Never shadow a helper the template actually defines.
  for (const name of present) delete bag[name];

  const keys = Object.keys(bag);
  const factory = new Function(...keys, `${emitted}\nreturn { ${present.join(", ")} };`) as (
    ...args: unknown[]
  ) => WorkflowHelpers;
  return factory(...keys.map((key) => bag[key]));
}

function createHarnessState(taskSpecs: TaskSpecLike[]): HarnessState {
  return {
    tombstones: new Map(),
    dependencySnapshots: new Map(),
    publicationSnapshots: new Map(),
    workspaceSnapshots: new Map(),
    baselineSnapshots: new Map(),
    protectedBaselineSnapshots: new Map(),
    taskSpecs,
    changedTestTreePaths: [],
    changedInvariantSourcePaths: []
  };
}

const HANDOFF_RECORD_HELPERS = [
  "assertInvariantSuiteTombstoneBudget",
  "parseInvariantSuiteManifestRecord",
  "readInvariantSuiteManifestRecord",
  "invariantSuiteProducerTask",
  "inheritedInvariantSuiteTombstones",
  "invariantSuiteDependencyFingerprints",
  "invariantSuiteFingerprintKey",
  "writeInvariantSuiteDependencyHandoff",
  "loadInvariantSuiteDependencyHandoff",
  "resolveInvariantSuiteDependencySnapshot",
  "resolveInheritedInvariantSuiteTombstones"
] as const;

const MATERIALIZATION_HELPERS = [
  ...HANDOFF_RECORD_HELPERS,
  "invariantSuiteAncestorSupersedes",
  "orderedInvariantSuiteDependencies",
  "invariantSuiteDependencySuitePaths",
  "assertInvariantSuiteDependencyExpectations",
  "reconcileInvariantSuiteWorkspace",
  "materializeInvariantSuiteFromDependencies"
] as const;

/**
 * Provenance path validation, lifted whole. The harness stub for
 * `assertSafeInvariantSuitePath` only rejects absolute paths and traversal, so
 * a list that stubs it cannot say anything about supported roots or internal
 * state segments.
 */
const PROVENANCE_HELPERS = [
  "assertSafeInvariantSuitePath",
  "assertSafeInvariantSuiteTestPath",
  "assertInvariantSuiteSourceBudget",
  "assertInvariantSuiteSourceSize"
] as const;

const PUBLICATION_HELPERS = [
  ...PROVENANCE_HELPERS,
  "assertInvariantSuiteTombstoneBudget",
  "parseInvariantSuiteManifestRecord",
  "readInvariantSuiteManifestRecord",
  "rememberVerifiedPublication",
  "recoverInvariantSuitePublicationSnapshot",
  "listInvariantSuiteSources",
  "rememberInvariantSuitePublications"
] as const;

const COMPANION_HELPERS = [
  ...HANDOFF_RECORD_HELPERS,
  "assertSafeInvariantSuitePath",
  "assertSafeInvariantSuiteTestPath",
  "resetInvariantSuiteArtifactRoot",
  "copyDependencyInvariantSuiteToArtifact",
  "materializeInvariantSuiteCompanions"
] as const;

const RETRY_HELPERS = ["invariantTestRoots", "resetTaskArtifactsForRetry"] as const;

const DISCOVERY_HELPERS = [
  "gitTestTreePaths",
  "recordInvariantSuiteTombstone",
  "invariantSuiteProtectedBaselinePath",
  "captureInvariantSuiteBaseline",
  "changedTestTreePaths"
] as const;

function writeSuiteSource(artifactDir: string, relativePath: string, contents: string): void {
  const target = path.join(artifactDir, "invariant-suite", relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function writeSuiteManifest(
  artifactDir: string,
  producerNodeId: string,
  producerAttemptId: string,
  files: readonly string[],
  tombstones?: readonly string[]
): void {
  fs.writeFileSync(
    path.join(artifactDir, "invariant-suite-manifest.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.invariant-suite-manifest.v1",
      producer_node_id: producerNodeId,
      producer_attempt_id: producerAttemptId,
      files: [...files].sort().map((relativePath) => {
        const contents = fs.readFileSync(path.join(artifactDir, "invariant-suite", relativePath));
        return {
          path: relativePath,
          size_bytes: contents.length,
          sha256: createHash("sha256").update(contents).digest("hex")
        };
      }),
      ...(tombstones === undefined ? {} : { tombstones: [...tombstones].sort() })
    })}\n`,
    "utf8"
  );
}

function makeTaskSpec(
  runRoot: string,
  attemptId: string,
  logicalNodeId: string,
  dependencyAttemptIds: readonly string[],
  directDependencyAttemptIds: readonly string[]
): TaskSpecLike {
  const artifactDir = path.join(runRoot, "artifacts", attemptId);
  const workspacePath = path.join(runRoot, "workspaces", attemptId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  return {
    attemptId,
    artifactDir,
    workspacePath,
    runRoot,
    dependencyArtifactDirs: dependencyAttemptIds.map((dependency) => path.join(runRoot, "artifacts", dependency)),
    outputs: [],
    metadata: {
      node: { logicalNodeId },
      dependencies: { attemptIds: [...directDependencyAttemptIds] },
      artifacts: { dir: artifactDir }
    }
  };
}

/**
 * Build a linear setup -> handlers -> coverage chain. `dependencyArtifactDirs`
 * is the full transitive ancestor closure, so coverage sees the setup artifact
 * directly even though handlers is its only declared dependency.
 */
function createInvariantChain(): {
  runRoot: string;
  setup: TaskSpecLike;
  handlers: TaskSpecLike;
  coverage: TaskSpecLike;
  state: HarnessState;
} {
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-handoff-"));
  const setup = makeTaskSpec(runRoot, "setup", "stateful-invariant-setup", [], []);
  const handlers = makeTaskSpec(runRoot, "handlers", "stateful-invariant-handlers", ["setup"], ["setup"]);
  const coverage = makeTaskSpec(
    runRoot,
    "coverage",
    "stateful-invariant-coverage",
    ["setup", "handlers"],
    ["handlers"]
  );
  return { runRoot, setup, handlers, coverage, state: createHarnessState([setup, handlers, coverage]) };
}

test("#217 a source deleted at an invariant stage is not resurrected from an indirect ancestor", () => {
  const { runRoot, setup, handlers, coverage, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* stale */ }\n");
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", [
      "test/recon/Properties.sol",
      "test/recon/TargetFunctions.sol"
    ]);

    // handlers deleted Properties.sol, so its published suite omits the file
    // and its manifest carries the deletion.
    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteManifest(
      handlers.artifactDir,
      "stateful-invariant-handlers",
      "handlers",
      ["test/recon/TargetFunctions.sol"],
      ["test/recon/Properties.sol"]
    );

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(coverage, coverage.workspacePath);

    assert.equal(
      fs.readFileSync(path.join(coverage.workspacePath, "test/recon/TargetFunctions.sol"), "utf8"),
      "contract TargetFunctions { /* v2 */ }\n"
    );
    assert.equal(
      fs.existsSync(path.join(coverage.workspacePath, "test/recon/Properties.sol")),
      false,
      "the stale ancestor Properties.sol must not be resurrected into the downstream workspace"
    );
    const selected = state.dependencySnapshots.get("coverage");
    assert.ok(selected);
    assert.equal(selected.has("test/recon/Properties.sol"), false);
    assert.equal(setup.attemptId, "setup");
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#217 a declared predecessor that still carries a tombstoned path outranks the tombstone", () => {
  const { runRoot, setup, handlers, coverage, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(
      setup.artifactDir,
      "stateful-invariant-setup",
      "setup",
      ["test/recon/TargetFunctions.sol"],
      ["test/recon/Properties.sol"]
    );

    // handlers is coverage's DIRECT dependency and it both re-added
    // Properties.sol and still carries the inherited tombstone for it. Only a
    // direct predecessor reaches the "still present" subtraction, so this is
    // the shape that pins the rule.
    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteSource(handlers.artifactDir, "test/recon/Properties.sol", "contract Properties { /* re-added */ }\n");
    writeSuiteManifest(
      handlers.artifactDir,
      "stateful-invariant-handlers",
      "handlers",
      ["test/recon/Properties.sol", "test/recon/TargetFunctions.sol"],
      ["test/recon/Properties.sol"]
    );

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(coverage, coverage.workspacePath);

    assert.equal(
      fs.readFileSync(path.join(coverage.workspacePath, "test/recon/Properties.sol"), "utf8"),
      "contract Properties { /* re-added */ }\n",
      "a path a declared predecessor still publishes must not be suppressed by its own inherited tombstone"
    );
    assert.equal(setup.attemptId, "setup");
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#217 a path this stage deletes and re-creates in the same attempt is not published as a tombstone", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/Properties.sol"]);

    // The agent removed Properties.sol and then wrote it again in the same
    // attempt, so the deletion is recorded but the file is published.
    const authored = path.join(handlers.workspacePath, "test/recon/Properties.sol");
    fs.mkdirSync(path.dirname(authored), { recursive: true });
    fs.writeFileSync(authored, "contract Properties { /* rewritten */ }\n", "utf8");
    state.changedTestTreePaths = ["test/recon/Properties.sol"];
    state.tombstones.set(fs.realpathSync(handlers.workspacePath), new Set(["test/recon/Properties.sol"]));
    state.dependencySnapshots.set("handlers", new Map<string, SuiteEntry>());

    const helpers = loadWorkflowHelpers([...COMPANION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteCompanions);
    helpers.materializeInvariantSuiteCompanions(handlers);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"), "utf8")
    ) as { files: Array<{ path: string }>; tombstones?: string[] };
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["test/recon/Properties.sol"]
    );
    assert.deepEqual(
      manifest.tombstones,
      [],
      "a path this stage still publishes must clear its own tombstone, or descendants suppress a live source"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#217 the published invariant-suite manifest carries deletion tombstones", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* stale */ }\n");
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(
      setup.artifactDir,
      "stateful-invariant-setup",
      "setup",
      ["test/recon/Properties.sol", "test/recon/TargetFunctions.sol"],
      ["src/Legacy.sol"]
    );

    // The handlers stage rewrote TargetFunctions.sol and deleted Properties.sol.
    const authored = path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol");
    fs.mkdirSync(path.dirname(authored), { recursive: true });
    fs.writeFileSync(authored, "contract TargetFunctions { /* v2 */ }\n", "utf8");
    state.changedTestTreePaths = ["test/recon/TargetFunctions.sol"];
    state.tombstones.set(fs.realpathSync(handlers.workspacePath), new Set(["test/recon/Properties.sol"]));
    state.dependencySnapshots.set(
      "handlers",
      new Map<string, SuiteEntry>([
        [
          "test/recon/Properties.sol",
          {
            dependency: setup.artifactDir,
            bytes: Buffer.from("contract Properties { /* stale */ }\n"),
            direct: true
          }
        ],
        [
          "test/recon/TargetFunctions.sol",
          {
            dependency: setup.artifactDir,
            bytes: Buffer.from("contract TargetFunctions { /* v1 */ }\n"),
            direct: true
          }
        ]
      ])
    );

    const helpers = loadWorkflowHelpers([...COMPANION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteCompanions);
    helpers.materializeInvariantSuiteCompanions(handlers);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"), "utf8")
    ) as { files: Array<{ path: string }>; tombstones?: string[] };
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["test/recon/TargetFunctions.sol"]
    );
    assert.deepEqual(
      manifest.tombstones,
      ["src/Legacy.sol", "test/recon/Properties.sol"],
      "the manifest must carry this stage's deletions plus the deletions it inherited"
    );
    assert.equal(fs.existsSync(path.join(handlers.artifactDir, "invariant-suite", "test/recon/Properties.sol")), false);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 publication verification recovers from the durable manifest after a restart", () => {
  const { runRoot, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteManifest(handlers.artifactDir, "stateful-invariant-handlers", "handlers", [
      "test/recon/TargetFunctions.sol"
    ]);

    const helpers = loadWorkflowHelpers([...PUBLICATION_HELPERS], state);
    assert.ok(helpers.rememberInvariantSuitePublications);

    // A restart between the agent task and its retries:0 verifier node leaves
    // the in-process publication snapshot empty.
    assert.equal(state.publicationSnapshots.size, 0);
    const publications = new Map<string, Buffer>();
    helpers.rememberInvariantSuitePublications(handlers, publications, [fs.realpathSync(handlers.artifactDir)]);

    assert.equal(publications.has("invariant-suite-manifest.json"), true);
    assert.equal(
      publications.get("invariant-suite/test/recon/TargetFunctions.sol")?.toString("utf8"),
      "contract TargetFunctions { /* v2 */ }\n"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 restart recovery still fails closed on tampered or unavailable suite artifacts", () => {
  const { runRoot, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteManifest(handlers.artifactDir, "stateful-invariant-handlers", "handlers", [
      "test/recon/TargetFunctions.sol"
    ]);

    const helpers = loadWorkflowHelpers([...PUBLICATION_HELPERS], state);
    const rememberInvariantSuitePublications = helpers.rememberInvariantSuitePublications;
    assert.ok(rememberInvariantSuitePublications);
    const artifactRoots = [fs.realpathSync(handlers.artifactDir)];

    fs.writeFileSync(
      path.join(handlers.artifactDir, "invariant-suite", "test/recon/TargetFunctions.sol"),
      "contract Tampered {}\n",
      "utf8"
    );
    assert.throws(
      () => rememberInvariantSuitePublications(handlers, new Map<string, Buffer>(), artifactRoots),
      /invariant suite artifact changed test\/recon\/TargetFunctions\.sol/u
    );

    // A missing manifest must name the durable record that is unavailable
    // rather than an in-process bookkeeping map.
    fs.rmSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"));
    state.publicationSnapshots.clear();
    assert.throws(
      () => rememberInvariantSuitePublications(handlers, new Map<string, Buffer>(), artifactRoots),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invariant-suite-manifest\.json/u);
        assert.doesNotMatch(error.message, /publication snapshot is unavailable/u);
        return true;
      }
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 post-restart preparation keeps the recorded handoff instead of reverting authored sources", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);

    helpers.materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);
    const authored = path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol");
    assert.equal(fs.readFileSync(authored, "utf8"), "contract TargetFunctions { /* v1 */ }\n");

    // The agent authors the stage harness, then the controller restarts and the
    // post-agent preparation pass runs with empty in-process state.
    fs.writeFileSync(authored, "contract TargetFunctions { /* authored */ }\n", "utf8");
    state.dependencySnapshots.clear();
    state.tombstones.clear();

    helpers.materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);
    assert.equal(
      fs.readFileSync(authored, "utf8"),
      "contract TargetFunctions { /* authored */ }\n",
      "the post-restart pass must not revert the harness this stage already authored"
    );
    assert.equal(state.dependencySnapshots.get("handlers")?.size, 1);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 the durable handoff record fails closed when a recorded dependency no longer matches", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    const materializeInvariantSuiteFromDependencies = helpers.materializeInvariantSuiteFromDependencies;
    assert.ok(materializeInvariantSuiteFromDependencies);
    materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);

    const recordPath = path.join(runRoot, "invariant-suite-handoffs", "handlers", "handoff.json");
    assert.equal(fs.existsSync(recordPath), true, "the dependency handoff must be recorded under durable run state");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      schema_version: string;
      producer_attempt_id: string;
      dependencies: Array<{ path: string; attempt_id: string; size: number; sha256: string; direct: boolean }>;
      tombstones: string[];
    };
    assert.equal(record.schema_version, "ultrafuzz.invariant-suite-handoff.v1");
    assert.equal(record.producer_attempt_id, "handlers");
    assert.deepEqual(
      record.dependencies.map((entry) => [entry.path, entry.attempt_id, entry.direct]),
      [["test/recon/TargetFunctions.sol", "setup", true]]
    );

    state.dependencySnapshots.clear();
    fs.writeFileSync(
      path.join(setup.artifactDir, "invariant-suite", "test/recon/TargetFunctions.sol"),
      "contract TargetFunctions { /* swapped */ }\n",
      "utf8"
    );
    assert.throws(
      () => materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath),
      /invariant suite dependency changed test\/recon\/TargetFunctions\.sol/u
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 a legitimately republished ancestor supersedes the record instead of failing the stage closed", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    const materialize = helpers.materializeInvariantSuiteFromDependencies;
    assert.ok(materialize);
    materialize(handlers, handlers.workspacePath);

    // An operator retries the ancestor (retry-task / timetravel / a new Modal
    // execution generation republishing the directory). It publishes different
    // bytes with a fresh, internally consistent manifest.
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);
    state.dependencySnapshots.clear();

    materialize(handlers, handlers.workspacePath);
    assert.equal(
      state.dependencySnapshots.get("handlers")?.get("test/recon/TargetFunctions.sol")?.bytes.toString("utf8"),
      "contract TargetFunctions { /* v2 */ }\n",
      "a superseded handoff record must be re-derived against the ancestor's new bytes"
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(runRoot, "invariant-suite-handoffs", "handlers", "handoff.json"), "utf8")
    ) as { dependencies: Array<{ sha256: string }>; producers: Array<{ attempt_id: string }> };
    assert.deepEqual(
      record.producers.map((entry) => entry.attempt_id),
      ["setup"],
      "the record must bind itself to the ancestor manifests it was derived from"
    );
    assert.equal(
      record.dependencies[0]?.sha256,
      createHash("sha256").update("contract TargetFunctions { /* v2 */ }\n").digest("hex")
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 a worktree lost before the durable workspace snapshot exists is repopulated from the record", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    const materialize = helpers.materializeInvariantSuiteFromDependencies;
    assert.ok(materialize);
    materialize(handlers, handlers.workspacePath);

    // The process died between writing the handoff record and capturing the
    // workspace snapshot, and the worktree was reclaimed. Nothing else can
    // restore the inherited suite here.
    fs.rmSync(handlers.workspacePath, { recursive: true, force: true });
    fs.mkdirSync(handlers.workspacePath, { recursive: true });
    state.dependencySnapshots.clear();
    assert.equal(state.workspaceSnapshots.size, 0);

    materialize(handlers, handlers.workspacePath);
    assert.equal(
      fs.readFileSync(path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol"), "utf8"),
      "contract TargetFunctions { /* v1 */ }\n",
      "the recorded handoff must be re-materialized rather than silently skipped"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 the record never resurrects a source the agent deleted once the workspace snapshot is durable", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* v1 */ }\n");
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", [
      "test/recon/Properties.sol",
      "test/recon/TargetFunctions.sol"
    ]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    const materialize = helpers.materializeInvariantSuiteFromDependencies;
    assert.ok(materialize);
    materialize(handlers, handlers.workspacePath);
    // The first preparation captured its durable workspace snapshot.
    state.workspaceSnapshots.set("handlers", new Map());

    // The agent deletes one inherited source and rewrites the other, then the
    // controller restarts and the post-agent preparation pass runs.
    fs.rmSync(path.join(handlers.workspacePath, "test/recon/Properties.sol"));
    fs.writeFileSync(
      path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol"),
      "contract TargetFunctions { /* authored */ }\n",
      "utf8"
    );
    state.dependencySnapshots.clear();

    materialize(handlers, handlers.workspacePath);
    assert.equal(
      fs.existsSync(path.join(handlers.workspacePath, "test/recon/Properties.sol")),
      false,
      "reconciliation must never resurrect a source this attempt deleted"
    );
    assert.equal(
      fs.readFileSync(path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol"), "utf8"),
      "contract TargetFunctions { /* authored */ }\n",
      "reconciliation must never overwrite a source this attempt authored"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 the recovered path still fails closed on an ancestor property with no published suite source", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state, {
      validateImplementedPropertiesSchema: () => ({
        ok: true,
        value: {
          properties: [
            {
              status: "implemented",
              implementation_paths: [] as string[],
              test_paths: ["test/recon/Missing.sol"]
            }
          ]
        }
      })
    });
    const materialize = helpers.materializeInvariantSuiteFromDependencies;
    assert.ok(materialize);

    // Record a handoff while the ancestor makes no implemented-property claim.
    materialize(handlers, handlers.workspacePath);
    assert.equal(fs.existsSync(path.join(runRoot, "invariant-suite-handoffs", "handlers", "handoff.json")), true);

    // The ancestor now claims a property implemented by a source it never
    // published. The suite manifest is untouched, so the record is still
    // current and the recovered path must re-check the expectation itself.
    fs.writeFileSync(path.join(setup.artifactDir, "implemented-properties.json"), "{}\n", "utf8");
    state.dependencySnapshots.clear();
    assert.throws(
      () => materialize(handlers, handlers.workspacePath),
      /artifact handoff is missing invariant suite source test\/recon\/Missing\.sol/u
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#219 the durable record's tombstones drive the deletion channel this stage publishes", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", ["test/recon/TargetFunctions.sol"]);

    const materializationHelpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(materializationHelpers.materializeInvariantSuiteFromDependencies);
    materializationHelpers.materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);

    // Rewrite only the record's deletion channel, leaving its ancestor
    // fingerprints intact. The ancestor manifest carries no tombstone, so the
    // published deletion channel can only come from the durable record.
    const recordPath = path.join(runRoot, "invariant-suite-handoffs", "handlers", "handoff.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { tombstones: string[] };
    record.tombstones = ["src/Legacy.sol"];
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    state.dependencySnapshots.clear();
    state.tombstones.clear();

    const companionHelpers = loadWorkflowHelpers([...COMPANION_HELPERS], state);
    assert.ok(companionHelpers.materializeInvariantSuiteCompanions);
    companionHelpers.materializeInvariantSuiteCompanions(handlers);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"), "utf8")
    ) as { tombstones?: string[] };
    assert.deepEqual(
      manifest.tombstones,
      ["src/Legacy.sol"],
      "the record is the durable statement of what the handoff suppressed and must be honoured"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#217 a retry drops the previous attempt's tombstones so a restored source is not suppressed", () => {
  const { runRoot, handlers, state } = createInvariantChain();
  try {
    const workspaceRoot = fs.realpathSync(handlers.workspacePath);
    state.tombstones.set(workspaceRoot, new Set(["test/recon/Properties.sol"]));

    const helpers = loadWorkflowHelpers([...RETRY_HELPERS], state);
    assert.ok(helpers.resetTaskArtifactsForRetry);
    helpers.resetTaskArtifactsForRetry(handlers);

    assert.equal(
      state.tombstones.get(workspaceRoot),
      undefined,
      "the restored workspace snapshot puts the deleted source back, so its tombstone must not survive the retry"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#217 an emptied test-tree source is tombstoned on both discovery paths", () => {
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-discovery-"));
  try {
    const workspaceRoot = fs.realpathSync(runRoot);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: workspaceRoot, stdio: "ignore" });
    };
    git("init", "--quiet");
    git("config", "user.email", "ultrafuzz@example.com");
    git("config", "user.name", "ultrafuzz");
    const relativePath = "test/recon/Properties.sol";
    const sourcePath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    const contents = "contract Properties { /* v1 */ }\n";
    fs.writeFileSync(sourcePath, contents, "utf8");
    git("add", "--all");
    git("commit", "--quiet", "-m", "baseline");

    const state = createHarnessState([]);
    const helpers = loadWorkflowHelpers([...DISCOVERY_HELPERS], state);
    const changedTestTreePaths = helpers.changedTestTreePaths;
    assert.ok(changedTestTreePaths);

    // The agent expressed a deletion by truncating the file to zero bytes.
    fs.writeFileSync(sourcePath, "", "utf8");

    // Git-fallback discovery: no baseline is available at all.
    assert.deepEqual(changedTestTreePaths(workspaceRoot), []);
    assert.deepEqual(
      [...(state.tombstones.get(workspaceRoot) ?? new Set<string>())],
      [relativePath],
      "the Git-fallback branch must record the truncation as a deletion, not skip it"
    );

    // Baseline discovery: the protected baseline still lists the source.
    state.tombstones.clear();
    const baselinePath = path.join(runRoot, "invariant-suite-baseline.json");
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({
        schema_version: "ultrafuzz.invariant-suite-baseline.v1",
        files: [
          {
            path: relativePath,
            size: Buffer.byteLength(contents),
            sha256: createHash("sha256").update(contents).digest("hex")
          }
        ]
      })}\n`,
      "utf8"
    );
    assert.deepEqual(changedTestTreePaths(workspaceRoot, baselinePath), []);
    assert.deepEqual(
      [...(state.tombstones.get(workspaceRoot) ?? new Set<string>())],
      [relativePath],
      "the baseline branch must record the truncation as a deletion"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 a later ancestor's rewrite supersedes an earlier one instead of failing as a conflict", () => {
  // R50's exact shape. `implement-properties` depends DIRECTLY only on `coverage`, so `setup` and
  // `handlers` are both INDIRECT ancestors -- equal directness, which is the case that used to throw
  // unconditionally. The existing #217 fixtures never reach it, because `coverage` has `handlers` direct
  // and `setup` indirect.
  //
  // `handlers` depends on `setup` and rewrote Properties.sol after it. That is supersession, and reading
  // it as a conflict killed R50 at 25 succeeded / 0 failed, one node from the Recon campaign no run has
  // ever entered.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-"));
  try {
    const setup = makeTaskSpec(runRoot, "setup", "stateful-invariant-setup", [], []);
    const handlers = makeTaskSpec(runRoot, "handlers", "stateful-invariant-handlers", ["setup"], ["setup"]);
    const coverage = makeTaskSpec(
      runRoot,
      "coverage",
      "stateful-invariant-coverage",
      ["setup", "handlers"],
      ["handlers"]
    );
    const implement = makeTaskSpec(
      runRoot,
      "implement",
      "stateful-invariant-implement-properties",
      ["setup", "handlers", "coverage"],
      ["coverage"]
    );
    const state = createHarnessState([setup, handlers, coverage, implement]);

    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* setup */ }\n");
    writeSuiteSource(setup.artifactDir, "test/recon/Setup.sol", "contract Setup { /* setup */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", [
      "test/recon/Properties.sol",
      "test/recon/Setup.sol"
    ]);
    writeSuiteSource(handlers.artifactDir, "test/recon/Properties.sol", "contract Properties { /* handlers */ }\n");
    writeSuiteSource(handlers.artifactDir, "test/recon/Setup.sol", "contract Setup { /* setup */ }\n");
    writeSuiteManifest(handlers.artifactDir, "stateful-invariant-handlers", "handlers", [
      "test/recon/Properties.sol",
      "test/recon/Setup.sol"
    ]);
    // `coverage` deliberately publishes NOTHING. An earlier version had it republish handlers' bytes, and
    // because it is a DIRECT dependency it won unconditionally via the different-directness path -- so the
    // assertion below was satisfied by `coverage` rather than by the supersession rule, and inverting the
    // two `invariantSuiteAncestorSupersedes` calls passed the entire suite while selecting the stale
    // ancestor's Solidity. A test the fix cannot fail is worse than no test.

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(implement, implement.workspacePath);

    assert.equal(
      fs.readFileSync(path.join(implement.workspacePath, "test/recon/Properties.sol"), "utf8"),
      "contract Properties { /* handlers */ }\n",
      "the descendant ancestor's rewrite must win over the one it superseded"
    );
    // A SECOND path, so abandoning the per-path loop early cannot go unnoticed. Every fixture here used to
    // publish exactly one file per dependency, which let `continue` become `break` silently.
    assert.equal(
      fs.readFileSync(path.join(implement.workspacePath, "test/recon/Setup.sol"), "utf8"),
      "contract Setup { /* setup */ }\n",
      "every published path must survive, not just the first"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 two UNORDERED ancestors publishing different bytes still fail closed", () => {
  // The guard that keeps the fix honest. Siblings that neither depend on the other are a genuine
  // conflict: picking one would silently drop the other's work, which is the failure that made the first
  // revision of #314 unmergeable. Reachability, not sort position, is what separates the two cases.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-conflict-"));
  try {
    const root = makeTaskSpec(runRoot, "root", "property-specification-fanin", [], []);
    const left = makeTaskSpec(runRoot, "left", "stateful-invariant-setup", ["root"], ["root"]);
    const right = makeTaskSpec(runRoot, "right", "stateful-invariant-handlers", ["root"], ["root"]);
    const downstream = makeTaskSpec(
      runRoot,
      "downstream",
      "stateful-invariant-implement-properties",
      ["root", "left", "right"],
      ["root"]
    );
    const state = createHarnessState([root, left, right, downstream]);

    writeSuiteSource(left.artifactDir, "test/recon/Properties.sol", "contract Properties { /* left */ }\n");
    writeSuiteManifest(left.artifactDir, "stateful-invariant-setup", "left", ["test/recon/Properties.sol"]);
    writeSuiteSource(right.artifactDir, "test/recon/Properties.sol", "contract Properties { /* right */ }\n");
    writeSuiteManifest(right.artifactDir, "stateful-invariant-handlers", "right", ["test/recon/Properties.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    assert.throws(
      () => helpers.materializeInvariantSuiteFromDependencies?.(downstream, downstream.workspacePath),
      /ancestor invariant suite sources conflict for test\/recon\/Properties\.sol/u
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 unordered ancestors fail closed regardless of which one is visited first", () => {
  // Review constructed this and it SILENTLY SELECTED in one direction. `sib` and `mid` are unordered
  // siblings publishing identical bytes; `desc` depends on `mid` only and publishes different bytes.
  // Folding pairwise, only the sibling written to the selection LAST was still compared, so `sib`'s
  // unordered claim vanished when it sorted first -- no error at all -- while sorting `mid` first threw.
  // Same graph, opposite outcomes, decided by `localeCompare`. That silent arm was NEW: before the fix
  // both orderings threw.
  //
  // The two attemptId pairs sort oppositely, so both visit orders are exercised.
  for (const [sibId, midId] of [
    ["a-sib", "b-mid"],
    ["y-sib", "z-mid"]
  ] as ReadonlyArray<readonly [string, string]>) {
    const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-order-"));
    try {
      const root = makeTaskSpec(runRoot, "root", "property-specification-fanin", [], []);
      const sib = makeTaskSpec(runRoot, sibId, "stateful-invariant-setup", ["root"], ["root"]);
      const mid = makeTaskSpec(runRoot, midId, "stateful-invariant-handlers", ["root"], ["root"]);
      const desc = makeTaskSpec(runRoot, "desc", "stateful-invariant-coverage", ["root", midId], [midId]);
      const downstream = makeTaskSpec(
        runRoot,
        "downstream",
        "stateful-invariant-implement-properties",
        ["root", sibId, midId, "desc"],
        // `root` is the only DIRECT dependency, so `sib`, `mid` and `desc` all arrive indirect and the
        // long-standing direct-outranks-indirect rule cannot decide this. That rule is what resolved an
        // earlier version of this fixture, which made it pass without ever reaching the unordered case.
        ["root"]
      );
      const state = createHarnessState([root, sib, mid, desc, downstream]);

      writeSuiteSource(sib.artifactDir, "test/recon/Properties.sol", "contract Properties { /* shared */ }\n");
      writeSuiteManifest(sib.artifactDir, "stateful-invariant-setup", sibId, ["test/recon/Properties.sol"]);
      writeSuiteSource(mid.artifactDir, "test/recon/Properties.sol", "contract Properties { /* shared */ }\n");
      writeSuiteManifest(mid.artifactDir, "stateful-invariant-handlers", midId, ["test/recon/Properties.sol"]);
      writeSuiteSource(desc.artifactDir, "test/recon/Properties.sol", "contract Properties { /* desc */ }\n");
      writeSuiteManifest(desc.artifactDir, "stateful-invariant-coverage", "desc", ["test/recon/Properties.sol"]);

      const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
      assert.ok(helpers.materializeInvariantSuiteFromDependencies);
      assert.throws(
        () => helpers.materializeInvariantSuiteFromDependencies?.(downstream, downstream.workspacePath),
        /ancestor invariant suite sources conflict for test\/recon\/Properties\.sol/u,
        `${sibId} before ${midId} must fail closed, not silently select`
      );
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
  }
});

test("#315 an indirect descendant's rewrite beats a stale DIRECT ancestor", () => {
  // Reachability is consulted BEFORE directness. The old rule handed this to the direct dependency and
  // silently selected the older Solidity. It was unreachable in the shipped topology only by luck --
  // `property-specification-fanin` is a direct dependency of `stateful-invariant-coverage` and an
  // ancestor of the indirect `stateful-invariant-setup`, exactly this shape, and is harmless solely
  // because it publishes no suite sources.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-direct-"));
  try {
    const older = makeTaskSpec(runRoot, "older", "stateful-invariant-setup", [], []);
    const newer = makeTaskSpec(runRoot, "newer", "stateful-invariant-handlers", ["older"], ["older"]);
    const downstream = makeTaskSpec(
      runRoot,
      "downstream",
      "stateful-invariant-implement-properties",
      ["older", "newer"],
      ["older"]
    );
    const state = createHarnessState([older, newer, downstream]);

    writeSuiteSource(older.artifactDir, "test/recon/Properties.sol", "contract Properties { /* older */ }\n");
    writeSuiteManifest(older.artifactDir, "stateful-invariant-setup", "older", ["test/recon/Properties.sol"]);
    writeSuiteSource(newer.artifactDir, "test/recon/Properties.sol", "contract Properties { /* newer */ }\n");
    writeSuiteManifest(newer.artifactDir, "stateful-invariant-handlers", "newer", ["test/recon/Properties.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(downstream, downstream.workspacePath);
    assert.equal(
      fs.readFileSync(path.join(downstream.workspacePath, "test/recon/Properties.sol"), "utf8"),
      "contract Properties { /* newer */ }\n",
      "a stale direct ancestor must not outrank the descendant that rewrote it"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 a DIRECT publisher still outranks an unordered indirect one", () => {
  // Long-standing behaviour that reachability must not quietly replace. These two publishers are
  // unordered with respect to each other, so the graph cannot decide; the direct dependency wins, exactly
  // as before this change. Without this test, deleting the directness preference passes the whole suite --
  // and it would turn a case that selects today into a thrown conflict.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-directness-"));
  try {
    const root = makeTaskSpec(runRoot, "root", "property-specification-fanin", [], []);
    const indirect = makeTaskSpec(runRoot, "indirect", "stateful-invariant-setup", ["root"], ["root"]);
    const direct = makeTaskSpec(runRoot, "direct", "stateful-invariant-handlers", ["root"], ["root"]);
    const downstream = makeTaskSpec(
      runRoot,
      "downstream",
      "stateful-invariant-implement-properties",
      ["root", "indirect", "direct"],
      ["direct"]
    );
    const state = createHarnessState([root, indirect, direct, downstream]);

    writeSuiteSource(indirect.artifactDir, "test/recon/Properties.sol", "contract Properties { /* indirect */ }\n");
    writeSuiteManifest(indirect.artifactDir, "stateful-invariant-setup", "indirect", ["test/recon/Properties.sol"]);
    writeSuiteSource(direct.artifactDir, "test/recon/Properties.sol", "contract Properties { /* direct */ }\n");
    writeSuiteManifest(direct.artifactDir, "stateful-invariant-handlers", "direct", ["test/recon/Properties.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(downstream, downstream.workspacePath);
    assert.equal(
      fs.readFileSync(path.join(downstream.workspacePath, "test/recon/Properties.sol"), "utf8"),
      "contract Properties { /* direct */ }\n",
      "a direct dependency must still outrank an unordered indirect one"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 a cyclic dependency graph fails closed instead of silently dropping the path", () => {
  // If every publisher is superseded by another -- which only a CYCLE can produce -- the unsuperseded set
  // is empty. Falling through on an empty set would drop the file from the harness with no error at all,
  // which is precisely the class of failure this change exists to remove, so the conflict check gets the
  // whole set instead. The topology validator rejects cycles, so this should be unreachable; "unreachable"
  // is a property of today's validator, not of this function.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-cycle-"));
  try {
    const left = makeTaskSpec(runRoot, "left", "stateful-invariant-setup", ["right"], ["right"]);
    const right = makeTaskSpec(runRoot, "right", "stateful-invariant-handlers", ["left"], ["left"]);
    const downstream = makeTaskSpec(
      runRoot,
      "downstream",
      "stateful-invariant-implement-properties",
      ["left", "right"],
      []
    );
    const state = createHarnessState([left, right, downstream]);

    writeSuiteSource(left.artifactDir, "test/recon/Properties.sol", "contract Properties { /* left */ }\n");
    writeSuiteManifest(left.artifactDir, "stateful-invariant-setup", "left", ["test/recon/Properties.sol"]);
    writeSuiteSource(right.artifactDir, "test/recon/Properties.sol", "contract Properties { /* right */ }\n");
    writeSuiteManifest(right.artifactDir, "stateful-invariant-handlers", "right", ["test/recon/Properties.sol"]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    assert.throws(
      () => helpers.materializeInvariantSuiteFromDependencies?.(downstream, downstream.workspacePath),
      /ancestor invariant suite sources conflict for test\/recon\/Properties\.sol/u,
      "a cycle must surface as a conflict, never as a missing file"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#315 a direct publisher does not mask a conflict between two unordered indirect ones", () => {
  // Review's PROBE C, run against three revisions: `main` throws, the first restructure threw, and the
  // second SELECTED silently. Filtering to the direct publisher before checking for disagreement discards
  // both indirect claims with no error -- a strict loss of fail-closed behaviour in exactly the class this
  // change is about, and invisible to every other fixture because they have at most two publishers.
  //
  // Not reachable in the shipped topology, which is a pure chain; that is why it is latent rather than
  // live, and why it is worth a test rather than a comment.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-315-mask-"));
  try {
    const root = makeTaskSpec(runRoot, "root", "property-specification-fanin", [], []);
    const i1 = makeTaskSpec(runRoot, "i1", "stateful-invariant-setup", ["root"], ["root"]);
    const i2 = makeTaskSpec(runRoot, "i2", "stateful-invariant-handlers", ["root"], ["root"]);
    const zd = makeTaskSpec(runRoot, "zd", "stateful-invariant-coverage", ["root"], ["root"]);
    const downstream = makeTaskSpec(
      runRoot,
      "downstream",
      "stateful-invariant-implement-properties",
      ["root", "i1", "i2", "zd"],
      ["zd"]
    );
    const state = createHarnessState([root, i1, i2, zd, downstream]);

    for (const [spec, node, marker] of [
      [i1, "stateful-invariant-setup", "I1"],
      [i2, "stateful-invariant-handlers", "I2"],
      [zd, "stateful-invariant-coverage", "D"]
    ] as ReadonlyArray<readonly [typeof i1, string, string]>) {
      writeSuiteSource(spec.artifactDir, "test/recon/Properties.sol", `contract Properties { /* ${marker} */ }\n`);
      writeSuiteManifest(spec.artifactDir, node, spec.attemptId, ["test/recon/Properties.sol"]);
    }

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    assert.throws(
      () => helpers.materializeInvariantSuiteFromDependencies?.(downstream, downstream.workspacePath),
      /ancestor invariant suite sources conflict for test\/recon\/Properties\.sol/u,
      "two unordered indirect publishers disagreeing must not be masked by an unrelated direct one"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#218 a suite tree nested past the depth bound is rejected on the way down", () => {
  const { runRoot, setup, state } = createInvariantChain();
  try {
    // 40 nested directories under test/, which is past MAX_INVARIANT_SUITE_SOURCE_DEPTH.
    const nested = ["test", ...Array.from({ length: 40 }, (_unused, index) => `d${index}`)].join("/");
    writeSuiteSource(setup.artifactDir, `${nested}/Properties.sol`, "contract Properties {}\n");

    const helpers = loadWorkflowHelpers(["listInvariantSuiteSources"], state);
    const listInvariantSuiteSources = helpers.listInvariantSuiteSources;
    assert.ok(listInvariantSuiteSources);
    assert.throws(
      () => listInvariantSuiteSources(path.join(setup.artifactDir, "invariant-suite")),
      /invariant-suite tree is too deep/u,
      "an unbounded recursion walks and stats an adversarial tree before any limit applies"
    );

    // A suite of ordinary depth still lists normally.
    const { runRoot: shallowRoot, setup: shallow, state: shallowState } = createInvariantChain();
    try {
      writeSuiteSource(shallow.artifactDir, "test/recon/Properties.sol", "contract Properties {}\n");
      const shallowHelpers = loadWorkflowHelpers(["listInvariantSuiteSources"], shallowState);
      assert.deepEqual(shallowHelpers.listInvariantSuiteSources?.(path.join(shallow.artifactDir, "invariant-suite")), [
        "test/recon/Properties.sol"
      ]);
    } finally {
      fs.rmSync(shallowRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#218 the source budget is spent across the whole ancestor union, not reset per ancestor", () => {
  const { runRoot, setup, handlers, coverage, state } = createInvariantChain();
  try {
    // Two ancestors publishing two sources each. The handoff reads a buffer per
    // (ancestor, path) pair, so a per-ancestor allowance bounds nothing.
    for (const [spec, node] of [
      [setup, "stateful-invariant-setup"],
      [handlers, "stateful-invariant-handlers"]
    ] as ReadonlyArray<readonly [TaskSpecLike, string]>) {
      writeSuiteSource(spec.artifactDir, "test/recon/Properties.sol", "contract Properties {}\n");
      writeSuiteSource(spec.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions {}\n");
      writeSuiteManifest(spec.artifactDir, node, spec.attemptId, [
        "test/recon/Properties.sol",
        "test/recon/TargetFunctions.sol"
      ]);
    }

    const helpers = loadWorkflowHelpers(
      [...MATERIALIZATION_HELPERS, "listInvariantSuiteSources", "assertInvariantSuiteSourceBudget"],
      state,
      { MAX_INVARIANT_SUITE_FILES: 3 }
    );
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    assert.throws(
      () => helpers.materializeInvariantSuiteFromDependencies?.(coverage, coverage.workspacePath),
      /invariant suite has too many source files \(4\)/u,
      "two ancestors of two sources each must be charged to one budget, not to two fresh ones"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#213 the protected baseline outranks a sidecar the agent rewrote", () => {
  // `invariant-suite-baseline.json` lives in the artifact directory the agent
  // gets as a writable addDir. Editing an entry's digest to match its own edit
  // makes a generated harness source hash as unchanged, and the change detector
  // then omits it from the durable suite. The protected copy under run state is
  // never mounted into the agent, so it is the only thing that can contradict
  // the sidecar once a restart has emptied the in-process digest map.
  const { runRoot, setup, state } = createInvariantChain();
  try {
    const workspaceRoot = fs.realpathSync(setup.workspacePath);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: workspaceRoot, stdio: "ignore" });
    };
    git("init", "--quiet");
    git("config", "user.email", "ultrafuzz@example.com");
    git("config", "user.name", "ultrafuzz");
    const relativePath = "test/recon/TargetFunctions.sol";
    const sourcePath = path.join(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "contract TargetFunctions { /* pinned */ }\n", "utf8");
    git("add", "--all");
    git("commit", "--quiet", "-m", "pinned");

    const helpers = loadWorkflowHelpers([...DISCOVERY_HELPERS], state);
    const captureInvariantSuiteBaseline = helpers.captureInvariantSuiteBaseline;
    const changedTestTreePaths = helpers.changedTestTreePaths;
    const invariantSuiteProtectedBaselinePath = helpers.invariantSuiteProtectedBaselinePath;
    assert.ok(captureInvariantSuiteBaseline);
    assert.ok(changedTestTreePaths);
    assert.ok(invariantSuiteProtectedBaselinePath);

    captureInvariantSuiteBaseline(setup, workspaceRoot);
    const sidecarPath = path.join(setup.artifactDir, "invariant-suite-baseline.json");
    const protectedPath = path.join(runRoot, "invariant-suite-baselines", `${setup.attemptId}.json`);
    assert.equal(
      invariantSuiteProtectedBaselinePath(setup),
      protectedPath,
      "the protected baseline must live under durable run state, outside every agent-writable artifact root"
    );
    const captured = fs.readFileSync(protectedPath, "utf8");
    assert.equal(fs.readFileSync(sidecarPath, "utf8"), captured);

    // The agent rewrites the harness source and edits the sidecar so its own
    // edit hashes as unchanged.
    fs.writeFileSync(sourcePath, "contract TargetFunctions { /* generated */ }\n", "utf8");
    const authoredBytes = fs.readFileSync(sourcePath);
    const forged = JSON.parse(captured) as { files: Array<{ path: string; sha256: string; size: number }> };
    forged.files = forged.files.map((entry) =>
      entry.path === relativePath
        ? { ...entry, size: authoredBytes.length, sha256: createHash("sha256").update(authoredBytes).digest("hex") }
        : entry
    );
    fs.writeFileSync(sidecarPath, `${JSON.stringify(forged, null, 2)}\n`, "utf8");

    // Durable resume: the workflow process restarted, so the in-memory digests
    // that would otherwise catch the edit are gone.
    state.baselineSnapshots.clear();
    state.protectedBaselineSnapshots.clear();

    captureInvariantSuiteBaseline(setup, workspaceRoot);
    assert.equal(
      fs.readFileSync(sidecarPath, "utf8"),
      captured,
      "the post-agent pass must restore the sidecar from the protected copy instead of trusting the agent's"
    );
    assert.deepEqual(
      changedTestTreePaths(workspaceRoot, sidecarPath, protectedPath),
      [relativePath],
      "the source the agent rewrote must still be detected as changed and reach the durable suite"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#218 the publication budget covers the inherited union and rejects before anything is written", () => {
  const { runRoot, setup, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(setup.artifactDir, "test/recon/Properties.sol", "contract Properties { /* v1 */ }\n");
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", [
      "test/recon/Properties.sol",
      "test/recon/TargetFunctions.sol"
    ]);

    const materialization = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(materialization.materializeInvariantSuiteFromDependencies);
    materialization.materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);

    // The stage adds a single source of its own on top of the two it inherited.
    const authored = path.join(handlers.workspacePath, "test/recon/Handlers.sol");
    fs.mkdirSync(path.dirname(authored), { recursive: true });
    fs.writeFileSync(authored, "contract Handlers {}\n", "utf8");
    state.changedTestTreePaths = ["test/recon/Handlers.sol"];

    const companions = loadWorkflowHelpers([...COMPANION_HELPERS, "assertInvariantSuiteSourceBudget"], state, {
      MAX_INVARIANT_SUITE_FILES: 2
    });
    assert.ok(companions.materializeInvariantSuiteCompanions);
    assert.throws(
      () => companions.materializeInvariantSuiteCompanions?.(handlers),
      /invariant suite has too many source files \(3\)/u,
      "budgeting only this stage's own paths lets the assembled publication run to twice the limit"
    );
    assert.equal(
      fs.existsSync(path.join(handlers.artifactDir, "invariant-suite")),
      false,
      "the budget must reject before the assembled suite is copied into the artifact roots"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#215 a changed src/ helper reaches the manifest and survives one hop downstream", () => {
  // Invariant setup routinely edits an interface or a mock under src/ so the
  // harness compiles. Capturing only the test tree drops it, and the downstream
  // campaign worktree then builds the pinned repository without it.
  const { runRoot, handlers, coverage, state } = createInvariantChain();
  try {
    const helperSource = "library HarnessHelper { /* invariant mock */ }\n";
    const helperPath = path.join(handlers.workspacePath, "src/HarnessHelper.sol");
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, helperSource, "utf8");
    const targetPath = path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "contract TargetFunctions { /* v1 */ }\n", "utf8");
    state.changedTestTreePaths = ["test/recon/TargetFunctions.sol"];
    state.changedInvariantSourcePaths = ["src/HarnessHelper.sol"];
    state.dependencySnapshots.set("handlers", new Map<string, SuiteEntry>());

    const companionHelpers = loadWorkflowHelpers([...COMPANION_HELPERS], state);
    assert.ok(companionHelpers.materializeInvariantSuiteCompanions);
    companionHelpers.materializeInvariantSuiteCompanions(handlers);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"), "utf8")
    ) as { files: Array<{ path: string }> };
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["src/HarnessHelper.sol", "test/recon/TargetFunctions.sol"],
      "an invariant source edited outside the test tree must be published alongside the harness it supports"
    );
    assert.equal(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite", "src/HarnessHelper.sol"), "utf8"),
      helperSource
    );

    state.dependencySnapshots.clear();
    const materializationHelpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(materializationHelpers.materializeInvariantSuiteFromDependencies);
    materializationHelpers.materializeInvariantSuiteFromDependencies(coverage, coverage.workspacePath);
    assert.equal(
      fs.readFileSync(path.join(coverage.workspacePath, "src/HarnessHelper.sol"), "utf8"),
      helperSource,
      "the next stage's worktree must receive the exact src/ source the previous stage used"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#212 retry cleanup resets generated tests under the repository's plural tests/ root", () => {
  // Aave v4 at the benchmark commit has no test/ at all: `git ls-files test`
  // is empty and the Foundry root is tests/. A retry that resets test/foundry/
  // leaves the previous attempt's generated sources in place under tests/, and
  // the stage republishes them as if this attempt had authored them.
  const { runRoot, handlers, state } = createInvariantChain();
  try {
    const workspaceRoot = fs.realpathSync(handlers.workspacePath);
    fs.mkdirSync(path.join(workspaceRoot, "tests", "recon"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, "tests", "recon", "CryticTester.sol"),
      "contract CryticTester { /* recon */ }\n",
      "utf8"
    );
    handlers.outputs = [{ path: "generated-tests/CryticTester.sol", contract: "ultrafuzz/generated-tests@1" }];

    const resetGeneratedTestRoots: string[] = [];
    const helpers = loadWorkflowHelpers([...RETRY_HELPERS], state, {
      resetTaskArtifactContents: (rootPath: string, _attemptId: string, label: string) => {
        if (label === "generated-test") resetGeneratedTestRoots.push(rootPath);
      }
    });
    assert.ok(helpers.resetTaskArtifactsForRetry);
    helpers.resetTaskArtifactsForRetry(handlers);

    assert.deepEqual(
      resetGeneratedTestRoots,
      [path.join(workspaceRoot, "tests", "foundry", "stateful-invariant-handlers")],
      "retry cleanup must follow the repository's own Foundry test root, not a hardcoded test/"
    );
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, "test")),
      false,
      "a repository that uses tests/ must not have a singular test/ root invented for it"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#211 an inherited-only suite source survives a stage that never touches it", () => {
  // `downstream` sees ONLY handlers' artifact directory, so Setup.sol reaches
  // it exclusively through handlers republishing what it inherited. Every other
  // fixture here tombstones the ancestor file, which proves the suppression
  // path and says nothing about the retention path.
  const runRoot = fs.mkdtempSync(path.join(process.cwd(), "ultrafuzz-invariant-211-"));
  try {
    const setup = makeTaskSpec(runRoot, "setup", "stateful-invariant-setup", [], []);
    const handlers = makeTaskSpec(runRoot, "handlers", "stateful-invariant-handlers", ["setup"], ["setup"]);
    const downstream = makeTaskSpec(runRoot, "downstream", "stateful-invariant-coverage", ["handlers"], ["handlers"]);
    const state = createHarnessState([setup, handlers, downstream]);

    const inherited = "contract Setup { /* inherited */ }\n";
    writeSuiteSource(setup.artifactDir, "test/recon/Setup.sol", inherited);
    writeSuiteSource(setup.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v1 */ }\n");
    writeSuiteManifest(setup.artifactDir, "stateful-invariant-setup", "setup", [
      "test/recon/Setup.sol",
      "test/recon/TargetFunctions.sol"
    ]);

    const materializationHelpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(materializationHelpers.materializeInvariantSuiteFromDependencies);
    materializationHelpers.materializeInvariantSuiteFromDependencies(handlers, handlers.workspacePath);

    // handlers rewrites TargetFunctions.sol only. Nothing in its own provenance
    // names Setup.sol.
    fs.writeFileSync(
      path.join(handlers.workspacePath, "test/recon/TargetFunctions.sol"),
      "contract TargetFunctions { /* v2 */ }\n",
      "utf8"
    );
    state.changedTestTreePaths = ["test/recon/TargetFunctions.sol"];

    const companionHelpers = loadWorkflowHelpers([...COMPANION_HELPERS], state);
    assert.ok(companionHelpers.materializeInvariantSuiteCompanions);
    companionHelpers.materializeInvariantSuiteCompanions(handlers);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite-manifest.json"), "utf8")
    ) as { files: Array<{ path: string }> };
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["test/recon/Setup.sol", "test/recon/TargetFunctions.sol"],
      "this stage's artifact must carry the union of what it inherited and what it authored"
    );
    assert.equal(
      fs.readFileSync(path.join(handlers.artifactDir, "invariant-suite", "test/recon/Setup.sol"), "utf8"),
      inherited,
      "the inherited source must be republished as bytes, not merely listed in the manifest"
    );

    state.dependencySnapshots.clear();
    materializationHelpers.materializeInvariantSuiteFromDependencies(downstream, downstream.workspacePath);
    assert.equal(
      fs.readFileSync(path.join(downstream.workspacePath, "test/recon/Setup.sol"), "utf8"),
      inherited,
      "a stage that only sees its direct predecessor must still receive the ancestor's Setup.sol"
    );
    assert.equal(
      fs.readFileSync(path.join(downstream.workspacePath, "test/recon/TargetFunctions.sol"), "utf8"),
      "contract TargetFunctions { /* v2 */ }\n"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

test("#211 invariant suite provenance is restricted to supported source roots", () => {
  const state = createHarnessState([]);
  const helpers = loadWorkflowHelpers([...PROVENANCE_HELPERS], state);
  const assertSafeInvariantSuitePath = helpers.assertSafeInvariantSuitePath;
  const assertSafeInvariantSuiteTestPath = helpers.assertSafeInvariantSuiteTestPath;
  const assertInvariantSuiteSourceBudget = helpers.assertInvariantSuiteSourceBudget;
  assert.ok(assertSafeInvariantSuitePath);
  assert.ok(assertSafeInvariantSuiteTestPath);
  assert.ok(assertInvariantSuiteSourceBudget);

  for (const accepted of [
    "src/HarnessHelper.sol",
    "contracts/interfaces/IPool.sol",
    "test/recon/Properties.sol",
    "tests/recon/Properties.sol"
  ]) {
    assert.equal(assertSafeInvariantSuitePath(accepted), accepted, `${accepted} is a supported source root`);
  }

  // A malformed or malicious implementation record naming internal state or a
  // secret must never copy it into the published suite.
  for (const rejected of [
    "artifacts/workspace-state.json",
    ".envrc",
    ".git/config",
    "src/../.envrc",
    "src/.ultrafuzz/state.json",
    "node_modules/pkg/index.js",
    "src/.env.local",
    "/etc/passwd",
    ""
  ]) {
    assert.throws(
      () => assertSafeInvariantSuitePath(rejected),
      /artifact-contract failure: (unsafe invariant suite source path|unsupported invariant suite source root)/u,
      `${rejected || "<empty>"} must be rejected`
    );
  }

  assert.equal(assertSafeInvariantSuiteTestPath("tests/recon/Properties.sol"), "tests/recon/Properties.sol");
  assert.throws(
    () => assertSafeInvariantSuiteTestPath("src/HarnessHelper.sol"),
    /invariant suite test path must be under test\/ or tests\//u,
    "test provenance must stay inside a Foundry test root even though src/ is a supported source root"
  );

  assert.doesNotThrow(() => assertInvariantSuiteSourceBudget(512, 64 * 1024 * 1024));
  assert.throws(
    () => assertInvariantSuiteSourceBudget(513, 0),
    /invariant suite has too many source files \(513\)/u,
    "the file-count budget must be enforced, not assumed"
  );
  assert.throws(
    () => assertInvariantSuiteSourceBudget(1, 64 * 1024 * 1024 + 1),
    /invariant suite exceeds the source byte budget/u
  );
});

test("#214 an unreferenced file under invariant-suite/ fails the publication closed", () => {
  // The suite root is inside an agent-writable artifact directory. Anything the
  // agent drops there used to be walked and published with no provenance record
  // tying it to a property or a source change.
  const { runRoot, handlers, state } = createInvariantChain();
  try {
    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteManifest(handlers.artifactDir, "stateful-invariant-handlers", "handlers", [
      "test/recon/TargetFunctions.sol"
    ]);

    const helpers = loadWorkflowHelpers([...PUBLICATION_HELPERS], state);
    const rememberInvariantSuitePublications = helpers.rememberInvariantSuitePublications;
    assert.ok(rememberInvariantSuitePublications);
    const artifactRoots = [fs.realpathSync(handlers.artifactDir)];

    const extraPath = path.join(handlers.artifactDir, "invariant-suite", "test/recon/Sneaky.sol");
    writeSuiteSource(handlers.artifactDir, "test/recon/Sneaky.sol", "contract Sneaky { /* unreferenced */ }\n");
    const publications = new Map<string, Buffer>();
    assert.throws(
      () => rememberInvariantSuitePublications(handlers, publications, artifactRoots),
      /artifact-contract failure: unexpected invariant suite artifact test\/recon\/Sneaky\.sol/u,
      "a suite file no validated provenance record selected must not be published"
    );
    assert.equal(
      publications.has("invariant-suite/test/recon/Sneaky.sol"),
      false,
      "the rejected extra must never be remembered as a publication"
    );
    fs.rmSync(extraPath);

    // An extra outside the supported source roots is rejected while the suite
    // is enumerated, before any comparison against the manifest happens.
    writeSuiteSource(handlers.artifactDir, "artifacts/workspace-state.json", "{}\n");
    assert.throws(
      () => rememberInvariantSuitePublications(handlers, new Map<string, Buffer>(), artifactRoots),
      /artifact-contract failure: unsupported invariant suite source root artifacts\/workspace-state\.json/u,
      "internal state smuggled into the suite root must fail closed rather than be published"
    );
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});
