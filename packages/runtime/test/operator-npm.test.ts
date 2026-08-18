import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bundledOperatorNpmClosureForValidation, resolveOperatorNpmAuthority } from "../src/operator-npm.js";

test("the release-pinned operator npm closure is complete and reproducible", () => {
  assert.deepEqual(bundledOperatorNpmClosureForValidation(), {
    bytes: 12_230_534,
    digest: "4823bc9e925ce3ddecaa33d5d7fd01b1de0ba3c395332a58bcbbc481c2a1cdbe",
    directories: 461,
    files: 1_954
  });
});

test("the operator npm backports retain their security behavior", () => {
  const require = createRequire(import.meta.url);
  const npmRoot = path.dirname(require.resolve("npm/package.json"));
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
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-operator-npm-target-"));
  const controllerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-operator-npm-controller-"));
  context.after(() => {
    makeTreeWritable(controllerRoot);
    fs.rmSync(controllerRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  const authority = resolveOperatorNpmAuthority(targetRoot, undefined);
  const provision = authority.provision(controllerRoot);
  assert.equal(path.relative(targetRoot, provision.cliPath).startsWith(`..${path.sep}`), true);
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
