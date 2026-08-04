import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { applySmithers031CompatibilityPatches } from "../src/smithers.js";
import { SMITHERS_ORCHESTRATOR_VERSION } from "../src/smithers-package.js";

const requireFromRuntime = createRequire(import.meta.url);

function pinnedSmithersPackageRoots(): Record<"cli" | "engine" | "scheduler" | "time-travel", string> {
  const publicEntry = requireFromRuntime.resolve("smithers-orchestrator");
  const publicRoot = path.resolve(path.dirname(publicEntry), "..");
  const peerNodeModules = path.dirname(publicRoot);
  const packageRoot = (name: "cli" | "engine" | "scheduler" | "time-travel"): string => {
    const root = fs.realpathSync(path.join(peerNodeModules, "@smithers-orchestrator", name));
    const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    assert.equal(metadata.version, SMITHERS_ORCHESTRATOR_VERSION, `${name} must resolve to the pinned package`);
    return root;
  };
  return {
    cli: packageRoot("cli"),
    engine: packageRoot("engine"),
    scheduler: packageRoot("scheduler"),
    "time-travel": packageRoot("time-travel")
  };
}

function copyPinnedPatchInput(
  projectRoot: string,
  packageName: "cli" | "engine" | "scheduler",
  sourceRoot: string
): void {
  const destination = path.join(projectRoot, ".smithers", "node_modules", "@smithers-orchestrator", packageName);
  fs.mkdirSync(path.join(destination, "src"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "package.json"), path.join(destination, "package.json"));
  const sourceFiles =
    packageName === "cli"
      ? ["src/index.js", "src/detached-admission.js"]
      : packageName === "engine"
        ? ["src/engine.js", "src/workflow-hash.js"]
        : ["src/makeWorkflowSession.js"];
  for (const relative of sourceFiles) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), target);
  }
}

test("the compatibility adapter patches the exact pinned 0.31 fork and replay sources", (t) => {
  const roots = pinnedSmithersPackageRoots();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-smithers-compatibility-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  copyPinnedPatchInput(projectRoot, "cli", roots.cli);
  copyPinnedPatchInput(projectRoot, "engine", roots.engine);
  copyPinnedPatchInput(projectRoot, "scheduler", roots.scheduler);

  const installedCliSource = path.join(
    projectRoot,
    ".smithers",
    "node_modules",
    "@smithers-orchestrator",
    "cli",
    "src",
    "index.js"
  );
  const originalCli = fs.readFileSync(installedCliSource, "utf8");
  assert.match(originalCli, /const resolvedReplayWorkflowPath = resolve\(c\.args\.workflow\);/u);
  assert.match(originalCli, /const resolvedForkWorkflowPath = resolve\(c\.args\.workflow\);/u);
  assert.match(originalCli, /autoRun: c\.options\.run,/u);

  applySmithers031CompatibilityPatches(projectRoot);

  const cli = fs.readFileSync(installedCliSource, "utf8");
  assert.match(cli, /loadWorkflowDb\(c\.args\.workflow\)/u, "descriptor path still drives preparation reads");
  assert.match(cli, /loadWorkflow\(c\.args\.workflow\)/u, "descriptor path still drives foreground workflow loads");
  assert.match(cli, /const resolvedReplayWorkflowPath = resolve\(c\.args\.workflow\);/u);
  assert.match(cli, /realpathSync\(resolvedReplayWorkflowPath\) !== realpathSync\(persistedReplayWorkflowPath\)/u);
  assert.match(
    cli,
    /workflowPath: persistedReplayWorkflowPath,[\s\S]*workflowHash: await readWorkflowGraphHash\([\s\S]*resolvedReplayWorkflowPath,[\s\S]*persistedReplayWorkflowPath,[\s\S]*\),[\s\S]*entryWorkflowHash: await readWorkflowEntryHash\(resolvedReplayWorkflowPath\),/u
  );
  assert.match(cli, /const resolvedForkWorkflowPath = resolve\(c\.args\.workflow\);/u);
  assert.match(cli, /realpathSync\(resolvedForkWorkflowPath\) !== realpathSync\(persistedForkWorkflowPath\)/u);
  assert.match(
    cli,
    /workflowPath: persistedForkWorkflowPath,[\s\S]*workflowHash: await readWorkflowGraphHash\([\s\S]*resolvedForkWorkflowPath,[\s\S]*persistedForkWorkflowPath,[\s\S]*\),[\s\S]*entryWorkflowHash: await readWorkflowEntryHash\(resolvedForkWorkflowPath\),/u
  );
  assert.doesNotMatch(cli, /resolve\(persisted(?:Replay|Fork)WorkflowPath \|\| c\.args\.workflow\)/u);
  assert.match(cli, /ultrafuzzPrepareOnly: z[\s\S]*Private Ultrafuzz mode: prepare the fork child/u);
  assert.match(cli, /autoRun: c\.options\.run \|\| c\.options\.ultrafuzzPrepareOnly,/u);
  assert.match(cli, /if \(c\.options\.run && !c\.options\.ultrafuzzPrepareOnly\) \{[\s\S]*Starting forked run/u);
  assert.doesNotMatch(cli, /if \(c\.options\.run \|\| c\.options\.ultrafuzzPrepareOnly\)/u);

  const engine = fs.readFileSync(
    path.join(projectRoot, ".smithers", "node_modules", "@smithers-orchestrator", "engine", "src", "engine.js"),
    "utf8"
  );
  assert.match(engine, /const resolvedWorkflowPath = opts\.workflowPath \? resolve\(opts\.workflowPath\) : null;/u);
  assert.match(engine, /const persistedWorkflowPathValue = process\.env\.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH/u);
  assert.match(
    engine,
    /getRunDurabilityMetadata\([\s\S]*resolvedWorkflowPath,[\s\S]*rootDir,[\s\S]*persistedWorkflowPath/u
  );
  assert.match(engine, /workflowPath: persistedWorkflowPath \?\? opts\.workflowPath \?\? null/u);
  assert.match(engine, /runMetadata,[\s\S]*persistedWorkflowPath,[\s\S]*\);/u);
  assert.match(engine, /workflowPath: resolvedWorkflowPath,[\s\S]*runtimeAdapter: createNodeRuntime/u);
  assert.match(engine, /workflowPath: resolvedWorkflowPath \?\? opts\.workflowPath,[\s\S]*auth: runAuth/u);
  assert.doesNotMatch(engine, /resolve\(persistedWorkflowPath \|\| opts\.workflowPath\)/u);

  const workflowHash = fs.readFileSync(
    path.join(projectRoot, ".smithers", "node_modules", "@smithers-orchestrator", "engine", "src", "workflow-hash.js"),
    "utf8"
  );
  assert.match(workflowHash, /readWorkflowGraphHash\(workflowPath, identityWorkflowPath = workflowPath\)/u);
  assert.match(workflowHash, /readFile\(resolvedPath, "utf8"\)/u);
  assert.match(workflowHash, /`\$\{resolvedIdentityPath\}:\$\{sha256Hex\(source\)\}`/u);

  const forkEffect = fs.readFileSync(path.join(roots["time-travel"], "src", "fork", "forkRunEffect.js"), "utf8");
  assert.match(forkEffect, /warningOnly: params\.autoRun !== true,/u);
  assert.match(forkEffect, /params\.autoRun === true && params\.force !== true && newlyCrossed\.blocking\.length > 0/u);
  assert.match(forkEffect, /params\.autoRun === true && params\.force === true && newlyCrossed\.blocking\.length > 0/u);
});

test("the compatibility adapter upgrades the prior canonical-current engine path patch", (t) => {
  const roots = pinnedSmithersPackageRoots();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-smithers-path-upgrade-"));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  copyPinnedPatchInput(projectRoot, "cli", roots.cli);
  copyPinnedPatchInput(projectRoot, "engine", roots.engine);
  copyPinnedPatchInput(projectRoot, "scheduler", roots.scheduler);
  const engineSource = path.join(
    projectRoot,
    ".smithers",
    "node_modules",
    "@smithers-orchestrator",
    "engine",
    "src",
    "engine.js"
  );
  const upstreamDeclaration = "  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;";
  const priorUnsafePatch = `  const persistedWorkflowPath = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  const resolvedWorkflowPath = opts.workflowPath
    ? resolve(persistedWorkflowPath || opts.workflowPath)
    : null;`;
  const original = fs.readFileSync(engineSource, "utf8");
  assert.equal(original.split(upstreamDeclaration).length, 2);
  fs.chmodSync(engineSource, 0o600);
  fs.writeFileSync(engineSource, original.replace(upstreamDeclaration, priorUnsafePatch), "utf8");

  applySmithers031CompatibilityPatches(projectRoot);
  assert.doesNotThrow(() => applySmithers031CompatibilityPatches(projectRoot), "patching remains idempotent");

  const upgraded = fs.readFileSync(engineSource, "utf8");
  assert.match(upgraded, /const resolvedWorkflowPath = opts\.workflowPath \? resolve\(opts\.workflowPath\) : null;/u);
  assert.match(upgraded, /const persistedWorkflowPathValue = process\.env\.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH/u);
  assert.doesNotMatch(upgraded, /resolve\(persistedWorkflowPath \|\| opts\.workflowPath\)/u);
});

test(
  "workflow graph hashing reads the anchored tree and keeps a stable lexical identity after controller close",
  { skip: process.platform !== "linux" },
  async (t) => {
    const roots = pinnedSmithersPackageRoots();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-smithers-hash-identity-"));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    copyPinnedPatchInput(projectRoot, "cli", roots.cli);
    copyPinnedPatchInput(projectRoot, "engine", roots.engine);
    copyPinnedPatchInput(projectRoot, "scheduler", roots.scheduler);
    const errorsDestination = path.join(projectRoot, ".smithers", "node_modules", "@smithers-orchestrator", "errors");
    fs.symlinkSync(fs.realpathSync(path.join(path.dirname(roots.engine), "errors")), errorsDestination, "dir");
    applySmithers031CompatibilityPatches(projectRoot);

    const workflowHashModule = (await import(
      `${
        pathToFileURL(
          path.join(
            projectRoot,
            ".smithers",
            "node_modules",
            "@smithers-orchestrator",
            "engine",
            "src",
            "workflow-hash.js"
          )
        ).href
      }?test=${Date.now()}`
    )) as {
      readWorkflowGraphHash(readPath: string, identityPath?: string): Promise<string | null>;
    };
    const snapshotsRoot = path.join(projectRoot, "execution-snapshots");
    const snapshotRoot = path.join(snapshotsRoot, "stable-snapshot");
    const workflowPath = path.join(snapshotRoot, ".smithers", "workflows", "run.mjs");
    const helperPath = path.join(path.dirname(workflowPath), "helper.mjs");
    const nestedPath = path.join(path.dirname(workflowPath), "nested.mjs");
    const executionLog = path.join(projectRoot, "executed-workflow.txt");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'import "./helper.mjs";\n', "utf8");
    fs.writeFileSync(helperPath, 'import "./nested.mjs";\n', "utf8");
    fs.writeFileSync(
      nestedPath,
      `import fs from "node:fs";\nfs.writeFileSync(process.env.SMITHERS_COMPAT_EXECUTION_LOG, "trusted");\n`,
      "utf8"
    );
    const descriptor = fs.openSync(snapshotRoot, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    const descriptorWorkflowPath = `/proc/self/fd/${descriptor}/.smithers/workflows/run.mjs`;
    const expectedHash = await workflowHashModule.readWorkflowGraphHash(workflowPath, workflowPath);
    assert.ok(expectedHash);
    assert.equal(fs.realpathSync(descriptorWorkflowPath), fs.realpathSync(workflowPath));

    const displacedSnapshotsRoot = `${snapshotsRoot}.displaced`;
    const replacementRoot = path.join(projectRoot, "replacement-snapshots");
    const replacementWorkflowPath = path.join(
      replacementRoot,
      path.basename(snapshotRoot),
      ".smithers",
      "workflows",
      "run.mjs"
    );
    fs.mkdirSync(path.dirname(replacementWorkflowPath), { recursive: true });
    fs.writeFileSync(replacementWorkflowPath, 'import "./helper.mjs";\n', "utf8");
    fs.writeFileSync(
      path.join(path.dirname(replacementWorkflowPath), "helper.mjs"),
      'import "./nested.mjs";\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(path.dirname(replacementWorkflowPath), "nested.mjs"),
      `import fs from "node:fs";\nfs.writeFileSync(process.env.SMITHERS_COMPAT_EXECUTION_LOG, "replacement");\n`,
      "utf8"
    );
    fs.renameSync(snapshotsRoot, displacedSnapshotsRoot);
    fs.symlinkSync(replacementRoot, snapshotsRoot, "dir");
    let descriptorClosed = false;
    try {
      const anchoredHash = await workflowHashModule.readWorkflowGraphHash(descriptorWorkflowPath, workflowPath);
      const replacementHash = await workflowHashModule.readWorkflowGraphHash(workflowPath, workflowPath);
      assert.equal(anchoredHash, expectedHash);
      assert.notEqual(replacementHash, expectedHash);

      process.env.SMITHERS_COMPAT_EXECUTION_LOG = executionLog;
      try {
        await import(`${pathToFileURL(descriptorWorkflowPath).href}?execute=${Date.now()}`);
      } finally {
        delete process.env.SMITHERS_COMPAT_EXECUTION_LOG;
      }
      assert.equal(fs.readFileSync(executionLog, "utf8"), "trusted");

      fs.unlinkSync(snapshotsRoot);
      fs.renameSync(displacedSnapshotsRoot, snapshotsRoot);
      fs.closeSync(descriptor);
      descriptorClosed = true;
      const resumedHash = await workflowHashModule.readWorkflowGraphHash(workflowPath, workflowPath);
      assert.equal(resumedHash, expectedHash);
    } finally {
      if (!descriptorClosed) fs.closeSync(descriptor);
      if (fs.existsSync(displacedSnapshotsRoot)) {
        if (fs.existsSync(snapshotsRoot) && fs.lstatSync(snapshotsRoot).isSymbolicLink()) {
          fs.unlinkSync(snapshotsRoot);
        }
        if (!fs.existsSync(snapshotsRoot)) fs.renameSync(displacedSnapshotsRoot, snapshotsRoot);
      }
    }
  }
);
