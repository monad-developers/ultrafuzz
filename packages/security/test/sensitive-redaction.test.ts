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
