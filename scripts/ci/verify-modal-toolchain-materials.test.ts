import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyModalToolchainMaterials } from "./verify-modal-toolchain-materials.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Modal toolchain material policy", () => {
  it("accepts the checked-in immutable material closure", () => {
    expect(() => verifyModalToolchainMaterials(repoRoot)).not.toThrow();
  });

  it("rejects a mutable base image even when its manifest fingerprint is updated", () => {
    const root = fixture();
    const manifestPath = path.join(root, "packages", "modal", "toolchain-materials.json");
    const manifest = readJson(manifestPath);
    manifest.base_image = "ubuntu:24.04";
    writeManifestAndFingerprint(root, manifest);

    expect(() => verifyModalToolchainMaterials(root)).toThrow(/base image is not digest-pinned/u);
  });

  it("rejects an unchecked toolchain download", () => {
    const root = fixture();
    const dockerfilePath = path.join(root, "packages", "modal", "Dockerfile");
    const manifest = readJson(path.join(root, "packages", "modal", "toolchain-materials.json"));
    const downloads = manifest.downloads;
    const node = Array.isArray(downloads)
      ? downloads.find((download) => isRecord(download) && download.name === "node")
      : undefined;
    const nodeChecksum = isRecord(node) ? node.sha256 : undefined;
    if (typeof nodeChecksum !== "string") throw new Error("fixture has no Node checksum");
    fs.writeFileSync(dockerfilePath, fs.readFileSync(dockerfilePath, "utf8").replace(nodeChecksum, "0".repeat(64)));

    expect(() => verifyModalToolchainMaterials(root)).toThrow(/node Dockerfile download is unchecked/u);
  });

  it("rejects an unlocked global install", () => {
    const root = fixture();
    const dockerfilePath = path.join(root, "packages", "modal", "Dockerfile");
    fs.appendFileSync(dockerfilePath, "\nRUN npm install -g mutable-tool@1.0.0\n");

    expect(() => verifyModalToolchainMaterials(root)).toThrow(/unlocked global npm install is forbidden/u);
  });

  it("rejects manifest-fingerprint and lockfile drift", () => {
    const fingerprintDrift = fixture();
    fs.writeFileSync(
      path.join(fingerprintDrift, "packages", "modal", "toolchain-materials.sha256"),
      `${"0".repeat(64)}  toolchain-materials.json\n`
    );
    expect(() => verifyModalToolchainMaterials(fingerprintDrift)).toThrow(/fingerprint does not match/u);

    const lockDrift = fixture();
    fs.appendFileSync(path.join(lockDrift, "packages", "modal", "security-requirements.lock"), "\n");
    expect(() => verifyModalToolchainMaterials(lockDrift)).toThrow(/python-security lock fingerprint drifted/u);
  });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-materials-"));
  roots.push(root);
  for (const relativePath of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "benchmarks/evmbench/overlay.Dockerfile",
    "packages/evmbench/src/runner.ts",
    "packages/modal/Dockerfile",
    "packages/modal/package.json",
    "packages/modal/security-requirements.lock",
    "packages/modal/scripts/prepare-smithers-seed.mjs",
    "packages/modal/smithers-seed/package-lock.json",
    "packages/modal/smithers-seed/package.json",
    "packages/modal/src/runner.ts",
    "packages/modal/toolchain-materials.json",
    "packages/modal/toolchain-materials.sha256"
  ]) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relativePath), destination);
  }
  return root;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function writeManifestAndFingerprint(root: string, manifest: Record<string, unknown>): void {
  const modalRoot = path.join(root, "packages", "modal");
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(modalRoot, "toolchain-materials.json"), bytes);
  fs.writeFileSync(
    path.join(modalRoot, "toolchain-materials.sha256"),
    `${createHash("sha256").update(bytes).digest("hex")}  toolchain-materials.json\n`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
