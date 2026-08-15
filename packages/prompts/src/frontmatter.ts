import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const PROMPT_FRONTMATTER_FIELDS = ["id", "display_name"] as const;

export type PromptFrontmatterField = (typeof PROMPT_FRONTMATTER_FIELDS)[number];

export interface PromptFrontmatter {
  id?: string;
  display_name?: string;
}

export interface ParsedPromptDocument {
  frontmatter: PromptFrontmatter;
  body: string;
  rawFrontmatter?: string;
  unknownFrontmatter?: Record<string, unknown>;
}

export interface ParsePromptFrontmatterOptions {
  allowUnknownFields?: boolean;
}

export type PromptErrorCode =
  | "duplicate-prompt-id"
  | "empty-template-variable"
  | "invalid-artifact-reference"
  | "invalid-frontmatter"
  | "invalid-prompt-path"
  | "invalid-render-input"
  | "invalid-rename"
  | "missing-template-variable"
  | "not-ancestor"
  | "symlink-prompt-path"
  | "unsafe-validation-command-path"
  | "unclosed-frontmatter"
  | "unclosed-template-variable";

export class PromptError extends Error {
  readonly code: PromptErrorCode;
  readonly details?: unknown;

  constructor(code: PromptErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "PromptError";
    this.code = code;
    this.details = details;
  }
}

export function parsePromptFrontmatter(
  markdown: string,
  options: ParsePromptFrontmatterOptions = {}
): ParsedPromptDocument {
  const frontmatterBlock = readFrontmatterBlock(markdown);
  if (!frontmatterBlock) {
    return {
      frontmatter: {},
      body: markdown
    };
  }

  let parsed: unknown;
  try {
    parsed = frontmatterBlock.raw.trim() === "" ? {} : parseYaml(frontmatterBlock.raw);
  } catch (error) {
    throw new PromptError(
      "invalid-frontmatter",
      `invalid prompt YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (parsed == null) {
    parsed = {};
  }
  if (!isPlainPromptFrontmatterObject(parsed)) {
    throw new PromptError("invalid-frontmatter", "prompt frontmatter must be a YAML mapping");
  }

  const unknownFrontmatter: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (key === "category") {
      throw new PromptError("invalid-frontmatter", "`category` is no longer supported in prompt frontmatter");
    }
    if (!PROMPT_FRONTMATTER_FIELDS.includes(key as PromptFrontmatterField)) {
      if (!options.allowUnknownFields) {
        throw new PromptError("invalid-frontmatter", `unsupported prompt frontmatter field: ${key}`);
      }
      unknownFrontmatter[key] = parsed[key];
    }
  }

  const frontmatter: PromptFrontmatter = {};
  const raw = parsed as Record<string, unknown>;
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !isSafePromptId(raw.id)) {
      throw new PromptError("invalid-frontmatter", "`id` must be a safe prompt id");
    }
    frontmatter.id = raw.id;
  }
  if (raw.display_name !== undefined) {
    if (typeof raw.display_name !== "string" || raw.display_name.trim() === "") {
      throw new PromptError("invalid-frontmatter", "`display_name` must be a non-empty string");
    }
    frontmatter.display_name = raw.display_name;
  }
  return {
    frontmatter,
    body: frontmatterBlock.body,
    rawFrontmatter: frontmatterBlock.raw,
    ...(Object.keys(unknownFrontmatter).length > 0 ? { unknownFrontmatter } : {})
  };
}

export function serializePromptDocument(
  frontmatter: PromptFrontmatter,
  body: string,
  unknownFrontmatter: Record<string, unknown> = {}
): string {
  const mapping: Record<string, unknown> = {};
  for (const key of PROMPT_FRONTMATTER_FIELDS) {
    const value = frontmatter[key];
    if (value !== undefined) {
      mapping[key] = value;
    }
  }
  for (const [key, value] of Object.entries(unknownFrontmatter)) {
    if (!(key in mapping)) {
      mapping[key] = value;
    }
  }

  if (Object.keys(mapping).length === 0) {
    return body;
  }

  const yaml = stringifyYaml(mapping, { sortMapEntries: true }).trimEnd();
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `---\n${yaml}\n---\n\n${normalizedBody}`;
}

export interface PromptIdentityDiff {
  idChanged: boolean;
  displayNameChanged: boolean;
  executionIdentityChanged: boolean;
  displayNameOnly: boolean;
}

export function diffPromptIdentity(beforeMarkdown: string, afterMarkdown: string): PromptIdentityDiff {
  const before = parsePromptFrontmatter(beforeMarkdown);
  const after = parsePromptFrontmatter(afterMarkdown);

  const idChanged = before.frontmatter.id !== after.frontmatter.id;
  const displayNameChanged = before.frontmatter.display_name !== after.frontmatter.display_name;
  const executionIdentityChanged = idChanged || before.body !== after.body;

  return {
    idChanged,
    displayNameChanged,
    executionIdentityChanged,
    displayNameOnly: displayNameChanged && !executionIdentityChanged
  };
}

export function isSafePromptId(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("..") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}

export function titleFromId(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function readFrontmatterBlock(markdown: string):
  | {
      raw: string;
      body: string;
    }
  | undefined {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return undefined;
  }

  const firstLineBreak = markdown.startsWith("---\r\n") ? 5 : 4;
  const rest = markdown.slice(firstLineBreak);
  const delimiterMatch = rest.match(/(?:^|\r?\n)---(?:\r?\n|$)/);
  if (!delimiterMatch || delimiterMatch.index === undefined) {
    throw new PromptError("unclosed-frontmatter", "frontmatter block is missing a closing delimiter");
  }

  const delimiterStart = delimiterMatch.index === 0 ? 0 : delimiterMatch.index + delimiterMatch[0].indexOf("---");
  const delimiterLength = rest.slice(delimiterStart).startsWith("---\r\n")
    ? 5
    : rest.slice(delimiterStart).startsWith("---\n")
      ? 4
      : 3;
  return {
    raw: rest.slice(0, delimiterStart).replace(/\r\n/g, "\n"),
    body: rest.slice(delimiterStart + delimiterLength)
  };
}

export function isPlainPromptFrontmatterObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
