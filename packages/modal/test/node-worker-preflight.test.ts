import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { artifactSchemaBundleDigest, artifactSchemaRegistry, VALIDATOR_BUILD_IDENTITY } from "@ultrafuzz/artifacts";
import { describe, expect, it, vi } from "vitest";

import { preflightModalJsonValidator } from "../src/node-worker.js";

function preflightEnvelope(): string {
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  if (findings === undefined) throw new Error("findings schema is not registered");
  return JSON.stringify({
    ok: true,
    data: {
      status: "valid",
      schema: {
        registered: true,
        id: findings.id,
        sha256: findings.sha256,
        bundle_sha256: artifactSchemaBundleDigest(),
        validator_build: VALIDATOR_BUILD_IDENTITY
      }
    }
  });
}

function fakeValidator(root: string, stdout: string): string {
  const cliPath = path.join(root, "ultrafuzz");
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  fs.chmodSync(cliPath, 0o500);
  return cliPath;
}

function withRootOwnedFileStats(run: () => void): void {
  const originalLstat = fs.lstatSync.bind(fs);
  const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike) => {
    const stat = originalLstat(candidate);
    Object.defineProperty(stat, "uid", { configurable: true, value: 0 });
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
      withRootOwnedFileStats(() => expect(() => preflightModalJsonValidator(cliPath)).not.toThrow());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate-key output instead of accepting the JSON.parse projection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-validator-"));
    try {
      const duplicateKeyEnvelope = preflightEnvelope().replace('{"ok":true', '{"ok":true,"ok":true');
      const cliPath = fakeValidator(root, duplicateKeyEnvelope);
      withRootOwnedFileStats(() =>
        expect(() => preflightModalJsonValidator(cliPath)).toThrow(/returned invalid strict JSON/u)
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
