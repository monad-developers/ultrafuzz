import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";

import {
  artifactSchemaRegistry,
  readRegularFileSnapshot,
  schemaRegistryBundleDigest,
  type SchemaRegistryEntry,
  VALIDATOR_BUILD_IDENTITY
} from "./schema-registry.js";
import { parseStrictJsonBytes, StrictJsonError } from "./strict-json.js";

const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_INSTANCE_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_SCHEMAS = 64;
const MAX_PATTERN_COUNT = 256;
const MAX_PATTERN_LENGTH = 1_024;
const MAX_SCHEMA_ID_LENGTH = 4_096;
const MAX_SCHEMA_REFERENCE_LENGTH = 4_096;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_CODE_BYTES = 128;
const MAX_DIAGNOSTIC_PATH_BYTES = 8 * 1024;
const MAX_DIAGNOSTIC_KEYWORD_BYTES = 256;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 8 * 1024;
const DEFAULT_DEADLINE_MS = 5_000;

export interface ValidateJsonFileOptions {
  schemaPath: string;
  filePath: string;
  refPaths?: readonly string[];
  maxErrors?: number;
  deadlineMs?: number;
  /** Trusted schemas made available to the isolated validator worker. */
  schemaRegistry?: readonly SchemaRegistryEntry[];
  /** Identity to persist for the registry that owns the selected schema. */
  schemaBundleSha256?: string;
}

export interface ValidateRegisteredJsonFileOptions {
  schemaPath: string;
  filePath: string;
  maxErrors?: number;
  deadlineMs?: number;
  schemaRegistry?: readonly SchemaRegistryEntry[];
  schemaBundleSha256?: string;
}

export interface ValidateRegisteredJsonBytesOptions {
  schemaPath: string;
  instanceBytes: Uint8Array;
  maxErrors?: number;
  deadlineMs?: number;
  schemaRegistry?: readonly SchemaRegistryEntry[];
  schemaBundleSha256?: string;
}

export type JsonFileValidationStatus = "instance-error" | "setup-error" | "valid";

export interface JsonFileValidationDiagnostic {
  code: string;
  message: string;
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
}

export interface JsonFileValidationResult {
  status: JsonFileValidationStatus;
  diagnostics: JsonFileValidationDiagnostic[];
  schema: {
    id: string | null;
    sha256: string;
    bundle_sha256: string;
    validator_build: string;
    registered: boolean;
  } | null;
  artifact_sha256: string | null;
  truncated: boolean;
}

interface ExternalSchemaSnapshot {
  filePath: string;
  schema: Record<string, unknown>;
}

interface RegisteredSchemaSnapshot {
  id: string;
  schema: Readonly<Record<string, unknown>>;
}

interface WorkerRequest {
  instanceBytes: Uint8Array;
  registeredSchemaId?: string;
  registeredSchemas?: RegisteredSchemaSnapshot[];
  externalRootPath?: string;
  externalSchemas?: ExternalSchemaSnapshot[];
  maxErrors: number;
}

interface SyncWorkerRequest extends WorkerRequest {
  responsePort: MessagePort;
}

export async function validateJsonFile(options: ValidateJsonFileOptions): Promise<JsonFileValidationResult> {
  try {
    return await validateJsonFileUnchecked(options);
  } catch {
    return internalFailure();
  }
}

async function validateJsonFileUnchecked(options: ValidateJsonFileOptions): Promise<JsonFileValidationResult> {
  const schemaPath = path.resolve(options.schemaPath);
  const filePath = path.resolve(options.filePath);
  const maxErrors = Math.min(Math.max(options.maxErrors ?? 50, 1), 1_000);

  let instanceBytes: Buffer;
  try {
    instanceBytes = readRegularFileSnapshot(filePath, MAX_INSTANCE_BYTES);
  } catch (error) {
    return failure("instance-error", "JSON_INSTANCE_UNREADABLE", errorMessage(error));
  }

  let schemaBytes: Buffer;
  try {
    schemaBytes = readRegularFileSnapshot(schemaPath, MAX_SCHEMA_BYTES);
  } catch (error) {
    return failure("setup-error", "JSON_SCHEMA_UNREADABLE", errorMessage(error));
  }

  let registry: readonly SchemaRegistryEntry[];
  let schemaBundleSha256: string;
  try {
    registry = options.schemaRegistry ?? artifactSchemaRegistry();
    assertUnambiguousRegistry(registry);
    schemaBundleSha256 = options.schemaBundleSha256 ?? schemaRegistryBundleDigest(registry);
    if (!/^[0-9a-f]{64}$/u.test(schemaBundleSha256)) {
      throw new Error("schema bundle identity must be a lowercase SHA-256 digest");
    }
  } catch (error) {
    return failure("setup-error", "JSON_SCHEMA_REGISTRY_INVALID", errorMessage(error));
  }
  const registeredSchemas = registry.map((entry) => ({ id: entry.id, schema: entry.schema }));
  const filenameRegistration = registry.find((entry) => entry.filename === path.basename(schemaPath));
  const schemaSha256 = sha256(schemaBytes);
  const digestRegistration = registry.find((entry) => entry.sha256 === schemaSha256);
  let request: WorkerRequest;
  let schemaId: string | null;
  let registered = false;
  if (filenameRegistration !== undefined || digestRegistration !== undefined) {
    if (filenameRegistration !== undefined && filenameRegistration.sha256 !== schemaSha256) {
      return failure(
        "setup-error",
        "JSON_SCHEMA_DIGEST_MISMATCH",
        `Registered schema ${filenameRegistration.filename} does not match its pinned digest`
      );
    }
    const registration = digestRegistration ?? filenameRegistration!;
    schemaId = registration.id;
    registered = true;
    request = { instanceBytes, registeredSchemaId: schemaId, registeredSchemas, maxErrors };
  } else {
    const prepared = prepareExternalSchemas(schemaPath, schemaBytes, options.refPaths ?? [], registry);
    if ("failure" in prepared) return prepared.failure;
    schemaId = typeof prepared.root.schema.$id === "string" ? prepared.root.schema.$id : null;
    request = {
      instanceBytes,
      registeredSchemas,
      externalRootPath: prepared.root.filePath,
      externalSchemas: prepared.schemas,
      maxErrors
    };
  }

  const workerResult = await runValidationWorker(request, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  return boundValidationResult({
    ...workerResult,
    schema: {
      id: schemaId,
      sha256: schemaSha256,
      bundle_sha256: schemaBundleSha256,
      validator_build: VALIDATOR_BUILD_IDENTITY,
      registered
    },
    artifact_sha256: sha256(instanceBytes)
  });
}

/**
 * Host-side shape validation for a bundled contract. It uses the same isolated worker,
 * resource limits, schema bytes, parser, and diagnostics as the producer-facing CLI,
 * while preserving the runtime's synchronous artifact-gate API.
 */
export function validateRegisteredJsonFileSync(options: ValidateRegisteredJsonFileOptions): JsonFileValidationResult {
  try {
    return validateRegisteredJsonFileSyncUnchecked(options);
  } catch {
    return internalFailure();
  }
}

function validateRegisteredJsonFileSyncUnchecked(options: ValidateRegisteredJsonFileOptions): JsonFileValidationResult {
  const filePath = path.resolve(options.filePath);
  let instanceBytes: Buffer;
  try {
    instanceBytes = readRegularFileSnapshot(filePath, MAX_INSTANCE_BYTES);
  } catch (error) {
    return failure("instance-error", "JSON_INSTANCE_UNREADABLE", errorMessage(error));
  }
  return validateRegisteredJsonBytesSync({
    schemaPath: options.schemaPath,
    instanceBytes,
    ...(options.maxErrors === undefined ? {} : { maxErrors: options.maxErrors }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.schemaRegistry === undefined ? {} : { schemaRegistry: options.schemaRegistry }),
    ...(options.schemaBundleSha256 === undefined ? {} : { schemaBundleSha256: options.schemaBundleSha256 })
  });
}

/** Validate one already-captured immutable instance snapshot with the host worker. */
export function validateRegisteredJsonBytesSync(options: ValidateRegisteredJsonBytesOptions): JsonFileValidationResult {
  try {
    return validateRegisteredJsonBytesSyncUnchecked(options);
  } catch {
    return internalFailure();
  }
}

function validateRegisteredJsonBytesSyncUnchecked(
  options: ValidateRegisteredJsonBytesOptions
): JsonFileValidationResult {
  const schemaPath = path.resolve(options.schemaPath);
  const instanceBytes = Buffer.from(options.instanceBytes);
  if (instanceBytes.byteLength > MAX_INSTANCE_BYTES) {
    return failure(
      "instance-error",
      "JSON_INSTANCE_UNREADABLE",
      `JSON instance exceeds the ${MAX_INSTANCE_BYTES}-byte limit`
    );
  }
  let schemaBytes: Buffer;
  try {
    schemaBytes = readRegularFileSnapshot(schemaPath, MAX_SCHEMA_BYTES);
  } catch (error) {
    return failure("setup-error", "JSON_SCHEMA_UNREADABLE", errorMessage(error));
  }
  let registry: readonly SchemaRegistryEntry[];
  let schemaBundleSha256: string;
  try {
    registry = options.schemaRegistry ?? artifactSchemaRegistry();
    assertUnambiguousRegistry(registry);
    schemaBundleSha256 = options.schemaBundleSha256 ?? schemaRegistryBundleDigest(registry);
    if (!/^[0-9a-f]{64}$/u.test(schemaBundleSha256)) {
      throw new Error("schema bundle identity must be a lowercase SHA-256 digest");
    }
  } catch (error) {
    return failure("setup-error", "JSON_SCHEMA_REGISTRY_INVALID", errorMessage(error));
  }
  const schemaSha256 = sha256(schemaBytes);
  const filenameRegistration = registry.find((entry) => entry.filename === path.basename(schemaPath));
  if (filenameRegistration !== undefined && filenameRegistration.sha256 !== schemaSha256) {
    return failure(
      "setup-error",
      "JSON_SCHEMA_DIGEST_MISMATCH",
      `Registered schema ${filenameRegistration.filename} does not match its pinned digest`
    );
  }
  const registration = registry.find((entry) => entry.sha256 === schemaSha256);
  if (registration === undefined) {
    return failure(
      "setup-error",
      "JSON_SCHEMA_DIGEST_MISMATCH",
      `Host schema does not match any pinned registry digest: ${path.basename(schemaPath)}`
    );
  }
  const workerResult = runValidationWorkerSync(
    {
      instanceBytes,
      registeredSchemaId: registration.id,
      registeredSchemas: registry.map((entry) => ({ id: entry.id, schema: entry.schema })),
      maxErrors: Math.min(Math.max(options.maxErrors ?? 50, 1), 1_000)
    },
    options.deadlineMs ?? DEFAULT_DEADLINE_MS
  );
  return boundValidationResult({
    ...workerResult,
    schema: {
      id: registration.id,
      sha256: registration.sha256,
      bundle_sha256: schemaBundleSha256,
      validator_build: VALIDATOR_BUILD_IDENTITY,
      registered: true
    },
    artifact_sha256: sha256(instanceBytes)
  });
}

function prepareExternalSchemas(
  rootPath: string,
  rootBytes: Buffer,
  explicitRefPaths: readonly string[],
  registry: readonly SchemaRegistryEntry[]
): { root: ExternalSchemaSnapshot; schemas: ExternalSchemaSnapshot[] } | { failure: JsonFileValidationResult } {
  try {
    const allowedRoots = new Set<string>([fs.realpathSync(path.dirname(rootPath))]);
    const explicit = explicitRefPaths.map((refPath) => path.resolve(refPath));
    for (const refPath of explicit) allowedRoots.add(fs.realpathSync(path.dirname(refPath)));
    const byPath = new Map<string, ExternalSchemaSnapshot>();
    const byRequestedPath = new Map<string, ExternalSchemaSnapshot>();
    let totalBytes = 0;
    let totalPatterns = 0;

    const load = (filePath: string, supplied?: Buffer, requireId = true): ExternalSchemaSnapshot => {
      const requestedPath = path.resolve(filePath);
      const requested = byRequestedPath.get(requestedPath);
      if (requested !== undefined) return requested;
      if (byRequestedPath.size >= MAX_EXTERNAL_SCHEMAS) {
        throw new Error(`schema bundle exceeds the ${MAX_EXTERNAL_SCHEMAS}-reference-path limit`);
      }
      const bytes = supplied ?? readRegularFileSnapshot(filePath, MAX_SCHEMA_BYTES);
      const realPath = fs.realpathSync(filePath);
      if (!insideAnyRoot(realPath, allowedRoots))
        throw new Error(`schema reference escapes every allowed root: ${filePath}`);
      const existing = byPath.get(realPath);
      if (existing !== undefined) {
        byRequestedPath.set(requestedPath, existing);
        return existing;
      }
      if (byPath.size >= MAX_EXTERNAL_SCHEMAS) {
        throw new Error(`schema bundle exceeds the ${MAX_EXTERNAL_SCHEMAS}-schema limit`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SCHEMA_BUNDLE_BYTES) {
        throw new Error(`schema bundle exceeds the ${MAX_SCHEMA_BUNDLE_BYTES}-byte limit`);
      }
      const parsed = parseStrictJsonBytes(bytes, {
        maxBytes: MAX_SCHEMA_BYTES,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
      if (!isRecord(parsed)) throw new Error(`schema must be a JSON object: ${realPath}`);
      if (parsed.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`schema must declare Draft 2020-12: ${realPath}`);
      }
      if (requireId && (typeof parsed.$id !== "string" || parsed.$id.length === 0)) {
        throw new Error(`referenced schema must declare a non-empty $id: ${realPath}`);
      }
      if (typeof parsed.$id === "string" && parsed.$id.includes("#")) {
        throw new Error(`schema $id must not contain a fragment: ${realPath}`);
      }
      if (typeof parsed.$id === "string" && parsed.$id.length > MAX_SCHEMA_ID_LENGTH) {
        throw new Error(`schema $id exceeds the ${MAX_SCHEMA_ID_LENGTH}-character limit: ${realPath}`);
      }
      totalPatterns += enforcePatternLimits(parsed);
      if (totalPatterns > MAX_PATTERN_COUNT) {
        throw new Error(`schema bundle exceeds the ${MAX_PATTERN_COUNT}-pattern limit`);
      }
      const snapshot = { filePath: realPath, schema: parsed };
      byPath.set(realPath, snapshot);
      byRequestedPath.set(requestedPath, snapshot);
      return snapshot;
    };

    const root = load(rootPath, rootBytes, false);
    for (const refPath of explicit) load(refPath);
    const queue = [root, ...byPath.values()].filter((entry, index, entries) => entries.indexOf(entry) === index);
    let rootReferencedByAnotherSchema = false;
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      rewriteAndLoadReferences(current.schema, current.filePath, (relativePath) => {
        const loaded = load(relativePath);
        if (current.filePath !== root.filePath && loaded.filePath === root.filePath) {
          rootReferencedByAnotherSchema = true;
        }
        if (!queue.includes(loaded)) queue.push(loaded);
        return loaded.filePath;
      });
    }
    if (rootReferencedByAnotherSchema && typeof root.schema.$id !== "string") {
      throw new Error("an external root schema referenced by another schema must declare a non-empty $id");
    }

    const bundledIds = new Set(registry.map((entry) => entry.id));
    const externalIds = new Set<string>();
    for (const snapshot of byPath.values()) {
      const id = snapshot.schema.$id;
      if (typeof id !== "string") continue;
      if (bundledIds.has(id) || externalIds.has(id)) throw new Error(`duplicate schema $id: ${id}`);
      externalIds.add(id);
    }
    return { root, schemas: [...byPath.values()] };
  } catch (error) {
    const code = error instanceof StrictJsonError ? "JSON_SCHEMA_INVALID_JSON" : "JSON_SCHEMA_SETUP_ERROR";
    return { failure: failure("setup-error", code, errorMessage(error)) };
  }
}

function assertUnambiguousRegistry(registry: readonly SchemaRegistryEntry[]): void {
  const filenames = new Set<string>();
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const entry of registry) {
    if (filenames.has(entry.filename)) throw new Error(`duplicate registered schema filename: ${entry.filename}`);
    if (ids.has(entry.id)) throw new Error(`duplicate registered schema $id: ${entry.id}`);
    if (digests.has(entry.sha256)) throw new Error(`duplicate registered schema digest: ${entry.sha256}`);
    filenames.add(entry.filename);
    ids.add(entry.id);
    digests.add(entry.sha256);
  }
}

function rewriteAndLoadReferences(value: unknown, referringPath: string, load: (filePath: string) => string): void {
  if (Array.isArray(value)) {
    for (const entry of value) rewriteAndLoadReferences(entry, referringPath, load);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key !== "$ref" && key !== "$dynamicRef" && key !== "$recursiveRef") || typeof entry !== "string") {
      rewriteAndLoadReferences(entry, referringPath, load);
      continue;
    }
    if (entry.length > MAX_SCHEMA_REFERENCE_LENGTH) {
      throw new Error(`schema reference exceeds the ${MAX_SCHEMA_REFERENCE_LENGTH}-character limit`);
    }
    if (entry.startsWith("#") || /^urn:/iu.test(entry)) continue;
    const hashIndex = entry.indexOf("#");
    const relative = hashIndex === -1 ? entry : entry.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : entry.slice(hashIndex);
    if (relative.length === 0) continue;
    if (relative.includes("?")) throw new Error(`schema reference queries are forbidden: ${entry}`);
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      throw new Error(`schema reference contains invalid percent-encoding: ${entry}`);
    }
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(decoded)?.[1]?.toLowerCase();
    if (scheme === "http" || scheme === "https") {
      throw new Error(`HTTP(S) schema references are forbidden: ${entry}`);
    }
    if (
      scheme === "file" ||
      path.isAbsolute(decoded) ||
      path.win32.isAbsolute(decoded) ||
      /^[A-Za-z]:/u.test(decoded) ||
      decoded.includes("\\")
    ) {
      throw new Error(`absolute file schema references are forbidden: ${entry}`);
    }
    if (scheme !== undefined) throw new Error(`non-local schema reference scheme is forbidden: ${entry}`);
    const loadedPath = load(path.resolve(path.dirname(referringPath), decoded));
    value[key] = `${pathToFileURL(loadedPath).href}${fragment}`;
  }
}

function enforcePatternLimits(value: unknown): number {
  let count = 0;
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    } else if (isRecord(entry)) {
      for (const [key, item] of Object.entries(entry)) {
        if (key === "pattern" && typeof item === "string") {
          assertPattern(item);
        } else if (key === "patternProperties" && isRecord(item)) {
          for (const pattern of Object.keys(item)) assertPattern(pattern);
        }
        visit(item);
      }
    }
  };
  const assertPattern = (pattern: string): void => {
    count += 1;
    if (count > MAX_PATTERN_COUNT) throw new Error(`schema exceeds the ${MAX_PATTERN_COUNT}-pattern limit`);
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`schema pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit`);
    }
  };
  visit(value);
  return count;
}

function runValidationWorker(request: WorkerRequest, deadlineMs: number): Promise<JsonFileValidationResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./json-validation-worker.js", import.meta.url), {
      workerData: request,
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    });
    let settled = false;
    const settle = (result: JsonFileValidationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => {
        void worker.terminate();
        settle(
          failure("setup-error", "JSON_VALIDATION_TIMEOUT", "Schema compilation or validation exceeded its deadline")
        );
      },
      Math.max(250, Math.min(deadlineMs, 30_000))
    );
    timer.unref();
    worker.once("message", (message: JsonFileValidationResult) => settle(message));
    worker.once("error", (error) => settle(failure("setup-error", "JSON_VALIDATOR_WORKER_ERROR", errorMessage(error))));
    worker.once("exit", (code) => {
      if (code !== 0)
        settle(failure("setup-error", "JSON_VALIDATOR_WORKER_EXIT", `Validator worker exited with code ${code}`));
    });
  });
}

function runValidationWorkerSync(request: WorkerRequest, deadlineMs: number): JsonFileValidationResult {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./json-validation-worker.js", import.meta.url), {
    workerData: { ...request, responsePort: port2 } satisfies SyncWorkerRequest,
    transferList: [port2],
    resourceLimits: {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4
    }
  });
  const deadline = Date.now() + Math.max(250, Math.min(deadlineMs, 30_000));
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (Date.now() < deadline) {
    const received = receiveMessageOnPort(port1);
    if (received !== undefined) {
      void worker.terminate();
      port1.close();
      return received.message as JsonFileValidationResult;
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
  void worker.terminate();
  port1.close();
  return failure("setup-error", "JSON_VALIDATION_TIMEOUT", "Schema compilation or validation exceeded its deadline");
}

function failure(
  status: Exclude<JsonFileValidationStatus, "valid">,
  code: string,
  message: string
): JsonFileValidationResult {
  return boundValidationResult({
    status,
    diagnostics: [{ code, message }],
    schema: null,
    artifact_sha256: null,
    truncated: false
  });
}

function internalFailure(): JsonFileValidationResult {
  return failure("setup-error", "JSON_VALIDATOR_INTERNAL_ERROR", "The validator encountered an internal tool failure");
}

function boundValidationResult(result: JsonFileValidationResult): JsonFileValidationResult {
  const diagnostics: JsonFileValidationDiagnostic[] = [];
  let serializedBytes = 2;
  let contentTruncated = false;
  for (const diagnostic of result.diagnostics) {
    contentTruncated ||=
      Buffer.byteLength(diagnostic.code, "utf8") > MAX_DIAGNOSTIC_CODE_BYTES ||
      Buffer.byteLength(diagnostic.message, "utf8") > MAX_DIAGNOSTIC_MESSAGE_BYTES ||
      (diagnostic.instancePath !== undefined &&
        Buffer.byteLength(diagnostic.instancePath, "utf8") > MAX_DIAGNOSTIC_PATH_BYTES) ||
      (diagnostic.schemaPath !== undefined &&
        Buffer.byteLength(diagnostic.schemaPath, "utf8") > MAX_DIAGNOSTIC_PATH_BYTES) ||
      (diagnostic.keyword !== undefined &&
        Buffer.byteLength(diagnostic.keyword, "utf8") > MAX_DIAGNOSTIC_KEYWORD_BYTES);
    const bounded: JsonFileValidationDiagnostic = {
      code: truncateUtf8(diagnostic.code, MAX_DIAGNOSTIC_CODE_BYTES),
      message: truncateUtf8(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_BYTES),
      ...(diagnostic.instancePath === undefined
        ? {}
        : { instancePath: truncateUtf8(diagnostic.instancePath, MAX_DIAGNOSTIC_PATH_BYTES) }),
      ...(diagnostic.schemaPath === undefined
        ? {}
        : { schemaPath: truncateUtf8(diagnostic.schemaPath, MAX_DIAGNOSTIC_PATH_BYTES) }),
      ...(diagnostic.keyword === undefined
        ? {}
        : { keyword: truncateUtf8(diagnostic.keyword, MAX_DIAGNOSTIC_KEYWORD_BYTES) })
    };
    const bytes = Buffer.byteLength(JSON.stringify(bounded), "utf8") + (diagnostics.length === 0 ? 0 : 1);
    if (serializedBytes + bytes > MAX_DIAGNOSTIC_BYTES) break;
    diagnostics.push(bounded);
    serializedBytes += bytes;
  }
  if (diagnostics.length === 0 && result.status !== "valid") {
    diagnostics.push({
      code: "JSON_DIAGNOSTIC_TRUNCATED",
      message: "Validation failed, but the diagnostic exceeded the output limit"
    });
    contentTruncated = true;
  }
  return {
    ...result,
    diagnostics,
    truncated: result.truncated || contentTruncated || diagnostics.length < result.diagnostics.length
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const suffix = Buffer.from("…", "utf8");
  let end = Math.max(0, maxBytes - suffix.byteLength);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function insideAnyRoot(candidate: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
