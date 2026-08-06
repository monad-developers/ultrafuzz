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

test("base64 detection covers a credential embedded at every byte alignment", () => {
  const secret = "sk-ant-api03-DEADBEEFdeadbeef0123456789";
  // Base64 packs three bytes per four characters, so a credential encoded as part
  // of a larger body produces different characters for each of the three
  // alignments. An HTTP body or JSON envelope encoded as a whole is the common
  // case, and every alignment must still be detected and redacted.
  for (let padding = 0; padding < 6; padding += 1) {
    const payload = Buffer.from(`${"x".repeat(padding)}${secret}TAIL`, "utf8").toString("base64");
    assert.equal(containsSecretValueRepresentation(payload, [secret]), true, `alignment ${padding} must be detected`);
    const redacted = redactSecretValueRepresentations(payload, [secret], "[credential]");
    assert.notEqual(redacted, payload, `alignment ${padding} must be redacted`);
    assert.equal(containsSecretValueRepresentation(redacted, [secret]), false);
  }

  const envelope = Buffer.from(`{"KIMI_API_KEY":"${secret}"}`, "utf8").toString("base64");
  assert.equal(containsSecretValueRepresentation(envelope, [secret]), true);
  assert.equal(
    containsSecretValueRepresentation(redactSecretValueRepresentations(envelope, [secret], "[credential]"), [secret]),
    false
  );

  const urlSafeEnvelope = envelope.replaceAll("+", "-").replaceAll("/", "_");
  assert.equal(containsSecretValueRepresentation(urlSafeEnvelope, [secret]), true);

  assert.equal(containsSecretValueRepresentation(Buffer.from("unrelated body").toString("base64"), [secret]), false);
});

test("secret detection covers unicode-escaped credential text", () => {
  const secret = "sk-unicode-escaped-credential";
  const escaped = [...secret].map((unit) => `\\u${unit.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("");

  assert.equal(containsSecretValueRepresentation(`{"key":"${escaped}"}`, [secret]), true);
  assert.equal(
    containsSecretValueRepresentation(
      redactSecretValueRepresentations(`{"key":"${escaped}"}`, [secret], "[credential]"),
      [secret]
    ),
    false
  );
  assert.equal(containsSecretValueRepresentation("\\u0061\\u0062\\u0063", [secret]), false);
});
