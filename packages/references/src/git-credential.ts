import os from "node:os";

/**
 * The explicit read credential contract for pinned references that live in private repositories.
 *
 * A pinned reference is normally fetched anonymously, which is the only safe default: public
 * references must never carry a credential they do not need. Projects may also declare references
 * to private repositories, which makes *which* remote may receive a token the security-relevant
 * decision, not merely whether a token exists.
 *
 * The contract is therefore two explicit values rather than one:
 *
 * - `ULTRAFUZZ_REFERENCE_GITHUB_TOKEN` is the short-lived token itself.
 * - `ULTRAFUZZ_REFERENCE_GITHUB_REPOS` enumerates the `owner/repo` values it may be sent to.
 *
 * A token with no allowlist is inert, and a reference outside the allowlist is still fetched
 * anonymously even while a token is present. So a token minted for one private repository can never
 * be leaked to an unrelated remote just because a catalog happens to name it.
 *
 * The token reaches git through `GIT_CONFIG_*` environment variables carrying an `http.<url>.
 * extraheader` setting, keyed to the exact remote URL. It is never written into the remote URL, a
 * command argument, a config file, or a credential helper, so it cannot surface in `git remote -v`,
 * a process listing, a cache manifest, or an error that echoes the failing command.
 */

/** Environment variable holding the short-lived read token. */
export const REFERENCE_GITHUB_TOKEN_ENV = "ULTRAFUZZ_REFERENCE_GITHUB_TOKEN";

/** Environment variable enumerating the `owner/repo` values the token may be sent to. */
export const REFERENCE_GITHUB_REPOS_ENV = "ULTRAFUZZ_REFERENCE_GITHUB_REPOS";

/** Replacement text used wherever the token could otherwise reach a message or a log. */
export const REFERENCE_TOKEN_REDACTION = "[reference-token]";

export interface ReferenceGitCredential {
  /** The token value. Never serialize, log, or persist this. */
  readonly token: string;
  /** The exact `owner/repo` values this token may be sent to. */
  readonly repos: ReadonlySet<string>;
}

/**
 * Reads the declared credential, or `undefined` when references are fetched anonymously.
 *
 * A token without an allowlist is deliberately treated as absent rather than as an error: an
 * anonymous fetch of a public reference is the correct behavior, and failing the whole catalog
 * because an unused credential was half-configured would turn a harmless misconfiguration into an
 * outage. A reference that genuinely needs the credential still fails loudly at its own fetch.
 */
export function referenceGitCredential(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ReferenceGitCredential | undefined {
  const token = env[REFERENCE_GITHUB_TOKEN_ENV]?.trim();
  if (token === undefined || token === "") return undefined;
  const repos = new Set(
    (env[REFERENCE_GITHUB_REPOS_ENV] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "")
  );
  if (repos.size === 0) return undefined;
  return { token, repos };
}

/** Whether this credential may be sent to `owner/repo`. */
export function referenceGitCredentialCoversRepo(
  credential: ReferenceGitCredential | undefined,
  repo: string
): boolean {
  return credential !== undefined && credential.repos.has(repo);
}

/**
 * Builds the complete, isolated environment for a Git subprocess.
 *
 * Every inherited `GIT_*` variable is removed first. Global and system configuration are replaced
 * with the platform null device, credential helpers and prompts are disabled, and only then is an
 * allowlisted exact-remote header added. Consequently an uncovered reference is genuinely
 * anonymous even on a host with ambient helpers, injected `GIT_CONFIG_*` entries, or global HTTP
 * extraheaders. The same returned environment must be used for the fetch and for later object reads:
 * a filtered Git repository may lazily contact its promisor remote from `cat-file` or `show`.
 */
export function referenceGitCredentialEnv(
  credential: ReferenceGitCredential | undefined,
  repo: string,
  remote: string,
  inheritedEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    // Windows environment names are case-insensitive. Normalize before filtering so a caller cannot
    // preserve a Git control (or a raw reference credential) merely by changing its key's casing.
    const normalizedKey = key.toUpperCase();
    if (
      !normalizedKey.startsWith("GIT_") &&
      normalizedKey !== REFERENCE_GITHUB_TOKEN_ENV &&
      normalizedKey !== REFERENCE_GITHUB_REPOS_ENV &&
      value !== undefined
    ) {
      env[key] = value;
    }
  }

  const config: Array<[string, string]> = [];
  if (referenceGitCredentialCoversRepo(credential, repo)) {
    const basic = Buffer.from(`x-access-token:${credential!.token}`, "utf8").toString("base64");
    config.push([`http.${remote}.extraheader`, `AUTHORIZATION: basic ${basic}`]);
  }
  // Reset the multi-valued helper list after repository configuration is loaded. The global and
  // system files are already disabled below, but the explicit reset also protects commands that
  // run after `remote add` has created the temporary repository configuration.
  config.push(["credential.helper", ""]);
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }

  return {
    ...env,
    GIT_CONFIG_COUNT: String(config.length),
    // A private fetch must fail rather than block forever on an interactive credential prompt when
    // the token is rejected, and it must never fall back to an ambient helper credential.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull
  };
}

/**
 * Removes the token, and the derived basic-auth material, from text that may be surfaced.
 *
 * Both forms are redacted because the base64 `x-access-token:<token>` encoding is what actually
 * travels in the git configuration, so a diagnostic that echoes the environment would otherwise
 * disclose a recoverable credential even though the raw token never appears.
 */
export function redactReferenceGitCredential(text: string, credential: ReferenceGitCredential | undefined): string {
  if (credential === undefined || credential.token === "") return text;
  const basic = Buffer.from(`x-access-token:${credential.token}`, "utf8").toString("base64");
  return text.split(credential.token).join(REFERENCE_TOKEN_REDACTION).split(basic).join(REFERENCE_TOKEN_REDACTION);
}
