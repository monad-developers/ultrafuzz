import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePathInside, validateSafeId, validateSafeRelativePath } from "../src/index.js";

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

  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-path-backslash-"));
  const resolved = resolvePathInside(root, "runs\\run-1\\report.json");
  assert.equal(resolved.ok, false);
  assert.ok(resolved.diagnostics.some((diagnostic) => diagnostic.code === "PATH_BACKSLASH"));
});

test("safe IDs reject traversal, slashes, and dot edges", () => {
  assert.equal(validateSafeId("node id", "setup-1").ok, true);
  assert.equal(validateSafeId("node id", "../setup").ok, false);
  assert.equal(validateSafeId("node id", "bad/node").ok, false);
  assert.equal(validateSafeId("node id", ".hidden").ok, false);
});

test("resolvePathInside rejects symlink escapes after canonicalization", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-path-root-"));
  const outside = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-path-outside-"));
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(root, "linked-outside"));

  const result = resolvePathInside(root, "linked-outside/secret.txt");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "PATH_ESCAPE"));
});

test("resolvePathInside rejects traversal and preserves non-existing leaf paths", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ufz-path-root-"));
  const safe = resolvePathInside(root, "nested/new-file.txt");
  assert.equal(safe.ok, true, JSON.stringify(safe.diagnostics));
  assert.equal(safe.value?.relativePath, "nested/new-file.txt");

  const traversal = resolvePathInside(root, "../outside.txt");
  assert.equal(traversal.ok, false);
  assert.ok(traversal.diagnostics.some((diagnostic) => diagnostic.code === "PATH_TRAVERSAL"));
});
