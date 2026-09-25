import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_PATCH_SCHEMA_VERSION,
  normalizeWorkspacePatchPath,
  validateArtifactContract,
  validateWorkspacePatchSchema,
  workspacePatchJsonSchema
} from "../src/index.js";

const valid = {
  schema_version: WORKSPACE_PATCH_SCHEMA_VERSION,
  base_commit: "a".repeat(40),
  base_tree: "b".repeat(40),
  result_tree: "c".repeat(40),
  patch_sha256: "d".repeat(64),
  files: [{ path: "foundry.toml" }],
  source_snapshot: { status: "preserved" as const, protected_roots: ["contracts", "src"] }
};

test("validates the workspace patch manifest contract", () => {
  assert.equal(validateWorkspacePatchSchema(valid).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/workspace-patch@1", JSON.stringify(valid)).ok, true);
  assert.equal(workspacePatchJsonSchema.properties.schema_version.const, WORKSPACE_PATCH_SCHEMA_VERSION);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "./foundry.toml" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".gitignore" }] }).ok, true);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".git/.keep" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".npmrc" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "artifacts/agent.json" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, source_snapshot: undefined }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "src/Vault.sol" }] }).ok, false);
});

test("rejects duplicate or traversal workspace patch paths", () => {
  assert.equal(
    validateWorkspacePatchSchema({ ...valid, files: [{ path: "foundry.toml" }, { path: "foundry.toml" }] }).ok,
    false
  );
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "../outside" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".ultrafuzz/schemas/evil.json" }] }).ok, false);
});

test("accepts audited exact-file overflow exclusions and rejects ambiguous records", () => {
  const exclusion = {
    path: "test/recon/corpus-deep/seed.bin",
    diff_bytes_at_least: 33_865_139,
    reason: "git-diff-overflow" as const
  };
  const withExclusion = { ...valid, excluded_files: [exclusion] };
  assert.equal(validateWorkspacePatchSchema(withExclusion).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/workspace-patch@1", JSON.stringify(withExclusion)).ok, true);

  for (const excluded_files of [
    [],
    [exclusion, exclusion],
    [{ ...exclusion, path: "../seed.bin" }],
    [{ ...exclusion, path: "artifacts/seed.bin" }],
    [{ ...exclusion, diff_bytes_at_least: 0 }],
    [{ ...exclusion, diff_bytes_at_least: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...exclusion, reason: "size-guess" }],
    [{ ...exclusion, bytes: exclusion.diff_bytes_at_least }]
  ]) {
    assert.equal(validateWorkspacePatchSchema({ ...valid, excluded_files }).ok, false, JSON.stringify(excluded_files));
  }
  assert.equal(
    validateWorkspacePatchSchema({
      ...valid,
      files: [{ path: exclusion.path }],
      excluded_files: [exclusion]
    }).ok,
    false
  );
  assert.equal(
    validateWorkspacePatchSchema({ ...valid, excluded_files: [{ ...exclusion, path: "contracts/Vault.sol" }] }).ok,
    false
  );
});

test("names the rejected segment and the reason for an unsafe workspace patch path", () => {
  const longest = "a".repeat(128);
  assert.equal(normalizeWorkspacePatchPath(`test/${longest}`), `test/${longest}`);

  const tooLong = "b".repeat(129);
  assert.throws(
    () => normalizeWorkspacePatchPath(`test/${tooLong}/x.sol`),
    new Error(
      `workspace patch file path "test/${tooLong}/x.sol" contains an unsafe path segment "${tooLong}": segment is 129 characters long (maximum 128)`
    )
  );
  assert.throws(
    () => normalizeWorkspacePatchPath("lib/@scope/x.sol", "workspace patch excluded file path"),
    new Error(
      'workspace patch excluded file path "lib/@scope/x.sol" contains an unsafe path segment "@scope": segment contains disallowed character "@" (allowed: A-Z, a-z, 0-9, ".", "_", "-")'
    )
  );
  assert.throws(
    () => normalizeWorkspacePatchPath("test/my file.sol"),
    /segment "my file\.sol": segment contains disallowed character " "/u
  );
});
