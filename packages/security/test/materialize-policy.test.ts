import assert from "node:assert/strict";
import { test } from "node:test";

import { validateCleanPolicy, validateMaterializePolicy } from "../src/index.js";

test("materialize policy rejects implicit bulk selections and unsafe output IDs", () => {
  const accepted = validateMaterializePolicy({
    confirmed: true,
    copies: [{ source: "artifacts/node-1/generated-tests/Test.t.sol", destination: "test/ultrafuzz/Test.t.sol" }]
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted.diagnostics));

  const noSelection = validateMaterializePolicy({ confirmed: true });
  assert.equal(noSelection.ok, false);
  assert.ok(noSelection.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_NO_SELECTION"));

  const wildcard = validateMaterializePolicy({
    confirmed: true,
    copies: [{ source: "artifacts/node-1/*", destination: "test/ultrafuzz/Test.t.sol" }]
  });
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.diagnostics.some((diagnostic) => diagnostic.code === "PATH_IMPLICIT_BULK_SELECTION"));

  const rootSelection = validateMaterializePolicy({
    confirmed: true,
    copies: [{ source: "artifacts/node-1", destination: "test/ultrafuzz/Test.t.sol" }]
  });
  assert.equal(rootSelection.ok, false);
  assert.ok(rootSelection.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SOURCE_NOT_OUTPUT"));

  const patch = validateMaterializePolicy({
    confirmed: true,
    patches: ["artifacts/node-1/changes.diff"]
  });
  assert.equal(patch.ok, false);
  assert.ok(patch.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_PATCHES_UNSUPPORTED"));

  const unsafeId = validateMaterializePolicy({
    confirmed: true,
    copies: [{ source: "artifacts/node 1/output.txt", destination: "test/ultrafuzz/output.txt" }]
  });
  assert.equal(unsafeId.ok, false);
  assert.ok(unsafeId.diagnostics.some((diagnostic) => diagnostic.code.startsWith("ID_UNSAFE")));
});

test("materialize policy rejects denied destinations, duplicate destinations, and unsafe modes", () => {
  const sensitive = validateMaterializePolicy({
    confirmed: true,
    copies: [{ source: "artifacts/node-1/output.txt", destination: ".env.local" }]
  });
  assert.equal(sensitive.ok, false);
  assert.ok(sensitive.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SENSITIVE_DESTINATION"));

  const duplicate = validateMaterializePolicy({
    confirmed: true,
    copies: [
      { source: "artifacts/node-1/one.txt", destination: "test/Generated.t.sol" },
      { source: "artifacts/node-1/two.txt", destination: "./test/Generated.t.sol" }
    ]
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DUPLICATE_DESTINATION"));

  const portableAliases = validateMaterializePolicy({
    confirmed: true,
    copies: [
      { source: "artifacts/node-1/one.txt", destination: "test/Generated.t.sol" },
      { source: "artifacts/node-1/two.txt", destination: "TEST/generated.t.sol" }
    ]
  });
  assert.equal(portableAliases.ok, false);
  assert.ok(portableAliases.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DUPLICATE_DESTINATION"));

  for (const destination of [
    ".GIT/config",
    ".ULTRAFUZZ/runs/output.txt",
    "SECRETS/key.txt",
    ".SSH/config",
    "nested/CERT.PEM",
    "nested/SIGNING.KEY",
    ".ENV.LOCAL"
  ]) {
    const denied = validateMaterializePolicy({
      confirmed: true,
      copies: [{ source: "artifacts/node-1/output.txt", destination }]
    });
    assert.equal(denied.ok, false, destination);
    assert.ok(
      denied.diagnostics.some((diagnostic) =>
        [
          "MATERIALIZE_GIT_DESTINATION",
          "MATERIALIZE_PRODUCT_SURFACE_DESTINATION",
          "MATERIALIZE_SENSITIVE_DESTINATION"
        ].includes(diagnostic.code)
      ),
      `${destination}: ${JSON.stringify(denied.diagnostics)}`
    );
  }

  const publishingMode = validateMaterializePolicy({
    confirmed: true,
    mode: "push",
    copies: [{ source: "artifacts/node-1/output.txt", destination: "test/Generated.t.sol" }]
  });
  assert.equal(publishingMode.ok, false);
  assert.ok(publishingMode.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_UNSAFE_MODE"));
});

test("clean policy allows selected generated roots and rejects bulk or non-generated selections", () => {
  assert.equal(validateCleanPolicy({ selections: ["runs/run-1"], confirmed: true }).ok, true);
  assert.equal(validateCleanPolicy({ selections: ["runs/run-1/artifacts/node-1"], confirmed: true }).ok, true);
  assert.equal(validateCleanPolicy({ selections: ["runs/run-1/workspaces/node-1"], confirmed: true }).ok, true);

  const noConfirmation = validateCleanPolicy({ selections: ["runs/run-1"] });
  assert.equal(noConfirmation.ok, false);
  assert.ok(noConfirmation.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_CONFIRMATION_REQUIRED"));

  const wildcard = validateCleanPolicy({ selections: ["runs/run-1/artifacts/*"], confirmed: true });
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.diagnostics.some((diagnostic) => diagnostic.code === "PATH_IMPLICIT_BULK_SELECTION"));

  const stateFile = validateCleanPolicy({ selections: ["runs/run-1/state.json"], confirmed: true });
  assert.equal(stateFile.ok, false);
  assert.ok(stateFile.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_UNSUPPORTED_RUN_SUBPATH"));

  const nonGenerated = validateCleanPolicy({ selections: ["src"], confirmed: true });
  assert.equal(nonGenerated.ok, false);
  assert.ok(nonGenerated.diagnostics.some((diagnostic) => diagnostic.code === "CLEAN_NON_GENERATED_PATH"));
});
