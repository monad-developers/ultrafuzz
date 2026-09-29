import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSafeId, validateSafeRelativePath } from "../src/index.js";

test("safe relative path policy rejects traversal and absolute injection", () => {
  assert.equal(validateSafeRelativePath("src/Test.sol").ok, true);
  assert.equal(validateSafeRelativePath("../secret").ok, false);
  assert.equal(validateSafeRelativePath("/tmp/secret").ok, false);
  assert.equal(validateSafeRelativePath("C:\\secret").ok, false);
  assert.equal(validateSafeRelativePath("nested\\secret.txt").ok, false);
  assert.equal(validateSafeRelativePath(".git/config").ok, true);
  assert.equal(validateSafeRelativePath("secrets.json").ok, true);
});

test("shared path policy rejects backslash paths before normalization", () => {
  const relative = validateSafeRelativePath("runs\\run-1\\report.json");
  assert.equal(relative.ok, false);
  assert.ok(relative.diagnostics.some((diagnostic) => diagnostic.code === "PATH_BACKSLASH"));
});

test("safe IDs reject traversal, slashes, and dot edges", () => {
  assert.equal(validateSafeId("node id", "setup-1").ok, true);
  assert.equal(validateSafeId("node id", "../setup").ok, false);
  assert.equal(validateSafeId("node id", "bad/node").ok, false);
  assert.equal(validateSafeId("node id", ".hidden").ok, false);
});
