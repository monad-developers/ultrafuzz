import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactSchemaDirectory, createRunLayout, validateRegisteredJsonFileSync } from "@ultrafuzz/artifacts";

import { composeSmithersCommandPath } from "../src/smithers.js";
import {
  assertTrustedCliLauncher,
  prepareTrustedCliEnvironment,
  runTrustedJsonValidatorPreflight,
  ULTRAFUZZ_TRUSTED_BIN_ENV
} from "../src/trusted-cli.js";

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-trusted-cli-"));
}

function fakeCliEntrypoint(root: string, fixedOutput?: string): string {
  const entrypoint = path.join(root, "validator-cli.mjs");
  const artifactsUrl = new URL("../../../artifacts/dist/index.js", import.meta.url).href;
  fs.writeFileSync(
    entrypoint,
    fixedOutput === undefined
      ? [
          `import { validateJsonFile } from ${JSON.stringify(artifactsUrl)};`,
          "const args = process.argv.slice(2);",
          "const value = (flag) => args[args.indexOf(flag) + 1];",
          "const result = await validateJsonFile({ schemaPath: value('--schema'), filePath: value('--file') });",
          "process.stdout.write(JSON.stringify({ ok: result.status === 'valid', data: result }));",
          "process.exitCode = result.status === 'valid' ? 0 : result.status === 'instance-error' ? 1 : 2;",
          ""
        ].join("\n")
      : `process.stdout.write(${JSON.stringify(fixedOutput)});\n`,
    "utf8"
  );
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

test("schema-backed producers require an explicit trusted CLI entrypoint", () => {
  const root = temporaryRoot();
  const layout = createRunLayout({ projectRoot: root, runId: "required-entrypoint" });
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout, required: true }),
    /entrypoint is required for schema-backed producer validation/u
  );
  assert.equal(prepareTrustedCliEnvironment({ layout, required: false }).active, false);
});

test("trusted CLI identity is schema-valid, preflighted, and ordered before every shadow binary", () => {
  const root = temporaryRoot();
  const layout = createRunLayout({ projectRoot: root, runId: "trusted-path" });
  const entrypoint = fakeCliEntrypoint(root);
  const callerBin = path.join(root, "target-bin");
  const localBin = path.join(root, ".smithers", "node_modules", ".bin");
  fs.mkdirSync(callerBin, { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  for (const directory of [callerBin, localBin]) {
    const shadow = path.join(directory, "ultrafuzz");
    fs.writeFileSync(shadow, "#!/bin/sh\nexit 77\n", "utf8");
    fs.chmodSync(shadow, 0o500);
  }

  const trusted = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: entrypoint,
    env: { PATH: callerBin },
    required: true
  });
  assert.equal(trusted.active, true);
  runTrustedJsonValidatorPreflight({ layout, trusted });
  assert.equal(
    validateRegisteredJsonFileSync({
      schemaPath: path.join(artifactSchemaDirectory(), "trusted-cli.schema.json"),
      filePath: path.join(layout.root, "trusted-cli.json")
    }).status,
    "valid"
  );

  const commandPath = composeSmithersCommandPath(root, trusted.env);
  const entries = commandPath.split(path.delimiter);
  assert.deepEqual(entries.slice(0, 3), [trusted.env[ULTRAFUZZ_TRUSTED_BIN_ENV], localBin, callerBin]);
  const output = execFileSync(
    "ultrafuzz",
    [
      "json",
      "validate",
      "--schema",
      path.join(artifactSchemaDirectory(), "findings.schema.json"),
      "--file",
      path.join(artifactSchemaDirectory(), "validator-smoke.valid.json"),
      "--json"
    ],
    { encoding: "utf8", env: { ...process.env, ...trusted.env, PATH: commandPath } }
  );
  assert.equal((JSON.parse(output) as { data?: { status?: string } }).data?.status, "valid");
});

test("trusted CLI preflight rejects duplicate-key validator output", () => {
  const root = temporaryRoot();
  const layout = createRunLayout({ projectRoot: root, runId: "duplicate-output" });
  const entrypoint = fakeCliEntrypoint(root, '{"ok":true,"ok":true}');
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });

  assert.throws(() => runTrustedJsonValidatorPreflight({ layout, trusted }), /duplicate property name/u);
});

test("resume rejects missing, tampered, and stale trusted CLI identity", () => {
  const root = temporaryRoot();
  const entrypoint = fakeCliEntrypoint(root);

  const tamperedLayout = createRunLayout({ projectRoot: root, runId: "tampered-launcher" });
  const tampered = prepareTrustedCliEnvironment({ layout: tamperedLayout, cliEntrypoint: entrypoint });
  fs.chmodSync(tampered.launcherPath!, 0o700);
  fs.appendFileSync(tampered.launcherPath!, "# changed\n");
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout: tamperedLayout, cliEntrypoint: entrypoint }),
    /launcher changed/u
  );

  const missingLayout = createRunLayout({ projectRoot: root, runId: "missing-launcher" });
  const missing = prepareTrustedCliEnvironment({ layout: missingLayout, cliEntrypoint: entrypoint });
  fs.unlinkSync(missing.launcherPath!);
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout: missingLayout, cliEntrypoint: entrypoint }),
    /cannot open|ENOENT/u
  );

  const staleLayout = createRunLayout({ projectRoot: root, runId: "stale-identity" });
  const stale = prepareTrustedCliEnvironment({ layout: staleLayout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(staleLayout.root, "trusted-cli.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.validator_build = "ultrafuzz-json-validator.v1:stale";
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  assert.throws(() => assertTrustedCliLauncher({ layout: staleLayout, launcherPath: stale.launcherPath! }), /stale/u);
});
