import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJsonFile } from "../src/index.js";

test("generic artifact JSON reads use one strict no-follow byte snapshot", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-strict-json-reader-"));
  const validPath = path.join(root, "valid.json");
  fs.writeFileSync(validPath, '{"schema_version":"current","items":[]}\n');
  assert.deepEqual(readJsonFile(validPath), { schema_version: "current", items: [] });

  const duplicatePath = path.join(root, "duplicate.json");
  fs.writeFileSync(duplicatePath, '{"items":[],"items":[]}\n');
  assert.throws(() => readJsonFile(duplicatePath), /duplicate property name/u);

  const invalidUtf8Path = path.join(root, "invalid-utf8.json");
  fs.writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  assert.throws(() => readJsonFile(invalidUtf8Path), /UTF-8/u);

  const symlinkPath = path.join(root, "linked.json");
  fs.symlinkSync(validPath, symlinkPath);
  assert.throws(() => readJsonFile(symlinkPath), /cannot open regular file/u);
});
