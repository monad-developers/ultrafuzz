import path from "node:path";

import { z } from "zod/v4";

/**
 * The versioned controller-to-worker handoff for exactly one already-materialized concrete attempt.
 *
 * A cloud worker must never rematerialize controller-owned global state (`graph.json`,
 * `smithers/tasks.json`, expansion manifests, prompt-template snapshots), so the controller hands it
 * one explicit minimal DTO instead. That DTO is an untrusted input on both sides of the boundary:
 * the Modal provider validates it before archiving anything, and the relocated worker validates it
 * again before hydrating it into a runnable spec. This module is the single contract both sides use
 * so the two checks cannot drift.
 *
 * It lives in `@ultrafuzz/artifacts` because both `@ultrafuzz/modal` and `@ultrafuzz/runtime` already
 * depend on it and it depends on neither, so sharing the contract introduces no dependency cycle.
 */
export const CLOUD_SELECTED_TASK_SCHEMA_VERSION = "ultrafuzz.cloud-selected-task.v1";

/** Basename every runtime-rendered (dynamic or deferred) prompt is written under. */
export const CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME = "prompt.rendered.md";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
/** Identity fields may carry `:` (topology provenance) but never a path separator or wildcard. */
const HANDOFF_IDENTITY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9:._-]{0,255}$/u;
/** Handoff path segments allow a leading dot (`.ultrafuzz`, `.smithers`) but never `.` or `..`. */
const HANDOFF_SEGMENT_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/u;
const MAXIMUM_HANDOFF_PATH_LENGTH = 1024;
const MAXIMUM_HANDOFF_TEXT_LENGTH = 1024;
/** A cloud execution generation names a sandbox, a volume attempt root, and a storage lineage. */
const CLOUD_EXECUTION_GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Accepts only canonical, project-relative POSIX paths.
 *
 * Rejecting the non-canonical spellings (`a/./b`, `a//b`, `a/`) as well as traversal means a
 * validated value can be compared literally and prefix-tested for confinement without re-normalizing
 * it, which is what makes sibling-prefix escapes (`runs/run-one-evil`) detectable.
 */
export function isSafeCloudHandoffPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_HANDOFF_PATH_LENGTH) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (path.posix.normalize(value) !== value) return false;
  return value
    .split("/")
    .every((segment) => segment !== "." && segment !== ".." && HANDOFF_SEGMENT_PATTERN.test(segment));
}

/** Accepts only an already-canonical absolute path, so a controller root can be compared literally. */
export function isCanonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_HANDOFF_PATH_LENGTH) return false;
  if (value.includes("\0") || !path.isAbsolute(value)) return false;
  return path.resolve(value) === value;
}

/**
 * The controller project root every relative handoff path is stated against.
 *
 * A relocated worker rewrites this prefix to its own root throughout the rendered prompt, so the
 * filesystem root is refused outright: it would rewrite every absolute path in the prompt.
 */
export function isCloudHandoffSourceRoot(value: unknown): value is string {
  return isCanonicalAbsolutePath(value) && path.dirname(value) !== value;
}

/**
 * The bounded execution-generation identity a cloud dispatch runs under.
 *
 * Both boundaries validate the dispatched generation against this one pattern: it names the sandbox,
 * the volume attempt root, and the storage lineage, so an unbounded value would be an identity a
 * controller never issued.
 */
export function isCloudExecutionGeneration(value: unknown): value is string {
  return typeof value === "string" && CLOUD_EXECUTION_GENERATION_PATTERN.test(value);
}

/** True when `candidate` is strictly inside `root` at a path-segment boundary. */
export function isInsideCloudHandoffRoot(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}/`);
}

const handoffPath = z
  .string()
  .refine(isSafeCloudHandoffPath, { message: "must be a canonical safe project-relative POSIX path" });
const handoffSourceRoot = z
  .string()
  .refine(isCloudHandoffSourceRoot, { message: "must be a canonical absolute path below the filesystem root" });
const handoffIdentity = z
  .string()
  .refine((value) => HANDOFF_IDENTITY_PATTERN.test(value), { message: "must be a safe bounded identity" });
const handoffText = z.string().min(1).max(MAXIMUM_HANDOFF_TEXT_LENGTH);
const handoffDigest = z.string().regex(SHA256_PATTERN, "must be a lowercase sha256 digest");
const handoffPositiveInt = z.number().int().positive();
const handoffCount = z.number().int().nonnegative();
/** A git branch built from run and attempt identities; never a path and never traversal. */
const handoffBranch = z
  .string()
  .refine(
    (value) =>
      value.length <= MAXIMUM_HANDOFF_TEXT_LENGTH &&
      value.split("/").every((segment) => HANDOFF_IDENTITY_PATTERN.test(segment)),
    { message: "must be a safe bounded branch name" }
  );

const handoffArtifactOutput = z.strictObject({
  path: handoffPath,
  contract: handoffText,
  contractDigest: handoffDigest,
  primary: z.boolean()
});

const handoffExecutionResources = z.strictObject({
  cpu: z.number().positive(),
  memoryMiB: handoffPositiveInt,
  timeoutSeconds: handoffPositiveInt
});

/**
 * The exact `SmithersTaskMetadata` shape, restated as a strict schema.
 *
 * Metadata drives artifact roots, provenance attribution, retry accounting, and the vulnerability
 * database postprocessors, so it is validated member by member rather than waved through: an
 * unknown key here would be an unvalidated field the worker forwards into Smithers provenance.
 */
const handoffMetadata = z.strictObject({
  schemaVersion: handoffIdentity,
  run: z.strictObject({
    ultrafuzzRunId: handoffIdentity,
    smithersWorkflowName: handoffIdentity,
    graphVersion: handoffIdentity,
    topologyVersion: handoffPositiveInt
  }),
  node: z.strictObject({
    concreteNodeId: handoffIdentity,
    logicalNodeId: handoffIdentity,
    attemptId: handoffIdentity,
    label: handoffText,
    kind: handoffIdentity,
    role: handoffIdentity.optional(),
    promptPath: handoffPath.optional(),
    group: handoffText.optional(),
    producerNodeId: handoffIdentity.optional(),
    storageId: handoffIdentity.optional(),
    dynamic: z
      .strictObject({
        groupNodeId: handoffIdentity,
        sourceNodeId: handoffIdentity,
        sourceAttemptId: handoffIdentity,
        sourceDigest: handoffDigest,
        expansionKey: handoffText,
        itemDigest: handoffDigest,
        manifestPath: handoffPath
      })
      .optional()
  }),
  dependencies: z.strictObject({
    concreteNodeIds: z.array(handoffIdentity),
    attemptIds: z.array(handoffIdentity),
    smithersNodeIds: z.array(handoffIdentity)
  }),
  loop: z.strictObject({
    index: handoffCount,
    count: handoffPositiveInt,
    mode: handoffIdentity,
    attemptIndex: handoffCount
  }),
  model: z
    .strictObject({
      profileId: handoffIdentity,
      agentRef: handoffIdentity,
      modelName: handoffText.optional(),
      reasoningEffort: handoffText.optional(),
      modelIndex: handoffCount,
      attemptIndex: handoffCount
    })
    .optional(),
  // `repoPath` is deliberately absent: it is controller-only provenance the worker never reads, and a
  // configured `project.repo` cannot be stated as a meaningful relocated-worker path, so it is
  // rejected as an unknown nested key rather than transported.
  workspace: z.strictObject({
    primitive: z.literal("worktree"),
    path: handoffPath,
    trustModel: handoffIdentity
  }),
  artifacts: z.strictObject({
    dir: handoffPath,
    outputs: z.array(handoffArtifactOutput),
    manifestPath: handoffPath
  }),
  retryPolicy: z.strictObject({
    maxAttempts: handoffPositiveInt,
    smithersRetries: handoffCount
  }),
  timeout: z.strictObject({
    milliseconds: handoffPositiveInt,
    seconds: handoffPositiveInt,
    heartbeatTimeoutMs: handoffPositiveInt
  }),
  execution: z.strictObject({
    mode: z.enum(["local", "cloud"]),
    provider: z.literal("modal").optional(),
    resources: handoffExecutionResources
  })
});

/**
 * The complete handoff DTO: only the fields required to execute the selected attempt.
 *
 * Deliberately absent, because the worker derives them and trusting them would widen the boundary
 * for nothing: the inline `prompt` body (which would bypass the validated `promptPath`), `dependsOn`
 * and `dynamicDependencies` (a worker runs one attempt), `runtimeContext` (a pure function of
 * `timeoutMs`), the top-level `outputs` duplicate of `metadata.artifacts.outputs`, the
 * `promptRelativePath` / `workspaceRelativePath` / `artifactRelativeDir` hydration aliases, and the
 * provider/resources/credential members of `execution`.
 */
export const cloudSelectedTaskSchema = z.strictObject({
  schema_version: z.literal(CLOUD_SELECTED_TASK_SCHEMA_VERSION),
  id: handoffIdentity,
  attemptId: handoffIdentity,
  preparationId: handoffIdentity,
  verifierId: handoffIdentity,
  agentRef: handoffIdentity,
  modelName: handoffText.nullable(),
  reasoningEffort: handoffText.nullable(),
  branch: handoffBranch,
  promptPath: handoffPath,
  workspacePath: handoffPath,
  artifactDir: handoffPath,
  runRoot: handoffPath,
  workflowPath: handoffPath,
  sourceProjectRoot: handoffSourceRoot,
  dependencyArtifactDirs: z.array(handoffPath),
  referenceArtifactDirs: z.array(handoffPath),
  vulnerabilityDatabase: z.strictObject({ catalogPath: handoffPath, catalogSha256: handoffDigest }).optional(),
  timeoutMs: handoffPositiveInt,
  heartbeatTimeoutMs: handoffPositiveInt,
  retries: handoffCount,
  retryPolicy: z.strictObject({
    backoff: z.literal("exponential"),
    initialDelayMs: handoffCount,
    maxDelayMs: handoffCount
  }),
  metadata: handoffMetadata,
  execution: z.strictObject({
    mode: z.enum(["local", "cloud"]),
    generation: z
      .string()
      .refine(isCloudExecutionGeneration, { message: "must be a bounded cloud execution generation" })
  })
});

export type CloudSelectedTask = z.infer<typeof cloudSelectedTaskSchema>;

/**
 * Every DTO path that must resolve strictly inside the run root.
 *
 * `workflowPath` is deliberately absent: the generated workflow lives at `.smithers/workflows/`, a
 * project child outside any run root, and the canonical safe-relative check already confines it.
 */
const RUN_ROOT_CONFINED_PATHS: ReadonlyArray<{
  label: string;
  read: (task: CloudSelectedTask) => readonly string[];
}> = [
  { label: "promptPath", read: (task) => [task.promptPath] },
  { label: "workspacePath", read: (task) => [task.workspacePath] },
  { label: "artifactDir", read: (task) => [task.artifactDir] },
  { label: "dependencyArtifactDirs", read: (task) => task.dependencyArtifactDirs },
  { label: "referenceArtifactDirs", read: (task) => task.referenceArtifactDirs },
  {
    label: "vulnerabilityDatabase.catalogPath",
    read: (task) => (task.vulnerabilityDatabase === undefined ? [] : [task.vulnerabilityDatabase.catalogPath])
  },
  { label: "metadata.workspace.path", read: (task) => [task.metadata.workspace.path] },
  { label: "metadata.artifacts.dir", read: (task) => [task.metadata.artifacts.dir] },
  { label: "metadata.artifacts.manifestPath", read: (task) => [task.metadata.artifacts.manifestPath] }
];

/**
 * Values the validating side already knows independently of the handoff.
 *
 * A runtime-generated dynamic attempt has no compiled spec to compare against, so binding it to the
 * consumer's own compiled constants is the only thing that keeps its identity from being
 * attacker-chosen. Every supplied field must match exactly.
 */
export interface CloudSelectedTaskExpectation {
  /** The dispatched Smithers node ID; the handoff must claim exactly this attempt. */
  taskId?: string;
  /** The only execution mode this dispatch may run under; both mode members must claim it. */
  executionMode?: "local" | "cloud";
  /** The only cloud provider this dispatch may run under. */
  executionProvider?: "modal";
  /** The sandbox, durable-attempt, and storage-lineage generation issued by this dispatch. */
  executionGeneration?: string;
  /** The dispatched attempt ID; a runtime-generated attempt has no compiled spec to fall back on. */
  attemptId?: string;
  /** The compiled controller project root every relative handoff path is stated against. */
  sourceProjectRoot?: string;
  /** The compiled run ID this workflow was generated for. */
  runId?: string;
  /** The compiled Smithers workflow name. */
  workflowName?: string;
  /** The project-relative location of this generated workflow. */
  workflowPath?: string;
  /** The preparation node ID derived from the dispatched attempt. */
  preparationId?: string;
  /** The verifier node ID derived from the dispatched attempt. */
  verifierId?: string;
  /** The worktree branch derived from the run and the dispatched attempt. */
  branch?: string;
}

/**
 * The only execution identity a cloud dispatch may claim.
 *
 * Both cloud boundaries spread this one constant into their expectation, so a handoff that is
 * internally consistent about running locally -- the shape a runtime-generated attempt with no
 * compiled peer could otherwise smuggle through -- can never be executed as a cloud attempt.
 */
export const CLOUD_SELECTED_TASK_CLOUD_EXECUTION = {
  executionMode: "cloud",
  executionProvider: "modal"
} as const satisfies CloudSelectedTaskExpectation;

export class CloudSelectedTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSelectedTaskError";
  }
}

/**
 * Validates one controller-supplied handoff and returns the exact DTO.
 *
 * Structure, then paths, then cross-field agreement, then dispatch identity: a corrupted or hostile
 * handoff cannot make a worker read, write, or execute outside its own relocated project root, and
 * cannot silently disagree with the artifact roots its own metadata declares.
 */
export function parseCloudSelectedTask(
  value: unknown,
  expectation: CloudSelectedTaskExpectation = {}
): CloudSelectedTask {
  const parsed = cloudSelectedTaskSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new CloudSelectedTaskError(`selected_task is invalid: ${detail}`);
  }
  const task = parsed.data;
  for (const { label, read } of RUN_ROOT_CONFINED_PATHS) {
    for (const candidate of read(task)) {
      if (!isInsideCloudHandoffRoot(task.runRoot, candidate)) {
        throw new CloudSelectedTaskError(`selected_task ${label} must stay inside the run root`);
      }
    }
  }
  assertAgrees(task.metadata.node.attemptId, task.attemptId, "metadata.node.attemptId");
  assertAgrees(task.metadata.artifacts.dir, task.artifactDir, "metadata.artifacts.dir");
  assertAgrees(task.metadata.workspace.path, task.workspacePath, "metadata.workspace.path");
  assertAgrees(
    task.metadata.artifacts.manifestPath,
    `${task.artifactDir}/artifact-manifest.json`,
    "metadata.artifacts.manifestPath"
  );
  assertAgrees(task.metadata.execution.mode, task.execution.mode, "metadata.execution.mode");
  if (
    expectation.executionMode !== undefined &&
    (task.execution.mode !== expectation.executionMode || task.metadata.execution.mode !== expectation.executionMode)
  ) {
    throw new CloudSelectedTaskError(
      `selected_task execution mode ${task.execution.mode} is not the dispatched ${expectation.executionMode} execution identity`
    );
  }
  if (
    expectation.executionProvider !== undefined &&
    task.metadata.execution.provider !== expectation.executionProvider
  ) {
    throw new CloudSelectedTaskError(
      `selected_task metadata.execution.provider is not the dispatched ${expectation.executionProvider} provider`
    );
  }
  if (expectation.executionGeneration !== undefined && task.execution.generation !== expectation.executionGeneration) {
    throw new CloudSelectedTaskError(
      `selected_task execution.generation ${task.execution.generation} is not the dispatched ${expectation.executionGeneration} generation`
    );
  }
  assertAgrees(task.metadata.timeout.milliseconds, task.timeoutMs, "metadata.timeout.milliseconds");
  assertAgrees(
    task.metadata.timeout.heartbeatTimeoutMs,
    task.heartbeatTimeoutMs,
    "metadata.timeout.heartbeatTimeoutMs"
  );
  assertAgrees(task.metadata.retryPolicy.smithersRetries, task.retries, "metadata.retryPolicy.smithersRetries");
  if (expectation.sourceProjectRoot !== undefined && task.sourceProjectRoot !== expectation.sourceProjectRoot) {
    throw new CloudSelectedTaskError("selected_task sourceProjectRoot is not the compiled project root");
  }
  if (
    (expectation.taskId !== undefined && task.id !== expectation.taskId) ||
    (expectation.attemptId !== undefined && task.attemptId !== expectation.attemptId)
  ) {
    throw new CloudSelectedTaskError(
      `selected_task does not identify the dispatched attempt: ${task.id}/${task.attemptId}`
    );
  }
  const bound: Array<[string, string, string | undefined]> = [
    ["preparationId", task.preparationId, expectation.preparationId],
    ["verifierId", task.verifierId, expectation.verifierId],
    ["branch", task.branch, expectation.branch],
    ["workflowPath", task.workflowPath, expectation.workflowPath],
    ["metadata.run.ultrafuzzRunId", task.metadata.run.ultrafuzzRunId, expectation.runId],
    ["metadata.run.smithersWorkflowName", task.metadata.run.smithersWorkflowName, expectation.workflowName]
  ];
  for (const [label, actual, expected] of bound) {
    if (expected !== undefined && actual !== expected) {
      throw new CloudSelectedTaskError(`selected_task ${label} does not match the dispatching workflow`);
    }
  }
  return task;
}

/**
 * Fields a runtime materialization legitimately extends after compilation.
 *
 * A dynamic group is expanded by the controller, so a compiled task that declares dynamic
 * dependencies gains the generated children's artifact directories and identities, and a task whose
 * prompt rendering was deferred gains its rendered prompt path. Every other field must match the
 * compiled DTO exactly.
 */
export const CLOUD_SELECTED_TASK_RUNTIME_EXTENDED_FIELDS = [
  "promptPath",
  "dependencyArtifactDirs",
  "metadata.dependencies.concreteNodeIds",
  "metadata.dependencies.attemptIds",
  "metadata.dependencies.smithersNodeIds"
] as const;

export interface CloudSelectedTaskCanonicalOptions {
  /** The compiled task declares dynamic dependencies, so runtime lowering extends its dependencies. */
  allowsRuntimeDependencies?: boolean;
  /** The compiled task had no rendered prompt, so runtime rendering supplies its canonical path. */
  allowsRuntimeRenderedPrompt?: boolean;
}

/**
 * Compares a handoff against the whole canonical compiled DTO.
 *
 * Every field is compared, including nested ones: the only relaxations are the documented
 * runtime-extended fields above, and each of those still gets its own rule rather than being
 * skipped. Extended dependency entries must be run-root artifact directories or safe identities, and
 * a runtime prompt must be the attempt's own rendered prompt inside its own artifact directory.
 */
export function assertCloudSelectedTaskMatchesCanonical(
  actual: CloudSelectedTask,
  canonical: CloudSelectedTask,
  options: CloudSelectedTaskCanonicalOptions = {}
): void {
  if (options.allowsRuntimeRenderedPrompt === true) {
    const expected = `${canonical.artifactDir}/${CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME}`;
    if (actual.promptPath !== expected) {
      throw new CloudSelectedTaskError(
        "selected_task promptPath must be the attempt's runtime-rendered prompt inside its artifact directory"
      );
    }
  }
  if (options.allowsRuntimeDependencies === true) {
    assertRuntimeExtension(actual.dependencyArtifactDirs, canonical.dependencyArtifactDirs, "dependencyArtifactDirs");
    for (const extra of extraEntries(actual.dependencyArtifactDirs, canonical.dependencyArtifactDirs)) {
      if (!isInsideCloudHandoffRoot(`${actual.runRoot}/artifacts`, extra)) {
        throw new CloudSelectedTaskError(
          "selected_task dependencyArtifactDirs may only gain run-root artifact directories"
        );
      }
    }
    for (const field of ["concreteNodeIds", "attemptIds", "smithersNodeIds"] as const) {
      assertRuntimeExtension(
        actual.metadata.dependencies[field],
        canonical.metadata.dependencies[field],
        `metadata.dependencies.${field}`
      );
    }
  }
  const relaxed = new Set(
    options.allowsRuntimeDependencies === true || options.allowsRuntimeRenderedPrompt === true
      ? CLOUD_SELECTED_TASK_RUNTIME_EXTENDED_FIELDS.filter(
          (field) =>
            (field === "promptPath" && options.allowsRuntimeRenderedPrompt === true) ||
            (field !== "promptPath" && options.allowsRuntimeDependencies === true)
        )
      : []
  );
  const difference = firstDifference(actual, canonical, "", relaxed);
  if (difference !== undefined) {
    throw new CloudSelectedTaskError(`selected_task does not match the compiled attempt: ${difference}`);
  }
}

function assertRuntimeExtension(actual: readonly string[], canonical: readonly string[], field: string): void {
  const seen = new Set(actual);
  if (canonical.some((entry) => !seen.has(entry)) || actual.length !== new Set(actual).size) {
    throw new CloudSelectedTaskError(
      `selected_task ${field} must extend the compiled attempt without dropping entries`
    );
  }
}

function extraEntries(actual: readonly string[], canonical: readonly string[]): string[] {
  const known = new Set(canonical);
  return actual.filter((entry) => !known.has(entry));
}

function assertAgrees(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new CloudSelectedTaskError(`selected_task ${label} disagrees with the handoff it belongs to`);
  }
}

/** Returns the first structurally differing field path, so a mismatch names itself. */
function firstDifference(
  actual: unknown,
  expected: unknown,
  at: string,
  relaxed: ReadonlySet<string>
): string | undefined {
  if (relaxed.has(at)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return at || "<root>";
    if (actual.length !== expected.length) return `${at || "<root>"} length`;
    for (const [index, entry] of expected.entries()) {
      const difference = firstDifference(actual[index], entry, `${at}[${index}]`, relaxed);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  if (isPlainRecord(expected) || isPlainRecord(actual)) {
    if (!isPlainRecord(expected) || !isPlainRecord(actual)) return at || "<root>";
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const difference = firstDifference(actual[key], expected[key], at === "" ? key : `${at}.${key}`, relaxed);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  return actual === expected ? undefined : at || "<root>";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
