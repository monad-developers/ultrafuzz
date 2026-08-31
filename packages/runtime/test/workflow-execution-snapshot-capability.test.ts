import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { descriptorPathsAvailable } from "./descriptor-paths.js";

import {
  acquireWorkflowExecutionSnapshotAnchor,
  bindWorkflowExecutionSnapshotCapability,
  type WorkflowExecutionSnapshotIdentity,
  type WorkflowExecutionSnapshotProtectedEntry
} from "../src/workflow-execution-snapshot-capability.js";

function snapshotFixture(fileCount: number): {
  env: Record<string, string | undefined>;
  identity: WorkflowExecutionSnapshotIdentity;
  files: string[];
} {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-snapshot-attestation-"));
  const snapshotsRoot = path.join(temporaryRoot, "snapshots");
  const root = path.join(snapshotsRoot, "generation");
  fs.mkdirSync(root, { recursive: true });
  const files = Array.from({ length: fileCount }, (_, index) => path.join(root, `protected-${index}.txt`));
  for (const [index, file] of files.entries()) {
    fs.writeFileSync(file, `sealed-${index.toString().padStart(4, "0")}\n`, "utf8");
    fs.chmodSync(file, 0o400);
  }
  fs.chmodSync(root, 0o500);

  const protectedEntries: WorkflowExecutionSnapshotProtectedEntry[] = [];
  const rootStat = fs.lstatSync(root);
  protectedEntries.push({
    kind: "directory",
    relativePath: "",
    device: rootStat.dev,
    inode: rootStat.ino,
    mode: rootStat.mode,
    links: rootStat.nlink
  });
  for (const file of files) {
    const stat = fs.lstatSync(file);
    protectedEntries.push({
      kind: "file",
      relativePath: path.basename(file),
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      links: stat.nlink,
      size: stat.size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    });
  }
  const snapshotsRootStat = fs.lstatSync(snapshotsRoot);
  const identity = {
    root,
    snapshotsRoot,
    snapshotsRootDevice: snapshotsRootStat.dev,
    snapshotsRootInode: snapshotsRootStat.ino,
    snapshotDevice: rootStat.dev,
    snapshotInode: rootStat.ino,
    protectedEntries
  } satisfies WorkflowExecutionSnapshotIdentity;
  return { env: bindWorkflowExecutionSnapshotCapability({}, identity), identity, files };
}

test(
  "one capability authenticates protected bytes once across repeated controller command anchors",
  { concurrency: false, skip: !descriptorPathsAvailable },
  () => {
    const fixture = snapshotFixture(12);
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "readSync")!;
    const originalReadSync = fs.readSync;
    let digestStarts = 0;
    Object.defineProperty(fs, "readSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (args[4] === 0) digestStarts += 1;
        return Reflect.apply(originalReadSync, fs, args) as number;
      }
    });
    try {
      for (let command = 0; command < 25; command += 1) {
        const anchor = acquireWorkflowExecutionSnapshotAnchor({ ...fixture.env });
        assert.ok(anchor);
        anchor.assertCurrent();
        anchor.assertCurrent();
        anchor.close();
      }

      assert.equal(
        digestStarts,
        fixture.files.length,
        "digest work must scale with protected files, not command count"
      );

      const reloaded = bindWorkflowExecutionSnapshotCapability({}, fixture.identity);
      const anchor = acquireWorkflowExecutionSnapshotAnchor(reloaded);
      assert.ok(anchor);
      anchor.close();
      assert.equal(
        digestStarts,
        fixture.files.length * 2,
        "a newly bound evidence capability needs a fresh byte attestation"
      );
    } finally {
      Object.defineProperty(fs, "readSync", originalDescriptor);
    }
  }
);

test(
  "cached attestation rejects a same-size write after mtime and permissions are restored",
  { skip: !descriptorPathsAvailable },
  () => {
    const fixture = snapshotFixture(1);
    const initial = acquireWorkflowExecutionSnapshotAnchor(fixture.env);
    assert.ok(initial);
    initial.close();

    const file = fixture.files[0]!;
    const before = fs.statSync(file);
    const replacement = Buffer.alloc(before.size, 0x78);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, replacement);
    fs.utimesSync(file, before.atime, before.mtime);
    fs.chmodSync(file, 0o400);

    assert.throws(
      () => acquireWorkflowExecutionSnapshotAnchor(fixture.env),
      /workflow execution snapshot changed at the controller command boundary/u
    );
  }
);
