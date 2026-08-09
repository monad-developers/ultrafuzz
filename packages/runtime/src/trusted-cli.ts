import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  artifactSchemaBundleDigest,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  artifactValidatorSmokeFixturePath,
  assertNoSymlinkComponents,
  ensureSafeDirectory,
  parseStrictJsonBytes,
  TRUSTED_CLI_METADATA_SCHEMA_VERSION,
  VALIDATOR_BUILD_IDENTITY,
  validateTrustedCliMetadata,
  writeFileDurable,
  writeJsonDurable,
  type TrustedCliMetadata,
  type RunLayout
} from "@ultrafuzz/artifacts";

export const ULTRAFUZZ_TRUSTED_BIN_ENV = "ULTRAFUZZ_TRUSTED_BIN" as const;
export const ULTRAFUZZ_VALIDATOR_BUILD_ENV = "ULTRAFUZZ_VALIDATOR_BUILD" as const;
export const ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV = "ULTRAFUZZ_SCHEMA_BUNDLE_SHA256" as const;
export const TRUSTED_CLI_ENVIRONMENT_VARIABLES = [
  ULTRAFUZZ_TRUSTED_BIN_ENV,
  ULTRAFUZZ_VALIDATOR_BUILD_ENV,
  ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV
] as const;

const TRUSTED_CLI_METADATA_FILE = "trusted-cli.json";

export interface TrustedCliEnvironment {
  active: boolean;
  env: Record<string, string | undefined>;
  environmentVariableNames: readonly string[];
  launcherPath?: string;
}

/**
 * Creates a run-owned launcher ahead of both target PATH and `.smithers/node_modules/.bin`.
 * The host remains authoritative: this launcher exists to give the producer the exact same
 * validator build before it returns, not to turn a same-UID local sandbox into a security boundary.
 */
export function prepareTrustedCliEnvironment(input: {
  layout: RunLayout;
  cliEntrypoint?: string;
  env?: Record<string, string | undefined>;
  required?: boolean;
}): TrustedCliEnvironment {
  const env = { ...(input.env ?? {}) };
  if (input.cliEntrypoint === undefined) {
    if (input.required ?? true) {
      throw new Error("Ultrafuzz CLI entrypoint is required for schema-backed producer validation");
    }
    return { active: false, env, environmentVariableNames: [] };
  }
  const entrypoint = verifiedCliEntrypoint(input.cliEntrypoint);
  const trustedBin = ensureSafeDirectory(input.layout.root, "trusted-bin");
  const launcherPath = path.join(trustedBin, process.platform === "win32" ? "ultrafuzz.cmd" : "ultrafuzz");
  assertNoSymlinkComponents(input.layout.root, launcherPath, "trusted Ultrafuzz launcher");
  const launcher = trustedCliLauncher(entrypoint.path);
  const metadata: TrustedCliMetadata = {
    schema_version: TRUSTED_CLI_METADATA_SCHEMA_VERSION,
    cli_entrypoint: entrypoint.path,
    cli_sha256: entrypoint.sha256,
    launcher_sha256: sha256(Buffer.from(launcher, "utf8")),
    validator_build: VALIDATOR_BUILD_IDENTITY,
    schema_bundle_sha256: artifactSchemaBundleDigest()
  };
  assertValidTrustedCliMetadata(metadata);
  const metadataPath = path.join(input.layout.root, TRUSTED_CLI_METADATA_FILE);
  if (fs.existsSync(metadataPath)) {
    const existing = parseTrustedCliMetadata(readRegularFile(metadataPath, "trusted Ultrafuzz CLI metadata"));
    if (stableJson(existing) !== stableJson(metadata)) {
      throw new Error("trusted Ultrafuzz CLI identity changed since this run was planned");
    }
  } else {
    if (fs.existsSync(launcherPath)) {
      throw new Error("trusted Ultrafuzz CLI launcher exists without identity metadata");
    }
    writeFileDurable(launcherPath, launcher);
    fs.chmodSync(launcherPath, 0o500);
    writeJsonDurable(metadataPath, metadata);
  }
  assertTrustedCliLauncher({ layout: input.layout, launcherPath });

  const sourcePath = env.PATH ?? process.env.PATH ?? "";
  return {
    active: true,
    launcherPath,
    env: {
      ...env,
      PATH: [trustedBin, sourcePath].filter((entry) => entry.length > 0).join(path.delimiter),
      [ULTRAFUZZ_TRUSTED_BIN_ENV]: trustedBin,
      [ULTRAFUZZ_VALIDATOR_BUILD_ENV]: VALIDATOR_BUILD_IDENTITY,
      [ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV]: artifactSchemaBundleDigest()
    },
    environmentVariableNames: TRUSTED_CLI_ENVIRONMENT_VARIABLES
  };
}

export function runTrustedJsonValidatorPreflight(input: { layout: RunLayout; trusted: TrustedCliEnvironment }): void {
  if (!input.trusted.active || input.trusted.launcherPath === undefined) return;
  assertTrustedCliLauncher({ layout: input.layout, launcherPath: input.trusted.launcherPath });
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  if (findings === undefined) throw new Error("validator preflight schema is not registered");
  const stdout = execFileSync(
    input.trusted.launcherPath,
    [
      "json",
      "validate",
      "--schema",
      path.join(artifactSchemaDirectory(), findings.filename),
      "--file",
      artifactValidatorSmokeFixturePath(),
      "--json"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...input.trusted.env },
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true
    }
  );
  const parsed = parseStrictJsonBytes(Buffer.from(stdout, "utf8")) as {
    ok?: unknown;
    data?: {
      status?: unknown;
      schema?: {
        id?: unknown;
        sha256?: unknown;
        bundle_sha256?: unknown;
        validator_build?: unknown;
        registered?: unknown;
      };
    };
  };
  if (
    parsed.ok !== true ||
    parsed.data?.status !== "valid" ||
    parsed.data.schema?.registered !== true ||
    parsed.data.schema.id !== findings.id ||
    parsed.data.schema.sha256 !== findings.sha256 ||
    parsed.data.schema.bundle_sha256 !== artifactSchemaBundleDigest() ||
    parsed.data.schema.validator_build !== VALIDATOR_BUILD_IDENTITY
  ) {
    throw new Error("trusted Ultrafuzz CLI validator preflight returned a mismatched build or schema identity");
  }
  assertTrustedCliLauncher({ layout: input.layout, launcherPath: input.trusted.launcherPath });
}

export function assertTrustedCliLauncher(input: { layout: RunLayout; launcherPath: string }): void {
  const metadataPath = path.join(input.layout.root, TRUSTED_CLI_METADATA_FILE);
  const metadata = parseTrustedCliMetadata(readRegularFile(metadataPath, "trusted Ultrafuzz CLI metadata"));
  if (
    metadata.schema_version !== TRUSTED_CLI_METADATA_SCHEMA_VERSION ||
    metadata.validator_build !== VALIDATOR_BUILD_IDENTITY ||
    metadata.schema_bundle_sha256 !== artifactSchemaBundleDigest()
  ) {
    throw new Error("trusted Ultrafuzz CLI metadata is stale");
  }
  if (verifiedCliEntrypoint(metadata.cli_entrypoint).sha256 !== metadata.cli_sha256) {
    throw new Error("trusted Ultrafuzz CLI entrypoint changed");
  }
  const launcher = readRegularFile(input.launcherPath, "trusted Ultrafuzz launcher");
  if (sha256(launcher) !== metadata.launcher_sha256) throw new Error("trusted Ultrafuzz CLI launcher changed");
}

function parseTrustedCliMetadata(bytes: Uint8Array): TrustedCliMetadata {
  const parsed = parseStrictJsonBytes(bytes);
  assertValidTrustedCliMetadata(parsed);
  return parsed as TrustedCliMetadata;
}

function assertValidTrustedCliMetadata(value: unknown): void {
  const validation = validateTrustedCliMetadata(value);
  if (validation.ok) return;
  const first = validation.issues[0];
  throw new Error(
    `trusted Ultrafuzz CLI metadata is schema-invalid${first === undefined ? "" : ` at ${first.instancePath || "/"}: ${first.message}`}`
  );
}

function verifiedCliEntrypoint(filePath: string): { path: string; sha256: string } {
  if (!path.isAbsolute(filePath)) throw new Error("Ultrafuzz CLI entrypoint must be absolute");
  const resolved = fs.realpathSync(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("Ultrafuzz CLI entrypoint must be an unlinked regular file");
  }
  return { path: resolved, sha256: sha256(readRegularFile(resolved, "Ultrafuzz CLI entrypoint")) };
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

function trustedCliLauncher(entrypoint: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\n"${process.execPath.replaceAll('"', '""')}" "${entrypoint.replaceAll('"', '""')}" %*\r\n`;
  }
  return [
    "#!/bin/sh",
    "set -eu",
    `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(entrypoint)} "$@"`,
    ""
  ].join("\n");
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
