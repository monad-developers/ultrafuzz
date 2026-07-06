import { type z } from "zod/v4";

export interface SchemaValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface SchemaValidationResult<T> {
  ok: boolean;
  issues: SchemaValidationIssue[];
  value?: T;
}

export function validateWithZod<T>(
  schema: z.ZodType<T>,
  value: unknown,
  options: {
    path?: string;
    code?: string;
  } = {}
): SchemaValidationResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true, issues: [], value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: zodPath(issue.path, options.path ?? "$"),
      code: options.code ?? issue.code,
      message: issue.message
    }))
  };
}

export function schemaErrorMessage(label: string, issues: SchemaValidationIssue[]): string {
  return `${label} schema validation failed: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`;
}

function zodPath(parts: readonly (string | number | symbol)[], root: string): string {
  let output = root;
  for (const part of parts) {
    if (typeof part === "number") {
      output += `[${part}]`;
    } else if (typeof part === "string") {
      output += /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`;
    }
  }
  return output;
}
