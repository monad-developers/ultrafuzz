import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";

import {
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  readRegularFileSnapshot,
  VALIDATOR_BUILD_IDENTITY
} from "./schema-registry.js";
import { parseStrictJsonBytes, StrictJsonError } from "./strict-json.js";

const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_INSTANCE_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_SCHEMAS = 64;
const MAX_PATTERN_COUNT = 256;
const MAX_PATTERN_LENGTH = 1_024;
const DEFAULT_DEADLINE_MS = 5_000;

export interface ValidateJsonFileOptions {
  schemaPath: string;
  filePath: string;
  refPaths?: readonly string[];
  maxErrors?: number;
  deadlineMs?: number;
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

interface WorkerRequest {
  instanceBytes: Uint8Array;
  registeredSchemaId?: string;
  externalRootPath?: string;
  externalSchemas?: ExternalSchemaSnapshot[];
  maxErrors: number;
}

interface SyncWorkerRequest extends WorkerRequest {
  responsePort: MessagePort;
}

export async function validateJsonFile(options: ValidateJsonFileOptions): Promise<JsonFileValidationResult> {
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

  const registry = artifactSchemaRegistry();
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
    request = { instanceBytes, registeredSchemaId: schemaId, maxErrors };
  } else {
    const prepared = prepareExternalSchemas(schemaPath, schemaBytes, options.refPaths ?? []);
    if ("failure" in prepared) return prepared.failure;
    schemaId = typeof prepared.root.schema.$id === "string" ? prepared.root.schema.$id : null;
    request = {
      instanceBytes,
      externalRootPath: prepared.root.filePath,
      externalSchemas: prepared.schemas,
      maxErrors
    };
  }

  const workerResult = await runValidationWorker(request, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  return {
    ...workerResult,
    schema: {
      id: schemaId,
      sha256: schemaSha256,
      bundle_sha256: artifactSchemaBundleDigest(),
      validator_build: VALIDATOR_BUILD_IDENTITY,
      registered
    },
    artifact_sha256: sha256(instanceBytes)
  };
}

/**
 * Host-side shape validation for a bundled contract. It uses the same isolated worker,
 * resource limits, schema bytes, parser, and diagnostics as the producer-facing CLI,
 * while preserving the runtime's synchronous artifact-gate API.
 */
export function validateRegisteredJsonFileSync(options: {
  schemaPath: string;
  filePath: string;
  maxErrors?: number;
  deadlineMs?: number;
}): JsonFileValidationResult {
  const schemaPath = path.resolve(options.schemaPath);
  const filePath = path.resolve(options.filePath);
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
  const schemaSha256 = sha256(schemaBytes);
  const registration = artifactSchemaRegistry().find((entry) => entry.sha256 === schemaSha256);
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
      maxErrors: Math.min(Math.max(options.maxErrors ?? 50, 1), 1_000)
    },
    options.deadlineMs ?? DEFAULT_DEADLINE_MS
  );
  return {
    ...workerResult,
    schema: {
      id: registration.id,
      sha256: registration.sha256,
      bundle_sha256: artifactSchemaBundleDigest(),
      validator_build: VALIDATOR_BUILD_IDENTITY,
      registered: true
    },
    artifact_sha256: sha256(instanceBytes)
  };
}

function prepareExternalSchemas(
  rootPath: string,
  rootBytes: Buffer,
  explicitRefPaths: readonly string[]
): { root: ExternalSchemaSnapshot; schemas: ExternalSchemaSnapshot[] } | { failure: JsonFileValidationResult } {
  try {
    const allowedRoots = new Set<string>([fs.realpathSync(path.dirname(rootPath))]);
    const explicit = explicitRefPaths.map((refPath) => path.resolve(refPath));
    for (const refPath of explicit) allowedRoots.add(fs.realpathSync(path.dirname(refPath)));
    const byPath = new Map<string, ExternalSchemaSnapshot>();
    let totalBytes = 0;

    const load = (filePath: string, supplied?: Buffer, requireId = true): ExternalSchemaSnapshot => {
      const bytes = supplied ?? readRegularFileSnapshot(filePath, MAX_SCHEMA_BYTES);
      const realPath = fs.realpathSync(filePath);
      if (!insideAnyRoot(realPath, allowedRoots))
        throw new Error(`schema reference escapes every allowed root: ${filePath}`);
      const existing = byPath.get(realPath);
      if (existing !== undefined) return existing;
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
      enforcePatternLimits(parsed);
      const snapshot = { filePath: realPath, schema: parsed };
      byPath.set(realPath, snapshot);
      return snapshot;
    };

    const root = load(rootPath, rootBytes, false);
    for (const refPath of explicit) load(refPath);
    const queue = [root, ...byPath.values()].filter((entry, index, entries) => entries.indexOf(entry) === index);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      rewriteAndLoadReferences(current.schema, current.filePath, (relativePath) => {
        const loaded = load(relativePath);
        if (!queue.includes(loaded)) queue.push(loaded);
        return loaded.filePath;
      });
    }

    const bundledIds = new Set(artifactSchemaRegistry().map((entry) => entry.id));
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

function rewriteAndLoadReferences(value: unknown, referringPath: string, load: (filePath: string) => string): void {
  if (Array.isArray(value)) {
    for (const entry of value) rewriteAndLoadReferences(entry, referringPath, load);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "$ref" || typeof entry !== "string") {
      rewriteAndLoadReferences(entry, referringPath, load);
      continue;
    }
    if (/^https?:/iu.test(entry)) throw new Error(`HTTP(S) schema references are forbidden: ${entry}`);
    if (/^file:/iu.test(entry) || path.isAbsolute(entry)) {
      throw new Error(`absolute file schema references are forbidden: ${entry}`);
    }
    if (entry.startsWith("#") || /^urn:/iu.test(entry)) continue;
    const hashIndex = entry.indexOf("#");
    const relative = hashIndex === -1 ? entry : entry.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : entry.slice(hashIndex);
    if (relative.length === 0) continue;
    const loadedPath = load(path.resolve(path.dirname(referringPath), relative));
    value[key] = `${pathToFileURL(loadedPath).href}${fragment}`;
  }
}

function enforcePatternLimits(value: unknown): void {
  let count = 0;
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    } else if (isRecord(entry)) {
      for (const [key, item] of Object.entries(entry)) {
        if (key === "pattern" && typeof item === "string") {
          count += 1;
          if (count > MAX_PATTERN_COUNT) throw new Error(`schema exceeds the ${MAX_PATTERN_COUNT}-pattern limit`);
          if (item.length > MAX_PATTERN_LENGTH) {
            throw new Error(`schema pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit`);
          }
        }
        visit(item);
      }
    }
  };
  visit(value);
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
  return {
    status,
    diagnostics: [{ code, message }],
    schema: null,
    artifact_sha256: null,
    truncated: false
  };
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
