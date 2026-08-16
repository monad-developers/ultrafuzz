import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initProject, materializeSelection, planRun } from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-materialize-"));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

async function plannedRunWithArtifact(project: string): Promise<{ runId: string; runRoot: string; nodeId: string }> {
  initProject({ projectRoot: project, force: true });
  writeSmallTopology(project);
  const plan = await planRun({ projectRoot: project, runId: `mat-${crypto.randomBytes(4).toString("hex")}`, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const nodeId = plan.value!.graph.nodes[0]!.id;
  assert.ok(nodeId);
  const artifactDir = path.join(plan.value!.run_root, "artifacts", nodeId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated output\n", "utf8");
  return { runId: plan.value!.run_id, runRoot: plan.value!.run_root, nodeId };
}

function isDescriptorAnchoredChild(candidate: fs.PathLike, basename: string): boolean {
  const value = String(candidate);
  return path.basename(value) === basename && (value.startsWith("/proc/self/fd/") || value.startsWith("/dev/fd/"));
}

function openedDescriptorPath(descriptor: number): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  return "";
}

function restoreSwappedDirectory(directory: string, displaced: string): void {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (fs.existsSync(displaced)) fs.renameSync(displaced, directory);
}

test("materializeSelection copies only explicit outputs, leaves git changes unstaged, and records audit evidence", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);

  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.writeFileSync(path.join(project, "test/Generated.t.sol"), "contract OldGenerated {}\n", "utf8");
  git(project, ["init"]);
  git(project, ["config", "user.email", "tester@example.invalid"]);
  git(project, ["config", "user.name", "Ultrafuzz Tester"]);
  git(project, ["add", "test/Generated.t.sol"]);
  git(project, ["commit", "-m", "seed"]);

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    allowOverwrite: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.value?.audit.mode, "unstaged-working-tree");
  assert.equal(result.value?.audit.unstaged, true);
  assert.equal(result.value?.copied.length, 1);
  assert.equal(fs.existsSync(result.value!.audit.audit_path), true);

  const status = git(project, ["status", "--porcelain=v1"]);
  assert.match(status, / M test\/Generated\.t\.sol/u);
  assert.doesNotMatch(status, /^M {2}test\/Generated\.t\.sol/mu);

  const events = fs.readFileSync(path.join(runRoot, "events.jsonl"), "utf8");
  assert.match(events, /materialize-selection/u);
  const audit = fs.readFileSync(result.value!.audit.audit_path, "utf8");
  assert.match(audit, /"unstaged":true/u);
  assert.doesNotMatch(audit, /"mutation_policy"/u);
});

test("materializeSelection creates missing destination parents through directory descriptors", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "generated", "nested", "output.txt");

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "generated/nested/output.txt" }]
  });

  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
});

test(
  "overwrite materialization atomically replaces a raced destination symlink without following it",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "Generated.t.sol");
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-race-target-"));
    const outsidePath = path.join(outsideRoot, "outside.txt");
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, "old generated output\n", "utf8");
    fs.writeFileSync(outsidePath, "must remain unchanged\n", "utf8");

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    fs.renameSync = ((oldPath, newPath) => {
      if (!swapped && isDescriptorAnchoredChild(newPath, path.basename(destinationPath))) {
        swapped = true;
        fs.unlinkSync(destinationPath);
        fs.symlinkSync(outsidePath, destinationPath);
      }
      originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        allowOverwrite: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
      });

      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(swapped, true);
      assert.equal(fs.lstatSync(destinationPath).isSymbolicLink(), false);
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
      assert.equal(fs.readFileSync(outsidePath, "utf8"), "must remain unchanged\n");
    } finally {
      fs.renameSync = originalRenameSync;
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
);

test(
  "new materialization cannot follow a checked parent replaced by an outside symlink",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationDirectory = path.join(project, "test");
    const destinationPath = path.join(destinationDirectory, "created.txt");
    const displacedDirectory = `${destinationDirectory}.displaced`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-create-parent-outside-"));
    const outsidePath = path.join(outsideRoot, "created.txt");
    fs.mkdirSync(destinationDirectory);

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
    const originalWriteSync = fs.writeSync;
    let swapped = false;
    Object.defineProperty(fs, "writeSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const openedPath = openedDescriptorPath(Number(args[0]));
        if (!swapped && path.basename(openedPath) === path.basename(destinationPath)) {
          swapped = true;
          fs.renameSync(destinationDirectory, displacedDirectory);
          fs.symlinkSync(outsideRoot, destinationDirectory, process.platform === "win32" ? "junction" : "dir");
        }
        return Reflect.apply(originalWriteSync, fs, args) as number;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/created.txt" }]
      });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
      assert.equal(swapped, true);
      assert.equal(fs.existsSync(outsidePath), false);
      assert.equal(fs.statSync(path.join(displacedDirectory, "created.txt")).size, 0);
    } finally {
      Object.defineProperty(fs, "writeSync", originalDescriptor);
      restoreSwappedDirectory(destinationDirectory, displacedDirectory);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
);

test(
  "overwrite materialization cannot replace through a checked parent swapped to an outside directory",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationDirectory = path.join(project, "test");
    const destinationPath = path.join(destinationDirectory, "Generated.t.sol");
    const displacedDirectory = `${destinationDirectory}.displaced`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-overwrite-parent-outside-"));
    const outsidePath = path.join(outsideRoot, "Generated.t.sol");
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(destinationPath, "old project output\n", "utf8");
    fs.writeFileSync(outsidePath, "must remain unchanged\n", "utf8");

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    fs.renameSync = ((oldPath, newPath) => {
      if (!swapped && isDescriptorAnchoredChild(newPath, path.basename(destinationPath))) {
        swapped = true;
        originalRenameSync(destinationDirectory, displacedDirectory);
        fs.symlinkSync(outsideRoot, destinationDirectory, process.platform === "win32" ? "junction" : "dir");
      }
      originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        allowOverwrite: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/Generated.t.sol" }]
      });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
      assert.equal(swapped, true);
      assert.equal(fs.readFileSync(outsidePath, "utf8"), "must remain unchanged\n");
      assert.equal(fs.statSync(path.join(displacedDirectory, "Generated.t.sol")).size, 0);
    } finally {
      fs.renameSync = originalRenameSync;
      restoreSwappedDirectory(destinationDirectory, displacedDirectory);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
);

test(
  "missing destination parents are created through the checked directory descriptor",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const checkedDirectory = path.join(project, "test");
    const displacedDirectory = `${checkedDirectory}.displaced`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-mkdir-parent-outside-"));
    fs.mkdirSync(checkedDirectory);

    const originalMkdirSync = fs.mkdirSync;
    let swapped = false;
    fs.mkdirSync = ((directory, options) => {
      if (!swapped && isDescriptorAnchoredChild(directory, "generated")) {
        swapped = true;
        fs.renameSync(checkedDirectory, displacedDirectory);
        fs.symlinkSync(outsideRoot, checkedDirectory, process.platform === "win32" ? "junction" : "dir");
      }
      return originalMkdirSync(directory, options as never);
    }) as typeof fs.mkdirSync;
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/generated/output.txt" }]
      });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
      assert.equal(swapped, true);
      assert.deepEqual(fs.readdirSync(outsideRoot), []);
      assert.deepEqual(fs.readdirSync(path.join(displacedDirectory, "generated")), []);
    } finally {
      fs.mkdirSync = originalMkdirSync;
      restoreSwappedDirectory(checkedDirectory, displacedDirectory);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  }
);

test(
  "materialization fails closed when the parent descriptor has no verifiable access path",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "blocked.txt");
    fs.mkdirSync(path.dirname(destinationPath));

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "statSync")!;
    const originalStatSync = fs.statSync;
    let descriptorPathRejected = false;
    Object.defineProperty(fs, "statSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const candidate = String(args[0]);
        if (candidate.startsWith("/proc/self/fd/") || candidate.startsWith("/dev/fd/")) {
          descriptorPathRejected = true;
          throw Object.assign(new Error("descriptor path unavailable for test"), { code: "ENOENT" });
        }
        return Reflect.apply(originalStatSync, fs, args) as fs.Stats;
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/blocked.txt" }]
      });

      assert.equal(result.ok, false);
      assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
      assert.match(JSON.stringify(result.diagnostics), /no verifiable descriptor path/u);
      assert.equal(descriptorPathRejected, true);
      assert.equal(fs.existsSync(destinationPath), false);
    } finally {
      Object.defineProperty(fs, "statSync", originalDescriptor);
    }
  }
);

test("a failed stage write preserves a concurrently created destination", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "concurrent.txt");
  fs.mkdirSync(path.dirname(destinationPath));

  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync")!;
  const originalWriteSync = fs.writeSync;
  let failedWhileStaging = false;
  Object.defineProperty(fs, "writeSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const descriptor = Number(args[0]);
      const openedPath = openedDescriptorPath(descriptor);
      if (!failedWhileStaging && path.basename(openedPath) === "concurrent.txt") {
        failedWhileStaging = true;
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, "concurrent project file\n", { flag: "wx" });
        throw Object.assign(new Error("simulated stage write failure"), { code: "ENOSPC" });
      }
      return Reflect.apply(originalWriteSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/concurrent.txt" }]
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
    assert.equal(failedWhileStaging, true);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "concurrent project file\n");
    assert.deepEqual(
      fs.readdirSync(path.dirname(destinationPath)).filter((entry) => entry.includes(".ultrafuzz-materialize-")),
      []
    );
  } finally {
    Object.defineProperty(fs, "writeSync", originalDescriptor);
  }
});

test("exclusive open preserves a destination raced in before creation", { concurrency: false }, async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const destinationPath = path.join(project, "test", "raced.txt");
  fs.mkdirSync(path.dirname(destinationPath));

  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalOpenSync = fs.openSync;
  let raced = false;
  Object.defineProperty(fs, "openSync", {
    ...originalDescriptor,
    value: (...args: unknown[]) => {
      const openPath = args[0] as fs.PathLike;
      const flags = Number(args[1]);
      if (
        !raced &&
        isDescriptorAnchoredChild(openPath, path.basename(destinationPath)) &&
        (flags & fs.constants.O_EXCL) !== 0
      ) {
        raced = true;
        fs.writeFileSync(destinationPath, "concurrent project file\n", { flag: "wx" });
      }
      return Reflect.apply(originalOpenSync, fs, args) as number;
    }
  });
  try {
    const result = await materializeSelection({
      projectRoot: project,
      runId,
      confirmed: true,
      copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/raced.txt" }]
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((entry) => entry.code === "MATERIALIZE_DESTINATION_RACE"));
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(destinationPath, "utf8"), "concurrent project file\n");
    assert.deepEqual(
      fs.readdirSync(path.dirname(destinationPath)).filter((entry) => entry.includes(".ultrafuzz-materialize-")),
      []
    );
  } finally {
    Object.defineProperty(fs, "openSync", originalDescriptor);
  }
});

test(
  "a descriptor close error after verified publication does not report an uncommitted failure",
  { concurrency: false },
  async () => {
    const project = tempProject();
    const { runId, nodeId } = await plannedRunWithArtifact(project);
    const destinationPath = path.join(project, "test", "close-ok.txt");
    fs.mkdirSync(path.dirname(destinationPath));

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "closeSync")!;
    const originalCloseSync = fs.closeSync;
    let closeFailed = false;
    Object.defineProperty(fs, "closeSync", {
      ...originalDescriptor,
      value: (descriptor: number) => {
        const openedPath = openedDescriptorPath(descriptor);
        originalCloseSync(descriptor);
        if (!closeFailed && path.basename(openedPath) === path.basename(destinationPath)) {
          closeFailed = true;
          throw Object.assign(new Error("simulated committed descriptor close failure"), { code: "EIO" });
        }
      }
    });
    try {
      const result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/close-ok.txt" }]
      });

      assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
      assert.equal(closeFailed, true);
      assert.equal(fs.readFileSync(destinationPath, "utf8"), "generated output\n");
    } finally {
      Object.defineProperty(fs, "closeSync", originalDescriptor);
    }
  }
);

test("materializeSelection rejects conflicts, denied destinations, source symlinks, and destination symlink escapes", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);

  const conflictPath = path.join(project, "test/conflict.txt");
  fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
  fs.writeFileSync(conflictPath, "already here\n", "utf8");
  const conflict = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/conflict.txt" }]
  });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DESTINATION_EXISTS"));

  const sensitive = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: ".env.local" }]
  });
  assert.equal(sensitive.ok, false);
  assert.ok(sensitive.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SENSITIVE_DESTINATION"));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-materialize-outside-"));
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "outside\n", "utf8");
  fs.symlinkSync(outsideFile, path.join(runRoot, "artifacts", nodeId, "link.txt"));
  const sourceSymlink = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/link.txt`, destination: "test/link.txt" }]
  });
  assert.equal(sourceSymlink.ok, false);
  assert.ok(sourceSymlink.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_SOURCE_SYMLINK"));

  fs.symlinkSync(outside, path.join(project, "linked-out"));
  const destinationSymlink = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "linked-out/escape.txt" }]
  });
  assert.equal(destinationSymlink.ok, false);
  assert.ok(destinationSymlink.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_DESTINATION_INVALID"));
  assert.equal(fs.existsSync(path.join(outside, "escape.txt")), false);
});

test("materializeSelection rejects missing confirmation and implicit bulk selections before filesystem writes", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);

  const noConfirmation = await materializeSelection({
    projectRoot: project,
    runId,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/no-confirm.txt" }]
  });
  assert.equal(noConfirmation.ok, false);
  assert.ok(noConfirmation.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_CONFIRMATION_REQUIRED"));

  const wildcard = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/*`, destination: "test/wildcard.txt" }]
  });
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.diagnostics.some((diagnostic) => diagnostic.code === "PATH_IMPLICIT_BULK_SELECTION"));
  assert.equal(fs.existsSync(path.join(project, "test/wildcard.txt")), false);
});

test("materializeSelection rejects excessive copy selections before reading sources or writing destinations", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const copies = Array.from({ length: 129 }, (_, index) => ({
    source: `artifacts/${nodeId}/missing-${index}.txt`,
    destination: `test/limit-${index}.txt`
  }));

  const result = await materializeSelection({ projectRoot: project, runId, confirmed: true, copies });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["MATERIALIZE_COPY_SELECTION_LIMIT_EXCEEDED"]
  );
  assert.deepEqual(result.diagnostics[0]?.details, { actual_entries: 129, limit_entries: 128 });
  assert.equal(fs.existsSync(path.join(project, "test")), false);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "materialize-audit.jsonl")), false);
});

test(
  "materializeSelection rejects aggregate snapshots over 64 MiB before reading excess sources or writing",
  {
    concurrency: false
  },
  async () => {
    const project = tempProject();
    const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
    const artifactDirectory = path.join(runRoot, "artifacts", nodeId);
    const firstSource = path.join(artifactDirectory, "first.bin");
    const secondSource = path.join(artifactDirectory, "second.bin");
    const finalSource = path.join(artifactDirectory, "final.bin");
    fs.closeSync(fs.openSync(firstSource, "w"));
    fs.closeSync(fs.openSync(secondSource, "w"));
    fs.truncateSync(firstSource, 32 * 1024 * 1024);
    fs.truncateSync(secondSource, 32 * 1024 * 1024);
    fs.writeFileSync(finalSource, Buffer.from([1]));

    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
    const originalOpenSync = fs.openSync;
    let openedExcessSource = false;
    Object.defineProperty(fs, "openSync", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        if (path.resolve(String(args[0])) === finalSource) {
          openedExcessSource = true;
          throw new Error("aggregate-budget regression opened the excess source");
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      }
    });
    let result: Awaited<ReturnType<typeof materializeSelection>>;
    try {
      result = await materializeSelection({
        projectRoot: project,
        runId,
        confirmed: true,
        copies: [
          { source: `artifacts/${nodeId}/first.bin`, destination: "test/first.bin" },
          { source: `artifacts/${nodeId}/second.bin`, destination: "test/second.bin" },
          { source: `artifacts/${nodeId}/final.bin`, destination: "test/final.bin" }
        ]
      });
    } finally {
      Object.defineProperty(fs, "openSync", originalDescriptor);
    }

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ["MATERIALIZE_SNAPSHOT_BUDGET_EXCEEDED"]
    );
    assert.deepEqual(result.diagnostics[0]?.details, {
      attempted_bytes: 64 * 1024 * 1024 + 1,
      limit_bytes: 64 * 1024 * 1024
    });
    assert.equal(openedExcessSource, false);
    assert.equal(fs.existsSync(path.join(project, "test")), false);
    assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "materialize-audit.jsonl")), false);
  }
);

test("materializeSelection rejects malformed historical audit data before copying", async () => {
  const project = tempProject();
  const { runId, nodeId } = await plannedRunWithArtifact(project);
  const auditPath = path.join(project, ".ultrafuzz", "materialize-audit.jsonl");
  const destinationPath = path.join(project, "test", "blocked.txt");
  const malformedAudit = Buffer.from('{"schema_version":"1.0"}\n', "utf8");
  fs.writeFileSync(auditPath, malformedAudit);

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    copies: [{ source: `artifacts/${nodeId}/stdout.txt`, destination: "test/blocked.txt" }]
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_AUDIT_ROOT_UNSAFE"));
  assert.equal(fs.existsSync(destinationPath), false);
  assert.deepEqual(fs.readFileSync(auditPath), malformedAudit);
});

test("materializeSelection rejects patch selections until patch application is implemented", async () => {
  const project = tempProject();
  const { runId, runRoot, nodeId } = await plannedRunWithArtifact(project);
  fs.writeFileSync(path.join(runRoot, "artifacts", nodeId, "patch.diff"), "diff --git a/a b/a\n", "utf8");

  const result = await materializeSelection({
    projectRoot: project,
    runId,
    confirmed: true,
    patches: [`artifacts/${nodeId}/patch.diff`]
  });

  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "MATERIALIZE_PATCHES_UNSUPPORTED"));
});
