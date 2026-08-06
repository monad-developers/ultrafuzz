import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containsSecretValueRepresentation,
  redactSecretValueRepresentations,
  secretValueRepresentations
} from "../src/index.js";

test("exact secret representation policy covers standard reversible encodings", () => {
  const secret = "credential value/with+symbols";
  const representations = secretValueRepresentations(secret);

  assert.ok(representations.includes(secret));
  assert.ok(representations.includes(Buffer.from(secret).toString("base64")));
  assert.ok(representations.includes(Buffer.from(secret).toString("base64url")));
  assert.ok(representations.includes(Buffer.from(secret).toString("hex")));
  assert.ok(representations.includes(encodeURIComponent(secret)));
  for (const representation of representations) {
    assert.equal(containsSecretValueRepresentation(`prefix ${representation} suffix`, [secret]), true);
  }
  assert.equal(containsSecretValueRepresentation("unrelated public text", [secret]), false);
});

test("exact secret representation redaction removes every known encoding", () => {
  const secret = "encoded-secret-value";
  for (const representation of secretValueRepresentations(secret)) {
    const redacted = redactSecretValueRepresentations(`before ${representation} after`, [secret], "[credential]");
    assert.equal(redacted, "before [credential] after");
    assert.equal(containsSecretValueRepresentation(redacted, [secret]), false);
  }
});

test("secret representation policy rejects mixed-case hex and partial percent encodings", () => {
  const secret = "Credential value/+";
  const mixedCaseHex = Buffer.from(secret)
    .toString("hex")
    .split("")
    .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character.toLowerCase()))
    .join("");
  const partialPercent = "Cred%65ntial+value%2f%2B";

  for (const representation of [mixedCaseHex, partialPercent]) {
    assert.equal(containsSecretValueRepresentation(`prefix ${representation} suffix`, [secret]), true);
    const redacted = redactSecretValueRepresentations(`prefix ${representation} suffix`, [secret], "[credential]");
    assert.equal(redacted, "prefix [credential] suffix");
    assert.equal(containsSecretValueRepresentation(redacted, [secret]), false);
  }
});

test("partial percent matching compares UTF-8 bytes and does not accept near misses", () => {
  const secret = "café space";
  assert.equal(containsSecretValueRepresentation("caf%C3%a9+space", [secret]), true);
  assert.equal(containsSecretValueRepresentation("caf%C3%a8+space", [secret]), false);
  assert.equal(containsSecretValueRepresentation("cafe+space", [secret]), false);
});
