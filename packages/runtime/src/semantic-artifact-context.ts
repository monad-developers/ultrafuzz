import path from "node:path";

/** The declaration subset shared by compiled Smithers tasks and the sealed task manifest. */
export interface SemanticArtifactTaskDeclaration {
  attemptId: string;
  logicalNodeId: string;
  artifactDir: string;
  dependencies: readonly string[];
  /** Full transitive artifact-ancestor closure for this exact attempt. */
  dependencyArtifactDirs: readonly string[];
  outputs: readonly SemanticArtifactOutputDeclaration[];
}

export interface SemanticArtifactOutputDeclaration {
  path: string;
  contract: string;
}

/** One exact producer/output binding. Reading and authentication happen after this declaration step. */
export interface DeclaredSemanticArtifactOutput {
  attemptId: string;
  logicalNodeId: string;
  artifactDir: string;
  path: string;
  contract: string;
}

export interface DeclaredAncestorOutputOptions {
  /** Restrict the sealed transitive closure to the task's exact direct attempt dependencies. */
  directOnly?: boolean;
}

/**
 * Resolve current-node sibling outputs only from the task's sealed declarations.
 * Multiple paths with the same contract are retained (for example differential triage A/B).
 */
export function declaredSiblingOutputsByContract(
  task: SemanticArtifactTaskDeclaration,
  contract: string
): readonly DeclaredSemanticArtifactOutput[] {
  assertNonEmpty(contract, "artifact contract");
  assertTaskDeclaration(task);
  return Object.freeze(declaredOutputsByContract(task, contract));
}

/**
 * Resolve ancestor outputs from the current attempt's sealed artifact-ancestor closure.
 *
 * This deliberately does not search by logical node ID, filename, or filesystem
 * contents. A known producer is eligible only when its exact attempt directory is
 * present in `dependencyArtifactDirs` and agrees with that producer's declaration.
 * Artifact directories owned by non-agentic/reference ancestors are ignored because
 * they have no task declaration and therefore cannot satisfy a task-output contract.
 */
export function declaredAncestorOutputsByContract(
  task: SemanticArtifactTaskDeclaration,
  tasks: readonly SemanticArtifactTaskDeclaration[],
  contract: string,
  options: DeclaredAncestorOutputOptions = {}
): readonly DeclaredSemanticArtifactOutput[] {
  assertNonEmpty(contract, "artifact contract");
  const tasksByAttempt = indexTaskDeclarations(tasks);
  const current = tasksByAttempt.get(task.attemptId);
  if (current === undefined) {
    throw new Error(`semantic artifact task is not present in the sealed task set: ${JSON.stringify(task.attemptId)}`);
  }
  assertSameTaskIdentity(task, current);

  const directAttemptIds = new Set<string>();
  for (const attemptId of current.dependencies) {
    assertNonEmpty(attemptId, "direct dependency attempt ID");
    if (directAttemptIds.has(attemptId)) {
      throw new Error(`semantic artifact task repeats direct dependency ${JSON.stringify(attemptId)}`);
    }
    directAttemptIds.add(attemptId);
  }

  const seenDirectories = new Set<string>();
  const bindings: DeclaredSemanticArtifactOutput[] = [];
  for (const declaredDirectory of current.dependencyArtifactDirs) {
    const dependencyDirectory = absoluteNormalizedPath(declaredDirectory, "dependency artifact directory");
    if (seenDirectories.has(dependencyDirectory)) {
      throw new Error(`semantic artifact task repeats dependency directory ${JSON.stringify(dependencyDirectory)}`);
    }
    seenDirectories.add(dependencyDirectory);

    const attemptId = path.basename(dependencyDirectory);
    const producer = tasksByAttempt.get(attemptId);
    if (producer === undefined) continue;
    if (attemptId === current.attemptId) {
      throw new Error("semantic artifact task includes its own artifact directory as an ancestor");
    }
    const producerDirectory = absoluteNormalizedPath(producer.artifactDir, "producer artifact directory");
    if (dependencyDirectory !== producerDirectory) {
      throw new Error(
        `semantic artifact dependency directory does not match producer ${JSON.stringify(attemptId)} declaration`
      );
    }
    if (options.directOnly === true && !directAttemptIds.has(attemptId)) continue;
    bindings.push(...declaredOutputsByContract(producer, contract));
  }
  return Object.freeze(bindings);
}

function declaredOutputsByContract(
  task: SemanticArtifactTaskDeclaration,
  contract: string
): DeclaredSemanticArtifactOutput[] {
  const seenPaths = new Set<string>();
  const outputs: DeclaredSemanticArtifactOutput[] = [];
  for (const output of task.outputs) {
    assertNonEmpty(output.path, "artifact output path");
    assertNonEmpty(output.contract, "artifact output contract");
    if (seenPaths.has(output.path)) {
      throw new Error(
        `semantic artifact producer ${JSON.stringify(task.attemptId)} repeats output path ${JSON.stringify(output.path)}`
      );
    }
    seenPaths.add(output.path);
    if (output.contract !== contract) continue;
    outputs.push(
      Object.freeze({
        attemptId: task.attemptId,
        logicalNodeId: task.logicalNodeId,
        artifactDir: task.artifactDir,
        path: output.path,
        contract: output.contract
      })
    );
  }
  return outputs;
}

function indexTaskDeclarations(
  tasks: readonly SemanticArtifactTaskDeclaration[]
): ReadonlyMap<string, SemanticArtifactTaskDeclaration> {
  const tasksByAttempt = new Map<string, SemanticArtifactTaskDeclaration>();
  const attemptsByDirectory = new Map<string, string>();
  for (const task of tasks) {
    assertTaskDeclaration(task);
    if (tasksByAttempt.has(task.attemptId)) {
      throw new Error(`sealed task set repeats attempt ${JSON.stringify(task.attemptId)}`);
    }
    const artifactDirectory = absoluteNormalizedPath(task.artifactDir, "task artifact directory");
    const priorAttempt = attemptsByDirectory.get(artifactDirectory);
    if (priorAttempt !== undefined) {
      throw new Error(
        `sealed tasks ${JSON.stringify(priorAttempt)} and ${JSON.stringify(task.attemptId)} share an artifact directory`
      );
    }
    tasksByAttempt.set(task.attemptId, task);
    attemptsByDirectory.set(artifactDirectory, task.attemptId);
  }
  return tasksByAttempt;
}

function assertTaskDeclaration(task: SemanticArtifactTaskDeclaration): void {
  assertNonEmpty(task.attemptId, "task attempt ID");
  assertNonEmpty(task.logicalNodeId, "task logical node ID");
  absoluteNormalizedPath(task.artifactDir, "task artifact directory");
  if (
    !Array.isArray(task.dependencies) ||
    !Array.isArray(task.dependencyArtifactDirs) ||
    !Array.isArray(task.outputs)
  ) {
    throw new Error(`semantic artifact task declaration is incomplete: ${JSON.stringify(task.attemptId)}`);
  }
}

function assertSameTaskIdentity(
  supplied: SemanticArtifactTaskDeclaration,
  sealed: SemanticArtifactTaskDeclaration
): void {
  if (
    supplied.logicalNodeId !== sealed.logicalNodeId ||
    absoluteNormalizedPath(supplied.artifactDir, "supplied task artifact directory") !==
      absoluteNormalizedPath(sealed.artifactDir, "sealed task artifact directory")
  ) {
    throw new Error(
      `semantic artifact task identity disagrees with the sealed task set: ${JSON.stringify(supplied.attemptId)}`
    );
  }
}

function absoluteNormalizedPath(value: string, label: string): string {
  assertNonEmpty(value, label);
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || value !== resolved) {
    throw new Error(`${label} must be an absolute normalized path: ${JSON.stringify(value)}`);
  }
  return resolved;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
