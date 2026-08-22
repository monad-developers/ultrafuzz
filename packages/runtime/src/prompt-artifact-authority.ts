import path from "node:path";

import {
  ARTIFACT_CONTRACT_IDS,
  CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN,
  isArtifactContractId,
  MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS,
  MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  promptArtifactAuthorityPathSelectorId,
  type ArtifactContractId,
  type SmithersTaskManifestPromptArtifactAuthoritySelector,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

export const PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION = "ultrafuzz.prompt-artifact-authority.v1" as const;
export const PROMPT_ARTIFACT_AUTHORITY_JSON_SCHEMA_ID =
  "urn:ultrafuzz:schema:runtime:prompt-artifact-authority:1" as const;

export const MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS = 100_000;
const MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS = 1_000_000;
const SAFE_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const SAFE_ID = new RegExp(SAFE_ID_PATTERN, "u");
const CANONICAL_RELATIVE_PATH = new RegExp(CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN, "u");

/** Machine-readable structural schema; semantic/path gates are enforced by the parser below. */
export const promptArtifactAuthorityJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: PROMPT_ARTIFACT_AUTHORITY_JSON_SCHEMA_ID,
  title: "Ultrafuzz per-task prompt artifact authority",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "run_id", "attempt_id", "artifact_path_base", "selectors", "producers"],
  properties: {
    schema_version: { const: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION },
    run_id: { type: "string", pattern: SAFE_ID_PATTERN },
    attempt_id: { type: "string", pattern: SAFE_ID_PATTERN },
    artifact_path_base: { type: "string", minLength: 1, maxLength: 4_096 },
    selectors: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS,
      uniqueItems: true,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "contract"],
            properties: { kind: { const: "contract" }, contract: { enum: ARTIFACT_CONTRACT_IDS } }
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "id", "paths"],
            properties: {
              kind: { const: "path" },
              id: { type: "string", pattern: "^[0-9a-f]{64}$" },
              paths: {
                type: "array",
                minItems: 1,
                maxItems: MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS,
                uniqueItems: true,
                items: { type: "string", pattern: CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN }
              }
            }
          }
        ]
      }
    },
    producers: {
      type: "array",
      maxItems: MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attempt_id", "logical_node_id", "artifact_dir", "outputs"],
        properties: {
          attempt_id: { type: "string", pattern: SAFE_ID_PATTERN },
          logical_node_id: { type: "string", pattern: SAFE_ID_PATTERN },
          artifact_dir: {
            type: "string",
            pattern: `^artifacts/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
          },
          outputs: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "contract"],
              properties: {
                path: { type: "string", pattern: CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN },
                contract: { enum: ARTIFACT_CONTRACT_IDS }
              }
            }
          }
        }
      }
    }
  }
} as const;

export interface PromptArtifactAuthorityContractSelector {
  kind: "contract";
  contract: ArtifactContractId;
}

export interface PromptArtifactAuthorityPathSelector {
  kind: "path";
  id: string;
  paths: readonly string[];
}

export type PromptArtifactAuthoritySelector =
  PromptArtifactAuthorityContractSelector | PromptArtifactAuthorityPathSelector;

export interface PromptArtifactAuthorityOutput {
  path: string;
  contract: ArtifactContractId;
}

export interface PromptArtifactAuthorityProducer {
  attempt_id: string;
  logical_node_id: string;
  /** Canonical path relative to `artifact_path_base`. */
  artifact_dir: string;
  outputs: PromptArtifactAuthorityOutput[];
}

/**
 * The minimized artifact declaration exposed to one agent attempt.
 *
 * `artifact_path_base` is the absolute run root in the current execution
 * environment. All other paths are canonical relative paths, so sealed
 * controller-host paths never enter this document.
 */
export interface PromptArtifactAuthorityDocument {
  schema_version: typeof PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION;
  run_id: string;
  attempt_id: string;
  artifact_path_base: string;
  selectors: PromptArtifactAuthoritySelector[];
  producers: PromptArtifactAuthorityProducer[];
}

export interface DerivePromptArtifactAuthorityInput {
  /** Exact bytes read from the sealed execution snapshot's `controls/tasks.json`. */
  sealedTaskManifestBytes: Uint8Array;
  currentAttemptId: string;
  /** Absolute run root after local/cloud execution relocation. */
  relocatedRunRoot: string;
  /**
   * Exact relocated ancestor directories admitted after dependency
   * authentication. Every required directory must be present. Optional
   * directories without an admitted verifier marker must be omitted.
   */
  admittedDependencyArtifactDirs: readonly string[];
  /** Canonical compact selector groups sealed for this task's prompt. */
  selectors: readonly SmithersTaskManifestPromptArtifactAuthoritySelector[];
}

/**
 * Derive the portable, least-authority artifact view for one task.
 *
 * The sealed task manifest is parsed and semantically validated from bytes on
 * every call. The result contains only admitted ancestor producers and only
 * their outputs selected by the current prompt.
 */
export function derivePromptArtifactAuthority(
  input: DerivePromptArtifactAuthorityInput
): PromptArtifactAuthorityDocument {
  assertSafeId(input.currentAttemptId, "current attempt ID");
  const manifest = parseSmithersTaskManifestBytes(input.sealedTaskManifestBytes);
  const current = manifest.tasks.find((task) => task.attemptId === input.currentAttemptId);
  if (current === undefined) {
    throw new Error(
      `prompt artifact authority cannot find current attempt ${JSON.stringify(input.currentAttemptId)} in the sealed task manifest`
    );
  }
  const selectors = normalizeSelectors(input.selectors);
  const sealedSelectors = normalizeSelectors(current.promptArtifactAuthoritySelectors ?? []);
  if (JSON.stringify(selectors) !== JSON.stringify(sealedSelectors)) {
    throw new Error("prompt artifact authority selectors do not match the sealed current-task declaration");
  }

  const relocatedRunRoot = canonicalAbsolutePath(input.relocatedRunRoot, "relocated run root");
  const sourceCurrentArtifactDir = canonicalAbsolutePath(current.artifactDir, "sealed current-task artifact directory");
  const sourceRunRoot = path.dirname(path.dirname(sourceCurrentArtifactDir));
  assertExactArtifactDirectory(
    relativePathInside(sourceRunRoot, sourceCurrentArtifactDir, "sealed current-task artifact directory"),
    current.attemptId,
    "sealed current-task artifact directory"
  );

  const tasksBySourceArtifactDir = indexSealedTasksByArtifactDirectory(manifest.tasks, sourceRunRoot);
  const declaredDependencies = indexDeclaredDependencies(current, sourceRunRoot);
  const optionalDependencies = new Set(
    (current.optionalDependencyArtifactDirs ?? []).map((directory) => {
      const relative = relativePathInside(
        sourceRunRoot,
        canonicalAbsolutePath(directory, "sealed optional dependency artifact directory"),
        "sealed optional dependency artifact directory"
      );
      if (!declaredDependencies.has(relative)) {
        throw new Error(
          `prompt artifact authority optional dependency is outside the current task's declared closure: ${JSON.stringify(relative)}`
        );
      }
      return relative;
    })
  );

  const admittedDependencies = indexAdmittedDependencies(
    input.admittedDependencyArtifactDirs,
    relocatedRunRoot,
    declaredDependencies
  );
  for (const relative of declaredDependencies.keys()) {
    if (!optionalDependencies.has(relative) && !admittedDependencies.has(relative)) {
      throw new Error(`prompt artifact authority is missing required admitted dependency ${JSON.stringify(relative)}`);
    }
  }

  const selectedContracts = new Set(
    selectors.flatMap((selector) => (selector.kind === "contract" ? [selector.contract] : []))
  );
  const selectedPaths = new Set(selectors.flatMap((selector) => (selector.kind === "path" ? selector.paths : [])));
  const producers: PromptArtifactAuthorityProducer[] = [];
  for (const relativeDirectory of [...admittedDependencies].sort(localeCompare)) {
    const sourceDirectory = declaredDependencies.get(relativeDirectory)!;
    const producer = tasksBySourceArtifactDir.get(sourceDirectory);
    // Reference ancestors have artifact roots but no agentic task declaration.
    if (producer === undefined) continue;
    const outputs = selectedProducerOutputs(producer, selectedContracts, selectedPaths);
    if (outputs.length === 0) continue;
    producers.push({
      attempt_id: producer.attemptId,
      logical_node_id: producer.logicalNodeId,
      artifact_dir: relativeDirectory,
      outputs
    });
  }
  producers.sort(
    (left, right) =>
      localeCompare(left.artifact_dir, right.artifact_dir) || localeCompare(left.attempt_id, right.attempt_id)
  );

  const document: PromptArtifactAuthorityDocument = {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: manifest.run_id,
    attempt_id: current.attemptId,
    artifact_path_base: relocatedRunRoot,
    selectors,
    producers
  };
  assertValidPromptArtifactAuthority(document);
  return document;
}

/** Parse and validate an agent-visible prompt artifact authority document. */
export function parsePromptArtifactAuthorityBytes(bytes: Uint8Array): PromptArtifactAuthorityDocument {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES,
    maxDepth: 8,
    maxItems:
      MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS +
      MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS +
      MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS +
      MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS,
    maxProperties: 4 * MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS + 8 * MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS
  });
  assertValidPromptArtifactAuthority(value);
  return value;
}

/** Serialize a validated authority into deterministic bytes suitable for retry restoration. */
export function serializePromptArtifactAuthority(document: PromptArtifactAuthorityDocument): Buffer {
  assertValidPromptArtifactAuthority(document);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES) {
    throw new Error(
      `prompt artifact authority exceeds the ${MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES}-byte materialization limit`
    );
  }
  return bytes;
}

export function assertValidPromptArtifactAuthority(value: unknown): asserts value is PromptArtifactAuthorityDocument {
  const document = exactRecord(
    value,
    ["schema_version", "run_id", "attempt_id", "artifact_path_base", "selectors", "producers"],
    "prompt artifact authority"
  );
  if (document.schema_version !== PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION) {
    throw new Error("prompt artifact authority has an unsupported schema version");
  }
  assertSafeId(document.run_id, "prompt artifact authority run ID");
  assertSafeId(document.attempt_id, "prompt artifact authority attempt ID");
  canonicalAbsolutePath(document.artifact_path_base, "prompt artifact authority artifact path base");

  if (
    !Array.isArray(document.selectors) ||
    document.selectors.length === 0 ||
    document.selectors.length > MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS
  ) {
    throw new Error("prompt artifact authority selectors must be a non-empty bounded array");
  }
  const selectorKeys: string[] = [];
  const selectedContracts = new Set<ArtifactContractId>();
  const selectedPaths = new Set<string>();
  let totalSelectorPaths = 0;
  for (const [index, valueSelector] of document.selectors.entries()) {
    const selector = validateSelector(valueSelector, `prompt artifact authority selector ${index}`);
    selectorKeys.push(selectorKey(selector));
    if (selector.kind === "contract") selectedContracts.add(selector.contract);
    else {
      totalSelectorPaths += selector.paths.length;
      if (totalSelectorPaths > MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS) {
        throw new Error("prompt artifact authority has too many selected paths");
      }
      for (const selectedPath of selector.paths) selectedPaths.add(selectedPath);
    }
  }
  assertCanonicalUniqueOrder(selectorKeys, "prompt artifact authority selectors");

  if (!Array.isArray(document.producers) || document.producers.length > MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS) {
    throw new Error("prompt artifact authority producers must be a bounded array");
  }
  const producerAttempts = new Set<string>();
  const producerDirectories = new Set<string>();
  let priorProducerKey: string | undefined;
  let totalOutputs = 0;
  for (const [producerIndex, valueProducer] of document.producers.entries()) {
    const producer = exactRecord(
      valueProducer,
      ["attempt_id", "logical_node_id", "artifact_dir", "outputs"],
      `prompt artifact authority producer ${producerIndex}`
    );
    assertSafeId(producer.attempt_id, `prompt artifact authority producer ${producerIndex} attempt ID`);
    assertSafeId(producer.logical_node_id, `prompt artifact authority producer ${producerIndex} logical node ID`);
    const artifactDirectory = canonicalRelativePath(
      producer.artifact_dir,
      `prompt artifact authority producer ${producerIndex} artifact directory`
    );
    assertExactArtifactDirectory(
      artifactDirectory,
      producer.attempt_id,
      `prompt artifact authority producer ${producerIndex} artifact directory`
    );
    if (producerAttempts.has(producer.attempt_id)) {
      throw new Error(`prompt artifact authority repeats producer attempt ${JSON.stringify(producer.attempt_id)}`);
    }
    if (producerDirectories.has(artifactDirectory)) {
      throw new Error(
        `prompt artifact authority repeats producer artifact directory ${JSON.stringify(artifactDirectory)}`
      );
    }
    producerAttempts.add(producer.attempt_id);
    producerDirectories.add(artifactDirectory);
    if (producer.attempt_id === document.attempt_id) {
      throw new Error("prompt artifact authority includes the current task as its own producer");
    }
    const producerKey = `${artifactDirectory}\u0000${String(producer.attempt_id)}`;
    if (priorProducerKey !== undefined && localeCompare(priorProducerKey, producerKey) >= 0) {
      throw new Error("prompt artifact authority producers are not canonically ordered");
    }
    priorProducerKey = producerKey;

    if (!Array.isArray(producer.outputs) || producer.outputs.length === 0) {
      throw new Error(`prompt artifact authority producer ${producerIndex} must have selected outputs`);
    }
    totalOutputs += producer.outputs.length;
    if (totalOutputs > MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS) {
      throw new Error("prompt artifact authority has too many selected outputs");
    }
    const outputPaths = new Set<string>();
    let priorOutputKey: string | undefined;
    for (const [outputIndex, valueOutput] of producer.outputs.entries()) {
      const output = exactRecord(
        valueOutput,
        ["path", "contract"],
        `prompt artifact authority producer ${producerIndex} output ${outputIndex}`
      );
      const outputPath = canonicalRelativePath(
        output.path,
        `prompt artifact authority producer ${producerIndex} output ${outputIndex} path`
      );
      if (!isArtifactContractId(output.contract)) {
        throw new Error(
          `prompt artifact authority producer ${producerIndex} output ${outputIndex} has an unknown contract`
        );
      }
      if (!selectedContracts.has(output.contract) && !selectedPaths.has(outputPath)) {
        throw new Error(
          `prompt artifact authority producer ${producerIndex} output ${outputIndex} is outside the declared selectors`
        );
      }
      if (outputPaths.has(outputPath)) {
        throw new Error(
          `prompt artifact authority producer ${producerIndex} repeats output path ${JSON.stringify(outputPath)}`
        );
      }
      outputPaths.add(outputPath);
      const outputKey = `${outputPath}\u0000${output.contract}`;
      if (priorOutputKey !== undefined && localeCompare(priorOutputKey, outputKey) >= 0) {
        throw new Error(`prompt artifact authority producer ${producerIndex} outputs are not canonically ordered`);
      }
      priorOutputKey = outputKey;
    }
  }
}

function indexSealedTasksByArtifactDirectory(
  tasks: readonly SmithersTaskManifestTask[],
  sourceRunRoot: string
): ReadonlyMap<string, SmithersTaskManifestTask> {
  const tasksByArtifactDirectory = new Map<string, SmithersTaskManifestTask>();
  for (const task of tasks) {
    const sourceArtifactDirectory = canonicalAbsolutePath(task.artifactDir, "sealed task artifact directory");
    const relativeDirectory = relativePathInside(
      sourceRunRoot,
      sourceArtifactDirectory,
      "sealed task artifact directory"
    );
    assertExactArtifactDirectory(relativeDirectory, task.attemptId, "sealed task artifact directory");
    if (tasksByArtifactDirectory.has(sourceArtifactDirectory)) {
      throw new Error(`sealed task manifest repeats artifact directory ${JSON.stringify(sourceArtifactDirectory)}`);
    }
    tasksByArtifactDirectory.set(sourceArtifactDirectory, task);
  }
  return tasksByArtifactDirectory;
}

function indexDeclaredDependencies(
  current: SmithersTaskManifestTask,
  sourceRunRoot: string
): ReadonlyMap<string, string> {
  const dependencies = new Map<string, string>();
  for (const directory of current.dependencyArtifactDirs) {
    const sourceDirectory = canonicalAbsolutePath(directory, "sealed dependency artifact directory");
    const relativeDirectory = relativePathInside(
      sourceRunRoot,
      sourceDirectory,
      "sealed dependency artifact directory"
    );
    assertArtifactDirectory(relativeDirectory, "sealed dependency artifact directory");
    if (dependencies.has(relativeDirectory)) {
      throw new Error(`sealed current task repeats dependency artifact directory ${JSON.stringify(relativeDirectory)}`);
    }
    dependencies.set(relativeDirectory, sourceDirectory);
  }
  return dependencies;
}

function indexAdmittedDependencies(
  directories: readonly string[],
  relocatedRunRoot: string,
  declaredDependencies: ReadonlyMap<string, string>
): ReadonlySet<string> {
  if (!Array.isArray(directories)) {
    throw new Error("prompt artifact authority admitted dependency directories must be an array");
  }
  const admitted = new Set<string>();
  for (const directory of directories) {
    const relocatedDirectory = canonicalAbsolutePath(directory, "admitted dependency artifact directory");
    const relativeDirectory = relativePathInside(
      relocatedRunRoot,
      relocatedDirectory,
      "admitted dependency artifact directory"
    );
    assertArtifactDirectory(relativeDirectory, "admitted dependency artifact directory");
    if (!declaredDependencies.has(relativeDirectory)) {
      throw new Error(
        `prompt artifact authority admitted dependency is outside the sealed ancestor closure: ${JSON.stringify(relativeDirectory)}`
      );
    }
    if (admitted.has(relativeDirectory)) {
      throw new Error(`prompt artifact authority repeats admitted dependency ${JSON.stringify(relativeDirectory)}`);
    }
    admitted.add(relativeDirectory);
  }
  return admitted;
}

function selectedProducerOutputs(
  producer: SmithersTaskManifestTask,
  selectedContracts: ReadonlySet<ArtifactContractId>,
  selectedPaths: ReadonlySet<string>
): PromptArtifactAuthorityOutput[] {
  const seenPaths = new Set<string>();
  const selected: PromptArtifactAuthorityOutput[] = [];
  for (const output of producer.metadata.artifacts.outputs) {
    const outputPath = canonicalRelativePath(
      output.path,
      `sealed producer ${JSON.stringify(producer.attemptId)} output path`
    );
    if (seenPaths.has(outputPath)) {
      throw new Error(
        `sealed producer ${JSON.stringify(producer.attemptId)} repeats output path ${JSON.stringify(outputPath)}`
      );
    }
    seenPaths.add(outputPath);
    if (!selectedContracts.has(output.contract) && !selectedPaths.has(outputPath)) continue;
    selected.push({ path: outputPath, contract: output.contract });
  }
  selected.sort((left, right) => localeCompare(left.path, right.path) || localeCompare(left.contract, right.contract));
  return selected;
}

function normalizeSelectors(selectors: readonly PromptArtifactAuthoritySelector[]): PromptArtifactAuthoritySelector[] {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw new Error("prompt artifact authority requires at least one output selector");
  }
  if (selectors.length > MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS) {
    throw new Error("prompt artifact authority has too many output selectors");
  }
  const normalized = selectors.map((selector, index) =>
    validateSelector(selector, `prompt artifact authority input selector ${index}`)
  );
  const seen = new Set<string>();
  for (const selector of normalized) {
    const key = selectorKey(selector);
    if (seen.has(key)) {
      throw new Error(`prompt artifact authority repeats selector ${JSON.stringify(key)}`);
    }
    seen.add(key);
  }
  return normalized.sort((left, right) => localeCompare(selectorKey(left), selectorKey(right)));
}

function validateSelector(value: unknown, label: string): PromptArtifactAuthoritySelector {
  if (!isPlainRecord(value) || (value.kind !== "contract" && value.kind !== "path")) {
    throw new Error(`${label} is invalid`);
  }
  if (value.kind === "contract") {
    exactRecord(value, ["kind", "contract"], label);
    if (!isArtifactContractId(value.contract)) throw new Error(`${label} has an unknown artifact contract`);
    return { kind: "contract", contract: value.contract };
  }
  exactRecord(value, ["kind", "id", "paths"], label);
  if (typeof value.id !== "string" || !/^[0-9a-f]{64}$/u.test(value.id)) {
    throw new Error(`${label} has an invalid selector ID`);
  }
  if (
    !Array.isArray(value.paths) ||
    value.paths.length === 0 ||
    value.paths.length > MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS
  ) {
    throw new Error(`${label} paths must be a non-empty bounded array`);
  }
  const paths = value.paths.map((selectedPath, index) => canonicalRelativePath(selectedPath, `${label} path ${index}`));
  assertCanonicalUniqueOrder(paths, `${label} paths`);
  if (value.id !== promptArtifactAuthorityPathSelectorId(paths)) {
    throw new Error(`${label} ID does not match its paths`);
  }
  return { kind: "path", id: value.id, paths };
}

function selectorKey(selector: PromptArtifactAuthoritySelector): string {
  return selector.kind === "contract" ? `contract\u0000${selector.contract}` : `path\u0000${selector.id}`;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort(localeCompare);
  const expected = [...keys].sort(localeCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
}

function canonicalAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return value;
}

function canonicalRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_RELATIVE_PATH.test(value)) {
    throw new Error(`${label} must be a canonical run-relative path without traversal or an absolute prefix`);
  }
  return value;
}

function relativePathInside(root: string, target: string, label: string): string {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes the run root`);
  }
  return canonicalRelativePath(relative.split(path.sep).join("/"), label);
}

function assertArtifactDirectory(value: string, label: string): void {
  canonicalRelativePath(value, label);
  const segments = value.split("/");
  if (segments.length !== 2 || segments[0] !== "artifacts" || !SAFE_ID.test(segments[1]!)) {
    throw new Error(`${label} must be an exact run-relative artifact directory`);
  }
}

function assertExactArtifactDirectory(value: string, attemptId: string, label: string): void {
  assertSafeId(attemptId, `${label} attempt ID`);
  assertArtifactDirectory(value, label);
  if (value !== `artifacts/${attemptId}`) {
    throw new Error(`${label} does not match its producer attempt ID`);
  }
}

function assertCanonicalUniqueOrder(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (localeCompare(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} are duplicated or not canonically ordered`);
    }
  }
}

function localeCompare(left: string, right: string): number {
  return left.localeCompare(right);
}
