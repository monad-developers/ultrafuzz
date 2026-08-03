export const AGENT_POSTFLIGHT_FAILURE_PREFIX = "ultrafuzz-agent-postflight:" as const;

export const AGENT_POSTFLIGHT_FAILURE_CODES = [
  "workspace-provenance-postflight",
  "artifact-preparation-postflight",
  "source-attestation-persistence-postflight",
  "markdown-materialization-postflight",
  "dedupe-materialization-postflight",
  "final-report-materialization-postflight",
  "findings-normalization-postflight",
  "report-provenance-normalization-postflight",
  "generated-test-manifest-normalization-postflight",
  "generated-test-companion-materialization-postflight",
  "artifact-validation-postflight"
] as const;

export type AgentPostflightFailureCode = (typeof AGENT_POSTFLIGHT_FAILURE_CODES)[number];

export type AgentPostflightRunner = <T>(
  code: AgentPostflightFailureCode,
  operation: () => T | Promise<T>
) => Promise<T>;

export class AgentPostflightError extends Error {
  readonly code: AgentPostflightFailureCode;
  readonly details!: Readonly<{ failureRetryable: false }>;
  readonly usage?: unknown;

  constructor(code: AgentPostflightFailureCode, cause: unknown, usage?: unknown) {
    super(`${AGENT_POSTFLIGHT_FAILURE_PREFIX}${code}: ${errorDetail(cause)}`, { cause });
    this.name = "AgentPostflightError";
    this.code = code;
    Object.defineProperty(this, "details", {
      configurable: false,
      enumerable: true,
      value: Object.freeze({ failureRetryable: false }),
      writable: false
    });
    if (usage !== undefined) {
      Object.defineProperty(this, "usage", {
        configurable: false,
        enumerable: true,
        value: usage,
        writable: false
      });
    }
  }
}

export async function runAgentWithPostflight<T>(
  generate: () => Promise<T>,
  postflight: (result: T, run: AgentPostflightRunner) => void | Promise<void>
): Promise<T> {
  // Keep provider failures outside the postflight boundary so their identity,
  // retry behavior, and provider-specific usage handling remain unchanged.
  const result = await generate();
  const usage = successfulAgentUsage(result);
  const run: AgentPostflightRunner = async (code, operation) => {
    try {
      return await operation();
    } catch (error) {
      throw new AgentPostflightError(code, error, usage);
    }
  };
  await postflight(result, run);
  return result;
}

export function agentPostflightFailureCode(value: unknown): AgentPostflightFailureCode | undefined {
  const message = errorMessage(value);
  if (message === undefined) return undefined;
  const serializedPrefix = `AgentPostflightError: ${AGENT_POSTFLIGHT_FAILURE_PREFIX}`;
  const markerBody = message.startsWith(AGENT_POSTFLIGHT_FAILURE_PREFIX)
    ? message.slice(AGENT_POSTFLIGHT_FAILURE_PREFIX.length)
    : message.startsWith(serializedPrefix)
      ? message.slice(serializedPrefix.length)
      : undefined;
  if (markerBody === undefined) return undefined;
  for (const code of AGENT_POSTFLIGHT_FAILURE_CODES) {
    if (markerBody === code || markerBody.startsWith(`${code}:`)) return code;
  }
  return undefined;
}

function successfulAgentUsage(value: unknown): unknown {
  const usage = propertyValue(value, "usage");
  return usage ?? propertyValue(value, "totalUsage");
}

function propertyValue(value: unknown, key: "usage" | "totalUsage"): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

function errorDetail(value: unknown): string {
  return errorMessage(value) ?? (typeof value === "string" ? value : "postflight operation failed");
}
