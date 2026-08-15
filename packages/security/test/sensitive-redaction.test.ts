import assert from "node:assert/strict";
import test from "node:test";

import {
  containsSensitiveSecrets,
  redactSecretsInText,
  redactSecretsInValue,
  sensitiveEnvironmentValues
} from "../src/index.js";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("redaction recognizes maintained key, token, mnemonic, URL, and entropy patterns", () => {
  const fixtures = [
    `private key 0x${"1a".repeat(32)}`,
    `signing key: ${"2b".repeat(32)}`,
    "google AIzaSyB7w_ThisIsAFakeGoogleApiKey1234",
    "npm npm_0123456789abcdefghijklmnopqrstuv",
    "modal ak-0123456789abcdefghijklmnop",
    "modal as-0123456789abcdefghijklmnop",
    "oauth ya29.a0AfH6SMB0123456789abcdefghijklmnop",
    "rpc https://eth-mainnet.g.alchemy.com/v2/0123456789abcdefghijklmnopqrstuv",
    "rpc wss://mainnet.infura.io/v3/0123456789abcdefghijklmnopqrstuv",
    'api_key: "an-otherwise-low-entropy-value"',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.zyxwvutsrq",
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

test("ordinary prose, source identifiers, addresses, and checksums remain unchanged", () => {
  const safe = [
    "Agent YOLO execution remains enabled.",
    "function aReasonablyLongButNotRandomIdentifierForCoverage() {}",
    `address 0x${"12".repeat(20)}`,
    `bytes32 public constant DOMAIN = 0x${"34".repeat(32)};`,
    `transaction hash: 0x${"56".repeat(32)}`,
    `sha256: ${"ab".repeat(32)}`
  ].join("\n");
  assert.equal(redactSecretsInText(safe), safe);
});
