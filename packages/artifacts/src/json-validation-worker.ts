import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import { createStrictAjv, runValidator } from "./json-schema-validator.js";
import { artifactSchemaRegistry } from "./schema-registry.js";
import { parseStrictJsonBytes, StrictJsonError } from "./strict-json.js";

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
  maxInstanceBytes: number;
  registeredSchemaId?: string;
  registeredSchemas?: RegisteredSchemaSnapshot[];
  externalRootPath?: string;
  externalSchemas?: ExternalSchemaSnapshot[];
  maxErrors: number;
  responsePort?: MessagePort;
}

/**
 * Long-lived registered-schema validator. The isolate, its resource limits, and
 * its compiled schema bundle are pinned once so repeated host gates pay the
 * compile cost a single time instead of on every artifact they authenticate.
 */
interface ServeRequest {
  mode: "serve";
  registeredSchemas: RegisteredSchemaSnapshot[];
  requestPort: MessagePort;
  ready: Int32Array;
}

interface ServeValidationRequest {
  sequence: number;
  instanceBytes: Uint8Array;
  maxInstanceBytes: number;
  registeredSchemaId: string;
  maxErrors: number;
}

const input = workerData as ServeRequest | WorkerRequest;

if (isServeRequest(input)) {
  serveRegisteredValidations(input);
} else {
  validateOnce(input);
}

function isServeRequest(value: ServeRequest | WorkerRequest): value is ServeRequest {
  return (value as ServeRequest).mode === "serve";
}

function serveRegisteredValidations(serve: ServeRequest): void {
  let validators: ReturnType<typeof compileRegisteredValidators> | undefined;
  let setupError: string | undefined;
  try {
    validators = compileRegisteredValidators(serve.registeredSchemas);
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }
  serve.requestPort.on("message", (request: ServeValidationRequest) => {
    let result: unknown;
    try {
      result =
        validators === undefined
          ? compileFailure(setupError ?? "registered schema bundle is unavailable")
          : validateRegisteredInstance(validators, request);
    } catch (error) {
      result = compileFailure(error instanceof Error ? error.message : String(error));
    }
    serve.requestPort.postMessage({ sequence: request.sequence, result });
    // The requesting thread blocks on this slot, so publish it only after the
    // response is queued on the port it drains.
    Atomics.store(serve.ready, 0, 1);
    Atomics.notify(serve.ready, 0);
  });
}

function compileRegisteredValidators(schemas: readonly RegisteredSchemaSnapshot[]): {
  getSchema: (id: string) => ReturnType<ReturnType<typeof createStrictAjv>["getSchema"]>;
} {
  const ajv = createStrictAjv();
  addAndCompileRegisteredSchemas(ajv, schemas);
  return { getSchema: (id: string) => ajv.getSchema(id) };
}

function addAndCompileRegisteredSchemas(
  ajv: ReturnType<typeof createStrictAjv>,
  schemas: readonly RegisteredSchemaSnapshot[]
): void {
  for (const entry of schemas) ajv.addSchema(structuredClone(entry.schema), entry.id);
  // Compile in registry order so referenced-schema diagnostics retain their
  // canonical registered IDs instead of depending on which root is requested
  // first. The host and one-shot worker must project identical schema paths.
  for (const entry of schemas) {
    if (ajv.getSchema(entry.id) === undefined) throw new Error(`failed to compile registered schema ${entry.id}`);
  }
}

function validateRegisteredInstance(
  validators: { getSchema: (id: string) => ReturnType<ReturnType<typeof createStrictAjv>["getSchema"]> },
  request: ServeValidationRequest
): unknown {
  let instance: unknown;
  try {
    instance = parseInstance(request.instanceBytes, request.maxInstanceBytes);
  } catch (error) {
    return instanceFailure(error);
  }
  const validator = validators.getSchema(request.registeredSchemaId);
  if (validator === undefined) throw new Error(`registered schema is unavailable: ${request.registeredSchemaId}`);
  const result = runValidator(validator, instance, { maxErrors: request.maxErrors });
  return {
    status: result.ok ? "valid" : "instance-error",
    diagnostics: result.issues.map((issue) => ({ code: "JSON_SCHEMA_VIOLATION", ...issue })),
    schema: null,
    artifact_sha256: null,
    truncated: result.truncated
  };
}

function validateOnce(request: WorkerRequest): void {
  try {
    let instance: unknown;
    try {
      instance = parseInstance(request.instanceBytes, request.maxInstanceBytes);
    } catch (error) {
      post(request, instanceFailure(error));
    }

    const ajv = createStrictAjv();
    const registeredSchemas = request.registeredSchemas ?? artifactSchemaRegistry();
    addAndCompileRegisteredSchemas(ajv, registeredSchemas);
    let validator;
    if (request.registeredSchemaId !== undefined) {
      validator = ajv.getSchema(request.registeredSchemaId);
      if (validator === undefined) throw new Error(`registered schema is unavailable: ${request.registeredSchemaId}`);
    } else {
      const schemas = request.externalSchemas ?? [];
      const rootPath = request.externalRootPath;
      if (rootPath === undefined) throw new Error("external root schema path is missing");
      for (const snapshot of schemas) {
        ajv.addSchema(snapshot.schema, pathToFileURL(snapshot.filePath).href);
      }
      validator = ajv.getSchema(pathToFileURL(rootPath).href);
      if (validator === undefined) throw new Error(`failed to compile root schema ${rootPath}`);
    }
    const result = runValidator(validator, instance, { maxErrors: request.maxErrors });
    post(request, {
      status: result.ok ? "valid" : "instance-error",
      diagnostics: result.issues.map((issue) => ({ code: "JSON_SCHEMA_VIOLATION", ...issue })),
      schema: null,
      artifact_sha256: null,
      truncated: result.truncated
    });
  } catch (error) {
    post(request, compileFailure(error instanceof Error ? error.message : String(error)));
  }
}

function parseInstance(instanceBytes: Uint8Array, maxInstanceBytes: number): unknown {
  return parseStrictJsonBytes(instanceBytes, {
    maxBytes: maxInstanceBytes,
    maxDepth: 128,
    maxItems: 1_000_000,
    maxProperties: 1_000_000
  });
}

function instanceFailure(error: unknown): unknown {
  const strict = error instanceof StrictJsonError ? error : undefined;
  return {
    status: "instance-error",
    diagnostics: [
      {
        code: strict?.kind === "duplicate-key" ? "JSON_DUPLICATE_KEY" : "JSON_INSTANCE_INVALID",
        message: error instanceof Error ? error.message : String(error),
        ...(strict?.pointer === undefined || strict.pointer.length === 0 ? {} : { instancePath: strict.pointer })
      }
    ],
    schema: null,
    artifact_sha256: null,
    truncated: false
  };
}

function compileFailure(message: string): unknown {
  return {
    status: "setup-error",
    diagnostics: [{ code: "JSON_SCHEMA_COMPILE_ERROR", message }],
    schema: null,
    artifact_sha256: null,
    truncated: false
  };
}

function post(request: WorkerRequest, value: unknown): never {
  (request.responsePort ?? parentPort)?.postMessage(value);
  process.exit(0);
}
