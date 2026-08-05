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
 * Builds the `GIT_CONFIG_*` overlay that authenticates exactly one remote.
 *
 * Returns an empty object whenever the credential does not cover `repo`, so an anonymous fetch stays
 * anonymous. The header is keyed to the full remote URL rather than to `https://github.com/`, so git
 * only attaches it to this one repository even though every reference shares the host.
 */
export function referenceGitCredentialEnv(
  credential: ReferenceGitCredential | undefined,
  repo: string,
  remote: string
): Record<string, string> {
  if (!referenceGitCredentialCoversRepo(credential, repo)) return {};
  const basic = Buffer.from(`x-access-token:${credential!.token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${remote}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    // Reset the multi-valued helper list after repository, global, and system config have been
    // loaded. Otherwise an ambient helper could answer after this narrowly scoped header is
    // rejected, silently widening the credential actually used for a private fetch.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    // A private fetch must fail rather than block forever on an interactive credential prompt when
    // the token is rejected, and it must never fall back to an ambient helper credential.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1"
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
