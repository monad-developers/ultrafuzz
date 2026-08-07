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
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "./foundry.toml" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".gitignore" }] }).ok, true);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".git/.keep" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".npmrc" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "artifacts/agent.json" }] }).ok, false);
});

test("rejects duplicate or traversal workspace patch paths", () => {
  assert.equal(
    validateWorkspacePatchSchema({ ...valid, files: [{ path: "foundry.toml" }, { path: "foundry.toml" }] }).ok,
    false
  );
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: "../outside" }] }).ok, false);
  assert.equal(validateWorkspacePatchSchema({ ...valid, files: [{ path: ".ultrafuzz/schemas/evil.json" }] }).ok, false);
});

// R53 (`aave-v4-v0012-main-issue357fix-r53-invariant-only`) died at `stateful-invariant-handlers` because
// the workspace capture blew the 32 MiB git buffer on `recon-corpus-deep`, an agent-named fuzzing corpus
// no name list had predicted (issue #368). The capture-side fix drops such a root by SIZE and records it
// in the manifest, because a silent omission is worse than the overflow: `applyWorkspacePatch` verifies
// both trees under the same exclusions, so every check passes and the dependent just sees content that was
// never delivered.
//
// That record has to be legal here or the fix trades one dead node for another. `workspacePatchSchema` is
// a `z.strictObject` and `validateArtifactContract` routes `ultrafuzz/workspace-patch@1` straight into it,
// which `artifact-gates.ts` calls on every declared node output — and `stateful-invariant-handlers`
// declares `workspace-patch.json` with exactly that contract. Measured before this change, on the R53
// shape: `WORKSPACE_PATCH_SCHEMA_INVALID: Unrecognized key: "excluded_roots"`.
//
// The gate path is asserted alongside the direct validator on purpose. The runtime's own `validateManifest`
// ignores unknown keys, so a capture-side change stays green through the entire runtime suite and fails
// only here — which is how this reached a live run in the first place.
test("accepts the excluded-roots record a size-capped capture writes", () => {
  const withExclusions = {
    ...valid,
    excluded_roots: [
      { path: "recon-corpus-deep", bytes: 35_651_584 },
      { path: "echidna-deep", bytes: 37_453 }
    ]
  };
  assert.equal(validateWorkspacePatchSchema(withExclusions).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/workspace-patch@1", JSON.stringify(withExclusions)).ok, true);
  // Absent, not empty, when nothing was excluded: presence alone has to mean something was left out.
  assert.equal(validateWorkspacePatchSchema(valid).ok, true);
  assert.equal(validateWorkspacePatchSchema({ ...valid, excluded_roots: [] }).ok, true);
  // A zero-byte root is legal: every listed entry can vanish between listing and stat, which the producer
  // counts as zero rather than failing the capture.
  assert.equal(validateWorkspacePatchSchema({ ...valid, excluded_roots: [{ path: "corpus", bytes: 0 }] }).ok, true);
});

// The looseness is the point, not an omission. The producer keys these roots on raw bytes and renders them
// with `toString("latin1")` so a non-UTF-8 directory name is matched exactly instead of through a lossy
// decode. Applying `files`' charset pattern here would fail the gate on exactly the oversized corpus this
// field exists to report — reintroducing the defect one layer down. This test exists to make that trade
// explicit, so tightening the rule is a decision rather than an accident.
test("does not impose the applied-path charset on a root that is only ever named", () => {
  const latin1Named = { ...valid, excluded_roots: [{ path: "recon-corpus-café", bytes: 33_865_139 }] };
  assert.equal(validateWorkspacePatchSchema(latin1Named).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/workspace-patch@1", JSON.stringify(latin1Named)).ok, true);
  assert.equal(validateWorkspacePatchSchema({ ...valid, excluded_roots: [{ path: "a b:c", bytes: 1 }] }).ok, true);
  // The JSON Schema has to stay loose too, or the two disagree about the same manifest.
  assert.equal(
    "pattern" in workspacePatchJsonSchema.properties.excluded_roots.items.properties.path,
    false,
    "excluded root paths must not carry a charset pattern"
  );
});

// Unreachable from today's producer — git never lists a `.` or `..` component, and the root is by
// construction the text before the first `/` — so these guard a hand-written or future producer without
// risking a real capture.
test("rejects an excluded root that is not readable as a single root", () => {
  const reject = (excluded_roots: unknown): void => {
    assert.equal(validateWorkspacePatchSchema({ ...valid, excluded_roots }).ok, false);
  };
  reject([{ path: "recon-corpus/build-snapshot", bytes: 1 }]);
  reject([{ path: "", bytes: 1 }]);
  reject([{ path: ".", bytes: 1 }]);
  reject([{ path: "..", bytes: 1 }]);
  reject([{ path: "corpus", bytes: -1 }]);
  reject([{ path: "corpus", bytes: 1.5 }]);
  reject([{ path: "corpus" }]);
  reject([{ path: "corpus", bytes: 1, why: "big" }]);
  reject([
    { path: "corpus", bytes: 1 },
    { path: "corpus", bytes: 2 }
  ]);
  reject("recon-corpus-deep");
});
