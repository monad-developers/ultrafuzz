import crypto from "node:crypto";

export const MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS = 4_096;
export const MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS = 4_096;

/**
 * Selector paths and selector keys are canonical when strictly ascending by
 * UTF-16 code unit. `localeCompare` order depends on the host locale, so a plan
 * sealed on one host could fail validation on another.
 */
export function isCanonicalSelectorOrder(values: readonly string[]): boolean {
  let previous: string | undefined;
  for (const value of values) {
    if (previous !== undefined && previous >= value) return false;
    previous = value;
  }
  return true;
}

/** Stable identity for one canonically ordered exact-path selector group. */
export function promptArtifactAuthorityPathSelectorId(paths: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(`ultrafuzz.prompt-artifact-authority.path-selector.v1\u0000${JSON.stringify(paths)}`)
    .digest("hex");
}
