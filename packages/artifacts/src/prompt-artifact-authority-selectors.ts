import crypto from "node:crypto";

export const MAX_PROMPT_ARTIFACT_AUTHORITY_SELECTORS = 4_096;
export const MAX_PROMPT_ARTIFACT_AUTHORITY_PATHS = 4_096;

/** Stable identity for one canonically ordered exact-path selector group. */
export function promptArtifactAuthorityPathSelectorId(paths: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(`ultrafuzz.prompt-artifact-authority.path-selector.v1\u0000${JSON.stringify(paths)}`)
    .digest("hex");
}
