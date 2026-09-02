import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  publishFileDurableExclusive,
  validateSafeId
} from "@ultrafuzz/artifacts";
import { isDynamicItemTemplateVariable, isNamespacedDynamicReplacementKey } from "@ultrafuzz/prompts";

import { sha256Stable, stableJson } from "./utils.js";

export const DYNAMIC_EXPANSION_SCHEMA_VERSION = "ultrafuzz.dynamic-expansion.v1" as const;
/** Generated IDs stay canonical lowercase; static historical IDs may contain uppercase. */
export const DYNAMIC_NODE_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,255}$/u;

export interface DynamicExpansionInput {
  runId: string;
  groupNodeId: string;
  sourceNodeId: string;
  sourceAttemptId: string;
  sourceArtifactPath: string;
  sourceDigest: string;
  sourceDocument: unknown;
  sourcePath: string;
  keyPath: string;
  nodeIdTemplate: string;
  templateDigest: string;
  templateFingerprint: string;
  maxDynamicNodes: number;
  sequence?: number;
  alreadyExpandedNodes?: number;
  reservedNodeIds?: Iterable<string>;
}

export interface DynamicExpansionItem {
  order: number;
  key: string;
  item: Record<string, unknown>;
  item_sha256: string;
  node_id: string;
  storage_id: string;
  variables: Record<string, string | number | boolean>;
}

export interface DynamicExpansionManifest {
  schema_version: typeof DYNAMIC_EXPANSION_SCHEMA_VERSION;
  run_id: string;
  group_node_id: string;
  source: {
    node_id: string;
    attempt_id: string;
    artifact_path: string;
    output_sha256: string;
    json_path: string;
  };
  template: {
    key_path: string;
    node_id: string;
    prompt_sha256: string;
    fingerprint: string;
  };
  max_dynamic_nodes: number;
  /**
   * Explicit monotonic publication order. Two independently sourced groups can legitimately share
   * a `dynamic_nodes_before` boundary when one of them expands to zero items, so contiguity must be
   * validated in publication order rather than by sorting on the counts themselves.
   *
   * Optional for backward compatibility: a run whose manifests were published before this field
   * existed must still resume, so a set without it keeps the historical count-based ordering.
   */
  sequence?: number;
  dynamic_nodes_before: number;
  dynamic_nodes_after: number;
  items: DynamicExpansionItem[];
}

export interface DynamicExpansionRetryArchive {
  archive_path: string;
  group_node_ids: string[];
}

export class DynamicExpansionError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DynamicExpansionError";
    this.code = code;
    this.details = details;
  }
}

export function planDynamicExpansion(input: DynamicExpansionInput): DynamicExpansionManifest {
  validateSafeId(input.runId, "run ID");
  validateSafeId(input.groupNodeId, "dynamic group node ID");
  validateSafeId(input.sourceNodeId, "dynamic source node ID");
  validateSafeId(input.sourceAttemptId, "dynamic source attempt ID");
  assertDigest(input.sourceDigest, "dynamic source digest");
  assertDigest(input.templateDigest, "dynamic prompt digest");
  assertDigest(input.templateFingerprint, "dynamic template fingerprint");
  if (!Number.isInteger(input.maxDynamicNodes) || input.maxDynamicNodes < 1) {
    throw dynamicError("DYNAMIC_LIMIT_INVALID", "max_dynamic_nodes must be a positive integer", {
      max: input.maxDynamicNodes
    });
  }
  const selected = resolveJsonPath(input.sourceDocument, input.sourcePath);
  if (!Array.isArray(selected)) {
    throw dynamicError("DYNAMIC_SOURCE_NOT_ARRAY", `Dynamic source ${input.sourcePath} must resolve to an array`, {
      groupNodeId: input.groupNodeId,
      sourcePath: input.sourcePath
    });
  }
  const alreadyExpanded = input.alreadyExpandedNodes ?? 0;
  if (alreadyExpanded + selected.length > input.maxDynamicNodes) {
    throw dynamicError(
      "TOO_MANY_DYNAMIC_NODES",
      `Dynamic expansion would create ${alreadyExpanded + selected.length} nodes, exceeding max_dynamic_nodes=${input.maxDynamicNodes}`,
      { count: alreadyExpanded + selected.length, max: input.maxDynamicNodes, groupNodeId: input.groupNodeId }
    );
  }

  const reserved = new Set(input.reservedNodeIds ?? []);
  const keys = new Set<string>();
  const generatedIds = new Set<string>();
  const generatedStorageIds = new Set<string>();
  const items = selected.map<DynamicExpansionItem>((value, order) => {
    if (!isPlainRecord(value)) {
      throw dynamicError("DYNAMIC_ITEM_INVALID", `Dynamic item ${order} must be a JSON object`, {
        groupNodeId: input.groupNodeId,
        order
      });
    }
    const keyValue = resolveItemPath(value, input.keyPath);
    if (!isScalar(keyValue) || String(keyValue).length === 0) {
      throw dynamicError("DYNAMIC_KEY_INVALID", `Dynamic item ${order} has an invalid key`, {
        groupNodeId: input.groupNodeId,
        keyPath: input.keyPath,
        order
      });
    }
    const key = String(keyValue);
    if (keys.has(key)) {
      throw dynamicError("DYNAMIC_KEY_DUPLICATE", `Dynamic group ${input.groupNodeId} repeats key ${key}`, {
        groupNodeId: input.groupNodeId,
        key
      });
    }
    keys.add(key);
    const nodeId = renderDynamicNodeId(input.nodeIdTemplate, value);
    if (!DYNAMIC_NODE_ID_PATTERN.test(nodeId)) {
      throw dynamicError("DYNAMIC_NODE_ID_INVALID", `Generated node ID ${JSON.stringify(nodeId)} is invalid`, {
        groupNodeId: input.groupNodeId,
        key,
        nodeId
      });
    }
    if (generatedIds.has(nodeId) || generatedStorageIds.has(nodeId) || reserved.has(nodeId)) {
      throw dynamicError("DYNAMIC_NODE_ID_COLLISION", `Generated node ID ${nodeId} is not globally unique`, {
        groupNodeId: input.groupNodeId,
        key,
        nodeId
      });
    }
    const storageId = dynamicStorageId(input.groupNodeId, nodeId);
    if (generatedIds.has(storageId) || generatedStorageIds.has(storageId) || reserved.has(storageId)) {
      throw dynamicError("DYNAMIC_NODE_ID_COLLISION", `Generated storage ID ${storageId} is not globally unique`, {
        groupNodeId: input.groupNodeId,
        key,
        nodeId,
        storageId
      });
    }
    generatedIds.add(nodeId);
    generatedStorageIds.add(storageId);
    return {
      order,
      key,
      item: canonicalClone(value),
      item_sha256: sha256Stable(value),
      node_id: nodeId,
      storage_id: storageId,
      variables: dynamicItemVariables(value)
    };
  });

  return {
    schema_version: DYNAMIC_EXPANSION_SCHEMA_VERSION,
    run_id: input.runId,
    group_node_id: input.groupNodeId,
    source: {
      node_id: input.sourceNodeId,
      attempt_id: input.sourceAttemptId,
      artifact_path: input.sourceArtifactPath.split(path.sep).join("/"),
      output_sha256: input.sourceDigest,
      json_path: input.sourcePath
    },
    template: {
      key_path: input.keyPath,
      node_id: input.nodeIdTemplate,
      prompt_sha256: input.templateDigest,
      fingerprint: input.templateFingerprint
    },
    max_dynamic_nodes: input.maxDynamicNodes,
    sequence: input.sequence ?? 0,
    dynamic_nodes_before: alreadyExpanded,
    dynamic_nodes_after: alreadyExpanded + items.length,
    items
  };
}

export function loadOrCreateDynamicExpansion(input: {
  runRoot: string;
  runId: string;
  groupNodeId: string;
  sourceNodeId: string;
  sourceAttemptId: string;
  sourceArtifactPath: string;
  sourcePath: string;
  keyPath: string;
  nodeIdTemplate: string;
  templatePath: string;
  templateDigest: string;
  templateFingerprint: string;
  maxDynamicNodes: number;
  reservedNodeIds?: Iterable<string>;
}): DynamicExpansionManifest {
  const runRoot = path.resolve(input.runRoot);
  assertPathInside(runRoot, input.sourceArtifactPath, "dynamic source artifact");
  assertPathInside(runRoot, input.templatePath, "dynamic prompt template");
  assertNoSymlinkComponents(runRoot, input.sourceArtifactPath, "dynamic source artifact");
  assertNoSymlinkComponents(runRoot, input.templatePath, "dynamic prompt template");
  assertRegularFileInside(runRoot, input.sourceArtifactPath, "dynamic source artifact");
  assertRegularFileInside(runRoot, input.templatePath, "dynamic prompt template");
  const sourceBytes = fs.readFileSync(input.sourceArtifactPath);
  const sourceDigest = sha256Bytes(sourceBytes);
  const actualTemplateDigest = sha256Bytes(fs.readFileSync(input.templatePath));
  if (actualTemplateDigest !== input.templateDigest) {
    throw dynamicError("DYNAMIC_TEMPLATE_CHANGED", `Dynamic group ${input.groupNodeId} prompt template changed`, {
      groupNodeId: input.groupNodeId,
      expected: input.templateDigest,
      actual: actualTemplateDigest
    });
  }
  const manifestDir = path.join(runRoot, "dynamic-expansions");
  assertPathInside(runRoot, manifestDir, "dynamic expansion manifest directory");
  assertNoSymlinkComponents(runRoot, manifestDir, "dynamic expansion manifest directory");
  fs.mkdirSync(manifestDir, { recursive: true });
  assertNoSymlinkComponents(runRoot, manifestDir, "dynamic expansion manifest directory");
  const manifestPath = path.join(manifestDir, `${validateSafeId(input.groupNodeId, "dynamic group node ID")}.json`);
  const sourceArtifactRelativePath = path.relative(runRoot, input.sourceArtifactPath).split(path.sep).join("/");
  return withDynamicExpansionLock(manifestDir, () => {
    const priorManifests = readExpansionManifests(manifestDir);
    assertManifestSetMatchesInput(priorManifests, {
      runId: input.runId,
      maxDynamicNodes: input.maxDynamicNodes,
      reservedNodeIds: input.reservedNodeIds
    });
    const existing = priorManifests.find((manifest) => manifest.group_node_id === input.groupNodeId);
    if (existing !== undefined) {
      assertCompatibleManifest(existing, {
        runId: input.runId,
        groupNodeId: input.groupNodeId,
        sourceNodeId: input.sourceNodeId,
        sourceAttemptId: input.sourceAttemptId,
        sourceArtifactPath: sourceArtifactRelativePath,
        sourceDigest,
        templateDigest: input.templateDigest,
        templateFingerprint: input.templateFingerprint,
        sourcePath: input.sourcePath,
        keyPath: input.keyPath,
        nodeIdTemplate: input.nodeIdTemplate,
        maxDynamicNodes: input.maxDynamicNodes
      });
      return existing;
    }

    let sourceDocument: unknown;
    try {
      sourceDocument = JSON.parse(sourceBytes.toString("utf8")) as unknown;
    } catch (error) {
      throw dynamicError("DYNAMIC_SOURCE_JSON_INVALID", `Dynamic source artifact is not valid JSON`, {
        groupNodeId: input.groupNodeId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    const reserved = new Set(input.reservedNodeIds ?? []);
    for (const manifest of priorManifests) {
      for (const item of manifest.items) reserved.add(item.node_id);
    }
    const manifest = planDynamicExpansion({
      runId: input.runId,
      groupNodeId: input.groupNodeId,
      sourceNodeId: input.sourceNodeId,
      sourceAttemptId: input.sourceAttemptId,
      sourceArtifactPath: sourceArtifactRelativePath,
      sourceDigest,
      sourceDocument,
      sourcePath: input.sourcePath,
      keyPath: input.keyPath,
      nodeIdTemplate: input.nodeIdTemplate,
      templateDigest: input.templateDigest,
      templateFingerprint: input.templateFingerprint,
      maxDynamicNodes: input.maxDynamicNodes,
      sequence: priorManifests.length,
      alreadyExpandedNodes: priorManifests.reduce((sum, entry) => sum + entry.items.length, 0),
      reservedNodeIds: reserved
    });
    // Validate the complete candidate set in memory first: a manifest that would make the set
    // invalid must never reach durable storage, otherwise every automatic resume keeps failing
    // until an operator removes or repairs the published file by hand.
    const candidateSet = [...priorManifests, manifest];
    validateManifestSet(candidateSet, manifestDir);
    assertManifestSetMatchesInput(candidateSet, {
      runId: input.runId,
      maxDynamicNodes: input.maxDynamicNodes,
      reservedNodeIds: input.reservedNodeIds
    });
    publishFileDurableExclusive(manifestDir, `${input.groupNodeId}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    const publishedManifests = readExpansionManifests(manifestDir);
    assertManifestSetMatchesInput(publishedManifests, {
      runId: input.runId,
      maxDynamicNodes: input.maxDynamicNodes,
      reservedNodeIds: input.reservedNodeIds
    });
    const published = publishedManifests.find((candidate) => candidate.group_node_id === input.groupNodeId);
    if (published === undefined || !fs.existsSync(manifestPath)) {
      throw dynamicError("DYNAMIC_MANIFEST_PUBLISH_FAILED", "Dynamic expansion manifest publication failed", {
        groupNodeId: input.groupNodeId
      });
    }
    return published;
  });
}

/**
 * Withdraw one complete expansion generation before an explicit source retry.
 *
 * Smithers resets the producer and all of its dependents, but the expansion
 * manifests live outside Smithers state. Leaving them active makes the next
 * workflow render require the canonical source artifact during the gap between
 * producer completion and verifier publication. A whole-set rename keeps the
 * old generation durable and prevents a partially rewritten manifest set.
 */
export function archiveDynamicExpansionsForRetry(input: {
  runRoot: string;
  sourceNodeIds?: readonly string[];
  requireMissingSources?: boolean;
}): DynamicExpansionRetryArchive | undefined {
  const runRoot = path.resolve(input.runRoot);
  const manifestDir = path.join(runRoot, "dynamic-expansions");
  assertPathInside(runRoot, manifestDir, "dynamic expansion manifest directory");
  if (!fs.existsSync(manifestDir)) return undefined;
  assertNoSymlinkComponents(runRoot, manifestDir, "dynamic expansion manifest directory");
  const manifestStat = fs.lstatSync(manifestDir);
  if (!manifestStat.isDirectory() || manifestStat.isSymbolicLink()) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion manifest root is not a directory", {
      manifestDir
    });
  }
  const manifests = readExpansionManifests(manifestDir);
  if (manifests.length === 0) return undefined;

  const sourceNodeIds = new Set(
    (input.sourceNodeIds ?? []).flatMap((nodeId) => [nodeId, nodeId.startsWith("node:") ? nodeId.slice(5) : nodeId])
  );
  const matches = (manifest: DynamicExpansionManifest): boolean => {
    if (
      sourceNodeIds.has(manifest.source.node_id) ||
      sourceNodeIds.has(manifest.source.attempt_id) ||
      sourceNodeIds.has(`node:${manifest.source.node_id}`) ||
      sourceNodeIds.has(`node:${manifest.source.attempt_id}`)
    ) {
      return true;
    }
    if (input.requireMissingSources !== true) return false;
    const sourcePath = path.join(runRoot, manifest.source.artifact_path);
    assertPathInside(runRoot, sourcePath, "dynamic source artifact");
    assertNoSymlinkComponents(runRoot, sourcePath, "dynamic source artifact");
    return !fs.existsSync(sourcePath);
  };
  const matched = manifests.filter(matches);
  if (matched.length === 0) return undefined;
  if (matched.length !== manifests.length) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_AMBIGUOUS",
      "Dynamic source retry cannot withdraw only part of the published expansion generation",
      {
        matchedGroupNodeIds: matched.map((manifest) => manifest.group_node_id),
        retainedGroupNodeIds: manifests
          .filter((manifest) => !matches(manifest))
          .map((manifest) => manifest.group_node_id)
      }
    );
  }

  const expectedEntries = new Set(manifests.map((manifest) => `${manifest.group_node_id}.json`));
  const unexpectedEntries = fs.readdirSync(manifestDir).filter((entry) => !expectedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic expansion manifest root contains unrecognized retry state",
      { unexpectedEntries }
    );
  }

  const archiveRoot = path.join(runRoot, "dynamic-expansion-history");
  assertPathInside(runRoot, archiveRoot, "dynamic expansion history");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, archiveRoot, "dynamic expansion history");
  const archivedAt = new Date().toISOString();
  const archiveDir = path.join(archiveRoot, `${archivedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
  assertPathInside(runRoot, archiveDir, "dynamic expansion retry archive");
  fs.renameSync(manifestDir, archiveDir);
  fs.mkdirSync(manifestDir, { mode: manifestStat.mode & 0o777 });
  publishFileDurableExclusive(
    archiveDir,
    "retry.json",
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.dynamic-expansion-retry.v1",
        archived_at: archivedAt,
        source_node_ids: [...sourceNodeIds].sort(),
        group_node_ids: manifests.map((manifest) => manifest.group_node_id)
      },
      null,
      2
    )}\n`
  );
  fsyncDirectory(manifestDir);
  fsyncDirectory(archiveRoot);
  fsyncDirectory(runRoot);
  return {
    archive_path: archiveDir,
    group_node_ids: manifests.map((manifest) => manifest.group_node_id)
  };
}

export function dynamicStorageId(groupNodeId: string, generatedNodeId: string): string {
  const slug = groupNodeId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 40);
  const digest = crypto.createHash("sha256").update(generatedNodeId).digest("hex").slice(0, 32);
  return `dynamic-${slug}-${digest}`;
}

export function dynamicItemVariables(item: Record<string, unknown>): Record<string, string | number | boolean> {
  const variables: Record<string, string | number | boolean> = {};
  flattenItemVariables(item, "item", variables, new Set());
  const replacements = item.replacements;
  if (replacements !== undefined) {
    if (!isPlainRecord(replacements)) {
      throw dynamicError("DYNAMIC_REPLACEMENTS_INVALID", "Dynamic item replacements must be an object");
    }
    for (const [name, value] of Object.entries(replacements)) {
      if (!isNamespacedDynamicReplacementKey(name)) {
        throw dynamicError("DYNAMIC_REPLACEMENT_KEY_INVALID", `Invalid namespaced replacement key ${name}`, { name });
      }
      if (!isScalar(value)) {
        throw dynamicError("DYNAMIC_REPLACEMENT_VALUE_INVALID", `Replacement ${name} must be scalar`, { name });
      }
      if (variables[name] !== undefined) {
        throw dynamicError("DYNAMIC_REPLACEMENT_COLLISION", `Replacement ${name} collides with an item variable`, {
          name
        });
      }
      variables[name] = value;
    }
  }
  return Object.fromEntries(Object.entries(variables).sort(([left], [right]) => left.localeCompare(right)));
}

function flattenItemVariables(
  value: Record<string, unknown>,
  prefix: string,
  target: Record<string, string | number | boolean>,
  seen: Set<object>
): void {
  if (seen.has(value)) throw dynamicError("DYNAMIC_ITEM_CYCLIC", "Dynamic item must be JSON-serializable");
  seen.add(value);
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (key === "replacements") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) {
      throw dynamicError(
        "DYNAMIC_ITEM_FIELD_INVALID",
        `Dynamic item field segment ${JSON.stringify(key)} cannot be used in templates`,
        { key, prefix }
      );
    }
    const name = `${prefix}.${key}`;
    if (isScalar(entry)) {
      if (!isDynamicItemTemplateVariable(name)) {
        throw dynamicError("DYNAMIC_ITEM_FIELD_INVALID", `Dynamic item field ${name} cannot be used in templates`, {
          name
        });
      }
      target[name] = entry;
    } else if (isPlainRecord(entry)) {
      flattenItemVariables(entry, name, target, seen);
    }
  }
  seen.delete(value);
}

function renderDynamicNodeId(template: string, item: Record<string, unknown>): string {
  return template.replace(/\{\{\s*item\.([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/gu, (_match, itemPath: string) => {
    const value = resolveItemPath(item, itemPath);
    if (!isScalar(value)) {
      throw dynamicError("DYNAMIC_NODE_ID_VALUE_INVALID", `Node ID field item.${itemPath} must be scalar`, {
        itemPath
      });
    }
    return String(value);
  });
}

function resolveJsonPath(document: unknown, jsonPath: string): unknown {
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(jsonPath)) {
    throw dynamicError("DYNAMIC_PATH_INVALID", `Unsupported dynamic JSONPath ${jsonPath}`, { jsonPath });
  }
  if (jsonPath === "$") return document;
  let current = document;
  for (const segment of jsonPath.slice(2).split(".")) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
      throw dynamicError("DYNAMIC_PATH_MISSING", `Dynamic JSONPath ${jsonPath} is missing ${segment}`, {
        jsonPath,
        segment
      });
    }
    current = current[segment];
  }
  return current;
}

function resolveItemPath(item: Record<string, unknown>, itemPath: string): unknown {
  let current: unknown = item;
  for (const segment of itemPath.split(".")) {
    if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function readExpansionManifests(directory: string): DynamicExpansionManifest[] {
  const manifestEntries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(entry.name));
  for (const entry of manifestEntries) {
    const manifestPath = path.join(directory, entry.name);
    const stat = fs.lstatSync(manifestPath);
    if (entry.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile()) {
      throw dynamicError("DYNAMIC_MANIFEST_INVALID", "Dynamic expansion manifest must be a regular file", {
        filePath: manifestPath
      });
    }
  }
  const manifests = manifestEntries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readManifest(path.join(directory, entry.name), entry.name.slice(0, -".json".length)))
    .filter((entry): entry is DynamicExpansionManifest => entry !== undefined);
  validateManifestSet(manifests, directory);
  return manifests;
}

function readManifest(filePath: string, expectedGroupNodeId?: string): DynamicExpansionManifest | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw dynamicError("DYNAMIC_MANIFEST_INVALID", `Invalid dynamic expansion manifest ${filePath}`, {
      filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  return validateDynamicExpansionManifest(value, { filePath, expectedGroupNodeId });
}

export function validateDynamicExpansionManifest(
  value: unknown,
  options: { filePath?: string; expectedGroupNodeId?: string } = {}
): DynamicExpansionManifest {
  const fail = (reason: string, details: Record<string, unknown> = {}): never => {
    throw dynamicError("DYNAMIC_MANIFEST_INVALID", `Invalid dynamic expansion manifest: ${reason}`, {
      ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
      ...details
    });
  };
  if (!isPlainRecord(value)) return fail("document must be an object");
  const document = value;
  assertExactKeys(
    document,
    [
      "schema_version",
      "run_id",
      "group_node_id",
      "source",
      "template",
      "max_dynamic_nodes",
      "dynamic_nodes_before",
      "dynamic_nodes_after",
      "items"
    ],
    "document",
    fail,
    ["sequence"]
  );
  if (document.schema_version !== DYNAMIC_EXPANSION_SCHEMA_VERSION) fail("schema_version is unsupported");
  if (typeof document.run_id !== "string") fail("run_id must be a string");
  if (typeof document.group_node_id !== "string") fail("group_node_id must be a string");
  const runId = document.run_id as string;
  const groupNodeId = document.group_node_id as string;
  try {
    validateSafeId(runId, "run ID");
    validateSafeId(groupNodeId, "dynamic group node ID");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (options.expectedGroupNodeId !== undefined && groupNodeId !== options.expectedGroupNodeId) {
    fail("group_node_id does not match its manifest filename", {
      expected: options.expectedGroupNodeId,
      actual: groupNodeId
    });
  }

  if (!isPlainRecord(document.source)) fail("source must be an object");
  const source = document.source as Record<string, unknown>;
  assertExactKeys(source, ["node_id", "attempt_id", "artifact_path", "output_sha256", "json_path"], "source", fail);
  const sourceNodeId = requiredString(source, "node_id", "source", fail);
  const sourceAttemptId = requiredString(source, "attempt_id", "source", fail);
  try {
    validateSafeId(sourceNodeId, "dynamic source node ID");
    validateSafeId(sourceAttemptId, "dynamic source attempt ID");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const artifactPath = requiredString(source, "artifact_path", "source", fail);
  validateManifestRelativePath(artifactPath, fail);
  const outputDigest = requiredString(source, "output_sha256", "source", fail);
  if (!isDigest(outputDigest)) fail("source.output_sha256 must be SHA-256");
  const sourcePath = requiredString(source, "json_path", "source", fail);
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(sourcePath)) fail("source.json_path is invalid");

  if (!isPlainRecord(document.template)) fail("template must be an object");
  const template = document.template as Record<string, unknown>;
  assertExactKeys(template, ["key_path", "node_id", "prompt_sha256", "fingerprint"], "template", fail);
  const keyPath = requiredString(template, "key_path", "template", fail);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(keyPath)) {
    fail("template.key_path is invalid");
  }
  const nodeIdTemplate = requiredString(template, "node_id", "template", fail);
  validateManifestNodeIdTemplate(nodeIdTemplate, keyPath, fail);
  const promptDigest = requiredString(template, "prompt_sha256", "template", fail);
  const fingerprint = requiredString(template, "fingerprint", "template", fail);
  if (!isDigest(promptDigest)) fail("template.prompt_sha256 must be SHA-256");
  if (!isDigest(fingerprint)) fail("template.fingerprint must be SHA-256");

  const maxDynamicNodes = nonNegativeIntegerField(document, "max_dynamic_nodes", fail);
  const sequence = document.sequence === undefined ? undefined : nonNegativeIntegerField(document, "sequence", fail);
  const before = nonNegativeIntegerField(document, "dynamic_nodes_before", fail);
  const after = nonNegativeIntegerField(document, "dynamic_nodes_after", fail);
  if (maxDynamicNodes < 1) fail("max_dynamic_nodes must be positive");
  if (!Array.isArray(document.items)) fail("items must be an array");
  const itemValues = document.items as unknown[];
  if (after !== before + itemValues.length) fail("dynamic node count arithmetic is inconsistent");
  if (after > maxDynamicNodes) fail("dynamic node count exceeds max_dynamic_nodes");

  const keys = new Set<string>();
  const nodeIds = new Set<string>();
  const storageIds = new Set<string>();
  const items = itemValues.map((candidate, index): DynamicExpansionItem => {
    if (!isPlainRecord(candidate)) fail(`items[${index}] must be an object`);
    const itemEntry = candidate as Record<string, unknown>;
    assertExactKeys(
      itemEntry,
      ["order", "key", "item", "item_sha256", "node_id", "storage_id", "variables"],
      `items[${index}]`,
      fail
    );
    if (itemEntry.order !== index) fail(`items[${index}].order must be contiguous and match array order`);
    if (typeof itemEntry.key !== "string" || itemEntry.key.length < 1 || itemEntry.key.length > 512) {
      fail(`items[${index}].key is invalid`);
    }
    const itemKey = itemEntry.key as string;
    if (keys.has(itemKey)) fail(`items[${index}].key is duplicated`);
    keys.add(itemKey);
    if (!isPlainRecord(itemEntry.item)) fail(`items[${index}].item must be an object`);
    const item = itemEntry.item as Record<string, unknown>;
    assertJsonValue(item, `items[${index}].item`, fail);
    const resolvedKey = resolveItemPath(item, keyPath);
    if (!isScalar(resolvedKey) || String(resolvedKey) !== itemKey) {
      fail(`items[${index}].key does not match template.key_path`);
    }
    if (typeof itemEntry.item_sha256 !== "string" || !isDigest(itemEntry.item_sha256)) {
      fail(`items[${index}].item_sha256 must be SHA-256`);
    }
    const itemDigest = itemEntry.item_sha256 as string;
    if (sha256Stable(item) !== itemDigest) fail(`items[${index}].item_sha256 is incorrect`);
    if (typeof itemEntry.node_id !== "string" || !DYNAMIC_NODE_ID_PATTERN.test(itemEntry.node_id)) {
      fail(`items[${index}].node_id is invalid`);
    }
    const nodeId = itemEntry.node_id as string;
    if (renderDynamicNodeId(nodeIdTemplate, item) !== nodeId) {
      fail(`items[${index}].node_id does not match template.node_id`);
    }
    if (nodeIds.has(nodeId) || storageIds.has(nodeId)) {
      fail(`items[${index}].node_id collides with another generated identity`);
    }
    nodeIds.add(nodeId);
    if (typeof itemEntry.storage_id !== "string") fail(`items[${index}].storage_id must be a string`);
    const storageId = itemEntry.storage_id as string;
    try {
      validateSafeId(storageId, `items[${index}] storage ID`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (storageId !== dynamicStorageId(groupNodeId, nodeId)) {
      fail(`items[${index}].storage_id is not deterministic`);
    }
    if (storageIds.has(storageId) || nodeIds.has(storageId)) {
      fail(`items[${index}].storage_id collides with another generated identity`);
    }
    storageIds.add(storageId);
    if (!isPlainRecord(itemEntry.variables)) fail(`items[${index}].variables must be an object`);
    const variables = itemEntry.variables as Record<string, unknown>;
    for (const [name, variable] of Object.entries(variables)) {
      if (!isDynamicItemTemplateVariable(name) || !isScalar(variable)) {
        fail(`items[${index}].variables contains invalid value ${name}`);
      }
    }
    const expectedVariables = dynamicItemVariables(item);
    if (stableJson(variables) !== stableJson(expectedVariables)) {
      fail(`items[${index}].variables do not match the canonical item variables`);
    }
    return {
      order: index,
      key: itemKey,
      item: canonicalClone(item),
      item_sha256: itemDigest,
      node_id: nodeId,
      storage_id: storageId,
      variables: expectedVariables
    };
  });

  return {
    schema_version: DYNAMIC_EXPANSION_SCHEMA_VERSION,
    run_id: runId,
    group_node_id: groupNodeId,
    source: {
      node_id: sourceNodeId,
      attempt_id: sourceAttemptId,
      artifact_path: artifactPath,
      output_sha256: outputDigest,
      json_path: sourcePath
    },
    template: {
      key_path: keyPath,
      node_id: nodeIdTemplate,
      prompt_sha256: promptDigest,
      fingerprint
    },
    max_dynamic_nodes: maxDynamicNodes,
    ...(sequence === undefined ? {} : { sequence }),
    dynamic_nodes_before: before,
    dynamic_nodes_after: after,
    items
  };
}

function validateManifestSet(manifests: readonly DynamicExpansionManifest[], directory: string): void {
  const groupIds = new Set<string>();
  const nodeIds = new Set<string>();
  const storageIds = new Set<string>();
  const sequences = new Set<number>();
  let expectedBefore = 0;
  let expectedSequence = 0;
  let runId: string | undefined;
  let maxDynamicNodes: number | undefined;
  // A set published before `sequence` existed keeps a count-based ordering so an in-flight run
  // still resumes; every newly published set carries an explicit publication order. The fallback
  // orders zero-length transitions (before === after) ahead of expanding ones at the same count,
  // otherwise a legacy empty expansion published before a non-empty one can never validate.
  const sequenced = manifests.every((manifest) => manifest.sequence !== undefined);
  const ordered = sequenced
    ? [...manifests].sort((left, right) => left.sequence! - right.sequence!)
    : [...manifests].sort(
        (left, right) =>
          left.dynamic_nodes_before - right.dynamic_nodes_before ||
          left.dynamic_nodes_after - right.dynamic_nodes_after ||
          left.group_node_id.localeCompare(right.group_node_id)
      );
  for (const manifest of ordered) {
    if (sequenced) {
      const sequence = manifest.sequence!;
      if (sequences.has(sequence)) {
        throw dynamicError(
          "DYNAMIC_MANIFEST_SET_INVALID",
          "Dynamic expansion manifests repeat a publication sequence",
          { directory, groupNodeId: manifest.group_node_id, sequence }
        );
      }
      sequences.add(sequence);
      if (sequence !== expectedSequence) {
        throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifest sequence is not contiguous", {
          directory,
          groupNodeId: manifest.group_node_id,
          expectedSequence,
          actualSequence: sequence
        });
      }
      expectedSequence += 1;
    }
    if (groupIds.has(manifest.group_node_id)) {
      throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifests repeat a group", {
        directory,
        groupNodeId: manifest.group_node_id
      });
    }
    groupIds.add(manifest.group_node_id);
    runId ??= manifest.run_id;
    maxDynamicNodes ??= manifest.max_dynamic_nodes;
    if (manifest.run_id !== runId || manifest.max_dynamic_nodes !== maxDynamicNodes) {
      throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifests disagree on run or limit", {
        directory,
        groupNodeId: manifest.group_node_id
      });
    }
    if (manifest.dynamic_nodes_before !== expectedBefore) {
      throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifest counts are not contiguous", {
        directory,
        groupNodeId: manifest.group_node_id,
        expectedBefore,
        actualBefore: manifest.dynamic_nodes_before
      });
    }
    expectedBefore = manifest.dynamic_nodes_after;
    for (const item of manifest.items) {
      if (
        nodeIds.has(item.node_id) ||
        storageIds.has(item.node_id) ||
        nodeIds.has(item.storage_id) ||
        storageIds.has(item.storage_id)
      ) {
        throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifests collide globally", {
          directory,
          groupNodeId: manifest.group_node_id,
          nodeId: item.node_id,
          storageId: item.storage_id
        });
      }
      nodeIds.add(item.node_id);
      storageIds.add(item.storage_id);
    }
  }
}

function assertManifestSetMatchesInput(
  manifests: readonly DynamicExpansionManifest[],
  input: { runId: string; maxDynamicNodes: number; reservedNodeIds?: Iterable<string> }
): void {
  validateSafeId(input.runId, "run ID");
  const reserved = new Set(input.reservedNodeIds ?? []);
  for (const manifest of manifests) {
    if (manifest.run_id !== input.runId || manifest.max_dynamic_nodes !== input.maxDynamicNodes) {
      throw dynamicError("DYNAMIC_MANIFEST_SET_INVALID", "Dynamic expansion manifest belongs to another run or limit", {
        groupNodeId: manifest.group_node_id,
        expectedRunId: input.runId,
        actualRunId: manifest.run_id,
        expectedMax: input.maxDynamicNodes,
        actualMax: manifest.max_dynamic_nodes
      });
    }
    for (const item of manifest.items) {
      if (reserved.has(item.node_id) || reserved.has(item.storage_id)) {
        const collidingId = reserved.has(item.node_id) ? item.node_id : item.storage_id;
        throw dynamicError("DYNAMIC_NODE_ID_COLLISION", `Generated ID ${collidingId} collides with static graph`, {
          groupNodeId: manifest.group_node_id,
          nodeId: item.node_id,
          storageId: item.storage_id
        });
      }
    }
  }
}

function withDynamicExpansionLock<T>(manifestDir: string, operation: () => T): T {
  const lockPath = path.join(manifestDir, ".expansion.lock");
  const deadline = Date.now() + 5_000;
  const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${token}\n`, "utf8");
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(lockPath);
      } catch (statError) {
        // The holder may release between our exclusive-create failure and the
        // inspection. That is ordinary lock contention, not a run failure.
        if (isNoEntryError(statError)) continue;
        throw statError;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw dynamicError("DYNAMIC_EXPANSION_LOCK_INVALID", "Dynamic expansion lock is unsafe", { lockPath });
      }
      // Never steal a lock based on age. Between an age check and unlink, the
      // observed inode can disappear and a new owner can publish a fresh lock
      // at the same path. Only the token-owning holder releases the lock;
      // contenders fail after the bounded wait and leave recovery explicit.
      if (Date.now() >= deadline) {
        throw dynamicError("DYNAMIC_EXPANSION_LOCKED", "Dynamic expansion is already being materialized", {
          lockPath
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(lockPath, "utf8").trim() === token) fs.unlinkSync(lockPath);
    } catch {
      // A missing lock after the operation cannot weaken manifest validation.
    }
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

type ManifestFailure = (reason: string, details?: Record<string, unknown>) => never;

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
  fail: ManifestFailure,
  optionalKeys: readonly string[] = []
): void {
  const allowed = new Set([...keys, ...optionalKeys]);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !(key in value));
  const unknown = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(`${context} has invalid fields`, { missing, unknown });
  }
}

function requiredString(value: Record<string, unknown>, field: string, context: string, fail: ManifestFailure): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) fail(`${context}.${field} must be a non-empty string`);
  return candidate as string;
}

function nonNegativeIntegerField(value: Record<string, unknown>, field: string, fail: ManifestFailure): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    fail(`${field} must be a non-negative safe integer`);
  }
  return candidate as number;
}

function validateManifestRelativePath(value: string, fail: ManifestFailure): void {
  const parts = value.split("/");
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail("source.artifact_path must be traversal-free and relative");
  }
}

function validateManifestNodeIdTemplate(template: string, keyPath: string, fail: ManifestFailure): void {
  if (template.length === 0 || template.length > 256 || template.includes("/") || template.includes("\\")) {
    fail("template.node_id is unsafe");
  }
  const placeholders = [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)].map((match) => match[1]!.trim());
  if (placeholders.length === 0 || !placeholders.includes(`item.${keyPath}`)) {
    fail("template.node_id must contain the configured key field");
  }
  if (
    placeholders.some(
      (placeholder) => !/^item\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u.test(placeholder)
    )
  ) {
    fail("template.node_id contains an invalid placeholder");
  }
  const literal = template.replace(/\{\{\s*[^{}]+?\s*\}\}/gu, "");
  if (!/^[a-z0-9:_-]*$/u.test(literal) || literal.includes("{{") || literal.includes("}}")) {
    fail("template.node_id contains invalid literals");
  }
}

function assertJsonValue(value: unknown, context: string, fail: ManifestFailure, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${context} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") fail(`${context} contains a non-JSON value`);
  const object = value as object;
  if (seen.has(object)) fail(`${context} is cyclic`);
  seen.add(object);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${context}[${index}]`, fail, seen));
  } else if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${context}.${key}`, fail, seen);
  } else {
    fail(`${context} contains a non-plain object`);
  }
  seen.delete(object);
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function assertCompatibleManifest(
  manifest: DynamicExpansionManifest,
  expected: {
    runId: string;
    groupNodeId: string;
    sourceNodeId: string;
    sourceAttemptId: string;
    sourceArtifactPath: string;
    sourceDigest: string;
    templateDigest: string;
    templateFingerprint: string;
    sourcePath: string;
    keyPath: string;
    nodeIdTemplate: string;
    maxDynamicNodes: number;
  }
): void {
  const conflicts = [
    ["run ID", manifest.run_id, expected.runId],
    ["group node ID", manifest.group_node_id, expected.groupNodeId],
    ["source node ID", manifest.source.node_id, expected.sourceNodeId],
    ["source attempt ID", manifest.source.attempt_id, expected.sourceAttemptId],
    ["source artifact", manifest.source.artifact_path, expected.sourceArtifactPath],
    ["source output", manifest.source.output_sha256, expected.sourceDigest],
    ["source path", manifest.source.json_path, expected.sourcePath],
    ["key path", manifest.template.key_path, expected.keyPath],
    ["node ID template", manifest.template.node_id, expected.nodeIdTemplate],
    ["prompt template", manifest.template.prompt_sha256, expected.templateDigest],
    ["template fingerprint", manifest.template.fingerprint, expected.templateFingerprint],
    ["dynamic node limit", manifest.max_dynamic_nodes, expected.maxDynamicNodes]
  ].filter(([, actual, wanted]) => actual !== wanted);
  if (conflicts.length > 0) {
    throw dynamicError("DYNAMIC_EXPANSION_CHANGED", "Persisted dynamic expansion is incompatible with current inputs", {
      conflicts: conflicts.map(([field, actual, wanted]) => ({ field, actual, expected: wanted }))
    });
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw dynamicError("DYNAMIC_DIGEST_INVALID", `${label} must be SHA-256`);
}

function sha256Bytes(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function dynamicError(code: string, message: string, details: Record<string, unknown> = {}): DynamicExpansionError {
  return new DynamicExpansionError(code, message, details);
}
