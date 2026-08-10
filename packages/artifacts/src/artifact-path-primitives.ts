import { z } from "zod/v4";

/**
 * The one portable relative-path grammar shared by planned outputs, manifests,
 * verification markers, and artifact contracts. Filesystem containment and
 * symlink checks remain contextual runtime concerns.
 */
export const CANONICAL_ARTIFACT_PATH_SEGMENT_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._@+-]{1,128}$/u;
export const CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN =
  "^(?!\\.{1,2}(?:\\/|$))[A-Za-z0-9._@+-]{1,128}(?:\\/(?!\\.{1,2}(?:\\/|$))[A-Za-z0-9._@+-]{1,128})*$" as const;

export const canonicalArtifactRelativePathSchema = z
  .string()
  .regex(new RegExp(CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN, "u"), {
    message: "Path must use the canonical artifact-relative path grammar"
  });
