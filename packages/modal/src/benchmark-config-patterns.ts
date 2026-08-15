import { SAFE_GIT_REF_PATTERN_SOURCE } from "@ultrafuzz/security";

/** Lowercase HTTPS URL syntax whose authority cannot carry embedded credentials. */
export const MODAL_HTTPS_URL_PATTERN_SOURCE =
  "^https://(?=[^/?#]*[A-Za-z0-9])(?:[A-Za-z0-9._~:\\[\\]!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+(?:[/?#](?:[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*)?(?![\\s\\S])" as const;

/** Controller-owned repositories use the same credential-free HTTPS grammar. */
export const MODAL_GIT_URL_PATTERN_SOURCE = MODAL_HTTPS_URL_PATTERN_SOURCE;
export const MODAL_GIT_REF_PATTERN_SOURCE = SAFE_GIT_REF_PATTERN_SOURCE;

export const MODAL_GIT_URL_PATTERN = new RegExp(MODAL_GIT_URL_PATTERN_SOURCE, "u");
export const MODAL_GIT_REF_PATTERN = new RegExp(MODAL_GIT_REF_PATTERN_SOURCE, "u");
export const MODAL_HTTPS_URL_PATTERN = new RegExp(MODAL_HTTPS_URL_PATTERN_SOURCE, "u");
