import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withBackendFinalization, readBackendFinalizationStatus } from "@ultrafuzz/runtime";
import { temporaryRoot } from "./temporary-root.js";

test("backend run passes argv after -- to the child and publishes its completion checkpoint", async (t) => {
  const root = temporaryRoot("backend-cli-", t);
  const artifactDirectory = path.join(root, "artifacts");
  const directory = path.join(root, "checkpoint");
  fs.mkdirSync(artifactDirectory);
  const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  await withBackendFinalization({
    directory,
    artifactDirectory,
    binding: "cli-fixture",
    timeoutMs: 5_000,
    graceMs: 1_000,
    args: { prompt: "test" },
    generate: async () => {
      const result = await promisify(execFile)(process.execPath, [
        entry,
        "backend",
        "run",
        directory,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1])",
        "--",
        "literal --argument"
      ]);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  });
  const entries = fs.readdirSync(directory).filter((name) => fs.lstatSync(path.join(directory, name)).isDirectory());
  const snapshot = entries[0];
  assert.ok(snapshot !== undefined);
  assert.equal(fs.readFileSync(path.join(directory, snapshot, "stdout.log"), "utf8"), "literal --argument");
  assert.equal(readBackendFinalizationStatus(directory)?.checkpoint_available, true);
});
