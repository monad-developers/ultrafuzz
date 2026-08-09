/**
 * Portable repository URL syntax shared by the canonical JSON Schema and retained Zod shape.
 *
 * This is deliberately a lexical contract rather than a platform URL-parser delegation: it
 * requires an ASCII scheme and authority, rejects normalization-prone characters, and permits
 * only complete percent escapes. Repository reachability and trust remain contextual concerns.
 */
export const MODAL_GIT_URL_PATTERN_SOURCE =
  "^[A-Za-z][A-Za-z0-9+.-]*://(?=[^/?#]*[A-Za-z0-9])(?:[A-Za-z0-9._~:\\[\\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+(?:[/?#](?:[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*)?$" as const;

/** Lowercase HTTPS URL syntax whose authority cannot carry embedded credentials. */
export const MODAL_HTTPS_URL_PATTERN_SOURCE =
  "^https://(?=[^/?#]*[A-Za-z0-9])(?:[A-Za-z0-9._~:\\[\\]!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+(?:[/?#](?:[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*)?$" as const;

export const MODAL_GIT_URL_PATTERN = new RegExp(MODAL_GIT_URL_PATTERN_SOURCE, "u");
export const MODAL_HTTPS_URL_PATTERN = new RegExp(MODAL_HTTPS_URL_PATTERN_SOURCE, "u");
