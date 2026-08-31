import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { bundledOperatorNpmClosureForValidation, resolveOperatorNpmAuthority } from "../src/operator-npm.js";

test("the release-pinned operator npm closure is complete and reproducible", () => {
  assert.deepEqual(bundledOperatorNpmClosureForValidation(), {
    bytes: 12_223_470,
    digest: "21e3d464bd4418f10c34d70ac8fa19a0d64bcd9c52c932221517bd586b005d7b",
    directories: 460,
    files: 1_943
  });
});

test("the operator npm backports retain their security behavior", () => {
  const require = createRequire(import.meta.url);
  const npmRoot = path.dirname(require.resolve("npm/package.json"));
  assert.deepEqual(
    Object.fromEntries(
      ["brace-expansion", "ip-address", "tar", "undici"].map((name) => [
        name,
        (require(path.join(npmRoot, "node_modules", name, "package.json")) as { version: string }).version
      ])
    ),
    {
      "brace-expansion": "5.0.9",
      "ip-address": "10.5.0",
      tar: "7.5.22",
      undici: "6.28.0"
    }
  );
  const braceExpansion = require(path.join(npmRoot, "node_modules", "brace-expansion")) as {
    expand: (value: string, options: { max: number; maxLength: number }) => string[];
  };
  const chained = braceExpansion.expand("{a,b}".repeat(200), { max: 64, maxLength: 1_024 });
  assert.ok(chained.length > 0);
  assert.ok(chained.reduce((total, value) => total + value.length, 0) <= 1_024);

  const { Address4 } = require(path.join(npmRoot, "node_modules", "ip-address")) as {
    Address4: new (address: string) => { isPrivate: () => boolean };
  };
  assert.throws(() => new Address4("127.000.0.1"), /leading zeroes/u);
  assert.equal(new Address4("10.0.0.1/0").isPrivate(), true);
});

test("operator npm runs only from a private read-only snapshot", (context) => {
  const targetRoot = temporaryRoot("ufz-operator-npm-target-");
  const controllerRoot = temporaryRoot("ufz-operator-npm-controller-");
  context.after(() => {
    makeTreeWritable(controllerRoot);
    fs.rmSync(controllerRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  const authority = resolveOperatorNpmAuthority(targetRoot, undefined);
  const provision = authority.provision(controllerRoot);
  const snapshotRoot = path.dirname(path.dirname(provision.cliPath));
  assert.equal(path.relative(targetRoot, provision.cliPath).startsWith(`..${path.sep}`), true);
  assert.equal(fs.existsSync(path.join(snapshotRoot, "node_modules", ".bin")), false);
  assert.equal(fs.lstatSync(provision.cliPath).mode & 0o777, 0o400);
  assert.equal(
    execFileSync(process.execPath, [provision.cliPath, "--version"], {
      cwd: targetRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" }
    }).trim(),
    "11.19.0"
  );
  provision.assertCurrent();

  const snapshotNodeModules = path.join(snapshotRoot, "node_modules");
  const generatedBin = path.join(snapshotNodeModules, ".bin");
  fs.chmodSync(snapshotNodeModules, 0o700);
  fs.mkdirSync(generatedBin, { mode: 0o500 });
  fs.chmodSync(snapshotNodeModules, 0o500);
  assert.throws(() => provision.assertCurrent(), /snapshot contains generated bin shims/u);
  fs.chmodSync(snapshotNodeModules, 0o700);
  fs.rmdirSync(generatedBin);
  fs.chmodSync(snapshotNodeModules, 0o500);
  provision.assertCurrent();

  fs.chmodSync(provision.cliPath, 0o600);
  assert.throws(() => provision.assertCurrent(), /snapshot file is not read-only/u);
});

function makeTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeTreeWritable(path.join(root, name));
}
