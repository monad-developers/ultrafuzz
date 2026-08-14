import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
  VALIDATOR_BUILD_IDENTITY
} from "@ultrafuzz/artifacts";
import { describe, expect, it, vi } from "vitest";

import { preflightModalJsonValidator } from "../src/node-worker.js";

function preflightEnvelope(): string {
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  if (findings === undefined) throw new Error("findings schema is not registered");
  return JSON.stringify({
    schema_version: "ultrafuzz.cli.result.v2",
    command: "json validate",
    ok: true,
    diagnostics: [],
    data: {
      status: "valid",
      diagnostics: [],
      schema: {
        registered: true,
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY
      },
      artifact_sha256: ARTIFACT_VALIDATOR_SMOKE_FIXTURE_SHA256,
      truncated: false
    }
  });
}

function fakeValidator(root: string, stdout: string): string {
  const cliPath = path.join(root, "ultrafuzz");
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  fs.chmodSync(cliPath, 0o500);
  return cliPath;
}

function withModalImageFileStats(run: () => void): void {
  const originalLstat = fs.lstatSync.bind(fs);
  const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) => {
    const stat = originalLstat(candidate);
    Object.defineProperty(stat, "uid", { configurable: true, value: 0 });
    Object.defineProperty(stat, "mode", { configurable: true, value: stat.mode & ~0o022 });
    return stat;
  }) as typeof fs.lstatSync);
  try {
    run();
  } finally {
    lstat.mockRestore();
  }
}

describe("Modal JSON validator startup preflight", () => {
  it("accepts only the pinned registered validator identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-validator-"));
    try {
      const cliPath = fakeValidator(root, preflightEnvelope());
      withModalImageFileStats(() => expect(() => preflightModalJsonValidator(cliPath)).not.toThrow());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate-key output instead of accepting the JSON.parse projection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-validator-"));
    try {
      const duplicateKeyEnvelope = preflightEnvelope().replace(
        '{"schema_version":',
        '{"schema_version":"ultrafuzz.cli.result.v2","schema_version":'
      );
      const cliPath = fakeValidator(root, duplicateKeyEnvelope);
      withModalImageFileStats(() =>
        expect(() => preflightModalJsonValidator(cliPath)).toThrow(/returned an invalid success envelope/u)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing command", (value: Record<string, unknown>) => delete value.command],
    ["unknown envelope field", (value: Record<string, unknown>) => Object.assign(value, { legacy: true })],
    [
      "wrong artifact identity",
      (value: Record<string, unknown>) =>
        Object.assign(value.data as Record<string, unknown>, { artifact_sha256: "0".repeat(64) })
    ],
    [
      "truncated output",
      (value: Record<string, unknown>) => Object.assign(value.data as Record<string, unknown>, { truncated: true })
    ]
  ] as const)("rejects %s", (_name, mutate) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-validator-"));
    try {
      const value = JSON.parse(preflightEnvelope()) as Record<string, unknown>;
      mutate(value);
      const cliPath = fakeValidator(root, JSON.stringify(value));
      withModalImageFileStats(() =>
        expect(() => preflightModalJsonValidator(cliPath)).toThrow(/returned an invalid success envelope/u)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
