import type { EvalConfig } from "@ultrafuzz/config";

import { EvalError } from "../utils.js";

export const EVAL_PROVIDER_NONE = "none";
export const KNOWN_EVAL_PROVIDERS = [EVAL_PROVIDER_NONE] as const;

export interface ResolveEvalProviderInput {
  /** `--provider` CLI flag; highest precedence. */
  cliProvider?: string;
  env?: Record<string, string | undefined>;
  evalConfig?: EvalConfig;
}

export interface ResolvedEvalProvider {
  provider: string;
}

/**
 * Provider precedence: CLI flag > `ULTRAFUZZ_EVAL_PROVIDER` > `[eval].provider`.
 * Only local reporting is supported. Historical provider profiles remain inert;
 * validate the final selection so `--provider none` can override an old config
 * without reading its credentials or contacting an external service.
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
  throw new EvalError(
    "EVAL_PROVIDER_UNKNOWN",
    `unsupported eval provider \`${provider}\`; only \`none\` is supported for local reporting`,
    {
      provider,
      known: [...KNOWN_EVAL_PROVIDERS]
    }
  );
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

function firstNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
