import { setTimeout as delay } from "node:timers/promises";

// Each ephemeral workflow workspace is installed with `--package-lock=false`, so npm
// re-resolves every unpinned transitive dependency on each install. That resolution
// can land on a version published seconds earlier, whose packument entry is already
// live but whose tarball has not reached the registry CDN edge the container talks
// to. npm reports the gap as a hard E404 and, at run submission, the whole run dies
// before its first task node. The gap closes on its own within minutes, so wait it
// out: a minute of retries is far cheaper than losing a multi-hour campaign.
const TRANSIENT_NPM_INSTALL_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 45_000];

const TRANSIENT_NPM_REGISTRY_PATTERNS: readonly RegExp[] = [
  // Scoped to tarball URLs (`/-/name-version.tgz`) on purpose. A 404 on a package
  // or version name is a permanent resolution error, and retrying it only delays
  // the real failure by a minute while reporting the same thing.
  /404\s+Not Found\s*-\s*GET\s+\S+\/-\/\S+\.tgz/iu,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ERR_SOCKET_TIMEOUT)\b/u,
  /socket hang up|network timeout|request to \S+ failed/iu,
  // Registry-side 5xx, which npm surfaces as `npm error 503 Service Unavailable`.
  /npm error 5\d\d\b/iu
];

/**
 * Whether a failed npm install can be expected to succeed on a later attempt without
 * anything changing but time. Deliberately conservative: anything unrecognized is
 * treated as permanent so a genuine dependency error still fails fast.
 */
export function isTransientNpmRegistryFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  // A cancelled or timed-out install is not a registry problem. Retrying it either
  // races the abort that just fired or restarts a budget that has already expired.
  if (record.killed === true || record.name === "AbortError" || typeof record.signal === "string") {
    return false;
  }
  const text = [record.stderr, record.stdout, record.message].filter((part) => typeof part === "string").join("\n");
  return TRANSIENT_NPM_REGISTRY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Run an npm install, retrying it while the registry reports a transient failure.
 * Rejects with the last error once the retries are exhausted, so the caller still
 * reports the registry's own diagnostic rather than a wrapper's.
 */
export async function withTransientNpmRegistryRetry<T>(
  install: () => Promise<T>,
  control: { signal?: AbortSignal; onRetry?: (attempt: number, error: unknown) => void } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await install();
    } catch (error) {
      const waitMs = TRANSIENT_NPM_INSTALL_RETRY_DELAYS_MS[attempt];
      if (waitMs === undefined || !isTransientNpmRegistryFailure(error)) {
        throw error;
      }
      control.onRetry?.(attempt + 1, error);
      await delay(waitMs, undefined, control.signal === undefined ? {} : { signal: control.signal });
    }
  }
}
