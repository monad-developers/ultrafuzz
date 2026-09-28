import { parseStrictJsonBytes, writeJsonDurable, type StrictJsonLimits } from "@ultrafuzz/artifacts";

import {
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  type RuntimeDocumentForSchemaId,
  type RuntimeDocumentSchemaId
} from "./runtime-contracts.js";
import { assertRuntimeJsonSchema } from "./schema-registry.js";
import { assertRuntimeDocumentSemantics } from "./runtime-semantic-gates.js";

const RUNTIME_DOCUMENT_LIMITS: StrictJsonLimits = {
  maxBytes: 128 * 1024 * 1024,
  maxDepth: 64,
  maxItems: 100_000,
  maxProperties: 500_000
};

// The parser counts items across the whole document. The control seal's schema
// admits 100_000 execution files plus three identity arrays of up to 100_000
// entries each, so a seal whose every array is within its schema bound can hold
// 400_000 items. Its property total (four per execution file plus 35 fixed) stays
// under the default limit.
const CONTROL_SEAL_LIMITS: StrictJsonLimits = { ...RUNTIME_DOCUMENT_LIMITS, maxItems: 400_000 };

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
  const value = parseStrictJsonBytes(
    bytes,
    schemaId === WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID ? CONTROL_SEAL_LIMITS : RUNTIME_DOCUMENT_LIMITS
  );
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
