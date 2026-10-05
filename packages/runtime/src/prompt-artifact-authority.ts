import path from "node:path";

import {
  ARTIFACT_CONTRACT_IDS,
  CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN,
  isArtifactContractId,
  parseStrictJsonBytes,
  type ArtifactContractId
} from "@ultrafuzz/artifacts";

import { declaredAncestorOutputs, type SemanticArtifactTaskDeclaration } from "./semantic-artifact-context.js";

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
  required: ["schema_version", "run_id", "attempt_id", "artifact_path_base", "producers"],
  properties: {
    schema_version: { const: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION },
    run_id: { type: "string", pattern: SAFE_ID_PATTERN },
    attempt_id: { type: "string", pattern: SAFE_ID_PATTERN },
    artifact_path_base: { type: "string", minLength: 1, maxLength: 4_096 },
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
 * The index of one agent attempt's admitted ancestor outputs.
 *
 * `artifact_path_base` is the absolute run root in the current execution
 * environment. All other paths are canonical relative paths.
 */
export interface PromptArtifactAuthorityDocument {
  schema_version: typeof PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION;
  run_id: string;
  attempt_id: string;
  artifact_path_base: string;
  producers: PromptArtifactAuthorityProducer[];
}

export interface DerivePromptArtifactAuthorityInput {
  runId: string;
  /** The current attempt's declaration in the live task plan, after dynamic expansion. */
  current: SemanticArtifactTaskDeclaration;
  /** Every task declaration in that plan. */
  tasks: readonly SemanticArtifactTaskDeclaration[];
  /** Absolute run root in the current execution environment. */
  artifactPathBase: string;
  /** The ancestor directories admitted after dependency authentication. Only their producers are listed. */
  admittedDependencyArtifactDirs: readonly string[];
}

/**
 * Index every declared output of the current task's admitted ancestors.
 *
 * The producers come from the task plan the workflow is running, so a task
 * that waits on a dynamic group sees the children that group generated.
 */
export function derivePromptArtifactAuthority(
  input: DerivePromptArtifactAuthorityInput
): PromptArtifactAuthorityDocument {
  const artifactPathBase = canonicalAbsolutePath(input.artifactPathBase, "artifact path base");
  const runRoot = path.dirname(
    path.dirname(canonicalAbsolutePath(input.current.artifactDir, "task artifact directory"))
  );
  const admitted = new Set(input.admittedDependencyArtifactDirs.map((directory) => path.resolve(directory)));
  const producersByAttempt = new Map<string, PromptArtifactAuthorityProducer>();
  for (const output of declaredAncestorOutputs(input.current, input.tasks)) {
    if (!admitted.has(path.resolve(output.artifactDir))) continue;
    const contract = output.contract;
    if (!isArtifactContractId(contract)) {
      throw new Error(`prompt artifact authority ancestor ${output.attemptId} declares an unknown contract`);
    }
    let producer = producersByAttempt.get(output.attemptId);
    if (producer === undefined) {
      producer = {
        attempt_id: output.attemptId,
        logical_node_id: output.logicalNodeId,
        artifact_dir: relativePathInside(runRoot, path.resolve(output.artifactDir), "producer artifact directory"),
        outputs: []
      };
      producersByAttempt.set(output.attemptId, producer);
    }
    producer.outputs.push({ path: output.path, contract });
  }
  const producers = [...producersByAttempt.values()];
  for (const producer of producers) {
    producer.outputs.sort(
      (left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.contract, right.contract)
    );
  }
  producers.sort(
    (left, right) =>
      compareCodeUnits(left.artifact_dir, right.artifact_dir) || compareCodeUnits(left.attempt_id, right.attempt_id)
  );

  const document: PromptArtifactAuthorityDocument = {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: input.runId,
    attempt_id: input.current.attemptId,
    artifact_path_base: artifactPathBase,
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
    maxItems: MAX_PROMPT_ARTIFACT_AUTHORITY_OUTPUTS + MAX_PROMPT_ARTIFACT_AUTHORITY_PRODUCERS,
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
    ["schema_version", "run_id", "attempt_id", "artifact_path_base", "producers"],
    "prompt artifact authority"
  );
  if (document.schema_version !== PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION) {
    throw new Error("prompt artifact authority has an unsupported schema version");
  }
  assertSafeId(document.run_id, "prompt artifact authority run ID");
  assertSafeId(document.attempt_id, "prompt artifact authority attempt ID");
  canonicalAbsolutePath(document.artifact_path_base, "prompt artifact authority artifact path base");

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
    if (priorProducerKey !== undefined && compareCodeUnits(priorProducerKey, producerKey) >= 0) {
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
      if (outputPaths.has(outputPath)) {
        throw new Error(
          `prompt artifact authority producer ${producerIndex} repeats output path ${JSON.stringify(outputPath)}`
        );
      }
      outputPaths.add(outputPath);
      const outputKey = `${outputPath}\u0000${output.contract}`;
      if (priorOutputKey !== undefined && compareCodeUnits(priorOutputKey, outputKey) >= 0) {
        throw new Error(`prompt artifact authority producer ${producerIndex} outputs are not canonically ordered`);
      }
      priorOutputKey = outputKey;
    }
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
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

// Code-unit order, not localeCompare: collation depends on the host locale, and
// it ignores the NUL separator in producer keys, so it rejected the order this
// module derives for attempt IDs such as `x-1` and `x-10`.
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
