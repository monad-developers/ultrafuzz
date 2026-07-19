import { z, type ZodIssue } from "zod/v4";
import { DEFAULT_MODEL_PROFILE_ID, synthesizeDefaultModelProfile } from "./defaults.js";
import { diagnostic, type ConfigDiagnostic, type ResolvedConfig } from "./types.js";

export interface DefaultProfileOverrides {
  agent?: string;
  model?: string;
  reasoning?: string;
}

const MODEL_TIMEOUT_SECONDS = 86_400;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_AGENT_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

const profileIdSchema = z
  .string()
  .regex(PROFILE_ID_PATTERN)
  .refine((value) => !value.split(/[\\/]/).some((segment) => segment === "..") && !value.includes(".."));

const safeAgentRefSchema = z
  .string()
  .regex(SAFE_AGENT_REF_PATTERN)
  .refine((value) => !value.includes(".."));

const modelProfileSchema = z.object({
  id: z.string(),
  agent: safeAgentRefSchema,
  model: z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
  reasoning: z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
  timeoutSeconds: z.number().int().min(1).max(MODEL_TIMEOUT_SECONDS).optional()
});

const modelProfileIdsSchema = z.record(profileIdSchema, z.unknown());
const modelProfileValuesSchema = z.record(z.string(), modelProfileSchema);

const modelDefaultReferenceSchema = z
  .object({
    default: z.string(),
    profiles: z.record(z.string(), z.unknown())
  })
  .superRefine((models, context) => {
    if (models.profiles[models.default] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "CONFIG_MODEL_DEFAULT_UNKNOWN"
      });
    }
  });

const modelProfileIdMatchSchema = z
  .record(z.string(), z.object({ id: z.string() }).passthrough())
  .superRefine((profiles, context) => {
    for (const [id, profile] of Object.entries(profiles).sort()) {
      if (profile.id !== id) {
        context.addIssue({
          code: "custom",
          path: [id, "id"],
          message: "CONFIG_MODEL_PROFILE_ID_MISMATCH"
        });
      }
    }
  });

export function validateModelProfiles(config: ResolvedConfig): ConfigDiagnostic[] {
  const issues = [
    ...schemaIssues(modelDefaultReferenceSchema, config.models),
    ...schemaIssues(modelProfileIdMatchSchema, config.models.profiles),
    ...schemaIssues(modelProfileIdsSchema, config.models.profiles),
    ...schemaIssues(modelProfileValuesSchema, config.models.profiles)
  ].sort(compareModelProfileIssues);
  return issues.map((issue) => modelProfileDiagnostic(issue, config));
}

export function syncDefaultModelProfile(config: ResolvedConfig): void {
  const defaultId = DEFAULT_MODEL_PROFILE_ID;
  if (config.models.default !== defaultId) {
    return;
  }

  const existingAgent = config.models.profiles[defaultId]?.agent;
  if (!config.models.profiles[defaultId] || config.models.synthesizedDefault) {
    config.models.profiles[defaultId] = synthesizeDefaultModelProfile(existingAgent);
    config.models.synthesizedDefault = true;
  }
}

export function validProfileId(id: string): boolean {
  return profileIdSchema.safeParse(id).success;
}

export function applyDefaultProfileOverrides(config: ResolvedConfig, overrides: DefaultProfileOverrides): void {
  if (overrides.agent === undefined && overrides.model === undefined && overrides.reasoning === undefined) {
    return;
  }
  const profile = config.models.profiles[config.models.default];
  if (profile === undefined) {
    return;
  }
  // A profile's model and reasoning are chosen for its agent, so switching the
  // agent must not hand backend-specific reasoning to another backend. A model
  // survives only when the override explicitly replaces it below.
  if (overrides.agent !== undefined && overrides.agent !== profile.agent) {
    if (overrides.model === undefined) {
      delete profile.model;
    }
    delete profile.reasoning;
  }
  if (overrides.agent !== undefined) {
    profile.agent = overrides.agent;
  }
  if (overrides.model !== undefined) {
    profile.model = overrides.model;
  }
  if (overrides.reasoning !== undefined) {
    profile.reasoning = overrides.reasoning;
  }
}

function schemaIssues(schema: z.ZodType, value: unknown): ZodIssue[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues;
}

function modelProfileDiagnostic(issue: ZodIssue, config: ResolvedConfig): ConfigDiagnostic {
  const code = modelProfileDiagnosticCode(issue);
  return diagnostic(
    code,
    modelProfileDiagnosticMessage(code, issue, config),
    modelProfileDiagnosticPath(issue),
    "validation"
  );
}

function modelProfileDiagnosticCode(issue: ZodIssue): string {
  if (issue.code === "custom" && issue.message.startsWith("CONFIG_")) {
    return issue.message;
  }
  if (issue.code === "invalid_key") {
    return "CONFIG_MODEL_PROFILE_ID_INVALID";
  }
  switch (issue.path[1]) {
    case "agent":
      return "CONFIG_MODEL_AGENT_INVALID";
    case "model":
      return "CONFIG_MODEL_NAME_EMPTY";
    case "reasoning":
      return "CONFIG_MODEL_REASONING_EMPTY";
    case "timeoutSeconds":
      return "CONFIG_MODEL_TIMEOUT_INVALID";
    default:
      return "CONFIG_MODEL_PROFILE_ID_INVALID";
  }
}

function modelProfileDiagnosticMessage(code: string, issue: ZodIssue, config: ResolvedConfig): string {
  const id = modelProfileId(issue);
  const profile = id === undefined ? undefined : config.models.profiles[id];
  switch (code) {
    case "CONFIG_MODEL_DEFAULT_UNKNOWN":
      return `models.default references unknown model profile \`${config.models.default}\``;
    case "CONFIG_MODEL_PROFILE_ID_MISMATCH":
      return `model profile key \`${id ?? ""}\` must match profile id \`${profile?.id ?? ""}\``;
    case "CONFIG_MODEL_AGENT_INVALID":
      return `model profile \`${id ?? ""}\` references invalid agent \`${String(profile?.agent)}\``;
    case "CONFIG_MODEL_NAME_EMPTY":
      return `model profile \`${id ?? ""}\` model cannot be empty`;
    case "CONFIG_MODEL_REASONING_EMPTY":
      return `model profile \`${id ?? ""}\` reasoning cannot be empty`;
    case "CONFIG_MODEL_TIMEOUT_INVALID":
      return "model profile timeout_seconds must be between 1 and 86400";
    default:
      return `model profile id \`${id ?? ""}\` must use ASCII letters, digits, hyphen, underscore, or dot and must not contain traversal segments`;
  }
}

function modelProfileDiagnosticPath(issue: ZodIssue): string[] {
  if (issue.path[0] === "default") {
    return ["models", "default"];
  }
  const path = ["models", ...issue.path.map((segment) => modelProfilePathSegment(String(segment)))];
  return issue.code === "invalid_key" ? path.slice(0, 2) : path;
}

function modelProfilePathSegment(segment: string): string {
  return segment === "timeoutSeconds" ? "timeout_seconds" : segment;
}

function modelProfileId(issue: ZodIssue): string | undefined {
  if (issue.path[0] === "default") {
    return undefined;
  }
  return String(issue.path[0] ?? "");
}

function compareModelProfileIssues(left: ZodIssue, right: ZodIssue): number {
  const leftRank = modelProfileIssueRank(left);
  const rightRank = modelProfileIssueRank(right);
  return (
    leftRank.section - rightRank.section || leftRank.id.localeCompare(rightRank.id) || leftRank.field - rightRank.field
  );
}

function modelProfileIssueRank(issue: ZodIssue): { section: number; id: string; field: number } {
  if (issue.path[0] === "default") {
    return { section: 0, id: "", field: 0 };
  }
  return {
    section: 1,
    id: modelProfileId(issue) ?? "",
    field: modelProfileFieldRank(issue)
  };
}

function modelProfileFieldRank(issue: ZodIssue): number {
  const code = modelProfileDiagnosticCode(issue);
  switch (code) {
    case "CONFIG_MODEL_PROFILE_ID_MISMATCH":
      return 0;
    case "CONFIG_MODEL_PROFILE_ID_INVALID":
      return 1;
    case "CONFIG_MODEL_AGENT_INVALID":
      return 2;
    case "CONFIG_MODEL_NAME_EMPTY":
      return 3;
    case "CONFIG_MODEL_REASONING_EMPTY":
      return 4;
    case "CONFIG_MODEL_TIMEOUT_INVALID":
      return 5;
    default:
      return 6;
  }
}
