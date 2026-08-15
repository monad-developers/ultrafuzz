/**
 * Controller-owned Git operations use an HTTPS-only transport policy. This is
 * deliberately scoped to Ultrafuzz's own fetch/clone helpers; it is not an
 * agent command or network allowlist and does not alter unrestricted agent
 * execution.
 */
export const CONTROLLER_GIT_PROTOCOL_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never"
] as const;

export const SAFE_GIT_REF_PATTERN_SOURCE =
  "^(?!.*(?:\\.\\.|//|@\\{|[\\\\~^:?*\\[\\]\\s]))(?!.*(?:^|/)\\.)(?!.*\\.lock(?:/|$))(?!.*[/.]$)[A-Za-z0-9][A-Za-z0-9._/-]{0,255}(?![\\s\\S])" as const;

const safeGitRef = new RegExp(SAFE_GIT_REF_PATTERN_SOURCE, "u");
const unsafeRemotePrefix = /^(?:ext|file)::/iu;

export function controllerGitArguments(args: readonly string[]): string[] {
  return [...CONTROLLER_GIT_PROTOCOL_CONFIG, ...args];
}

export function assertSafeGitOperand(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.startsWith("-") ||
    value.includes("\0") ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    }) ||
    unsafeRemotePrefix.test(value)
  ) {
    throw new Error(`${label} is not a safe Git operand`);
  }
  return value;
}

export function assertSafeGitRef(value: string, label = "Git ref"): string {
  assertSafeGitOperand(value, label);
  if (!safeGitRef.test(value)) throw new Error(`${label} is not a canonical Git ref or commit`);
  return value;
}

export function assertHttpsGitRemote(value: string, label = "Git repository"): string {
  assertSafeGitOperand(value, label);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an HTTPS URL`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    parsed.href !== value
  ) {
    throw new Error(`${label} must be a canonical credential-free HTTPS URL`);
  }
  return value;
}
