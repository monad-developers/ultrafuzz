import crypto from "node:crypto";

/** Stable identity for one canonically ordered exact-path selector group. */
export function promptArtifactAuthorityPathSelectorId(paths: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(`ultrafuzz.prompt-artifact-authority.path-selector.v1\u0000${JSON.stringify(paths)}`)
    .digest("hex");
}
