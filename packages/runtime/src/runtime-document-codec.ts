import { parseStrictJsonBytes, writeJsonDurable } from "@ultrafuzz/artifacts";

import { type RuntimeDocumentForSchemaId, type RuntimeDocumentSchemaId } from "./runtime-contracts.js";
import { assertRuntimeJsonSchema } from "./schema-registry.js";
import { assertRuntimeDocumentSemantics } from "./runtime-semantic-gates.js";

const MAX_RUNTIME_DOCUMENT_BYTES = 128 * 1024 * 1024;

export function assertRuntimeDocument<SchemaId extends RuntimeDocumentSchemaId>(
  schemaId: SchemaId,
  value: unknown,
  label: string
): RuntimeDocumentForSchemaId<SchemaId> {
  assertRuntimeJsonSchema(schemaId, value, label);
  const document = value as RuntimeDocumentForSchemaId<SchemaId>;
  assertRuntimeDocumentSemantics(schemaId, document);
  return document;
}

export function parseRuntimeDocumentBytes<SchemaId extends RuntimeDocumentSchemaId>(
  schemaId: SchemaId,
  bytes: Uint8Array,
  label: string
): RuntimeDocumentForSchemaId<SchemaId> {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_RUNTIME_DOCUMENT_BYTES,
    maxDepth: 64,
    maxItems: 100_000,
    maxProperties: 500_000
  });
  return assertRuntimeDocument(schemaId, value, label);
}

export function serializeRuntimeDocument<SchemaId extends RuntimeDocumentSchemaId>(
  schemaId: SchemaId,
  value: RuntimeDocumentForSchemaId<SchemaId>,
  label: string,
  pretty = false
): string {
  const document = assertRuntimeDocument(schemaId, value, label);
  return `${JSON.stringify(document, null, pretty ? 2 : undefined)}\n`;
}

export function writeRuntimeDocument<SchemaId extends RuntimeDocumentSchemaId>(
  filePath: string,
  schemaId: SchemaId,
  value: RuntimeDocumentForSchemaId<SchemaId>,
  label: string
): void {
  const document = assertRuntimeDocument(schemaId, value, label);
  writeJsonDurable(filePath, document);
}
