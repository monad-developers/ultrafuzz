import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layoutForRunRoot } from "@ultrafuzz/artifacts";

import { acquireWorkflowStartPreparationLock } from "../src/plan-run.js";
import { acquireWorkflowMutationLock } from "../src/workflow-mutation.js";

test(
  "owned workflow locks clean their exact owner after timestamp restoration fails",
  { skip: process.platform !== "linux", concurrency: false },
  async (t) => {
    const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-owned-lock-cleanup-"));
    t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
    const layout = layoutForRunRoot(runRoot, path.basename(runRoot));
    const originalFutimesSync = fs.futimesSync;
    fs.futimesSync = (() => {
      const error = new Error("injected lock timestamp restoration failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }) as typeof fs.futimesSync;
    t.after(() => {
      fs.futimesSync = originalFutimesSync;
    });

    await assert.rejects(acquireWorkflowStartPreparationLock(layout), /injected lock timestamp restoration failure/u);
    await assert.rejects(acquireWorkflowMutationLock(layout), /injected lock timestamp restoration failure/u);

    for (const lockPath of [path.join(runRoot, ".start-preparation-lock"), path.join(runRoot, ".workflow-mutation")]) {
      assert.equal(fs.existsSync(path.join(lockPath, "owner.json")), false);
      assert.equal(fs.existsSync(lockPath), false);
    }
  }
);

test(
  "owned workflow locks preserve proper-lockfile mtime through the first heartbeat",
  { skip: process.platform !== "linux", concurrency: false },
  async (t) => {
    const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-owned-lock-heartbeat-"));
    t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
    const layout = layoutForRunRoot(runRoot, path.basename(runRoot));

    let releasePreparation: (() => Promise<void>) | undefined;
    let releaseMutation: (() => Promise<void>) | undefined;
    try {
      releasePreparation = await acquireWorkflowStartPreparationLock(layout);
      releaseMutation = await acquireWorkflowMutationLock(layout);
      const lockPaths = [path.join(runRoot, ".start-preparation-lock"), path.join(runRoot, ".workflow-mutation")];
      const acquiredMtimes = new Map(lockPaths.map((lockPath) => [lockPath, fs.statSync(lockPath).mtime.getTime()]));
      for (const lockPath of lockPaths) {
        assert.equal(fs.existsSync(path.join(lockPath, "owner.json")), true);
      }

      await waitForHeartbeat(lockPaths, acquiredMtimes);
    } finally {
      if (releaseMutation !== undefined) await releaseMutation();
      if (releasePreparation !== undefined) await releasePreparation();
    }

    assert.equal(fs.existsSync(path.join(runRoot, ".start-preparation-lock")), false);
    assert.equal(fs.existsSync(path.join(runRoot, ".workflow-mutation")), false);
  }
);

async function waitForHeartbeat(
  lockPaths: readonly string[],
  acquiredMtimes: ReadonlyMap<string, number>
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (lockPaths.some((lockPath) => fs.statSync(lockPath).mtime.getTime() === acquiredMtimes.get(lockPath))) {
    if (Date.now() >= deadline) throw new Error("proper-lockfile heartbeat did not update every owned lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
