import assert from "node:assert/strict";
import test from "node:test";

import {
  containsSensitiveSecrets,
  isSensitiveEnvironmentName,
  matchesRedactedText,
  redactSecretsInText,
  redactSecretsInValue,
  redactedTextSpanCodePointLengths,
  sensitiveEnvironmentValues
} from "../src/index.js";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("sensitive environment names cover the provider credential vocabulary", () => {
  for (const name of [
    "CUSTOM_AUTH",
    "AWS_ACCESS_KEY_ID",
    "SSH_PRIVATE_KEY",
    "DATABASE_PASSWD",
    "CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AUTHORIZATION"
  ]) {
    assert.equal(isSensitiveEnvironmentName(name), true, name);
  }
  assert.equal(isSensitiveEnvironmentName("FOUNDRY_PROFILE"), false);
});

test("redaction recognizes maintained key, token, mnemonic, URL, and entropy patterns", () => {
  const fixtures = [
    `private key 0x${"1a".repeat(32)}`,
    `signing key: ${"2b".repeat(32)}`, // gitleaks:allow -- fake credential fixture for the redaction tests
    "google AIzaSyB7w_ThisIsAFakeGoogleApiKey1234", // gitleaks:allow -- fake credential fixture for the redaction tests
    // Real npm tokens are npm_ plus exactly 36 characters; secretlint encodes
    // the true vendor format, so the fixture uses it.
    "npm npm_0123456789abcdefghijklmnopqrstuvwxyz", // gitleaks:allow -- fake credential fixture for the redaction tests
    "modal ak-0123456789abcdefghijklmnop", // gitleaks:allow -- fake credential fixture for the redaction tests
    "modal as-0123456789abcdefghijklmnop",
    "oauth ya29.a0AfH6SMB0123456789abcdefghijklmnop", // gitleaks:allow -- fake credential fixture for the redaction tests
    "rpc https://eth-mainnet.g.alchemy.com/v2/0123456789abcdefghijklmnopqrstuv",
    "rpc wss://mainnet.infura.io/v3/0123456789abcdefghijklmnopqrstuv", // gitleaks:allow -- fake credential fixture for the redaction tests
    'api_key: "an-otherwise-low-entropy-value"',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.zyxwvutsrq", // gitleaks:allow -- fake credential fixture for the redaction tests
    `wallet words ${mnemonic}`,
    "opaque aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wXyZ1_cD3eF5gH7jK9mP2q"
  ];

  for (const fixture of fixtures) {
    assert.equal(containsSensitiveSecrets(fixture), true, fixture);
    const redacted = redactSecretsInText(fixture);
    assert.match(redacted, /<redacted>/u, fixture);
    assert.notEqual(redacted, fixture, fixture);
  }
});

test("generic forty-hex secrets are redacted without treating labeled Git and digest values as secrets", () => {
  const bare = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(redactSecretsInText(`leaked ${bare}`), "leaked <redacted>");
  assert.equal(redactSecretsInText(`commit = "${bare}"`), `commit = "${bare}"`);
  assert.equal(redactSecretsInText(`source_ref: ${bare}`), `source_ref: ${bare}`);
  assert.equal(redactSecretsInText(`sha1 ${bare}`), `sha1 ${bare}`);
  assert.equal(redactSecretsInText(`digest=${"a".repeat(64)}`), `digest=${"a".repeat(64)}`);
});

test("exact in-memory secrets are redacted even when their format is unknown", () => {
  const exact = "correct horse battery staple";
  assert.equal(redactSecretsInText(`before ${exact} after`, undefined, [exact]), "before <redacted> after");
  assert.deepEqual(redactSecretsInValue({ message: `failure: ${exact}`, safe: "retained" }, undefined, [exact]), {
    message: "failure: <redacted>",
    safe: "retained"
  });
});

test("exact secret matching ignores collision-prone short values", () => {
  assert.equal(redactSecretsInText("ordinary example text", undefined, ["e"]), "ordinary example text");
  assert.deepEqual(sensitiveEnvironmentValues({ OPENAI_API_KEY: "short" }), []);
});

test("persisted redaction matches rotated replay without hiding changed non-secret context", () => {
  const length = (value: string): number => [...value].length;
  const secret = "old credential";
  assert.equal(matchesRedactedText("provider echoed <redacted>", `provider echoed ${secret}`, [length(secret)]), true);
  assert.equal(
    matchesRedactedText("provider echoed <redacted>", `provider echoed ${secret}; changed context`, [length(secret)]),
    false
  );
  assert.equal(matchesRedactedText("<redacted> failed", `${secret} failed`, [length(secret)]), true);
  assert.equal(matchesRedactedText("<redacted> failed", `changed ${secret} failed`, [length(secret)]), false);
  assert.equal(matchesRedactedText("provider <redacted> failed", `provider ${secret} failed`, [length(secret)]), true);
  assert.equal(
    matchesRedactedText("provider <redacted> failed", `provider ${secret}; changed failed`, [length(secret)]),
    false
  );
  assert.deepEqual(redactedTextSpanCodePointLengths("<redacted> and <redacted>", "first secret and second secret"), [
    length("first secret"),
    length("second secret")
  ]);
  assert.equal(
    redactedTextSpanCodePointLengths(`${"<redacted>x".repeat(65)}z`, `${"secretxx".repeat(65)}z`),
    undefined
  );
  assert.equal(matchesRedactedText("ordinary failure", "ordinary failure", []), true);
  assert.equal(matchesRedactedText("ordinary failure", "changed failure", []), false);
});

test("persisted redaction can match a retained prefix when the storage boundary truncated it", () => {
  assert.equal(
    matchesRedactedText("prefix <redacted> retained", "prefix old-secret retained unpersisted", [10], {
      allowObservedSuffix: true
    }),
    true
  );
  assert.equal(
    matchesRedactedText("prefix <redacted> retained", "prefix old-secret changed unpersisted", [10], {
      allowObservedSuffix: true
    }),
    false
  );
});

test("recursive redaction handles own __proto__ keys without mutating prototypes", () => {
  const parsed = JSON.parse(
    '{"__proto__":{"message":"token=otherwise-unknown-value"},"nested":{"password":"value"}}'
  ) as Record<string, unknown>;
  const redacted = redactSecretsInValue(parsed) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
  assert.equal(Object.hasOwn(redacted, "__proto__"), true);
  assert.deepEqual(redacted["__proto__"], { message: "token=<redacted>" });
  assert.deepEqual(redacted.nested, { password: "<redacted>" });
  assert.equal(Object.hasOwn(Object.prototype, "message"), false);

  const exotic = new (class CredentialContainer {
    token = "token=otherwise-unknown-value";
  })();
  assert.equal(redactSecretsInValue(exotic), exotic);
});

test("sensitive environment collection combines configured names and conventional credential names", () => {
  const values = sensitiveEnvironmentValues(
    {
      OPENAI_API_KEY: "openai-exact",
      CUSTOM_PROVIDER_VALUE: "custom-exact",
      KIMI_BASE_URL: "https://api.example.invalid/v1",
      ORDINARY_VALUE: "ordinary",
      TINY_TOKEN: "short"
    },
    ["CUSTOM_PROVIDER_VALUE", "KIMI_BASE_URL"]
  );
  assert.deepEqual(values, ["custom-exact", "openai-exact"]);
});

test("secretlint library findings cover vendor formats the hand-rolled patterns used to own", () => {
  const fixtures = [
    "ghp_AbCdEf1234567890AbCdEf1234567890AbCd", // gitleaks:allow -- fixed placeholder asserted on by the redaction tests
    "gho_AbCdEf1234567890AbCdEf1234567890AbCd", // gitleaks:allow -- fake credential fixture for the redaction tests
    `github_pat_${"A1".repeat(41)}`, // gitleaks:allow -- fake credential fixture for the redaction tests
    "glpat-a1B2c3D4e5F6g7H8i9J0", // gitleaks:allow -- fake credential fixture for the redaction tests
    `hf_${"a".repeat(34)}`,
    "npm_AbCdEf1234567890AbCdEf1234567890AbCd", // gitleaks:allow -- fake credential fixture for the redaction tests
    "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt", // gitleaks:allow -- fake credential fixture for the redaction tests
    "https://hooks.slack.com/services/T12345/B98765/abcdefghijklmnop",
    "https://admin:hunter2hunter2@example.com/x", // gitleaks:allow -- fake credential fixture for the redaction tests
    "postgres://svc:passw0rdpass@db.internal:5432/main", // gitleaks:allow -- fake credential fixture for the redaction tests
    `-----BEGIN RSA PRIVATE KEY-----\nMIIEow${"A".repeat(120)}\n-----END RSA PRIVATE KEY-----`
  ];
  for (const fixture of fixtures) {
    assert.equal(containsSensitiveSecrets(fixture, [], "positive-only"), true, fixture);
    const redacted = redactSecretsInText(fixture);
    assert.match(redacted, /<redacted>/u, fixture);
    assert.notEqual(redacted, fixture, fixture);
  }
});

test("positive-only scans skip the speculative heuristics that killed publication runs", () => {
  // The five #819 shapes: three high-entropy identifiers, a key-name sentence,
  // and pinned 40-hex dependency commits. None contains a secret; each killed
  // a real campaign run when the publication gate scanned speculatively.
  const prose = [
    "IExampleVaultCore.setAuthority/togglePause/transferOwnership",
    "testFuzz_MaximumPrincipalForGrossIsSafeAndBounded",
    "IExampleBook.NativeExecInstruction.POST_ONLY",
    "For every token:\n  contract token balance >= sum of credits",
    `Pinned dependencies: \`${"da0e9c1b".repeat(5)}\`, \`${"1a2b3c4d".repeat(5)}\`.`
  ];
  for (const fixture of prose) {
    assert.equal(containsSensitiveSecrets(fixture, [], "positive-only"), false, fixture);
  }
  // Default ("all") callers rewrite for display, where over-redaction is
  // cheap; the heuristics stay on for them.
  assert.equal(containsSensitiveSecrets("For every token:\n  balance >= credits"), true);
  assert.equal(containsSensitiveSecrets(`leaked ${"0123456789abcdef0123456789abcdef01234567"}`), true);
});

test("kebab-case English never matches the modal key patterns while opaque tokens stay detected", () => {
  // #822: the ak-/as- suffix class must not admit "-", or hyphenated prose
  // ("...-treated-as-private-...") reads as a credential in every scan mode.
  const prose = [
    "policy.record-treated-as-private-to-the-service",
    "classified-as-internal-only-configuration-value",
    "resources-marked-ak-restricted-to-the-owner-role"
  ];
  for (const fixture of prose) {
    assert.equal(containsSensitiveSecrets(fixture), false, fixture);
    assert.equal(containsSensitiveSecrets(fixture, [], "positive-only"), false, fixture);
  }
  for (const token of ["ak-AbCdEf1234567890XyZwVuTs", "as-9f2b7c1d4e6a8b0c3d5e7f90", "ak-AbCdEf_1234567890_XyZwVu"]) {
    assert.equal(containsSensitiveSecrets(token, [], "positive-only"), true, token);
  }
});

test("the English word bearer does not redact following prose while Bearer tokens stay redacted", () => {
  // #820: the Bearer rule is case-insensitive, so OpenZeppelin's AccessControl
  // docs — "the role bearer (i.e. `account`)" — must stay readable.
  const prose = "grant it to the role bearer (i.e. `account`) explicitly";
  assert.equal(redactSecretsInText(prose), prose);
  assert.equal(
    redactSecretsInText("Authorization: Bearer AbCdEf1234567890AbCdEf1234567890", undefined, [], "positive-only"), // gitleaks:allow -- fake credential fixture for the redaction tests
    "Authorization: Bearer <redacted>"
  );
});

test("in-content secretlint-disable comments cannot suppress detection", () => {
  // Scanned content is agent-controlled; the filter-comments rule is disabled
  // so contaminated output cannot exempt itself from the fail-closed gate.
  const fixture = "// secretlint-disable\nghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fixed placeholder asserted on by the redaction tests
  assert.equal(containsSensitiveSecrets(fixture, [], "positive-only"), true);
});

test("ordinary prose, source identifiers, addresses, and checksums remain unchanged", () => {
  const safe = [
    "Agent YOLO execution remains enabled.",
    "function aReasonablyLongButNotRandomIdentifierForCoverage() {}",
    "read process.env.ULTRAFUZZ_CONFIG_PATH before launch",
    `address 0x${"12".repeat(20)}`,
    `bytes32 public constant DOMAIN = 0x${"34".repeat(32)};`,
    `transaction hash: 0x${"56".repeat(32)}`,
    `sha256: ${"ab".repeat(32)}`
  ].join("\n");
  assert.equal(redactSecretsInText(safe), safe);
});
