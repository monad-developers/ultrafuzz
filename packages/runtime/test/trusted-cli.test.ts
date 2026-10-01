import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  artifactSchemaBundleDigest,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  createRunLayout,
  validateRegisteredJsonFileSync,
  VALIDATOR_BUILD_IDENTITY
} from "@ultrafuzz/artifacts";

import { composeSmithersCommandPath } from "../src/smithers.js";
import {
  assertTrustedCliLauncher,
  prepareTrustedCliEnvironment,
  renderTrustedCliLauncherForTests,
  runTrustedJsonValidatorPreflight,
  ULTRAFUZZ_TRUSTED_BIN_ENV
} from "../src/trusted-cli.js";

function fakeCliEntrypoint(root: string, fixedOutput?: string): string {
  const packageRoot = path.join(root, "fake-validator-cli");
  const entrypoint = path.join(packageRoot, "dist", "validator-cli.mjs");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "fake-validator-cli", version: "1.0.0", type: "module" })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    entrypoint,
    `process.stdout.write(${JSON.stringify(fixedOutput ?? JSON.stringify(preflightEnvelope()))});\n`,
    "utf8"
  );
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

/** A validator CLI whose success envelope is whatever `envelopePath` holds when it runs. */
function envelopeReadingCliEntrypoint(root: string, envelopePath: string): string {
  const packageRoot = path.join(root, "envelope-reading-validator-cli");
  const entrypoint = path.join(packageRoot, "dist", "validator-cli.mjs");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "envelope-reading-validator-cli", version: "1.0.0", type: "module" })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    entrypoint,
    [
      'import fs from "node:fs";',
      `process.stdout.write(fs.readFileSync(${JSON.stringify(envelopePath)}, "utf8"));`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

function countingCliEntrypoint(root: string, counterPath: string): string {
  const packageRoot = path.join(root, "counting-validator-cli");
  const entrypoint = path.join(packageRoot, "dist", "validator-cli.mjs");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "counting-validator-cli", version: "1.0.0", type: "module" })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    entrypoint,
    [
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(counterPath)}, "x");`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(preflightEnvelope()))});`,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(entrypoint, 0o500);
  return entrypoint;
}

function countCliInvocations(counterPath: string): number {
  return fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8").length : 0;
}

function fakeTransitiveCli(root: string, output: string): { entrypoint: string; dependencyEntrypoint: string } {
  const cliRoot = path.join(root, "transitive-validator-cli");
  const dependencyRoot = path.join(root, "transitive-validator-build");
  const entrypoint = path.join(cliRoot, "dist", "index.mjs");
  const dependencyEntrypoint = path.join(dependencyRoot, "dist", "index.mjs");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.dirname(dependencyEntrypoint), { recursive: true });
  fs.mkdirSync(path.join(cliRoot, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(cliRoot, "package.json"),
    `${JSON.stringify({
      name: "transitive-validator-cli",
      version: "1.0.0",
      type: "module",
      dependencies: { "transitive-validator-build": "1.0.0" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(dependencyRoot, "package.json"),
    `${JSON.stringify({
      name: "transitive-validator-build",
      version: "1.0.0",
      type: "module",
      exports: "./dist/index.mjs"
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(entrypoint, 'import { output } from "transitive-validator-build";\nprocess.stdout.write(output);\n');
  fs.writeFileSync(dependencyEntrypoint, `export const output = ${JSON.stringify(output)};\n`, "utf8");
  fs.symlinkSync(dependencyRoot, path.join(cliRoot, "node_modules", "transitive-validator-build"), "dir");
  fs.chmodSync(entrypoint, 0o500);
  fs.chmodSync(dependencyEntrypoint, 0o400);
  return { entrypoint, dependencyEntrypoint };
}

function fakeSnapshotPreferredCli(input: { root: string; currentOutput: string; snapshotOutput: string }): {
  entrypoint: string;
  executionSnapshotRoot: string;
} {
  const packageName = "@ultrafuzz/test-validator-build";
  const cliRoot = path.join(input.root, "snapshot-preferred-cli");
  const currentRoot = path.join(input.root, "current-validator-build");
  const executionSnapshotRoot = path.join(input.root, "execution-snapshot");
  const snapshotRoot = path.join(executionSnapshotRoot, "modules", "@ultrafuzz", "test-validator-build");
  const snapshotArtifactsRoot = path.join(executionSnapshotRoot, "modules", "@ultrafuzz", "artifacts");
  const entrypoint = path.join(cliRoot, "dist", "index.mjs");
  const packageDocument = {
    name: packageName,
    version: "1.0.0",
    type: "module",
    exports: "./dist/index.mjs"
  };
  for (const [root, output] of [
    [currentRoot, input.currentOutput],
    [snapshotRoot, input.snapshotOutput]
  ] as const) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageDocument)}\n`, "utf8");
    fs.writeFileSync(path.join(root, "dist", "index.mjs"), `export const output = ${JSON.stringify(output)};\n`);
  }
  fs.mkdirSync(path.join(snapshotArtifactsRoot, "schema"), { recursive: true });
  fs.writeFileSync(
    path.join(snapshotArtifactsRoot, "package.json"),
    `${JSON.stringify({ name: "@ultrafuzz/artifacts", version: "1.0.0", type: "module" })}\n`
  );
  for (const name of ["findings.schema.json", "validator-smoke.valid.json"]) {
    fs.copyFileSync(path.join(artifactSchemaDirectory(), name), path.join(snapshotArtifactsRoot, "schema", name));
  }
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.join(cliRoot, "node_modules", "@ultrafuzz"), { recursive: true });
  fs.writeFileSync(
    path.join(cliRoot, "package.json"),
    `${JSON.stringify({
      name: "snapshot-preferred-cli",
      version: "1.0.0",
      type: "module",
      dependencies: { [packageName]: "1.0.0" }
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    entrypoint,
    `import { output } from ${JSON.stringify(packageName)};\nprocess.stdout.write(output);\n`
  );
  fs.symlinkSync(currentRoot, path.join(cliRoot, "node_modules", "@ultrafuzz", "test-validator-build"), "dir");
  fs.chmodSync(entrypoint, 0o500);
  return { entrypoint, executionSnapshotRoot };
}

function fakeResolutionEscapeCli(root: string): {
  entrypoint: string;
  preload: string;
  dataFile: string;
  nodePathRoot: string;
  nodePathSentinel: string;
} {
  const packageRoot = path.join(root, "resolution-escape-cli");
  const entrypoint = path.join(packageRoot, "dist", "index.mjs");
  const outsideRoot = path.join(root, "outside-modules");
  const outsideEsm = path.join(outsideRoot, "outside.mjs");
  const outsideCjs = path.join(outsideRoot, "outside.cjs");
  const preload = path.join(outsideRoot, "preload.cjs");
  const dataFile = path.join(outsideRoot, "data.txt");
  const nodePathRoot = path.join(outsideRoot, "node-path");
  const nodePathPackage = path.join(nodePathRoot, "node-path-escape");
  const nodePathSentinel = path.join(root, "node-path-loaded");
  const ancestorPackage = path.join(root, "node_modules", "ancestor-escape");
  const declaredPackage = path.join(root, "declared-cjs");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.mkdirSync(ancestorPackage, { recursive: true });
  fs.mkdirSync(nodePathPackage, { recursive: true });
  fs.mkdirSync(declaredPackage, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "resolution-escape-cli",
      version: "1.0.0",
      type: "module",
      dependencies: { "declared-cjs": "1.0.0" }
    })}\n`
  );
  fs.writeFileSync(
    path.join(declaredPackage, "package.json"),
    `${JSON.stringify({ name: "declared-cjs", version: "1.0.0", main: "index.cjs" })}\n`
  );
  fs.writeFileSync(path.join(declaredPackage, "index.cjs"), "module.exports = true;\n");
  fs.symlinkSync(declaredPackage, path.join(packageRoot, "node_modules", "declared-cjs"), "dir");
  fs.writeFileSync(outsideEsm, "export const outside = true;\n");
  fs.writeFileSync(outsideCjs, "module.exports = true;\n");
  fs.writeFileSync(
    preload,
    `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "preloaded"))}, "yes");\n`
  );
  fs.writeFileSync(dataFile, "ordinary artifact data\n");
  fs.writeFileSync(
    path.join(ancestorPackage, "package.json"),
    `${JSON.stringify({ name: "ancestor-escape", version: "1.0.0", main: "index.cjs" })}\n`
  );
  fs.writeFileSync(path.join(ancestorPackage, "index.cjs"), "module.exports = true;\n");
  fs.writeFileSync(
    path.join(nodePathPackage, "package.json"),
    `${JSON.stringify({ name: "node-path-escape", version: "1.0.0", main: "index.cjs" })}\n`
  );
  fs.writeFileSync(
    path.join(nodePathPackage, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(nodePathSentinel)}, "yes");\n`
  );
  fs.writeFileSync(
    entrypoint,
    [
      'import fs from "node:fs";',
      'import { createRequire } from "node:module";',
      'if (createRequire(import.meta.url)("declared-cjs") !== true) throw new Error("declared CJS failed");',
      "const mode = process.env.ULTRAFUZZ_TEST_RESOLUTION_ESCAPE;",
      `if (mode === "esm") await import(${JSON.stringify(new URL(`file://${outsideEsm}`).href)});`,
      `if (mode === "cjs") createRequire(import.meta.url)(${JSON.stringify(outsideCjs)});`,
      'if (mode === "ancestor") createRequire(import.meta.url)("ancestor-escape");',
      'if (mode === "node-path") createRequire(import.meta.url)("node-path-escape");',
      `if (mode === "data") fs.readFileSync(${JSON.stringify(dataFile)}, "utf8");`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(preflightEnvelope()))});`,
      ""
    ].join("\n")
  );
  fs.chmodSync(entrypoint, 0o500);
  return { entrypoint, preload, dataFile, nodePathRoot, nodePathSentinel };
}

function preflightEnvelope(): Record<string, unknown> {
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  assert.ok(findings);
  return {
    schema_version: "ultrafuzz.cli.result.v2",
    command: "json validate",
    ok: true,
    diagnostics: [],
    data: {
      status: "valid",
      diagnostics: [],
      schema: {
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY,
        registered: true
      },
      artifact_sha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
      truncated: false
    }
  };
}

function canonicalDigest(value: Record<string, unknown>): string {
  const canonical = `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`)
    .join(",")}}`;
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

test("schema-backed producers require an explicit trusted CLI entrypoint", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "required-entrypoint" });
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout, required: true }),
    /entrypoint is required for schema-backed producer validation/u
  );
  assert.equal(prepareTrustedCliEnvironment({ layout, required: false }).active, false);
});

test("trusted CLI launchers quote POSIX spaces and keep Windows command lines bounded", () => {
  const posix = renderTrustedCliLauncherForTests({
    metadataPath: "/run root/trusted-cli.json",
    closuresRoot: "/run root/trusted-cli-closures",
    platform: "linux",
    nodePath: "/opt/Node Runtime/bin/node"
  });
  assert.match(posix, /unset NODE_OPTIONS NODE_PATH/u);
  assert.match(posix, /exec '\/opt\/Node Runtime\/bin\/node'/u);
  // The dispatcher body is CommonJS, and `-e` code is an ES module whose direct
  // `eval` does not inherit an injected `require` on every runtime.
  assert.match(posix, /new Function\("require", Buffer\.from\(/u);
  assert.doesNotMatch(posix, /-e 'eval\(/u);

  const windows = renderTrustedCliLauncherForTests({
    metadataPath: "C:\\Run Root\\trusted-cli.json",
    closuresRoot: "C:\\Run Root\\trusted-cli-closures",
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe"
  });
  assert.match(windows, /set "NODE_OPTIONS="\r\nset "NODE_PATH="/u);
  assert.match(windows, /"C:\\Program Files\\nodejs\\node\.exe" --no-global-search-paths/u);
  assert.equal(Math.max(...windows.split("\r\n").map((line) => line.length)) < 8_191, true);
});

test("trusted CLI identity is schema-valid and target PATH entries cannot shadow it", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "trusted-path" });
  const entrypoint = fakeCliEntrypoint(root);
  const callerBin = path.join(root, "target-bin");
  const localBin = path.join(root, ".smithers", "node_modules", ".bin");
  const externalBin = temporaryRoot("ultrafuzz-trusted-cli-");
  const targetLink = path.join(externalBin, "target-link");
  fs.mkdirSync(callerBin, { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  for (const directory of [callerBin, localBin]) {
    const shadow = path.join(directory, "ultrafuzz");
    fs.writeFileSync(shadow, "#!/bin/sh\nexit 77\n", "utf8");
    fs.chmodSync(shadow, 0o500);
  }
  fs.symlinkSync(callerBin, targetLink, process.platform === "win32" ? "junction" : "dir");

  const trusted = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: entrypoint,
    env: { PATH: [callerBin, localBin, targetLink, externalBin, "relative-bin", ""].join(path.delimiter) },
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
  assert.deepEqual(entries, [trusted.env[ULTRAFUZZ_TRUSTED_BIN_ENV], externalBin]);
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

test("an authenticated closure content address is preflighted once per process", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const counterPath = path.join(root, "validator-cli-invocations");
  const entrypoint = countingCliEntrypoint(root, counterPath);

  const first = createRunLayout({ projectRoot: root, runId: "closure-preflight-first" });
  const firstTrusted = prepareTrustedCliEnvironment({ layout: first, cliEntrypoint: entrypoint });
  assert.equal(countCliInvocations(counterPath), 1);

  // A second run publishes the same content address, so its closure needs no
  // second fixture execution to be authenticated.
  const second = createRunLayout({ projectRoot: root, runId: "closure-preflight-second" });
  const secondTrusted = prepareTrustedCliEnvironment({ layout: second, cliEntrypoint: entrypoint });
  assert.equal(countCliInvocations(counterPath), 1);

  // Every run still executes the real fixture through its own launcher.
  runTrustedJsonValidatorPreflight({ layout: first, trusted: firstTrusted });
  runTrustedJsonValidatorPreflight({ layout: second, trusted: secondTrusted });
  assert.equal(countCliInvocations(counterPath), 3);

  // ... and the reused content address is still verified byte for byte.
  const metadata = JSON.parse(fs.readFileSync(path.join(second.root, "trusted-cli.json"), "utf8")) as {
    cli_entrypoint: string;
  };
  fs.chmodSync(metadata.cli_entrypoint, 0o600);
  fs.appendFileSync(metadata.cli_entrypoint, "\n");
  const secondLauncherPath = secondTrusted.launcherPath;
  assert.ok(secondLauncherPath);
  assert.throws(
    () => assertTrustedCliLauncher({ layout: second, launcherPath: secondLauncherPath }),
    /trusted CLI closure file/u
  );
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout: second, cliEntrypoint: entrypoint }),
    /trusted CLI closure file/u
  );
});

test("trusted CLI initialization resumes an authenticated launcher publication crash", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "initialization-crash" });
  const entrypoint = fakeCliEntrypoint(root);
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const initializationPath = path.join(layout.root, "trusted-cli-initialization.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    initializationPath,
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.trusted-cli-initialization.v1",
        metadata_sha256: canonicalDigest(metadata),
        metadata
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  fs.unlinkSync(metadataPath);
  fs.chmodSync(trusted.launcherPath!, 0o600);

  const recovered = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, "utf8")), metadata);
  assert.equal(fs.existsSync(initializationPath), false);
  assert.equal(fs.statSync(recovered.launcherPath!).mode & 0o777, 0o500);
  runTrustedJsonValidatorPreflight({ layout, trusted: recovered });
});

test("trusted CLI preflight rejects duplicate-key validator output", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "duplicate-output" });
  const entrypoint = fakeCliEntrypoint(root, '{"ok":true,"ok":true}');
  assert.throws(() => prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint }), /duplicate property name/u);
});

test("trusted CLI preflight rejects incomplete and extensible success envelopes", () => {
  for (const [label, mutate] of [
    ["missing command", (value: Record<string, unknown>) => delete value.command],
    ["unknown field", (value: Record<string, unknown>) => Object.assign(value, { legacy: true })],
    [
      "nonempty diagnostics",
      (value: Record<string, unknown>) => Object.assign(value, { diagnostics: [{ severity: "info" }] })
    ]
  ] as const) {
    const root = temporaryRoot("ultrafuzz-trusted-cli-");
    const layout = createRunLayout({ projectRoot: root, runId: `invalid-${label.replaceAll(" ", "-")}` });
    const value = preflightEnvelope();
    mutate(value);
    const entrypoint = fakeCliEntrypoint(root, JSON.stringify(value));
    assert.throws(
      () => prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint }),
      /success envelope is invalid/u,
      label
    );
  }
});

test("resume rejects missing, tampered, and stale trusted CLI identity", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
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
  // The recorded validator build is provenance (#921); the schema bundle it validates with still binds.
  metadata.validator_build = "ultrafuzz-json-validator.v1:another-build";
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  runTrustedJsonValidatorPreflight({ layout: staleLayout, trusted: stale });
  metadata.schema_bundle_sha256 = "0".repeat(64);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  assert.throws(
    () => runTrustedJsonValidatorPreflight({ layout: staleLayout, trusted: stale }),
    /mismatched identity/u
  );
});

test("ordinary resume retains a sealed CLI while controller refresh rotates its closure", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "rotated-identity" });
  const entrypoint = fakeCliEntrypoint(root);
  const original = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const originalMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    cli_entrypoint: string;
    cli_sha256: string;
  };
  const originalLauncher = fs.readFileSync(original.launcherPath!);

  fs.chmodSync(entrypoint, 0o700);
  fs.appendFileSync(entrypoint, "// compatible rebuilt CLI\n", "utf8");
  fs.chmodSync(entrypoint, 0o500);

  const ordinary = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  runTrustedJsonValidatorPreflight({ layout, trusted: ordinary });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(metadataPath, "utf8")),
    originalMetadata,
    "ordinary resume must keep the active immutable closure"
  );
  const rotated = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: entrypoint,
    allowIdentityRotation: true
  });
  const rotatedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
    cli_entrypoint: string;
    cli_sha256: string;
  };
  assert.notEqual(rotatedMetadata.cli_entrypoint, originalMetadata.cli_entrypoint);
  assert.notEqual(rotatedMetadata.cli_sha256, originalMetadata.cli_sha256);
  assert.deepEqual(fs.readFileSync(rotated.launcherPath!), originalLauncher);
  runTrustedJsonValidatorPreflight({ layout, trusted: rotated });
});

test("controller refresh rejects a tampered trusted CLI identity before rotation", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "tampered-rotation" });
  const entrypoint = fakeCliEntrypoint(root);
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const metadataBefore = fs.readFileSync(metadataPath);

  fs.chmodSync(trusted.launcherPath!, 0o700);
  fs.appendFileSync(trusted.launcherPath!, "# changed\n", "utf8");
  fs.chmodSync(entrypoint, 0o700);
  fs.appendFileSync(entrypoint, "// compatible rebuilt CLI\n", "utf8");
  fs.chmodSync(entrypoint, 0o500);

  assert.throws(
    () =>
      prepareTrustedCliEnvironment({
        layout,
        cliEntrypoint: entrypoint,
        allowIdentityRotation: true
      }),
    /launcher changed/u
  );
  assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore);

  const metadataLayout = createRunLayout({ projectRoot: root, runId: "tampered-metadata-rotation" });
  prepareTrustedCliEnvironment({ layout: metadataLayout, cliEntrypoint: entrypoint });
  const tamperedMetadataPath = path.join(metadataLayout.root, "trusted-cli.json");
  const tamperedMetadata = JSON.parse(fs.readFileSync(tamperedMetadataPath, "utf8")) as Record<string, unknown>;
  tamperedMetadata.launcher_sha256 = "0".repeat(64);
  fs.writeFileSync(tamperedMetadataPath, `${JSON.stringify(tamperedMetadata, null, 2)}\n`, "utf8");
  assert.throws(
    () =>
      prepareTrustedCliEnvironment({
        layout: metadataLayout,
        cliEntrypoint: entrypoint,
        allowIdentityRotation: true
      }),
    /launcher changed/u
  );
});

test("controller refresh migrates a valid legacy launcher to an immutable closure", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "legacy-migration" });
  const entrypoint = fakeCliEntrypoint(root);
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const historicalNodePath = path.join(root, "retired-node-generation", "bin", "node");
  const legacyLauncher = ["#!/bin/sh", "set -eu", `exec '${historicalNodePath}' '${entrypoint}' "$@"`, ""].join("\n");
  metadata.cli_entrypoint = entrypoint;
  metadata.cli_sha256 = crypto.createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex");
  metadata.launcher_sha256 = crypto.createHash("sha256").update(legacyLauncher).digest("hex");
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.chmodSync(trusted.launcherPath!, 0o700);
  fs.writeFileSync(trusted.launcherPath!, legacyLauncher, "utf8");
  fs.chmodSync(trusted.launcherPath!, 0o500);

  assert.throws(
    () => prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint }),
    /requires controller refresh/u
  );
  const migrated = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: entrypoint,
    allowIdentityRotation: true
  });
  runTrustedJsonValidatorPreflight({ layout, trusted: migrated });
  const migratedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as { cli_entrypoint: string };
  assert.match(migratedMetadata.cli_entrypoint, /trusted-cli-closures\/[0-9a-f]{64}\//u);
});

test("legacy migration rejects stale evidence and recovers only the matching staged rotation", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "legacy-staged-rotation" });
  const entrypoint = fakeCliEntrypoint(root);
  prepareTrustedCliEnvironment({ layout, cliEntrypoint: entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const rotationPath = path.join(layout.root, "trusted-cli-rotation.json");
  const replacement = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const legacyLauncher = ["#!/bin/sh", "set -eu", `exec '${process.execPath}' '${entrypoint}' "$@"`, ""].join("\n");
  const prior = {
    ...replacement,
    cli_entrypoint: entrypoint,
    cli_sha256: crypto.createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex"),
    launcher_sha256: crypto.createHash("sha256").update(legacyLauncher).digest("hex")
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(prior, null, 2)}\n`, "utf8");

  assert.throws(
    () =>
      prepareTrustedCliEnvironment({
        layout,
        cliEntrypoint: entrypoint,
        allowIdentityRotation: true
      }),
    /without authenticated rotation evidence/u
  );

  const staged = {
    schema_version: "ultrafuzz.trusted-cli-rotation.v1",
    prior_metadata_sha256: canonicalDigest(prior),
    replacement_metadata_sha256: "0".repeat(64),
    launcher_sha256: replacement.launcher_sha256
  };
  fs.writeFileSync(rotationPath, `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () =>
      prepareTrustedCliEnvironment({
        layout,
        cliEntrypoint: entrypoint,
        allowIdentityRotation: true
      }),
    /rotation evidence is stale or tampered/u
  );

  staged.replacement_metadata_sha256 = canonicalDigest(replacement);
  const launcherPath = path.join(layout.root, "trusted-bin", "ultrafuzz");
  fs.chmodSync(launcherPath, 0o600);
  fs.writeFileSync(rotationPath, `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o600 });
  const recovered = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: entrypoint,
    allowIdentityRotation: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, "utf8")), replacement);
  assert.equal(fs.existsSync(rotationPath), false);
  assert.equal(fs.statSync(launcherPath).mode & 0o777, 0o500);
  runTrustedJsonValidatorPreflight({ layout, trusted: recovered });
});

test("active trusted CLI stays on its sealed transitive build; refresh adopts a rebuilt validator of the same schemas", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "sealed-transitive-build" });
  const originalEnvelope = preflightEnvelope();
  const source = fakeTransitiveCli(root, JSON.stringify(originalEnvelope));
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: source.entrypoint });
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const metadataBefore = fs.readFileSync(metadataPath);
  const closuresRoot = path.join(layout.root, "trusted-cli-closures");
  const closuresBefore = fs.readdirSync(closuresRoot).sort();
  const rebuild = (mutate: (schema: Record<string, unknown>) => void): void => {
    const envelope = structuredClone(originalEnvelope) as { data: { schema: Record<string, unknown> } };
    mutate(envelope.data.schema);
    fs.chmodSync(source.dependencyEntrypoint, 0o600);
    fs.writeFileSync(
      source.dependencyEntrypoint,
      `export const output = ${JSON.stringify(JSON.stringify(envelope))};\n`,
      "utf8"
    );
    fs.chmodSync(source.dependencyEntrypoint, 0o400);
  };

  // A rebuild that reports different schemas is refused and leaves the sealed CLI in place.
  rebuild((schema) => void (schema.bundle_sha256 = "0".repeat(64)));
  runTrustedJsonValidatorPreflight({ layout, trusted });
  assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore);
  assert.throws(
    () =>
      prepareTrustedCliEnvironment({
        layout,
        cliEntrypoint: source.entrypoint,
        allowIdentityRotation: true
      }),
    /mismatched identity/u
  );
  assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore);
  assert.deepEqual(fs.readdirSync(closuresRoot).sort(), closuresBefore);

  // #921: a rebuild that only changed the validator build validates the same schemas, so controller
  // refresh adopts it instead of leaving the continued run without a trusted validator.
  rebuild((schema) => void (schema.validator_build = "ultrafuzz-json-validator.v1:rebuilt-transitive"));
  const refreshed = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: source.entrypoint,
    allowIdentityRotation: true
  });
  assert.notDeepEqual(fs.readdirSync(closuresRoot).sort(), closuresBefore);
  runTrustedJsonValidatorPreflight({ layout, trusted: refreshed });
});

test("controller refresh keeps a sealed launcher that validates with the run's schemas after this build's changed", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "refresh-after-schema-upgrade" });
  const reportedEnvelope = path.join(root, "reported-envelope.json");
  fs.writeFileSync(reportedEnvelope, JSON.stringify(preflightEnvelope()), "utf8");
  const launched = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: envelopeReadingCliEntrypoint(root, reportedEnvelope)
  });
  // #921: the run was planned with a schema bundle this build no longer installs, and the launcher its
  // launch sealed still validates with that bundle.
  const plannedBundle = "1".repeat(64);
  const metadataPath = path.join(layout.root, "trusted-cli.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  metadata.schema_bundle_sha256 = plannedBundle;
  const metadataMode = fs.statSync(metadataPath).mode & 0o777;
  fs.chmodSync(metadataPath, 0o600);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.chmodSync(metadataPath, metadataMode);
  const envelope = preflightEnvelope() as { data: { schema: Record<string, unknown> } };
  envelope.data.schema.bundle_sha256 = plannedBundle;
  fs.writeFileSync(reportedEnvelope, JSON.stringify(envelope), "utf8");
  const metadataBefore = fs.readFileSync(metadataPath);

  // The installed CLI validates with this build's schemas, so refresh does not try to rotate to it, a
  // rotation its preflight would refuse, and keeps the run's own launcher.
  const refreshed = prepareTrustedCliEnvironment({
    layout,
    cliEntrypoint: fakeCliEntrypoint(path.join(root, "installed")),
    allowIdentityRotation: true
  });
  assert.deepEqual(fs.readFileSync(metadataPath), metadataBefore);
  assert.equal(refreshed.launcherPath, launched.launcherPath);
  assert.equal(refreshed.env.ULTRAFUZZ_SCHEMA_BUNDLE_SHA256, plannedBundle);
  assert.doesNotThrow(() => runTrustedJsonValidatorPreflight({ layout, trusted: refreshed }));
});

test("trusted CLI closure prefers the authenticated execution generation for workspace dependencies", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const valid = JSON.stringify(preflightEnvelope());
  const invalid = structuredClone(preflightEnvelope()) as { data: { schema: { bundle_sha256: string } } };
  invalid.data.schema.bundle_sha256 = "9".repeat(64);
  const source = fakeSnapshotPreferredCli({
    root,
    currentOutput: JSON.stringify(invalid),
    snapshotOutput: valid
  });
  const preferredLayout = createRunLayout({ projectRoot: root, runId: "snapshot-preferred" });
  const trusted = prepareTrustedCliEnvironment({
    layout: preferredLayout,
    cliEntrypoint: source.entrypoint,
    executionSnapshotRoot: source.executionSnapshotRoot
  });
  runTrustedJsonValidatorPreflight({ layout: preferredLayout, trusted });

  const mutableLayout = createRunLayout({ projectRoot: root, runId: "mutable-dependency" });
  assert.throws(
    () => prepareTrustedCliEnvironment({ layout: mutableLayout, cliEntrypoint: source.entrypoint }),
    /mismatched identity/u
  );
});

test("trusted CLI confines ESM, CommonJS, ancestor, and preload module resolution without blocking data reads", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "module-confinement" });
  const source = fakeResolutionEscapeCli(root);
  const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: source.entrypoint });
  const args = ["json", "validate", "--schema", source.dataFile, "--file", source.dataFile, "--json"];

  for (const mode of ["esm", "cjs", "ancestor"]) {
    const escaped = spawnSync(trusted.launcherPath!, args, {
      encoding: "utf8",
      env: { ...process.env, ...trusted.env, ULTRAFUZZ_TEST_RESOLUTION_ESCAPE: mode }
    });
    assert.notEqual(escaped.status, 0, mode);
    assert.match(escaped.stderr, /module resolved outside its content-addressed closure/u, mode);
  }

  const preloadSentinel = path.join(root, "preloaded");
  const guarded = spawnSync(trusted.launcherPath!, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...trusted.env,
      NODE_OPTIONS: `--require=${source.preload}`,
      NODE_PATH: path.join(root, "node_modules"),
      ULTRAFUZZ_TEST_RESOLUTION_ESCAPE: "data"
    }
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(fs.existsSync(preloadSentinel), false);
  assert.doesNotThrow(() => JSON.parse(guarded.stdout));

  const nodePath = spawnSync(trusted.launcherPath!, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...trusted.env,
      NODE_PATH: source.nodePathRoot,
      ULTRAFUZZ_TEST_RESOLUTION_ESCAPE: "node-path"
    }
  });
  assert.notEqual(nodePath.status, 0);
  assert.equal(fs.existsSync(source.nodePathSentinel), false);
});

// @ultrafuzz/runtime depends on the workflow runner so lifecycle commands can run
// the installed one. The validator launcher never loads it, and copying the
// engine's closure into every run would dwarf the CLI's own. Frog is the same:
// the friction log command runs the Frog of the install that rendered the
// workflow, so a copy, with everything only Frog needs, would never run.
test("the trusted CLI closure leaves out the workflow runner and Frog a first-party package depends on", () => {
  const root = temporaryRoot("ultrafuzz-trusted-cli-");
  const layout = createRunLayout({ projectRoot: root, runId: "runner-dependency" });
  const source = fakeTransitiveCli(root, JSON.stringify(preflightEnvelope()));
  const cliRoot = path.dirname(path.dirname(source.entrypoint));
  const cliManifestPath = path.join(cliRoot, "package.json");
  const cliManifest = JSON.parse(fs.readFileSync(cliManifestPath, "utf8")) as { dependencies: Record<string, string> };
  fs.writeFileSync(
    cliManifestPath,
    `${JSON.stringify({ ...cliManifest, name: "@ultrafuzz/fake-cli", dependencies: { ...cliManifest.dependencies, smthrs: "0.35.0", frog: "1.1.0" } })}\n`
  );
  for (const manifest of [
    { name: "smthrs", version: "0.35.0" },
    { name: "frog", version: "1.1.0", dependencies: { incur: "0.4.25" } },
    { name: "incur", version: "0.4.25" }
  ]) {
    const packageRoot = path.join(cliRoot, "node_modules", manifest.name);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify(manifest)}\n`);
  }

  prepareTrustedCliEnvironment({ layout, cliEntrypoint: source.entrypoint });

  const metadata = JSON.parse(fs.readFileSync(path.join(layout.root, "trusted-cli.json"), "utf8")) as {
    cli_entrypoint: string;
  };
  const closureRoot = path.dirname(path.dirname(path.dirname(path.dirname(metadata.cli_entrypoint))));
  const manifest = JSON.parse(fs.readFileSync(path.join(closureRoot, "manifest.json"), "utf8")) as {
    packages: Array<{ name: string }>;
  };
  assert.deepEqual(
    manifest.packages.map((entry) => entry.name),
    ["@ultrafuzz/fake-cli", "transitive-validator-build"]
  );
});

test("trusted CLI rejects transitive closure, path-set, and manifest digest tampering", () => {
  for (const tamper of ["transitive-file", "unexpected-file", "manifest-digest"] as const) {
    const root = temporaryRoot("ultrafuzz-trusted-cli-");
    const layout = createRunLayout({ projectRoot: root, runId: `tampered-${tamper}` });
    const source = fakeTransitiveCli(root, JSON.stringify(preflightEnvelope()));
    const trusted = prepareTrustedCliEnvironment({ layout, cliEntrypoint: source.entrypoint });
    const metadata = JSON.parse(fs.readFileSync(path.join(layout.root, "trusted-cli.json"), "utf8")) as {
      cli_entrypoint: string;
    };
    const closureRoot = path.dirname(path.dirname(path.dirname(path.dirname(metadata.cli_entrypoint))));
    const manifestPath = path.join(closureRoot, "manifest.json");
    if (tamper === "manifest-digest") {
      fs.chmodSync(manifestPath, 0o600);
      fs.appendFileSync(manifestPath, " ", "utf8");
      fs.chmodSync(manifestPath, 0o400);
      assert.throws(
        () => assertTrustedCliLauncher({ layout, launcherPath: trusted.launcherPath! }),
        /manifest digest changed/u
      );
      const launched = spawnSync(trusted.launcherPath!, ["--help"], { encoding: "utf8" });
      assert.notEqual(launched.status, 0);
      assert.match(launched.stderr, /manifest digest changed/u);
      continue;
    }
    if (tamper === "unexpected-file") {
      const packageRoot = path.join(closureRoot, "packages", "000001");
      fs.chmodSync(closureRoot, 0o700);
      fs.chmodSync(packageRoot, 0o700);
      fs.writeFileSync(path.join(packageRoot, "injected.mjs"), "throw new Error('injected');\n", { mode: 0o400 });
      fs.chmodSync(packageRoot, 0o500);
      fs.chmodSync(closureRoot, 0o500);
      assert.throws(
        () => assertTrustedCliLauncher({ layout, launcherPath: trusted.launcherPath! }),
        /closure path set changed/u
      );
      const launched = spawnSync(trusted.launcherPath!, ["--help"], { encoding: "utf8" });
      assert.notEqual(launched.status, 0);
      assert.match(launched.stderr, /closure path set changed/u);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      packages: Array<{ name: string; files: Array<{ path: string }> }>;
    };
    const dependency = manifest.packages.find((entry) => entry.name === "transitive-validator-build");
    assert.ok(dependency);
    const file = dependency.files.find((entry) => entry.path.endsWith("/dist/index.mjs"));
    assert.ok(file);
    const filePath = path.join(closureRoot, ...file.path.split("/"));
    fs.chmodSync(filePath, 0o600);
    fs.appendFileSync(filePath, "// tampered\n", "utf8");
    fs.chmodSync(filePath, 0o400);
    assert.throws(
      () => assertTrustedCliLauncher({ layout, launcherPath: trusted.launcherPath! }),
      /closure file changed/u
    );
    const launched = spawnSync(trusted.launcherPath!, ["--help"], { encoding: "utf8" });
    assert.notEqual(launched.status, 0);
    assert.match(launched.stderr, /closure file changed/u);
  }
});
