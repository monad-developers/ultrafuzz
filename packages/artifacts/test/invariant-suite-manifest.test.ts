import assert from "node:assert/strict";
import test from "node:test";

import {
  INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION,
  assertInvariantSuiteManifestSemantics,
  assertValidInvariantSuiteManifest,
  parseInvariantSuiteManifestBytes,
  validateInvariantSuiteManifest,
  type InvariantSuiteManifest
} from "../src/index.js";

function canonicalManifest(): InvariantSuiteManifest {
  return {
    schema_version: INVARIANT_SUITE_MANIFEST_SCHEMA_VERSION,
    producer_node_id: "stateful-invariant-setup",
    producer_attempt_id: "stateful-invariant-setup-0",
    files: [
      {
        path: "test/recon/Properties.sol",
        size_bytes: 128,
        sha256: "a".repeat(64)
      }
    ],
    tombstones: ["src/LegacyInvariant.sol"]
  };
}

test("invariant-suite manifest accepts and strictly parses canonical v2", () => {
  const manifest = canonicalManifest();
  assert.deepEqual(validateInvariantSuiteManifest(manifest), { ok: true, issues: [], truncated: false });
  assert.doesNotThrow(() => assertValidInvariantSuiteManifest(manifest));
  assert.deepEqual(parseInvariantSuiteManifestBytes(Buffer.from(JSON.stringify(manifest), "utf8")), manifest);
});

test("invariant-suite manifest is current-only and requires its deletion channel", () => {
  const missingTombstones = canonicalManifest() as unknown as Record<string, unknown>;
  delete missingTombstones.tombstones;
  assert.equal(validateInvariantSuiteManifest(missingTombstones).ok, false);

  const v1 = { ...canonicalManifest(), schema_version: "ultrafuzz.invariant-suite-manifest.v1" };
  assert.equal(validateInvariantSuiteManifest(v1).ok, false);
  assert.throws(
    () => parseInvariantSuiteManifestBytes(Buffer.from(JSON.stringify(v1), "utf8")),
    /violates its registered schema/u
  );
});

test("invariant-suite manifest strict parsing rejects duplicate JSON keys", () => {
  const manifest = canonicalManifest();
  const duplicateKeyJson = JSON.stringify(manifest).replace(
    `"producer_node_id":"${manifest.producer_node_id}"`,
    `"producer_node_id":"shadowed","producer_node_id":"${manifest.producer_node_id}"`
  );
  assert.throws(
    () => parseInvariantSuiteManifestBytes(Buffer.from(duplicateKeyJson, "utf8")),
    /duplicate property name/u
  );
});

test("invariant-suite manifest enforces path uniqueness and deletion disjointness", () => {
  const duplicateFilePath = canonicalManifest();
  duplicateFilePath.files.push({
    path: duplicateFilePath.files[0]!.path,
    size_bytes: 256,
    sha256: "b".repeat(64)
  });
  assert.throws(() => assertValidInvariantSuiteManifest(duplicateFilePath), /repeats file path/u);

  const duplicateTombstone = canonicalManifest();
  duplicateTombstone.tombstones.push(duplicateTombstone.tombstones[0]!);
  assert.throws(() => assertInvariantSuiteManifestSemantics(duplicateTombstone), /repeats tombstone/u);
  assert.equal(validateInvariantSuiteManifest(duplicateTombstone).ok, false);

  const overlap = canonicalManifest();
  overlap.tombstones = [overlap.files[0]!.path];
  assert.throws(() => assertValidInvariantSuiteManifest(overlap), /both present and tombstoned/u);
});

test("invariant-suite manifest rejects unknown fields and malformed entries", () => {
  const extraRootField = { ...canonicalManifest(), legacy_mode: true };
  assert.equal(validateInvariantSuiteManifest(extraRootField).ok, false);

  const extraFileField = canonicalManifest() as InvariantSuiteManifest & {
    files: Array<InvariantSuiteManifest["files"][number] & { content?: string }>;
  };
  extraFileField.files[0]!.content = "contract Properties {}";
  assert.equal(validateInvariantSuiteManifest(extraFileField).ok, false);

  for (const malformed of [
    { ...canonicalManifest(), files: [{ path: "test/recon/Properties.sol", size_bytes: 0, sha256: "a".repeat(64) }] },
    { ...canonicalManifest(), files: [{ path: "../escape.sol", size_bytes: 1, sha256: "a".repeat(64) }] },
    { ...canonicalManifest(), files: [{ path: "test/recon/Properties.sol", size_bytes: 1, sha256: "A".repeat(64) }] },
    { ...canonicalManifest(), tombstones: [42] }
  ]) {
    assert.equal(validateInvariantSuiteManifest(malformed).ok, false);
  }
});
