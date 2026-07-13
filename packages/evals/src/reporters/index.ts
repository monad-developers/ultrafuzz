import type { EvalConfig, EvalProviderProfile } from "@ultrafuzz/config";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import type { EvalReporter } from "../reporter.js";
import { guardReporter } from "../reporter.js";
import type { EvalReportingPolicy } from "../types.js";
import { EvalError } from "../utils.js";
import { BraintrustReporter } from "./braintrust.js";
import { LangSmithReporter } from "./langsmith.js";

export { BraintrustReporter, type BraintrustReporterOptions } from "./braintrust.js";
export { LangSmithReporter, type LangSmithReporterOptions, dottedOrderSegment } from "./langsmith.js";

export const EVAL_PROVIDER_NONE = "none";
export const KNOWN_EVAL_PROVIDERS = ["braintrust", "langsmith", EVAL_PROVIDER_NONE] as const;
const BRAINTRUST_CREDENTIAL_ENV = "BRAINTRUST_API_KEY";
const LANGSMITH_CREDENTIAL_ENV = "LANGSMITH_API_KEY";
const LANGSMITH_WORKSPACE_ENV = "LANGSMITH_WORKSPACE_ID";
const BRAINTRUST_TRUSTED_ENDPOINT_ENV = "ULTRAFUZZ_EVAL_BRAINTRUST_TRUSTED_ENDPOINT";
const LANGSMITH_TRUSTED_ENDPOINT_ENV = "ULTRAFUZZ_EVAL_LANGSMITH_TRUSTED_ENDPOINT";

export interface ResolveEvalProviderInput {
  /** `--provider` CLI flag; highest precedence. */
  cliProvider?: string;
  env?: Record<string, string | undefined>;
  evalConfig?: EvalConfig;
}

export interface ResolvedEvalProvider {
  provider: string;
  profile?: EvalProviderProfile;
}

/**
 * Provider precedence: CLI flag > `ULTRAFUZZ_EVAL_PROVIDER` > `[eval].provider`.
 * Unknown providers and missing `[eval.providers.<name>]` profiles are config
 * errors at plan time; missing credential env vars are only errors at publish
 * time (see `createEvalReporter`), so local-only runs stay possible.
 */
export function resolveEvalProvider(input: ResolveEvalProviderInput): ResolvedEvalProvider {
  const env = input.env ?? process.env;
  const provider =
    firstNonEmpty(input.cliProvider) ??
    firstNonEmpty(env.ULTRAFUZZ_EVAL_PROVIDER) ??
    firstNonEmpty(input.evalConfig?.provider) ??
    EVAL_PROVIDER_NONE;
  if (provider === EVAL_PROVIDER_NONE) {
    return { provider };
  }
  if (!(KNOWN_EVAL_PROVIDERS as readonly string[]).includes(provider)) {
    throw new EvalError("EVAL_PROVIDER_UNKNOWN", `unknown eval provider \`${provider}\``, {
      provider,
      known: [...KNOWN_EVAL_PROVIDERS]
    });
  }
  const profile = input.evalConfig?.providers[provider];
  if (profile === undefined) {
    throw new EvalError(
      "EVAL_PROVIDER_PROFILE_MISSING",
      `eval provider \`${provider}\` has no [eval.providers.${provider}] profile in ultrafuzz.toml`,
      { provider }
    );
  }
  return { provider, profile };
}

/** Suite path precedence: CLI flag > `ULTRAFUZZ_EVAL_CONFIG` > `[eval].eval_config` > default. */
export function resolveEvalSuitePath(input: {
  cliSuite?: string;
  env?: Record<string, string | undefined>;
  evalConfig?: EvalConfig;
  defaultPath?: string;
}): string {
  const env = input.env ?? process.env;
  return (
    firstNonEmpty(input.cliSuite) ??
    firstNonEmpty(env.ULTRAFUZZ_EVAL_CONFIG) ??
    firstNonEmpty(input.evalConfig?.evalConfig) ??
    input.defaultPath ??
    ".ultrafuzz/evals/bug-finding.yml"
  );
}

export interface CreateEvalReportersInput extends ResolveEvalProviderInput {
  evalRunId: string;
  policy: EvalReportingPolicy;
  fetchImpl?: typeof fetch;
  /** Collects reporter warnings; reporter failures never fail an eval run. */
  onWarning?: (diagnostic: RuntimeDiagnostic) => void;
}

/**
 * Build the active reporter list. `provider = "none"` yields an empty list —
 * the full plan→run→score→compare loop must keep working offline.
 * Missing credential env vars are a (publish-time) error here.
 */
export function createEvalReporters(input: CreateEvalReportersInput): EvalReporter[] {
  const resolved = resolveEvalProvider(input);
  if (resolved.provider === EVAL_PROVIDER_NONE) {
    return [];
  }
  const env = input.env ?? process.env;
  const profile = resolved.profile ?? {};
  const onWarning = input.onWarning ?? (() => undefined);
  switch (resolved.provider) {
    case "braintrust": {
      requireFixedEnvName(profile.apiKeyEnv, BRAINTRUST_CREDENTIAL_ENV, resolved.provider, "api_key_env");
      const apiKey = requireEnv(env, BRAINTRUST_CREDENTIAL_ENV, resolved.provider);
      const trustedApiUrl = firstNonEmpty(env[BRAINTRUST_TRUSTED_ENDPOINT_ENV]);
      const reporter = new BraintrustReporter({
        apiKey,
        project: profile.project ?? "ultrafuzz-evals",
        evalRunId: input.evalRunId,
        policy: input.policy,
        ...(profile.endpoint !== undefined ? { apiUrl: profile.endpoint } : {}),
        ...(trustedApiUrl !== undefined ? { trustedApiUrl } : {}),
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {})
      });
      return [guardReporter(reporter, onWarning)];
    }
    case "langsmith": {
      requireFixedEnvName(profile.apiKeyEnv, LANGSMITH_CREDENTIAL_ENV, resolved.provider, "api_key_env");
      const apiKey = requireEnv(env, LANGSMITH_CREDENTIAL_ENV, resolved.provider);
      if (profile.workspaceIdEnv !== undefined) {
        requireFixedEnvName(profile.workspaceIdEnv, LANGSMITH_WORKSPACE_ENV, resolved.provider, "workspace_id_env");
      }
      const workspaceId =
        profile.workspaceIdEnv !== undefined ? firstNonEmpty(env[LANGSMITH_WORKSPACE_ENV]) : undefined;
      const trustedEndpoint = firstNonEmpty(env[LANGSMITH_TRUSTED_ENDPOINT_ENV]);
      const reporter = new LangSmithReporter({
        apiKey,
        project: profile.project ?? "ultrafuzz-evals",
        evalRunId: input.evalRunId,
        policy: input.policy,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(profile.endpoint !== undefined ? { endpoint: profile.endpoint } : {}),
        ...(trustedEndpoint !== undefined ? { trustedEndpoint } : {}),
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {})
      });
      return [guardReporter(reporter, onWarning)];
    }
    default:
      throw new EvalError("EVAL_PROVIDER_UNKNOWN", `unknown eval provider \`${resolved.provider}\``, {
        provider: resolved.provider
      });
  }
}

function requireFixedEnvName(configured: string | undefined, expected: string, provider: string, field: string): void {
  if (configured === undefined) {
    throw new EvalError(
      "EVAL_PROVIDER_CREDENTIALS_MISSING",
      `[eval.providers.${provider}] must set ${field} to ${expected}`,
      { provider, field, expected }
    );
  }
  if (configured !== expected) {
    throw new EvalError(
      "EVAL_PROVIDER_CREDENTIAL_BINDING_INVALID",
      `[eval.providers.${provider}].${field} must be ${expected}`,
      { provider, field, expected }
    );
  }
}

function requireEnv(env: Record<string, string | undefined>, envName: string | undefined, provider: string): string {
  if (envName === undefined) {
    throw new EvalError(
      "EVAL_PROVIDER_CREDENTIALS_MISSING",
      `[eval.providers.${provider}] must set api_key_env to publish to ${provider}`,
      { provider }
    );
  }
  const value = env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new EvalError(
      "EVAL_PROVIDER_CREDENTIALS_MISSING",
      `environment variable ${envName} (from [eval.providers.${provider}].api_key_env) is not set`,
      { provider, envName }
    );
  }
  return value;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
