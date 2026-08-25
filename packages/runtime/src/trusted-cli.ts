import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  artifactContractSchemaBinding,
  artifactSchemaDirectory,
  artifactValidatorSmokeFixturePath,
  ensureSafeDirectory,
  parseJsonValidatorPreflightSuccessEnvelope,
  parseStrictJsonBytes,
  TRUSTED_CLI_METADATA_SCHEMA_VERSION,
  VALIDATOR_BUILD_IDENTITY,
  validateTrustedCliMetadata,
  writeFileDurable,
  writeJsonDurable,
  type TrustedCliMetadata,
  type RunLayout
} from "@ultrafuzz/artifacts";

import {
  prepareTrustedCliClosure,
  readTrustedCliClosureForEntrypoint,
  trustedCliChildEnvironment,
  trustedCliClosuresRoot,
  type TrustedCliClosure
} from "./trusted-cli-closure.js";

export const ULTRAFUZZ_TRUSTED_BIN_ENV = "ULTRAFUZZ_TRUSTED_BIN" as const;
export const ULTRAFUZZ_VALIDATOR_BUILD_ENV = "ULTRAFUZZ_VALIDATOR_BUILD" as const;
export const ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV = "ULTRAFUZZ_SCHEMA_BUNDLE_SHA256" as const;
export const TRUSTED_CLI_ENVIRONMENT_VARIABLES = [
  ULTRAFUZZ_TRUSTED_BIN_ENV,
  ULTRAFUZZ_VALIDATOR_BUILD_ENV,
  ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV
] as const;

const TRUSTED_CLI_METADATA_FILE = "trusted-cli.json";
const TRUSTED_CLI_INITIALIZATION_FILE = "trusted-cli-initialization.json";
const TRUSTED_CLI_ROTATION_FILE = "trusted-cli-rotation.json";

interface TrustedCliInitializationReceipt {
  schema_version: "ultrafuzz.trusted-cli-initialization.v1";
  metadata_sha256: string;
  metadata: TrustedCliMetadata;
}

interface TrustedCliRotationReceipt {
  schema_version: "ultrafuzz.trusted-cli-rotation.v1";
  prior_metadata_sha256: string;
  replacement_metadata_sha256: string;
  launcher_sha256: string;
}

export interface TrustedCliEnvironment {
  active: boolean;
  env: Record<string, string | undefined>;
  environmentVariableNames: readonly string[];
  launcherPath?: string;
}

/**
 * Creates a run-owned launcher ahead of both target PATH and `.smithers/node_modules/.bin`.
 * The launcher dispatches only to a verified content-addressed package closure. The host remains
 * authoritative: this is reproducible execution evidence, not a same-UID sandbox boundary.
 */
export function prepareTrustedCliEnvironment(input: {
  layout: RunLayout;
  cliEntrypoint?: string;
  executionSnapshotRoot?: string;
  env?: Record<string, string | undefined>;
  required?: boolean;
  allowIdentityRotation?: boolean;
}): TrustedCliEnvironment {
  const env = { ...(input.env ?? {}) };
  if (input.cliEntrypoint === undefined) {
    if (input.required ?? true) {
      throw new Error("Ultrafuzz CLI entrypoint is required for schema-backed producer validation");
    }
    return { active: false, env, environmentVariableNames: [] };
  }
  const trustedBin = ensureSafeDirectory(input.layout.root, "trusted-bin");
  const launcherPath = path.join(trustedBin, process.platform === "win32" ? "ultrafuzz.cmd" : "ultrafuzz");
  const metadataPath = path.join(input.layout.root, TRUSTED_CLI_METADATA_FILE);
  const initializationPath = path.join(input.layout.root, TRUSTED_CLI_INITIALIZATION_FILE);
  const rotationPath = path.join(input.layout.root, TRUSTED_CLI_ROTATION_FILE);
  const launcher = trustedCliLauncher(metadataPath, trustedCliClosuresRoot(input.layout));
  const launcherSha256 = sha256(Buffer.from(launcher, "utf8"));
  const initialization = fs.existsSync(initializationPath)
    ? parseTrustedCliInitializationReceipt(initializationPath)
    : undefined;

  let metadata: TrustedCliMetadata;
  if (!fs.existsSync(metadataPath)) {
    if (fs.existsSync(launcherPath) && initialization === undefined) {
      throw new Error("trusted Ultrafuzz CLI launcher exists without identity metadata");
    }
    const binding = artifactContractSchemaBinding("ultrafuzz/findings@2");
    if (binding === undefined) throw new Error("validator preflight schema is not registered");
    const initialIdentity = {
      validator_build: VALIDATOR_BUILD_IDENTITY,
      schema_bundle_sha256: binding.schema_bundle_sha256
    };
    const closure = prepareTrustedCliClosure({
      layout: input.layout,
      cliEntrypoint: input.cliEntrypoint,
      ...validatorPreflightSources(input.executionSnapshotRoot),
      ...(input.executionSnapshotRoot === undefined ? {} : { executionSnapshotRoot: input.executionSnapshotRoot }),
      validate: (candidate) => preflightTrustedCliClosure(candidate, initialIdentity)
    });
    metadata = metadataForClosure(closure, launcherSha256, {
      validatorBuild: initialIdentity.validator_build,
      schemaBundleSha256: initialIdentity.schema_bundle_sha256
    });
    const expectedInitialization: TrustedCliInitializationReceipt = {
      schema_version: "ultrafuzz.trusted-cli-initialization.v1",
      metadata_sha256: metadataDigest(metadata),
      metadata
    };
    if (initialization === undefined) {
      writeJsonDurable(initializationPath, expectedInitialization);
    } else if (stableJson(initialization) !== stableJson(expectedInitialization)) {
      throw new Error("trusted Ultrafuzz CLI initialization evidence is stale or tampered");
    }
    if (fs.existsSync(launcherPath)) {
      const observed = readRegularFile(launcherPath, "trusted Ultrafuzz launcher");
      if (!observed.equals(Buffer.from(launcher, "utf8"))) {
        throw new Error("trusted Ultrafuzz CLI initialization launcher changed");
      }
      if (process.platform !== "win32" && (fs.lstatSync(launcherPath).mode & 0o777) !== 0o500) {
        fs.chmodSync(launcherPath, 0o500);
      }
    } else {
      writeFileDurable(launcherPath, launcher, { mode: 0o500 });
    }
    writeJsonDurable(metadataPath, metadata);
    removeTrustedCliReceipt(initializationPath, input.layout.root, "initialization");
  } else {
    metadata = parseTrustedCliMetadata(readRegularFile(metadataPath, "trusted Ultrafuzz CLI metadata"));
    const observedLauncher = readRegularFile(launcherPath, "trusted Ultrafuzz launcher");
    const observedLauncherMode = fs.lstatSync(launcherPath).mode & 0o777;
    const observedLauncherSha256 = sha256(observedLauncher);
    const currentLauncher = observedLauncherSha256 === launcherSha256;
    const legacyLauncher =
      observedLauncherSha256 === metadata.launcher_sha256 && legacyLauncherMatches(metadata, observedLauncher);
    const rotation = fs.existsSync(rotationPath) ? parseTrustedCliRotationReceipt(rotationPath) : undefined;
    let currentClosure: TrustedCliClosure | undefined;
    if (currentLauncher) {
      try {
        currentClosure = readTrustedCliClosureForEntrypoint({
          layout: input.layout,
          cliEntrypoint: metadata.cli_entrypoint
        });
      } catch (error) {
        if (input.allowIdentityRotation !== true) throw error;
        // A controller refresh can recover the fail-closed intermediate state
        // where the canonical dispatcher was published before legacy metadata.
      }
    }
    if (!currentLauncher && !legacyLauncher) {
      throw new Error("trusted Ultrafuzz CLI launcher changed");
    }
    if (currentClosure !== undefined && observedLauncherSha256 !== metadata.launcher_sha256) {
      throw new Error("trusted Ultrafuzz CLI launcher changed");
    }
    if (currentClosure !== undefined && currentClosure.cliSha256 !== metadata.cli_sha256) {
      throw new Error("trusted Ultrafuzz CLI entrypoint changed");
    }
    if (initialization !== undefined) {
      if (
        initialization.metadata_sha256 !== metadataDigest(metadata) ||
        stableJson(initialization.metadata) !== stableJson(metadata) ||
        !currentLauncher
      ) {
        throw new Error("trusted Ultrafuzz CLI initialization evidence is stale or tampered");
      }
      removeTrustedCliReceipt(initializationPath, input.layout.root, "initialization");
    }
    if (rotation !== undefined && input.allowIdentityRotation !== true) {
      throw new Error("trusted Ultrafuzz CLI rotation requires controller refresh to finish");
    }
    if (currentLauncher && currentClosure === undefined && rotation === undefined) {
      throw new Error("trusted Ultrafuzz CLI launcher changed without authenticated rotation evidence");
    }
    if (input.allowIdentityRotation === true) {
      const candidate = prepareTrustedCliClosure({
        layout: input.layout,
        cliEntrypoint: input.cliEntrypoint,
        ...validatorPreflightSources(input.executionSnapshotRoot),
        ...(input.executionSnapshotRoot === undefined ? {} : { executionSnapshotRoot: input.executionSnapshotRoot }),
        validate: (closure) => preflightTrustedCliClosure(closure, metadata)
      });
      const replacement = metadataForClosure(candidate, launcherSha256, {
        validatorBuild: metadata.validator_build,
        schemaBundleSha256: metadata.schema_bundle_sha256
      });
      const expectedRotation: TrustedCliRotationReceipt = {
        schema_version: "ultrafuzz.trusted-cli-rotation.v1",
        prior_metadata_sha256: metadataDigest(metadata),
        replacement_metadata_sha256: metadataDigest(replacement),
        launcher_sha256: launcherSha256
      };
      if (rotation !== undefined) {
        const metadataSha256 = metadataDigest(metadata);
        if (
          rotation.launcher_sha256 !== launcherSha256 ||
          rotation.replacement_metadata_sha256 !== expectedRotation.replacement_metadata_sha256 ||
          (rotation.prior_metadata_sha256 !== metadataSha256 && rotation.replacement_metadata_sha256 !== metadataSha256)
        ) {
          throw new Error("trusted Ultrafuzz CLI rotation evidence is stale or tampered");
        }
      } else if (!currentLauncher) {
        writeJsonDurable(rotationPath, expectedRotation);
      }
      if (currentLauncher && process.platform !== "win32" && observedLauncherMode !== 0o500) {
        if (rotation === undefined) throw new Error("trusted Ultrafuzz CLI launcher mode changed");
        fs.chmodSync(launcherPath, 0o500);
      }
      if (!currentLauncher) {
        // Publish the dispatcher first. With legacy metadata this intermediate
        // state rejects execution, and another refresh can complete it safely.
        writeFileDurable(launcherPath, launcher, { mode: 0o500 });
      }
      if (stableJson(metadata) !== stableJson(replacement)) writeJsonDurable(metadataPath, replacement);
      if (rotation !== undefined || !currentLauncher) {
        removeTrustedCliReceipt(rotationPath, input.layout.root, "rotation");
      }
      metadata = replacement;
    } else if (currentClosure === undefined) {
      throw new Error("trusted Ultrafuzz CLI identity requires controller refresh to seal its dependency closure");
    }
  }

  assertTrustedCliLauncher({ layout: input.layout, launcherPath });
  return {
    active: true,
    launcherPath,
    env: {
      ...env,
      [ULTRAFUZZ_TRUSTED_BIN_ENV]: trustedBin,
      [ULTRAFUZZ_VALIDATOR_BUILD_ENV]: metadata.validator_build,
      [ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV]: metadata.schema_bundle_sha256
    },
    environmentVariableNames: TRUSTED_CLI_ENVIRONMENT_VARIABLES
  };
}

export function runTrustedJsonValidatorPreflight(input: { layout: RunLayout; trusted: TrustedCliEnvironment }): void {
  if (!input.trusted.active || input.trusted.launcherPath === undefined) return;
  const { metadata, closure } = assertTrustedCliLauncher({
    layout: input.layout,
    launcherPath: input.trusted.launcherPath
  });
  const paths = closurePreflightPaths(closure);
  const stdout = execFileSync(
    input.trusted.launcherPath,
    ["json", "validate", "--schema", paths.schemaPath, "--file", paths.fixturePath, "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, ...input.trusted.env },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true
    }
  );
  parseJsonValidatorPreflightSuccessEnvelope(Buffer.from(stdout, "utf8"), {
    schemaId: paths.schemaId,
    schemaSha256: paths.schemaSha256,
    schemaBundleSha256: metadata.schema_bundle_sha256,
    validatorBuild: metadata.validator_build,
    artifactSha256: paths.fixtureSha256
  });
  assertTrustedCliLauncher({ layout: input.layout, launcherPath: input.trusted.launcherPath });
}

export function assertTrustedCliLauncher(input: { layout: RunLayout; launcherPath: string }): {
  metadata: TrustedCliMetadata;
  closure: TrustedCliClosure;
} {
  const metadataPath = path.join(input.layout.root, TRUSTED_CLI_METADATA_FILE);
  const metadata = parseTrustedCliMetadata(readRegularFile(metadataPath, "trusted Ultrafuzz CLI metadata"));
  const expectedLauncher = Buffer.from(trustedCliLauncher(metadataPath, trustedCliClosuresRoot(input.layout)), "utf8");
  const launcher = readRegularFile(input.launcherPath, "trusted Ultrafuzz launcher");
  if (
    (process.platform !== "win32" && (fs.lstatSync(input.launcherPath).mode & 0o777) !== 0o500) ||
    sha256(launcher) !== metadata.launcher_sha256 ||
    !launcher.equals(expectedLauncher)
  ) {
    throw new Error("trusted Ultrafuzz CLI launcher changed");
  }
  const closure = readTrustedCliClosureForEntrypoint({
    layout: input.layout,
    cliEntrypoint: metadata.cli_entrypoint
  });
  if (closure.cliSha256 !== metadata.cli_sha256) throw new Error("trusted Ultrafuzz CLI entrypoint changed");
  return { metadata, closure };
}

function preflightTrustedCliClosure(
  closure: TrustedCliClosure,
  expected: { validator_build: string; schema_bundle_sha256: string }
): void {
  const paths = closurePreflightPaths(closure);
  const stdout = execFileSync(
    process.execPath,
    [
      "--no-global-search-paths",
      "--import",
      closure.moduleConfinementPath,
      closure.cliEntrypoint,
      "json",
      "validate",
      "--schema",
      paths.schemaPath,
      "--file",
      paths.fixturePath,
      "--json"
    ],
    {
      encoding: "utf8",
      env: trustedCliChildEnvironment(process.env),
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true
    }
  );
  parseJsonValidatorPreflightSuccessEnvelope(Buffer.from(stdout, "utf8"), {
    schemaId: paths.schemaId,
    schemaSha256: paths.schemaSha256,
    schemaBundleSha256: expected.schema_bundle_sha256,
    validatorBuild: expected.validator_build,
    artifactSha256: paths.fixtureSha256
  });
}

function closurePreflightPaths(closure: TrustedCliClosure): {
  schemaPath: string;
  fixturePath: string;
  schemaId: string;
  schemaSha256: string;
  fixtureSha256: string;
} {
  const schemaPath = closure.validatorSchemaPath;
  const fixturePath = closure.validatorFixturePath;
  const schemaBytes = readRegularFile(schemaPath, "trusted validator preflight schema");
  const schema = parseStrictJsonBytes(schemaBytes);
  if (
    typeof schema !== "object" ||
    schema === null ||
    Array.isArray(schema) ||
    typeof (schema as Record<string, unknown>).$id !== "string"
  ) {
    throw new Error("trusted validator preflight schema has no identity");
  }
  return {
    schemaPath,
    fixturePath,
    schemaId: (schema as { $id: string }).$id,
    schemaSha256: sha256(schemaBytes),
    fixtureSha256: sha256(readRegularFile(fixturePath, "trusted validator preflight fixture"))
  };
}

function validatorPreflightSources(executionSnapshotRoot: string | undefined): {
  validatorSchemaPath: string;
  validatorFixturePath: string;
} {
  if (executionSnapshotRoot === undefined) {
    return {
      validatorSchemaPath: path.join(artifactSchemaDirectory(), "findings.schema.json"),
      validatorFixturePath: artifactValidatorSmokeFixturePath()
    };
  }
  const schemaRoot = path.join(path.resolve(executionSnapshotRoot), "modules", "@ultrafuzz", "artifacts", "schema");
  return {
    validatorSchemaPath: path.join(schemaRoot, "findings.schema.json"),
    validatorFixturePath: path.join(schemaRoot, "validator-smoke.valid.json")
  };
}

function metadataForClosure(
  closure: TrustedCliClosure,
  launcherSha256: string,
  identity: { validatorBuild: string; schemaBundleSha256: string }
): TrustedCliMetadata {
  const metadata: TrustedCliMetadata = {
    schema_version: TRUSTED_CLI_METADATA_SCHEMA_VERSION,
    cli_entrypoint: closure.cliEntrypoint,
    cli_sha256: closure.cliSha256,
    launcher_sha256: launcherSha256,
    validator_build: identity.validatorBuild,
    schema_bundle_sha256: identity.schemaBundleSha256
  };
  assertValidTrustedCliMetadata(metadata);
  return metadata;
}

function parseTrustedCliMetadata(bytes: Uint8Array): TrustedCliMetadata {
  const parsed = parseStrictJsonBytes(bytes);
  assertValidTrustedCliMetadata(parsed);
  return parsed as TrustedCliMetadata;
}

function parseTrustedCliInitializationReceipt(filePath: string): TrustedCliInitializationReceipt {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  ) {
    throw new Error("trusted Ultrafuzz CLI initialization evidence is unsafe");
  }
  const value = parseStrictJsonBytes(readRegularFile(filePath, "trusted Ultrafuzz CLI initialization evidence"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== ["metadata", "metadata_sha256", "schema_version"].sort().join("\0")
  ) {
    throw new Error("trusted Ultrafuzz CLI initialization evidence is invalid");
  }
  const record = value as Record<string, unknown>;
  assertValidTrustedCliMetadata(record.metadata);
  if (
    record.schema_version !== "ultrafuzz.trusted-cli-initialization.v1" ||
    typeof record.metadata_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.metadata_sha256) ||
    metadataDigest(record.metadata as TrustedCliMetadata) !== record.metadata_sha256
  ) {
    throw new Error("trusted Ultrafuzz CLI initialization evidence is invalid");
  }
  return record as unknown as TrustedCliInitializationReceipt;
}

function parseTrustedCliRotationReceipt(filePath: string): TrustedCliRotationReceipt {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
  ) {
    throw new Error("trusted Ultrafuzz CLI rotation evidence is unsafe");
  }
  const value = parseStrictJsonBytes(readRegularFile(filePath, "trusted Ultrafuzz CLI rotation evidence"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      ["launcher_sha256", "prior_metadata_sha256", "replacement_metadata_sha256", "schema_version"].sort().join("\0")
  ) {
    throw new Error("trusted Ultrafuzz CLI rotation evidence is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== "ultrafuzz.trusted-cli-rotation.v1" ||
    typeof record.prior_metadata_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.prior_metadata_sha256) ||
    typeof record.replacement_metadata_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.replacement_metadata_sha256) ||
    typeof record.launcher_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.launcher_sha256)
  ) {
    throw new Error("trusted Ultrafuzz CLI rotation evidence is invalid");
  }
  return record as unknown as TrustedCliRotationReceipt;
}

function removeTrustedCliReceipt(filePath: string, runRoot: string, kind: "initialization" | "rotation"): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`trusted Ultrafuzz CLI ${kind} evidence is unsafe`);
  }
  fs.unlinkSync(filePath);
  const descriptor = fs.openSync(runRoot, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertValidTrustedCliMetadata(value: unknown): void {
  const validation = validateTrustedCliMetadata(value);
  if (validation.ok) return;
  const first = validation.issues[0];
  throw new Error(
    `trusted Ultrafuzz CLI metadata is schema-invalid${first === undefined ? "" : ` at ${first.instancePath || "/"}: ${first.message}`}`
  );
}

function legacyLauncherMatches(metadata: TrustedCliMetadata, launcher: Buffer): boolean {
  if (process.platform === "win32") {
    const prefix = '@echo off\r\n"';
    const suffix = `" "${metadata.cli_entrypoint.replaceAll('"', '""')}" %*\r\n`;
    const source = launcher.toString("utf8");
    if (!source.startsWith(prefix) || !source.endsWith(suffix)) return false;
    const interpreterToken = source.slice(prefix.length, -suffix.length);
    const interpreter = interpreterToken.replaceAll('""', '"');
    return path.win32.isAbsolute(interpreter) && interpreter.replaceAll('"', '""') === interpreterToken;
  }
  const prefix = "#!/bin/sh\nset -eu\nexec ";
  const suffix = ` ${shellSingleQuote(metadata.cli_entrypoint)} "$@"\n`;
  const source = launcher.toString("utf8");
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return false;
  const interpreterToken = source.slice(prefix.length, -suffix.length);
  if (!interpreterToken.startsWith("'") || !interpreterToken.endsWith("'")) return false;
  const interpreter = interpreterToken.slice(1, -1).replaceAll(`'"'"'`, "'");
  return path.isAbsolute(interpreter) && shellSingleQuote(interpreter) === interpreterToken;
}

function readRegularFile(filePath: string, label: string): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${label} must be an unlinked regular file`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function trustedCliLauncher(
  metadataPath: string,
  closuresRoot: string,
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath
): string {
  const windows = platform === "win32";
  const platformPath = windows ? path.win32 : path.posix;
  const canonicalLauncherPath = platformPath.join(
    platformPath.dirname(metadataPath),
    "trusted-bin",
    windows ? "ultrafuzz.cmd" : "ultrafuzz"
  );
  const source = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const metadataPath = ${JSON.stringify(metadataPath)};
const closuresRoot = ${JSON.stringify(closuresRoot)};
const launcherPath = ${JSON.stringify(canonicalLauncherPath)};
const enforcePosixModes = ${JSON.stringify(!windows)};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
if (path.resolve(process.argv[1]) !== path.resolve(launcherPath)) throw new Error("trusted Ultrafuzz CLI launcher path changed");
const metadataStat = fs.lstatSync(metadataPath);
if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1 || (enforcePosixModes && (metadataStat.mode & 0o777) !== 0o600)) throw new Error("trusted Ultrafuzz CLI metadata is unsafe");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const launcherStat = fs.lstatSync(launcherPath);
if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.nlink !== 1 || (enforcePosixModes && (launcherStat.mode & 0o777) !== 0o500)) throw new Error("trusted Ultrafuzz CLI launcher is unsafe");
const launcher = fs.readFileSync(launcherPath);
if (sha256(launcher) !== metadata.launcher_sha256) throw new Error("trusted Ultrafuzz CLI launcher changed");
const relative = path.relative(closuresRoot, path.resolve(metadata.cli_entrypoint)).split(path.sep).join("/");
const digest = relative.split("/")[0];
if (!/^[0-9a-f]{64}$/.test(digest) || relative.startsWith("../") || relative === digest) throw new Error("trusted Ultrafuzz CLI entrypoint is outside its closure");
const root = path.join(closuresRoot, digest);
const rootStat = fs.lstatSync(root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("trusted CLI closure root is unsafe");
const manifestPath = path.join(root, "manifest.json");
const manifestStat = fs.lstatSync(manifestPath);
if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || (enforcePosixModes && (manifestStat.mode & 0o777) !== 0o400)) throw new Error("trusted CLI closure manifest is unsafe");
const manifestBytes = fs.readFileSync(manifestPath);
if (sha256(manifestBytes) !== digest) throw new Error("trusted CLI closure manifest digest changed");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (path.resolve(root, ...manifest.cli_entrypoint.split("/")) !== path.resolve(metadata.cli_entrypoint)) throw new Error("trusted CLI closure entrypoint changed");
const byId = new Map(manifest.packages.map((entry) => [entry.id, entry]));
const confinementPath = path.join(root, ...manifest.module_confinement.path.split("/"));
const confinementStat = fs.lstatSync(confinementPath);
if (!confinementStat.isFile() || confinementStat.isSymbolicLink() || confinementStat.nlink !== 1 || (enforcePosixModes && (confinementStat.mode & 0o777) !== 0o400) || sha256(fs.readFileSync(confinementPath)) !== manifest.module_confinement.sha256) throw new Error("trusted CLI module confinement changed");
const expectedEntries = new Set(["manifest.json", manifest.module_confinement.path]);
const addParents = (value) => {
  let current = path.posix.dirname(value);
  while (current !== ".") {
    expectedEntries.add(current);
    current = path.posix.dirname(current);
  }
};
for (const file of Object.values(manifest.validator_preflight)) {
  const candidate = path.join(root, ...file.path.split("/"));
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (enforcePosixModes && (stat.mode & 0o777) !== 0o400) || sha256(fs.readFileSync(candidate)) !== file.sha256) throw new Error("trusted CLI validator preflight identity changed");
  expectedEntries.add(file.path);
  addParents(file.path);
}
for (const entry of manifest.packages) {
  expectedEntries.add(entry.snapshot_path);
  addParents(entry.snapshot_path);
  for (const file of entry.files) {
    const candidate = path.join(root, ...file.path.split("/"));
    const stat = fs.lstatSync(candidate);
    const expectedMode = file.executable ? 0o500 : 0o400;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (enforcePosixModes && (stat.mode & 0o777) !== expectedMode) || sha256(fs.readFileSync(candidate)) !== file.sha256) throw new Error("trusted CLI closure file changed: " + file.path);
    expectedEntries.add(file.path);
    addParents(file.path);
  }
  for (const [name, targetId] of Object.entries(entry.dependencies)) {
    const target = byId.get(targetId);
    if (target === undefined) throw new Error("trusted CLI closure dependency target is missing");
    const link = path.join(root, ...entry.snapshot_path.split("/"), "node_modules", ...name.split("/"));
    const expected = path.join(root, ...target.snapshot_path.split("/"));
    if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(expected)) throw new Error("trusted CLI closure dependency link changed: " + name);
    const linkPath = path.posix.join(entry.snapshot_path, "node_modules", name);
    expectedEntries.add(linkPath);
    addParents(linkPath);
  }
}
const observedEntries = [];
const pending = [root];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    const relativeEntry = path.relative(root, candidate).split(path.sep).join("/");
    observedEntries.push(relativeEntry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (enforcePosixModes && (fs.lstatSync(candidate).mode & 0o777) !== 0o500) throw new Error("trusted CLI closure directory mode changed: " + relativeEntry);
      pending.push(candidate);
    }
  }
}
if ((enforcePosixModes && (rootStat.mode & 0o777) !== 0o500) || observedEntries.length !== expectedEntries.size || observedEntries.some((entry) => !expectedEntries.has(entry))) throw new Error("trusted CLI closure path set changed");
if (sha256(fs.readFileSync(metadata.cli_entrypoint)) !== metadata.cli_sha256) throw new Error("trusted Ultrafuzz CLI entrypoint changed");
const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) if (["NODE_OPTIONS", "NODE_PATH"].includes(name.toUpperCase())) delete childEnvironment[name];
delete childEnvironment.ULTRAFUZZ_TRUSTED_DISPATCH;
const child = spawnSync(process.execPath, ["--no-global-search-paths", "--import", confinementPath, metadata.cli_entrypoint, ...process.argv.slice(2)], { env: childEnvironment, stdio: "inherit" });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exitCode = child.status === null ? 1 : child.status;
`;
  const encodedDispatch = Buffer.from(source.trimStart(), "utf8").toString("base64");
  const dispatch = `eval(Buffer.from(${JSON.stringify(encodedDispatch)}, "base64").toString("utf8"))`;
  if (windows) {
    if (encodedDispatch.length > 30_000) throw new Error("trusted CLI Windows dispatcher exceeds environment limit");
    const chunks = encodedDispatch.match(/.{1,3000}/gu) ?? [];
    const lines = ["@echo off", "setlocal", 'set "NODE_OPTIONS="', 'set "NODE_PATH="'];
    for (const [index, chunk] of chunks.entries()) {
      lines.push(
        index === 0
          ? `set "ULTRAFUZZ_TRUSTED_DISPATCH=${chunk}"`
          : `set "ULTRAFUZZ_TRUSTED_DISPATCH=%ULTRAFUZZ_TRUSTED_DISPATCH%${chunk}"`
      );
    }
    const escapedNode = nodePath.replaceAll("%", "%%").replaceAll('"', '""');
    const escapedLauncher = canonicalLauncherPath.replaceAll("%", "%%").replaceAll('"', '""');
    lines.push(
      `"${escapedNode}" --no-global-search-paths -e "eval(Buffer.from(process.env.ULTRAFUZZ_TRUSTED_DISPATCH,'base64').toString('utf8'))" "${escapedLauncher}" %*`,
      ""
    );
    return lines.join("\r\n");
  }
  return [
    "#!/bin/sh",
    "set -eu",
    "unset NODE_OPTIONS NODE_PATH",
    `exec ${shellSingleQuote(nodePath)} --no-global-search-paths -e ${shellSingleQuote(dispatch)} ${shellSingleQuote(canonicalLauncherPath)} "$@"`,
    ""
  ].join("\n");
}

export function renderTrustedCliLauncherForTests(input: {
  metadataPath: string;
  closuresRoot: string;
  platform: NodeJS.Platform;
  nodePath: string;
}): string {
  return trustedCliLauncher(input.metadataPath, input.closuresRoot, input.platform, input.nodePath);
}

function shellSingleQuote(value: string): string {
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new Error("launcher path contains control characters");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metadataDigest(metadata: TrustedCliMetadata): string {
  return sha256(Buffer.from(stableJson(metadata), "utf8"));
}
