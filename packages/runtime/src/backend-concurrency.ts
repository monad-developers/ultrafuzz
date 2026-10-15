import { availableParallelism } from "node:os";

/** Resolve on the executing controller, once per workflow load, rather than on the planning host. */
export function renderBackendConcurrencyContext(
  configuredConcurrencyLimit: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
  availableVcpus: number = availableParallelism()
): string {
  const limit = Number(env.ULTRAFUZZ_MAX_CONCURRENCY ?? configuredConcurrencyLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("backend concurrency limit must be a positive safe integer");
  }
  const workers = Math.max(1, Math.min(availableVcpus, limit));
  return [
    "## Backend Concurrency",
    "",
    `- Configured concurrency limit: ${String(limit)}.`,
    `- Available vCPUs: ${String(availableVcpus)}.`,
    `- Backend worker limit: ${String(workers)} = max(1, min(available_vcpus, configured_concurrency_limit)).`,
    `- Use at most ${String(workers)} concurrent workers in total across this task's nested backend processes, including setup, smoke, replay, and final fuzzing.`,
    "- This limit takes precedence over profile or task defaults requesting the whole host."
  ].join("\n");
}
