import { z } from "zod/v4";

const zodTimestampSchema = z.string().datetime({ offset: true });
const timestampWithSecondsPattern = /T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;

export const canonicalTimestampSchema = zodTimestampSchema.refine((value) => timestampWithSecondsPattern.test(value), {
  message: "Timestamp must include seconds and use canonical uppercase RFC 3339 syntax"
});
export const canonicalUuidSchema = z.string().uuid();

export const CANONICAL_TIMESTAMP_PATTERN = jsonSchemaPattern(zodTimestampSchema, "timestamp");
export const CANONICAL_UUID_PATTERN = jsonSchemaPattern(canonicalUuidSchema, "UUID");

export const canonicalTimestampJsonSchema = {
  type: "string",
  format: "date-time",
  pattern: CANONICAL_TIMESTAMP_PATTERN
} as const;

export const canonicalUuidJsonSchema = {
  type: "string",
  format: "uuid",
  pattern: CANONICAL_UUID_PATTERN
} as const;

export function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return true;
}

function jsonSchemaPattern(schema: z.ZodString, label: string): string {
  const generated = z.toJSONSchema(schema);
  if (typeof generated.pattern !== "string" || generated.pattern.length === 0) {
    throw new Error(`Zod did not expose a canonical ${label} JSON Schema pattern`);
  }
  return generated.pattern;
}
