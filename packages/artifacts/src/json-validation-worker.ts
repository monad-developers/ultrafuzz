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

const request = workerData as WorkerRequest;

try {
  let instance: unknown;
  try {
    instance = parseStrictJsonBytes(request.instanceBytes, {
      maxBytes: request.maxInstanceBytes,
      maxDepth: 128,
      maxItems: 1_000_000,
      maxProperties: 1_000_000
    });
  } catch (error) {
    const strict = error instanceof StrictJsonError ? error : undefined;
    post({
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
    });
  }

  const ajv = createStrictAjv();
  const registeredSchemas = request.registeredSchemas ?? artifactSchemaRegistry();
  for (const entry of registeredSchemas) ajv.addSchema(structuredClone(entry.schema), entry.id);
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
  post({
    status: result.ok ? "valid" : "instance-error",
    diagnostics: result.issues.map((issue) => ({ code: "JSON_SCHEMA_VIOLATION", ...issue })),
    schema: null,
    artifact_sha256: null,
    truncated: result.truncated
  });
} catch (error) {
  post({
    status: "setup-error",
    diagnostics: [
      {
        code: "JSON_SCHEMA_COMPILE_ERROR",
        message: error instanceof Error ? error.message : String(error)
      }
    ],
    schema: null,
    artifact_sha256: null,
    truncated: false
  });
}

function post(value: unknown): never {
  (request.responsePort ?? parentPort)?.postMessage(value);
  process.exit(0);
}
