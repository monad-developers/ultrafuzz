import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layoutForRunRoot } from "@ultrafuzz/artifacts";

import { acquireWorkflowStartPreparationLock } from "../src/plan-run.js";
import { acquireWorkflowMutationLock, selectWorkflowMutationProcessIdentityToken } from "../src/workflow-mutation.js";

test("workflow mutation identity selection remains usable without Linux procfs", () => {
  assert.equal(
    selectWorkflowMutationProcessIdentityToken({
      observedStartToken: "linux-start-token",
      isCurrentProcess: true,
      processNonce: "module-nonce"
    }),
    "linux-start-token"
  );
  assert.equal(
    selectWorkflowMutationProcessIdentityToken({
      observedStartToken: null,
      isCurrentProcess: true,
      processNonce: "module-nonce"
    }),
    "process-nonce:module-nonce"
  );
  assert.equal(
    selectWorkflowMutationProcessIdentityToken({
      observedStartToken: null,
      isCurrentProcess: false,
      processNonce: "module-nonce"
    }),
    null
  );
});

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
  "stale workflow lock reclamation never removes a replacement acquired by another process",
  { skip: process.platform !== "linux", concurrency: false },
  async (t) => {
    for (const lockKind of ["start", "mutation"] as const) {
      const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `ufz-lock-race-${lockKind}-`));
      t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
      const lockName = lockKind === "start" ? ".start-preparation-lock" : ".workflow-mutation";
      const lockPath = path.join(runRoot, lockName);
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, "owner.json"),
        `${JSON.stringify({ pid: 2_147_483_647, process_start: "dead", acquired_at: new Date().toISOString() })}\n`
      );
      const childScript = path.join(runRoot, "contend.mjs");
      const planRunModule = new URL("../src/plan-run.js", import.meta.url).href;
      const mutationModule = new URL("../src/workflow-mutation.js", import.meta.url).href;
      const artifactsModule = import.meta.resolve("@ultrafuzz/artifacts");
      fs.writeFileSync(
        childScript,
        `import fs from "node:fs";\n` +
          `import path from "node:path";\n` +
          `import { layoutForRunRoot } from ${JSON.stringify(artifactsModule)};\n` +
          `import { acquireWorkflowStartPreparationLock } from ${JSON.stringify(planRunModule)};\n` +
          `import { acquireWorkflowMutationLock } from ${JSON.stringify(mutationModule)};\n` +
          `const [root, kind, id] = process.argv.slice(2);\n` +
          `const layout = layoutForRunRoot(root, path.basename(root));\n` +
          `const acquire = kind === "start" ? acquireWorkflowStartPreparationLock : acquireWorkflowMutationLock;\n` +
          `const release = await acquire(layout);\n` +
          `const active = path.join(root, "critical-section");\n` +
          `let descriptor;\n` +
          `try { descriptor = fs.openSync(active, "wx"); } catch { fs.writeFileSync(path.join(root, "violation"), "overlap\\n"); }\n` +
          `fs.writeFileSync(path.join(root, \`held-\${id}\`), "held\\n");\n` +
          `while (!fs.existsSync(path.join(root, \`release-\${id}\`))) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
          `if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(active); }\n` +
          `await release();\n`,
        "utf8"
      );
      const children = ["a", "b"].map((id) =>
        spawn(process.execPath, [childScript, runRoot, lockKind, id], {
          cwd: runRoot,
          stdio: ["ignore", "ignore", "pipe"]
        })
      );
      try {
        const first = await waitForOneHeldMarker(runRoot);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(fs.existsSync(path.join(runRoot, "violation")), false, lockKind);
        assert.deepEqual(heldMarkerIds(runRoot), [first], lockKind);
        fs.writeFileSync(path.join(runRoot, `release-${first}`), "release\n");
        const second = first === "a" ? "b" : "a";
        await waitForPath(path.join(runRoot, `held-${second}`));
        assert.equal(fs.existsSync(path.join(runRoot, "violation")), false, lockKind);
        fs.writeFileSync(path.join(runRoot, `release-${second}`), "release\n");
        const exits = await Promise.all(children.map((child) => childExit(child)));
        assert.deepEqual(exits, [0, 0], lockKind);
        assert.equal(fs.existsSync(lockPath), false, lockKind);
      } finally {
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
      }
    }
  }
);

test(
  "alive-to-dead workflow lock races serialize reclamation with primary acquisition",
  { skip: process.platform !== "linux", concurrency: false },
  async (t) => {
    for (const lockKind of ["start", "mutation"] as const) {
      const runRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `ufz-lock-live-race-${lockKind}-`));
      t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
      const lockName = lockKind === "start" ? ".start-preparation-lock" : ".workflow-mutation";
      const lockPath = path.join(runRoot, lockName);
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      const contenders: ReturnType<typeof spawn>[] = [];
      try {
        await new Promise<void>((resolve, reject) => {
          owner.once("spawn", resolve);
          owner.once("error", reject);
        });
        const processStart = linuxProcessStartToken(owner.pid!);
        if (processStart === null) throw new Error("live lock owner has no process start token");
        fs.mkdirSync(lockPath);
        fs.writeFileSync(
          path.join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: owner.pid, process_start: processStart, acquired_at: new Date().toISOString() })}\n`
        );

        const childScript = path.join(runRoot, "live-race-contend.mjs");
        const planRunModule = new URL("../src/plan-run.js", import.meta.url).href;
        const mutationModule = new URL("../src/workflow-mutation.js", import.meta.url).href;
        const artifactsModule = import.meta.resolve("@ultrafuzz/artifacts");
        const properLockfileModule = import.meta.resolve("proper-lockfile");
        fs.writeFileSync(
          childScript,
          `import fs from "node:fs";\n` +
            `import path from "node:path";\n` +
            `import lockfile from ${JSON.stringify(properLockfileModule)};\n` +
            `import { layoutForRunRoot } from ${JSON.stringify(artifactsModule)};\n` +
            `import { acquireWorkflowStartPreparationLock } from ${JSON.stringify(planRunModule)};\n` +
            `import { acquireWorkflowMutationLock } from ${JSON.stringify(mutationModule)};\n` +
            `const [root, kind, id, pause] = process.argv.slice(2);\n` +
            `const lockName = kind === "start" ? ".start-preparation-lock" : ".workflow-mutation";\n` +
            `const primaryPath = path.join(root, lockName);\n` +
            `const originalLock = lockfile.lock;\n` +
            `let announced = false;\n` +
            `lockfile.lock = async (...args) => {\n` +
            `  if (!announced && path.resolve(args[1]?.lockfilePath ?? "") === primaryPath) {\n` +
            `    announced = true;\n` +
            `    fs.writeFileSync(path.join(root, \`before-primary-\${id}\`), "ready\\n");\n` +
            `    while (pause === "yes" && !fs.existsSync(path.join(root, \`allow-primary-\${id}\`))) {\n` +
            `      await new Promise((resolve) => setTimeout(resolve, 10));\n` +
            `    }\n` +
            `  }\n` +
            `  return originalLock(...args);\n` +
            `};\n` +
            `const layout = layoutForRunRoot(root, path.basename(root));\n` +
            `const acquire = kind === "start" ? acquireWorkflowStartPreparationLock : acquireWorkflowMutationLock;\n` +
            `const release = await acquire(layout);\n` +
            `const active = path.join(root, "live-race-critical-section");\n` +
            `let descriptor;\n` +
            `try { descriptor = fs.openSync(active, "wx"); } catch { fs.writeFileSync(path.join(root, "violation"), "overlap\\n"); }\n` +
            `fs.writeFileSync(path.join(root, \`held-\${id}\`), "held\\n");\n` +
            `while (!fs.existsSync(path.join(root, \`release-\${id}\`))) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
            `if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(active); }\n` +
            `await release();\n`,
          "utf8"
        );

        const firstContender = spawn(process.execPath, [childScript, runRoot, lockKind, "a", "yes"], {
          cwd: runRoot,
          stdio: ["ignore", "ignore", "pipe"]
        });
        contenders.push(firstContender);
        await waitForPath(path.join(runRoot, "before-primary-a"));
        owner.kill("SIGKILL");
        await childExit(owner);

        const secondContender = spawn(process.execPath, [childScript, runRoot, lockKind, "b", "no"], {
          cwd: runRoot,
          stdio: ["ignore", "ignore", "pipe"]
        });
        contenders.push(secondContender);
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(fs.existsSync(path.join(runRoot, "before-primary-b")), false, lockKind);

        fs.writeFileSync(path.join(runRoot, "allow-primary-a"), "allow\n");
        const first = await waitForOneHeldMarker(runRoot);
        assert.equal(fs.existsSync(path.join(runRoot, "violation")), false, lockKind);
        fs.writeFileSync(path.join(runRoot, `release-${first}`), "release\n");
        const second = first === "a" ? "b" : "a";
        await waitForPath(path.join(runRoot, `held-${second}`));
        assert.equal(fs.existsSync(path.join(runRoot, "violation")), false, lockKind);
        fs.writeFileSync(path.join(runRoot, `release-${second}`), "release\n");
        assert.deepEqual(await Promise.all(contenders.map((child) => childExit(child))), [0, 0], lockKind);
        assert.equal(fs.existsSync(lockPath), false, lockKind);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
        for (const contender of contenders) {
          if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGKILL");
        }
      }
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

function heldMarkerIds(root: string): string[] {
  return ["a", "b"].filter((id) => fs.existsSync(path.join(root, `held-${id}`)));
}

async function waitForOneHeldMarker(root: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const held = heldMarkerIds(root);
    if (held.length === 1) return held[0]!;
    if (held.length > 1) throw new Error("both lock contenders entered the critical section");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("workflow lock contender did not acquire the stale lock");
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function linuxProcessStartToken(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    return (
      stat
        .slice(closingParenthesis + 2)
        .trim()
        .split(/\s+/u)[19] ?? null
    );
  } catch {
    return null;
  }
}
