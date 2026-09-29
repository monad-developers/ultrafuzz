import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { temporaryRoot } from "./temporary-root.js";

test("temporaryRoot removes a sealed run tree and the fake-bin sibling when the test ends", async (t) => {
  let root = "";
  await t.test("fixture", (inner) => {
    root = temporaryRoot("ufz-cli-cleanup-", inner);
    // The shape a launched run leaves: read-only files in dr-x directories.
    const sealed = path.join(root, ".ultrafuzz", "runs", "run-1", "snapshot");
    fs.mkdirSync(sealed, { recursive: true });
    fs.writeFileSync(path.join(sealed, "module.js"), "export {};\n", { mode: 0o400 });
    for (let directory = sealed; directory !== root; directory = path.dirname(directory)) {
      fs.chmodSync(directory, 0o500);
    }
    fs.mkdirSync(`${root}-fake-bin`);
    fs.writeFileSync(path.join(`${root}-fake-bin`, "smithers"), "#!/bin/sh\n", { mode: 0o500 });
  });

  assert.notEqual(root, "");
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(`${root}-fake-bin`), false);
});
