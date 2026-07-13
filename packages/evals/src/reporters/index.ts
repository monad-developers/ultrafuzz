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
const BRAINTRUST_API_KEY_ENV = "BRAINTRUST_API_KEY";
const BRAINTRUST_ENDPOINT = "https://api.braintrust.dev";
const LANGSMITH_API_KEY_ENV = "LANGSMITH_API_KEY";
const LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
const LANGSMITH_WORKSPACE_ID_ENV = "LANGSMITH_WORKSPACE_ID";

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
      assertTrustedEnvName(profile.apiKeyEnv, BRAINTRUST_API_KEY_ENV, resolved.provider, "api_key_env");
      const apiUrl = trustedProviderEndpoint(profile.endpoint, BRAINTRUST_ENDPOINT, resolved.provider);
      const apiKey = requireEnv(env, BRAINTRUST_API_KEY_ENV, resolved.provider);
      const reporter = new BraintrustReporter({
        apiKey,
        project: profile.project ?? "ultrafuzz-evals",
        evalRunId: input.evalRunId,
        policy: input.policy,
        ...(apiUrl !== undefined ? { apiUrl } : {}),
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {})
      });
      return [guardReporter(reporter, onWarning)];
    }
    case "langsmith": {
      assertTrustedEnvName(profile.apiKeyEnv, LANGSMITH_API_KEY_ENV, resolved.provider, "api_key_env");
      if (profile.workspaceIdEnv !== undefined) {
        assertTrustedEnvName(profile.workspaceIdEnv, LANGSMITH_WORKSPACE_ID_ENV, resolved.provider, "workspace_id_env");
      }
      const endpoint = trustedProviderEndpoint(profile.endpoint, LANGSMITH_ENDPOINT, resolved.provider);
      const apiKey = requireEnv(env, LANGSMITH_API_KEY_ENV, resolved.provider);
      const workspaceId =
        profile.workspaceIdEnv === undefined ? undefined : firstNonEmpty(env[LANGSMITH_WORKSPACE_ID_ENV]);
      const reporter = new LangSmithReporter({
        apiKey,
        project: profile.project ?? "ultrafuzz-evals",
        evalRunId: input.evalRunId,
        policy: input.policy,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(endpoint !== undefined ? { endpoint } : {}),
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

function assertTrustedEnvName(configured: string | undefined, expected: string, provider: string, field: string): void {
  if (configured !== undefined && configured !== expected) {
    throw new EvalError(
      "EVAL_PROVIDER_PROFILE_UNSAFE",
      `[eval.providers.${provider}].${field} must use the provider-specific environment variable`,
      { provider, field, expected }
    );
  }
}

function trustedProviderEndpoint(
  configured: string | undefined,
  expected: string,
  provider: string
): string | undefined {
  if (configured === undefined) {
    return undefined;
  }
  try {
    const url = new URL(configured);
    if (
      url.origin === expected &&
      (url.pathname === "" || url.pathname === "/") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    ) {
      return expected;
    }
  } catch {
    // The provider-safe error below intentionally avoids reflecting the configured URL.
  }
  throw new EvalError(
    "EVAL_PROVIDER_PROFILE_UNSAFE",
    `[eval.providers.${provider}].endpoint must use the provider's official HTTPS API origin`,
    { provider }
  );
}

function requireEnv(env: Record<string, string | undefined>, envName: string, provider: string): string {
  const value = env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new EvalError(
      "EVAL_PROVIDER_CREDENTIALS_MISSING",
      `environment variable ${envName} is not set for ${provider}`,
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
