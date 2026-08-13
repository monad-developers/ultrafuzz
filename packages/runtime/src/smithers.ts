import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertValidSmithersTaskManifest,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  invariantPinnedSourceRefExists,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  readRunPlanDocument,
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATES,
  SMITHERS_RUN_STATUSES,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION as REGISTERED_SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  writeFileDurable,
  type RunLayout,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestMetadata,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { resolveExecutionResources, serializeResolvedConfigJsonBytes, type ResolvedConfig } from "@ultrafuzz/config";
import { redactSecretsInText, redactSecretsInValue } from "@ultrafuzz/security";
import type { ExpandedGraph, ExpandedNode, ModelFanoutProvenance } from "@ultrafuzz/topology";

import { withTransientNpmRegistryRetry } from "./npm-install-retry.js";
import {
  enablePinnedSubmoduleWorktreeConfig,
  pinnedSubmoduleExecutionFiles,
  pinnedSubmoduleExpectationForProject,
  type PinnedSubmoduleExpectation
} from "./pinned-submodules.js";
import { renderRuntimeTemplate } from "./runtime-template.js";
import { topologyRuntimeBudgetForTimeout } from "./topology-runtime-budget.js";
import {
  CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
  CLOUD_EXECUTION_GENERATION_SCHEMA_VERSION,
  SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
  SMITHERS_RESET_NODE_SCHEMA_VERSION,
  SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
  SMITHERS_SUBMISSION_SCHEMA_VERSION,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION
} from "./runtime-contracts.js";
import { assertRuntimeDocument, parseRuntimeDocumentBytes, writeRuntimeDocument } from "./runtime-document-codec.js";
import {
  acquireSmithersExecutableAnchor,
  bindSmithersExecutableCapability,
  smithersExecutableCapability,
  type SmithersExecutableAnchor
} from "./smithers-executable-capability.js";
import type { WorkflowExecutionControlFile } from "./workflow-integrity.js";
import {
  acquireWorkflowExecutionSnapshotAnchor,
  hasWorkflowExecutionSnapshotCapability,
  type WorkflowExecutionSnapshotAnchor
} from "./workflow-execution-snapshot-capability.js";
import {
  assertSmithersPackageManifest,
  SMITHERS_BIN_PATH,
  SMITHERS_VERSION,
  smithersDependencyInstallArgs
} from "./smithers-package.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";
import {
  ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV,
  ULTRAFUZZ_TRUSTED_BIN_ENV,
  ULTRAFUZZ_VALIDATOR_BUILD_ENV
} from "./trusted-cli.js";
import { stableJson } from "./utils.js";

const execFileAsync = promisify(execFile);
const SMITHERS_CLI_MAX_BUFFER_BYTES = 1024 * 1024 * 128;
const MAX_PACKAGE_MANAGER_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_MANAGER_MANIFEST_DEPTH = 32;
const MAX_PACKAGE_MANAGER_MANIFEST_ITEMS = 10_000;
const MAX_PACKAGE_MANAGER_MANIFEST_PROPERTIES = 10_000;
const SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;
const SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = "300000";
const STREAM_TERMINATION_GRACE_MS = 5_000;
const SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS = 1024 * 1024;
const ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH";
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH = "dependencies/manifest.json";
const WORKFLOW_DIRECT_EXTERNAL_DEPENDENCIES = ["@smthrs/tool-context", "react", "smthrs", "zod"] as const;
const SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_SOURCE = `        child = spawn("bun", [cliPath, ...childArgs], {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: {
            ...process.env,
            [DETACHED_RUN_LOG_FILE_ENV]: logFile,
            [DETACHED_ADMISSION_NONCE_ENV]: admissionNonce,
          },
        });`;
const SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_PATCH = `        const childSnapshotTransfer = ultrafuzzExecutionSnapshotChildTransfer([
          cliPath,
          ...childArgs,
        ]);
        child = spawn("bun", childSnapshotTransfer?.args ?? [cliPath, ...childArgs], {
          detached: true,
          stdio:
            childSnapshotTransfer === undefined
              ? ["ignore", fd, fd]
              : ["ignore", fd, fd, childSnapshotTransfer.descriptor],
          env: {
            ...process.env,
            [DETACHED_RUN_LOG_FILE_ENV]: logFile,
            [DETACHED_ADMISSION_NONCE_ENV]: admissionNonce,
            ...(childSnapshotTransfer?.env ?? {}),
          },
        });`;
const SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE = `        const supervisor = spawn("bun", supervisorArgs, {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process.env,
        });
        supervisor.unref();
        supervisorPid = supervisor.pid;`;
const SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH = `        const supervisorSnapshotTransfer = ultrafuzzExecutionSnapshotChildTransfer(supervisorArgs);
        const supervisorFd = openSync(logFile, "a");
        let supervisor;
        try {
          supervisor = spawn("bun", supervisorSnapshotTransfer?.args ?? supervisorArgs, {
            detached: true,
            stdio:
              supervisorSnapshotTransfer === undefined
                ? ["ignore", supervisorFd, supervisorFd]
                : ["ignore", supervisorFd, supervisorFd, supervisorSnapshotTransfer.descriptor],
            env: {
              ...process.env,
              ...(supervisorSnapshotTransfer?.env ?? {}),
            },
          });
        } finally {
          closeSync(supervisorFd);
        }
        supervisor.unref();
        supervisorPid = supervisor.pid;`;
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_SOURCE = `    const child = spawn(options.executable ?? "bun", args, {
      cwd,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      env: process.env,
      detached: true,
    });`;
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PATCH = `    const snapshotDescriptorValue =
      process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR?.trim();
    const snapshotProcessRoot = process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT?.trim();
    const snapshotPersistedRoot = process.env.ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT?.trim();
    const snapshotTransferDeclared =
      snapshotDescriptorValue !== undefined ||
      snapshotProcessRoot !== undefined ||
      snapshotPersistedRoot !== undefined;
    const parsedSnapshotDescriptor = Number(snapshotDescriptorValue ?? "");
    const snapshotDescriptor =
      /^[0-9]+$/u.test(snapshotDescriptorValue ?? "") &&
      Number.isSafeInteger(parsedSnapshotDescriptor) &&
      parsedSnapshotDescriptor >= 0
        ? parsedSnapshotDescriptor
        : undefined;
    if (snapshotTransferDeclared) {
      const expectedProcessRoot = "/proc/" + process.pid + "/fd/" + snapshotDescriptor;
      const processStat =
        snapshotDescriptor === undefined || !snapshotProcessRoot
          ? undefined
          : statSync(snapshotProcessRoot);
      const persistedStat =
        snapshotDescriptor === undefined || !snapshotPersistedRoot
          ? undefined
          : statSync(snapshotPersistedRoot);
      if (
        snapshotDescriptor === undefined ||
        processStat === undefined ||
        persistedStat === undefined ||
        snapshotProcessRoot !== expectedProcessRoot ||
        !processStat.isDirectory() ||
        !persistedStat.isDirectory() ||
        processStat.dev !== persistedStat.dev ||
        processStat.ino !== persistedStat.ino
      ) {
        throw new Error("detached resume execution snapshot transfer capability is no longer current");
      }
    }
    const snapshotRoots = [snapshotProcessRoot, snapshotPersistedRoot].filter(
      (value) => value !== undefined && value.length > 1,
    );
    const rewriteSnapshotArgument = (value) => {
      if (snapshotDescriptor === undefined) return value;
      for (const root of snapshotRoots) {
        if (value === root || value.startsWith(root + "/")) {
          return "/proc/self/fd/3" + value.slice(root.length);
        }
      }
      return value;
    };
    const child = spawn(options.executable ?? "bun", args.map(rewriteSnapshotArgument), {
      cwd,
      stdio:
        snapshotDescriptor === undefined
          ? logFd === null
            ? "ignore"
            : ["ignore", logFd, logFd]
          : logFd === null
            ? ["ignore", "ignore", "ignore", snapshotDescriptor]
            : ["ignore", logFd, logFd, snapshotDescriptor],
      env: {
        ...process.env,
        ...(snapshotDescriptor === undefined
          ? {}
          : { ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: "3" }),
      },
      detached: true,
    });`;
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE =
  'import { closeSync, readFileSync, existsSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";';
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH =
  'import { closeSync, readFileSync, existsSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";';
const SMITHERS_CLI_WORKFLOW_PATH_SOURCE = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_CLI_WORKFLOW_PATH_PATCH = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
    const persistedWorkflowPath = persistedWorkflowPathValue
      ? resolve(process.cwd(), persistedWorkflowPathValue)
      : resolvedWorkflowPath;
    if (realpathSync(resolvedWorkflowPath) !== realpathSync(persistedWorkflowPath)) {
      return fail({
        code: "INVALID_WORKFLOW_PATH",
        message: "Controller workflow path does not match its persisted workflow path",
        exitCode: 4,
      });
    }
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_SOURCE =
  "process.env.SMITHERS_CLI_SRC_DIR ??= dirname(fileURLToPath(import.meta.url));";
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PATCH = `process.env.SMITHERS_CLI_SRC_DIR ??= dirname(fileURLToPath(import.meta.url));

// Ultrafuzz invokes this process through a descriptor held by its controller.
// Each detached descendant receives that directory atomically as fd 3, opens a
// process-owned anchor, and passes the capability the same way to its children.
// This avoids every parent-exit race around /proc/<parent>/fd/<n> pathnames.
const ultrafuzzInheritedSnapshotDescriptorEnv = "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR";
const ultrafuzzProcessSnapshotDescriptorEnv = "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR";
const ultrafuzzProcessSnapshotRootEnv = "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT";
const ultrafuzzPersistedSnapshotRootEnv = "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT";

function ultrafuzzPersistedExecutionSnapshotRoot(persistedWorkflowValue) {
  const persistedWorkflowPath = resolve(process.cwd(), persistedWorkflowValue);
  const persistedWorkflowsDirectory = dirname(persistedWorkflowPath);
  const persistedSmithersDirectory = dirname(persistedWorkflowsDirectory);
  if (
    basename(persistedWorkflowsDirectory) !== "workflows" ||
    basename(persistedSmithersDirectory) !== ".smithers"
  ) {
    throw new Error("persisted workflow path is outside an execution snapshot");
  }
  return { persistedWorkflowPath, persistedRoot: dirname(persistedSmithersDirectory) };
}

function rewriteUltrafuzzExecutionSnapshotValue(value, sourceRoots, destinationRoot) {
  let candidate = value;
  let fileUrl = false;
  if (value.startsWith("file:")) {
    try {
      candidate = fileURLToPath(value);
      fileUrl = true;
    } catch {
      return value;
    }
  }
  if (resolve(candidate) !== candidate) return value;
  for (const sourceRoot of sourceRoots) {
    const relativePath = relative(sourceRoot, candidate);
    if (
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.startsWith("..\\\\") ||
      resolve(sourceRoot, relativePath) !== candidate
    ) {
      continue;
    }
    const rewritten = resolve(destinationRoot, relativePath);
    return fileUrl ? pathToFileURL(rewritten).href : rewritten;
  }
  return value;
}

function ultrafuzzSnapshotDescriptor(value) {
  if (!/^[0-9]+$/u.test(value)) return undefined;
  const descriptor = Number(value);
  return Number.isSafeInteger(descriptor) && descriptor >= 0 ? descriptor : undefined;
}

function ultrafuzzExecutionSnapshotChildTransfer(args) {
  const descriptorValue = process.env[ultrafuzzProcessSnapshotDescriptorEnv]?.trim();
  const processRoot = process.env[ultrafuzzProcessSnapshotRootEnv]?.trim();
  const persistedRoot = process.env[ultrafuzzPersistedSnapshotRootEnv]?.trim();
  const transferDeclared =
    descriptorValue !== undefined || processRoot !== undefined || persistedRoot !== undefined;
  if (!transferDeclared) return undefined;

  const descriptor = ultrafuzzSnapshotDescriptor(descriptorValue ?? "");
  if (descriptor === undefined || !processRoot || !persistedRoot) {
    throw new Error("process execution snapshot transfer capability is incomplete or invalid");
  }

  const expectedProcessRoot = "/proc/" + process.pid + "/fd/" + descriptor;
  if (
    processRoot !== expectedProcessRoot ||
    !statSync(processRoot).isDirectory() ||
    realpathSync(processRoot) !== realpathSync(persistedRoot)
  ) {
    throw new Error("process execution snapshot transfer capability is no longer current");
  }
  return {
    descriptor,
    args: args.map((value) =>
      rewriteUltrafuzzExecutionSnapshotValue(value, [processRoot, persistedRoot], "/proc/self/fd/3")
    ),
    env: { [ultrafuzzInheritedSnapshotDescriptorEnv]: "3" },
  };
}

function anchorUltrafuzzExecutionSnapshotForProcess() {
  const inheritedDescriptorValue = process.env[ultrafuzzInheritedSnapshotDescriptorEnv]?.trim();
  delete process.env[ultrafuzzInheritedSnapshotDescriptorEnv];
  delete process.env[ultrafuzzProcessSnapshotDescriptorEnv];
  delete process.env[ultrafuzzProcessSnapshotRootEnv];
  delete process.env[ultrafuzzPersistedSnapshotRootEnv];

  const configValue = process.env.ULTRAFUZZ_CONFIG_PATH?.trim();
  const persistedWorkflowValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  if (!configValue || !persistedWorkflowValue) {
    if (inheritedDescriptorValue !== undefined) {
      throw new Error("inherited execution snapshot is missing its persisted controls");
    }
    return;
  }

  let configPath;
  try {
    configPath = configValue.startsWith("file:") ? fileURLToPath(configValue) : configValue;
  } catch {
    if (inheritedDescriptorValue !== undefined) {
      throw new Error("inherited execution snapshot has an invalid config path");
    }
    return;
  }
  const sourceRoot = dirname(dirname(configPath));
  if (inheritedDescriptorValue !== undefined && inheritedDescriptorValue !== "3") {
    throw new Error("inherited execution snapshot descriptor must be fixed fd 3");
  }
  const inheritedDescriptor = inheritedDescriptorValue === undefined ? undefined : 3;
  if (inheritedDescriptor === undefined && !/^\\/proc\\/[0-9]+\\/fd\\/[0-9]+$/u.test(sourceRoot)) return;

  const { persistedWorkflowPath, persistedRoot } =
    ultrafuzzPersistedExecutionSnapshotRoot(persistedWorkflowValue);
  const acquisitionRoot =
    inheritedDescriptor === undefined ? sourceRoot : "/proc/self/fd/" + inheritedDescriptor;
  let descriptor;
  try {
    descriptor = openSync(acquisitionRoot, "r");
    const processRoot = "/proc/" + process.pid + "/fd/" + descriptor;
    const processStat = statSync(processRoot);
    if (
      !processStat.isDirectory() ||
      realpathSync(processRoot) !== realpathSync(persistedRoot)
    ) {
      throw new Error("process execution snapshot descriptor changed during acquisition");
    }

    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name !== "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH") {
        process.env[name] = rewriteUltrafuzzExecutionSnapshotValue(
          value,
          [sourceRoot, acquisitionRoot, persistedRoot],
          processRoot,
        );
      }
    }
    for (let index = 0; index < process.argv.length; index += 1) {
      process.argv[index] = rewriteUltrafuzzExecutionSnapshotValue(
        process.argv[index],
        [sourceRoot, acquisitionRoot, persistedRoot],
        processRoot,
      );
    }
    const loadedWorkflow = process.argv.find((value) => value.includes("/.smithers/workflows/"));
    if (loadedWorkflow && realpathSync(loadedWorkflow) !== realpathSync(persistedWorkflowPath)) {
      throw new Error("process-owned workflow path does not match its persisted generation");
    }

    process.env[ultrafuzzProcessSnapshotDescriptorEnv] = String(descriptor);
    process.env[ultrafuzzProcessSnapshotRootEnv] = processRoot;
    process.env[ultrafuzzPersistedSnapshotRootEnv] = persistedRoot;
    process.env.SMITHERS_MONITOR_SUPPRESS = "1";
    process.env.SMITHERS_POST_FAILURE = "0";
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  } finally {
    if (inheritedDescriptor !== undefined) closeSync(inheritedDescriptor);
  }
  // This descriptor is the process-scoped execution capability. The kernel
  // closes it when this CLI, detached engine, or supervisor exits.
}

anchorUltrafuzzExecutionSnapshotForProcess();`;
const SMITHERS_CLI_POST_FAILURE_PATH_SOURCE = `            launchPostFailureAutopsy({
              failedRunId: result.runId,
              workflowPath: resolvedWorkflowPath,
              enabled: true,
            });`;
const SMITHERS_CLI_POST_FAILURE_PATH_PATCH = `            launchPostFailureAutopsy({
              failedRunId: result.runId,
              workflowPath: persistedWorkflowPath,
              enabled: true,
            });`;
const SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE =
  "          const resolvedReplayWorkflowPath = resolve(c.args.workflow);";
const SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH = `          const resolvedReplayWorkflowPath = resolve(c.args.workflow);
          const persistedReplayWorkflowPathValue =
            process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
          const persistedReplayWorkflowPath = persistedReplayWorkflowPathValue
            ? resolve(persistedReplayWorkflowPathValue)
            : resolvedReplayWorkflowPath;
          if (realpathSync(resolvedReplayWorkflowPath) !== realpathSync(persistedReplayWorkflowPath)) {
            return fail({
              code: "INVALID_WORKFLOW_PATH",
              message: "Controller replay workflow path does not match its persisted workflow path",
              exitCode: 4,
            });
          }`;
const SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE = `            workflowPath: resolvedReplayWorkflowPath,
            workflowHash: await readWorkflowGraphHash(resolvedReplayWorkflowPath),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedReplayWorkflowPath),`;
const SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH = `            workflowPath: persistedReplayWorkflowPath,
            workflowHash: await readWorkflowGraphHash(
              resolvedReplayWorkflowPath,
              persistedReplayWorkflowPath,
            ),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedReplayWorkflowPath),`;
const SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE = "          const resolvedForkWorkflowPath = resolve(c.args.workflow);";
const SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH = `          const resolvedForkWorkflowPath = resolve(c.args.workflow);
          const persistedForkWorkflowPathValue =
            process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
          const persistedForkWorkflowPath = persistedForkWorkflowPathValue
            ? resolve(persistedForkWorkflowPathValue)
            : resolvedForkWorkflowPath;
          if (realpathSync(resolvedForkWorkflowPath) !== realpathSync(persistedForkWorkflowPath)) {
            return fail({
              code: "INVALID_WORKFLOW_PATH",
              message: "Controller fork workflow path does not match its persisted workflow path",
              exitCode: 4,
            });
          }`;
const SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE = `            workflowPath: resolvedForkWorkflowPath,
            workflowHash: await readWorkflowGraphHash(resolvedForkWorkflowPath),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedForkWorkflowPath),`;
const SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH = `            workflowPath: persistedForkWorkflowPath,
            workflowHash: await readWorkflowGraphHash(
              resolvedForkWorkflowPath,
              persistedForkWorkflowPath,
            ),
            entryWorkflowHash: await readWorkflowEntryHash(resolvedForkWorkflowPath),`;
// Smithers executes through the descriptor path but persists the stable lexical
// generation path. Every durable path/hash sink must keep those identities
// separate or the next lifecycle command inherits a dead /proc path.
const SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE = `          runConfigJson,
          runMetadata,
          resolvedWorkflowPath,
        );`;
const SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH = `          runConfigJson,
          runMetadata,
          persistedWorkflowPath,
        );`;
const SMITHERS_ENGINE_DESCRIPTOR_EXECUTION_PATH_ANCHOR = "workflowPath: resolvedWorkflowPath ?? opts.workflowPath,";
const SMITHERS_ENGINE_DESCRIPTOR_DRIVER_PATH_ANCHOR = "workflowPath: resolvedWorkflowPath,";
const SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE =
  "  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;";
const SMITHERS_ENGINE_WORKFLOW_PATH_PATCH = `  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;
  const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  const persistedWorkflowPath = opts.workflowPath
    ? resolve(persistedWorkflowPathValue || opts.workflowPath)
    : null;
  if (
    resolvedWorkflowPath &&
    persistedWorkflowPath &&
    realpathSync(resolvedWorkflowPath) !== realpathSync(persistedWorkflowPath)
  ) {
    throw new SmithersError(
      "INVALID_WORKFLOW_PATH",
      "Controller workflow path does not match its persisted workflow path",
    );
  }`;
const SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE = `/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir) {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath);`;
const SMITHERS_ENGINE_DURABILITY_METADATA_PATCH = `/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @param {string | null} [identityWorkflowPath]
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir, identityWorkflowPath = workflowPath) {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath, identityWorkflowPath);`;
const SMITHERS_ENGINE_RUN_METADATA_SOURCE =
  "  const runMetadata = await getRunDurabilityMetadata(resolvedWorkflowPath, rootDir);";
const SMITHERS_ENGINE_RUN_METADATA_PATCH = `  const runMetadata = await getRunDurabilityMetadata(
    resolvedWorkflowPath,
    rootDir,
    persistedWorkflowPath,
  );`;
const SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE = `          runMetadata,
          resolvedWorkflowPath,
          {
            acceptWorkflowChange: "acceptWorkflowChange" in opts && opts.acceptWorkflowChange === true,`;
const SMITHERS_ENGINE_RESUME_IDENTITY_PATCH = `          runMetadata,
          persistedWorkflowPath,
          {
            acceptWorkflowChange: "acceptWorkflowChange" in opts && opts.acceptWorkflowChange === true,`;
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE = `          workflowName: "workflow",
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash,`;
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH = `          workflowName: "workflow",
          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash,`;
const SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE =
  "          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,";
const SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH =
  "          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,";
const SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE =
  "          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? latestRun?.workflowPath ?? null,";
const SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH =
  "          workflowPath: persistedWorkflowPath ?? opts.workflowPath ?? latestRun?.workflowPath ?? null,";
const SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE = 'import { dirname, extname, resolve } from "node:path";';
const SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH = 'import { dirname, extname, relative, resolve } from "node:path";';
const SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE = `/**
 * @param {string} workflowPath
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(workflowPath, visited = new Set()) {
  const resolvedPath = resolve(workflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH = `/**
 * @param {string} workflowPath
 * @param {string} [identityWorkflowPath]
 * @param {Set<string>} [visited]
 * @returns {Promise<string[]>}
 */
async function collectWorkflowModuleHashEntries(
  workflowPath,
  identityWorkflowPath = workflowPath,
  visited = new Set(),
) {
  const resolvedPath = resolve(workflowPath);
  const resolvedIdentityPath = resolve(identityWorkflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE = "  const entries = [`${resolvedPath}:${sha256Hex(source)}`];";
const SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH = "  const entries = [`${resolvedIdentityPath}:${sha256Hex(source)}`];";
const SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE =
  "    entries.push(...(await collectWorkflowModuleHashEntries(importedPath, visited)));";
const SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH = `    const importedIdentityPath = resolve(
      dirname(resolvedIdentityPath),
      relative(dirname(resolvedPath), importedPath),
    );
    entries.push(
      ...(await collectWorkflowModuleHashEntries(importedPath, importedIdentityPath, visited)),
    );`;
const SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE = `/**
 * @param {string | null} workflowPath
 * @returns {Promise<string | null>}
 */
export async function readWorkflowGraphHash(workflowPath) {
  if (!workflowPath) return null;
  try {
    const entries = await collectWorkflowModuleHashEntries(workflowPath);`;
const SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH = `/**
 * @param {string | null} workflowPath
 * @param {string | null} [identityWorkflowPath]
 * @returns {Promise<string | null>}
 */
export async function readWorkflowGraphHash(workflowPath, identityWorkflowPath = workflowPath) {
  if (!workflowPath) return null;
  try {
    const entries = await collectWorkflowModuleHashEntries(
      workflowPath,
      identityWorkflowPath || workflowPath,
    );`;
const SMITHERS_SCHEDULER_TERMINAL_RESTORE_SOURCE =
  "    getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),";
const SMITHERS_SCHEDULER_TERMINAL_RESTORE_PATCH = `    restoreTerminalTaskStates: (tasks) =>
      Effect.sync(() => {
        for (const task of tasks) {
          if (task.state !== "finished" && task.state !== "skipped") continue;
          state.states.set(stateKeyFor(task), task.state);
        }
      }),
    getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),`;
// Anchored immediately after the resume path's `startRunRuntime()`, which is
// where Smithers cancels stale in-progress attempts and rewrites their nodes back
// to `pending`. Hydrating before that reset would restore a node as finished and
// then let the reset flip the durable row to pending, leaving the in-memory
// session and the database disagreeing for the whole resume. Smithers 0.31 ran
// that reset eagerly, before the renderer existed; current Smithers defers it
// into the first render of a resume, so the anchor has to follow it. The enclosing
// `resumeWorkflowNameValidated` guard also makes this run exactly once, still
// before the rendered graph reaches the scheduler.
const SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE = `          resumeWorkflowNameValidated = true;
          await startRunRuntime();
        }`;
const SMITHERS_ENGINE_RESUME_HYDRATION_PATCH = `          resumeWorkflowNameValidated = true;
          await startRunRuntime();
          const durableOutputs = await loadOutputs(db, schema, runId);
          const durableNodes = await Effect.runPromise(adapter.listNodes(runId));
          const terminalTaskStates = durableNodes.flatMap((node) => {
            if (node.state === "skipped") {
              return [{ nodeId: node.nodeId, iteration: node.iteration ?? 0, state: "skipped" }];
            }
            if (node.state !== "finished" || typeof node.outputTable !== "string") return [];
            const rows = durableOutputs[node.outputTable];
            const hasOutput =
              Array.isArray(rows) &&
              rows.some((row) => {
                const rowNodeId = row.nodeId ?? row.node_id;
                return rowNodeId === node.nodeId && Number(row.iteration ?? 0) === Number(node.iteration ?? 0);
              });
            return hasOutput
              ? [{ nodeId: node.nodeId, iteration: node.iteration ?? 0, state: "finished" }]
              : [];
          });
          await Effect.runPromise(workflowSession.restoreTerminalTaskStates(terminalTaskStates));
          logInfo(
            "restored durable terminal tasks into resumed workflow session",
            { runId, restoredTaskCount: terminalTaskStates.length },
            "engine:run",
          );
        }`;

export type SmithersCompatibilityPatchId =
  | "detached_snapshot_transfer"
  | "supervisor_descriptor"
  | "resume_snapshot_transfer"
  | "terminal_state_restore"
  | "resume_hydration"
  | "workflow_path_import"
  | "workflow_path_persistence"
  | "process_snapshot_anchor"
  | "post_failure_workflow_path"
  | "replay_workflow_path"
  | "replay_workflow_metadata"
  | "fork_workflow_path"
  | "fork_workflow_metadata"
  | "engine_workflow_path"
  | "engine_durability_metadata"
  | "engine_run_metadata"
  | "engine_resume_identity"
  | "engine_insert_workflow_path"
  | "engine_activate_workflow_path"
  | "engine_update_workflow_path"
  | "engine_continuation_workflow_path"
  | "workflow_hash_import"
  | "workflow_hash_collect"
  | "workflow_hash_entry"
  | "workflow_hash_recursion"
  | "workflow_hash_public";

export interface SmithersCompatibilityPatch {
  /** Stable name this patch is reported under by `doctor`. */
  readonly id: SmithersCompatibilityPatchId;
  /** Package that owns the patched source, as published on the registry. */
  readonly packageName: string;
  /** Source file inside that package, relative to its own root. */
  readonly sourceRelativePath: string;
  /** Exact upstream text the patch replaces; must occur exactly once. */
  readonly patchable: string;
  /** Replacement text; its presence means the patch is already applied. */
  readonly patched: string;
  /**
   * Text that must be ABSENT from the pinned source for the workaround to still
   * be warranted. An anchor alone is a weak signal: it can be one generic line
   * that survives a refactor of the very behaviour the patch depends on, or
   * upstream can add a supported alternative while leaving the anchor intact.
   * These encode the evidence that upstream has not addressed the problem.
   */
  readonly upstreamAbsent: readonly string[];
}

// The durability workarounds Ultrafuzz applies to the pinned runner. Every entry
// is still unfixed upstream as of SMITHERS_VERSION, so a runner bump
// must re-verify each anchor against the newly pinned release instead of assuming
// the workaround still lands.
export const SMITHERS_COMPATIBILITY_PATCHES: readonly SmithersCompatibilityPatch[] = [
  {
    id: "detached_snapshot_transfer",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_SOURCE,
    patched: SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_PATCH,
    upstreamAbsent: ["ultrafuzzExecutionSnapshotChildTransfer"]
  },
  {
    id: "supervisor_descriptor",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE,
    patched: SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH,
    upstreamAbsent: []
  },
  {
    id: "resume_snapshot_transfer",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/resume-detached.js",
    patchable: SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_SOURCE,
    patched: SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PATCH,
    upstreamAbsent: ["ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR"]
  },
  {
    id: "terminal_state_restore",
    packageName: "@smthrs/scheduler",
    sourceRelativePath: "src/makeWorkflowSession.js",
    patchable: SMITHERS_SCHEDULER_TERMINAL_RESTORE_SOURCE,
    patched: SMITHERS_SCHEDULER_TERMINAL_RESTORE_PATCH,
    // Upstream growing its own terminal-state restoration retires this patch.
    upstreamAbsent: ["restoreTerminalTaskStates"]
  },
  {
    id: "resume_hydration",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE,
    patched: SMITHERS_ENGINE_RESUME_HYDRATION_PATCH,
    // `restoreTerminalTaskStates` would mean upstream hydrates on its own.
    upstreamAbsent: ["restoreTerminalTaskStates"]
  },
  {
    id: "workflow_path_import",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE,
    patched: SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_path_persistence",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_CLI_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "process_snapshot_anchor",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_SOURCE,
    patched: SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PATCH,
    upstreamAbsent: ["anchorUltrafuzzExecutionSnapshotForProcess"]
  },
  {
    id: "post_failure_workflow_path",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_POST_FAILURE_PATH_SOURCE,
    patched: SMITHERS_CLI_POST_FAILURE_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "replay_workflow_path",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "replay_workflow_metadata",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE,
    patched: SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH,
    upstreamAbsent: []
  },
  {
    id: "fork_workflow_path",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "fork_workflow_metadata",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE,
    patched: SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_workflow_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_durability_metadata",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE,
    patched: SMITHERS_ENGINE_DURABILITY_METADATA_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_run_metadata",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_RUN_METADATA_SOURCE,
    patched: SMITHERS_ENGINE_RUN_METADATA_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_resume_identity",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE,
    patched: SMITHERS_ENGINE_RESUME_IDENTITY_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_insert_workflow_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_activate_workflow_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_update_workflow_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "engine_continuation_workflow_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE,
    patched: SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_hash_import",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/workflow-hash.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_hash_collect",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/workflow-hash.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_hash_entry",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/workflow-hash.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_hash_recursion",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/workflow-hash.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH,
    upstreamAbsent: []
  },
  {
    id: "workflow_hash_public",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/workflow-hash.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH,
    upstreamAbsent: []
  }
];

export const SMITHERS_REQUIRED_ENGINE_ANCHORS = [
  {
    id: "engine_descriptor_execution_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    anchor: SMITHERS_ENGINE_DESCRIPTOR_EXECUTION_PATH_ANCHOR
  },
  {
    id: "engine_descriptor_driver_path",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    anchor: SMITHERS_ENGINE_DESCRIPTOR_DRIVER_PATH_ANCHOR
  }
] as const;

/**
 * Markers that must sit between the start of the deferred run-startup closure and
 * the resume-hydration anchor. The anchor places our hydration immediately after
 * `startRunRuntime()`, which is only ordered after the attempt resets while those
 * resets live inside the closure. Hydrating first would restore a node as finished
 * and then let a reset rewrite the durable row to pending, so this ordering is
 * load-bearing and is asserted against the pinned release.
 *
 * Both resets are pinned. `cancelStaleAttempts` only rewrites attempts older than
 * the staleness window, so on its own it is the weaker signal; the transaction
 * named below is the unconditional resume reset that rewrites *every* in-progress
 * attempt, and it is the one whose ordering actually matters.
 *
 * This is a textual proxy for execution order, not a proof of it. A failure means
 * "re-derive the anchor against the new upstream code", not necessarily "upstream
 * broke something".
 */
export const SMITHERS_ENGINE_RESUME_RESET_ORDERING = {
  closureStart: "const startRunRuntime = async () => {",
  resetCalls: ["await cancelStaleAttempts(adapter, runId);", '"resume-cancel-stale-attempt"'],
  anchor: SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE
} as const;

const SMITHERS_BASE_ENVIRONMENT_VARIABLES = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "CODEX_HOME",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  ULTRAFUZZ_SCHEMA_BUNDLE_SHA256_ENV,
  ULTRAFUZZ_TRUSTED_BIN_ENV,
  ULTRAFUZZ_VALIDATOR_BUILD_ENV,
  ULTRAFUZZ_WORKFLOW_PERSISTED_PATH,
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME"
]);
const SMITHERS_EXECUTION_CONTEXT_ENVIRONMENT_VARIABLES = new Set([
  "SMITHERS_ATTEMPT",
  "SMITHERS_CLI_SRC_DIR",
  "SMITHERS_ITERATION",
  "SMITHERS_NODE_ID",
  "SMITHERS_RUN_ID",
  "SMITHERS_SNAPSHOT_SOCK"
]);
export type SmithersRunStatus = (typeof SMITHERS_RUN_STATUSES)[number];
export type SmithersRunState = Exclude<(typeof SMITHERS_RUN_STATES)[number], "unknown">;
export type SmithersNodeState = (typeof SMITHERS_NODE_STATES)[number];

export interface CurrentSmithersInspectNode {
  nodeId: string;
  state: SmithersNodeState;
  attempt: number;
  label: string;
}

export interface CurrentSmithersInspect {
  runStatus: SmithersRunStatus;
  runState: SmithersRunState;
  nodes: CurrentSmithersInspectNode[];
  failedChildKeys: string[];
}

const SMITHERS_ACTIVE_RUN_STATES = new Set<SmithersRunState>([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "recovering"
]);

export const SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION = SMITHERS_TASK_MANIFEST_SCHEMA_VERSION;
export const SMITHERS_TASK_METADATA_SCHEMA_VERSION = REGISTERED_SMITHERS_TASK_METADATA_SCHEMA_VERSION;
export { SMITHERS_RESET_NODE_SCHEMA_VERSION, SMITHERS_SUBMISSION_SCHEMA_VERSION } from "./runtime-contracts.js";

export interface SmithersCompileInput {
  config: ResolvedConfig;
  graph: ExpandedGraph;
  runLayout: RunLayout;
  projectRoot?: string;
  workflowName?: string;
  renderedPrompts: readonly RenderedPromptPlan[];
  operatorPrompt?: string;
  operatorInput?: unknown;
}

export interface NodeAttemptProvenance {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  attemptIndex: number;
  modelIndex: number;
  model?: ModelFanoutProvenance;
}

export type CompiledSmithersTask = SmithersTaskManifestTask;

export type SmithersTaskMetadata = SmithersTaskManifestMetadata;

export interface CompiledSmithersWorkflow {
  schemaVersion: typeof SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION;
  runId: string;
  smithersRunId: string;
  workflowName: string;
  tasks: readonly CompiledSmithersTask[];
  projectRoot: string;
  workflowPath: string;
  evidenceWorkflowPath: string;
  expandedGraphPath: string;
  configPath: string;
  resolvedConfigPath: string;
  inputPath: string;
  tasksPath: string;
  logsDir: string;
  pinnedSubmodules?: PinnedSubmoduleExpectation;
  productionSourceRoots?: string[];
}

export interface SubmitSmithersInput {
  compiled: CompiledSmithersWorkflow;
  projectRoot: string;
  maxConcurrency: number;
  keepWorkspaces: boolean;
  controllerLeaseSeconds: number;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  workflowPath?: string;
  inputJson: string;
}

export interface SmithersSubmissionResult {
  smithersRunId: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersPauseResult {
  status: "pause-requested" | "paused";
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersCancelResult {
  status: "cancel-requested" | "cancelled";
  reportedStatus?: string;
  command: readonly string[];
  stdout: string;
  stderr: string;
}

export interface SmithersStreamResult {
  command: string[];
  lines: number;
  truncated: boolean;
  exitCode: number | null;
  /** Set when the process died from a signal, e.g. an OOM kill. */
  terminatedBySignal: string | null;
  /**
   * True only when Ultrafuzz itself stopped the process for truncation or
   * abort. Callers must not infer that from a null exit code: an externally
   * signalled death also has no exit code but is a real failure.
   */
  stoppedByCaller: boolean;
  stderr: string;
}

export type SmithersPatchPosture = "applied" | "upstream" | "missing" | "incompatible" | "unknown";

export interface SmithersInstallationPosture {
  bundled_version: string;
  required_version: string;
  installed_version: string | null;
  installed_bin_target: string | null;
  bin_path: string | null;
  layout_error: string | null;
  compatibility_patches: Record<string, SmithersPatchPosture>;
}

export interface SmithersCommandSnapshot {
  command: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
  json?: unknown;
  error?: string;
}

export function compileSmithersWorkflow(input: SmithersCompileInput): CompiledSmithersWorkflow {
  const projectRoot = path.resolve(input.projectRoot ?? inferProjectRootFromRunLayout(input.runLayout));
  const workflowName = input.workflowName ?? `ultrafuzz-${input.runLayout.runId}`;
  const smithersRunId = `ultrafuzz-${input.runLayout.runId}`;
  if (!isCompatibleSmithersRunId(smithersRunId)) {
    throw new Error(
      `run ID ${JSON.stringify(input.runLayout.runId)} does not produce a current Smithers run ID matching ^[a-z0-9_-]{1,64}$`
    );
  }
  const agenticAttemptsByNodeId = new Map<string, string[]>();
  const attemptsByNodeId = new Map<string, string[]>();
  for (const node of input.graph.nodes.filter((candidate) => candidate.kind !== "meta")) {
    attemptsByNodeId.set(
      node.id,
      nodeAttemptsFor(node).map((attempt) => attempt.attemptId)
    );
  }
  for (const node of input.graph.nodes.filter((candidate) => candidate.kind === "agentic")) {
    agenticAttemptsByNodeId.set(
      node.id,
      nodeAttemptsFor(node).map((attempt) => attempt.attemptId)
    );
  }
  const renderedByAttempt = new Map(
    input.renderedPrompts.map((prompt) => [prompt.attempt_id, prompt.rendered_prompt_path])
  );
  const tasks = input.graph.nodes.flatMap((node) =>
    nodeAttemptsFor(node)
      .filter(() => node.kind === "agentic")
      .map((attempt) =>
        compileTask({
          config: input.config,
          graph: input.graph,
          node,
          attempt,
          runLayout: input.runLayout,
          workflowName,
          renderedPromptPath: renderedByAttempt.get(attempt.attemptId) ?? renderedByAttempt.get(node.id),
          dependencyAttemptIds: node.dependsOn.flatMap((dependency) => attemptsByNodeId.get(dependency) ?? []),
          dependencyAgenticAttemptIds: node.dependsOn.flatMap(
            (dependency) => agenticAttemptsByNodeId.get(dependency) ?? []
          ),
          artifactDependencyAttemptIds: artifactAncestorNodeIds(node.id, input.graph.nodes).flatMap(
            (ancestor) => attemptsByNodeId.get(ancestor) ?? []
          )
        })
      )
  );
  const smithersDir = path.join(input.runLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  const evidenceWorkflowPath = path.join(smithersDir, "workflow.tsx");
  const expandedGraphPath = path.join(smithersDir, "expanded-graph.json");
  const configPath = path.join(smithersDir, "config.fingerprint-input");
  const resolvedConfigPath = path.join(smithersDir, "resolved-config.json");
  const resolvedConfigBytes = serializeResolvedConfigJsonBytes(input.config);
  const workflowPath = path.join(
    projectRoot,
    ".smithers",
    "workflows",
    `${workflowFileStem(input.runLayout.runId)}.tsx`
  );
  const inputPath = path.join(smithersDir, "input.json");
  const tasksPath = path.join(smithersDir, "tasks.json");
  const logsDir = path.join(smithersDir, "logs");
  // Cloud handoffs seal the same pinned dependency bytes as local runs, so the
  // expectation is computed for every execution mode. Every task worktree is
  // created locally, so Git's shared worktree-config prerequisite is enabled
  // whenever a pinned expectation exists.
  const pinnedSubmodules = invariantPinnedSourceRefExists(projectRoot)
    ? pinnedSubmoduleExpectationForProject(projectRoot)
    : undefined;
  enablePinnedSubmoduleWorktreeConfig(projectRoot, pinnedSubmodules);
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: input.runLayout.runId,
    smithersRunId,
    workflowName,
    tasks,
    projectRoot,
    workflowPath,
    evidenceWorkflowPath,
    expandedGraphPath,
    configPath,
    resolvedConfigPath,
    inputPath,
    tasksPath,
    logsDir,
    productionSourceRoots: input.config.permissions.productionSourceRoots,
    ...(pinnedSubmodules === undefined ? {} : { pinnedSubmodules })
  };
  writePreparedWorkflowFile(
    input.runLayout.root,
    expandedGraphPath,
    `${JSON.stringify(input.graph, null, 2)}\n`,
    "expanded workflow graph"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    configPath,
    stableJson(input.config),
    "workflow config fingerprint input"
  );
  writePreparedWorkflowFile(input.runLayout.root, resolvedConfigPath, resolvedConfigBytes, "resolved workflow config");
  const taskManifest: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    run_id: input.runLayout.runId,
    smithers_run_id: smithersRunId,
    workflow_name: workflowName,
    pinned_submodules: pinnedSubmodules ?? null,
    tasks
  };
  assertValidSmithersTaskManifest(taskManifest);
  writePreparedWorkflowFile(
    input.runLayout.root,
    tasksPath,
    `${JSON.stringify(taskManifest, null, 2)}\n`,
    "workflow task manifest"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    inputPath,
    `${JSON.stringify(
      redactSecretsInValue(smithersInputDocument(compiled, input.operatorPrompt, input.operatorInput)),
      null,
      2
    )}\n`,
    "workflow input"
  );
  writePreparedWorkflowFile(
    projectRoot,
    workflowPath,
    renderWorkflowSource(compiled, input.config),
    "generated Smithers workflow"
  );
  writePreparedWorkflowFile(
    input.runLayout.root,
    evidenceWorkflowPath,
    renderEvidenceWorkflowSource(workflowPath, evidenceWorkflowPath),
    "evidence workflow"
  );
  return compiled;
}

/**
 * Enumerates the complete package/config/prompt closure consumed by a generated
 * workflow. The returned paths are sealed before any Smithers command and are
 * copied into the generation snapshot rather than read from mutable project
 * paths after verification.
 */
export async function smithersExecutionControlFiles(
  compiled: CompiledSmithersWorkflow,
  layout: RunLayout,
  env?: Record<string, string | undefined>
): Promise<WorkflowExecutionControlFile[]> {
  const files = new Map<string, WorkflowExecutionControlFile>();
  const snapshotSources = new Map<string, string>();
  const add = (sourcePath: string, snapshotPath: string): void => {
    const source = fs.realpathSync(path.resolve(sourcePath));
    const normalizedSnapshotPath = snapshotPath.split(path.sep).join("/");
    const existing = files.get(source);
    if (existing !== undefined) {
      if (existing.snapshotPath !== normalizedSnapshotPath) {
        throw new Error(`workflow execution source file has multiple snapshot paths: ${source}`);
      }
      return;
    }
    if (snapshotSources.has(normalizedSnapshotPath)) {
      throw new Error(`workflow execution snapshot path has multiple source files: ${normalizedSnapshotPath}`);
    }
    files.set(source, { sourcePath: source, snapshotPath: normalizedSnapshotPath });
    snapshotSources.set(normalizedSnapshotPath, source);
  };

  const externalRunner = explicitSmithersExecutable(env) !== undefined;
  const useExternalRunnerForExecutionClosure =
    externalRunner && compiled.tasks.every((task) => task.execution.mode !== "cloud");
  if (!useExternalRunnerForExecutionClosure) {
    await ensureSmithersDependencies(compiled.projectRoot, env, {
      timeoutMs: SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS,
      requirePinnedRunner: true
    });
  }

  for (const file of pinnedSubmoduleExecutionFiles(compiled.projectRoot, compiled.pinnedSubmodules)) {
    add(file.sourcePath, file.snapshotPath);
  }

  const planPath = path.join(layout.root, "plan.json");
  add(planPath, "controls/plan.json");
  const plan = readRunPlanDocument(planPath, layout.runId);
  const plannedPrompts = new Map<string, Record<string, unknown>>();
  for (const value of plan.rendered_prompts) {
    if (isObjectRecord(value) && typeof value.attempt_id === "string") plannedPrompts.set(value.attempt_id, value);
  }
  for (const task of compiled.tasks) {
    if (task.renderedPromptPath === undefined) continue;
    const planned = plannedPrompts.get(task.attemptId);
    if (
      planned === undefined ||
      planned.rendered_prompt_path !== task.renderedPromptPath ||
      typeof planned.rendered_prompt_snapshot_path !== "string"
    ) {
      throw new Error(`persisted prompt plan does not match compiled task ${task.attemptId}`);
    }
    add(task.renderedPromptPath, `controls/rendered-prompts/${task.attemptId}.md`);
    add(
      path.resolve(layout.root, planned.rendered_prompt_snapshot_path),
      `controls/prompt-snapshots/${task.attemptId}.md`
    );
  }

  const projectConfigPath = path.join(compiled.projectRoot, "ultrafuzz.toml");
  if (fs.existsSync(projectConfigPath)) add(projectConfigPath, "controls/ultrafuzz.toml");
  add(compiled.resolvedConfigPath, "controls/resolved-config.json");
  const agentsRoot = path.join(compiled.projectRoot, ".smithers", "agents");
  for (const sourcePath of walkExecutionFiles(agentsRoot)) {
    const source = fs.readFileSync(sourcePath, "utf8");
    if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
      throw new Error(
        `workflow agent reads mutable project ultrafuzz.toml instead of process.env.ULTRAFUZZ_CONFIG_PATH: ${sourcePath}; rerun ultrafuzz init to upgrade a byte-identical stock adapter, or update this customized adapter manually and remove controller-only variables before spawning a model process`
      );
    }
    add(sourcePath, path.posix.join(".smithers/agents", relativeExecutionPath(agentsRoot, sourcePath)));
  }

  const queuedModules = Object.values(workflowModuleEntryUrls(compiled)).filter(
    (value): value is string => value.length > 0
  );
  const modulesByRoot = new Map<string, WorkflowExecutionModule>();
  const modulesByName = new Map<string, WorkflowExecutionModule>();
  while (queuedModules.length > 0) {
    const entryPath = fileURLToPath(queuedModules.shift()!);
    const packageRoot = workflowPackageRoot(entryPath);
    if (modulesByRoot.has(packageRoot)) continue;
    const packageJsonPath = path.join(packageRoot, "package.json");
    const manifest = readWorkflowPackageManifest(packageJsonPath);
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@ultrafuzz/")) {
      throw new Error(`workflow module is not an Ultrafuzz runtime package: ${entryPath}`);
    }
    if (modulesByName.has(manifest.name)) {
      throw new Error(`workflow execution closure resolved multiple roots for ${manifest.name}`);
    }
    const module: WorkflowExecutionModule = {
      id: `module:${manifest.name}`,
      name: manifest.name,
      root: packageRoot,
      snapshotPath: path.posix.join("modules", manifest.name),
      manifest
    };
    modulesByRoot.set(packageRoot, module);
    modulesByName.set(manifest.name, module);
    add(packageJsonPath, path.posix.join(module.snapshotPath, "package.json"));
    for (const directory of ["dist", "schema"]) {
      const sourceRoot = path.join(packageRoot, directory);
      if (!fs.existsSync(sourceRoot)) continue;
      for (const sourcePath of walkExecutionFiles(sourceRoot)) {
        add(sourcePath, path.posix.join(module.snapshotPath, relativeExecutionPath(packageRoot, sourcePath)));
      }
    }
    const dockerfile = path.join(packageRoot, "Dockerfile");
    if (fs.existsSync(dockerfile)) add(dockerfile, path.posix.join(module.snapshotPath, "Dockerfile"));
    if (isObjectRecord(manifest.dependencies)) {
      for (const dependency of Object.keys(manifest.dependencies).filter((name) => name.startsWith("@ultrafuzz/"))) {
        const dependencyRoot = fs.realpathSync(path.join(packageRoot, "node_modules", ...dependency.split("/")));
        queuedModules.push(pathToFileURL(path.join(dependencyRoot, "package.json")).href);
      }
    }
  }

  const dependencyMap = collectWorkflowExecutionDependencies({
    projectRoot: compiled.projectRoot,
    modules: [...modulesByRoot.values()],
    externalRunner: useExternalRunnerForExecutionClosure,
    add
  });
  const dependencyMapPath = path.join(layout.root, "smithers", "execution-dependencies.json");
  const validatedDependencyMap = assertRuntimeDocument(
    WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
    dependencyMap,
    "workflow execution dependency map"
  );
  writeFileDurable(dependencyMapPath, `${stableWorkflowDependencyJson(validatedDependencyMap)}\n`);
  add(dependencyMapPath, WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH);
  return [...files.values()].sort((left, right) =>
    compareWorkflowExecutionStrings(left.snapshotPath, right.snapshotPath)
  );
}

interface WorkflowPackageManifest {
  name?: string;
  version?: string;
  bin?: string | Readonly<Record<string, string>>;
  dependencies?: Readonly<Record<string, string>>;
  optionalDependencies?: Readonly<Record<string, string>>;
  peerDependencies?: Readonly<Record<string, string>>;
  peerDependenciesMeta?: Readonly<Record<string, Readonly<{ optional?: boolean }>>>;
}

interface WorkflowExecutionModule {
  id: string;
  name: string;
  root: string;
  snapshotPath: string;
  manifest: WorkflowPackageManifest;
}

interface WorkflowExecutionPackage extends WorkflowExecutionModule {
  version: string;
}

interface WorkflowExecutionDependencyIssuer {
  id: string;
  root: string;
  snapshotPath: string;
  manifest: WorkflowPackageManifest;
  rootDependencies?: readonly string[];
}

function collectWorkflowExecutionDependencies(input: {
  projectRoot: string;
  modules: readonly WorkflowExecutionModule[];
  externalRunner: boolean;
  add: (sourcePath: string, snapshotPath: string) => void;
}): Record<string, unknown> {
  const modules = [...input.modules].sort((left, right) => compareWorkflowExecutionStrings(left.id, right.id));
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const packagesByRoot = new Map<string, WorkflowExecutionPackage>();
  const packages: WorkflowExecutionPackage[] = [];
  const issuers: Array<{ id: string; snapshot_path: string; dependencies: Record<string, string> }> = [];
  const executablePaths = new Set<string>();
  const smithersRoot = path.join(input.projectRoot, ".smithers");
  const rootPackageJson = path.join(smithersRoot, "package.json");
  const rootManifest = fs.existsSync(rootPackageJson) ? readWorkflowPackageManifest(rootPackageJson) : {};
  if (fs.existsSync(rootPackageJson)) input.add(rootPackageJson, "dependencies/root-package.json");
  // An explicit local runner replaces only the root Smithers dependency set.
  // Module issuers still need their external runtime dependencies in the
  // sealed closure because the runner loads those modules from the snapshot.
  const rootDependencies = input.externalRunner
    ? []
    : [...new Set([...requiredWorkflowDependencies(rootManifest), ...WORKFLOW_DIRECT_EXTERNAL_DEPENDENCIES])].sort();
  const pending: WorkflowExecutionDependencyIssuer[] = [
    { id: "root", root: smithersRoot, snapshotPath: ".", manifest: rootManifest, rootDependencies },
    ...modules
  ];

  for (let index = 0; index < pending.length; index += 1) {
    const issuer = pending[index]!;
    const dependencies: Record<string, string> = {};
    const requested =
      issuer.rootDependencies === undefined
        ? workflowPackageDependencies(issuer.manifest)
        : issuer.rootDependencies.map((name) => ({ name, optional: false }));
    for (const dependency of requested) {
      const module = modulesByName.get(dependency.name);
      if (module !== undefined) {
        dependencies[dependency.name] = module.id;
        continue;
      }
      const dependencyRoot = resolveWorkflowPackageDependency(issuer.root, dependency.name);
      if (dependencyRoot === undefined) {
        if (dependency.optional) continue;
        throw new Error(`workflow dependency is unavailable for snapshot: ${issuer.id} -> ${dependency.name}`);
      }
      const internalTarget = input.modules.find((candidate) => candidate.root === dependencyRoot);
      if (internalTarget !== undefined) {
        dependencies[dependency.name] = internalTarget.id;
        continue;
      }
      let target = packagesByRoot.get(dependencyRoot);
      if (target === undefined) {
        const manifest = readWorkflowPackageManifest(path.join(dependencyRoot, "package.json"));
        if (
          typeof manifest.name !== "string" ||
          !isWorkflowPackageName(manifest.name) ||
          typeof manifest.version !== "string" ||
          manifest.version.length === 0
        ) {
          throw new Error(`workflow dependency has invalid package metadata: ${dependencyRoot}`);
        }
        const sequence = String(packages.length + 1).padStart(6, "0");
        target = {
          id: `package:${sequence}`,
          name: manifest.name,
          version: manifest.version,
          root: dependencyRoot,
          snapshotPath: `dependencies/packages/${sequence}`,
          manifest
        };
        packagesByRoot.set(dependencyRoot, target);
        packages.push(target);
        for (const sourcePath of walkPackageExecutionFiles(dependencyRoot)) {
          const snapshotPath = path.posix.join(target.snapshotPath, relativeExecutionPath(dependencyRoot, sourcePath));
          input.add(sourcePath, snapshotPath);
          if ((fs.statSync(sourcePath).mode & 0o111) !== 0) executablePaths.add(snapshotPath);
        }
        pending.push(target);
      }
      dependencies[dependency.name] = target.id;
    }
    issuers.push({ id: issuer.id, snapshot_path: issuer.snapshotPath, dependencies });
  }

  const rootIssuer = issuers.find((issuer) => issuer.id === "root");
  const runnerId = rootIssuer?.dependencies["smthrs"];
  const runner = runnerId === undefined ? undefined : packages.find((candidate) => candidate.id === runnerId);
  let smithersBin: string | null = null;
  if (!input.externalRunner) {
    if (runner === undefined) throw new Error("workflow dependency snapshot is missing the pinned runner package");
    const binTarget = workflowPackageBinTarget(runner.manifest, "smithers");
    if (binTarget !== SMITHERS_BIN_PATH && binTarget !== `./${SMITHERS_BIN_PATH}`) {
      throw new Error("workflow dependency snapshot has an unexpected runner executable");
    }
    smithersBin = path.posix.join(runner.snapshotPath, binTarget.replace(/^\.\//u, ""));
    executablePaths.add(smithersBin);
  }
  return {
    schema_version: WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION,
    modules: modules.map((module) => ({ id: module.id, name: module.name, snapshot_path: module.snapshotPath })),
    packages: packages.map((entry) => ({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      snapshot_path: entry.snapshotPath
    })),
    issuers: issuers.sort((left, right) => compareWorkflowExecutionStrings(left.id, right.id)),
    executable_paths: [...executablePaths].sort(),
    smithers_bin: smithersBin
  };
}

function readWorkflowPackageManifest(packageJsonPath: string): WorkflowPackageManifest {
  const envelope = readPackageManagerOwnedManifestEnvelope(packageJsonPath, "workflow package manifest");
  return {
    ...projectOptionalPackageManifestString(envelope, "name", packageJsonPath),
    ...projectOptionalPackageManifestString(envelope, "version", packageJsonPath),
    ...projectOptionalPackageManifestBin(envelope, packageJsonPath),
    ...projectOptionalPackageManifestStringMap(envelope, "dependencies", packageJsonPath),
    ...projectOptionalPackageManifestStringMap(envelope, "optionalDependencies", packageJsonPath),
    ...projectOptionalPackageManifestStringMap(envelope, "peerDependencies", packageJsonPath),
    ...projectOptionalPackageManifestPeerMetadata(envelope, packageJsonPath)
  };
}

function requiredWorkflowDependencies(manifest: WorkflowPackageManifest): string[] {
  return workflowPackageDependencies(manifest)
    .filter((dependency) => !dependency.optional)
    .map((dependency) => dependency.name);
}

function workflowPackageDependencies(manifest: WorkflowPackageManifest): Array<{ name: string; optional: boolean }> {
  const dependencies = new Map<string, boolean>();
  if (isObjectRecord(manifest.dependencies)) {
    for (const name of Object.keys(manifest.dependencies)) dependencies.set(name, false);
  }
  if (isObjectRecord(manifest.optionalDependencies)) {
    for (const name of Object.keys(manifest.optionalDependencies)) dependencies.set(name, true);
  }
  if (isObjectRecord(manifest.peerDependencies)) {
    const metadata = isObjectRecord(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta : {};
    for (const name of Object.keys(manifest.peerDependencies)) {
      const peer = metadata[name];
      const optional = isObjectRecord(peer) && peer.optional === true;
      if (!dependencies.has(name) || !optional) dependencies.set(name, optional);
    }
  }
  return [...dependencies]
    .map(([name, optional]) => ({ name, optional }))
    .sort((left, right) => compareWorkflowExecutionStrings(left.name, right.name));
}

function resolveWorkflowPackageDependency(issuerRoot: string, dependency: string): string | undefined {
  if (!isWorkflowPackageName(dependency)) throw new Error(`workflow dependency name is invalid: ${dependency}`);
  let current = path.resolve(issuerRoot);
  for (;;) {
    const candidate = path.join(current, "node_modules", ...dependency.split("/"));
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWorkflowPackageName(value: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu.test(value);
}

function workflowPackageBinTarget(manifest: WorkflowPackageManifest, name: string): string | undefined {
  if (typeof manifest.bin === "string") return manifest.bin;
  return isObjectRecord(manifest.bin) && typeof manifest.bin[name] === "string" ? manifest.bin[name] : undefined;
}

function walkPackageExecutionFiles(root: string): string[] {
  return walkExecutionFiles(root, true);
}

function compareWorkflowExecutionStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableWorkflowDependencyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableWorkflowDependencyJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareWorkflowExecutionStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableWorkflowDependencyJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function workflowModuleEntryUrls(compiled: CompiledSmithersWorkflow): {
  artifacts: string;
  runtime: string;
  modal: string;
} {
  return {
    artifacts: import.meta.resolve("@ultrafuzz/artifacts"),
    runtime: import.meta.resolve("@ultrafuzz/runtime"),
    modal: compiled.tasks.some((task) => task.execution.mode === "cloud") ? import.meta.resolve("@ultrafuzz/modal") : ""
  };
}

function workflowPackageRoot(entryPath: string): string {
  let current = path.dirname(fs.realpathSync(entryPath));
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot resolve workflow module package root for ${entryPath}`);
    current = parent;
  }
}

function walkExecutionFiles(root: string, skipNodeModules = false): string[] {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`workflow execution closure root is not a physical directory: ${resolvedRoot}`);
  }
  const pending = [resolvedRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareWorkflowExecutionStrings(left.name, right.name))) {
      if (skipNodeModules && entry.name === "node_modules" && entry.isDirectory()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`workflow execution closure cannot contain a symlink: ${candidate}`);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error(`workflow execution closure contains a non-regular entry: ${candidate}`);
      if (files.length + pending.length > 50_000) throw new Error("workflow execution closure exceeds file limit");
    }
  }
  return files.sort();
}

function relativeExecutionPath(root: string, filePath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join("/");
  if (relative.length === 0 || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`workflow execution file escapes its package root: ${filePath}`);
  }
  return relative;
}

function smithersInputDocument(
  compiled: CompiledSmithersWorkflow,
  operatorPrompt: string | undefined,
  operatorInput: unknown
): Record<string, unknown> {
  return {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    // The workflow runner owns `run_id` in its input table, so the Ultrafuzz run
    // identity this envelope is bound to travels under its own key.
    ultrafuzz_run_id: compiled.runId,
    ...(operatorPrompt ? { operator_prompt: operatorPrompt } : {}),
    ...(operatorInput !== undefined ? { operator_input: operatorInput } : {}),
    tasks: compiled.tasks.map((task) => ({
      id: task.smithersNodeId,
      ...(task.renderedPromptPath
        ? { prompt_path: executionPath(compiled.projectRoot, task, task.renderedPromptPath, "rendered prompt") }
        : {})
    }))
  };
}

export async function submitSmithersWorkflow(input: SubmitSmithersInput): Promise<SmithersSubmissionResult> {
  const command = [
    "up",
    input.workflowPath ?? input.compiled.workflowPath,
    "--detach",
    "--run-id",
    input.compiled.smithersRunId,
    "--max-concurrency",
    String(input.maxConcurrency),
    "--root",
    input.projectRoot,
    "--log-dir",
    input.compiled.logsDir,
    "--input",
    input.inputJson,
    "--format",
    "json",
    ...supervisorCommandArgs(input.controllerLeaseSeconds)
  ];
  fs.mkdirSync(input.compiled.logsDir, { recursive: true });
  const {
    stdout,
    stderr,
    command: displayCommand
  } = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env,
    environmentVariableNames: input.environmentVariableNames,
    keepWorkspaces: input.keepWorkspaces
  });
  writeRuntimeDocument(
    path.join(path.dirname(input.compiled.inputPath), "submission.json"),
    SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
    {
      schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
      smithers_run_id: input.compiled.smithersRunId,
      command: displayCommand,
      stdout: redactedEvidenceText(stdout),
      stderr: redactedEvidenceText(stderr),
      submitted_at: new Date().toISOString()
    },
    "Smithers submission evidence"
  );
  return {
    smithersRunId: input.compiled.smithersRunId,
    command: displayCommand,
    stdout,
    stderr
  };
}

export async function requestSmithersPause(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersPauseResult> {
  const result = await execSmithersCli({
    // `--full-output` is what makes the runner emit the `{ok, data, meta}`
    // envelope this result is read as.
    args: ["pause", input.smithersRunId, "--format", "json", "--full-output"],
    projectRoot: input.projectRoot,
    env: input.env,
    acceptedExitCodes: [2]
  });
  const payload = commandPayload(jsonField(result.stdout).json);
  const reportedStatus = payload?.status;
  if (reportedStatus !== "paused" && reportedStatus !== "pause-requested") {
    throw new Error("workflow runner pause did not return the current JSON status contract");
  }
  return { ...result, status: reportedStatus };
}

export async function requestSmithersCancel(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersCancelResult> {
  // Exit 2 carries a durable cancel request. Exit 4 is the engine reporting the
  // run is no longer active, which for cancellation is a completed outcome, not
  // a failure: rerunning `cancel` to confirm an in-flight request must converge
  // rather than error.
  const result = await execSmithersCli({
    args: ["cancel", input.smithersRunId, "--format", "json", "--full-output"],
    projectRoot: input.projectRoot,
    env: input.env,
    acceptedExitCodes: [2, 4]
  });
  if (result.exitCode === 4 && !smithersStdoutHasErrorCode(result.stdout, "RUN_NOT_ACTIVE")) {
    throw new Error(sanitizedDiagnosticText(result.stderr.trim() || "workflow runner cancel failed"));
  }
  if (result.exitCode === 4) {
    return { ...result, status: "cancelled", reportedStatus: "already-terminal" };
  }
  const payload = commandPayload(jsonField(result.stdout).json);
  const reportedStatus = payload?.status;
  if (reportedStatus !== "cancelled" && reportedStatus !== "cancel-requested") {
    throw new Error("workflow runner cancel did not return the current JSON status contract");
  }
  return { ...result, status: reportedStatus, reportedStatus };
}

function smithersStdoutHasErrorCode(stdout: string, code: string): boolean {
  const parsed = jsonField(stdout).json;
  return isObjectRecord(parsed) && parsed.ok === false && isObjectRecord(parsed.error) && parsed.error.code === code;
}

/**
 * Streams a bounded number of stdout lines from an inspection command instead
 * of buffering the whole run through `execFile`. Watch surfaces need
 * incremental output and deterministic teardown; the bounded inspection helper
 * stays strict for one-shot reads.
 */
export async function streamSmithersCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  maxLines: number;
  onLine: (line: string) => void | Promise<void>;
}): Promise<SmithersStreamResult> {
  const command = [...input.args];
  const displayCommand = smithersDisplayCommand(command);
  // An already-aborted caller must not spawn a process at all: `abort` has
  // already been dispatched, so an abort listener registered later never fires
  // and the doomed child would run until it exited on its own.
  if (isAbortedSignal(input.signal)) {
    return {
      command: displayCommand,
      lines: 0,
      truncated: false,
      exitCode: null,
      terminatedBySignal: null,
      stoppedByCaller: true,
      stderr: ""
    };
  }
  const commandEnvironment = await prepareSmithersExecutableEnvironment(input.projectRoot, input.env, {
    signal: input.signal
  });
  const { anchored, snapshotAnchor, executableAnchor } = acquireAnchoredSmithersController(command, commandEnvironment);
  const child = (() => {
    try {
      return spawn(
        executableAnchor?.executable ?? smithersExecutable(input.projectRoot, anchored.env),
        [...(executableAnchor?.argumentPrefix ?? []), ...anchored.args],
        {
          cwd: input.projectRoot,
          env: smithersCommandEnv(input.projectRoot, anchored.env),
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
    } catch (error) {
      try {
        assertAndCloseSmithersExecutableAnchor(executableAnchor);
      } finally {
        assertAndCloseWorkflowExecutionSnapshotAnchor(snapshotAnchor);
      }
      throw error;
    }
  })();
  const childClosed = new Promise<void>((resolve) => {
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let lines = 0;
  let truncated = false;
  let stderr = "";
  let stoppedByCaller = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stopStreaming = (): void => {
    stoppedByCaller = true;
    reader.close();
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      // A wedged engine can ignore SIGTERM, which would leave this awaiting
      // `close` forever. Escalate once, and never hold the event loop open.
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, STREAM_TERMINATION_GRACE_MS).unref();
    }
  };
  const onAbort = (): void => {
    stopStreaming();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  // Covers an abort that landed while dependencies were being verified above,
  // after the pre-spawn check and before this listener existed.
  if (isAbortedSignal(input.signal)) {
    stopStreaming();
  }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = truncateDiagnosticText(`${stderr}${chunk}`);
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      child.once("error", (error) => {
        settle(() => {
          reject(error);
        });
      });
      child.once("close", (code, signal) => {
        settle(() => {
          resolve({ code, signal });
        });
      });
      reader.on("line", (line) => {
        if (truncated) {
          return;
        }
        lines += 1;
        // Contain a throwing or rejecting consumer: an exception raised inside
        // this readline handler would otherwise be uncaught and the awaited
        // promise would never settle.
        try {
          const pending = input.onLine(line);
          if (pending !== undefined) {
            pending.catch((error: unknown) => {
              settle(() => {
                reject(error instanceof Error ? error : new Error(String(error)));
              });
            });
          }
        } catch (error) {
          settle(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
        if (lines >= input.maxLines) {
          truncated = true;
          stopStreaming();
        }
      });
    });
    return {
      command: displayCommand,
      lines,
      truncated,
      exitCode: exit.code,
      terminatedBySignal: exit.signal,
      stoppedByCaller,
      stderr: redactedEvidenceText(stderr)
    };
  } finally {
    try {
      input.signal?.removeEventListener("abort", onAbort);
      stopStreaming();
      // The descriptor paths belong to this controller process. Keep them open
      // until a stopped or failed child can no longer resolve either path.
      await childClosed;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
    } finally {
      try {
        assertAndCloseSmithersExecutableAnchor(executableAnchor);
      } finally {
        assertAndCloseWorkflowExecutionSnapshotAnchor(snapshotAnchor);
      }
    }
  }
}

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Reports the local workflow-runner installation posture without mutating or
 * upgrading anything, so `doctor` can explain a broken install offline.
 */
export function inspectSmithersInstallation(projectRoot: string): SmithersInstallationPosture {
  const resolvedRoot = path.resolve(projectRoot);
  const binPath = localSmithersExecutable(resolvedRoot);
  let installedVersion: string | null = null;
  let installedBinTarget: string | null = null;
  try {
    const packageJson = path.join(resolveInstalledSmithersPackageRoot(resolvedRoot), "package.json");
    const metadata = readPackageManagerOwnedManifestEnvelope(packageJson, "installed Smithers package manifest");
    const candidateVersion = optionalPackageManifestString(metadata, "version", packageJson) ?? null;
    const bin = optionalPackageManifestBin(metadata, packageJson);
    const candidateBinTarget = typeof bin === "object" && bin !== null ? (bin.smithers ?? null) : null;
    installedVersion = candidateVersion;
    installedBinTarget = candidateBinTarget;
  } catch {
    // The detailed layout error below reports malformed or missing manifests.
  }
  return {
    bundled_version: SMITHERS_VERSION,
    required_version: SMITHERS_VERSION,
    installed_version: installedVersion,
    installed_bin_target: installedBinTarget,
    bin_path: fs.existsSync(binPath) ? binPath : null,
    layout_error: installedSmithersValidationError(resolvedRoot) ?? null,
    compatibility_patches: inspectSmithersCompatibilityPatches(resolvedRoot)
  };
}

// Reports every workaround in SMITHERS_COMPATIBILITY_PATCHES, including the two
// resume-durability patches that live in the scheduler and engine packages. A
// posture that goes unreported reads as healthy, and these two are exactly the
// ones whose absence silently costs durable resume progress.
function inspectSmithersCompatibilityPatches(
  projectRoot: string
): SmithersInstallationPosture["compatibility_patches"] {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const postures: Record<string, SmithersPatchPosture> = {};
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES) {
    const candidateRoots = smithersDependencyRootCandidates(nodeModules, patch.packageName);
    if (candidateRoots.length === 1) {
      const source = path.join(candidateRoots[0]!, ...patch.sourceRelativePath.split("/"));
      postures[patch.id] = patchPosture(source, patch.patched, patch.patchable);
      continue;
    }
    // Two roots make the next run hard-fail in `applySmithersCompatibilityPatches`,
    // so this must not read as merely unavailable. No root at all genuinely leaves
    // the posture unknown.
    postures[patch.id] = candidateRoots.length > 1 ? "incompatible" : "unknown";
  }
  for (const required of SMITHERS_REQUIRED_ENGINE_ANCHORS) {
    const candidateRoots = smithersDependencyRootCandidates(nodeModules, required.packageName);
    if (candidateRoots.length !== 1) {
      postures[required.id] = candidateRoots.length > 1 ? "incompatible" : "unknown";
      continue;
    }
    const source = path.join(candidateRoots[0]!, ...required.sourceRelativePath.split("/"));
    try {
      postures[required.id] = fs.readFileSync(source, "utf8").includes(required.anchor) ? "applied" : "incompatible";
    } catch {
      postures[required.id] = "unknown";
    }
  }
  return postures;
}

// A registry install nests the runner's own dependencies under it, while a
// hoisted layout puts them beside it. Both are legitimate, so resolve either and
// let callers decide what an absent or ambiguous result means.
function smithersDependencyRootCandidates(nodeModules: string, packageName: string): string[] {
  const segments = packageName.split("/");
  return [path.join(nodeModules, ...segments), path.join(nodeModules, "smthrs", "node_modules", ...segments)].filter(
    (candidate) => fs.existsSync(candidate)
  );
}

function patchPosture(sourcePath: string, patched: string, patchable: string): SmithersPatchPosture {
  if (!fs.existsSync(sourcePath)) {
    return "unknown";
  }
  let contents: string;
  try {
    contents = fs.readFileSync(sourcePath, "utf8");
  } catch {
    // An unreadable source must degrade, not throw out of `doctor`.
    return "unknown";
  }
  if (contents.includes(patched)) {
    return "applied";
  }
  // The pinned release carries the exact shape Ultrafuzz patches, so a source
  // with neither the patch nor the patchable shape has been modified or
  // replaced. `applySmithersCompatibilityPatches` throws in that state, so
  // report it as incompatible rather than assuming an upstream fix.
  return contents.includes(patchable) ? "missing" : "incompatible";
}

export function commandPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.data)) {
    return undefined;
  }
  return value.data;
}

export async function runSmithersLifecycleCommand(input: {
  action: "resume" | "replay" | "fork";
  smithersRunId: string;
  workflowPath: string;
  projectRoot: string;
  maxConcurrency?: number;
  forkFrame?: number;
  resetNode?: string;
  force?: boolean;
  retryFailed?: boolean;
  label?: string;
  relaunchPaths?: {
    runRoot: string;
    inputPath: string;
    inputJson?: string;
    logsDir: string;
  };
  keepWorkspaces: boolean;
  controllerLeaseSeconds: number;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
}): Promise<{
  stdout: string;
  stderr: string;
  command: string[];
  workflowRunId?: string;
  recoveredMissingRun?: boolean;
  alreadyRunning?: boolean;
}> {
  // Every `up` invocation has to name the run-scoped log directory. Without `--log-dir` the
  // orchestrator falls back to `<projectRoot>/.smithers/executions/<runId>/logs`, so a relaunched
  // run stops appending to `<runRoot>/smithers/logs/stream.ndjson` and the `NodeFailed` events for
  // every attempt after the first — the only record carrying a node's real error payload — land
  // outside the run directory the evidence layout owns.
  const workflowLogDirArgs = (): readonly string[] => {
    const paths = input.relaunchPaths;
    if (paths === undefined) {
      return [];
    }
    assertPathInside(paths.runRoot, paths.logsDir, "workflow log directory");
    fs.mkdirSync(paths.logsDir, { recursive: true });
    assertNoSymlinkComponents(paths.runRoot, paths.logsDir, "workflow log directory");
    return ["--log-dir", paths.logsDir];
  };
  const workflowRelaunchInputJson = (): string => {
    const paths = input.relaunchPaths;
    if (paths === undefined) throw new Error("workflow relaunch paths are unavailable");
    if (paths.inputJson !== undefined) return paths.inputJson;
    if (hasWorkflowExecutionSnapshotCapability(input.env)) {
      throw new Error("sealed workflow relaunch is missing its materialized input bytes");
    }
    assertRegularFileInside(paths.runRoot, paths.inputPath, "persisted workflow input");
    return fs.readFileSync(paths.inputPath, "utf8");
  };

  let preResumeStderr = "";
  if (input.action === "resume" && input.relaunchPaths !== undefined) {
    const inspection = await runSmithersInspectionCommand({
      args: ["inspect", input.smithersRunId, "--format", "json", "--full-output"],
      projectRoot: input.projectRoot,
      env: input.env
    });
    if (smithersSnapshotHasErrorCode(inspection, "RUN_NOT_FOUND")) {
      const recoveryLogDirArgs = workflowLogDirArgs();
      const inputJson = workflowRelaunchInputJson();
      const recoveryCommand = [
        "up",
        input.workflowPath,
        "--detach",
        "--run-id",
        input.smithersRunId,
        ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
        "--root",
        input.projectRoot,
        ...recoveryLogDirArgs,
        "--input",
        inputJson,
        "--format",
        "json",
        ...supervisorCommandArgs(input.controllerLeaseSeconds)
      ];
      const recoveryResult = await execSmithersCli({
        args: recoveryCommand,
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
      writeRuntimeDocument(
        path.join(path.dirname(input.relaunchPaths.inputPath), "recovery-submission.json"),
        SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
        {
          schema_version: SMITHERS_SUBMISSION_SCHEMA_VERSION,
          smithers_run_id: input.smithersRunId,
          recovery: "missing-workflow-run",
          command: recoveryResult.command,
          stdout: redactedEvidenceText(recoveryResult.stdout),
          stderr: redactedEvidenceText(recoveryResult.stderr),
          submitted_at: new Date().toISOString()
        },
        "Smithers recovery submission evidence"
      );
      return { ...recoveryResult, recoveredMissingRun: true };
    }
    if (!inspection.ok) {
      throw new Error(
        `workflow inspection failed before resume: ${inspection.error ?? (inspection.stderr.trim() || "unknown error")}`
      );
    }
    const currentInspection = parseCurrentSmithersInspect(inspection, input.smithersRunId);
    if (smithersRunStateIsActive(currentInspection) && input.resetNode === undefined && input.force !== true) {
      return {
        stdout: inspection.stdout,
        stderr: inspection.stderr,
        command: inspection.command,
        alreadyRunning: true
      };
    }
    const failedTasks =
      input.retryFailed === true && !smithersRunStateIsActive(currentInspection)
        ? smithersFailedTasks(currentInspection)
        : [];
    if (failedTasks.length > 0) {
      const resetStderr: string[] = [];
      for (const failedTask of failedTasks) {
        const resetResult = await execSmithersCli({
          args: [
            "timetravel",
            input.workflowPath,
            "--run-id",
            input.smithersRunId,
            "--node-id",
            failedTask.nodeId,
            "--iteration",
            String(failedTask.iteration),
            "--no-deps",
            "--force",
            "--format",
            "json"
          ],
          projectRoot: input.projectRoot,
          env: input.env,
          environmentVariableNames: input.environmentVariableNames,
          keepWorkspaces: input.keepWorkspaces
        });
        if (resetResult.stderr.length > 0) resetStderr.push(resetResult.stderr);
      }
      preResumeStderr = resetStderr.join("\n");
    }
    if (
      failedTasks.length === 0 &&
      input.retryFailed === true &&
      input.resetNode === undefined &&
      (currentInspection.runState === "failed" || currentInspection.runState === "stale") &&
      smithersSnapshotHasErrorCode(inspection, "WORKFLOW_RENDER_FAILED") &&
      !isCompatibleSmithersRunId(input.smithersRunId)
    ) {
      throw new Error(
        `persisted workflow run ID ${JSON.stringify(input.smithersRunId)} is unsupported by the pinned workflow runner; historical runs are not converted or transferred`
      );
    }
  }

  if (input.action === "resume" && input.resetNode !== undefined) {
    const resetMarkerPath =
      input.relaunchPaths === undefined
        ? undefined
        : path.join(path.dirname(input.relaunchPaths.inputPath), "reset-node-applied.json");
    let resetStderr = "";
    if (!resetNodeMarkerMatches(resetMarkerPath, input.smithersRunId, input.resetNode)) {
      const resetResult = await execSmithersCli({
        args: [
          "timetravel",
          input.workflowPath,
          "--run-id",
          input.smithersRunId,
          "--node-id",
          input.resetNode,
          "--no-vcs",
          "--force",
          "--format",
          "json"
        ],
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
      resetStderr = resetResult.stderr;
      if (resetMarkerPath !== undefined) {
        const appliedAt = new Date().toISOString();
        writeRuntimeDocument(
          resetMarkerPath,
          SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
          {
            schema_version: SMITHERS_RESET_NODE_SCHEMA_VERSION,
            smithers_run_id: input.smithersRunId,
            node_id: input.resetNode,
            applied_at: appliedAt
          },
          "Smithers reset-node marker"
        );
        writeRuntimeDocument(
          path.join(path.dirname(input.relaunchPaths!.inputPath), "cloud-execution-generation.json"),
          CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
          {
            schema_version: CLOUD_EXECUTION_GENERATION_SCHEMA_VERSION,
            generation: crypto.randomUUID(),
            reset_node: input.resetNode,
            applied_at: appliedAt
          },
          "cloud execution generation evidence"
        );
      }
    }
    let resumeResult: Awaited<ReturnType<typeof execSmithersCli>>;
    try {
      resumeResult = await execSmithersCli({
        args: [
          "up",
          input.workflowPath,
          "--resume",
          input.smithersRunId,
          "--run-id",
          input.smithersRunId,
          "--force",
          "--detach",
          ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
          ...workflowLogDirArgs(),
          "--format",
          "json",
          ...supervisorCommandArgs(input.controllerLeaseSeconds)
        ],
        projectRoot: input.projectRoot,
        env: input.env,
        environmentVariableNames: input.environmentVariableNames,
        keepWorkspaces: input.keepWorkspaces
      });
    } catch (error) {
      if (error instanceof Error && resetMarkerPath !== undefined) {
        error.message =
          `${error.message} ` +
          `(node reset for ${input.resetNode} already completed; ` +
          `rerun the same resume command to continue the reset run without repeating the reset)`;
      }
      throw error;
    }
    if (resetMarkerPath !== undefined) {
      fs.rmSync(resetMarkerPath, { force: true });
    }
    return {
      ...resumeResult,
      stderr: [resetStderr, resumeResult.stderr].filter((value) => value.length > 0).join("\n")
    };
  }

  if (input.action === "fork" && input.forkFrame !== undefined) {
    const forkCommand = [
      "fork",
      input.workflowPath,
      "--run-id",
      input.smithersRunId,
      "--frame",
      String(input.forkFrame),
      ...(input.resetNode === undefined ? [] : ["--reset-node", input.resetNode]),
      ...(input.label === undefined ? [] : ["--label", input.label]),
      "--format",
      "json",
      "--full-output"
    ];
    const forkResult = await execSmithersCli({
      args: forkCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces
    });
    const forkedRunId = parseForkedRunId(forkResult.stdout);
    if (forkedRunId === undefined) {
      throw new Error("workflow fork did not return a forked workflow run ID");
    }
    const resumeCommand = [
      "up",
      input.workflowPath,
      "--resume",
      forkedRunId,
      "--run-id",
      forkedRunId,
      "--force",
      "--detach",
      ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
      ...workflowLogDirArgs(),
      "--format",
      "json",
      ...supervisorCommandArgs(input.controllerLeaseSeconds)
    ];
    const resumeResult = await execSmithersCli({
      args: resumeCommand,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
      keepWorkspaces: input.keepWorkspaces
    });
    return {
      stdout: resumeResult.stdout,
      stderr: [forkResult.stderr, resumeResult.stderr].filter((value) => value.length > 0).join("\n"),
      command: resumeResult.command,
      workflowRunId: forkedRunId
    };
  }

  const command =
    input.action === "resume"
      ? [
          "up",
          input.workflowPath,
          "--resume",
          input.smithersRunId,
          "--run-id",
          input.smithersRunId,
          ...(input.force === true ? ["--force"] : []),
          "--detach",
          ...(input.maxConcurrency === undefined ? [] : ["--max-concurrency", String(input.maxConcurrency)]),
          ...workflowLogDirArgs(),
          "--format",
          "json",
          ...supervisorCommandArgs(input.controllerLeaseSeconds)
        ]
      : input.action === "fork"
        ? [
            input.action,
            input.workflowPath,
            "--run-id",
            input.smithersRunId,
            "--run",
            "--format",
            "json",
            "--full-output"
          ]
        : [input.action, input.workflowPath, "--run-id", input.smithersRunId, "--format", "json", "--full-output"];
  const result = await execSmithersCli({
    args: command,
    projectRoot: input.projectRoot,
    env: input.env,
    environmentVariableNames: input.environmentVariableNames,
    keepWorkspaces: input.keepWorkspaces
  });
  return {
    ...result,
    stderr: [preResumeStderr, result.stderr].filter((value) => value.length > 0).join("\n"),
    ...(["fork", "replay"].includes(input.action) ? { workflowRunId: parseForkedRunId(result.stdout) } : {})
  };
}

export async function runSmithersInspectionCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SmithersCommandSnapshot> {
  const command = [...input.args];
  try {
    const result = await execSmithersCli({
      args: command,
      projectRoot: input.projectRoot,
      env: input.env,
      signal: input.signal,
      timeoutMs: input.timeoutMs
    });
    return {
      command: result.command,
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      ...jsonField(result.stdout)
    };
  } catch (error) {
    const record =
      error && typeof error === "object" ? (error as { stdout?: unknown; stderr?: unknown; message?: unknown }) : {};
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return {
      command: smithersDisplayCommand(command),
      ok: false,
      stdout,
      stderr,
      ...jsonField(stdout),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function smithersSnapshotHasErrorCode(snapshot: SmithersCommandSnapshot, code: string): boolean {
  if (!isObjectRecord(snapshot.json)) return false;
  if (snapshot.json.ok === false && isObjectRecord(snapshot.json.error)) {
    return snapshot.json.error.code === code;
  }
  if (snapshot.json.ok !== true || !isObjectRecord(snapshot.json.data)) return false;
  const run = snapshot.json.data.run;
  return isObjectRecord(run) && isObjectRecord(run.error) && run.error.code === code;
}

function smithersRunStateIsActive(inspect: CurrentSmithersInspect): boolean {
  return SMITHERS_ACTIVE_RUN_STATES.has(inspect.runState);
}

function smithersFailedTasks(inspect: CurrentSmithersInspect): Array<{ nodeId: string; iteration: number }> {
  const failedTasks = new Map<string, { nodeId: string; iteration: number }>();
  for (const key of inspect.failedChildKeys) {
    const separator = key.lastIndexOf("::");
    const nodeId = key.slice(0, separator);
    const iteration = Number(key.slice(separator + 2));
    failedTasks.set(key, { nodeId, iteration });
  }
  if (failedTasks.size > 0) return [...failedTasks.values()];
  // The runner derives `failedChildKeys` only for a success-terminal run, so a
  // genuinely failed run never carries them and retrying one used to throw. Its
  // canonical `nodes` array still names every failed node exactly. Topology
  // expansion gives each loop iteration its own concrete node, so a generated
  // workflow runs every node at iteration 0 and the node id alone identifies the
  // attempt to reset.
  for (const entry of inspect.nodes) {
    if (entry.state !== "failed") continue;
    failedTasks.set(`${entry.nodeId}::0`, { nodeId: entry.nodeId, iteration: 0 });
  }
  return [...failedTasks.values()];
}

export function parseCurrentSmithersInspect(
  snapshot: SmithersCommandSnapshot,
  expectedWorkflowRunId: string
): CurrentSmithersInspect {
  const envelope = snapshot.json;
  if (!isObjectRecord(envelope) || !hasExactObjectKeys(envelope, ["ok", "data", "meta"])) {
    throw new Error("Smithers inspect output must use the exact current full-output envelope");
  }
  if (envelope.ok !== true) {
    throw new Error("Smithers inspect full-output envelope must report ok: true");
  }
  validateCurrentSmithersInspectMeta(envelope.meta);
  if (!isObjectRecord(envelope.data)) {
    throw new Error("Smithers inspect data must be an object");
  }
  const data = envelope.data;
  const removedAliases = ["tasks", "status", "state"].filter((key) => Object.hasOwn(data, key));
  if (removedAliases.length > 0) {
    throw new Error(`Smithers inspect data contains removed field aliases: ${removedAliases.join(", ")}`);
  }
  assertCurrentInspectObjectKeys(
    data,
    ["run", "runState", "steps", "nodes"],
    [
      "run",
      "runState",
      "failedChildren",
      "failedChildKeys",
      "steps",
      "nodes",
      "approvals",
      "timers",
      "loops",
      "config"
    ],
    "Smithers inspect data"
  );
  if (!Array.isArray(data.steps)) {
    throw new Error("Smithers inspect data.steps must be the ignored compatibility array emitted by the pinned runner");
  }
  for (const key of ["approvals", "timers", "loops"] as const) {
    if (data[key] !== undefined && !Array.isArray(data[key])) {
      throw new Error(`Smithers inspect data.${key} must be an array`);
    }
  }
  if (data.config !== undefined && !isObjectRecord(data.config)) {
    throw new Error("Smithers inspect data.config must be an object");
  }

  const run = data.run;
  if (!isObjectRecord(run)) {
    throw new Error("Smithers inspect data.run must be an object");
  }
  if (Object.hasOwn(run, "startedAt") || Object.hasOwn(run, "finishedAt")) {
    throw new Error("Smithers inspect data.run contains removed timestamp aliases");
  }
  assertCurrentInspectObjectKeys(
    run,
    ["id", "workflow", "status", "started", "elapsed"],
    [
      "id",
      "workflow",
      "status",
      "parentRunId",
      "started",
      "elapsed",
      "finished",
      "activeDescendantRunId",
      "error",
      "startedBy",
      "continuedFrom",
      "continuedFromDisplay"
    ],
    "Smithers inspect data.run"
  );
  if (requiredCurrentInspectString(run.id, "Smithers inspect data.run.id") !== expectedWorkflowRunId) {
    throw new Error("Smithers inspect data.run.id does not match the requested workflow run");
  }
  const runStatus = requiredCurrentInspectEnum(run.status, SMITHERS_RUN_STATUSES, "Smithers inspect data.run.status");
  requiredCurrentInspectString(run.workflow, "Smithers inspect data.run.workflow");
  requiredCurrentInspectString(run.started, "Smithers inspect data.run.started");
  requiredCurrentInspectString(run.elapsed, "Smithers inspect data.run.elapsed");
  for (const key of ["parentRunId", "finished", "activeDescendantRunId", "continuedFromDisplay"] as const) {
    if (run[key] !== undefined) requiredCurrentInspectString(run[key], `Smithers inspect data.run.${key}`);
  }
  if (run.finished !== undefined && !isCanonicalDateTime(run.finished as string)) {
    throw new Error("Smithers inspect data.run.finished must be a canonical timestamp");
  }
  if (run.continuedFrom !== undefined) {
    if (!Array.isArray(run.continuedFrom)) {
      throw new Error("Smithers inspect data.run.continuedFrom must be an array");
    }
    for (const [index, value] of run.continuedFrom.entries()) {
      requiredCurrentInspectString(value, `Smithers inspect data.run.continuedFrom[${index}]`);
    }
  }
  if (run.startedBy !== undefined) validateCurrentSmithersStartedBy(run.startedBy);

  const runState = data.runState;
  if (!isObjectRecord(runState)) {
    throw new Error("Smithers inspect data.runState must be an object");
  }
  assertCurrentInspectObjectKeys(
    runState,
    ["runId", "state", "computedAt"],
    ["runId", "state", "computedAt", "blocked", "unhealthy"],
    "Smithers inspect data.runState"
  );
  if (requiredCurrentInspectString(runState.runId, "Smithers inspect data.runState.runId") !== expectedWorkflowRunId) {
    throw new Error("Smithers inspect data.runState.runId does not match the requested workflow run");
  }
  const computedAt = requiredCurrentInspectString(runState.computedAt, "Smithers inspect data.runState.computedAt");
  if (!isCanonicalDateTime(computedAt)) {
    throw new Error("Smithers inspect data.runState.computedAt must be a canonical timestamp");
  }
  for (const key of ["blocked", "unhealthy"] as const) {
    if (runState[key] !== undefined && !isObjectRecord(runState[key])) {
      throw new Error(`Smithers inspect data.runState.${key} must be an object`);
    }
  }
  const parsedRunState = requiredCurrentInspectEnum(
    runState.state,
    SMITHERS_RUN_STATES,
    "Smithers inspect data.runState.state"
  );
  if (parsedRunState === "unknown") {
    throw new Error("Smithers inspect data.runState.state is unknown and cannot drive resume");
  }

  if (!Array.isArray(data.nodes)) {
    throw new Error("Smithers inspect data.nodes must be the canonical node array");
  }
  const nodeIds = new Set<string>();
  const nodes = data.nodes.map((value, index): CurrentSmithersInspectNode => {
    const label = `Smithers inspect data.nodes[${index}]`;
    if (!isObjectRecord(value) || !hasExactObjectKeys(value, ["nodeId", "state", "attempt", "label"])) {
      throw new Error(`${label} must use the exact current node shape`);
    }
    const nodeId = requiredCurrentInspectString(value.nodeId, `${label}.nodeId`);
    if (nodeIds.has(nodeId)) {
      throw new Error(`${label}.nodeId duplicates an earlier canonical node`);
    }
    nodeIds.add(nodeId);
    return {
      nodeId,
      state: requiredCurrentInspectEnum(value.state, SMITHERS_NODE_STATES, `${label}.state`),
      attempt: requiredCurrentInspectCount(value.attempt, `${label}.attempt`),
      label: requiredCurrentInspectString(value.label, `${label}.label`)
    };
  });

  const failedChildKeys = parseCurrentSmithersFailedChildKeys(data, nodeIds);
  return { runStatus, runState: parsedRunState, nodes, failedChildKeys };
}

function validateCurrentSmithersInspectMeta(value: unknown): void {
  if (
    !isObjectRecord(value) ||
    !Object.hasOwn(value, "command") ||
    !Object.hasOwn(value, "duration") ||
    Object.keys(value).some((key) => !["command", "duration", "cta"].includes(key))
  ) {
    throw new Error("Smithers inspect metadata must use the exact current full-output shape");
  }
  if (value.command !== "inspect") {
    throw new Error("Smithers inspect metadata command must be inspect");
  }
  requiredCurrentInspectString(value.duration, "Smithers inspect metadata duration");
  if (value.cta === undefined) return;
  if (!isObjectRecord(value.cta) || !hasExactObjectKeys(value.cta, ["description", "commands"])) {
    throw new Error("Smithers inspect metadata CTA must use the exact current shape");
  }
  requiredCurrentInspectString(value.cta.description, "Smithers inspect metadata CTA description");
  if (!Array.isArray(value.cta.commands) || value.cta.commands.length === 0) {
    throw new Error("Smithers inspect metadata CTA commands must be a non-empty array");
  }
  for (const [index, command] of value.cta.commands.entries()) {
    const label = `Smithers inspect metadata CTA commands[${index}]`;
    if (
      !isObjectRecord(command) ||
      !Object.hasOwn(command, "command") ||
      Object.keys(command).some((key) => !["command", "description"].includes(key))
    ) {
      throw new Error(`${label} must use the exact current shape`);
    }
    requiredCurrentInspectString(command.command, `${label}.command`);
    if (command.description !== undefined) {
      requiredCurrentInspectString(command.description, `${label}.description`);
    }
  }
}

function validateCurrentSmithersStartedBy(value: unknown): void {
  if (!isObjectRecord(value)) {
    throw new Error("Smithers inspect data.run.startedBy must be an object");
  }
  assertCurrentInspectObjectKeys(
    value,
    [],
    ["harness", "sessionId", "prompt", "detected"],
    "Smithers inspect data.run.startedBy"
  );
  for (const key of ["harness", "sessionId", "prompt"] as const) {
    if (value[key] !== undefined) {
      requiredCurrentInspectString(value[key], `Smithers inspect data.run.startedBy.${key}`);
    }
  }
  if (value.detected !== undefined && value.detected !== true) {
    throw new Error("Smithers inspect data.run.startedBy.detected must be true when present");
  }
  if (Object.keys(value).length === 0) {
    throw new Error("Smithers inspect data.run.startedBy must not be empty");
  }
}

function parseCurrentSmithersFailedChildKeys(data: Record<string, unknown>, nodeIds: ReadonlySet<string>): string[] {
  const hasFailedChildren = Object.hasOwn(data, "failedChildren");
  const hasFailedChildKeys = Object.hasOwn(data, "failedChildKeys");
  if (hasFailedChildren !== hasFailedChildKeys) {
    throw new Error("Smithers inspect failedChildren and failedChildKeys must be present together");
  }
  if (!hasFailedChildren) return [];
  const count = requiredCurrentInspectCount(data.failedChildren, "Smithers inspect data.failedChildren");
  if (count === 0 || !Array.isArray(data.failedChildKeys) || data.failedChildKeys.length !== count) {
    throw new Error("Smithers inspect failed child count and keys do not use the current paired shape");
  }
  const keys = new Set<string>();
  for (const [index, value] of data.failedChildKeys.entries()) {
    const key = requiredCurrentInspectString(value, `Smithers inspect data.failedChildKeys[${index}]`);
    const match = /^(.*)::(0|[1-9][0-9]*)$/u.exec(key);
    if (match === null || match[1] === undefined || match[1].length === 0) {
      throw new Error(`Smithers inspect data.failedChildKeys[${index}] is not a current task state key`);
    }
    if (!nodeIds.has(match[1])) {
      throw new Error(`Smithers inspect data.failedChildKeys[${index}] does not name a canonical node`);
    }
    requiredCurrentInspectCount(Number(match[2]), `Smithers inspect data.failedChildKeys[${index}] iteration`);
    if (keys.has(key)) {
      throw new Error(`Smithers inspect data.failedChildKeys[${index}] duplicates an earlier key`);
    }
    keys.add(key);
  }
  return [...keys];
}

function assertCurrentInspectObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  label: string
): void {
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing current required fields: ${missing.join(", ")}`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains fields outside the pinned 0.34.0 shape: ${unknown.join(", ")}`);
  }
}

function requiredCurrentInspectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredCurrentInspectCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requiredCurrentInspectEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is not a current supported value`);
  }
  return value as Values[number];
}

/**
 * Dependency attempt ids whose verified artifacts no longer match their verification marker.
 * The message is emitted by the generated workflow's own `assertVerifiedDependency`, so the shape
 * is stable, and it is the only signal that reaches the resume side: the failure lands on the
 * dependent's `prepare:` task and leaves no failed node behind, so the run row's `error_json` is
 * where it surfaces. Recovery on top of this is tracked separately in #288.
 */
export function smithersSnapshotUnverifiedDependencies(snapshot: SmithersCommandSnapshot): string[] {
  const evidence = [
    snapshot.stdout,
    snapshot.stderr,
    snapshot.error ?? "",
    snapshot.json === undefined ? "" : JSON.stringify(snapshot.json)
  ].join("\n");
  const dependencies = new Set<string>();
  for (const match of evidence.matchAll(
    /artifact dependency has not passed verification ([A-Za-z0-9._-]+) for [A-Za-z0-9._-]+/gu
  )) {
    const dependency = match[1];
    if (dependency !== undefined && dependency.trim() !== "" && !dependency.includes("..")) {
      dependencies.add(dependency);
    }
  }
  return [...dependencies].sort();
}

function isCompatibleSmithersRunId(value: string): boolean {
  return /^[a-z0-9_-]{1,64}$/u.test(value);
}

function resetNodeMarkerMatches(markerPath: string | undefined, smithersRunId: string, nodeId: string): boolean {
  if (markerPath === undefined) return false;
  try {
    fs.lstatSync(markerPath);
  } catch (error) {
    if (isCausalEnoent(error)) return false;
    throw error;
  }
  const parsed = parseRuntimeDocumentBytes(
    SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
    readRegularFileSnapshot(markerPath, 64 * 1024),
    "persisted Smithers reset marker"
  );
  if (
    !isObjectRecord(parsed) ||
    !hasExactObjectKeys(parsed, ["schema_version", "smithers_run_id", "node_id", "applied_at"]) ||
    parsed.schema_version !== SMITHERS_RESET_NODE_SCHEMA_VERSION ||
    typeof parsed.smithers_run_id !== "string" ||
    parsed.smithers_run_id.length === 0 ||
    typeof parsed.node_id !== "string" ||
    parsed.node_id.length === 0 ||
    typeof parsed.applied_at !== "string" ||
    !isCanonicalDateTime(parsed.applied_at)
  ) {
    throw new Error("persisted Smithers reset marker does not match the current strict contract");
  }
  return parsed.smithers_run_id === smithersRunId && parsed.node_id === nodeId;
}

function isCausalEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function execSmithersCli(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  keepWorkspaces?: boolean;
  acceptedExitCodes?: readonly number[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; command: string[]; exitCode: number }> {
  const command = [...input.args];
  const executionDeadline = input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs;
  const commandEnvironment = await prepareSmithersExecutableEnvironment(input.projectRoot, input.env, {
    signal: input.signal,
    timeoutMs: input.timeoutMs
  });
  const commandTimeoutMs =
    executionDeadline === undefined ? undefined : Math.max(1, Math.ceil(executionDeadline - Date.now()));
  const { anchored, snapshotAnchor, executableAnchor } = acquireAnchoredSmithersController(command, commandEnvironment);
  try {
    const { stdout, stderr } = await execFileAsync(
      executableAnchor?.executable ?? smithersExecutable(input.projectRoot, anchored.env),
      [...(executableAnchor?.argumentPrefix ?? []), ...anchored.args],
      {
        cwd: input.projectRoot,
        env: smithersCommandEnv(input.projectRoot, anchored.env, input.environmentVariableNames, input.keepWorkspaces),
        maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(commandTimeoutMs === undefined ? {} : { timeout: commandTimeoutMs })
      }
    );
    return { stdout, stderr, command: smithersDisplayCommand(command), exitCode: 0 };
  } catch (error) {
    const record =
      error && typeof error === "object" ? (error as { code?: unknown; stdout?: unknown; stderr?: unknown }) : {};
    if (typeof record.code === "number" && input.acceptedExitCodes?.includes(record.code)) {
      return {
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
        command: smithersDisplayCommand(command),
        exitCode: record.code
      };
    }
    throw error;
  } finally {
    try {
      assertAndCloseSmithersExecutableAnchor(executableAnchor);
    } finally {
      assertAndCloseWorkflowExecutionSnapshotAnchor(snapshotAnchor);
    }
  }
}

function anchoredSmithersControllerInput(
  args: readonly string[],
  env: Record<string, string | undefined> | undefined,
  anchor: WorkflowExecutionSnapshotAnchor | undefined
): { args: string[]; env: Record<string, string | undefined> | undefined } {
  if (anchor === undefined) return { args: [...args], env };
  const anchoredEnv = { ...env };
  for (const [key, value] of Object.entries(anchoredEnv)) {
    // Smithers persists this stable lexical path after proving it resolves to
    // the descriptor-held workflow. Every value it consumes directly is
    // rewritten through the held snapshot descriptor.
    if (value !== undefined && key.toUpperCase() !== ULTRAFUZZ_WORKFLOW_PERSISTED_PATH) {
      anchoredEnv[key] = anchor.rewriteControllerValue(value);
    }
  }
  return {
    args: args.map((argument) => anchor.rewriteControllerValue(argument)),
    env: anchoredEnv
  };
}

function acquireAnchoredSmithersController(
  args: readonly string[],
  env: Record<string, string | undefined> | undefined
): {
  anchored: { args: string[]; env: Record<string, string | undefined> | undefined };
  snapshotAnchor: WorkflowExecutionSnapshotAnchor | undefined;
  executableAnchor: SmithersExecutableAnchor | undefined;
} {
  const snapshotAnchor = acquireWorkflowExecutionSnapshotAnchor(env);
  try {
    snapshotAnchor?.assertCurrent();
    const anchored = anchoredSmithersControllerInput(args, env, snapshotAnchor);
    const executableAnchor = acquireSmithersExecutableAnchor(anchored.env);
    return { anchored, snapshotAnchor, executableAnchor };
  } catch (error) {
    // A failed rewrite or executable acquisition must not retain the directory
    // descriptors that make controller-only /proc paths usable.
    assertAndCloseWorkflowExecutionSnapshotAnchor(snapshotAnchor);
    throw error;
  }
}

function smithersDisplayCommand(command: readonly string[]): string[] {
  return [
    "smithers",
    ...command.map((argument, index) => (command[index - 1] === "--input" ? "<redacted>" : argument))
  ];
}

function supervisorCommandArgs(controllerLeaseSeconds: number): string[] {
  const staleThresholdSeconds = Math.max(1, Math.floor(controllerLeaseSeconds));
  const intervalSeconds = Math.max(1, Math.floor(staleThresholdSeconds / 3));
  return [
    "--supervise",
    "--supervise-interval",
    `${intervalSeconds}s`,
    "--supervise-stale-threshold",
    `${staleThresholdSeconds}s`,
    "--supervise-max-concurrent",
    "1"
  ];
}

function parseForkedRunId(stdout: string): string {
  const payload = commandPayload(jsonField(stdout).json);
  if (typeof payload?.forkedRunId !== "string" || payload.forkedRunId.length === 0) {
    throw new Error("workflow runner fork/replay did not return the current forkedRunId contract");
  }
  return payload.forkedRunId;
}

export function smithersDiagnostic(error: unknown, code: string): RuntimeDiagnostic {
  const record =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          signal?: unknown;
          killed?: unknown;
          stdout?: unknown;
          stderr?: unknown;
        })
      : {};
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = [
    error instanceof Error ? error.message : String(error),
    stdout.trim().length > 0 ? `stdout: ${stdout.trim()}` : "",
    stderr.trim().length > 0 ? `stderr: ${stderr.trim()}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  return {
    code,
    message: sanitizedDiagnosticText(message),
    severity: "error",
    source: "workflow",
    details: {
      ...(typeof record.code === "string" || typeof record.code === "number" ? { exit_code: record.code } : {}),
      ...(typeof record.signal === "string" ? { signal: record.signal } : {}),
      ...(typeof record.killed === "boolean" ? { killed: record.killed } : {}),
      ...(stdout.length > 0 ? { stdout: sanitizedDiagnosticText(stdout) } : {}),
      ...(stderr.length > 0 ? { stderr: sanitizedDiagnosticText(stderr) } : {})
    }
  };
}

function sanitizedDiagnosticText(value: string): string {
  return truncateDiagnosticText(scrubWorkflowRunnerText(redactSecretsInText(value)));
}

function redactedEvidenceText(value: string): string {
  const redacted = redactSecretsInText(value);
  const limit = SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS;
  return redacted.length > limit
    ? `${redacted.slice(0, limit)}\n[truncated ${redacted.length - limit} characters]`
    : redacted;
}

function scrubWorkflowRunnerText(value: string): string {
  return value.replace(/smithers/giu, "workflow runner");
}

function truncateDiagnosticText(value: string): string {
  const limit = 12000;
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated ${value.length - limit} bytes]` : value;
}

async function prepareSmithersExecutableEnvironment(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  control: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Record<string, string | undefined> | undefined> {
  // A linked run already carries a non-forgeable capability for the executable
  // copied into its sealed dependency closure. Do not consult, patch, or
  // reinstall the mutable project-owned runner tree before honoring it.
  if (smithersExecutableCapability(env) !== undefined) {
    return env;
  }
  await ensureSmithersDependencies(projectRoot, env, control);
  if (explicitSmithersExecutable(env) !== undefined) {
    return env;
  }
  const local = localSmithersExecutable(projectRoot);
  if (!fs.existsSync(local)) return env;

  // Dependency verification above pins the package version, validates the
  // command shim, and applies every compatibility patch before this authority
  // is granted. Execute the package's real script rather than attesting a
  // platform-specific .bin shim, which also keeps the capability portable to
  // Windows where the shim is a command file without a shebang.
  const packageRoot = resolveInstalledSmithersPackageRoot(projectRoot);
  const executable = path.join(packageRoot, ...SMITHERS_BIN_PATH.split("/"));
  return bindSmithersExecutableCapability({ ...(env ?? {}) }, executable);
}

async function ensureSmithersDependencies(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  control: { signal?: AbortSignal; timeoutMs?: number; requirePinnedRunner?: boolean } = {}
): Promise<void> {
  if (explicitSmithersExecutable(env) !== undefined && control.requirePinnedRunner !== true) {
    return;
  }
  const packageRoot = path.join(projectRoot, ".smithers");
  const packageJson = path.join(packageRoot, "package.json");
  const local = localSmithersExecutable(projectRoot);
  if (!fs.existsSync(packageJson)) {
    if (fs.existsSync(local)) {
      throw new Error("local workflow runner requires a generated dependency manifest");
    }
    return;
  }
  assertNoSymlinkComponents(projectRoot, packageRoot, "Smithers package");
  assertNoSymlinkComponents(projectRoot, packageJson, "Smithers package manifest");
  const parsedManifest = readPackageManagerOwnedManifestEnvelope(packageJson, "generated Smithers package manifest");
  assertSmithersPackageManifest(parsedManifest);
  const nodeModules = path.join(packageRoot, "node_modules");
  if (fs.existsSync(nodeModules)) {
    assertNoSymlinkComponents(projectRoot, nodeModules, "Smithers dependencies");
  }
  const installedPackageRoot = installedSmithersPackageRoot(projectRoot);
  if (fs.existsSync(installedPackageRoot)) {
    resolveInstalledSmithersPackageRoot(projectRoot);
  }
  let repairCause: unknown;
  if (installedSmithersValidationError(projectRoot) === undefined) {
    try {
      applySmithersCompatibilityPatches(projectRoot);
      return;
    } catch (error) {
      // `installedSmithersValidationError` only inspects the top-level runner, so
      // a half-reified tree passes it and then fails to patch: an interrupted
      // upgrade install can leave the new top-level runner beside stale or
      // missing `@smthrs/*` packages. Reinstalling repairs that;
      // returning here would make every later resume of a durable run fail
      // identically with no way back short of deleting `.smithers/node_modules`
      // by hand. Repair once per project root per process: when the source shape
      // genuinely no longer matches, reinstalling cannot help, and every
      // subsequent engine command would otherwise pay a full install before
      // failing the same way.
      if (repairedSmithersInstalls.has(packageRoot)) {
        throw error;
      }
      repairedSmithersInstalls.add(packageRoot);
      repairCause = error;
    }
  }
  await withTransientNpmRegistryRetry(
    () =>
      execFileAsync(
        "npm",
        smithersDependencyInstallArgs({ prefix: packageRoot, registry: "https://registry.npmjs.org" }),
        {
          cwd: projectRoot,
          env: smithersCommandEnv(projectRoot, env),
          maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES,
          ...(control.signal === undefined ? {} : { signal: control.signal }),
          ...(control.timeoutMs === undefined ? {} : { timeout: control.timeoutMs })
        }
      ),
    control.signal === undefined ? {} : { signal: control.signal }
  );
  const validationError = installedSmithersValidationError(projectRoot);
  if (validationError !== undefined) {
    throw new Error(
      `Smithers dependency install did not produce the pinned local workflow runner: ${validationError}`,
      {
        ...(repairCause === undefined ? {} : { cause: repairCause })
      }
    );
  }
  try {
    applySmithersCompatibilityPatches(projectRoot);
  } catch (error) {
    // Surface what the pre-install attempt saw. Without it a reinstall that cannot
    // fix the tree reports only its second-hand symptom, losing the specific reason
    // the seeded dependencies were unusable.
    if (repairCause !== undefined && error instanceof Error && error.cause === undefined) {
      error.cause = repairCause;
    }
    throw error;
  }
}

// Project roots this process has already tried to repair by reinstalling, so a
// permanently unpatchable tree fails fast instead of reinstalling on every command.
const repairedSmithersInstalls = new Set<string>();

function applySmithersCompatibilityPatches(projectRoot: string): void {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const cliRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/cli");
  const schedulerRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/scheduler");
  const engineRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/engine");
  // Unit-test installers intentionally provide only the public runner shim, so a
  // tree with none of these packages is tolerated. A registry installation always
  // carries all three, so a tree holding some but not all of them is a broken
  // install: fail instead of silently skipping the resume-durability patches and
  // letting the run proceed unpatched. The caller repairs this by reinstalling.
  if (cliRoots.length === 0 && schedulerRoots.length === 0 && engineRoots.length === 0) return;
  if (cliRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete CLI implementation");
  }
  if (schedulerRoots.length !== 1 || engineRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete resume implementation");
  }
  const packageRoot = cliRoots[0]!;
  const packageJson = path.join(packageRoot, "package.json");
  const cliSource = path.join(packageRoot, "src", "index.js");
  const resumeDetachedSource = path.join(packageRoot, "src", "resume-detached.js");
  assertRegularFileInside(nodeModules, packageJson, "installed Smithers CLI package metadata");
  assertRegularFileInside(nodeModules, cliSource, "installed Smithers CLI implementation");
  assertRegularFileInside(nodeModules, resumeDetachedSource, "installed Smithers detached resume implementation");
  const metadata = readPackageManagerOwnedManifestEnvelope(packageJson, "installed Smithers CLI package manifest");
  if (optionalPackageManifestString(metadata, "version", packageJson) !== SMITHERS_VERSION) {
    throw new Error(`installed Smithers CLI package version must be ${SMITHERS_VERSION}`);
  }
  let cliContents = fs.readFileSync(cliSource, "utf8");
  for (const [source, patched, label] of [
    [
      SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_SOURCE,
      SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_PATCH,
      "detached engine execution snapshot transfer"
    ],
    [SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE, SMITHERS_CLI_SUPERVISOR_SPAWN_PATCH, "detached supervisor"],
    [SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE, SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH, "workflow path import"],
    [SMITHERS_CLI_WORKFLOW_PATH_SOURCE, SMITHERS_CLI_WORKFLOW_PATH_PATCH, "workflow path validation"],
    [
      SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_SOURCE,
      SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PATCH,
      "process-owned execution snapshot"
    ],
    [SMITHERS_CLI_POST_FAILURE_PATH_SOURCE, SMITHERS_CLI_POST_FAILURE_PATH_PATCH, "post-failure workflow path"],
    [SMITHERS_CLI_REPLAY_WORKFLOW_PATH_SOURCE, SMITHERS_CLI_REPLAY_WORKFLOW_PATH_PATCH, "replay workflow path"],
    [
      SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_SOURCE,
      SMITHERS_CLI_REPLAY_WORKFLOW_METADATA_PATCH,
      "replay workflow metadata"
    ],
    [SMITHERS_CLI_FORK_WORKFLOW_PATH_SOURCE, SMITHERS_CLI_FORK_WORKFLOW_PATH_PATCH, "fork workflow path"],
    [SMITHERS_CLI_FORK_WORKFLOW_METADATA_SOURCE, SMITHERS_CLI_FORK_WORKFLOW_METADATA_PATCH, "fork workflow metadata"]
  ] as const) {
    cliContents = applyRequiredSmithersPatch(cliContents, source, patched, label);
  }
  writeFileDurable(cliSource, cliContents);
  const resumeDetachedContents = fs.readFileSync(resumeDetachedSource, "utf8");
  writeFileDurable(
    resumeDetachedSource,
    applyRequiredSmithersPatch(
      resumeDetachedContents,
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_SOURCE,
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PATCH,
      "detached resume execution snapshot transfer"
    )
  );

  const schedulerRoot = schedulerRoots[0]!;
  const engineRoot = engineRoots[0]!;
  const schedulerPackageJson = path.join(schedulerRoot, "package.json");
  const enginePackageJson = path.join(engineRoot, "package.json");
  const schedulerSource = path.join(schedulerRoot, "src", "makeWorkflowSession.js");
  const engineSource = path.join(engineRoot, "src", "engine.js");
  const engineWorkflowHashSource = path.join(engineRoot, "src", "workflow-hash.js");
  for (const [label, dependencyPackageJson, dependencySource] of [
    ["scheduler", schedulerPackageJson, schedulerSource],
    ["engine", enginePackageJson, engineSource]
  ] as const) {
    assertRegularFileInside(nodeModules, dependencyPackageJson, `installed Smithers ${label} package metadata`);
    assertRegularFileInside(nodeModules, dependencySource, `installed Smithers ${label} implementation`);
    const dependencyMetadata = readPackageManagerOwnedManifestEnvelope(
      dependencyPackageJson,
      `installed Smithers ${label} package manifest`
    );
    if (optionalPackageManifestString(dependencyMetadata, "version", dependencyPackageJson) !== SMITHERS_VERSION) {
      throw new Error(`installed Smithers ${label} package version must be ${SMITHERS_VERSION}`);
    }
  }
  assertRegularFileInside(nodeModules, engineWorkflowHashSource, "installed Smithers workflow hash implementation");

  const schedulerContents = fs.readFileSync(schedulerSource, "utf8");
  writeFileDurable(
    schedulerSource,
    applyRequiredSmithersPatch(
      schedulerContents,
      SMITHERS_SCHEDULER_TERMINAL_RESTORE_SOURCE,
      SMITHERS_SCHEDULER_TERMINAL_RESTORE_PATCH,
      "terminal-state restoration"
    )
  );

  let workflowHashContents = fs.readFileSync(engineWorkflowHashSource, "utf8");
  for (const [source, patched, label] of [
    [SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_SOURCE, SMITHERS_ENGINE_WORKFLOW_HASH_IMPORT_PATCH, "workflow hash import"],
    [SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_SOURCE, SMITHERS_ENGINE_WORKFLOW_HASH_COLLECT_PATCH, "workflow hash paths"],
    [SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_SOURCE, SMITHERS_ENGINE_WORKFLOW_HASH_ENTRY_PATCH, "workflow hash identity"],
    [
      SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_SOURCE,
      SMITHERS_ENGINE_WORKFLOW_HASH_RECURSION_PATCH,
      "workflow hash recursion"
    ],
    [SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_SOURCE, SMITHERS_ENGINE_WORKFLOW_HASH_PUBLIC_PATCH, "workflow hash API"]
  ] as const) {
    workflowHashContents = applyRequiredSmithersPatch(workflowHashContents, source, patched, label);
  }
  writeFileDurable(engineWorkflowHashSource, workflowHashContents);

  let engineContents = fs.readFileSync(engineSource, "utf8");
  for (const [source, patched, label] of [
    [SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_WORKFLOW_PATH_PATCH, "anchored workflow paths"],
    [
      SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE,
      SMITHERS_ENGINE_DURABILITY_METADATA_PATCH,
      "workflow durability hash identity"
    ],
    [SMITHERS_ENGINE_RUN_METADATA_SOURCE, SMITHERS_ENGINE_RUN_METADATA_PATCH, "workflow durability metadata"],
    [SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE, SMITHERS_ENGINE_RESUME_IDENTITY_PATCH, "resume workflow identity"],
    [SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH, "inserted workflow path"],
    [
      SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_SOURCE,
      SMITHERS_ENGINE_ACTIVATE_WORKFLOW_PATH_PATCH,
      "resumed workflow path"
    ],
    [SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_UPDATE_WORKFLOW_PATH_PATCH, "updated workflow path"],
    [
      SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_SOURCE,
      SMITHERS_ENGINE_CONTINUATION_WORKFLOW_PATH_PATCH,
      "continued workflow path"
    ],
    [SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE, SMITHERS_ENGINE_RESUME_HYDRATION_PATCH, "resume hydration"]
  ] as const) {
    engineContents = applyRequiredSmithersPatch(engineContents, source, patched, label);
  }
  for (const required of SMITHERS_REQUIRED_ENGINE_ANCHORS) {
    if (!engineContents.includes(required.anchor)) {
      throw new Error(`pinned workflow runner ${required.id.replaceAll("_", " ")} is incompatible`);
    }
  }
  writeFileDurable(engineSource, engineContents);
}

function applyRequiredSmithersPatch(contents: string, source: string, patched: string, label: string): string {
  if (contents.includes(patched)) return contents;
  if (contents.split(source).length !== 2) {
    throw new Error(`pinned workflow runner ${label} implementation is incompatible`);
  }
  return contents.replace(source, patched);
}

function installedSmithersValidationError(projectRoot: string): string | undefined {
  const linkedPackageRoot = installedSmithersPackageRoot(projectRoot);
  const local = localSmithersExecutable(projectRoot);
  try {
    if (!fs.existsSync(linkedPackageRoot)) {
      return "installed package metadata is missing";
    }
    const packageRoot = resolveInstalledSmithersPackageRoot(projectRoot);
    const packageJson = path.join(packageRoot, "package.json");
    const expectedBin = path.join(packageRoot, ...SMITHERS_BIN_PATH.split("/"));
    const expectedLinkedBin = path.join(linkedPackageRoot, ...SMITHERS_BIN_PATH.split("/"));
    if (!fs.existsSync(packageJson)) {
      return "installed package metadata is missing";
    }
    assertRegularFileInside(packageRoot, packageJson, "installed Smithers package metadata");
    const metadata = readPackageManagerOwnedManifestEnvelope(packageJson, "installed Smithers package manifest");
    if (optionalPackageManifestString(metadata, "version", packageJson) !== SMITHERS_VERSION) {
      return `installed package version must be ${SMITHERS_VERSION}`;
    }
    const bin = optionalPackageManifestBin(metadata, packageJson);
    if (typeof bin !== "object" || bin === null || !isExpectedSmithersBinTarget(bin.smithers)) {
      return "installed package metadata has an unexpected workflow runner target";
    }
    assertRegularFileInside(packageRoot, expectedBin, "installed Smithers workflow runner");
    if (!fs.existsSync(local)) {
      return "local workflow runner binary is missing";
    }
    assertNoSymlinkComponents(projectRoot, path.dirname(local), "Smithers binary directory");
    const shim = fs.lstatSync(local);
    if (process.platform === "win32") {
      if (!shim.isFile()) {
        return "local workflow runner command shim is not a regular file";
      }
      const expectedReference = path.relative(path.dirname(local), expectedBin).toLowerCase();
      const contents = fs.readFileSync(local, "utf8").replaceAll("/", "\\").toLowerCase();
      if (!contents.includes(expectedReference)) {
        return "local workflow runner command shim has an unexpected target";
      }
    } else if (shim.isSymbolicLink()) {
      if (fs.realpathSync(local) !== fs.realpathSync(expectedBin)) {
        return "local workflow runner binary has an unexpected target";
      }
    } else if (shim.isFile()) {
      assertRegularFileInside(path.dirname(local), local, "local Smithers workflow runner shim");
      const expectedReference = path.relative(path.dirname(local), expectedLinkedBin);
      const contents = fs.readFileSync(local, "utf8").replaceAll("\\", "/");
      if (!contents.includes(expectedReference.replaceAll("\\", "/"))) {
        return "local workflow runner command shim has an unexpected target";
      }
    } else {
      return "local workflow runner command shim is not a regular file or package-manager symlink";
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isExpectedSmithersBinTarget(value: unknown): boolean {
  return value === SMITHERS_BIN_PATH || value === `./${SMITHERS_BIN_PATH}`;
}

/**
 * `package.json` is an open package-manager-owned envelope, not an Ultrafuzz
 * durable document. Capture and strictly parse one bounded immutable snapshot,
 * then let each caller project only the package-manager fields it consumes.
 */
function readPackageManagerOwnedManifestEnvelope(
  packageJsonPath: string,
  label: string
): Readonly<Record<string, unknown>> {
  const value = parseStrictJsonBytes(readRegularFileSnapshot(packageJsonPath, MAX_PACKAGE_MANAGER_MANIFEST_BYTES), {
    maxBytes: MAX_PACKAGE_MANAGER_MANIFEST_BYTES,
    maxDepth: MAX_PACKAGE_MANAGER_MANIFEST_DEPTH,
    maxItems: MAX_PACKAGE_MANAGER_MANIFEST_ITEMS,
    maxProperties: MAX_PACKAGE_MANAGER_MANIFEST_PROPERTIES
  });
  if (!isObjectRecord(value)) throw new Error(`${label} must be a JSON object: ${packageJsonPath}`);
  return value;
}

function optionalPackageManifestString(
  manifest: Readonly<Record<string, unknown>>,
  key: string,
  packageJsonPath: string
): string | undefined {
  const value = manifest[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`package-manager manifest ${key} must be a non-empty string: ${packageJsonPath}`);
  }
  return value;
}

function optionalPackageManifestBin(
  manifest: Readonly<Record<string, unknown>>,
  packageJsonPath: string
): string | Readonly<Record<string, string>> | undefined {
  const value = manifest.bin;
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(`package-manager manifest bin must be a non-empty string: ${packageJsonPath}`);
    }
    return value;
  }
  return packageManifestStringMap(value, "bin", packageJsonPath);
}

function projectOptionalPackageManifestString<Key extends "name" | "version">(
  manifest: Readonly<Record<string, unknown>>,
  key: Key,
  packageJsonPath: string
): Partial<Pick<WorkflowPackageManifest, Key>> {
  const value = optionalPackageManifestString(manifest, key, packageJsonPath);
  return value === undefined ? {} : ({ [key]: value } as Pick<WorkflowPackageManifest, Key>);
}

function projectOptionalPackageManifestBin(
  manifest: Readonly<Record<string, unknown>>,
  packageJsonPath: string
): Pick<WorkflowPackageManifest, "bin"> | Record<never, never> {
  const value = optionalPackageManifestBin(manifest, packageJsonPath);
  return value === undefined ? {} : { bin: value };
}

function projectOptionalPackageManifestStringMap<
  Key extends "dependencies" | "optionalDependencies" | "peerDependencies"
>(
  manifest: Readonly<Record<string, unknown>>,
  key: Key,
  packageJsonPath: string
): Partial<Pick<WorkflowPackageManifest, Key>> {
  const value = manifest[key];
  if (value === undefined) return {};
  return { [key]: packageManifestStringMap(value, key, packageJsonPath) } as Pick<WorkflowPackageManifest, Key>;
}

function packageManifestStringMap(
  value: unknown,
  field: string,
  packageJsonPath: string
): Readonly<Record<string, string>> {
  if (!isObjectRecord(value)) {
    throw new Error(`package-manager manifest ${field} must be an object: ${packageJsonPath}`);
  }
  const projected = nullPrototypeRecord<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`package-manager manifest ${field}.${key} must be a non-empty string: ${packageJsonPath}`);
    }
    defineProjectedPackageManifestField(projected, key, entry);
  }
  return projected;
}

function projectOptionalPackageManifestPeerMetadata(
  manifest: Readonly<Record<string, unknown>>,
  packageJsonPath: string
): Pick<WorkflowPackageManifest, "peerDependenciesMeta"> | Record<never, never> {
  const value = manifest.peerDependenciesMeta;
  if (value === undefined) return {};
  if (!isObjectRecord(value)) {
    throw new Error(`package-manager manifest peerDependenciesMeta must be an object: ${packageJsonPath}`);
  }
  const projected = nullPrototypeRecord<Readonly<{ optional?: boolean }>>();
  for (const [key, entry] of Object.entries(value)) {
    if (!isObjectRecord(entry)) {
      throw new Error(`package-manager manifest peerDependenciesMeta.${key} must be an object: ${packageJsonPath}`);
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      throw new Error(
        `package-manager manifest peerDependenciesMeta.${key}.optional must be a boolean: ${packageJsonPath}`
      );
    }
    defineProjectedPackageManifestField(
      projected,
      key,
      entry.optional === undefined ? {} : { optional: entry.optional }
    );
  }
  return { peerDependenciesMeta: projected };
}

function nullPrototypeRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function defineProjectedPackageManifestField<Value>(target: Record<string, Value>, key: string, value: Value): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false
  });
}

function installedSmithersPackageRoot(projectRoot: string): string {
  return path.join(projectRoot, ".smithers", "node_modules", "smthrs");
}

function resolveInstalledSmithersPackageRoot(projectRoot: string): string {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const packageRoot = installedSmithersPackageRoot(projectRoot);
  assertNoSymlinkComponents(projectRoot, nodeModules, "Smithers dependencies");
  const realNodeModules = fs.realpathSync(nodeModules);
  const realPackageRoot = fs.realpathSync(packageRoot);
  assertPathInside(realNodeModules, realPackageRoot, "installed Smithers package");
  return realPackageRoot;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function isCanonicalDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertAndCloseSmithersExecutableAnchor(anchor: SmithersExecutableAnchor | undefined): void {
  if (anchor === undefined) return;
  try {
    anchor.assertCurrent();
  } finally {
    anchor.close();
  }
}

function assertAndCloseWorkflowExecutionSnapshotAnchor(anchor: WorkflowExecutionSnapshotAnchor | undefined): void {
  if (anchor === undefined) return;
  try {
    anchor.assertCurrent();
  } finally {
    anchor.close();
  }
}

function smithersExecutable(projectRoot: string, env: Record<string, string | undefined> | undefined): string {
  const explicit = explicitSmithersExecutable(env);
  if (explicit !== undefined) {
    return explicit;
  }
  const local = localSmithersExecutable(projectRoot);
  if (fs.existsSync(local)) {
    return local;
  }
  return "smithers";
}

function explicitSmithersExecutable(env: Record<string, string | undefined> | undefined): string | undefined {
  const explicit = env?.SMITHERS_BIN ?? process.env.SMITHERS_BIN;
  return explicit && explicit.trim().length > 0 ? explicit : undefined;
}

function localSmithersExecutable(projectRoot: string): string {
  return path.join(projectRoot, ".smithers", "node_modules", ".bin", smithersBinaryName());
}

function smithersCommandEnv(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  environmentVariableNames: readonly string[] = [],
  keepWorkspaces?: boolean
): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = { ...process.env, ...(env ?? {}) };
  source.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS;
  if (keepWorkspaces !== undefined) {
    source.SMITHERS_KEEP_WORKTREES = keepWorkspaces ? "1" : undefined;
  }
  const forwarded = new Set(environmentVariableNames.map((name) => name.toUpperCase()));
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "PATH") {
      continue;
    }
    if (
      value !== undefined &&
      (SMITHERS_BASE_ENVIRONMENT_VARIABLES.has(normalizedKey) ||
        (normalizedKey.startsWith("SMITHERS_") &&
          !SMITHERS_EXECUTION_CONTEXT_ENVIRONMENT_VARIABLES.has(normalizedKey)) ||
        forwarded.has(normalizedKey))
    ) {
      merged[key] = value;
    }
  }
  merged.PATH = composeSmithersCommandPath(projectRoot, source);
  return merged;
}

export function composeSmithersCommandPath(
  projectRoot: string,
  source: Readonly<Record<string, string | undefined>>
): string {
  const trustedBin = source[ULTRAFUZZ_TRUSTED_BIN_ENV];
  const localBin = path.join(projectRoot, ".smithers", "node_modules", ".bin");
  // Preserve the caller's PATH representation for workflow-engine compatibility,
  // while keeping the authenticated CLI and project-local Smithers binaries first.
  // Required-command preflight intentionally accepts only stable absolute entries,
  // because task commands execute from fresh worktrees rather than this checkout.
  return [trustedBin, localBin, source.PATH]
    .filter((entry): entry is string => typeof entry === "string")
    .join(path.delimiter);
}

function smithersBinaryName(): string {
  return process.platform === "win32" ? "smithers.cmd" : "smithers";
}

function compileTask(input: {
  config: ResolvedConfig;
  graph: ExpandedGraph;
  node: ExpandedNode;
  attempt: NodeAttemptProvenance;
  runLayout: RunLayout;
  workflowName: string;
  renderedPromptPath?: string;
  dependencyAttemptIds: readonly string[];
  dependencyAgenticAttemptIds: readonly string[];
  artifactDependencyAttemptIds: readonly string[];
}): CompiledSmithersTask {
  const profile = modelProfileFor(input.config, input.attempt);
  const timeoutMs =
    (input.node.timeoutSeconds ?? profile.timeoutSeconds ?? input.config.run.defaultTimeoutSeconds) * 1000;
  assertInvariantCampaignTimeoutBudget(input, timeoutMs);
  // Agent subprocesses can spend long stretches inside a provider request where
  // Smithers cannot emit a useful task heartbeat. Keep the watchdog aligned with
  // the configured node deadline so it does not silently replace a longer node
  // timeout with the old ten-minute cap.
  const heartbeatTimeoutMs = timeoutMs;
  const retries = Math.max(0, input.node.retryPolicy.maxAttempts - 1);
  const artifactDir = getNodeArtifactDir(input.runLayout, input.attempt.attemptId, { create: true });
  const workspacePath = getNodeWorkspaceDir(input.runLayout, input.attempt.attemptId);
  const dependencyArtifactDirs = input.artifactDependencyAttemptIds.map((attemptId) =>
    getNodeArtifactDir(input.runLayout, attemptId, { create: true })
  );
  const dependencySmithersNodeIds = input.dependencyAgenticAttemptIds.map(verifierSmithersNodeIdForAttempt);
  const executionResources = resolveExecutionResources(input.config, input.node.logicalId);
  const agent = input.config.agents[profile.agent];
  const agentCredentialEnv = cloudAgentCredentialEnv(input.config.execution.mode, profile.agent, agent);
  const execution = {
    mode: input.config.execution.mode,
    ...(input.config.execution.provider === undefined ? {} : { provider: input.config.execution.provider }),
    resources: executionResources,
    ...(input.config.execution.providers.modal === undefined
      ? {}
      : {
          modal: {
            ...input.config.execution.providers.modal,
            credentialEnv: [...input.config.execution.providers.modal.credentialEnv]
          }
        }),
    agentCredentialEnv
  } satisfies CompiledSmithersTask["execution"];
  const metadata: SmithersTaskMetadata = {
    schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
    run: {
      ultrafuzzRunId: input.runLayout.runId,
      smithersWorkflowName: input.workflowName,
      graphVersion: input.graph.graphVersion,
      topologyVersion: input.graph.topologyVersion
    },
    node: {
      concreteNodeId: input.node.id,
      logicalNodeId: input.node.logicalId,
      attemptId: input.attempt.attemptId,
      label: input.node.label,
      kind: "agentic",
      ...(input.node.promptPath ? { promptPath: input.node.promptPath } : {}),
      ...(input.node.group ? { group: input.node.group } : {})
    },
    dependencies: {
      concreteNodeIds: [...input.node.dependsOn],
      attemptIds: [...input.dependencyAttemptIds],
      smithersNodeIds: dependencySmithersNodeIds
    },
    loop: {
      index: input.node.loop.index,
      count: input.node.loop.count,
      mode: input.node.loop.mode,
      attemptIndex: input.node.loop.attemptIndex
    },
    model: {
      profileId: profile.id,
      agentRef: profile.agent,
      ...(profile.model ? { modelName: profile.model } : {}),
      ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {}),
      modelIndex: input.attempt.modelIndex,
      attemptIndex: input.attempt.attemptIndex
    },
    workspace: {
      primitive: "worktree",
      path: workspacePath,
      repoPath: input.config.project.repo,
      trustModel: input.config.permissions.trustModel
    },
    artifacts: {
      dir: artifactDir,
      outputs: input.node.outputs,
      manifestPath: path.join(artifactDir, "artifact-manifest.json")
    },
    retryPolicy: {
      maxAttempts: input.node.retryPolicy.maxAttempts,
      smithersRetries: retries
    },
    timeout: {
      milliseconds: timeoutMs,
      seconds: Math.ceil(timeoutMs / 1000),
      heartbeatTimeoutMs
    },
    execution: {
      mode: execution.mode,
      ...(execution.provider === undefined ? {} : { provider: execution.provider }),
      resources: execution.resources
    }
  };
  return {
    attemptId: input.attempt.attemptId,
    concreteNodeId: input.node.id,
    logicalNodeId: input.node.logicalId,
    preparationSmithersNodeId: `prepare:${input.attempt.attemptId}`,
    smithersNodeId: smithersNodeIdForAttempt(input.attempt.attemptId),
    verifierSmithersNodeId: verifierSmithersNodeIdForAttempt(input.attempt.attemptId),
    agentRef: profile.agent,
    ...(profile.model ? { modelName: profile.model } : {}),
    ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {}),
    dependencies: [...input.dependencyAttemptIds],
    dependencySmithersNodeIds,
    timeoutMs,
    heartbeatTimeoutMs,
    retries,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    ...(input.renderedPromptPath ? { renderedPromptPath: input.renderedPromptPath } : {}),
    execution,
    metadata
  };
}

const INVARIANT_CAMPAIGN_HOST_SHUTDOWN_GRACE_SECONDS = 300;
const INVARIANT_CAMPAIGN_ROLE_CONTRACTS = new Set([
  "ultrafuzz/invariant-campaign-plan@2",
  "ultrafuzz/property-campaign@3",
  "ultrafuzz/campaign-summary@2"
]);

function assertInvariantCampaignTimeoutBudget(
  input: {
    config: ResolvedConfig;
    node: ExpandedNode;
  },
  timeoutMs: number
): void {
  if (!input.node.outputs.some((output) => output.contract === "ultrafuzz/invariant-campaign-plan@2")) {
    return;
  }
  const runtimeBudget = topologyRuntimeBudgetForTimeout(timeoutMs);
  const smokeTimeoutSeconds = input.config.invariants.invariantTestingSmokeTimeoutSeconds;
  const fuzzerTimeoutSeconds = input.config.invariants.invariantTestingFuzzerTimeoutSeconds;
  const requiredSeconds =
    smokeTimeoutSeconds +
    fuzzerTimeoutSeconds +
    INVARIANT_CAMPAIGN_HOST_SHUTDOWN_GRACE_SECONDS +
    runtimeBudget.finalizationReserveSeconds;
  if (runtimeBudget.timeoutSeconds >= requiredSeconds) {
    return;
  }
  throw new Error(
    `INVARIANT_CAMPAIGN_TIMEOUT_BUDGET_EXCEEDED: logical_node_id=${input.node.logicalId} ` +
      `node_timeout_seconds=${runtimeBudget.timeoutSeconds} is smaller than required_seconds=${requiredSeconds} ` +
      `(smoke_timeout_seconds=${smokeTimeoutSeconds} + fuzzer_timeout_seconds=${fuzzerTimeoutSeconds} + ` +
      `host_shutdown_grace_seconds=${INVARIANT_CAMPAIGN_HOST_SHUTDOWN_GRACE_SECONDS} + ` +
      `artifact_finalization_reserve_seconds=${runtimeBudget.finalizationReserveSeconds}). ` +
      `Increase the campaign node or group timeout_seconds to at least ${requiredSeconds}, or lower the invariant timeouts.`
  );
}

function cloudAgentCredentialEnv(
  executionMode: ResolvedConfig["execution"]["mode"],
  agentRef: string,
  agent: ResolvedConfig["agents"][string] | undefined
): string[] {
  if (executionMode !== "cloud" || agent?.auth !== "api-key" || agent.apiKeyEnv === undefined) return [];
  const names = [agent.apiKeyEnv];
  if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY", "KIMI_BASE_URL");
  return names;
}

function artifactAncestorNodeIds(nodeId: string, nodes: readonly ExpandedNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set<string>();
  const pending = [...(byId.get(nodeId)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    pending.push(...(byId.get(candidate)?.dependsOn ?? []));
  }
  return [...ancestors].sort();
}

function nodeAttemptsFor(node: ExpandedNode): NodeAttemptProvenance[] {
  if (node.modelFanout.length === 0) {
    return [
      {
        attemptId: stableBaseAttemptId(node.id),
        concreteNodeId: node.id,
        logicalNodeId: node.logicalId,
        attemptIndex: node.loop.attemptIndex,
        modelIndex: 0
      }
    ];
  }
  return node.modelFanout.map((model) => ({
    attemptId: stableAttemptId(node, model),
    concreteNodeId: node.id,
    logicalNodeId: node.logicalId,
    attemptIndex: model.attemptIndex,
    modelIndex: model.modelIndex,
    model
  }));
}

function stableAttemptId(node: ExpandedNode, model: ModelFanoutProvenance): string {
  const baseId = stableBaseAttemptId(node.id);
  if (node.modelFanout.length <= 1) {
    return baseId;
  }
  return `${baseId}__model_${model.modelIndex}__attempt_${model.attemptIndex}`;
}

function stableBaseAttemptId(concreteNodeId: string): string {
  if (concreteNodeId === "__start__") return "meta-start";
  if (concreteNodeId === "__finish__") return "meta-finish";
  return concreteNodeId;
}

function smithersNodeIdForAttempt(attemptId: string): string {
  return `node:${attemptId}`;
}

function verifierSmithersNodeIdForAttempt(attemptId: string): string {
  return `verify:${attemptId}`;
}

function inferProjectRootFromRunLayout(runLayout: RunLayout): string {
  const marker = `${path.sep}.ultrafuzz${path.sep}runs${path.sep}`;
  const root = path.resolve(runLayout.root);
  const markerIndex = root.lastIndexOf(marker);
  if (markerIndex > 0) {
    return root.slice(0, markerIndex);
  }
  return path.resolve(runLayout.root, "..", "..", "..");
}

function workflowFileStem(runId: string): string {
  const stem = `ultrafuzz-${runId}`;
  if (!isCompatibleSmithersRunId(stem)) {
    throw new Error(
      `run ID ${JSON.stringify(runId)} does not produce a current Smithers workflow name matching ^[a-z0-9_-]{1,64}$`
    );
  }
  return stem;
}

function writePreparedWorkflowFile(root: string, filePath: string, contents: string | Uint8Array, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(filePath);
  const contentsBytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  assertPathInside(resolvedRoot, resolvedPath, label);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  assertNoSymlinkComponents(resolvedRoot, resolvedPath, label);
  if (fs.existsSync(resolvedPath)) {
    assertRegularFileInside(resolvedRoot, resolvedPath, label);
    if (!fs.readFileSync(resolvedPath).equals(contentsBytes)) {
      throw new Error(`existing ${label} conflicts with the prepared workflow start`);
    }
    return;
  }
  writeFileDurable(resolvedPath, contentsBytes);
  assertRegularFileInside(resolvedRoot, resolvedPath, label);
  if (!fs.readFileSync(resolvedPath).equals(contentsBytes)) {
    throw new Error(`${label} changed while the prepared workflow start was written`);
  }
}

function renderEvidenceWorkflowSource(workflowPath: string, evidenceWorkflowPath: string): string {
  return renderRuntimeTemplate("smithers/workflows/evidence.tsx", {
    __ULTRAFUZZ_WORKFLOW_IMPORT__: JSON.stringify(
      importPathBetween(path.dirname(evidenceWorkflowPath), workflowPath)
    ).slice(1, -1)
  });
}

function importPathBetween(fromDir: string, toFile: string): string {
  let relative = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative.replace(/\.tsx$/u, "");
}

function jsonField(stdout: string): { json?: unknown } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    return {
      json: parseStrictJsonBytes(Buffer.from(trimmed, "utf8"), {
        maxBytes: SMITHERS_CLI_MAX_BUFFER_BYTES,
        maxDepth: 128,
        maxItems: 1_000_000,
        maxProperties: 1_000_000
      })
    };
  } catch {
    return {};
  }
}

function modelProfileFor(
  config: ResolvedConfig,
  attempt: NodeAttemptProvenance
): ResolvedConfig["models"]["profiles"][string] {
  if (attempt.model !== undefined) {
    return config.models.profiles[attempt.model.modelProfileId] ?? defaultModelProfile(config);
  }
  return defaultModelProfile(config);
}

function defaultModelProfile(config: ResolvedConfig): ResolvedConfig["models"]["profiles"][string] {
  return config.models.profiles[config.models.default] ?? Object.values(config.models.profiles)[0]!;
}

export { topologyRuntimeBudgetForTimeout };

export function topologyRuntimeContextForTimeout(timeoutMs: number): string {
  const { timeoutSeconds, finalizationReserveSeconds, workingBudgetSeconds } =
    topologyRuntimeBudgetForTimeout(timeoutMs);
  return [
    "## Topology Runtime Context",
    "",
    `- Timeout: ${timeoutSeconds} seconds total.`,
    `- Finalization reserve: ${finalizationReserveSeconds} seconds.`,
    `- Working budget before finalization: ${workingBudgetSeconds} seconds.`,
    "- Stop starting new delegated or tool work when the finalization reserve begins.",
    "- During the reserve, write and validate every required artifact, marking unfinished work blocked instead of omitting outputs."
  ].join("\n");
}

function renderWorkflowSource(compiled: CompiledSmithersWorkflow, config: ResolvedConfig): string {
  const taskSpecs = JSON.stringify(
    compiled.tasks.map((task) => ({
      id: task.smithersNodeId,
      preparationId: task.preparationSmithersNodeId,
      verifierId: task.verifierSmithersNodeId,
      attemptId: task.attemptId,
      dependsOn: task.dependencySmithersNodeIds,
      agentRef: task.agentRef,
      modelName: task.modelName ?? null,
      reasoningEffort: task.reasoningEffort ?? null,
      prompt: "",
      promptPath:
        task.renderedPromptPath === undefined
          ? undefined
          : executionPath(compiled.projectRoot, task, task.renderedPromptPath, "rendered prompt"),
      workspacePath: executionPath(compiled.projectRoot, task, task.workspacePath, "task workspace"),
      artifactDir: executionPath(compiled.projectRoot, task, task.artifactDir, "task artifact directory"),
      dependencyArtifactDirs: task.dependencyArtifactDirs.map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "dependency artifact directory")
      ),
      runRoot: executionPath(compiled.projectRoot, task, path.resolve(task.artifactDir, "..", ".."), "run root"),
      workflowPath: executionPath(compiled.projectRoot, task, compiled.workflowPath, "workflow path"),
      sourceProjectRoot: compiled.projectRoot,
      branch: `ultrafuzz/${compiled.runId}/${task.attemptId}`,
      timeoutMs: task.timeoutMs,
      runtimeContext: topologyRuntimeContextForTimeout(task.timeoutMs),
      campaignTimeoutExpectations: task.metadata.artifacts.outputs.some((output) =>
        INVARIANT_CAMPAIGN_ROLE_CONTRACTS.has(output.contract)
      )
        ? {
            configuredFuzzerTimeoutSeconds: config.invariants.invariantTestingFuzzerTimeoutSeconds,
            plannedTimeoutSeconds: task.metadata.timeout.seconds,
            finalizationReserveSeconds: topologyRuntimeBudgetForTimeout(task.timeoutMs).finalizationReserveSeconds
          }
        : null,
      heartbeatTimeoutMs: task.heartbeatTimeoutMs,
      retries: task.retries,
      retryPolicy: task.retryPolicy,
      metadata: executionMetadata(compiled.projectRoot, task),
      outputs: task.metadata.artifacts.outputs,
      execution: task.execution,
      pinnedSubmodules: compiled.pinnedSubmodules ?? null,
      productionSourceRoots: compiled.productionSourceRoots ?? ["src", "contracts"]
    })),
    null,
    2
  );
  return renderRuntimeTemplate("smithers/workflows/workflow.tsx", {
    __ULTRAFUZZ_RUN_ID__: compiled.runId,
    __ULTRAFUZZ_RUN_ID_LITERAL__: JSON.stringify(compiled.runId),
    __ULTRAFUZZ_TASK_SPECS__: taskSpecs,
    __ULTRAFUZZ_WORKFLOW_NAME__: JSON.stringify(compiled.workflowName),
    __ULTRAFUZZ_ARTIFACTS_MODULE__: JSON.stringify(import.meta.resolve("@ultrafuzz/artifacts")),
    __ULTRAFUZZ_RUNTIME_MODULE__: JSON.stringify(import.meta.resolve("@ultrafuzz/runtime")),
    __ULTRAFUZZ_MODAL_MODULE__: JSON.stringify(
      compiled.tasks.some((task) => task.execution.mode === "cloud") ? import.meta.resolve("@ultrafuzz/modal") : ""
    )
  });
}

function executionMetadata(projectRoot: string, task: CompiledSmithersTask): SmithersTaskMetadata {
  if (task.execution.mode === "local") return task.metadata;
  return {
    ...task.metadata,
    workspace: {
      ...task.metadata.workspace,
      path: relativeProjectPath(projectRoot, task.metadata.workspace.path, "workspace metadata path")
    },
    artifacts: {
      ...task.metadata.artifacts,
      dir: relativeProjectPath(projectRoot, task.metadata.artifacts.dir, "artifact metadata directory"),
      manifestPath: relativeProjectPath(projectRoot, task.metadata.artifacts.manifestPath, "artifact manifest path")
    }
  };
}

function executionPath(projectRoot: string, task: CompiledSmithersTask, value: string, label: string): string {
  return task.execution.mode === "cloud" ? relativeProjectPath(projectRoot, value, label) : value;
}

function relativeProjectPath(projectRoot: string, value: string, label: string): string {
  const relative = path.relative(projectRoot, value);
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a project child path`);
  }
  return relative.split(path.sep).join("/");
}
