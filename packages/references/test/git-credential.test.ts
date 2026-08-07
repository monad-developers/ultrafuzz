import assert from "node:assert/strict";
import test from "node:test";

import {
  REFERENCE_GITHUB_REPOS_ENV,
  REFERENCE_GITHUB_TOKEN_ENV,
  REFERENCE_TOKEN_REDACTION,
  redactReferenceGitCredential,
  referenceGitCredential,
  referenceGitCredentialCoversRepo,
  referenceGitCredentialEnv
} from "../src/git-credential.js";

const TOKEN = "ghs_examplereferencetokenvalue0123456789";
const PRIVATE_REPO = "example/private-reference";
const PRIVATE_REMOTE = `https://github.com/${PRIVATE_REPO}.git`;

function credentialEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [REFERENCE_GITHUB_TOKEN_ENV]: TOKEN,
    [REFERENCE_GITHUB_REPOS_ENV]: PRIVATE_REPO,
    ...overrides
  };
}

test("a credential requires both a token and an explicit repository allowlist", () => {
  assert.deepEqual(referenceGitCredential(credentialEnv())?.token, TOKEN);
  assert.deepEqual([...referenceGitCredential(credentialEnv())!.repos], [PRIVATE_REPO]);

  // A token with no allowlist is inert rather than an error: an anonymous fetch of a public
  // reference is correct, and a half-configured credential must not fail the whole catalog.
  for (const [label, overrides] of [
    ["no token", { [REFERENCE_GITHUB_TOKEN_ENV]: undefined }],
    ["blank token", { [REFERENCE_GITHUB_TOKEN_ENV]: "   " }],
    ["no allowlist", { [REFERENCE_GITHUB_REPOS_ENV]: undefined }],
    ["blank allowlist", { [REFERENCE_GITHUB_REPOS_ENV]: " , ,, " }]
  ] as Array<[string, Record<string, string | undefined>]>) {
    assert.equal(referenceGitCredential(credentialEnv(overrides)), undefined, label);
  }
});

test("a credential is only ever attached to a remote its allowlist names", () => {
  const credential = referenceGitCredential(credentialEnv())!;
  assert.ok(referenceGitCredentialCoversRepo(credential, PRIVATE_REPO));

  // The security property: a token minted for one private repository must not be sent to any other
  // remote, even though every reference in the catalog shares the github.com host. The shipped
  // vulnerability database is public, so it must stay anonymous even while a credential is present.
  for (const other of ["crytic/properties", "monad-developers/ultrafuzz", "aviggiano/web3-vulnerability-database"]) {
    assert.equal(referenceGitCredentialCoversRepo(credential, other), false, other);
    assert.deepEqual(
      referenceGitCredentialEnv(credential, other, `https://github.com/${other}.git`),
      {},
      `${other} must be fetched anonymously`
    );
  }
  assert.deepEqual(referenceGitCredentialEnv(undefined, PRIVATE_REPO, PRIVATE_REMOTE), {});
});

test("the token travels only as a git config header keyed to the exact remote", () => {
  const credential = referenceGitCredential(credentialEnv())!;
  const env = referenceGitCredentialEnv(credential, PRIVATE_REPO, PRIVATE_REMOTE);

  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, `http.${PRIVATE_REMOTE}.extraheader`);
  assert.equal(
    env.GIT_CONFIG_VALUE_0,
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`
  );
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  // An unusable token must fail rather than hang on a prompt or silently fall back to an ambient
  // helper credential that could carry more privilege than this token was minted with.
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ASKPASS, "");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");

  // The raw token is never a standalone value, so it cannot reach a remote URL or an argv entry via
  // this overlay; only the base64 basic-auth encoding appears, inside the header value.
  assert.equal(
    Object.values(env).some((value) => value.includes(TOKEN)),
    false
  );
});

test("both the token and its derived basic-auth encoding are redacted from surfaced text", () => {
  const credential = referenceGitCredential(credentialEnv())!;
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

  const message = `git command failed: remote rejected AUTHORIZATION: basic ${basic} for token ${TOKEN}`;
  const redacted = redactReferenceGitCredential(message, credential);
  assert.equal(redacted.includes(TOKEN), false, "the raw token must not survive");
  assert.equal(redacted.includes(basic), false, "the recoverable basic-auth encoding must not survive");
  assert.equal(redacted.includes(REFERENCE_TOKEN_REDACTION), true);

  // Redaction is a no-op without a credential, so anonymous failures keep their exact diagnostics.
  assert.equal(redactReferenceGitCredential(message, undefined), message);
});
