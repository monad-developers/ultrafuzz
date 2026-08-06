import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeFileDurable } from "@ultrafuzz/artifacts";
import ts from "typescript";

/**
 * Regression coverage for #217 (invariant-suite deletions must survive the
 * ancestor handoff) and #219 (the handoff provenance must be rebuildable from
 * durable run state rather than a module-level Map).
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
};

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
function loadWorkflowHelpers(names: readonly string[], state: HarnessState): WorkflowHelpers {
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
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
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
    taskSpecs: state.taskSpecs,
    INVARIANT_SUITE_MANIFEST_FILE: "invariant-suite-manifest.json",
    INVARIANT_SUITE_BASELINE_FILE: "invariant-suite-baseline.json",
    INVARIANT_SUITE_HANDOFF_FILE: "handoff.json",
    INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION: "ultrafuzz.invariant-suite-handoff.v1",
    MAX_INVARIANT_SUITE_FILES: 512,
    MAX_INVARIANT_SUITE_SOURCE_BYTES: 16 * 1024 * 1024,
    MAX_INVARIANT_SUITE_TOTAL_BYTES: 64 * 1024 * 1024,
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
    }
  };

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
    taskSpecs,
    changedTestTreePaths: [],
    changedInvariantSourcePaths: []
  };
}

const MATERIALIZATION_HELPERS = [
  "assertInvariantSuiteTombstoneBudget",
  "parseInvariantSuiteManifestRecord",
  "readInvariantSuiteManifestRecord",
  "invariantSuiteProducerTask",
  "inheritedInvariantSuiteTombstones",
  "writeInvariantSuiteDependencyHandoff",
  "loadInvariantSuiteDependencyHandoff",
  "resolveInvariantSuiteDependencySnapshot",
  "materializeInvariantSuiteFromDependencies"
] as const;

const PUBLICATION_HELPERS = [
  "assertInvariantSuiteTombstoneBudget",
  "parseInvariantSuiteManifestRecord",
  "readInvariantSuiteManifestRecord",
  "rememberVerifiedPublication",
  "recoverInvariantSuitePublicationSnapshot",
  "rememberInvariantSuitePublications"
] as const;

const COMPANION_HELPERS = [
  "assertInvariantSuiteTombstoneBudget",
  "parseInvariantSuiteManifestRecord",
  "readInvariantSuiteManifestRecord",
  "invariantSuiteProducerTask",
  "inheritedInvariantSuiteTombstones",
  "writeInvariantSuiteDependencyHandoff",
  "loadInvariantSuiteDependencyHandoff",
  "resolveInvariantSuiteDependencySnapshot",
  "resetInvariantSuiteArtifactRoot",
  "copyDependencyInvariantSuiteToArtifact",
  "materializeInvariantSuiteCompanions"
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

test("#217 a source an ancestor deleted and a later stage re-added stays alive", () => {
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

    writeSuiteSource(handlers.artifactDir, "test/recon/TargetFunctions.sol", "contract TargetFunctions { /* v2 */ }\n");
    writeSuiteSource(handlers.artifactDir, "test/recon/Properties.sol", "contract Properties { /* re-added */ }\n");
    writeSuiteManifest(handlers.artifactDir, "stateful-invariant-handlers", "handlers", [
      "test/recon/Properties.sol",
      "test/recon/TargetFunctions.sol"
    ]);

    const helpers = loadWorkflowHelpers([...MATERIALIZATION_HELPERS], state);
    assert.ok(helpers.materializeInvariantSuiteFromDependencies);
    helpers.materializeInvariantSuiteFromDependencies(coverage, coverage.workspacePath);

    assert.equal(
      fs.readFileSync(path.join(coverage.workspacePath, "test/recon/Properties.sol"), "utf8"),
      "contract Properties { /* re-added */ }\n"
    );
    assert.equal(setup.attemptId, "setup");
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
