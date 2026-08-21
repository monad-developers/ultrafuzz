import { z } from "zod/v4";

import { MAX_RETRY_CHAIN_ATTEMPTS } from "@ultrafuzz/artifacts";
import { STOCK_AGENT_IDS } from "./agents.js";
import { MAX_TIMEOUT_SECONDS } from "./constants.js";
import { RESOLVED_CONFIG_SCHEMA_VERSION, type ResolvedConfig } from "./types.js";

export const RESOLVED_CONFIG_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:config:resolved-config:3" as const;
export const RESOLVED_CONFIG_SCHEMA_FILENAME = "resolved-config.schema.json" as const;

const NON_WHITESPACE_PATTERN = /.*\S.*/u;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROFILE_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NODE_ID_PATTERN = /^[a-z0-9_][a-z0-9_-]{0,127}$/u;
const EVAL_PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const HTTPS_ENDPOINT_PATTERN = /^https:\/\/\S+$/u;
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const AUDIT_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PACKAGED_TOPOLOGY_PATH_PATTERN = /^topologies\/[a-z0-9][a-z0-9-]*\.ya?ml$/u;
const OPENROUTER_MODEL_ID_PATTERN = /^[^\s\p{Cc}]+$/u;
const PROJECT_LOCAL_PATH_PATTERN =
  /^(?:\.|(?![A-Za-z]:[\\/])(?![\\/])(?!.*[\\/]$)(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))(?!.*[\\/]{2})[^\r\n]+)$/u;

const nonWhitespaceStringSchema = z.string().min(1).regex(NON_WHITESPACE_PATTERN);
const environmentVariableNameSchema = z.string().regex(ENVIRONMENT_VARIABLE_PATTERN);
const projectLocalPathSchema = z.string().regex(PROJECT_LOCAL_PATH_PATTERN);
const timeoutSecondsSchema = z.number().int().min(1).max(MAX_TIMEOUT_SECONDS);
const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const dynamicStrategiesEnumeratorSchema = z.union([nonNegativeIntegerSchema, z.literal("unlimited")]);
const sha256DigestSchema = z.string().regex(SHA256_DIGEST_PATTERN);
const auditProfileIdSchema = z.string().regex(AUDIT_PROFILE_ID_PATTERN);
const packagedTopologyPathSchema = z.string().regex(PACKAGED_TOPOLOGY_PATH_PATTERN);

const AUDIT_PROFILE_SETTING_NAMES = [
  "strategy_loops",
  "dynamic_strategies_enumerator",
  "same_agent_attempts",
  "max_parallel_agents",
  "max_parallel_nodes",
  "default_timeout_seconds",
  "workflow_deadline_seconds",
  "invariant_testing_smoke_timeout_seconds",
  "invariant_testing_fuzzer_timeout_seconds",
  "triage_quorum",
  "triage_panel_size"
] as const;

const auditProfileSettingNameSchema = z.enum(AUDIT_PROFILE_SETTING_NAMES);

const auditProfileSettingOriginSchema = z.enum([
  "default",
  "audit-profile",
  "project-config",
  "environment",
  "runtime-override"
]);

const auditProfileSettingsSchema = z
  .object({
    strategy_loops: positiveIntegerSchema.optional(),
    dynamic_strategies_enumerator: dynamicStrategiesEnumeratorSchema.optional(),
    same_agent_attempts: positiveIntegerSchema.max(MAX_RETRY_CHAIN_ATTEMPTS).optional(),
    max_parallel_agents: positiveIntegerSchema.optional(),
    max_parallel_nodes: positiveIntegerSchema.optional(),
    default_timeout_seconds: timeoutSecondsSchema.optional(),
    workflow_deadline_seconds: timeoutSecondsSchema.optional(),
    invariant_testing_smoke_timeout_seconds: timeoutSecondsSchema.optional(),
    invariant_testing_fuzzer_timeout_seconds: timeoutSecondsSchema.optional(),
    triage_quorum: positiveIntegerSchema.optional(),
    triage_panel_size: positiveIntegerSchema.optional()
  })
  .strict();

const auditProfileResolutionSchema = z
  .object({
    catalogSchemaVersion: positiveIntegerSchema,
    catalogDigest: sha256DigestSchema,
    declaredTopologyPath: packagedTopologyPathSchema.optional(),
    settings: auditProfileSettingsSchema,
    effectiveSettings: auditProfileSettingsSchema,
    settingOrigins: z.partialRecord(auditProfileSettingNameSchema, auditProfileSettingOriginSchema),
    overriddenSettings: z.array(auditProfileSettingNameSchema).refine((names) => new Set(names).size === names.length)
  })
  .strict();

const executionResourcesSchema = z
  .object({
    cpu: z.number().positive().max(256).finite(),
    memoryMiB: z.number().int().min(128).max(4_194_304),
    timeoutSeconds: timeoutSecondsSchema
  })
  .strict();

const executionNodeOverrideSchema = z
  .object({
    resources: z
      .object({
        cpu: z.number().positive().max(256).finite().optional(),
        memoryMiB: z.number().int().min(128).max(4_194_304).optional(),
        timeoutSeconds: timeoutSecondsSchema.optional()
      })
      .strict()
  })
  .strict();

const modalExecutionProviderSchema = z
  .object({
    app: nonWhitespaceStringSchema,
    image: nonWhitespaceStringSchema,
    region: nonWhitespaceStringSchema.optional(),
    credentialEnv: z
      .array(environmentVariableNameSchema)
      .length(2)
      .refine((names) => names.join(",") === "MODAL_TOKEN_ID,MODAL_TOKEN_SECRET")
  })
  .strict();

const modelProfileSchema = z
  .object({
    id: z.string().regex(PROFILE_ID_PATTERN),
    agent: z.enum(STOCK_AGENT_IDS),
    model: nonWhitespaceStringSchema.optional(),
    reasoning: nonWhitespaceStringSchema.optional(),
    timeoutSeconds: timeoutSecondsSchema.optional()
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      (profile.agent === "KimiAgent" || profile.agent === "DeepSeekAgent") &&
      profile.reasoning !== undefined &&
      !["low", "high", "max"].includes(profile.reasoning)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasoning"],
        message:
          profile.agent === "KimiAgent"
            ? "CONFIG_MODEL_KIMI_REASONING_UNSUPPORTED"
            : "CONFIG_MODEL_DEEPSEEK_REASONING_UNSUPPORTED"
      });
    }
    if (
      profile.agent === "OpenRouterAgent" &&
      (profile.model === undefined || profile.model.length > 256 || !OPENROUTER_MODEL_ID_PATTERN.test(profile.model))
    ) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "CONFIG_MODEL_OPENROUTER_ID_INVALID"
      });
    }
  });

const agentConfigSchema = z.discriminatedUnion("auth", [
  z
    .object({
      auth: z.literal("api-key"),
      apiKeyEnv: environmentVariableNameSchema,
      configDir: nonWhitespaceStringSchema.optional()
    })
    .strict(),
  z
    .object({
      auth: z.literal("subscription"),
      apiKeyEnv: environmentVariableNameSchema.optional(),
      configDir: nonWhitespaceStringSchema.optional()
    })
    .strict()
]);

const evalProviderProfileSchema = z
  .object({
    apiKeyEnv: environmentVariableNameSchema.optional(),
    project: nonWhitespaceStringSchema.optional(),
    endpoint: z.string().regex(HTTPS_ENDPOINT_PATTERN).optional()
  })
  .strict();

const executionConfigSchema = z
  .object({
    mode: z.enum(["local", "cloud"]),
    provider: z.literal("modal").optional(),
    retentionDays: z.number().int().min(1).max(3_650),
    resources: executionResourcesSchema,
    nodes: z.record(z.string().regex(NODE_ID_PATTERN), executionNodeOverrideSchema),
    providers: z
      .object({
        modal: modalExecutionProviderSchema.optional()
      })
      .strict()
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.mode === "local") {
      if (execution.provider !== undefined) {
        context.addIssue({ code: "custom", path: ["provider"], message: "CONFIG_EXECUTION_LOCAL_PROVIDER" });
      }
      if (execution.providers.modal !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["providers", "modal"],
          message: "CONFIG_EXECUTION_LOCAL_PROVIDER_SETTINGS"
        });
      }
      return;
    }
    if (execution.provider !== "modal") {
      context.addIssue({ code: "custom", path: ["provider"], message: "CONFIG_EXECUTION_PROVIDER_REQUIRED" });
    }
    if (execution.providers.modal === undefined) {
      context.addIssue({
        code: "custom",
        path: ["providers", "modal"],
        message: "CONFIG_EXECUTION_PROVIDER_SETTINGS_REQUIRED"
      });
    }
  });

const modelProfilesSchema = z
  .record(z.string().regex(PROFILE_ID_PATTERN), modelProfileSchema)
  .refine((profiles) => Object.keys(profiles).length > 0, { message: "models.profiles must not be empty" });

const agentConfigsSchema = z
  .partialRecord(z.enum(STOCK_AGENT_IDS), agentConfigSchema)
  .refine((agents) => Object.keys(agents).length > 0, { message: "agents must not be empty" })
  .superRefine((agents, context) => {
    if (agents.DeepSeekAgent?.auth === "subscription") {
      context.addIssue({
        code: "custom",
        path: ["DeepSeekAgent", "auth"],
        message: "CONFIG_AGENT_DEEPSEEK_AUTH_UNSUPPORTED"
      });
    }
    if (agents.OpenRouterAgent?.auth === "subscription") {
      context.addIssue({
        code: "custom",
        path: ["OpenRouterAgent", "auth"],
        message: "CONFIG_AGENT_OPENROUTER_AUTH_UNSUPPORTED"
      });
    }
  });

/**
 * Non-transforming structural mirror of the canonical checked-in JSON Schema.
 * Portable conditionals are mirrored here; environment, filesystem, and
 * dynamic-map key/value joins remain in the package's named semantic validators.
 */
export const resolvedConfigZodSchema: z.ZodType<ResolvedConfig> = z
  .object({
    schemaVersion: z.literal(RESOLVED_CONFIG_SCHEMA_VERSION),
    auditProfile: auditProfileIdSchema,
    topologyPath: projectLocalPathSchema.optional(),
    strategyLoops: positiveIntegerSchema.optional(),
    auditProfileResolution: auditProfileResolutionSchema,
    dynamicStrategiesEnumerator: dynamicStrategiesEnumeratorSchema,
    project: z
      .object({
        repo: projectLocalPathSchema,
        name: nonWhitespaceStringSchema.optional()
      })
      .strict(),
    run: z
      .object({
        outputDir: projectLocalPathSchema,
        maxParallelAgents: positiveIntegerSchema,
        maxParallelNodes: positiveIntegerSchema,
        keepWorkspaces: z.boolean(),
        forgeGuardEnabled: z.boolean(),
        forgeVmemLimitKb: positiveIntegerSchema,
        forgeRayonThreads: positiveIntegerSchema,
        workspaceMode: z.literal("git-worktree"),
        defaultTimeoutSeconds: timeoutSecondsSchema,
        workflowDeadlineSeconds: timeoutSecondsSchema,
        controllerLeaseSeconds: timeoutSecondsSchema
      })
      .strict(),
    execution: executionConfigSchema,
    models: z
      .object({
        default: z.string().regex(PROFILE_ID_PATTERN),
        synthesizedDefault: z.boolean(),
        profiles: modelProfilesSchema
      })
      .strict(),
    retry: z
      .object({
        sameAgentAttempts: positiveIntegerSchema.max(MAX_RETRY_CHAIN_ATTEMPTS),
        agents: z
          .array(z.string().regex(PROFILE_ID_PATTERN))
          .max(MAX_RETRY_CHAIN_ATTEMPTS)
          .refine((ids) => new Set(ids).size === ids.length)
      })
      .strict(),
    agents: agentConfigsSchema,
    permissions: z
      .object({
        trustModel: z.literal("skip-permissions"),
        promptReviewRequired: z.boolean(),
        materializeOutputsAsUnstaged: z.boolean(),
        productionSourceRoots: z.array(projectLocalPathSchema).min(1)
      })
      .strict(),
    invariants: z
      .object({
        propertyPriorityThreshold: z.enum(["high", "medium", "low"]),
        invariantTestingSmokeTimeoutSeconds: timeoutSecondsSchema,
        invariantTestingFuzzerTimeoutSeconds: timeoutSecondsSchema,
        referenceExpectationEnforcement: z.enum(["warn", "fail"]).optional()
      })
      .strict(),
    triage: z
      .object({
        quorum: positiveIntegerSchema,
        panelSize: positiveIntegerSchema
      })
      .strict(),
    eval: z
      .object({
        evalConfig: projectLocalPathSchema.optional(),
        groundTruthRoot: nonWhitespaceStringSchema.optional(),
        provider: z.string().regex(EVAL_PROVIDER_ID_PATTERN),
        providers: z.record(z.string().regex(EVAL_PROVIDER_ID_PATTERN), evalProviderProfileSchema)
      })
      .strict()
  })
  .strict()
  .superRefine((config, context) => {
    const expandedAttempts = config.retry.sameAgentAttempts + Math.max(0, config.retry.agents.length - 1);
    if (expandedAttempts > MAX_RETRY_CHAIN_ATTEMPTS) {
      context.addIssue({
        code: "custom",
        message: "CONFIG_RETRY_CHAIN_MAX_EXCEEDED",
        path: ["retry"]
      });
    }
  });

export function assertResolvedConfigZod(
  value: unknown,
  label = "resolved configuration"
): asserts value is ResolvedConfig {
  const result = resolvedConfigZodSchema.safeParse(value);
  if (result.success) return;
  const summary = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "/"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${RESOLVED_CONFIG_JSON_SCHEMA_ID}: ${summary}`);
}
