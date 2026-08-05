import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKSPACE_PATCH_SCHEMA_VERSION,
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
  files: [{ path: "foundry.toml" }]
};

test("validates the workspace patch manifest contract", () => {
  assert.equal(validateWorkspacePatchSchema(valid).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/workspace-patch@1", JSON.stringify(valid)).ok, true);
  assert.equal(workspacePatchJsonSchema.properties.schema_version.const, WORKSPACE_PATCH_SCHEMA_VERSION);
});

test("rejects duplicate or traversal workspace patch paths", () => {
  assert.equal(
    validateWorkspacePatchSchema({ ...valid, files: [{ path: "foundry.toml" }, { path: "foundry.toml" }] }).ok,
    false
  );
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "../outside" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".ultrafuzz/schemas/evil.json" }] }).ok, false);
});
