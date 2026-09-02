import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  assertRunPlanDocument,
  assertValidSmithersTaskManifest,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  isArtifactContractId,
  MAX_REFERENCE_ARTIFACT_MANIFEST_AUTHORITY_BYTES,
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  promptArtifactAuthorityPathSelectorId,
  readRegularFileSnapshot,
  readRunPlanDocument,
  safeResolveInside,
  sha256Bytes,
  SMITHERS_NODE_STATES,
  SMITHERS_RUN_STATES,
  SMITHERS_RUN_STATUSES,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION as REGISTERED_SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  writeFileDurable,
  type RunLayout,
  type RunDataGovernanceReference,
  type SmithersTaskManifestAgentChainEntry,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestDynamicGroup,
  type SmithersTaskManifestDynamicPromptRuntimeContext,
  type SmithersTaskManifestMetadata,
  type SmithersTaskManifestPromptArtifactAuthoritySelector,
  type SmithersTaskManifestReferenceArtifactManifestAuthority,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import {
  invariantPropertyPrioritySelection,
  resolveExecutionResources,
  serializeResolvedConfigJsonBytes,
  serializeResolvedConfigToml,
  type ResolvedConfig
} from "@ultrafuzz/config";
import { loadAgentPreambleTemplate, renderAgentPreambleTemplate } from "@ultrafuzz/prompts";
import { isPathInside, isSensitiveSecretValue, redactSecretsInText, redactSecretsInValue } from "@ultrafuzz/security";
import {
  assertExpandedGraphSchema,
  type ExpandedGraph,
  type ExpandedNode,
  type ModelFanoutProvenance
} from "@ultrafuzz/topology";
import * as ts from "typescript";

import {
  DATA_GOVERNANCE_PROVENANCE_PATH,
  effectiveRouteEnvironment,
  isCredentialLikeEnvironmentVariableName,
  routeOwnsCredentialLikeEnvironmentVariable
} from "./data-governance.js";
import {
  assertControllerSourceDigest,
  inspectControllerSource,
  loadPackagedControllerSource,
  type PackagedControllerSource
} from "./controller-source.js";
import { isPreparedForgeGuardBin } from "./forge-guard.js";
import { withTransientNpmRegistryRetry } from "./npm-install-retry.js";
import { resolveOperatorNpmAuthority, type OperatorNpmProvision } from "./operator-npm.js";
import {
  enablePinnedSubmoduleWorktreeConfig,
  pinnedSubmoduleExecutionFiles,
  pinnedSubmoduleExpectationForProject,
  type PinnedSubmoduleExpectation
} from "./pinned-submodules.js";
import { renderRuntimeTemplate } from "./runtime-template.js";
import { retryChainAttemptCount, retryFallbackProfileIds } from "./retry-chain.js";
import { assertRunSourceRevision, captureRunSourceRevision, type RunSourceRevision } from "./source-revision.js";
import { topologyRuntimeBudgetForTimeout } from "./topology-runtime-budget.js";
import {
  CLOUD_EXECUTION_GENERATION_JSON_SCHEMA_ID,
  CLOUD_EXECUTION_GENERATION_SCHEMA_VERSION,
  SMITHERS_RESET_NODE_JSON_SCHEMA_ID,
  SMITHERS_RESET_NODE_SCHEMA_VERSION,
  SMITHERS_SUBMISSION_JSON_SCHEMA_ID,
  SMITHERS_SUBMISSION_SCHEMA_VERSION,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_SCHEMA_VERSION,
  type WorkflowExecutionDependenciesDocument
} from "./runtime-contracts.js";
import { assertRuntimeDocument, parseRuntimeDocumentBytes, writeRuntimeDocument } from "./runtime-document-codec.js";
import {
  acquireSmithersExecutableAnchor,
  assertExecutableOutsideRoot,
  bindOperatorSmithersExecutableCapability,
  bindSmithersExecutableCapability,
  nativeOperatorSmithersNodePath,
  smithersExecutableCapability,
  type SmithersExecutableAnchor
} from "./smithers-executable-capability.js";
import {
  isBunStartupControlPath,
  replaceBunStartupControlsForControllerRefresh,
  writeCurrentBunStartupControls,
  type VerifiedWorkflowControlSnapshot,
  type WorkflowExecutionControlFile
} from "./workflow-integrity.js";
import {
  acquireWorkflowExecutionSnapshotAnchor,
  hasWorkflowExecutionSnapshotCapability,
  type WorkflowExecutionSnapshotAnchor
} from "./workflow-execution-snapshot-capability.js";
import {
  assertSmithersPackageManifest,
  migrateStockSmithers032PackageManifest,
  renderSmithersPackageJson,
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
import { DEFERRED_PROMPT_TEMPLATE_DIR, sha256Stable, stableJson } from "./utils.js";

const execFileAsync = promisify(execFile);
const SMITHERS_CLI_MAX_BUFFER_BYTES = 1024 * 1024 * 128;
const MAX_PACKAGE_MANAGER_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_MANAGER_MANIFEST_DEPTH = 32;
const MAX_PACKAGE_MANAGER_MANIFEST_ITEMS = 10_000;
const MAX_PACKAGE_MANAGER_MANIFEST_PROPERTIES = 10_000;
const MAX_WORKFLOW_EXECUTION_FILE_BYTES = 64 * 1024 * 1024;
const SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS = 300_000;
const SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = "300000";
const STREAM_TERMINATION_GRACE_MS = 5_000;
const SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS = 1024 * 1024;
const ULTRAFUZZ_WORKFLOW_PERSISTED_PATH = "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH";
const NATIVE_SMITHERS_CONTINUATION: unique symbol = Symbol("ultrafuzz.native-smithers-continuation");
const NATIVE_SMITHERS_CONTROLLER_RETAIN_MARKER = ".ultrafuzz-native-continuation";
const WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH = "dependencies/manifest.json";
const DYNAMIC_BASE_GRAPH_SNAPSHOT_PATH = "controls/runtime-base-graph.json";
const DYNAMIC_BASE_TASKS_SNAPSHOT_PATH = "controls/runtime-base-tasks.json";
const WORKFLOW_DIRECT_EXTERNAL_DEPENDENCIES = ["@smthrs/tool-context", "react", "smthrs", "zod"] as const;
interface OperatorControllerProject {
  npm: OperatorNpmProvision;
  root: string;
  seal: string;
}

type NativeContinuationEnvironment = Record<string, string | undefined> & {
  [NATIVE_SMITHERS_CONTINUATION]?: true;
};

export function nativeSmithersContinuationEnvironment<T extends Record<string, string | undefined>>(env: T): T {
  Object.defineProperty(env, NATIVE_SMITHERS_CONTINUATION, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: true
  });
  return env;
}

function isNativeSmithersContinuation(env: Record<string, string | undefined> | undefined): boolean {
  return (env as NativeContinuationEnvironment | undefined)?.[NATIVE_SMITHERS_CONTINUATION] === true;
}

const operatorControllerProjects = new Map<string, Promise<OperatorControllerProject>>(),
  operatorControllerRoots = new Set<string>();
let operatorControllerCleanupRegistered = false;
const SMITHERS_BIN_LOCAL_DELEGATION_SOURCE = "if (!delegateToLocalCliIfPresent()) {",
  SMITHERS_BIN_LOCAL_DELEGATION_PATCH = "if (true) { // Ultrafuzz operator controller: never delegate to target code.";
// 0.35.0 routes the detached spawn through `smithersRuntimeSpawn`, which only
// selects the interpreter: under Bun it returns exactly `{command: "bun", args}`,
// the literal 0.34.0 shape. Upstream still has no equivalent of the fd-3
// execution-snapshot descriptor transfer below, so the replacement keeps
// discarding upstream's runtime selection in favour of the verified
// `process.execPath` and adds the descriptor the runner cannot supply.
const SMITHERS_CLI_DETACHED_SNAPSHOT_TRANSFER_SOURCE = `        const detachedSpawn = smithersRuntimeSpawn([cliPath, ...childArgs]);
        child = spawn(detachedSpawn.command, detachedSpawn.args, {
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
        child = spawn(process.execPath, [...(childSnapshotTransfer === undefined ? [] : ultrafuzzBunStartupArgsFor(childSnapshotTransfer.root)), ...(childSnapshotTransfer?.args ?? [cliPath, ...childArgs])], {
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
// Same `smithersRuntimeSpawn` indirection as the detached spawn above. The
// use-after-close this patch exists for survives verbatim in 0.35.0: `fd` is
// closed in the enclosing `finally` before the supervisor spawn reaches it, so
// the private `supervisorFd` below is still the only thing keeping the
// supervisor off a closed descriptor.
const SMITHERS_CLI_SUPERVISOR_SPAWN_SOURCE = `        const supervisorSpawn = smithersRuntimeSpawn(supervisorArgs);
        const supervisor = spawn(supervisorSpawn.command, supervisorSpawn.args, {
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
          supervisor = spawn(process.execPath, [...(supervisorSnapshotTransfer === undefined ? [] : ultrafuzzBunStartupArgsFor(supervisorSnapshotTransfer.root)), ...(supervisorSnapshotTransfer?.args ?? supervisorArgs)], {
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
// 0.35.0 changed three things here: the interpreter now comes from
// `smithersRuntimeSpawn` (a no-op under Bun), `options.executable` is honoured
// when a caller supplies one, and `logFd` is no longer nullable — the runner
// throws `detached log is unavailable` instead of falling back to `"ignore"`.
// The replacement still overrides all three, and still supplies the fd-3
// execution-snapshot descriptor upstream has no equivalent of.
// The bun startup arguments 0.35.0 leaves inline in the resume patch. The
// darwin-capable patch swaps the whole expression for a descriptor-rooted
// helper call, so it is named here to keep that substitution checkable.
const RESUME_SNAPSHOT_INLINE_BUN_STARTUP_ARGS =
  '[...(process.versions.bun ? ["--config=/proc/self/fd/3/controls/bunfig.toml", "--env-file=/proc/self/fd/3/controls/bun-empty.env", "--no-env-file", "--no-install", "--no-addons", "--preserve-symlinks-main", "--preload=/proc/self/fd/3/controls/bun-module-confinement.js"] : []), ...args.map(rewriteSnapshotArgument)]';
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_SOURCE = `    const runtime = options.executable ? { command: options.executable, args } : smithersRuntimeSpawn(args);
    const child = spawn(runtime.command, runtime.args, {
      cwd,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      detached: true,
    });`;
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PREDECESSOR_PATCH = `    const snapshotDescriptorValue =
      process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR?.trim();
    const snapshotSourceRoot = process.env.ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT?.trim();
    const snapshotProcessRoot = process.env.ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT?.trim();
    const snapshotPersistedRoot = process.env.ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT?.trim();
    const snapshotTransferDeclared =
      snapshotDescriptorValue !== undefined ||
      snapshotSourceRoot !== undefined ||
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
      const expectedProcessRoot =
        snapshotDescriptor === undefined ? undefined : ultrafuzzDescriptorRootPath(snapshotDescriptor);
      const processStat =
        snapshotDescriptor === undefined || !snapshotProcessRoot
          ? undefined
          : statSync(snapshotProcessRoot);
      const sourceStat =
        snapshotDescriptor === undefined || !snapshotSourceRoot
          ? undefined
          : statSync(snapshotSourceRoot);
      const persistedStat =
        snapshotDescriptor === undefined || !snapshotPersistedRoot
          ? undefined
          : statSync(snapshotPersistedRoot);
      if (
        snapshotDescriptor === undefined ||
        processStat === undefined ||
        sourceStat === undefined ||
        persistedStat === undefined ||
        snapshotProcessRoot !== expectedProcessRoot ||
        !processStat.isDirectory() ||
        !sourceStat.isDirectory() ||
        !persistedStat.isDirectory() ||
        processStat.dev !== persistedStat.dev ||
        processStat.ino !== persistedStat.ino ||
        sourceStat.dev !== persistedStat.dev ||
        sourceStat.ino !== persistedStat.ino
      ) {
        throw new Error("detached resume execution snapshot transfer capability is no longer current");
      }
    }
    const snapshotRoots = [snapshotSourceRoot, snapshotProcessRoot, snapshotPersistedRoot].filter(
      (value) => value !== undefined && value.length > 1,
    );
    const snapshotChildRoot =
      snapshotDescriptor === undefined ? "/proc/self/fd/3" : ultrafuzzChildRootPath(snapshotDescriptor);
    const rewriteSnapshotArgument = (value) => {
      if (snapshotDescriptor === undefined) return value;
      for (const root of snapshotRoots) {
        if (value === root || value.startsWith(root + "/")) {
          return snapshotChildRoot + value.slice(root.length);
        }
      }
      return value;
    };
    // \`options.executable\` is deliberately ignored. \`process.execPath\` here is the
    // interpreter bound and verified by Ultrafuzz's executable capability;
    // honouring a caller-supplied executable string would be a capability escape.
    // \`logFd\` is always an open descriptor in the pinned runner, which throws when
    // it cannot open the detached log, so there is no "ignore" fallback to keep.
    const child = spawn(process.execPath, [...(process.versions.bun ? ["--config=/proc/self/fd/3/controls/bunfig.toml", "--env-file=/proc/self/fd/3/controls/bun-empty.env", "--no-env-file", "--no-install", "--no-addons", "--preserve-symlinks", "--preserve-symlinks-main", "--preload=/proc/self/fd/3/controls/bun-module-confinement.js"] : []), ...args.map(rewriteSnapshotArgument)], {
      cwd,
      stdio:
        snapshotDescriptor === undefined
          ? ["ignore", logFd, logFd]
          : ["ignore", logFd, logFd, snapshotDescriptor],
      env: {
        ...process.env,
        ...(snapshotDescriptor === undefined
          ? {}
          : { ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR: "3" }),
      },
      detached: true,
    });`;
// The form Ultrafuzz wrote before 0.35.0 dropped `--preserve-symlinks`.
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PRESERVE_SYMLINKS_PREDECESSOR_PATCH =
  SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PREDECESSOR_PATCH.replace(
    '"--no-addons", "--preserve-symlinks", "--preserve-symlinks-main"',
    '"--no-addons", "--preserve-symlinks-main"'
  );
// The form Ultrafuzz wrote while the child root was the /proc literal. An
// installation patched by that release is still recognized through the
// predecessor list below rather than being rewritten in place.
const SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PATCH =
  SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PRESERVE_SYMLINKS_PREDECESSOR_PATCH.replace(
    RESUME_SNAPSHOT_INLINE_BUN_STARTUP_ARGS,
    "[...ultrafuzzBunStartupArgsFor(snapshotChildRoot), ...args.map(rewriteSnapshotArgument)]"
  );
// 0.35.0 reflowed this import across multiple lines and added `watch`;
// `realpathSync` is still absent, so the CLI still cannot compare a workflow
// path against its persisted generation without this patch.
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_SOURCE = `import {
  closeSync,
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";`;
const SMITHERS_CLI_WORKFLOW_PATH_IMPORT_PATCH = `import {
  closeSync,
  fstatSync,
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  watch,
  writeFileSync,
  writeSync,
} from "node:fs";`;
const SMITHERS_CLI_WORKFLOW_PATH_SOURCE = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_WORKFLOW_FILE_IDENTITY_HELPER = `// Keep Linux's canonical-path comparison unchanged. Darwin volfs paths cannot
// be realpathed, so compare the verified file identities they name instead.
const ultrafuzzSameWorkflowFile = (left, right) => {
  if (process.platform !== "darwin") return realpathSync(left) === realpathSync(right);
  const a = statSync(left);
  const b = statSync(right);
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
};`;
const SMITHERS_CLI_WORKFLOW_PATH_PATCH = `    const resolvedWorkflowPath = resolve(process.cwd(), workflowPath);
    const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
    const persistedWorkflowPath = persistedWorkflowPathValue
      ? resolve(process.cwd(), persistedWorkflowPathValue)
      : resolvedWorkflowPath;
    if (!ultrafuzzSameWorkflowFile(resolvedWorkflowPath, persistedWorkflowPath)) {
      return fail({
        code: "INVALID_WORKFLOW_PATH",
        message: "Controller workflow path does not match its persisted workflow path",
        exitCode: 4,
      });
    }
    const { resume, resumeRunId } = normalizeResumeOption(options.resume);`;
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_SOURCE =
  "process.env.SMITHERS_CLI_SRC_DIR ??= dirname(fileURLToPath(import.meta.url));";
// Both the execve and the spawn now route through `smithersRuntimeReentry`,
// which under Bun returns exactly `{command: process.execPath, args}` — the
// literal 0.34.0 shape. The replacement declares its own `relaunchArgs` and
// never reads `runtime`, so it substitutes cleanly and keeps the fd-3 transfer.
const SMITHERS_CLI_MANIFEST_RELAUNCH_SOURCE = `  if (typeof process.execve === "function") {\n    process.chdir(cliPackageDir);\n    const runtime = smithersRuntimeReentry([cliEntry, ...process.argv.slice(2)]);\n    process.execve(runtime.command, [runtime.command, ...runtime.args], childEnv);\n  }\n  process.chdir(cliPackageDir);\n  const runtime = smithersRuntimeReentry([cliEntry, ...process.argv.slice(2)]);\n  const child = spawn(runtime.command, runtime.args, {\n    env: childEnv,\n    stdio: "inherit",\n  });`;
const SMITHERS_CLI_MANIFEST_RELAUNCH_PATCH = `  const relaunchArgs = [cliEntry, ...process.argv.slice(2)];\n  const relaunchSnapshotTransfer = ultrafuzzExecutionSnapshotChildTransfer(relaunchArgs);\n  if (relaunchSnapshotTransfer === undefined && typeof process.execve === "function") {\n    process.chdir(cliPackageDir);\n    process.execve(process.execPath, [process.execPath, ...relaunchArgs], childEnv);\n  }\n  process.chdir(cliPackageDir);\n  const child = spawn(process.execPath, [...(relaunchSnapshotTransfer === undefined ? [] : ultrafuzzBunStartupArgsFor(relaunchSnapshotTransfer.root)), ...(relaunchSnapshotTransfer?.args ?? relaunchArgs)], {\n    env: { ...childEnv, ...(relaunchSnapshotTransfer?.env ?? {}) },\n    stdio: relaunchSnapshotTransfer === undefined ? "inherit" : ["inherit", "inherit", "inherit", relaunchSnapshotTransfer.descriptor],\n  });`;
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PREDECESSOR_PATCH = `process.env.SMITHERS_CLI_SRC_DIR ??= dirname(fileURLToPath(import.meta.url));
// Linux addresses an open directory descriptor as /proc/<pid>/fd/<n>. macOS has
// no /proc, and its /dev/fd/<n> entry for a directory cannot be traversed, so it
// uses volfs instead: /.vol/<dev>/<ino> is rooted at an inode rather than a name,
// which is the same swap-immunity /proc/self/fd provides here. A volfs path is
// process-independent, so the same string is valid in the child; the descriptor
// is still inherited as fd 3 and still pins the inode against reuse.
const ultrafuzzVolfsRoot = (descriptor) => {
  const opened = fstatSync(descriptor);
  return "/.vol/" + opened.dev + "/" + opened.ino;
};
const ultrafuzzDescriptorRootPath = (descriptor) =>
  process.platform === "darwin" ? ultrafuzzVolfsRoot(descriptor) : "/proc/" + process.pid + "/fd/" + descriptor;
const ultrafuzzInheritedRootPath = (descriptor) =>
  process.platform === "darwin" ? ultrafuzzVolfsRoot(descriptor) : "/proc/self/fd/" + descriptor;
// The path the child will use for the directory it receives as fd 3.
const ultrafuzzChildRootPath = (descriptor) =>
  process.platform === "darwin" ? ultrafuzzVolfsRoot(descriptor) : "/proc/self/fd/3";
// volfs paths have no realpath(3) resolution, so identity is compared by inode.
const ultrafuzzSameDirectory = (left, right) => {
  const a = statSync(left);
  const b = statSync(right);
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
};
const ultrafuzzBunStartupArgsFor = (root) => process.versions.bun ? ["--config=" + root + "/controls/bunfig.toml", "--env-file=" + root + "/controls/bun-empty.env", "--no-env-file", "--no-install", "--no-addons", "--preserve-symlinks", "--preserve-symlinks-main", "--preload=" + root + "/controls/bun-module-confinement.js"] : [];

// Ultrafuzz invokes this process through a descriptor held by its controller.
// Each detached descendant receives that directory atomically as fd 3, opens a
// process-owned anchor, and passes the capability the same way to its children.
// This avoids every parent-exit race around /proc/<parent>/fd/<n> pathnames.
const ultrafuzzInheritedSnapshotDescriptorEnv = "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR";
const ultrafuzzProcessSnapshotDescriptorEnv = "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR";
const ultrafuzzSnapshotSourceRootEnv = "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT";
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
  const sourceRoot = process.env[ultrafuzzSnapshotSourceRootEnv]?.trim();
  const processRoot = process.env[ultrafuzzProcessSnapshotRootEnv]?.trim();
  const persistedRoot = process.env[ultrafuzzPersistedSnapshotRootEnv]?.trim();
  const transferDeclared =
    descriptorValue !== undefined || sourceRoot !== undefined || processRoot !== undefined || persistedRoot !== undefined;
  if (!transferDeclared) return undefined;

  const descriptor = ultrafuzzSnapshotDescriptor(descriptorValue ?? "");
  if (descriptor === undefined || !sourceRoot || !processRoot || !persistedRoot) {
    throw new Error("process execution snapshot transfer capability is incomplete or invalid");
  }

  const expectedProcessRoot = ultrafuzzDescriptorRootPath(descriptor);
  const childRoot = ultrafuzzChildRootPath(descriptor);
  if (
    processRoot !== expectedProcessRoot ||
    !statSync(sourceRoot).isDirectory() ||
    !statSync(processRoot).isDirectory() ||
    !ultrafuzzSameDirectory(sourceRoot, persistedRoot) ||
    !ultrafuzzSameDirectory(processRoot, persistedRoot)
  ) {
    throw new Error("process execution snapshot transfer capability is no longer current");
  }
  return {
    descriptor,
    root: childRoot,
    args: args.map((value) =>
      rewriteUltrafuzzExecutionSnapshotValue(value, [sourceRoot, processRoot, persistedRoot], childRoot)
    ),
    env: { [ultrafuzzInheritedSnapshotDescriptorEnv]: "3" },
  };
}

function anchorUltrafuzzExecutionSnapshotForProcess() {
  const inheritedDescriptorValue = process.env[ultrafuzzInheritedSnapshotDescriptorEnv]?.trim();
  delete process.env[ultrafuzzInheritedSnapshotDescriptorEnv];
  delete process.env[ultrafuzzProcessSnapshotDescriptorEnv];
  delete process.env[ultrafuzzSnapshotSourceRootEnv];
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
  const configuredSourceRoot = dirname(dirname(configPath));
  if (inheritedDescriptorValue !== undefined && inheritedDescriptorValue !== "3") {
    throw new Error("inherited execution snapshot descriptor must be fixed fd 3");
  }
  const inheritedDescriptor = inheritedDescriptorValue === undefined ? undefined : 3;
  if (inheritedDescriptor === undefined && !/^(?:\\/proc\\/[0-9]+\\/fd\\/[0-9]+|\\/\\.vol\\/[0-9]+\\/[0-9]+)$/u.test(configuredSourceRoot)) return;

  const { persistedWorkflowPath, persistedRoot } =
    ultrafuzzPersistedExecutionSnapshotRoot(persistedWorkflowValue);
  const sourceRoot =
    inheritedDescriptor === undefined ? configuredSourceRoot : ultrafuzzInheritedRootPath(inheritedDescriptor);
  const acquisitionRoot = sourceRoot;
  let descriptor;
  try {
    descriptor = inheritedDescriptor ?? openSync(acquisitionRoot, "r");
    const processRoot = ultrafuzzDescriptorRootPath(descriptor);
    const processStat = statSync(processRoot);
    if (!processStat.isDirectory() || !ultrafuzzSameDirectory(processRoot, persistedRoot)) {
      throw new Error("process execution snapshot descriptor changed during acquisition");
    }

    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name !== "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH") {
        process.env[name] = rewriteUltrafuzzExecutionSnapshotValue(
          value,
          [configuredSourceRoot, sourceRoot, persistedRoot],
          processRoot,
        );
      }
    }
    for (let index = 0; index < process.argv.length; index += 1) {
      process.argv[index] = rewriteUltrafuzzExecutionSnapshotValue(
        process.argv[index],
        [configuredSourceRoot, sourceRoot, persistedRoot],
        processRoot,
      );
    }
    const loadedWorkflow = process.argv.find((value) => value.includes("/.smithers/workflows/"));
    if (loadedWorkflow && realpathSync(loadedWorkflow) !== realpathSync(persistedWorkflowPath)) {
      throw new Error("process-owned workflow path does not match its persisted generation");
    }

    process.env[ultrafuzzProcessSnapshotDescriptorEnv] = String(descriptor);
    process.env[ultrafuzzSnapshotSourceRootEnv] = sourceRoot;
    process.env[ultrafuzzProcessSnapshotRootEnv] = processRoot;
    process.env[ultrafuzzPersistedSnapshotRootEnv] = persistedRoot;
    process.env.SMITHERS_MONITOR_SUPPRESS = "1";
    process.env.SMITHERS_POST_FAILURE = "0";
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
  // This descriptor is the process-scoped execution capability. The kernel
  // closes it when this CLI, detached engine, or supervisor exits.
}

anchorUltrafuzzExecutionSnapshotForProcess();`;
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_REALPATH_PATCH =
  SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PREDECESSOR_PATCH.replace(
    '"--no-addons", "--preserve-symlinks", "--preserve-symlinks-main"',
    '"--no-addons", "--preserve-symlinks-main"'
  );
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_NESTED_PREDECESSOR_PATCH =
  SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PREDECESSOR_PATCH.replace(
    SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_SOURCE,
    SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_REALPATH_PATCH
  );
const SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PATCH = SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_REALPATH_PATCH.replace(
  `const ultrafuzzSameDirectory = (left, right) => {
  const a = statSync(left);
  const b = statSync(right);
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
};`,
  `const ultrafuzzSameDirectory = (left, right) => {
  const a = statSync(left);
  const b = statSync(right);
  return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
};
${SMITHERS_WORKFLOW_FILE_IDENTITY_HELPER}`
).replace(
  "if (loadedWorkflow && realpathSync(loadedWorkflow) !== realpathSync(persistedWorkflowPath)) {",
  "if (loadedWorkflow && !ultrafuzzSameWorkflowFile(loadedWorkflow, persistedWorkflowPath)) {"
);
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
          if (!ultrafuzzSameWorkflowFile(resolvedReplayWorkflowPath, persistedReplayWorkflowPath)) {
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
          if (!ultrafuzzSameWorkflowFile(resolvedForkWorkflowPath, persistedForkWorkflowPath)) {
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
const SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_SOURCE = `  "RunAutoResumeSkipped",
  "RunForked",
  "NodePending",`;
const SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_PATCH = `  "RunAutoResumeSkipped",
  "RunForked",
  "AgentTraceSummary",
  "NodePending",`;
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
const SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_SOURCE =
  'import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";';
const SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_PATCH =
  'import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";';
const SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE =
  "  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;";
const SMITHERS_ENGINE_WORKFLOW_PATH_PATCH = `  ${SMITHERS_WORKFLOW_FILE_IDENTITY_HELPER.replaceAll("\n", "\n  ")}
  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;
  const persistedWorkflowPathValue = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH?.trim();
  const persistedWorkflowPath = opts.workflowPath
    ? resolve(persistedWorkflowPathValue || opts.workflowPath)
    : null;
  if (
    resolvedWorkflowPath &&
    persistedWorkflowPath &&
    !ultrafuzzSameWorkflowFile(resolvedWorkflowPath, persistedWorkflowPath)
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
const SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_SOURCE = `  const acceptedWorkflowMismatches =
    options.acceptWorkflowChange === true
      ? mismatches.filter((mismatch) => workflowHashMismatchLabels.includes(mismatch))
      : [];`;
const SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_PATCH = `  const acceptedWorkflowMismatches =
    options.acceptWorkflowChange === true
      ? mismatches.filter(
          (mismatch) =>
            mismatch === "workflow path changed" || workflowHashMismatchLabels.includes(mismatch),
        )
      : [];`;
// 0.35.0 re-nested `adapter.insertRun({…})` into `adapter.insertRun({…}, {…})`
// for the `rejectExisting` option and migration 0044's `owner`/`app` columns,
// pushing this block from 10 to 12 spaces. Behaviour is unchanged; only the
// indentation moved. The sibling update/continuation anchors below were not
// re-nested and stay at 10 spaces.
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_SOURCE = `            workflowName: "workflow",
            workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
            workflowHash: runMetadata.workflowHash,`;
const SMITHERS_ENGINE_INSERT_WORKFLOW_PATH_PATCH = `            workflowName: "workflow",
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
// Restores exactly the two states upstream's `isTerminalState` calls terminal
// unconditionally: `finished` and `skipped`. `failed`, `cancelled` and Smithers
// 0.35.0's new `stalled` are deliberately NOT restored, and the omission of
// `stalled` is the deliberate half of that rule, not an oversight from the
// 0.35.0 bump. Upstream classes `stalled` with `failed` ("it behaves exactly
// like `failed`, including the continueOnFail escape hatch"), and a resume's
// whole purpose is to re-attempt what did not finish -- restoring `stalled` but
// not `failed` would make a stalled node strictly less retryable than an
// ordinary failure, and an operator could not tell a permanently abandoned node
// from a hung one. The cost of re-running is bounded: 0.35.0 recomputes the
// identical-failure streak from durable attempt rows on every failure
// (`@smthrs/engine/src/failure-streak.js`), so a re-run stalled node re-stalls
// on its first attempt rather than burning the whole retry budget again.
// `resume --retry-failed` is the explicit escape hatch, and `smithersFailedTasks`
// resets stalled nodes with the failed ones.
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

// Smithers fences every agent event and stdout/stderr chunk with a durable
// heartbeat ownership proof before accepting its callback. At high concurrency,
// independently starting that proof for every callback creates a large queue of
// redundant database writes. Task completion then waits for the whole queue even
// after the agent process exits. Share only the proof that is currently in flight:
// every callback remains fenced by a successful ownership result, while callbacks
// arriving in the same burst no longer race the shared heartbeat state or repeat
// the same database write.
const SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_SOURCE = `  const pendingOwnershipChecks = new Set();
  const afterHeartbeatOwnership = (callback) => {
    const check = confirmHeartbeatOwnership()
      .then((owned) => {
        if (owned) return callback();
      })
      .catch(() => {})
      .finally(() => {
        pendingOwnershipChecks.delete(check);
      });
    pendingOwnershipChecks.add(check);
  };`;
const SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_PATCH = `  const pendingOwnershipChecks = new Set();
  let heartbeatOwnershipCheckInFlight = null;
  const sharedHeartbeatOwnershipCheck = () => {
    if (heartbeatOwnershipCheckInFlight) return heartbeatOwnershipCheckInFlight;
    const check = confirmHeartbeatOwnership().finally(() => {
      if (heartbeatOwnershipCheckInFlight === check) heartbeatOwnershipCheckInFlight = null;
    });
    heartbeatOwnershipCheckInFlight = check;
    return check;
  };
  const afterHeartbeatOwnership = (callback) => {
    const check = sharedHeartbeatOwnershipCheck()
      .then((owned) => {
        if (owned) return callback();
      })
      .catch(() => {})
      .finally(() => {
        pendingOwnershipChecks.delete(check);
      });
    pendingOwnershipChecks.add(check);
  };`;

// Every event the engine persists first runs an idempotency probe that
// filters `_smithers_events` on (run_id, timestamp_ms, type, payload_json).
// The table's only index is its (run_id, seq) primary key, and the probe's
// `ORDER BY seq DESC LIMIT 1` makes the planner walk that key newest-first,
// so a FRESH event — the overwhelmingly common case — reads every prior
// event row for the run, payloads included, before concluding there is no
// duplicate. Per-event cost is therefore linear in the run's event history
// and total cost quadratic in event count; at dynamic fan-out scale the
// controller's main thread saturates in these page reads (issue #858: ~300%
// CPU, frozen stream.ndjson, starved node-timeout timers, idle agents).
// The fix is a covering index whose equality prefix matches the probe and whose
// trailing `seq` satisfies its ordering. Including `payload_json` keeps the final
// equality check inside the index. SQLite then selects the index without an
// `INDEXED BY` hint, so historical databases remain readable before a current
// startup has created the optional index. `runtime.test.ts`'s "event probe
// compatibility patch adds an optional covering index" pins that choice from the
// other side.
const SMITHERS_DB_EVENT_PROBE_INDEX_SOURCE = `const EXTRA_INDEX_STATEMENTS = [
  \`CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)\`,`;
const SMITHERS_DB_EVENT_PROBE_INDEX_PATCH = `const EXTRA_INDEX_STATEMENTS = [
  \`CREATE INDEX IF NOT EXISTS _smithers_events_insert_probe_v2_idx ON _smithers_events (run_id, timestamp_ms, type, seq, payload_json)\`,
  \`CREATE INDEX IF NOT EXISTS _smithers_runs_parent_idx ON _smithers_runs (parent_run_id)\`,`;

// The stock per-attempt usage upsert is unconditional. A delayed callback from
// an old controller can therefore overwrite a newer snapshot after ownership
// changes, and an earlier cumulative snapshot can regress a later aggregate.
// Add an atomic operation that locks/checks the live run owner and exact
// in-progress attempt, then accepts only component-wise cumulative progress.
const SMITHERS_DB_FENCED_USAGE_SOURCE = `  /**
   * Persist one attempt's token usage so a run total is a single SUM instead of`;
const SMITHERS_DB_FENCED_USAGE_PATCH = `  /**
   * Atomically replace one live attempt's cumulative usage only while the
   * caller still owns the run and no known cumulative component regresses.
   * @param {{
   *   runId: string;
   *   nodeId: string;
   *   iteration: number;
   *   attempt: number;
   *   runtimeOwnerId: string | null;
   *   model?: string | null;
   *   agent?: string | null;
   *   inputTokens?: number | null;
   *   freshInputTokens?: number | null;
   *   outputTokens?: number | null;
   *   cacheReadTokens?: number | null;
   *   cacheWriteTokens?: number | null;
   *   reasoningTokens?: number | null;
   *   costUsd?: number | null;
   *   updatedAtMs: number;
   *   event: Record<string, unknown>;
   * }} row
   * @returns {RunnableEffect<boolean, SmithersError>}
   */
  recordRunTokenUsageOwned(row) {
    const self = this;
    return this.withTransactionEffect(
      \`record owned run token usage \${row.runId}/\${row.nodeId}#\${row.attempt}\`,
      Effect.tryPromise({
        try: async () => {
          const usageEvent = row.event;
          if (
            !usageEvent ||
            usageEvent.type !== "TokenUsageReported" ||
            usageEvent.runId !== row.runId ||
            usageEvent.nodeId !== row.nodeId ||
            Number(usageEvent.iteration ?? 0) !== row.iteration ||
            Number(usageEvent.attempt ?? 0) !== row.attempt ||
            usageEvent.timestampMs !== row.updatedAtMs
          ) {
            throw new Error("owned run token usage requires its exact TokenUsageReported event");
          }
          if (this.internalStorage.dialect === POSTGRES) {
            const ownedRun = await this.internalStorage.queryOne(
              \`SELECT 1 AS owned
               FROM _smithers_runs
               WHERE run_id = ?
                 AND status = 'running'
                 AND cancel_requested_at_ms IS NULL
                 AND ((runtime_owner_id IS NULL AND CAST(? AS TEXT) IS NULL) OR runtime_owner_id = ?)
               LIMIT 1 FOR UPDATE\`,
              [row.runId, row.runtimeOwnerId, row.runtimeOwnerId],
            );
            if (!ownedRun) return false;
            const activeAttempt = await this.internalStorage.queryOne(
              \`SELECT 1 AS active
               FROM _smithers_attempts
               WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ? AND state = 'in-progress'
               LIMIT 1 FOR UPDATE\`,
              [row.runId, row.nodeId, row.iteration, row.attempt],
            );
            if (!activeAttempt) return false;
          } else {
            const fence = await this.internalStorage.queryOne(
              \`SELECT 1 AS owned
               FROM _smithers_runs r
               JOIN _smithers_attempts a
                 ON a.run_id = r.run_id
                AND a.node_id = ?
                AND a.iteration = ?
                AND a.attempt = ?
               WHERE r.run_id = ?
                 AND r.status = 'running'
                 AND r.cancel_requested_at_ms IS NULL
                 AND ((r.runtime_owner_id IS NULL AND CAST(? AS TEXT) IS NULL) OR r.runtime_owner_id = ?)
                 AND a.state = 'in-progress'
               LIMIT 1\`,
              [row.nodeId, row.iteration, row.attempt, row.runId, row.runtimeOwnerId, row.runtimeOwnerId],
            );
            if (!fence) return false;
          }
          const count = (value) =>
            typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
          const optionalCount = (value) => (value == null ? null : count(value));
          const inputTokens = count(row.inputTokens);
          const freshInputTokens = optionalCount(row.freshInputTokens);
          const outputTokens = count(row.outputTokens);
          let cacheReadTokens = optionalCount(row.cacheReadTokens);
          let cacheWriteTokens = optionalCount(row.cacheWriteTokens);
          let reasoningTokens = optionalCount(row.reasoningTokens);
          const costUsd =
            typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0
              ? row.costUsd
              : null;
          const hasEventField = (field) => Object.prototype.hasOwnProperty.call(usageEvent, field);
          const exactEventCount = (field, expected, reported = true) => {
            if (!reported) return !hasEventField(field);
            const value = usageEvent[field];
            return Number.isSafeInteger(value) && value >= 0 && value === expected;
          };
          const exactEventCost =
            costUsd === null
              ? !hasEventField("costUsd")
              : hasEventField("costUsd") && usageEvent.costUsd === costUsd;
          if (
            usageEvent.model !== (row.model ?? null) ||
            usageEvent.agent !== (row.agent ?? null) ||
            !exactEventCount("inputTokens", inputTokens) ||
            !exactEventCount("freshInputTokens", freshInputTokens, freshInputTokens !== null) ||
            !exactEventCount("outputTokens", outputTokens) ||
            !exactEventCount("cacheReadTokens", cacheReadTokens, cacheReadTokens !== null) ||
            !exactEventCount("cacheWriteTokens", cacheWriteTokens, cacheWriteTokens !== null) ||
            !exactEventCount("reasoningTokens", reasoningTokens, reasoningTokens !== null) ||
            !exactEventCost
          ) {
            throw new Error("owned run token usage event does not match its normalized usage snapshot");
          }
          const existing = await this.internalStorage.queryOne(
            \`SELECT model, agent, input_tokens, fresh_input_tokens, output_tokens,
                    cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd
             FROM _smithers_run_usage
             WHERE run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?
             LIMIT 1\`,
            [row.runId, row.nodeId, row.iteration, row.attempt],
          );
          if (existing) {
            const oldInputTokens = count(existing.input_tokens ?? existing.inputTokens);
            const oldFreshInputTokens = optionalCount(existing.fresh_input_tokens ?? existing.freshInputTokens);
            const oldOutputTokens = count(existing.output_tokens ?? existing.outputTokens);
            const oldCacheReadTokens = count(existing.cache_read_tokens ?? existing.cacheReadTokens);
            const oldCacheWriteTokens = count(existing.cache_write_tokens ?? existing.cacheWriteTokens);
            const oldReasoningTokens = count(existing.reasoning_tokens ?? existing.reasoningTokens);
            const oldCostUsd =
              typeof (existing.cost_usd ?? existing.costUsd) === "number" &&
              Number.isFinite(existing.cost_usd ?? existing.costUsd) &&
              (existing.cost_usd ?? existing.costUsd) >= 0
                ? (existing.cost_usd ?? existing.costUsd)
                : null;
            // Missing optional breakdowns mean "unknown for the new
            // invocation", not that an earlier known subtotal regressed.
            cacheReadTokens ??= oldCacheReadTokens;
            cacheWriteTokens ??= oldCacheWriteTokens;
            reasoningTokens ??= oldReasoningTokens;
            const primaryUsageAdvanced = inputTokens > oldInputTokens || outputTokens > oldOutputTokens;
            const usageAdvanced =
              primaryUsageAdvanced ||
              cacheReadTokens > oldCacheReadTokens ||
              cacheWriteTokens > oldCacheWriteTokens ||
              reasoningTokens > oldReasoningTokens;
            // A later invocation can add primary tokens without an explicit
            // fresh/cache split. Permit the breakdown to become unknown only
            // alongside that forward progress, never on an equal stale row.
            const freshInputDominates =
              oldFreshInputTokens === null ||
              (freshInputTokens !== null && freshInputTokens >= oldFreshInputTokens) ||
              (freshInputTokens === null && primaryUsageAdvanced);
            // A later invocation can add tokens whose price is unavailable.
            // In that case the cumulative price legitimately becomes unknown;
            // require token progress so an equal stale snapshot cannot erase a
            // previously complete cost.
            const costDominates =
              oldCostUsd === null ||
              (costUsd !== null && costUsd >= oldCostUsd) ||
              (costUsd === null && usageAdvanced);
            if (
              inputTokens < oldInputTokens ||
              outputTokens < oldOutputTokens ||
              cacheReadTokens < oldCacheReadTokens ||
              cacheWriteTokens < oldCacheWriteTokens ||
              reasoningTokens < oldReasoningTokens ||
              !freshInputDominates ||
              !costDominates
            ) {
              return false;
            }
          }
          cacheReadTokens ??= 0;
          cacheWriteTokens ??= 0;
          reasoningTokens ??= 0;
          const values = [
            row.runId,
            row.nodeId,
            row.iteration,
            row.attempt,
            row.model ?? null,
            row.agent ?? null,
            inputTokens,
            freshInputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            costUsd,
            row.updatedAtMs,
          ];
          const columns = \`(run_id, node_id, iteration, attempt, model, agent, input_tokens, fresh_input_tokens,
                output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, updated_at_ms)\`;
          const update = \`model = excluded.model, agent = excluded.agent,
                            input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
                            fresh_input_tokens = excluded.fresh_input_tokens,
                            cache_read_tokens = excluded.cache_read_tokens,
                            cache_write_tokens = excluded.cache_write_tokens,
                            reasoning_tokens = excluded.reasoning_tokens,
                            cost_usd = excluded.cost_usd,
                            updated_at_ms = excluded.updated_at_ms\`;
          await self.internalStorage.execute(
            \`INSERT INTO _smithers_run_usage \${columns}
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id, node_id, iteration, attempt)
             DO UPDATE SET \${update}\`,
            values,
          );
          const eventRow = {
            runId: row.runId,
            timestampMs: row.updatedAtMs,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify(usageEvent),
          };
          if (self.internalStorage.dialect === POSTGRES) {
            await self.internalStorage.insertEventWithNextSeqPostgres(eventRow);
          } else {
            const existingEvent = await self.internalStorage.queryOne(
              \`SELECT seq
               FROM _smithers_events
               WHERE run_id = ? AND timestamp_ms = ? AND type = ? AND payload_json = ?
               ORDER BY seq DESC LIMIT 1\`,
              [eventRow.runId, eventRow.timestampMs, eventRow.type, eventRow.payloadJson],
            );
            if (existingEvent?.seq === undefined) {
              const lastSeq = (await self.internalStorage.getLastEventSeq(eventRow.runId)) ?? -1;
              await self.internalStorage.insertIgnore("_smithers_events", { ...eventRow, seq: lastSeq + 1 });
            }
          }
          return true;
        },
        catch: (cause) => toSmithersError(cause, "record owned run token usage"),
      }),
    );
  }
  /**
   * Persist one attempt's token usage so a run total is a single SUM instead of`;

// Smithers normally recomputes cost from its own small model table after a CLI
// adapter has already reported a per-invocation estimate. Pi can route models
// absent from that table, so preserving its estimate is the only way to avoid
// turning a fully priced invocation into "unavailable" (or repricing it using a
// different catalogue). Audited CLI adapters attach the custom field, which is
// bounded here before it reaches TokenUsageReported.
const SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_SOURCE = `  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens ?? undefined;
  if (!(inputTokens > 0 || outputTokens > 0)) return null;
  const reportedFreshInputTokens = usage.inputTokenDetails?.noCacheTokens ?? usage.freshInputTokens;
  const freshInputTokens =
    typeof reportedFreshInputTokens === "number" && Number.isFinite(reportedFreshInputTokens)
      ? Math.max(0, reportedFreshInputTokens)
      : Math.max(0, inputTokens);
  return {
    inputTokens,
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? undefined,
  };
}`;
const SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PATCH = `  const cacheWriteTokens =
    usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens ?? undefined;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? undefined;
  const reportedCostUsd = usage.reportedCostUsd;
  const normalizedReportedCostUsd =
    typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0
      ? reportedCostUsd
      : undefined;
  if (reportedCostUsd !== undefined && normalizedReportedCostUsd === undefined) return null;
  if (!(inputTokens > 0 || outputTokens > 0 || normalizedReportedCostUsd !== undefined)) return null;
  const reportedFreshInputTokens = usage.inputTokenDetails?.noCacheTokens ?? usage.freshInputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    (cacheReadTokens !== undefined && (!Number.isSafeInteger(cacheReadTokens) || cacheReadTokens < 0)) ||
    (cacheWriteTokens !== undefined && (!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0)) ||
    (reasoningTokens !== undefined && (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)) ||
    (reportedFreshInputTokens !== undefined &&
      (!Number.isSafeInteger(reportedFreshInputTokens) || reportedFreshInputTokens < 0))
  )
    return null;
  const inputBreakdownComplete = reportedFreshInputTokens !== undefined;
  const freshInputTokens = inputBreakdownComplete ? reportedFreshInputTokens : inputTokens;
  const normalizedUsage = {
    inputTokens,
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    reportedCostUsd: normalizedReportedCostUsd,
  };
  Object.defineProperty(normalizedUsage, "inputBreakdownComplete", {
    value: inputBreakdownComplete,
    enumerable: false,
  });
  return normalizedUsage;
}`;
const SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PREDECESSOR_PATCH = `  const cacheWriteTokens =
    usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens ?? undefined;
  const reportedCostUsd = usage.reportedCostUsd;
  const normalizedReportedCostUsd =
    typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0
      ? reportedCostUsd
      : undefined;
  if (!(inputTokens > 0 || outputTokens > 0 || normalizedReportedCostUsd !== undefined)) return null;
  const reportedFreshInputTokens = usage.inputTokenDetails?.noCacheTokens ?? usage.freshInputTokens;
  const freshInputTokens =
    typeof reportedFreshInputTokens === "number" && Number.isFinite(reportedFreshInputTokens)
      ? Math.max(0, reportedFreshInputTokens)
      : Math.max(0, inputTokens);
  return {
    inputTokens,
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? undefined,
    reportedCostUsd: normalizedReportedCostUsd,
  };
}`;
const SMITHERS_ENGINE_REPORTED_COST_PRICE_SOURCE = `function estimateReportedCostUsd(model, usage) {
  const price = modelTokenPrices(model);
  if (![price.input, price.output, price.cacheRead, price.cacheWrite].some((value) => value > 0)) return undefined;
  return estimateCostUsd({
    model,
    inputTokens: usage.freshInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}`;
const SMITHERS_ENGINE_REPORTED_COST_PRICE_PATCH = `function estimateReportedCostUsd(model, usage) {
  if (usage.reportedCostUsd !== undefined) return usage.reportedCostUsd;
  if (usage.inputBreakdownComplete !== true) return undefined;
  const accountedInputTokens =
    usage.freshInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (accountedInputTokens !== usage.inputTokens) return undefined;
  const price = modelTokenPrices(model);
  if (![price.input, price.output, price.cacheRead, price.cacheWrite].some((value) => value > 0)) return undefined;
  return estimateCostUsd({
    model,
    inputTokens: usage.freshInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}

function createCumulativeAgentUsageState() {
  let completedUsage = null;
  let completedCostUsd = 0;
  let completedPricingComplete = true;
  let activeUsage = null;
  let activeModelId = "unknown";
  const optionalComponents = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
  /**
   * @param {NonNullable<ReturnType<typeof normalizeTokenUsage>> | null} left
   * @param {NonNullable<ReturnType<typeof normalizeTokenUsage>>} right
   */
  const mergeInvocations = (left, right) => {
    const inputBreakdownComplete =
      (left === null || left.inputBreakdownComplete === true) && right.inputBreakdownComplete === true;
    const merged = {
      inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
      outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
      ...(inputBreakdownComplete
        ? { freshInputTokens: (left?.freshInputTokens ?? 0) + right.freshInputTokens }
        : {}),
    };
    for (const component of optionalComponents) {
      const leftValue = left?.[component];
      const rightValue = right[component];
      if ((left === null || leftValue !== undefined) && rightValue !== undefined) {
        merged[component] = (leftValue ?? 0) + rightValue;
      }
    }
    Object.defineProperty(merged, "inputBreakdownComplete", {
      value: inputBreakdownComplete,
      enumerable: false,
    });
    return merged;
  };
  const finalizeActive = () => {
    if (!activeUsage) return;
    const invocationCostUsd = estimateReportedCostUsd(activeModelId, activeUsage);
    completedUsage = mergeInvocations(completedUsage, activeUsage);
    if (completedPricingComplete && invocationCostUsd !== undefined) {
      completedCostUsd += invocationCostUsd;
    } else {
      completedPricingComplete = false;
    }
    activeUsage = null;
  };
  return {
    begin() {
      // Progress-only providers still expose a valid last invocation snapshot.
      finalizeActive();
      activeModelId = "unknown";
    },
    /**
     * @param {NonNullable<ReturnType<typeof normalizeTokenUsage>>} usage
     * @param {string} reportedModelId
     * @param {string} agentId
     * @param {boolean} finalize
     */
    snapshot(usage, reportedModelId, agentId, finalize = false) {
      activeUsage = usage;
      activeModelId = reportedModelId;
      const cumulativeUsage = mergeInvocations(completedUsage, usage);
      const invocationCostUsd = estimateReportedCostUsd(reportedModelId, usage);
      const costUsd =
        completedPricingComplete && invocationCostUsd !== undefined
          ? completedCostUsd + invocationCostUsd
          : undefined;
      const snapshot = { usage: cumulativeUsage, costUsd, reportedModelId, agentId };
      if (finalize) finalizeActive();
      return snapshot;
    },
  };
}`;
const SMITHERS_ENGINE_REPORTED_COST_PRICE_PREDECESSOR_PATCH = SMITHERS_ENGINE_REPORTED_COST_PRICE_PATCH.replace(
  `  if (usage.inputBreakdownComplete !== true) return undefined;
  const accountedInputTokens =
    usage.freshInputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (accountedInputTokens !== usage.inputTokens) return undefined;
`,
  ""
);

// A CLI process can report several billed model responses before its terminal
// agent_end/onExit. The pinned engine records usage only after generate settles,
// so a controller crash leaves a durable Pi session but no TokenUsageReported
// row. Pi emits cumulative `usage` events at every authoritative message_end.
// Persist each snapshot behind the attempt's session checkpoint and a fresh
// heartbeat-ownership proof. Both Smithers' usage table and Ultrafuzz's ledger
// treat later snapshots for the same attempt as replacements, not additions.
const SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_SOURCE = `        /**
         * @param {AgentCliEvent} event
         */
        handleAgentEvent = (event) => {
          if (heartbeatOwnerLost) return;
          recordInternalHeartbeat();
          afterHeartbeatOwnership(async () => {
            attemptMeta.agentEngine = event.engine ?? attemptMeta.agentEngine;
            let checkpointWrite = null;
            if ("resume" in event && typeof event.resume === "string") {
              attemptMeta.agentResume = event.resume;
              checkpointWrite = enqueueAgentCheckpoint(
                {
                  codec: CLI_SESSION_CHECKPOINT_CODEC,
                  version: 1,
                  payload: { engine: event.engine ?? attemptMeta.agentEngine, resume: event.resume },
                },
                "session",
                { allowLegacy: true },
              );
            }
            recordInternalHeartbeat({
              agentEngine: event.engine,
              ...(typeof event.resume === "string" ? { agentResume: event.resume } : {}),
            });
            if (event.type === "completed") {
              cliTurnCompletion.complete();
              if (!responseText && event.answer) {
                responseText = event.answer;
              }
            }
            if (event.type === "action" && isBlockingAgentActionKind(event.action.kind)) {
              if (event.phase === "started") {
                activeCliActions.add(event.action.id);
                extendToolActivityLease();
              } else if (event.phase === "completed") activeCliActions.delete(event.action.id);
            }
            void eventBus.emitEventQueued({
              type: "AgentEvent",
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              engine: event.engine,
              event,
              timestampMs: nowMs(),
            });
            void maybeCompleteHijack(true).catch(() => {});
            if (checkpointWrite) {
              try {
                await checkpointWrite;
              } catch (error) {
                logWarning(
                  "failed to persist CLI session checkpoint",
                  {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    engine: event.engine,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  "engine:agent-checkpoint",
                );
              }
            }
          });
        };`;
const SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_PATCH = `        const agentUsageAccumulator = createCumulativeAgentUsageState();
        const beginAgentUsageInvocation = () => agentUsageAccumulator.begin();
        let agentUsagePersistence = Promise.resolve();
        /**
         * @param {ReturnType<typeof normalizeTokenUsage>} usage
         * @param {string} reportedModelId
         * @param {string} agentId
         * @param {(AgentCliEvent & { model?: unknown, usage?: unknown }) | null} agentEvent
         * @param {boolean} finalizeInvocation
         */
        const persistOwnedAgentUsage = (
          usage,
          reportedModelId,
          agentId,
          agentEvent = null,
          finalizeInvocation = false,
        ) => {
          if (!usage) return Promise.resolve(false);
          const timestampMs = nowMs();
          const snapshot = agentUsageAccumulator.snapshot(
            usage,
            reportedModelId,
            agentId,
            finalizeInvocation,
          );
          const tokenUsageEvent = eventBus.attachCorrelation({
            type: "TokenUsageReported",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            model: snapshot.reportedModelId,
            agent: snapshot.agentId,
            ...snapshot.usage,
            ...(snapshot.costUsd !== undefined ? { costUsd: snapshot.costUsd } : {}),
            timestampMs,
          });
          const persistence = agentUsagePersistence
            .then(async () => {
              const stored = await Effect.runPromise(
                adapter.recordRunTokenUsageOwned({
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration ?? 0,
                  attempt: attemptNo,
                  runtimeOwnerId: executionOwnerId,
                  model: snapshot.reportedModelId,
                  agent: snapshot.agentId,
                  ...snapshot.usage,
                  costUsd: snapshot.costUsd,
                  updatedAtMs: timestampMs,
                  event: tokenUsageEvent,
                }),
              );
              if (!stored) return false;
              if (agentEvent) {
                await eventBus.emitEventQueued({
                  type: "AgentEvent",
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  engine: agentEvent.engine,
                  event: agentEvent,
                  timestampMs,
                });
              }
              // The exact correlated payload committed with the usage row.
              // Normal publication now supplies listeners, metrics, and the
              // stream log; its DB insertion is exact-event idempotent.
              await eventBus.emitEventQueued(tokenUsageEvent);
              return true;
            })
            .catch((error) => {
              logWarning(
                "failed to persist owned agent usage",
                {
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  error: error instanceof Error ? error.message : String(error),
                },
                "engine:agent-usage",
              );
              return false;
            });
          agentUsagePersistence = persistence.then(() => undefined);
          return persistence;
        };
        /**
         * @param {AgentCliEvent & { model?: unknown, usage?: unknown }} event
         */
        const persistAgentUsageProgress = (event) => {
          const usage = event.type === "usage" ? normalizeTokenUsage(event.usage) : null;
          if (!usage) return Promise.resolve(false);
          const reportedModelId =
            (typeof event.model === "string" && event.model.length > 0 ? event.model : undefined) ??
            (typeof effectiveAgent.model === "string" ? effectiveAgent.model : undefined) ??
            "unknown";
          const agentId =
            (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
            effectiveAgent.constructor?.name ??
            "unknown";
          return persistOwnedAgentUsage(usage, reportedModelId, agentId, event);
        };
        /** @param {unknown} result */
        const persistAgentResultUsage = (result) => {
          const usage = normalizeTokenUsage(result?.usage ?? result?.totalUsage);
          if (!usage) return Promise.resolve(false);
          const reportedModelId =
            (typeof result?.response?.modelId === "string" && result.response.modelId.length > 0
              ? result.response.modelId
              : undefined) ??
            (typeof effectiveAgent.model === "string" ? effectiveAgent.model : undefined) ??
            "unknown";
          const agentId =
            (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
            effectiveAgent.constructor?.name ??
            "unknown";
          return persistOwnedAgentUsage(usage, reportedModelId, agentId, null, true);
        };
        /**
         * @param {AgentCliEvent} event
         */
        handleAgentEvent = (event) => {
          if (heartbeatOwnerLost) return;
          recordInternalHeartbeat();
          afterHeartbeatOwnership(async () => {
            attemptMeta.agentEngine = event.engine ?? attemptMeta.agentEngine;
            let checkpointWrite = null;
            if ("resume" in event && typeof event.resume === "string") {
              attemptMeta.agentResume = event.resume;
              checkpointWrite = enqueueAgentCheckpoint(
                {
                  codec: CLI_SESSION_CHECKPOINT_CODEC,
                  version: 1,
                  payload: { engine: event.engine ?? attemptMeta.agentEngine, resume: event.resume },
                },
                "session",
                { allowLegacy: true },
              );
            }
            recordInternalHeartbeat({
              agentEngine: event.engine,
              ...(typeof event.resume === "string" ? { agentResume: event.resume } : {}),
            });
            if (event.type === "completed") {
              cliTurnCompletion.complete();
              if (!responseText && event.answer) {
                responseText = event.answer;
              }
            }
            if (event.type === "action" && isBlockingAgentActionKind(event.action.kind)) {
              if (event.phase === "started") {
                activeCliActions.add(event.action.id);
                extendToolActivityLease();
              } else if (event.phase === "completed") activeCliActions.delete(event.action.id);
            }
            if (event.type === "usage" && checkpointWrite) {
              try {
                await checkpointWrite;
                checkpointWrite = null;
              } catch (error) {
                logWarning(
                  "failed to persist CLI session checkpoint",
                  {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    engine: event.engine,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  "engine:agent-checkpoint",
                );
                return;
              }
            }
            if (event.type === "usage") {
              await persistAgentUsageProgress(event);
            } else {
              void eventBus.emitEventQueued({
                type: "AgentEvent",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                engine: event.engine,
                event,
                timestampMs: nowMs(),
              });
            }
            void maybeCompleteHijack(true).catch(() => {});
            if (checkpointWrite) {
              try {
                await checkpointWrite;
              } catch (error) {
                logWarning(
                  "failed to persist CLI session checkpoint",
                  {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    engine: event.engine,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  "engine:agent-checkpoint",
                );
              }
            }
          });
        };`;

const SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_SOURCE = `                      const doGenerate = () => {
                        cliTurnCompletion.begin();
                        return effectiveAgent.generate({`;
const SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PREDECESSOR_PATCH = `                      const doGenerate = () => {
                        beginAgentUsageInvocation();
                        cliTurnCompletion.begin();
                        return effectiveAgent.generate({`;
const SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PATCH = `                      const doGenerate = () => {
                        beginAgentUsageInvocation();
                        cliTurnCompletion.begin();
                        return effectiveAgent.generate(
                          {
                          ultrafuzzTaskRuntime: agentTaskRuntime,`;

const SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_SOURCE = `            const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
            cliTurnCompletion.begin();
            const retryResult = await raceAgentCallAbort(`;
const SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_PATCH = `            const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
            beginAgentUsageInvocation();
            cliTurnCompletion.begin();
            const retryResult = await raceAgentCallAbort(`;

const SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_SOURCE = `            await Promise.all(pendingOwnershipChecks);
            await captureResultCheckpoint(retryResult, "schema-correction");`;
const SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_PATCH = `            await Promise.all(pendingOwnershipChecks);
            await persistAgentResultUsage(retryResult);
            await captureResultCheckpoint(retryResult, "schema-correction");`;

const SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_SOURCE = `      const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
      cliTurnCompletion.begin();
      const schemaRetryResult = await raceAgentCallAbort(`;
const SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_PATCH = `      const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
      beginAgentUsageInvocation();
      cliTurnCompletion.begin();
      const schemaRetryResult = await raceAgentCallAbort(`;

const SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_SOURCE = `      await Promise.all(pendingOwnershipChecks);
      await captureResultCheckpoint(schemaRetryResult, "schema-correction");`;
const SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_PATCH = `      await Promise.all(pendingOwnershipChecks);
      await persistAgentResultUsage(schemaRetryResult);
      await captureResultCheckpoint(schemaRetryResult, "schema-correction");`;

const SMITHERS_ENGINE_FAILED_USAGE_SOURCE = `              const costUsd = estimateReportedCostUsd(reportedModelId, failedUsage);
              void eventBus
                .emitEventQueued({
                  type: "TokenUsageReported",
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  model: reportedModelId,
                  agent:
                    (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                    effectiveAgent.constructor?.name ??
                    "unknown",
                  ...failedUsage,
                  ...(costUsd !== undefined ? { costUsd } : {}),
                  timestampMs: nowMs(),
                })
                .catch(() => {});
              await Effect.runPromise(
                adapter.recordRunTokenUsage({
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration ?? 0,
                  attempt: attemptNo,
                  model: reportedModelId,
                  agent:
                    (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                    effectiveAgent.constructor?.name ??
                    "unknown",
                  ...failedUsage,
                  costUsd,
                  updatedAtMs: nowMs(),
                }),
              ).catch(() => {});`;
const SMITHERS_ENGINE_FAILED_USAGE_PATCH = `              const agentId =
                (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                effectiveAgent.constructor?.name ??
                "unknown";
              await persistOwnedAgentUsage(failedUsage, reportedModelId, agentId, null, true);`;

const SMITHERS_ENGINE_FINAL_USAGE_SOURCE = `          const costUsd = estimateReportedCostUsd(reportedModelId, usage);
          void eventBus.emitEventQueued({
            type: "TokenUsageReported",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            model: reportedModelId,
            agent:
              (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
              effectiveAgent.constructor?.name ??
              "unknown",
            inputTokens,
            freshInputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            ...(costUsd !== undefined ? { costUsd } : {}),
            timestampMs: nowMs(),
          });
          // Same numbers, persisted as a queryable row. The event log stays
          // the audit trail; \`_smithers_run_usage\` is the authoritative
          // per-run total nobody has to replay events to compute (#1464
          // AWF-6, #1436). Awaited so the row is durable before the attempt
          // settles, but swallowed — usage accounting never fails a task.
          await Effect.runPromise(
            adapter.recordRunTokenUsage({
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration ?? 0,
              attempt: attemptNo,
              model: reportedModelId,
              agent:
                (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                effectiveAgent.constructor?.name ??
                "unknown",
              inputTokens,
              freshInputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              reasoningTokens,
              costUsd,
              updatedAtMs: nowMs(),
            }),
          ).catch(() => {});`;
const SMITHERS_ENGINE_FINAL_USAGE_PATCH = `          const agentId =
            (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
            effectiveAgent.constructor?.name ??
            "unknown";
          await persistOwnedAgentUsage(usage, reportedModelId, agentId, null, true);`;

// Smithers 0.35.0 flattens several CLI-specific token formats into one shape
// before the engine sees them. The providers disagree about whether their
// input counter includes or excludes cache reads/writes, so inference in the
// engine is ambiguous. Canonicalize while the wire event type is still known:
// inputTokens is provider-inclusive and freshInputTokens is the uncached share.
const SMITHERS_AGENTS_COMPLETED_USAGE_SOURCE = `function usageFromCompletedEvent(completedEvent) {
  const u = completedEvent?.usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const usage = {
    inputTokens: num(u.input_tokens) ?? num(u.inputTokens),
    outputTokens: num(u.output_tokens) ?? num(u.outputTokens),
    cacheReadTokens: num(u.cache_read_input_tokens) ?? num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens) ?? num(u.cacheWriteTokens),
    reasoningTokens: num(u.reasoning_tokens) ?? num(u.reasoningTokens) ?? num(u.outputTokenDetails?.reasoningTokens),
    totalTokens: num(u.total_tokens) ?? num(u.totalTokens),
  };
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}`;
const SMITHERS_AGENTS_COMPLETED_USAGE_PATCH = `function usageFromCompletedEvent(completedEvent) {
  const u = completedEvent?.usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) return undefined;
  const num = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const usd = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const engine = typeof completedEvent?.engine === "string" ? completedEvent.engine.toLowerCase() : "";
  const inputTokenDetails =
    u.inputTokenDetails && typeof u.inputTokenDetails === "object" && !Array.isArray(u.inputTokenDetails)
      ? u.inputTokenDetails
      : undefined;
  const outputTokenDetails =
    u.outputTokenDetails && typeof u.outputTokenDetails === "object" && !Array.isArray(u.outputTokenDetails)
      ? u.outputTokenDetails
      : undefined;
  if (
    (u.inputTokenDetails !== undefined && inputTokenDetails === undefined) ||
    (u.outputTokenDetails !== undefined && outputTokenDetails === undefined)
  )
    return undefined;
  const tokenValues = [
    u.input_tokens,
    u.inputTokens,
    u.output_tokens,
    u.outputTokens,
    u.cache_read_input_tokens,
    u.cached_input_tokens,
    u.cacheReadTokens,
    inputTokenDetails?.cacheReadTokens,
    u.cache_write_input_tokens,
    u.cache_creation_input_tokens,
    u.cacheWriteTokens,
    inputTokenDetails?.cacheWriteTokens,
    u.fresh_input_tokens,
    u.freshInputTokens,
    inputTokenDetails?.noCacheTokens,
    u.reasoning_tokens,
    u.reasoningTokens,
    outputTokenDetails?.reasoningTokens,
    u.total_tokens,
    u.totalTokens,
  ];
  if (tokenValues.some((value) => value !== undefined && num(value) === undefined)) return undefined;
  const rawReportedCostUsd = u.reported_cost_usd ?? u.reportedCostUsd;
  if (rawReportedCostUsd !== undefined && usd(rawReportedCostUsd) === undefined) return undefined;
  const rawInputTokens = num(u.input_tokens) ?? num(u.inputTokens);
  const outputTokens = num(u.output_tokens) ?? num(u.outputTokens);
  const cacheReadTokens =
    num(u.cache_read_input_tokens) ??
    num(u.cached_input_tokens) ??
    num(u.cacheReadTokens) ??
    num(inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens =
    num(u.cache_write_input_tokens) ??
    num(u.cache_creation_input_tokens) ??
    num(u.cacheWriteTokens) ??
    num(inputTokenDetails?.cacheWriteTokens);
  let inputTokens = rawInputTokens;
  let freshInputTokens =
    num(u.fresh_input_tokens) ?? num(u.freshInputTokens) ?? num(inputTokenDetails?.noCacheTokens);
  if (
    rawInputTokens !== undefined &&
    freshInputTokens === undefined &&
    (engine.includes("claude") || engine.includes("kimi"))
  ) {
    freshInputTokens = rawInputTokens;
    inputTokens = rawInputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  } else if (rawInputTokens !== undefined && freshInputTokens === undefined && engine.includes("codex")) {
    const cachedInputTokens = (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    if (cachedInputTokens <= rawInputTokens) freshInputTokens = rawInputTokens - cachedInputTokens;
  }
  const inferredTotalTokens =
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;
  const usage = {
    inputTokens,
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: num(u.reasoning_tokens) ?? num(u.reasoningTokens) ?? num(outputTokenDetails?.reasoningTokens),
    totalTokens: inferredTotalTokens ?? num(u.total_tokens) ?? num(u.totalTokens),
    reportedCostUsd: usd(rawReportedCostUsd),
  };
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
}`;

const SMITHERS_AGENTS_USAGE_ACCUMULATOR_SOURCE = `  const usage = {};
  let found = false;
  let countedIncremental = false;`;
const SMITHERS_AGENTS_USAGE_ACCUMULATOR_PATCH = `  const usage = {};
  let observationsComplete = true;
  const count = (value) => {
    if (value === undefined) return 0;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    observationsComplete = false;
    return 0;
  };
  let found = false;
  let countedIncremental = false;
  let inputBreakdownComplete = true;
  let reportedCostComplete = true;`;

const SMITHERS_AGENTS_CLAUDE_USAGE_SOURCE = `    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (u.input_tokens ?? 0);
      if (u.cache_read_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cache_creation_input_tokens;
      }
      found = true;
      countedIncremental = true;
      continue;
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      if (parsed.usage.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + parsed.usage.output_tokens;
      }
      found = true;
      countedIncremental = true;
      continue;
    }`;
const SMITHERS_AGENTS_CLAUDE_USAGE_PATCH = `    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      const freshInput = count(u.input_tokens);
      const cacheRead = count(u.cache_read_input_tokens);
      const cacheWrite = count(u.cache_write_input_tokens ?? u.cache_creation_input_tokens);
      usage.inputTokens = (usage.inputTokens ?? 0) + freshInput + cacheRead + cacheWrite;
      usage.freshInputTokens = (usage.freshInputTokens ?? 0) + freshInput;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
      usage.totalTokens = (usage.totalTokens ?? 0) + freshInput + cacheRead + cacheWrite;
      found = true;
      countedIncremental = true;
      continue;
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      const output = count(parsed.usage.output_tokens);
      usage.outputTokens = (usage.outputTokens ?? 0) + output;
      usage.totalTokens = (usage.totalTokens ?? 0) + output;
      found = true;
      countedIncremental = true;
      continue;
    }`;

const SMITHERS_AGENTS_CLAUDE_RESULT_USAGE_SOURCE = `    if (parsed.type === "result") {
      // Claude Code stream-json emits a terminal "result" event whose
      // top-level usage summarizes tokens already accumulated from the
      // per-message message_start/message_delta events. If we counted
      // those incrementally, skip this event to avoid double-counting.
      // Otherwise fall through so the usage is still captured.
      if (countedIncremental) {
        continue;
      }
    }`;
const SMITHERS_AGENTS_CLAUDE_RESULT_USAGE_PATCH = `    if (parsed.type === "result") {
      // Claude Code's terminal result summarizes the same independent fresh,
      // cache-read and cache-write components as message_start. Use it only
      // when incremental events were unavailable, otherwise it is a duplicate.
      if (countedIncremental) continue;
      if (parsed.usage && typeof parsed.usage === "object") {
        const u = parsed.usage;
        const freshInput = count(u.input_tokens ?? u.inputTokens);
        const cacheRead = count(u.cache_read_input_tokens ?? u.cacheReadTokens);
        const cacheWrite = count(
          u.cache_write_input_tokens ?? u.cache_creation_input_tokens ?? u.cacheWriteTokens,
        );
        const output = count(u.output_tokens ?? u.outputTokens);
        usage.inputTokens = (usage.inputTokens ?? 0) + freshInput + cacheRead + cacheWrite;
        usage.freshInputTokens = (usage.freshInputTokens ?? 0) + freshInput;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
        usage.outputTokens = (usage.outputTokens ?? 0) + output;
        usage.totalTokens =
          (usage.totalTokens ?? 0) + freshInput + cacheRead + cacheWrite + output;
        found = true;
      }
      continue;
    }`;

const SMITHERS_AGENTS_CODEX_USAGE_SOURCE = `    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens) {
        usage.inputTokens = (usage.inputTokens ?? 0) + u.input_tokens;
      }
      if (u.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + u.output_tokens;
      }
      if (u.cached_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cached_input_tokens;
      }
      found = true;
      continue;
    }`;
const SMITHERS_AGENTS_CODEX_USAGE_PATCH = `    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      const providerInput = count(u.input_tokens);
      const output = count(u.output_tokens);
      const cacheRead = count(u.cached_input_tokens ?? u.cache_read_input_tokens);
      const cacheWrite = count(u.cache_write_input_tokens ?? u.cache_creation_input_tokens);
      const cachedInput = cacheRead + cacheWrite;
      usage.inputTokens = (usage.inputTokens ?? 0) + providerInput;
      usage.outputTokens = (usage.outputTokens ?? 0) + output;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
      usage.totalTokens = (usage.totalTokens ?? 0) + providerInput + output;
      if (cachedInput <= providerInput && inputBreakdownComplete) {
        usage.freshInputTokens = (usage.freshInputTokens ?? 0) + providerInput - cachedInput;
      } else {
        inputBreakdownComplete = false;
        delete usage.freshInputTokens;
      }
      found = true;
      continue;
    }`;

const SMITHERS_AGENTS_OPENCODE_USAGE_SOURCE = `    if (parsed.type === "step_finish" && parsed.part?.tokens && typeof parsed.part.tokens === "object") {
      const tokens = parsed.part.tokens;
      const input = tokens.input ?? 0;
      const output = tokens.output ?? 0;
      const total = tokens.total ?? 0;
      const reasoning = tokens.reasoning ?? 0;
      const cacheRead = tokens.cache?.read ?? 0;
      const cacheWrite = tokens.cache?.write ?? 0;
      if (input > 0 || output > 0 || total > 0 || reasoning > 0 || cacheRead > 0 || cacheWrite > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + input;
        usage.outputTokens = (usage.outputTokens ?? 0) + output;
        usage.totalTokens = (usage.totalTokens ?? 0) + total;
        usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoning;
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
        found = true;
        continue;
      }
    }`;
const SMITHERS_AGENTS_OPENCODE_USAGE_PATCH = `    if (
      parsed.type === "step_finish" &&
      parsed.part &&
      typeof parsed.part === "object" &&
      !Array.isArray(parsed.part)
    ) {
      const tokensPresent = parsed.part.tokens !== undefined;
      const tokens =
        tokensPresent && parsed.part.tokens && typeof parsed.part.tokens === "object" && !Array.isArray(parsed.part.tokens)
          ? parsed.part.tokens
          : undefined;
      if (tokensPresent && !tokens) observationsComplete = false;
        if (tokens) {
        const cachePresent = tokens.cache !== undefined;
        const cache =
          cachePresent && tokens.cache && typeof tokens.cache === "object" && !Array.isArray(tokens.cache)
            ? tokens.cache
            : undefined;
        if (cachePresent && !cache) observationsComplete = false;
        const freshInput = count(tokens.input);
        const output = count(tokens.output);
        const reasoning = count(tokens.reasoning);
        const cacheRead = count(cache?.read);
        const cacheWrite = count(cache?.write);
        const providerInput = freshInput + cacheRead + cacheWrite;
        const providerOutput = output + reasoning;
        const total = providerInput + providerOutput;
        if (
          Number.isSafeInteger(providerInput) &&
          Number.isSafeInteger(providerOutput) &&
          Number.isSafeInteger(total)
        ) {
          usage.inputTokens = (usage.inputTokens ?? 0) + providerInput;
          usage.freshInputTokens = (usage.freshInputTokens ?? 0) + freshInput;
          usage.outputTokens = (usage.outputTokens ?? 0) + providerOutput;
          usage.totalTokens = (usage.totalTokens ?? 0) + total;
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoning;
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + cacheRead;
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + cacheWrite;
          found = true;
        } else {
          observationsComplete = false;
        }
      }
      const reportedCostUsd = parsed.part.cost;
      if (reportedCostUsd === undefined) {
        if (tokensPresent) reportedCostComplete = false;
      } else if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
        usage.reportedCostUsd = (usage.reportedCostUsd ?? 0) + reportedCostUsd;
        if (!Number.isFinite(usage.reportedCostUsd)) observationsComplete = false;
        found = true;
      } else {
        observationsComplete = false;
      }
      if (tokensPresent || reportedCostUsd !== undefined) continue;
    }`;

const SMITHERS_AGENTS_USAGE_RETURN_SOURCE = `  return found ? usage : undefined;
}`;
const SMITHERS_AGENTS_USAGE_RETURN_PATCH = `  if (!inputBreakdownComplete) delete usage.freshInputTokens;
  if (!reportedCostComplete) delete usage.reportedCostUsd;
  return found && observationsComplete ? usage : undefined;
}`;

const SMITHERS_AGENTS_RETAIN_USAGE_SCOPE_SOURCE = `    let diagnosticsPromise;
    let stdoutEmitter;
    let cleanup;
    let commandLogAnnotations = {};`;
const SMITHERS_AGENTS_RETAIN_USAGE_SCOPE_PATCH = `    let diagnosticsPromise;
    let stdoutEmitter;
    let cleanup;
    let commandLogAnnotations = {};
    let retainedUsage;`;

const SMITHERS_AGENTS_RETAIN_USAGE_EARLY_SOURCE = `            const stdout = typeof outputFileText === "string" ? outputFileText : result.stdout;
            if (result.exitCode && result.exitCode !== 0) {`;
const SMITHERS_AGENTS_RETAIN_USAGE_EARLY_PATCH = `            const stdout = typeof outputFileText === "string" ? outputFileText : result.stdout;
            const completedUsage = usageFromCompletedEvent(completedEvent);
            const cliUsage = result.stdoutTruncated
              ? completedUsage ?? extractUsageFromOutput(result.stdout)
              : extractUsageFromOutput(result.stdout) ?? completedUsage;
            retainedUsage = cliUsage
              ? {
                  inputTokens: cliUsage.inputTokens,
                  inputTokenDetails: {
                    noCacheTokens: cliUsage.freshInputTokens,
                    cacheReadTokens: cliUsage.cacheReadTokens,
                    cacheWriteTokens: cliUsage.cacheWriteTokens,
                  },
                  outputTokens: cliUsage.outputTokens,
                  outputTokenDetails: {
                    textTokens: undefined,
                    reasoningTokens: cliUsage.reasoningTokens,
                  },
                  totalTokens:
                    cliUsage.totalTokens ?? ((cliUsage.inputTokens ?? 0) + (cliUsage.outputTokens ?? 0) || undefined),
                  ...(cliUsage.reportedCostUsd === undefined
                    ? {}
                    : { reportedCostUsd: cliUsage.reportedCostUsd }),
                }
              : undefined;
            if (result.exitCode && result.exitCode !== 0) {`;

const SMITHERS_AGENTS_RETAIN_USAGE_LATE_SOURCE = `            // Extract token usage from raw stdout before text extraction strips it.
            // Each CLI harness embeds usage differently (NDJSON events, JSON stats, etc.)
            const cliUsage = extractUsageFromOutput(result.stdout) ?? usageFromCompletedEvent(completedEvent);
            const usage = cliUsage
              ? {
                  inputTokens: cliUsage.inputTokens,
                  inputTokenDetails: {
                    noCacheTokens: undefined,
                    cacheReadTokens: cliUsage.cacheReadTokens,
                    cacheWriteTokens: cliUsage.cacheWriteTokens,
                  },
                  outputTokens: cliUsage.outputTokens,
                  outputTokenDetails: {
                    textTokens: undefined,
                    reasoningTokens: cliUsage.reasoningTokens,
                  },
                  totalTokens:
                    cliUsage.totalTokens ?? ((cliUsage.inputTokens ?? 0) + (cliUsage.outputTokens ?? 0) || undefined),
                }
              : undefined;`;
const SMITHERS_AGENTS_RETAIN_USAGE_LATE_PATCH = `            // Usage was normalized before all failure checks so billed provider
            // work remains available even when the CLI exits unsuccessfully.
            const usage = retainedUsage;`;

const SMITHERS_AGENTS_RETAIN_USAGE_ERROR_SOURCE = `        Effect.tapError((err) =>
          Effect.all(`;
const SMITHERS_AGENTS_RETAIN_USAGE_ERROR_PATCH = `        Effect.tapError((err) => {
          if (retainedUsage && err && typeof err === "object") {
            try {
              if (err.usage === undefined) err.usage = retainedUsage;
            } catch {
              // Preserve the provider error if an exotic error is immutable.
            }
          }
          return Effect.all(`;
const SMITHERS_AGENTS_RETAIN_USAGE_ERROR_CLOSE_SOURCE = `            { discard: true },
          ),
        ),
        Effect.ensuring(`;
const SMITHERS_AGENTS_RETAIN_USAGE_ERROR_CLOSE_PATCH = `            { discard: true },
          );
        }),
        Effect.ensuring(`;

const SMITHERS_OPENCODE_USAGE_TOTALS_SOURCE = `    // Accumulate tokens across multiple step_finish events
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;`;
const SMITHERS_OPENCODE_USAGE_TOTALS_PATCH = `    // Accumulate canonical provider-inclusive tokens across every step.
    let totalInputTokens = 0;
    let totalFreshInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalReasoningTokens = 0;
    let totalReportedCostUsd = 0;
    let totalTokens = 0;
    let observationsComplete = true;
    let reportedCostComplete = true;
    let sawReportedCost = false;
    const count = (value) => {
      if (value === undefined) return 0;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
      observationsComplete = false;
      return 0;
    };
    const currentUsage = () =>
      observationsComplete
        ? {
            inputTokens: totalInputTokens,
            freshInputTokens: totalFreshInputTokens,
            cacheReadTokens: totalCacheReadTokens,
            cacheWriteTokens: totalCacheWriteTokens,
            outputTokens: totalOutputTokens,
            reasoningTokens: totalReasoningTokens,
            totalTokens,
            ...(reportedCostComplete && sawReportedCost ? { reportedCostUsd: totalReportedCostUsd } : {}),
          }
        : undefined;`;

const SMITHERS_OPENCODE_USAGE_STEP_SOURCE = `        if (tokens) {
          const input = typeof tokens.input === "number" ? tokens.input : 0;
          const output = typeof tokens.output === "number" ? tokens.output : 0;
          const total = typeof tokens.total === "number" ? tokens.total : 0;
          totalInputTokens += input;
          totalOutputTokens += output;
          totalTokens += total;
        }`;
const SMITHERS_OPENCODE_USAGE_STEP_PATCH = `        if (tokens) {
          const freshInput = count(tokens.input);
          const output = count(tokens.output);
          const reasoning = count(tokens.reasoning);
          const cache = isRecord(tokens.cache) ? tokens.cache : null;
          if (tokens.cache !== undefined && cache === null) observationsComplete = false;
          const cacheRead = count(cache?.read);
          const cacheWrite = count(cache?.write);
          const providerInput = freshInput + cacheRead + cacheWrite;
          const providerOutput = output + reasoning;
          totalInputTokens += providerInput;
          totalFreshInputTokens += freshInput;
          totalOutputTokens += providerOutput;
          totalCacheReadTokens += cacheRead;
          totalCacheWriteTokens += cacheWrite;
          totalReasoningTokens += reasoning;
          totalTokens += providerInput + providerOutput;
          if (
            !Number.isSafeInteger(totalInputTokens) ||
            !Number.isSafeInteger(totalOutputTokens) ||
            !Number.isSafeInteger(totalTokens)
          )
            observationsComplete = false;
        } else if (part.tokens !== undefined) {
          observationsComplete = false;
        }
        const reportedCostUsd = part.cost;
        if (reportedCostUsd === undefined) {
          if (part.tokens !== undefined) reportedCostComplete = false;
        } else if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
          totalReportedCostUsd += reportedCostUsd;
          sawReportedCost = true;
          if (!Number.isFinite(totalReportedCostUsd)) observationsComplete = false;
        } else {
          observationsComplete = false;
        }`;

const SMITHERS_OPENCODE_USAGE_COMPLETED_SOURCE = `              resume: sessionId || undefined,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalTokens,
              },`;
const SMITHERS_OPENCODE_USAGE_COMPLETED_PATCH = `              resume: sessionId || undefined,
              usage: currentUsage(),`;

const SMITHERS_OPENCODE_USAGE_ERROR_SOURCE = `            answer: fullText || undefined,
            error: errorMessage ?? "OpenCode reported an error",
          },`;
const SMITHERS_OPENCODE_USAGE_ERROR_PATCH = `            answer: fullText || undefined,
            error: errorMessage ?? "OpenCode reported an error",
            usage: currentUsage(),
          },`;

const SMITHERS_OPENCODE_USAGE_EXIT_SOURCE = `            answer: isSuccess ? fullText || undefined : undefined,
            error: isSuccess ? undefined : (terminalError ?? \`OpenCode exited with code \${result.exitCode ?? -1}\`),
          },`;
const SMITHERS_OPENCODE_USAGE_EXIT_PATCH = `            answer: isSuccess ? fullText || undefined : undefined,
            error: isSuccess ? undefined : (terminalError ?? \`OpenCode exited with code \${result.exitCode ?? -1}\`),
            usage: currentUsage(),
          },`;

export type SmithersCompatibilityPatchId =
  | "local_delegation"
  | "detached_snapshot_transfer"
  | "supervisor_descriptor"
  | "resume_snapshot_transfer"
  | "terminal_state_restore"
  | "resume_hydration"
  | "engine_agent_event_ownership"
  | "engine_agent_usage_progress"
  | "engine_main_usage_invocation"
  | "engine_json_correction_usage_invocation"
  | "engine_json_correction_usage_result"
  | "engine_schema_correction_usage_invocation"
  | "engine_schema_correction_usage_result"
  | "engine_failed_usage_ownership"
  | "engine_final_usage_ownership"
  | "engine_reported_cost_normalize"
  | "engine_reported_cost_price"
  | "agents_completed_usage"
  | "agents_usage_accumulator"
  | "agents_claude_usage"
  | "agents_claude_result_usage"
  | "agents_codex_usage"
  | "agents_opencode_usage"
  | "agents_usage_return"
  | "agents_retain_usage_scope"
  | "agents_retain_usage_early"
  | "agents_retain_usage_late"
  | "agents_retain_usage_error"
  | "agents_retain_usage_error_close"
  | "opencode_usage_totals"
  | "opencode_usage_step"
  | "opencode_usage_completed"
  | "opencode_usage_error"
  | "opencode_usage_exit"
  | "workflow_path_import"
  | "workflow_path_persistence"
  | "process_snapshot_anchor"
  | "manifest_relaunch"
  | "post_failure_workflow_path"
  | "replay_workflow_path"
  | "replay_workflow_metadata"
  | "fork_workflow_path"
  | "fork_workflow_metadata"
  | "lifecycle_trace_summary"
  | "engine_workflow_path_import"
  | "engine_workflow_path"
  | "engine_durability_metadata"
  | "engine_run_metadata"
  | "engine_resume_identity"
  | "engine_refresh_path_acceptance"
  | "engine_insert_workflow_path"
  | "engine_activate_workflow_path"
  | "engine_update_workflow_path"
  | "engine_continuation_workflow_path"
  | "workflow_hash_import"
  | "workflow_hash_collect"
  | "workflow_hash_entry"
  | "workflow_hash_recursion"
  | "workflow_hash_public"
  | "event_probe_index"
  | "owned_usage";

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
  /** Exact earlier replacements that can be upgraded to `patched`. */
  readonly predecessors?: readonly string[];
  /** Patch-family markers that must not survive outside an exact replacement. */
  readonly patchedFamilyMarkers?: readonly string[];
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
    id: "local_delegation",
    packageName: "smthrs",
    sourceRelativePath: SMITHERS_BIN_PATH,
    patchable: SMITHERS_BIN_LOCAL_DELEGATION_SOURCE,
    patched: SMITHERS_BIN_LOCAL_DELEGATION_PATCH,
    upstreamAbsent: ["ULTRAFUZZ_DISABLE_LOCAL_SMITHERS_DELEGATION"]
  },
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
    predecessors: [
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PREDECESSOR_PATCH,
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PRESERVE_SYMLINKS_PREDECESSOR_PATCH
    ],
    patchedFamilyMarkers: ["ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR"],
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
    id: "engine_agent_event_ownership",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_SOURCE,
    patched: SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_PATCH,
    // Upstream coalescing its own in-flight proof retires this patch.
    upstreamAbsent: ["heartbeatOwnershipCheckInFlight"]
  },
  {
    id: "engine_agent_usage_progress",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_SOURCE,
    patched: SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_PATCH,
    upstreamAbsent: ["persistAgentUsageProgress"]
  },
  {
    id: "engine_main_usage_invocation",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_SOURCE,
    patched: SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PATCH,
    predecessors: [SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PREDECESSOR_PATCH],
    upstreamAbsent: ["beginAgentUsageInvocation"]
  },
  {
    id: "engine_json_correction_usage_invocation",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_SOURCE,
    patched: SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_PATCH,
    upstreamAbsent: ["persistAgentResultUsage"]
  },
  {
    id: "engine_json_correction_usage_result",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_SOURCE,
    patched: SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_PATCH,
    upstreamAbsent: ["persistAgentResultUsage"]
  },
  {
    id: "engine_schema_correction_usage_invocation",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_SOURCE,
    patched: SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_PATCH,
    upstreamAbsent: ["persistAgentResultUsage"]
  },
  {
    id: "engine_schema_correction_usage_result",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_SOURCE,
    patched: SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_PATCH,
    upstreamAbsent: ["persistAgentResultUsage"]
  },
  {
    id: "engine_failed_usage_ownership",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_FAILED_USAGE_SOURCE,
    patched: SMITHERS_ENGINE_FAILED_USAGE_PATCH,
    upstreamAbsent: ["await persistOwnedAgentUsage(failedUsage"]
  },
  {
    id: "engine_final_usage_ownership",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_FINAL_USAGE_SOURCE,
    patched: SMITHERS_ENGINE_FINAL_USAGE_PATCH,
    upstreamAbsent: ["await persistOwnedAgentUsage(usage"]
  },
  {
    id: "engine_reported_cost_normalize",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_SOURCE,
    patched: SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PATCH,
    predecessors: [SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PREDECESSOR_PATCH],
    upstreamAbsent: ["reportedCostUsd"]
  },
  {
    id: "engine_reported_cost_price",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_REPORTED_COST_PRICE_SOURCE,
    patched: SMITHERS_ENGINE_REPORTED_COST_PRICE_PATCH,
    predecessors: [SMITHERS_ENGINE_REPORTED_COST_PRICE_PREDECESSOR_PATCH],
    upstreamAbsent: []
  },
  {
    id: "agents_completed_usage",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_COMPLETED_USAGE_SOURCE,
    patched: SMITHERS_AGENTS_COMPLETED_USAGE_PATCH,
    upstreamAbsent: ["fresh_input_tokens) ?? num(u.freshInputTokens)"]
  },
  {
    id: "agents_usage_accumulator",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_USAGE_ACCUMULATOR_SOURCE,
    patched: SMITHERS_AGENTS_USAGE_ACCUMULATOR_PATCH,
    upstreamAbsent: ["let inputBreakdownComplete = true"]
  },
  {
    id: "agents_claude_usage",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_CLAUDE_USAGE_SOURCE,
    patched: SMITHERS_AGENTS_CLAUDE_USAGE_PATCH,
    upstreamAbsent: ["usage.freshInputTokens = (usage.freshInputTokens ?? 0) + freshInput"]
  },
  {
    id: "agents_claude_result_usage",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_CLAUDE_RESULT_USAGE_SOURCE,
    patched: SMITHERS_AGENTS_CLAUDE_RESULT_USAGE_PATCH,
    upstreamAbsent: ["Claude Code's terminal result summarizes the same independent fresh"]
  },
  {
    id: "agents_codex_usage",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_CODEX_USAGE_SOURCE,
    patched: SMITHERS_AGENTS_CODEX_USAGE_PATCH,
    upstreamAbsent: ["const cachedInput = cacheRead + cacheWrite"]
  },
  {
    id: "agents_opencode_usage",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_OPENCODE_USAGE_SOURCE,
    patched: SMITHERS_AGENTS_OPENCODE_USAGE_PATCH,
    upstreamAbsent: ["const providerOutput = output + reasoning"]
  },
  {
    id: "agents_usage_return",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_USAGE_RETURN_SOURCE,
    patched: SMITHERS_AGENTS_USAGE_RETURN_PATCH,
    upstreamAbsent: ["if (!inputBreakdownComplete) delete usage.freshInputTokens"]
  },
  {
    id: "agents_retain_usage_scope",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_RETAIN_USAGE_SCOPE_SOURCE,
    patched: SMITHERS_AGENTS_RETAIN_USAGE_SCOPE_PATCH,
    upstreamAbsent: ["let retainedUsage;"]
  },
  {
    id: "agents_retain_usage_early",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_RETAIN_USAGE_EARLY_SOURCE,
    patched: SMITHERS_AGENTS_RETAIN_USAGE_EARLY_PATCH,
    upstreamAbsent: ["const completedUsage = usageFromCompletedEvent(completedEvent)"]
  },
  {
    id: "agents_retain_usage_late",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_RETAIN_USAGE_LATE_SOURCE,
    patched: SMITHERS_AGENTS_RETAIN_USAGE_LATE_PATCH,
    upstreamAbsent: ["const usage = retainedUsage;"]
  },
  {
    id: "agents_retain_usage_error",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_RETAIN_USAGE_ERROR_SOURCE,
    patched: SMITHERS_AGENTS_RETAIN_USAGE_ERROR_PATCH,
    upstreamAbsent: ["err.usage = retainedUsage"]
  },
  {
    id: "agents_retain_usage_error_close",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/BaseCliAgent/BaseCliAgent.js",
    patchable: SMITHERS_AGENTS_RETAIN_USAGE_ERROR_CLOSE_SOURCE,
    patched: SMITHERS_AGENTS_RETAIN_USAGE_ERROR_CLOSE_PATCH,
    upstreamAbsent: []
  },
  {
    id: "opencode_usage_totals",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/OpenCodeAgent.js",
    patchable: SMITHERS_OPENCODE_USAGE_TOTALS_SOURCE,
    patched: SMITHERS_OPENCODE_USAGE_TOTALS_PATCH,
    upstreamAbsent: ["let totalFreshInputTokens = 0"]
  },
  {
    id: "opencode_usage_step",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/OpenCodeAgent.js",
    patchable: SMITHERS_OPENCODE_USAGE_STEP_SOURCE,
    patched: SMITHERS_OPENCODE_USAGE_STEP_PATCH,
    upstreamAbsent: ["totalCacheWriteTokens += cacheWrite"]
  },
  {
    id: "opencode_usage_completed",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/OpenCodeAgent.js",
    patchable: SMITHERS_OPENCODE_USAGE_COMPLETED_SOURCE,
    patched: SMITHERS_OPENCODE_USAGE_COMPLETED_PATCH,
    upstreamAbsent: ["usage: currentUsage()"]
  },
  {
    id: "opencode_usage_error",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/OpenCodeAgent.js",
    patchable: SMITHERS_OPENCODE_USAGE_ERROR_SOURCE,
    patched: SMITHERS_OPENCODE_USAGE_ERROR_PATCH,
    upstreamAbsent: ['error: errorMessage ?? "OpenCode reported an error",\n            usage: currentUsage()']
  },
  {
    id: "opencode_usage_exit",
    packageName: "@smthrs/agents",
    sourceRelativePath: "src/OpenCodeAgent.js",
    patchable: SMITHERS_OPENCODE_USAGE_EXIT_SOURCE,
    patched: SMITHERS_OPENCODE_USAGE_EXIT_PATCH,
    upstreamAbsent: ["usage: currentUsage(),"]
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
    predecessors: [
      SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PREDECESSOR_PATCH,
      SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_NESTED_PREDECESSOR_PATCH
    ],
    patchedFamilyMarkers: ["anchorUltrafuzzExecutionSnapshotForProcess"],
    upstreamAbsent: ["anchorUltrafuzzExecutionSnapshotForProcess"]
  },
  {
    id: "manifest_relaunch",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: SMITHERS_CLI_MANIFEST_RELAUNCH_SOURCE,
    patched: SMITHERS_CLI_MANIFEST_RELAUNCH_PATCH,
    upstreamAbsent: ["relaunchSnapshotTransfer"]
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
    id: "lifecycle_trace_summary",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/observability-helpers.js",
    patchable: SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_SOURCE,
    patched: SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_PATCH,
    upstreamAbsent: ['"AgentTraceSummary"']
  },
  {
    id: "engine_workflow_path_import",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_SOURCE,
    patched: SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_PATCH,
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
    id: "engine_refresh_path_acceptance",
    packageName: "@smthrs/engine",
    sourceRelativePath: "src/engine.js",
    patchable: SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_SOURCE,
    patched: SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_PATCH,
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
  },
  {
    id: "event_probe_index",
    packageName: "@smthrs/db",
    sourceRelativePath: "src/schema-migrations.js",
    patchable: SMITHERS_DB_EVENT_PROBE_INDEX_SOURCE,
    patched: SMITHERS_DB_EVENT_PROBE_INDEX_PATCH,
    // Upstream creating its own probe-covering events index retires the family.
    upstreamAbsent: ["_smithers_events_insert_probe_v2_idx"]
  },
  {
    id: "owned_usage",
    packageName: "@smthrs/db",
    sourceRelativePath: "src/adapter.js",
    patchable: SMITHERS_DB_FENCED_USAGE_SOURCE,
    patched: SMITHERS_DB_FENCED_USAGE_PATCH,
    upstreamAbsent: ["recordRunTokenUsageOwned"]
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
  "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_DATA_GOVERNANCE_PATH",
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
const SMITHERS_CONTROLLER_ENVIRONMENT_VARIABLES = new Set([
  "SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS",
  "SMITHERS_KEEP_WORKTREES",
  "SMITHERS_MONITOR_SUPPRESS"
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
  exhaustedLoops: CurrentSmithersExhaustedLoop[];
}

/**
 * The pre-resume ownership evidence a controller refresh already collected, so
 * the lifecycle command reuses it instead of inspecting the same run twice.
 * `missing` records the one outcome refresh tolerates and the full-output
 * envelope contract does not: a Smithers identity with no recorded history.
 */
export type SmithersResumeInspection =
  { status: "missing" } | { status: "present"; snapshot: SmithersCommandSnapshot; inspect: CurrentSmithersInspect };

export interface CurrentSmithersExhaustedLoop {
  id: string;
  iteration: number;
  maxIterations: number | null;
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
  sourceRevision?: string;
  sourceRef?: string;
  workflowName?: string;
  renderedPrompts: readonly RenderedPromptPlan[];
  operatorPrompt?: string;
  operatorInput?: unknown;
  env?: Record<string, string | undefined>;
  controllerSourceDigest?: string;
  dataGovernance?: RunDataGovernanceReference;
  vulnerabilityDatabase?: { relative_path: string; sha256: string };
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

export type DynamicPromptRuntimeContext = SmithersTaskManifestDynamicPromptRuntimeContext;

export type CompiledSmithersDynamicGroup = SmithersTaskManifestDynamicGroup;

export interface CompiledSmithersWorkflow {
  schemaVersion: typeof SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION;
  runId: string;
  smithersRunId: string;
  workflowName: string;
  tasks: readonly CompiledSmithersTask[];
  dynamicGroups: readonly CompiledSmithersDynamicGroup[];
  maxDynamicNodes: number;
  replacePromptSchemas: boolean;
  /** Attempts whose group explicitly quarantines failures from independent branches. */
  nonBlockingAttemptIds: readonly string[];
  /**
   * Execution-only prompt bindings by attempt ID. Emitted into the task-spec
   * literal, never into the compiled task manifest -- the manifest must stay
   * byte-identical to the sealed base so verifyDynamicRuntimeMaterialization
   * can re-derive the published tasks.json from it.
   */
  retainedPromptPaths?: Readonly<Record<string, string>>;
  projectRoot: string;
  runRoot: string;
  sourceRevision?: string;
  sourceRef?: string;
  workflowPath: string;
  evidenceWorkflowPath: string;
  expandedGraphPath: string;
  configPath: string;
  resolvedConfigPath: string;
  executionConfigPath: string;
  inputPath: string;
  tasksPath: string;
  logsDir: string;
  pinnedSubmodules?: PinnedSubmoduleExpectation;
  productionSourceRoots?: string[];
  controllerSourceDigest: string;
  dataGovernance?: RunDataGovernanceReference;
}

export interface RefreshedSmithersControllerSnapshot {
  snapshot: VerifiedWorkflowControlSnapshot;
  controllerSourceDigest: string;
  semanticFingerprint: string;
}

/**
 * Bind a continuation's plan-time prompts to their authenticated retained
 * snapshots WITHOUT moving the binding into the task manifest.
 *
 * The compiled task keeps `plan.json`'s sealed launch path, because the
 * controller publishes that manifest into `smithers/tasks.json` and
 * `verifyDynamicRuntimeMaterialization` re-derives it from the sealed
 * `controls/runtime-base-tasks.json` by whole-document fingerprint. Rebinding
 * the manifest field made the refreshed controller publish a document that no
 * longer re-derives, so every gated lifecycle command failed
 * `WORKFLOW_CONTROL_EVIDENCE_INVALID` for the rest of the run's life.
 *
 * The retained snapshot is returned alongside instead, and reaches only the
 * task-spec literal, which is what actually binds the bytes the agent opens.
 * The manifest field is a NAME that has to re-derive from the seal, not a
 * pointer to authenticated bytes: no execution path reads it, and the one place
 * that does open it -- `smithersExecutionControlFiles`, on launch -- hard-requires
 * it to equal its `plan.json` row, which is exactly what this normalization
 * restores and what the rebinding used to violate.
 */
function currentControllerPromptBindings(
  layout: RunLayout,
  tasks: SmithersTaskManifestDocument
): { tasks: readonly CompiledSmithersTask[]; retainedPromptPaths: Record<string, string> } {
  const plan = readRunPlanDocument(path.join(layout.root, "plan.json"), layout.runId);
  const plannedPrompts = new Map(plan.rendered_prompts.map((prompt) => [prompt.attempt_id, prompt]));
  const retainedPromptPaths: Record<string, string> = {};
  const bound = tasks.tasks.map((task) => {
    if (task.renderedPromptPath === undefined) return task;
    // A prompt deferred to the dynamic runtime is never rendered at plan time, so `plan.json` has
    // no row to rebind it to and no retained snapshot to authenticate against. That covers every
    // generated task and every planned task with a dynamic ancestor, whose prompt the runtime
    // re-derives from the sealed template and republishes under the task's own artifact directory.
    // `verifyDynamicRuntimeMaterialization` is what holds those bytes to their seal. Requiring a
    // plan row here instead made `--refresh-controller` throw
    // `persisted prompt plan does not match continuation task ...` for every run that had expanded
    // a dynamic group -- exactly the stopped runs a refresh exists to rescue.
    if ((task.deferredPromptGroups ?? []).length > 0) return task;
    const planned = plannedPrompts.get(task.attemptId);
    if (planned === undefined) {
      throw new Error(`persisted prompt plan does not match continuation task ${task.attemptId}`);
    }
    const snapshotPath = safeResolveInside(
      layout.root,
      planned.rendered_prompt_snapshot_path,
      `retained rendered prompt snapshot for ${task.attemptId}`
    );
    if (task.renderedPromptPath !== planned.rendered_prompt_path && task.renderedPromptPath !== snapshotPath) {
      throw new Error(`persisted prompt plan does not match continuation task ${task.attemptId}`);
    }
    assertRegularFileInside(layout.root, snapshotPath, `retained rendered prompt snapshot for ${task.attemptId}`);
    assertNoSymlinkComponents(layout.root, snapshotPath, `retained rendered prompt snapshot for ${task.attemptId}`);
    const contents = readRegularFileSnapshot(snapshotPath, MAX_WORKFLOW_EXECUTION_FILE_BYTES).toString("utf8");
    if (sha256Stable(contents) !== planned.rendered_prompt_digest) {
      throw new Error(`retained rendered prompt snapshot digest does not match task ${task.attemptId}`);
    }
    retainedPromptPaths[task.attemptId] = snapshotPath;
    // The manifest keeps the SEALED launch path so the published tasks.json re-derives from
    // controls/runtime-base-tasks.json. `smithersExecutionControlFiles` rejects any compiled task
    // whose renderedPromptPath diverges from its plan row, so this normalization is byte-exact for
    // any run that sealed -- and it also scrubs a manifest already poisoned by a prior refresh.
    // The authenticated retained snapshot binds the bytes the agent reads, via the task-spec
    // literal only (see renderWorkflowSource / taskSpecsFromCompiled).
    return { ...task, renderedPromptPath: planned.rendered_prompt_path };
  });
  // A silently missing binding would fall back to the launch path, which retry cleanup owns and may
  // have deleted, and which is read with no digest gate. Fail loudly instead.
  for (const task of bound) {
    if (task.renderedPromptPath === undefined) continue;
    if ((task.deferredPromptGroups ?? []).length > 0) continue;
    if (!Object.hasOwn(retainedPromptPaths, task.attemptId)) {
      throw new Error(`continuation prompt binding is missing for ${task.attemptId}`);
    }
  }
  return { tasks: bound, retainedPromptPaths };
}

/**
 * The task manifest a refreshed controller must compile in.
 *
 * `<runRoot>/smithers/runtime-base-tasks.json` is the byte copy of the task
 * manifest taken when the run was sealed, before any dynamic group expanded.
 * The live `smithers/tasks.json` is rewritten by every materialization and so
 * carries the generated tasks as well -- and the controller's compiled task
 * array is precisely what the dynamic runtime takes as `baseTasks` and reserves
 * against the next expansion. Compiling the generated tasks back into that base
 * set reserves their own attempt IDs against the expansion that produced them,
 * and the first materialization after the refresh dies with
 * `DYNAMIC_NODE_ID_COLLISION` -- i.e. `resume --refresh-controller` could not
 * restart any run past its first expansion, exactly the runs a refresh exists
 * to rescue.
 *
 * `refreshedSmithersControllerSnapshot` makes the same selection out of the
 * sealed `controls/runtime-base-tasks.json`; this is the un-sealed path's
 * equivalent, and the two now agree on which document is authoritative.
 *
 * The seal writes this file only for a run that has dynamic groups, so a run
 * without them has none and keeps compiling the live manifest, which for it is
 * already the base set. A run with dynamic groups that has not expanded yet has
 * the file, and its bytes equal the live manifest, so nothing changes there
 * either.
 */
function currentControllerBaseTasks(
  layout: RunLayout,
  tasks: SmithersTaskManifestDocument
): SmithersTaskManifestDocument {
  const baseTasksPath = path.join(layout.root, "smithers", "runtime-base-tasks.json");
  if (!fs.existsSync(baseTasksPath)) return tasks;
  assertRegularFileInside(layout.root, baseTasksPath, "dynamic runtime base task manifest");
  assertNoSymlinkComponents(layout.root, baseTasksPath, "dynamic runtime base task manifest");
  const document = parseSealedTaskDocument(readRegularFileSnapshot(baseTasksPath, MAX_WORKFLOW_EXECUTION_FILE_BYTES));
  if (document.run_id !== layout.runId) {
    throw new Error("controller refresh base task manifest does not match the run ID");
  }
  return document;
}

/**
 * Render the current controller beside, rather than over, the source that
 * originally launched a stopped run. Smithers records this path and its
 * workflow hash as continuation provenance; neither value authorizes resume.
 */
export function renderCurrentSmithersController(input: {
  projectRoot: string;
  layout: RunLayout;
  smithersRunId: string;
  tasks: SmithersTaskManifestDocument;
  config: ResolvedConfig;
  expandedGraph?: unknown;
}): string {
  const projectRoot = path.resolve(input.projectRoot);
  const baseTaskDocument = currentControllerBaseTasks(input.layout, input.tasks);
  const { tasks, retainedPromptPaths } = currentControllerPromptBindings(input.layout, baseTaskDocument);
  const generationRoot = path.join(projectRoot, ".smithers", "continuations", crypto.randomUUID());
  const workflowPath = path.join(generationRoot, "workflows", `ultrafuzz-${input.layout.runId}.tsx`);
  const packagedController = loadPackagedControllerSource();
  for (const file of packagedController.files) {
    writePreparedWorkflowFile(projectRoot, path.join(generationRoot, "agents", file.name), file.contents, "controller");
  }
  const nonBlockingAttempts = new Set(
    tasks.flatMap((task) => (task.optionalDependencyArtifactDirs ?? []).map((directory) => path.basename(directory)))
  );
  const graph = isObjectRecord(input.expandedGraph) ? input.expandedGraph : {};
  const groups = isObjectRecord(graph.groups) ? graph.groups : {};
  for (const task of tasks) {
    const groupId = task.metadata.node.group;
    const group = groupId === undefined ? undefined : groups[groupId];
    const defaults = isObjectRecord(group) && isObjectRecord(group.defaults) ? group.defaults : {};
    if (defaults.failure_policy === "continue") nonBlockingAttempts.add(task.attemptId);
  }
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: input.layout.runId,
    smithersRunId: input.smithersRunId,
    workflowName: baseTaskDocument.workflow_name,
    tasks,
    dynamicGroups: baseTaskDocument.dynamic_groups ?? [],
    maxDynamicNodes: input.config.run.maxDynamicNodes,
    replacePromptSchemas: true,
    nonBlockingAttemptIds: [...nonBlockingAttempts].sort(compareWorkflowExecutionStrings),
    retainedPromptPaths,
    projectRoot,
    runRoot: input.layout.root,
    ...(baseTaskDocument.source_revision === undefined ? {} : { sourceRevision: baseTaskDocument.source_revision }),
    ...(baseTaskDocument.source_ref === undefined ? {} : { sourceRef: baseTaskDocument.source_ref }),
    workflowPath,
    evidenceWorkflowPath: path.join(input.layout.root, "smithers", "workflow.tsx"),
    expandedGraphPath: path.join(input.layout.root, "smithers", "expanded-graph.json"),
    configPath: path.join(input.layout.root, "smithers", "config.fingerprint-input"),
    resolvedConfigPath: path.join(input.layout.root, "smithers", "resolved-config.json"),
    executionConfigPath: path.join(input.layout.root, "smithers", "execution-config.toml"),
    inputPath: path.join(input.layout.root, "smithers", "input.json"),
    tasksPath: path.join(input.layout.root, "smithers", "tasks.json"),
    logsDir: path.join(input.layout.root, "smithers", "logs"),
    productionSourceRoots: input.config.permissions.productionSourceRoots,
    controllerSourceDigest: packagedController.digest,
    ...(baseTaskDocument.pinned_submodules === null ? {} : { pinnedSubmodules: baseTaskDocument.pinned_submodules })
  };
  writePreparedWorkflowFile(
    projectRoot,
    workflowPath,
    renderWorkflowSource(compiled, input.config),
    "current continuation workflow"
  );
  return workflowPath;
}

/**
 * Rebuild the controller-owned portion of an already sealed workflow from the
 * currently installed, stock Ultrafuzz packages. Campaign inputs remain the
 * exact bytes authenticated by the launch seal. The effective snapshot is the
 * authenticated committed head and supplies the append-only execution path set;
 * the original seal remains the root and semantic authority. A compatibility
 * refresh is deliberately narrower than an upgrade: existing module paths
 * cannot vanish from the refreshed generation, so a non-schema path retired by
 * the current package retains its authenticated bytes. The sealed dependency
 * map remains authoritative. New Ultrafuzz-owned module files are admitted only
 * from the installed package root and become explicit members of the new
 * generation manifest. Newly required runner compatibility replacements are
 * applied only to their exact sealed package paths and bytes before the
 * refreshed generation is authenticated.
 */
export function refreshedSmithersControllerSnapshot(input: {
  projectRoot: string;
  layout: RunLayout;
  original: VerifiedWorkflowControlSnapshot;
  /** Authenticated committed controller head; defaults to the original seal for a first refresh. */
  effective?: VerifiedWorkflowControlSnapshot;
  config: ResolvedConfig;
}): RefreshedSmithersControllerSnapshot {
  const projectRoot = path.resolve(input.projectRoot);
  const effective = input.effective ?? input.original;
  if (
    controllerRefreshCampaignSemanticFingerprint(effective) !==
    controllerRefreshCampaignSemanticFingerprint(input.original)
  ) {
    throw new Error("effective controller generation is not rooted in the sealed campaign semantics");
  }
  const currentTaskDocument = parseSealedTaskDocument(input.original.contents.tasks);
  if (currentTaskDocument.run_id !== input.layout.runId) {
    throw new Error("controller refresh task manifest does not match the run ID");
  }
  const dynamicBaseTasks = input.original.executionFiles.find(
    (file) => file.snapshotPath === DYNAMIC_BASE_TASKS_SNAPSHOT_PATH
  );
  const taskDocument =
    dynamicBaseTasks === undefined ? currentTaskDocument : parseSealedTaskDocument(dynamicBaseTasks.contents);
  if (taskDocument.run_id !== input.layout.runId) {
    throw new Error("controller refresh base task manifest does not match the run ID");
  }
  const expandedGraph = assertExpandedGraphSchema(parseStrictJsonBytes(input.original.contents.expanded_graph));
  const nonBlockingAttemptIds = taskDocument.tasks
    .filter((task) => {
      const group = task.metadata.node.group;
      return group !== undefined && expandedGraph.groups[group]?.defaults?.failure_policy === "continue";
    })
    .map((task) => task.attemptId)
    .sort();
  const source = loadPackagedControllerSource();
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: input.layout.runId,
    smithersRunId: taskDocument.smithers_run_id,
    workflowName: taskDocument.workflow_name,
    tasks: taskDocument.tasks,
    dynamicGroups: taskDocument.dynamic_groups ?? [],
    maxDynamicNodes: input.config.run.maxDynamicNodes,
    replacePromptSchemas: true,
    nonBlockingAttemptIds,
    projectRoot,
    runRoot: input.layout.root,
    ...(taskDocument.source_revision === undefined ? {} : { sourceRevision: taskDocument.source_revision }),
    ...(taskDocument.source_ref === undefined ? {} : { sourceRef: taskDocument.source_ref }),
    workflowPath: input.original.paths.workflowPath,
    evidenceWorkflowPath: input.original.paths.evidenceWorkflowPath,
    expandedGraphPath: input.original.paths.expandedGraphPath,
    configPath: input.original.paths.configPath,
    resolvedConfigPath: executionFileSourcePath(input.original, "controls/resolved-config.json"),
    executionConfigPath: executionFileSourcePath(input.original, "controls/ultrafuzz.toml"),
    inputPath: input.original.paths.inputPath,
    tasksPath: input.original.paths.tasksPath,
    logsDir: path.join(input.layout.root, "smithers", "logs"),
    productionSourceRoots: input.config.permissions.productionSourceRoots,
    controllerSourceDigest: source.digest,
    ...(taskDocument.pinned_submodules === null ? {} : { pinnedSubmodules: taskDocument.pinned_submodules })
  };

  const executionFiles = replaceBunStartupControlsForControllerRefresh(input.layout, effective.executionFiles);
  replaceStockAgentFiles(source, executionFiles);
  const dependencyMap = refreshedControllerDependencyMap(executionFiles);
  replaceInternalModuleFiles(
    executionFiles,
    dependencyMap,
    input.original.executionFiles,
    currentWorkflowModuleRoots(compiled)
  );
  applyRefreshedSmithersCompatibilityPatches(executionFiles, dependencyMap);
  const workflow = Buffer.from(renderWorkflowSource(compiled, input.config), "utf8");
  const semanticFingerprint = controllerRefreshSemanticFingerprint(input.original);
  return {
    snapshot: {
      ...input.original,
      contents: { ...input.original.contents, workflow },
      executionFiles
    },
    controllerSourceDigest: source.digest,
    semanticFingerprint
  };
}

function parseSealedTaskDocument(contents: Buffer): SmithersTaskManifestDocument {
  const value = parseStrictJsonBytes(contents);
  assertValidSmithersTaskManifest(value);
  return value;
}

function executionFileSourcePath(snapshot: VerifiedWorkflowControlSnapshot, snapshotPath: string): string {
  const file = snapshot.executionFiles.find((candidate) => candidate.snapshotPath === snapshotPath);
  if (file === undefined) throw new Error(`controller refresh is missing sealed ${snapshotPath}`);
  return file.sourcePath;
}

function replaceStockAgentFiles(
  source: PackagedControllerSource,
  files: Array<WorkflowExecutionControlFile & { contents: Buffer }>
): void {
  const prefix = ".smithers/agents/";
  const sealed = files.filter((file) => file.snapshotPath.startsWith(prefix));
  const current = source.files.map((file) => ({
    snapshotPath: `${prefix}${file.name}`,
    contents: file.contents
  }));
  assertSameControllerPathSet(sealed, current, "stock controller adapters");
  const byPath = new Map(current.map((file) => [file.snapshotPath, file.contents]));
  for (const file of sealed) {
    file.contents = Buffer.from(byPath.get(file.snapshotPath)!);
  }
}

function refreshedControllerDependencyMap(
  files: readonly (WorkflowExecutionControlFile & { contents: Buffer })[]
): WorkflowExecutionDependenciesDocument {
  const dependencyManifest = files.find(
    (file) => file.snapshotPath === WORKFLOW_EXECUTION_DEPENDENCY_MAP_SNAPSHOT_PATH
  );
  if (dependencyManifest === undefined) {
    throw new Error("controller refresh is missing its sealed dependency map");
  }
  return parseRuntimeDocumentBytes(
    WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
    dependencyManifest.contents,
    "controller refresh dependency map"
  );
}

function replaceInternalModuleFiles(
  files: Array<WorkflowExecutionControlFile & { contents: Buffer }>,
  dependencyMap: WorkflowExecutionDependenciesDocument,
  rootAuthorityFiles: readonly (WorkflowExecutionControlFile & { contents: Buffer })[],
  currentModuleRoots: ReadonlyMap<string, string>
): void {
  const rootAuthorityByPath = new Map(rootAuthorityFiles.map((file) => [file.snapshotPath, file]));
  const byModule = new Map<string, Array<WorkflowExecutionControlFile & { contents: Buffer }>>();
  for (const file of files) {
    const match = /^modules\/(@ultrafuzz\/[^/]+)\/(.+)$/u.exec(file.snapshotPath);
    if (match === null) continue;
    const entries = byModule.get(match[1]!) ?? [];
    entries.push(file);
    byModule.set(match[1]!, entries);
  }
  for (const [moduleName, sealed] of byModule) {
    const manifestSnapshotPath = path.posix.join("modules", moduleName, "package.json");
    const sealedManifest = sealed.find((file) => file.snapshotPath === manifestSnapshotPath);
    if (sealedManifest === undefined) {
      throw new Error(`controller module ${moduleName} is missing its sealed package manifest`);
    }
    // A committed generation's source paths point into its immutable snapshot,
    // while the launch seal's paths may identify an older compatible Ultrafuzz
    // installation. An explicit refresh must adopt the package closure that is
    // executing it. Packages absent from that stock closure (for example a
    // retired or synthetic sealed module) retain their authenticated launch
    // context.
    const rootAuthorityManifest = rootAuthorityByPath.get(manifestSnapshotPath);
    if (rootAuthorityManifest === undefined) {
      throw new Error(`controller module ${moduleName} is missing its root package manifest authority`);
    }
    const currentModuleRoot = currentModuleRoots.get(moduleName);
    const moduleRoot = currentModuleRoot ?? workflowPackageRoot(rootAuthorityManifest.sourcePath);
    const packageJsonPath = path.join(moduleRoot, "package.json");
    if (
      currentModuleRoot === undefined &&
      fs.realpathSync(packageJsonPath) !== fs.realpathSync(rootAuthorityManifest.sourcePath)
    ) {
      throw new Error(`controller module ${moduleName} has a mismatched sealed package manifest path`);
    }
    const manifest = readWorkflowPackageManifest(packageJsonPath);
    if (manifest.name !== moduleName) {
      throw new Error(`controller module package manifest name does not match ${moduleName}`);
    }
    const currentManifest = readRegularFileSnapshot(packageJsonPath, MAX_WORKFLOW_EXECUTION_FILE_BYTES);
    if (!currentManifest.equals(sealedManifest.contents)) {
      throw new Error(
        `controller module ${moduleName} changed its package manifest; controller refresh cannot change dependency or executable authority`
      );
    }
    const candidates = [packageJsonPath];
    for (const directory of ["dist", "schema"]) {
      const root = path.join(moduleRoot, directory);
      if (fs.existsSync(root)) candidates.push(...walkExecutionFiles(root));
    }
    const dockerfile = path.join(moduleRoot, "Dockerfile");
    if (fs.existsSync(dockerfile)) candidates.push(dockerfile);
    const current = candidates.map((sourcePath) => ({
      sourcePath,
      snapshotPath: path.posix.join("modules", moduleName, relativeExecutionPath(moduleRoot, sourcePath)),
      contents: readRegularFileSnapshot(sourcePath, MAX_WORKFLOW_EXECUTION_FILE_BYTES),
      executable: (fs.statSync(sourcePath).mode & 0o111) !== 0
    }));
    assertRefreshedModuleAuthority(moduleName, current, dependencyMap);
    const schemaPrefix = path.posix.join("modules", moduleName, "schema/");
    const sealedSchemaPaths = sealed
      .map((file) => file.snapshotPath)
      .filter((snapshotPath) => snapshotPath.startsWith(schemaPrefix))
      .sort(compareWorkflowExecutionStrings);
    const currentSchemaPaths = current
      .map((file) => file.snapshotPath)
      .filter((snapshotPath) => snapshotPath.startsWith(schemaPrefix))
      .sort(compareWorkflowExecutionStrings);
    if (JSON.stringify(sealedSchemaPaths) !== JSON.stringify(currentSchemaPaths)) {
      throw new Error(`controller module ${moduleName} changed its sealed schema path authority`);
    }
    const currentByPath = new Map(current.map((file) => [file.snapshotPath, file]));
    for (const file of sealed) {
      // Schemas bind campaign output semantics. Controller code may refresh,
      // but its schema directory must remain the exact sealed generation.
      if (file.snapshotPath.startsWith(schemaPrefix)) continue;
      const replacement = currentByPath.get(file.snapshotPath);
      // A compatible package may retire a non-schema file. Its authenticated
      // bytes remain append-only authority for the durable run instead of
      // making that lineage non-resumable or silently deleting the path.
      if (replacement === undefined) continue;
      file.sourcePath = replacement.sourcePath;
      file.contents = replacement.contents;
    }
    const sealedPaths = new Set(sealed.map((file) => file.snapshotPath));
    for (const file of current.filter(
      (candidate) => !sealedPaths.has(candidate.snapshotPath) && !candidate.snapshotPath.startsWith(schemaPrefix)
    )) {
      files.push({
        sourcePath: file.sourcePath,
        snapshotPath: file.snapshotPath,
        contents: file.contents
      });
    }
  }
}

function currentWorkflowModuleRoots(compiled: CompiledSmithersWorkflow): ReadonlyMap<string, string> {
  const queuedModules = Object.values(workflowModuleEntryUrls(compiled)).filter(
    (value): value is string => value.length > 0
  );
  const rootsByName = new Map<string, string>();
  const visitedRoots = new Set<string>();
  while (queuedModules.length > 0) {
    const entryPath = fileURLToPath(queuedModules.shift()!);
    const moduleRoot = workflowPackageRoot(entryPath);
    if (visitedRoots.has(moduleRoot)) continue;
    visitedRoots.add(moduleRoot);
    const manifest = readWorkflowPackageManifest(path.join(moduleRoot, "package.json"));
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@ultrafuzz/")) {
      throw new Error(`controller refresh module is not an Ultrafuzz runtime package: ${entryPath}`);
    }
    const existing = rootsByName.get(manifest.name);
    if (existing !== undefined && existing !== moduleRoot) {
      throw new Error(`controller refresh resolved multiple invoking roots for ${manifest.name}`);
    }
    rootsByName.set(manifest.name, moduleRoot);
    if (!isObjectRecord(manifest.dependencies)) continue;
    for (const dependency of Object.keys(manifest.dependencies).filter((name) => name.startsWith("@ultrafuzz/"))) {
      const dependencyRoot = fs.realpathSync(path.join(moduleRoot, "node_modules", ...dependency.split("/")));
      queuedModules.push(pathToFileURL(path.join(dependencyRoot, "package.json")).href);
    }
  }
  return rootsByName;
}

function assertRefreshedModuleAuthority(
  moduleName: string,
  files: readonly {
    sourcePath: string;
    snapshotPath: string;
    contents: Buffer;
    executable: boolean;
  }[],
  dependencyMap: WorkflowExecutionDependenciesDocument
): void {
  const modules = dependencyMap.modules.filter((candidate) => candidate.name === moduleName);
  if (modules.length !== 1) {
    throw new Error(`controller module ${moduleName} does not have exactly one sealed dependency identity`);
  }
  const module = modules[0]!;
  if (module.id !== `module:${moduleName}` || module.snapshot_path !== path.posix.join("modules", moduleName)) {
    throw new Error(`controller module ${moduleName} differs from its sealed dependency identity`);
  }
  const issuers = dependencyMap.issuers.filter((candidate) => candidate.id === module.id);
  if (issuers.length !== 1 || issuers[0]!.snapshot_path !== module.snapshot_path) {
    throw new Error(`controller module ${moduleName} does not have exactly one sealed dependency issuer`);
  }
  const dependencies = new Set(Object.keys(issuers[0]!.dependencies));
  const executablePaths = new Set(dependencyMap.executable_paths);
  for (const file of files) {
    if (file.executable !== executablePaths.has(file.snapshotPath)) {
      throw new Error(`controller module ${moduleName} changed executable authority for ${file.snapshotPath}`);
    }
    if (!/\.(?:c|m)?js$/u.test(file.snapshotPath)) continue;
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(file.contents);
    } catch {
      throw new Error(`controller module ${moduleName} source ${file.snapshotPath} is not valid UTF-8`);
    }
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const specifier = imported.fileName;
      if (specifier.startsWith(".") || isBuiltin(specifier) || specifier === "bun") continue;
      const segments = specifier.split("/");
      const dependencyName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
      if (dependencyName === moduleName || dependencies.has(dependencyName)) continue;
      throw new Error(
        `controller module ${moduleName} source ${file.snapshotPath} imports ${dependencyName} outside its sealed dependency authority`
      );
    }
  }
}

function applyRefreshedSmithersCompatibilityPatches(
  files: Array<WorkflowExecutionControlFile & { contents: Buffer }>,
  dependencyMap: WorkflowExecutionDependenciesDocument
): void {
  const bySnapshotPath = new Map(files.map((file) => [file.snapshotPath, file]));
  if (bySnapshotPath.size !== files.length) {
    throw new Error("controller refresh execution paths are duplicated");
  }
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES) {
    const packages = dependencyMap.packages.filter((candidate) => candidate.name === patch.packageName);
    // Explicit external runners do not belong to the sealed dependency closure.
    if (packages.length === 0) continue;
    if (packages.length !== 1) {
      throw new Error(`controller refresh has multiple sealed roots for ${patch.packageName}`);
    }
    const dependency = packages[0]!;
    if (dependency.version !== SMITHERS_VERSION) {
      throw new Error(`controller refresh ${patch.packageName} dependency must remain at ${SMITHERS_VERSION}`);
    }
    const packageManifestPath = path.posix.join(dependency.snapshot_path, "package.json");
    const packageManifest = bySnapshotPath.get(packageManifestPath);
    if (packageManifest === undefined) {
      throw new Error(`controller refresh is missing sealed runner package manifest ${packageManifestPath}`);
    }
    const packageMetadata = parseStrictJsonBytes(packageManifest.contents);
    if (
      !isObjectRecord(packageMetadata) ||
      packageMetadata.name !== patch.packageName ||
      packageMetadata.version !== SMITHERS_VERSION
    ) {
      throw new Error(`controller refresh sealed package metadata differs for ${patch.packageName}`);
    }
    const snapshotPath = path.posix.join(dependency.snapshot_path, patch.sourceRelativePath);
    const source = bySnapshotPath.get(snapshotPath);
    if (source === undefined) {
      throw new Error(`controller refresh is missing sealed runner source ${snapshotPath}`);
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(source.contents);
    } catch {
      throw new Error(`authenticated controller runner ${patch.id} source is not valid UTF-8`);
    }
    source.contents = Buffer.from(
      applyRequiredSmithersPatch(
        contents,
        patch.patchable,
        patch.patched,
        `authenticated controller runner ${patch.id}`,
        patch.predecessors,
        patch.patchedFamilyMarkers
      ),
      "utf8"
    );
  }
}

function assertSameControllerPathSet(
  sealed: readonly { snapshotPath: string }[],
  current: readonly { snapshotPath: string }[],
  label: string
): void {
  const left = sealed.map((file) => file.snapshotPath).sort(compareWorkflowExecutionStrings);
  const right = current.map((file) => file.snapshotPath).sort(compareWorkflowExecutionStrings);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} changed its execution closure; controller refresh requires an exact path set`);
  }
}

function controllerRefreshSemanticFingerprint(snapshot: VerifiedWorkflowControlSnapshot): string {
  return controllerRefreshSemanticFingerprintWithStartupControls(snapshot, true);
}

function controllerRefreshCampaignSemanticFingerprint(snapshot: VerifiedWorkflowControlSnapshot): string {
  // Generation manifests already persist the original full fingerprint. Keep
  // that authority byte-compatible while excluding only the controller-owned
  // controls that a compatibility refresh is explicitly allowed to replace.
  return controllerRefreshSemanticFingerprintWithStartupControls(snapshot, false);
}

function controllerRefreshSemanticFingerprintWithStartupControls(
  snapshot: VerifiedWorkflowControlSnapshot,
  includeStartupControls: boolean
): string {
  const dynamicBaseGraph = snapshot.executionFiles.find(
    (file) => file.snapshotPath === DYNAMIC_BASE_GRAPH_SNAPSHOT_PATH
  );
  const dynamicBaseTasks = snapshot.executionFiles.find(
    (file) => file.snapshotPath === DYNAMIC_BASE_TASKS_SNAPSHOT_PATH
  );
  if ((dynamicBaseGraph === undefined) !== (dynamicBaseTasks === undefined)) {
    throw new Error("controller refresh has an incomplete dynamic control base");
  }
  const hash = crypto
    .createHash("sha256")
    .update(
      includeStartupControls
        ? "ultrafuzz-controller-refresh-semantics-v1\0"
        : "ultrafuzz-controller-refresh-campaign-semantics-v1\0"
    );
  for (const key of ["graph", "expanded_graph", "graph_fingerprint", "config", "tasks", "input"] as const) {
    const bytes =
      key === "graph" && dynamicBaseGraph !== undefined
        ? dynamicBaseGraph.contents
        : key === "tasks" && dynamicBaseTasks !== undefined
          ? dynamicBaseTasks.contents
          : snapshot.contents[key];
    hash.update(`${key}\0${bytes.byteLength}\0`).update(bytes);
  }
  for (const file of snapshot.executionFiles
    .filter(
      (candidate) =>
        candidate.snapshotPath.startsWith("controls/") &&
        (includeStartupControls || !isBunStartupControlPath(candidate.snapshotPath))
    )
    .sort((left, right) => compareWorkflowExecutionStrings(left.snapshotPath, right.snapshotPath))) {
    hash.update(`${file.snapshotPath}\0${file.contents.byteLength}\0`).update(file.contents);
  }
  return hash.digest("hex");
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
  const source = sourceRevisionForCompilation(input, projectRoot);
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
  const referenceAttemptsByNodeId = new Map<string, string[]>();
  for (const node of input.graph.nodes.filter((candidate) => candidate.kind === "reference")) {
    referenceAttemptsByNodeId.set(
      node.id,
      nodeAttemptsFor(node).map((attempt) => attempt.attemptId)
    );
  }
  const renderedByAttempt = new Map(input.renderedPrompts.map((prompt) => [prompt.attempt_id, prompt]));
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const dynamicNodeIds = new Set(
    input.graph.nodes.filter((candidate) => candidate.dynamic !== undefined).map((candidate) => candidate.id)
  );
  const referenceArtifactManifestAuthorityCache = new Map<
    string,
    SmithersTaskManifestReferenceArtifactManifestAuthority
  >();
  const compiledTasks = input.graph.nodes.flatMap((node) =>
    nodeAttemptsFor(node)
      .filter(() => node.kind === "agentic" && node.dynamic === undefined)
      .map((attempt) => {
        const renderedPrompt = renderedByAttempt.get(attempt.attemptId) ?? renderedByAttempt.get(node.id);
        const ancestorNodeIds = artifactAncestorNodeIds(node.id, input.graph.nodes);
        return compileTask({
          config: input.config,
          env: input.env ?? {},
          graph: input.graph,
          node,
          attempt,
          runLayout: input.runLayout,
          sourceRevision: source?.revision,
          sourceRef: source?.ref,
          workflowName,
          renderedPromptPath: renderedPrompt?.rendered_prompt_path,
          promptTemplatePath:
            dynamicAncestorGroupsForNode(node, nodeById).length === 0
              ? undefined
              : snapshotPromptTemplate(input.runLayout, input.graph, node),
          dynamicDependencies: node.dependsOn.filter((dependency) => dynamicNodeIds.has(dependency)),
          deferredPromptGroups: dynamicAncestorGroupsForNode(node, nodeById),
          promptArtifactAuthoritySelectors: promptArtifactAuthoritySelectorsFor(renderedPrompt),
          dependencyAttemptIds: node.dependsOn.flatMap((dependency) =>
            dynamicNodeIds.has(dependency) ? [] : (attemptsByNodeId.get(dependency) ?? [])
          ),
          dependencyAgenticAttemptIds: node.dependsOn.flatMap((dependency) =>
            dynamicNodeIds.has(dependency) ? [] : (agenticAttemptsByNodeId.get(dependency) ?? [])
          ),
          artifactDependencyAttemptIds: ancestorNodeIds.flatMap((ancestor) =>
            dynamicNodeIds.has(ancestor) ? [] : (attemptsByNodeId.get(ancestor) ?? [])
          ),
          dependencyReferenceAttemptIds: node.dependsOn.flatMap(
            (dependency) => referenceAttemptsByNodeId.get(dependency) ?? []
          ),
          referenceArtifactManifestAuthorities: referenceArtifactManifestAuthoritiesForAncestors(
            ancestorNodeIds,
            input.graph.nodes,
            input.runLayout,
            referenceArtifactManifestAuthorityCache
          ),
          ...(input.vulnerabilityDatabase === undefined ? {} : { vulnerabilityDatabase: input.vulnerabilityDatabase })
        });
      })
  );
  const dynamicGroups = input.graph.nodes
    .filter(
      (node): node is ExpandedNode & { dynamic: NonNullable<ExpandedNode["dynamic"]> } => node.dynamic !== undefined
    )
    .map((node) =>
      compileDynamicGroup({
        input,
        node,
        nodeById,
        attemptsByNodeId,
        agenticAttemptsByNodeId,
        referenceAttemptsByNodeId,
        referenceArtifactManifestAuthorityCache,
        sourceRevision: source?.revision,
        sourceRef: source?.ref,
        projectRoot,
        workflowName
      })
    );
  const nonBlockingAttemptIds = compiledTasks
    .filter((task) => {
      const group = task.metadata.node.group;
      return group !== undefined && input.graph.groups[group]?.defaults?.failure_policy === "continue";
    })
    .map((task) => task.attemptId)
    .sort();
  const nonBlockingAttemptIdSet = new Set(nonBlockingAttemptIds);
  const tasks = compiledTasks.map((task) => ({
    ...task,
    optionalDependencyArtifactDirs: task.dependencyArtifactDirs.filter((directory) =>
      nonBlockingAttemptIdSet.has(path.basename(directory))
    )
  }));
  const smithersDir = path.join(input.runLayout.root, "smithers");
  fs.mkdirSync(smithersDir, { recursive: true });
  const evidenceWorkflowPath = path.join(smithersDir, "workflow.tsx");
  const expandedGraphPath = path.join(smithersDir, "expanded-graph.json");
  const configPath = path.join(smithersDir, "config.fingerprint-input");
  const resolvedConfigPath = path.join(smithersDir, "resolved-config.json");
  const resolvedConfigBytes = serializeResolvedConfigJsonBytes(input.config);
  const executionConfigPath = path.join(smithersDir, "execution-config.toml");
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
  const pinnedSubmodules = source?.pinned === true ? pinnedSubmoduleExpectationForProject(projectRoot) : undefined;
  enablePinnedSubmoduleWorktreeConfig(projectRoot, pinnedSubmodules);
  const compiled: CompiledSmithersWorkflow = {
    schemaVersion: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    runId: input.runLayout.runId,
    smithersRunId,
    workflowName,
    tasks,
    dynamicGroups,
    maxDynamicNodes: input.config.run.maxDynamicNodes,
    replacePromptSchemas: false,
    nonBlockingAttemptIds,
    projectRoot,
    runRoot: input.runLayout.root,
    ...(source === undefined ? {} : { sourceRevision: source.revision, sourceRef: source.ref }),
    workflowPath,
    evidenceWorkflowPath,
    expandedGraphPath,
    configPath,
    resolvedConfigPath,
    executionConfigPath,
    inputPath,
    tasksPath,
    logsDir,
    productionSourceRoots: input.config.permissions.productionSourceRoots,
    controllerSourceDigest: input.controllerSourceDigest ?? inspectControllerSource(projectRoot).digest,
    ...(input.dataGovernance === undefined ? {} : { dataGovernance: input.dataGovernance }),
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
  writePreparedWorkflowFile(
    input.runLayout.root,
    executionConfigPath,
    serializeResolvedConfigToml(input.config),
    "reviewed workflow execution config"
  );
  const taskManifest: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_COMPILED_WORKFLOW_SCHEMA_VERSION,
    run_id: input.runLayout.runId,
    smithers_run_id: smithersRunId,
    workflow_name: workflowName,
    ...(source === undefined ? {} : { source_revision: source.revision, source_ref: source.ref }),
    pinned_submodules: pinnedSubmodules ?? null,
    tasks,
    dynamic_groups: dynamicGroups
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
    // "positive-only": these persisted bytes are the exact --input the
    // workflow runner byte-validates against the generated workflow's
    // compiled literals at detached-launch preflight. The speculative
    // heuristics flag the eval lane's bounded run ids (ci-<run_id>-…-<hex16>)
    // as secrets, so an "all" scan rewrote ultrafuzz_run_id to "<redacted>"
    // and every eval submission failed preflight as INVALID_INPUT (#899).
    // Positively identified credential formats are still redacted from the
    // operator-supplied free text this document can carry.
    `${JSON.stringify(
      redactSecretsInValue(
        smithersInputDocument(compiled, input.operatorPrompt, input.operatorInput),
        undefined,
        [],
        "positive-only"
      ),
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

function sourceRevisionForCompilation(
  input: Pick<SmithersCompileInput, "runLayout" | "sourceRevision" | "sourceRef">,
  projectRoot: string
): RunSourceRevision | undefined {
  if (input.sourceRevision === undefined && input.sourceRef === undefined) {
    return captureRunSourceRevision(projectRoot, input.runLayout.runId);
  }
  if (input.sourceRevision === undefined || input.sourceRef === undefined) {
    throw new Error("Smithers source revision and ref must be supplied together");
  }
  const source: RunSourceRevision = {
    revision: input.sourceRevision,
    ref: input.sourceRef,
    pinned: input.sourceRef === "refs/heads/ultrafuzz-pinned"
  };
  assertRunSourceRevision(projectRoot, source);
  return source;
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
  const dependencyProjectRoot = useExternalRunnerForExecutionClosure
    ? compiled.projectRoot
    : await operatorControllerProjectRoot(compiled.projectRoot, env);
  (() => {
    const candidate = path.join(layout.root, "smithers", "execution-tsconfig.json");
    writeFileDurable(candidate, "{}\n");
    add(candidate, "tsconfig.json");
  })();

  for (const file of pinnedSubmoduleExecutionFiles(compiled.projectRoot, compiled.pinnedSubmodules)) {
    add(file.sourcePath, file.snapshotPath);
  }

  const planPath = path.join(layout.root, "plan.json");
  add(planPath, "controls/plan.json");
  // Prompt artifact-authority selectors resolve through the same immutable
  // execution generation as the workflow and rendered prompts. Keep the
  // complete task manifest in that snapshot so a local continuation and a
  // relocated cloud worker read identical sealed task/output declarations.
  add(compiled.tasksPath, "controls/tasks.json");
  if (compiled.dynamicGroups.length > 0) {
    const dynamicBaseGraphPath = path.join(layout.root, "smithers", "runtime-base-graph.json");
    const dynamicBaseTasksPath = path.join(layout.root, "smithers", "runtime-base-tasks.json");
    writePreparedWorkflowFile(
      layout.root,
      dynamicBaseGraphPath,
      fs.readFileSync(layout.graphPath),
      "dynamic runtime base graph"
    );
    writePreparedWorkflowFile(
      layout.root,
      dynamicBaseTasksPath,
      fs.readFileSync(compiled.tasksPath),
      "dynamic runtime base task manifest"
    );
    add(dynamicBaseGraphPath, "controls/runtime-base-graph.json");
    add(dynamicBaseTasksPath, "controls/runtime-base-tasks.json");
  }
  const plan = readRunPlanDocument(planPath, layout.runId);
  const governancePath = (() => {
    const candidate = path.join(layout.root, plan.data_governance.path),
      bytes = readRegularFileSnapshot(candidate, 1024 * 1024);
    if (sha256Bytes(bytes) !== plan.data_governance.sha256)
      throw new Error("campaign data-governance provenance does not match the immutable run plan");
    return candidate;
  })();
  add(governancePath, `controls/${DATA_GOVERNANCE_PROVENANCE_PATH}`);
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
    // INVARIANT: reachable on launch only, where these bytes were just rendered and digested by
    // `plan-run`. It is asserted equal to the plan row above but NOT re-digested here, and it lives
    // under the agent-writable artifact dir -- so any future lane that re-seals an already-executing
    // controller must digest it against `planned.rendered_prompt_digest` first.
    add(task.renderedPromptPath, `controls/rendered-prompts/${task.attemptId}.md`);
    add(
      path.resolve(layout.root, planned.rendered_prompt_snapshot_path),
      `controls/prompt-snapshots/${task.attemptId}.md`
    );
  }

  add(compiled.executionConfigPath, "controls/ultrafuzz.toml");
  add(compiled.resolvedConfigPath, "controls/resolved-config.json");
  const agentsRoot = path.join(compiled.projectRoot, ".smithers", "agents");
  assertControllerSourceDigest(compiled.projectRoot, compiled.controllerSourceDigest);
  for (const sourcePath of walkExecutionFiles(agentsRoot)) {
    const source = fs.readFileSync(sourcePath, "utf8");
    if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
      throw new Error(
        `workflow agent reads mutable project ultrafuzz.toml instead of process.env.ULTRAFUZZ_CONFIG_PATH: ${sourcePath}; rerun ultrafuzz init --force to replace generated files, or update this adapter manually and remove controller-only variables before spawning a model process`
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
    projectRoot: dependencyProjectRoot,
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

export function assertSealedDataGovernance(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[],
  expected: RunDataGovernanceReference,
  runId: string
): void {
  const planFile = executionFiles.find((file) => file.snapshotPath === "controls/plan.json"),
    governanceFile = executionFiles.find((file) => file.snapshotPath === `controls/${DATA_GOVERNANCE_PROVENANCE_PATH}`);
  if (planFile === undefined || governanceFile === undefined) throw new Error("sealed data governance is incomplete");
  const plan = assertRunPlanDocument(parseStrictJsonBytes(planFile.contents), runId);
  if (
    JSON.stringify(plan.data_governance) !== JSON.stringify(expected) ||
    sha256Bytes(governanceFile.contents) !== expected.sha256
  )
    throw new Error("sealed data governance differs from the authenticated launch decision");
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
  const rootPackageLock = path.join(smithersRoot, "package-lock.json");
  const rootManifest = fs.existsSync(rootPackageJson) ? readWorkflowPackageManifest(rootPackageJson) : {};
  if (fs.existsSync(rootPackageJson)) input.add(rootPackageJson, "dependencies/root-package.json");
  if (!input.externalRunner) assertOperatorPackageLock(smithersRoot);
  if (fs.existsSync(rootPackageLock)) input.add(rootPackageLock, "dependencies/root-package-lock.json");
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
      const dependencyRoot = resolveWorkflowPackageDependency(
        issuer.root,
        dependency.name,
        issuer.id === "root" || isPathInside(path.join(smithersRoot, "node_modules"), issuer.root)
          ? smithersRoot
          : undefined
      );
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

function resolveWorkflowPackageDependency(
  issuerRoot: string,
  dependency: string,
  controllerRoot?: string
): string | undefined {
  if (!isWorkflowPackageName(dependency)) throw new Error(`workflow dependency name is invalid: ${dependency}`);
  let current = path.resolve(issuerRoot);
  for (;;) {
    const candidate = path.join(current, "node_modules", ...dependency.split("/"));
    if (fs.existsSync(candidate)) {
      const resolved = fs.realpathSync(candidate);
      if (controllerRoot !== undefined && !isPathInside(path.join(controllerRoot, "node_modules"), resolved))
        throw new Error(`workflow dependency escapes the private controller install: ${dependency}`);
      return resolved;
    }
    if (current === controllerRoot) return undefined;
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
      postures[patch.id] = patchPosture(
        source,
        patch.patched,
        patch.patchable,
        patch.predecessors,
        patch.patchedFamilyMarkers
      );
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

function patchPosture(
  sourcePath: string,
  patched: string,
  patchable: string,
  predecessors: readonly string[] = [],
  patchedMarkers: readonly string[] = []
): SmithersPatchPosture {
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
  return classifyRequiredSmithersPatch(contents, patchable, patched, predecessors, patchedMarkers).posture;
}

export function commandPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value) || value.ok !== true || !isObjectRecord(value.data)) {
    return undefined;
  }
  return value.data;
}

/**
 * Restore missing presentation prompts from immutable plan snapshots before Smithers renders a
 * reset continuation. `timetravel` owns task artifact directories and can remove these launch-time
 * copies even though persisted frames still refer to them. A later reset renders the whole graph,
 * so a prompt removed by any earlier reset must be available too. Only static agent tasks have plan
 * rows here; dynamic tasks keep their runtime materialization path.
 */
function restoreMissingRenderedPrompts(input: { projectRoot: string; runRoot: string }): void {
  const runRoot = path.resolve(input.runRoot);
  const plan = readRunPlanDocument(path.join(runRoot, "plan.json"), path.basename(runRoot));
  for (const planned of plan.rendered_prompts) {
    const nodeId = `node:${planned.attempt_id}`;
    const promptPath = path.isAbsolute(planned.rendered_prompt_path)
      ? path.resolve(planned.rendered_prompt_path)
      : path.resolve(input.projectRoot, planned.rendered_prompt_path);
    const expectedPromptPath = path.join(runRoot, "artifacts", planned.attempt_id, "prompt.rendered.md");
    if (promptPath !== expectedPromptPath) {
      throw new Error(`persisted rendered prompt path does not match reset task ${nodeId}`);
    }
    assertPathInside(runRoot, promptPath, `rendered prompt for reset task ${nodeId}`);
    if (fs.existsSync(promptPath)) continue;
    const snapshotPath = safeResolveInside(
      runRoot,
      planned.rendered_prompt_snapshot_path,
      `retained rendered prompt snapshot for reset task ${nodeId}`
    );
    assertRegularFileInside(runRoot, snapshotPath, `retained rendered prompt snapshot for reset task ${nodeId}`);
    assertNoSymlinkComponents(runRoot, snapshotPath, `retained rendered prompt snapshot for reset task ${nodeId}`);
    const contents = readRegularFileSnapshot(snapshotPath, MAX_WORKFLOW_EXECUTION_FILE_BYTES);
    if (sha256Stable(contents.toString("utf8")) !== planned.rendered_prompt_digest) {
      throw new Error(`retained rendered prompt snapshot does not match reset task ${nodeId}`);
    }
    const relativePromptPath = path.relative(runRoot, promptPath).split(path.sep).join("/");
    publishFileDurableExclusive(runRoot, relativePromptPath, contents);
  }
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
  priorInspection?: SmithersResumeInspection;
  relaunchPaths?: {
    runRoot: string;
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
    const inputJson = input.relaunchPaths?.inputJson;
    if (inputJson === undefined) {
      throw new Error("sealed workflow relaunch input is unavailable");
    }
    return inputJson;
  };
  const workflowChangeAcceptanceArgs = (): readonly string[] => {
    return input.action === "resume" ? ["--accept-workflow-change"] : [];
  };

  let preResumeStderr = "";
  let currentInspection: CurrentSmithersInspect | undefined;
  let inspection: SmithersCommandSnapshot | undefined;
  // Detached admission renders the workflow before Smithers checks whether
  // this run already has an active owner. Inspect every resume first so an
  // idempotent attach cannot fail preflight or compete with that owner (#968).
  //
  // A `--refresh-controller` resume has already inspected this exact run to
  // prove it is refreshable, and hands that evidence down as `priorInspection`.
  // Reuse it rather than issuing a second `inspect` per refresh: the refresh
  // gate deliberately admits a run with no recorded history, which the
  // full-output envelope contract rejects outright, so re-inspecting would also
  // fail a refresh that must succeed.
  if (input.action === "resume" && input.priorInspection === undefined) {
    const performed = await runSmithersInspectionCommand({
      args: ["inspect", input.smithersRunId, "--format", "json", "--full-output"],
      projectRoot: input.projectRoot,
      env: input.env
    });
    if (!performed.ok) {
      throw new Error(
        `workflow inspection failed before resume: ${performed.error ?? (performed.stderr.trim() || "unknown error")}`
      );
    }
    inspection = performed;
    currentInspection = parseCurrentSmithersInspect(performed, input.smithersRunId);
  } else if (input.action === "resume" && input.priorInspection?.status === "present") {
    inspection = input.priorInspection.snapshot;
    currentInspection = input.priorInspection.inspect;
  }
  if (currentInspection !== undefined && inspection !== undefined) {
    if (
      smithersRunStateIsActive(currentInspection) &&
      input.resetNode === undefined &&
      (input.force !== true || input.retryFailed === true)
    ) {
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
        const producerTask = retryProducerForFailedVerifier(currentInspection, failedTask);
        const resetResult = await execSmithersCli({
          args: [
            "timetravel",
            input.workflowPath,
            "--run-id",
            input.smithersRunId,
            "--node-id",
            producerTask?.nodeId ?? failedTask.nodeId,
            "--iteration",
            String(producerTask?.iteration ?? failedTask.iteration),
            // Generated verifiers deliberately have zero automatic retries. An
            // explicit retry must reopen their agent-owned artifact producer,
            // and Smithers must reset its verifier/dependents with it. Ordinary
            // failed tasks retain the narrow, node-only reset used before.
            ...(producerTask === undefined ? ["--no-deps"] : []),
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
        : path.join(input.relaunchPaths.runRoot, "smithers", "reset-node-applied.json");
    let resetStderr = "";
    if (!resetNodeMarkerMatches(resetMarkerPath, input.smithersRunId, input.resetNode)) {
      // A failure can be durable in the canonical node snapshot even when the
      // runner cannot resolve its implicit "latest attempt" lookup. Pinning the
      // iteration from that snapshot keeps --reset-node recoverable by node ID.
      const resetIteration =
        currentInspection === undefined
          ? undefined
          : smithersFailedTasks(currentInspection).find((task) => task.nodeId === input.resetNode)?.iteration;
      const resetResult = await execSmithersCli({
        args: [
          "timetravel",
          input.workflowPath,
          "--run-id",
          input.smithersRunId,
          "--node-id",
          input.resetNode,
          ...(resetIteration === undefined ? [] : ["--iteration", String(resetIteration)]),
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
          path.join(input.relaunchPaths!.runRoot, "smithers", "cloud-execution-generation.json"),
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
    if (input.relaunchPaths !== undefined) {
      restoreMissingRenderedPrompts({
        projectRoot: input.projectRoot,
        runRoot: input.relaunchPaths.runRoot
      });
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
          ...workflowChangeAcceptanceArgs(),
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
        Object.defineProperty(error, workflowLifecycleDiagnosticContext, {
          value:
            "node reset already completed; " +
            "rerun the same resume command to continue the reset run without repeating the reset",
          configurable: true
        });
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
    // A Smithers fork persists frame 0 before the child has an input-table row.
    // Detached-launch preflight runs before engine resume can restore that row
    // from the child snapshot, so it needs the authenticated relaunch input to
    // render the workflow. Resolve it before creating the child so a missing
    // sealed input fails without leaving an unlinked fork behind.
    const forkRelaunchInputJson = workflowRelaunchInputJson();
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
      "--input",
      forkRelaunchInputJson,
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
          ...workflowChangeAcceptanceArgs(),
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

/**
 * Proves the run is refreshable and returns the ownership evidence it used, so
 * the resume that follows reuses this inspection instead of issuing its own.
 */
export async function assertSmithersControllerRefreshable(input: {
  smithersRunId: string;
  projectRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<SmithersResumeInspection> {
  const inspection = await runSmithersInspectionCommand({
    args: ["inspect", input.smithersRunId, "--format", "json", "--full-output"],
    projectRoot: input.projectRoot,
    env: input.env
  });
  if (smithersSnapshotReportsMissingRun(inspection)) return { status: "missing" };
  if (!inspection.ok) {
    throw new Error(
      `workflow inspection failed before controller refresh: ${inspection.error ?? (inspection.stderr.trim() || "unknown error")}`
    );
  }
  const inspect = parseCurrentSmithersInspect(inspection, input.smithersRunId);
  if (smithersRunStateIsActive(inspect)) {
    throw new Error("controller refresh requires a stopped, terminal, or missing workflow run");
  }
  return { status: "present", snapshot: inspection, inspect };
}

export async function runSmithersInspectionCommand(input: {
  args: readonly string[];
  projectRoot: string;
  env?: Record<string, string | undefined>;
  environmentVariableNames?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SmithersCommandSnapshot> {
  const command = [...input.args];
  try {
    const result = await execSmithersCli({
      args: command,
      projectRoot: input.projectRoot,
      env: input.env,
      environmentVariableNames: input.environmentVariableNames,
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

export function smithersSnapshotReportsMissingRun(snapshot: SmithersCommandSnapshot): boolean {
  if (smithersSnapshotHasErrorCode(snapshot, "RUN_NOT_FOUND")) return true;
  const envelope = snapshot.json;
  if (
    !isObjectRecord(envelope) ||
    !hasExactObjectKeys(envelope, ["ok", "error", "meta"]) ||
    envelope.ok !== false ||
    !isObjectRecord(envelope.error) ||
    !hasExactObjectKeys(envelope.error, ["code", "message"]) ||
    envelope.error.code !== "INSPECT_FAILED" ||
    typeof envelope.error.message !== "string" ||
    !isObjectRecord(envelope.meta) ||
    !hasExactObjectKeys(envelope.meta, ["command", "duration"]) ||
    envelope.meta.command !== "inspect" ||
    typeof envelope.meta.duration !== "string" ||
    envelope.meta.duration.length === 0
  ) {
    return false;
  }
  const match =
    /^No (?:Smithers run history|smithers\.db) found at (.+[\\/]smithers\.db)\. Run 'smithers up <workflow>' to start a run first\. See https:\/\/smithers\.sh\/reference\/errors$/u.exec(
      envelope.error.message
    );
  return match !== null && path.isAbsolute(match[1]!);
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
    // `stalled` is Smithers 0.35.0's terminal verdict for a node that livelocked
    // on an identical error; every Ultrafuzz surface already reports it as a
    // failed node (`statusFromWorkflowState`), so `--retry-failed` has to reset
    // it too. Skipping it made an operator retry a silent no-op: the run
    // reported `failed`, and the reset loop issued zero `timetravel` commands.
    if (entry.state !== "failed" && entry.state !== "stalled") continue;
    failedTasks.set(`${entry.nodeId}::0`, { nodeId: entry.nodeId, iteration: 0 });
  }
  return [...failedTasks.values()];
}

function retryProducerForFailedVerifier(
  inspect: CurrentSmithersInspect,
  failedTask: { nodeId: string; iteration: number }
): { nodeId: string; iteration: number } | undefined {
  if (!failedTask.nodeId.startsWith("verify:")) return undefined;
  const producerNodeId = `node:${failedTask.nodeId.slice("verify:".length)}`;
  const producer = inspect.nodes.find((node) => node.nodeId === producerNodeId);
  if (producer === undefined) return undefined;
  return { nodeId: producer.nodeId, iteration: failedTask.iteration };
}

/**
 * The closed-world key contract Ultrafuzz enforces on `smithers inspect
 * --format json --full-output`. Exported so a test can diff it against the
 * pinned runner's own payload builder: an upstream release that emits a key
 * absent from `allowed` makes every inspect fail closed, which is exactly how
 * `tokenUsage`, `run.cancellationSource` and `runState.warnings` would have
 * broken the 0.34.0-to-0.35.0 bump had nothing checked.
 */
export const CURRENT_SMITHERS_INSPECT_KEY_CONTRACT = {
  data: {
    required: ["run", "runState", "steps", "nodes"],
    allowed: [
      "run",
      "runState",
      "failedChildren",
      "failedChildKeys",
      "steps",
      "nodes",
      "approvals",
      "timers",
      "loops",
      "exhaustedLoops",
      "steers",
      "tokenUsage",
      "config"
    ]
  },
  run: {
    required: ["id", "workflow", "status", "started", "elapsed"],
    allowed: [
      "id",
      "workflow",
      "status",
      "parentRunId",
      "started",
      "elapsed",
      "finished",
      "cancellationSource",
      "activeDescendantRunId",
      "error",
      "startedBy",
      "continuedFrom",
      "continuedFromDisplay"
    ]
  },
  runState: {
    required: ["runId", "state", "computedAt"],
    allowed: ["runId", "state", "computedAt", "blocked", "unhealthy", "warnings"]
  },
  node: { exact: ["nodeId", "state", "attempt", "label"] },
  /**
   * `pool` is emitted only under `smithers inspect --pool`, a flag Ultrafuzz
   * never passes, so it is deliberately outside `data.allowed` rather than
   * missing from it.
   */
  dataKeysGatedOnUnusedFlags: ["pool"]
} as const satisfies Record<string, unknown>;

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
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.data.required,
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.data.allowed,
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
  if (data.steers !== undefined) validateCurrentSmithersSteers(data.steers);
  if (data.config !== undefined && !isObjectRecord(data.config)) {
    throw new Error("Smithers inspect data.config must be an object");
  }
  // Aggregate run usage, emitted whenever the store carries the run-usage
  // migrations. Ultrafuzz reads its own accounting, so the contract only pins
  // the shape well enough to notice a future change.
  if (data.tokenUsage !== undefined && !isObjectRecord(data.tokenUsage)) {
    throw new Error("Smithers inspect data.tokenUsage must be an object");
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
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.run.required,
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.run.allowed,
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
  // Present on every run the pinned runner recorded a cancellation request for,
  // projected from the flat `cancel_request_*` columns.
  if (run.cancellationSource !== undefined && !isObjectRecord(run.cancellationSource)) {
    throw new Error("Smithers inspect data.run.cancellationSource must be an object");
  }
  if (run.startedBy !== undefined) validateCurrentSmithersStartedBy(run.startedBy);

  const runState = data.runState;
  if (!isObjectRecord(runState)) {
    throw new Error("Smithers inspect data.runState must be an object");
  }
  assertCurrentInspectObjectKeys(
    runState,
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.runState.required,
    CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.runState.allowed,
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
  // Durable operator warnings the runner derives from `RunConcurrencySaturated`
  // events. Advisory only — a warning never blocks or fails a run, so Ultrafuzz
  // pins the container shape and leaves the entries to the runner.
  if (runState.warnings !== undefined && !Array.isArray(runState.warnings)) {
    throw new Error("Smithers inspect data.runState.warnings must be an array");
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
    if (!isObjectRecord(value) || !hasExactObjectKeys(value, CURRENT_SMITHERS_INSPECT_KEY_CONTRACT.node.exact)) {
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
  const exhaustedLoops = parseCurrentSmithersExhaustedLoops(data.exhaustedLoops);
  // `succeeded-with-failures` is the success-terminal state the runner derives
  // when a run finished while tolerating a non-blocking child failure, so a
  // workflow can exhaust a loop and still land there.
  if (exhaustedLoops.length > 0 && parsedRunState !== "succeeded" && parsedRunState !== "succeeded-with-failures") {
    throw new Error("Smithers inspect data.exhaustedLoops is only valid for a succeeded workflow state");
  }
  return { runStatus, runState: parsedRunState, nodes, failedChildKeys, exhaustedLoops };
}

function parseCurrentSmithersExhaustedLoops(value: unknown): CurrentSmithersExhaustedLoop[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Smithers inspect data.exhaustedLoops must be a non-empty array when present");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const label = `Smithers inspect data.exhaustedLoops[${index}]`;
    if (!isObjectRecord(entry) || !hasExactObjectKeys(entry, ["id", "iteration", "maxIterations"])) {
      throw new Error(`${label} must use the exact current shape`);
    }
    const id = requiredCurrentInspectString(entry.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`${label}.id duplicates an earlier exhausted loop`);
    ids.add(id);
    const iteration = requiredCurrentInspectCount(entry.iteration, `${label}.iteration`);
    const maxIterations =
      entry.maxIterations === null ? null : requiredCurrentInspectCount(entry.maxIterations, `${label}.maxIterations`);
    if (maxIterations !== null && maxIterations === 0) {
      throw new Error(`${label}.maxIterations must be positive when present`);
    }
    return { id, iteration, maxIterations };
  });
}

function validateCurrentSmithersSteers(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Smithers inspect data.steers must be a non-empty array when present");
  }
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const label = `Smithers inspect data.steers[${index}]`;
    if (
      !isObjectRecord(entry) ||
      !["steerId", "nodeId", "status", "message", "queued"].every((key) => Object.hasOwn(entry, key)) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "steerId",
            "nodeId",
            "status",
            "message",
            "author",
            "queued",
            "consumedByAttempt",
            "consumedByIteration"
          ].includes(key)
      )
    ) {
      throw new Error(`${label} must use the exact current shape`);
    }
    const steerId = requiredCurrentInspectString(entry.steerId, `${label}.steerId`);
    if (ids.has(steerId)) throw new Error(`${label}.steerId duplicates an earlier steer`);
    ids.add(steerId);
    requiredCurrentInspectString(entry.nodeId, `${label}.nodeId`);
    requiredCurrentInspectEnum(entry.status, ["queued", "consumed", "expired"] as const, `${label}.status`);
    requiredCurrentInspectString(entry.message, `${label}.message`);
    const queued = requiredCurrentInspectString(entry.queued, `${label}.queued`);
    if (!isCanonicalDateTime(queued)) throw new Error(`${label}.queued must be a canonical timestamp`);
    if (entry.author !== undefined) requiredCurrentInspectString(entry.author, `${label}.author`);
    for (const key of ["consumedByAttempt", "consumedByIteration"] as const) {
      if (entry[key] !== undefined) requiredCurrentInspectCount(entry[key], `${label}.${key}`);
    }
  }
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
    throw new Error(`${label} contains fields outside the pinned 0.35.0 shape: ${unknown.join(", ")}`);
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
  const stdout = capturedProcessText(record.stdout);
  const stderr = capturedProcessText(record.stderr);
  const processFailure =
    Object.hasOwn(record, "stdout") ||
    Object.hasOwn(record, "stderr") ||
    Object.hasOwn(record, "signal") ||
    Object.hasOwn(record, "killed") ||
    typeof record.code === "number";
  const lifecycleContext =
    error &&
    typeof error === "object" &&
    typeof (error as ProcessDiagnosticContext)[workflowLifecycleDiagnosticContext] === "string"
      ? (error as ProcessDiagnosticContext)[workflowLifecycleDiagnosticContext]
      : "";
  const message = [
    processFailure ? processFailureSummary(record) : error instanceof Error ? error.message : String(error),
    lifecycleContext,
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

const workflowLifecycleDiagnosticContext = Symbol("workflowLifecycleDiagnosticContext");

type ProcessDiagnosticContext = {
  [workflowLifecycleDiagnosticContext]?: string;
};

function sanitizedDiagnosticText(value: string): string {
  return truncateDiagnosticText(scrubWorkflowRunnerText(redactProcessPayloadArguments(redactSecretsInText(value))));
}

function capturedProcessText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function processFailureSummary(record: { code?: unknown; signal?: unknown; killed?: unknown }): string {
  const disposition = [
    typeof record.code === "string" || typeof record.code === "number" ? `exit ${String(record.code)}` : "",
    typeof record.signal === "string" ? `signal ${record.signal}` : "",
    record.killed === true ? "killed" : ""
  ]
    .filter(Boolean)
    .join(", ");
  return `workflow runner command failed${disposition.length > 0 ? ` (${disposition})` : ""}`;
}

function redactProcessPayloadArguments(value: string): string {
  return value
    .replace(/((?:^|\s)--input\s+)[\s\S]*(\s--format\s+(?:json|ndjson)\b)/giu, "$1<redacted-input>$2")
    .replace(/((?:^|\s)--input\s+)(?!<redacted-input>)[^\r\n]*/giu, "$1<redacted-input>");
}

function redactedEvidenceText(value: string): string {
  const redacted = redactSecretsInText(value);
  const limit = SMITHERS_EVIDENCE_TEXT_LIMIT_CHARACTERS;
  return redacted.length > limit
    ? `${redacted.slice(0, limit)}\n[truncated ${redacted.length - limit} characters]`
    : redacted;
}

/**
 * Refuse to launch a compatibility-patched controller under anything but Bun.
 *
 * The spawn patches replace the runner's own interpreter selection with
 * `process.execPath` plus `ultrafuzzBunStartupArgs`, because that is the
 * interpreter `bindOperatorSmithersExecutableCapability` attested and the only
 * one that can carry the fd-3 execution snapshot into a detached child. The
 * pinned runner now offers a Node path of its own — `smithersRuntimeSpawn`
 * prepends an `--import` loader hook — and the patches deliberately discard it,
 * because composing would reintroduce an unverified interpreter and still leave
 * the snapshot behind. Under any other interpreter the patched spawns therefore
 * produce a child with neither the loader hook nor the snapshot descriptor,
 * which fails deep inside a detached engine instead of here.
 *
 * Installations carrying only the public runner shim are exempt on exactly the
 * basis `applySmithersCompatibilityPatches` uses: with no `@smthrs/cli` there is
 * no patched spawn path to mis-target.
 */
function assertPatchedSmithersRunnerInterpreter(env: Record<string, string | undefined>, controllerRoot: string): void {
  if (smithersExecutableCapability(env)?.interpreter.runtime === "bun") return;
  const nodeModules = path.join(controllerRoot, ".smithers", "node_modules");
  if (smithersDependencyRootCandidates(nodeModules, "@smthrs/cli").length === 0) return;
  throw new Error(
    "pinned workflow runner must run under Bun: its compatibility patches spawn every detached child through the attested interpreter and no other runtime carries the execution snapshot"
  );
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
  if (smithersExecutableCapability(env) !== undefined) return env;
  const explicit = explicitSmithersExecutable(env);
  if (explicit !== undefined) {
    assertExecutableOutsideRoot(explicit, projectRoot);
    return bindSmithersExecutableCapability({ ...(env ?? {}) }, explicit, projectRoot);
  }
  if (hasWorkflowExecutionSnapshotCapability(env)) throw new Error("sealed workflow has no runner capability");

  const controllerRoot = await operatorControllerProjectRoot(projectRoot, env, control);
  const packageRoot = resolveInstalledSmithersPackageRoot(controllerRoot);
  const executable = path.join(packageRoot, ...SMITHERS_BIN_PATH.split("/"));
  const nativeContinuation = isNativeSmithersContinuation(env);
  const bunModuleConfinement = nativeContinuation ? undefined : writeCurrentBunStartupControls(controllerRoot);
  const controllerSeal = operatorControllerProjectSeal(controllerRoot);
  const prepared = bindOperatorSmithersExecutableCapability(
    {
      ...(env ?? {}),
      ...(bunModuleConfinement === undefined ? {} : { ULTRAFUZZ_BUN_MODULE_CONFINEMENT: bunModuleConfinement })
    },
    executable,
    controllerRoot,
    () => {
      if (operatorControllerProjectSeal(controllerRoot) !== controllerSeal)
        throw new Error("operator controller changed during execution");
    },
    projectRoot,
    nativeContinuation
  );
  assertPatchedSmithersRunnerInterpreter(prepared, controllerRoot);
  if (nativeContinuation) {
    // Smithers detaches the resumed engine and supervisor. Their patched
    // relaunch paths still refer to this operator-owned package closure after
    // the submitting Ultrafuzz process exits, so it must outlive process-local
    // controller cleanup. Persist the exemption beside the closure as well as
    // in memory: a refresh/retry command can prepare the same controller across
    // several subprocess boundaries before detached admission, and process-exit
    // cleanup must remain fail-safe even if that root is re-registered. The OS
    // temporary-directory policy remains the outer reclamation boundary.
    retainNativeSmithersControllerRoot(controllerRoot);
  }
  return prepared;
}

async function ensureSmithersDependencies(
  projectRoot: string,
  env: Record<string, string | undefined> | undefined,
  control: {
    signal?: AbortSignal;
    timeoutMs?: number;
    requirePinnedRunner?: boolean;
    packageLock?: boolean;
    npmCli?: string;
    assertNpmCli?: () => void;
  } = {}
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
  const migratedManifest = migrateStockSmithers032PackageManifest(parsedManifest);
  if (migratedManifest !== undefined) {
    const identity = fs.lstatSync(packageJson, { bigint: true });
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n) {
      throw new Error("generated Smithers package manifest must be a singly linked regular file before migration");
    }
    writeFileDurable(packageJson, migratedManifest);
  }
  assertSmithersPackageManifest(
    migratedManifest === undefined
      ? parsedManifest
      : readPackageManagerOwnedManifestEnvelope(packageJson, "migrated generated Smithers package manifest")
  );
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
      if (control.packageLock === true) assertOperatorPackageLock(packageRoot);
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
    async () => {
      control.assertNpmCli?.();
      try {
        return await execFileAsync(
          control.npmCli === undefined ? "npm" : process.execPath,
          [
            ...(control.npmCli === undefined ? [] : [control.npmCli]),
            ...smithersDependencyInstallArgs({
              prefix: packageRoot,
              registry: "https://registry.npmjs.org",
              packageLock: control.packageLock
            })
          ],
          {
            cwd: projectRoot,
            env: smithersCommandEnv(projectRoot, env),
            maxBuffer: SMITHERS_CLI_MAX_BUFFER_BYTES,
            ...(control.signal === undefined ? {} : { signal: control.signal }),
            ...(control.timeoutMs === undefined ? {} : { timeout: control.timeoutMs })
          }
        );
      } finally {
        control.assertNpmCli?.();
      }
    },
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
    if (control.packageLock === true) assertOperatorPackageLock(packageRoot);
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

async function operatorControllerProjectRoot(
  targetRoot: string,
  env: Record<string, string | undefined> | undefined,
  control: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  const npmAuthority = resolveOperatorNpmAuthority(targetRoot, env);
  let project = operatorControllerProjects.get(npmAuthority.cacheKey);
  const fresh = project === undefined;
  if (project === undefined) {
    project = (async () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-controller-"));
      registerOperatorControllerRoot(root);
      try {
        const timeoutMs = Math.min(
            control.timeoutMs ?? SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS,
            SMITHERS_DEPENDENCY_INSTALL_TIMEOUT_MS
          ),
          npm = npmAuthority.provision(root),
          packageRoot = path.join(root, ".smithers");
        fs.mkdirSync(packageRoot, { mode: 0o700 });
        writeFileDurable(path.join(packageRoot, "package.json"), renderSmithersPackageJson());
        await ensureSmithersDependencies(root, env, {
          signal: control.signal,
          timeoutMs,
          requirePinnedRunner: true,
          packageLock: true,
          npmCli: npm.cliPath,
          assertNpmCli: npm.assertCurrent
        });
        writeCurrentBunStartupControls(root);
        return { npm, root, seal: operatorControllerProjectSeal(root) };
      } catch (error) {
        disposeOperatorControllerRoot(root);
        throw error;
      }
    })();
    operatorControllerProjects.set(npmAuthority.cacheKey, project);
  }
  let resolved: OperatorControllerProject | undefined;
  try {
    resolved = await project;
    if (!fresh) {
      resolved.npm.assertCurrent();
      if (operatorControllerProjectSeal(resolved.root) !== resolved.seal)
        throw new Error("operator controller changed after installation");
    }
    return resolved.root;
  } catch (error) {
    if (operatorControllerProjects.get(npmAuthority.cacheKey) === project)
      operatorControllerProjects.delete(npmAuthority.cacheKey);
    if (resolved !== undefined) disposeOperatorControllerRoot(resolved.root);
    throw error;
  }
}

function operatorControllerProjectSeal(projectRoot: string): string {
  const files = new Map<string, string>();
  const add = (sourcePath: string, snapshotPath: string): void => {
    if (files.has(snapshotPath)) throw new Error(`operator controller has a duplicate path: ${snapshotPath}`);
    files.set(snapshotPath, fs.realpathSync(sourcePath));
  };
  collectWorkflowExecutionDependencies({
    projectRoot,
    modules: [],
    externalRunner: false,
    add
  });
  for (const name of ["bun-module-confinement.js", "bun-empty.env", "bunfig.toml"])
    add(path.join(projectRoot, "controls", name), `controls/${name}`);
  const hash = crypto.createHash("sha256").update("ultrafuzz-operator-controller-v2\0");
  for (const [snapshotPath, sourcePath] of [...files].sort(([left], [right]) =>
    compareWorkflowExecutionStrings(left, right)
  )) {
    const stat = fs.lstatSync(sourcePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("operator controller contains a non-regular file");
    hash
      .update(snapshotPath)
      .update("\0")
      .update(`${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}\0`)
      .update(fs.readFileSync(sourcePath));
  }
  return hash.digest("hex");
}

function registerOperatorControllerRoot(root: string): void {
  operatorControllerRoots.add(root);
  if (operatorControllerCleanupRegistered) return;
  operatorControllerCleanupRegistered = true;
  process.once("exit", () => {
    for (const candidate of operatorControllerRoots) {
      if (isRetainedNativeSmithersControllerRoot(candidate)) continue;
      try {
        makeOperatorControllerTreeRemovable(candidate);
        fs.rmSync(candidate, { recursive: true, force: true });
      } catch {
        continue;
      }
    }
    operatorControllerRoots.clear();
  });
}

function retainNativeSmithersControllerRoot(root: string): void {
  const marker = path.join(root, NATIVE_SMITHERS_CONTROLLER_RETAIN_MARKER);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "retained\n", { encoding: "utf8", flag: "wx", mode: 0o400 });
  }
  if (!isRetainedNativeSmithersControllerRoot(root)) {
    throw new Error("native workflow runner retention marker is invalid");
  }
  operatorControllerRoots.delete(root);
}

function isRetainedNativeSmithersControllerRoot(root: string): boolean {
  const marker = path.join(root, NATIVE_SMITHERS_CONTROLLER_RETAIN_MARKER);
  try {
    const stat = fs.lstatSync(marker);
    return (
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && fs.readFileSync(marker, "utf8") === "retained\n"
    );
  } catch {
    return false;
  }
}

function disposeOperatorControllerRoot(root: string): void {
  operatorControllerRoots.delete(root);
  makeOperatorControllerTreeRemovable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function makeOperatorControllerTreeRemovable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeOperatorControllerTreeRemovable(path.join(root, name));
}

function assertOperatorPackageLock(packageRoot: string): void {
  const lockPath = path.join(packageRoot, "package-lock.json"),
    lock = parseStrictJsonBytes(readRegularFileSnapshot(lockPath, MAX_PACKAGE_MANAGER_MANIFEST_BYTES), {
      maxBytes: MAX_PACKAGE_MANAGER_MANIFEST_BYTES,
      maxDepth: MAX_PACKAGE_MANAGER_MANIFEST_DEPTH,
      maxItems: MAX_PACKAGE_MANAGER_MANIFEST_ITEMS,
      maxProperties: MAX_PACKAGE_MANAGER_MANIFEST_PROPERTIES
    });
  if (!isObjectRecord(lock) || lock.lockfileVersion !== 3 || !isObjectRecord(lock.packages))
    throw new Error("operator controller install requires a current package lock");
  for (const [location, value] of Object.entries(lock.packages)) {
    if (location === "") continue;
    const encodedIntegrity =
        isObjectRecord(value) && typeof value.integrity === "string" ? value.integrity.slice("sha512-".length) : "",
      decodedIntegrity = Buffer.from(encodedIntegrity, "base64");
    if (
      !isObjectRecord(value) ||
      typeof value.resolved !== "string" ||
      !value.resolved.startsWith("https://registry.npmjs.org/") ||
      typeof value.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.integrity) ||
      decodedIntegrity.byteLength !== 64 ||
      decodedIntegrity.toString("base64") !== encodedIntegrity
    )
      throw new Error(`operator controller lock entry is not registry-integrity bound: ${location}`);
  }
}

export function applySmithersCompatibilityPatches(projectRoot: string): void {
  const nodeModules = path.join(projectRoot, ".smithers", "node_modules");
  const runnerRoots = smithersDependencyRootCandidates(nodeModules, "smthrs");
  const cliRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/cli");
  const schedulerRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/scheduler");
  const engineRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/engine");
  const dbRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/db");
  const agentsRoots = smithersDependencyRootCandidates(nodeModules, "@smthrs/agents");
  // Unit-test installers intentionally provide only the public runner shim, so a
  // tree with none of these packages is tolerated. A registry installation always
  // carries all of them, so a tree holding some but not all of them is a broken
  // install: fail instead of silently skipping the resume-durability patches and
  // letting the run proceed unpatched. The caller repairs this by reinstalling.
  if (
    cliRoots.length === 0 &&
    schedulerRoots.length === 0 &&
    engineRoots.length === 0 &&
    dbRoots.length === 0 &&
    agentsRoots.length === 0
  )
    return;
  if (runnerRoots.length !== 1) throw new Error("pinned workflow runner resolved an incomplete public entrypoint");
  if (cliRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete CLI implementation");
  }
  if (schedulerRoots.length !== 1 || engineRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete resume implementation");
  }
  if (dbRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete event-store implementation");
  }
  if (agentsRoots.length !== 1) {
    throw new Error("pinned workflow runner resolved an incomplete agent implementation");
  }
  const packageRoot = cliRoots[0]!;
  const runnerSource = path.join(runnerRoots[0]!, ...SMITHERS_BIN_PATH.split("/"));
  const packageJson = path.join(packageRoot, "package.json");
  const cliSource = path.join(packageRoot, "src", "index.js");
  const observabilitySource = path.join(packageRoot, "src", "observability-helpers.js");
  const resumeDetachedSource = path.join(packageRoot, "src", "resume-detached.js");
  assertRegularFileInside(nodeModules, packageJson, "installed Smithers CLI package metadata");
  assertRegularFileInside(nodeModules, runnerSource, "installed Smithers public entrypoint");
  assertRegularFileInside(nodeModules, cliSource, "installed Smithers CLI implementation");
  assertRegularFileInside(nodeModules, observabilitySource, "installed Smithers observability implementation");
  assertRegularFileInside(nodeModules, resumeDetachedSource, "installed Smithers detached resume implementation");
  const metadata = readPackageManagerOwnedManifestEnvelope(packageJson, "installed Smithers CLI package manifest");
  if (optionalPackageManifestString(metadata, "version", packageJson) !== SMITHERS_VERSION) {
    throw new Error(`installed Smithers CLI package version must be ${SMITHERS_VERSION}`);
  }
  writeFileDurable(
    runnerSource,
    applyRequiredSmithersPatch(
      fs.readFileSync(runnerSource, "utf8"),
      SMITHERS_BIN_LOCAL_DELEGATION_SOURCE,
      SMITHERS_BIN_LOCAL_DELEGATION_PATCH,
      "target-local runner delegation"
    ),
    { mode: 0o500 }
  );
  let cliContents = fs.readFileSync(cliSource, "utf8");
  for (const [source, patched, label, predecessors, patchedMarkers] of [
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
      "process-owned execution snapshot",
      [
        SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_PREDECESSOR_PATCH,
        SMITHERS_CLI_PROCESS_SNAPSHOT_ANCHOR_NESTED_PREDECESSOR_PATCH
      ],
      ["anchorUltrafuzzExecutionSnapshotForProcess"]
    ],
    [SMITHERS_CLI_MANIFEST_RELAUNCH_SOURCE, SMITHERS_CLI_MANIFEST_RELAUNCH_PATCH, "manifest-conflict relaunch"],
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
    cliContents = applyRequiredSmithersPatch(cliContents, source, patched, label, predecessors, patchedMarkers);
  }
  writeFileDurable(cliSource, cliContents);
  writeFileDurable(
    observabilitySource,
    applyRequiredSmithersPatch(
      fs.readFileSync(observabilitySource, "utf8"),
      SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_SOURCE,
      SMITHERS_CLI_LIFECYCLE_TRACE_SUMMARY_PATCH,
      "lifecycle trace summary visibility"
    )
  );
  const resumeDetachedContents = fs.readFileSync(resumeDetachedSource, "utf8");
  writeFileDurable(
    resumeDetachedSource,
    applyRequiredSmithersPatch(
      resumeDetachedContents,
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_SOURCE,
      SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PATCH,
      "detached resume execution snapshot transfer",
      [SMITHERS_CLI_RESUME_SNAPSHOT_TRANSFER_PREDECESSOR_PATCH],
      ["ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR"]
    )
  );

  const agentsRoot = agentsRoots[0];
  if (agentsRoot === undefined) throw new Error("pinned workflow runner resolved an incomplete agent implementation");
  const agentsPackageJson = path.join(agentsRoot, "package.json");
  assertRegularFileInside(nodeModules, agentsPackageJson, "installed Smithers agents package metadata");
  const agentsMetadata = readPackageManagerOwnedManifestEnvelope(
    agentsPackageJson,
    "installed Smithers agents package manifest"
  );
  if (optionalPackageManifestString(agentsMetadata, "version", agentsPackageJson) !== SMITHERS_VERSION) {
    throw new Error(`installed Smithers agents package version must be ${SMITHERS_VERSION}`);
  }
  const agentsSources = new Map<string, string>();
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES.filter(
    (candidate) => candidate.packageName === "@smthrs/agents"
  )) {
    const sourcePath = path.join(agentsRoot, ...patch.sourceRelativePath.split("/"));
    assertRegularFileInside(nodeModules, sourcePath, `installed Smithers agent implementation ${patch.id}`);
    const current = agentsSources.get(sourcePath) ?? fs.readFileSync(sourcePath, "utf8");
    agentsSources.set(
      sourcePath,
      applyRequiredSmithersPatch(
        current,
        patch.patchable,
        patch.patched,
        patch.id.replaceAll("_", " "),
        patch.predecessors,
        patch.patchedFamilyMarkers
      )
    );
  }
  for (const [sourcePath, contents] of agentsSources) writeFileDurable(sourcePath, contents);

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
  for (const entry of [
    [
      SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_SOURCE,
      SMITHERS_ENGINE_WORKFLOW_PATH_IMPORT_PATCH,
      "workflow path file identity import"
    ],
    [SMITHERS_ENGINE_WORKFLOW_PATH_SOURCE, SMITHERS_ENGINE_WORKFLOW_PATH_PATCH, "anchored workflow paths"],
    [
      SMITHERS_ENGINE_DURABILITY_METADATA_SOURCE,
      SMITHERS_ENGINE_DURABILITY_METADATA_PATCH,
      "workflow durability hash identity"
    ],
    [SMITHERS_ENGINE_RUN_METADATA_SOURCE, SMITHERS_ENGINE_RUN_METADATA_PATCH, "workflow durability metadata"],
    [SMITHERS_ENGINE_RESUME_IDENTITY_SOURCE, SMITHERS_ENGINE_RESUME_IDENTITY_PATCH, "resume workflow identity"],
    [
      SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_SOURCE,
      SMITHERS_ENGINE_REFRESH_PATH_ACCEPTANCE_PATCH,
      "authenticated controller workflow path acceptance"
    ],
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
    [SMITHERS_ENGINE_RESUME_HYDRATION_SOURCE, SMITHERS_ENGINE_RESUME_HYDRATION_PATCH, "resume hydration"],
    [
      SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_SOURCE,
      SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PATCH,
      "reported CLI cost normalization",
      [SMITHERS_ENGINE_REPORTED_COST_NORMALIZE_PREDECESSOR_PATCH]
    ],
    [
      SMITHERS_ENGINE_REPORTED_COST_PRICE_SOURCE,
      SMITHERS_ENGINE_REPORTED_COST_PRICE_PATCH,
      "reported CLI cost precedence",
      [SMITHERS_ENGINE_REPORTED_COST_PRICE_PREDECESSOR_PATCH]
    ],
    [
      SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_SOURCE,
      SMITHERS_ENGINE_AGENT_EVENT_OWNERSHIP_PATCH,
      "agent event ownership coalescing"
    ],
    [
      SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_SOURCE,
      SMITHERS_ENGINE_AGENT_USAGE_PROGRESS_PATCH,
      "incremental owned agent usage"
    ],
    [
      SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_SOURCE,
      SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PATCH,
      "main agent usage invocation",
      [SMITHERS_ENGINE_MAIN_USAGE_INVOCATION_PREDECESSOR_PATCH]
    ],
    [
      SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_SOURCE,
      SMITHERS_ENGINE_JSON_CORRECTION_USAGE_INVOCATION_PATCH,
      "JSON correction usage invocation"
    ],
    [
      SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_SOURCE,
      SMITHERS_ENGINE_JSON_CORRECTION_USAGE_RESULT_PATCH,
      "JSON correction usage result"
    ],
    [
      SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_SOURCE,
      SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_INVOCATION_PATCH,
      "schema correction usage invocation"
    ],
    [
      SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_SOURCE,
      SMITHERS_ENGINE_SCHEMA_CORRECTION_USAGE_RESULT_PATCH,
      "schema correction usage result"
    ],
    [SMITHERS_ENGINE_FAILED_USAGE_SOURCE, SMITHERS_ENGINE_FAILED_USAGE_PATCH, "failed agent usage ownership"],
    [SMITHERS_ENGINE_FINAL_USAGE_SOURCE, SMITHERS_ENGINE_FINAL_USAGE_PATCH, "final agent usage ownership"]
  ] as const) {
    const [source, patched, label] = entry;
    const predecessors = entry.length === 4 ? entry[3] : undefined;
    engineContents = applyRequiredSmithersPatch(engineContents, source, patched, label, predecessors);
  }
  for (const required of SMITHERS_REQUIRED_ENGINE_ANCHORS) {
    if (!engineContents.includes(required.anchor)) {
      throw new Error(`pinned workflow runner ${required.id.replaceAll("_", " ")} is incompatible`);
    }
  }
  writeFileDurable(engineSource, engineContents);

  const dbRoot = dbRoots[0]!;
  const dbPackageJson = path.join(dbRoot, "package.json");
  const dbAdapterSource = path.join(dbRoot, "src", "adapter.js");
  const dbSchemaMigrationsSource = path.join(dbRoot, "src", "schema-migrations.js");
  assertRegularFileInside(nodeModules, dbPackageJson, "installed Smithers event-store package metadata");
  assertRegularFileInside(nodeModules, dbAdapterSource, "installed Smithers event-store adapter");
  assertRegularFileInside(nodeModules, dbSchemaMigrationsSource, "installed Smithers event-store schema migrations");
  const dbMetadata = readPackageManagerOwnedManifestEnvelope(
    dbPackageJson,
    "installed Smithers event-store package manifest"
  );
  if (optionalPackageManifestString(dbMetadata, "version", dbPackageJson) !== SMITHERS_VERSION) {
    throw new Error(`installed Smithers event-store package version must be ${SMITHERS_VERSION}`);
  }
  writeFileDurable(
    dbSchemaMigrationsSource,
    applyRequiredSmithersPatch(
      fs.readFileSync(dbSchemaMigrationsSource, "utf8"),
      SMITHERS_DB_EVENT_PROBE_INDEX_SOURCE,
      SMITHERS_DB_EVENT_PROBE_INDEX_PATCH,
      "event insert probe index"
    )
  );
  writeFileDurable(
    dbAdapterSource,
    applyRequiredSmithersPatch(
      fs.readFileSync(dbAdapterSource, "utf8"),
      SMITHERS_DB_FENCED_USAGE_SOURCE,
      SMITHERS_DB_FENCED_USAGE_PATCH,
      "owned cumulative agent usage"
    )
  );
}

function applyRequiredSmithersPatch(
  contents: string,
  source: string,
  patched: string,
  label: string,
  predecessors: readonly string[] = [],
  patchedMarkers: readonly string[] = []
): string {
  const state = classifyRequiredSmithersPatch(contents, source, patched, predecessors, patchedMarkers);
  if (state.posture === "applied") return contents;
  if (state.posture === "incompatible") {
    throw new Error(`pinned workflow runner ${label} implementation is incompatible`);
  }
  return contents.replace(state.replacement, patched);
}

type RequiredSmithersPatchState =
  | { readonly posture: "applied" }
  | { readonly posture: "missing"; readonly replacement: string }
  | { readonly posture: "incompatible" };

function classifyRequiredSmithersPatch(
  contents: string,
  source: string,
  patched: string,
  predecessors: readonly string[],
  patchedMarkers: readonly string[]
): RequiredSmithersPatchState {
  // Check exact predecessors first: a known malformed predecessor can contain
  // the whole current replacement after an earlier nested-anchor migration.
  const matchingPredecessors = predecessors.filter((predecessor) => contents.includes(predecessor));
  if (matchingPredecessors.length > 0) {
    const predecessor = matchingPredecessors[0]!;
    const remainder = contents.replace(predecessor, "");
    if (
      matchingPredecessors.length !== 1 ||
      contents.split(predecessor).length !== 2 ||
      remainder.includes(patched) ||
      remainder.includes(source)
    ) {
      return { posture: "incompatible" };
    }
    return { posture: "missing", replacement: predecessor };
  }
  if (contents.includes(patched)) {
    const remainder = contents.replace(patched, "");
    if (
      contents.split(patched).length !== 2 ||
      predecessors.some((predecessor) => contents.includes(predecessor)) ||
      remainder.includes(source) ||
      patchedMarkers.some((marker) => remainder.includes(marker))
    ) {
      return { posture: "incompatible" };
    }
    return { posture: "applied" };
  }
  if (patchedMarkers.some((marker) => contents.includes(marker))) {
    return { posture: "incompatible" };
  }
  return contents.split(source).length === 2
    ? { posture: "missing", replacement: source }
    : { posture: "incompatible" };
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
  // A native continuation deliberately loads the persisted workflow from the
  // target tree, which has no installed controller dependencies in production.
  // Derive Bun's package fallback from the private operator capability after
  // dropping ambient NODE_PATH below; detached children inherit this trusted
  // path for the lifetime of the continued workflow (#973).
  const nativeOperatorNodePath = nativeOperatorSmithersNodePath(env);
  source.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS ??= SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS;
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
      !["BUN_INSPECT_PRELOAD", "BUN_OPTIONS", "NODE_OPTIONS", "NODE_PATH"].includes(normalizedKey) &&
      (SMITHERS_BASE_ENVIRONMENT_VARIABLES.has(normalizedKey) ||
        (SMITHERS_CONTROLLER_ENVIRONMENT_VARIABLES.has(normalizedKey) &&
          !SMITHERS_EXECUTION_CONTEXT_ENVIRONMENT_VARIABLES.has(normalizedKey)) ||
        forwarded.has(normalizedKey))
    ) {
      merged[key] = value;
    }
  }
  if (nativeOperatorNodePath !== undefined) merged.NODE_PATH = nativeOperatorNodePath;
  merged.PATH = composeSmithersCommandPath(projectRoot, source);
  return merged;
}

export function composeSmithersCommandPath(
  projectRoot: string,
  source: Readonly<Record<string, string | undefined>>
): string {
  const trustedBin = source[ULTRAFUZZ_TRUSTED_BIN_ENV];
  const target = path.resolve(projectRoot);
  const canonicalTarget = fs.realpathSync(target);
  const callerEntries = (source.PATH ?? "").split(path.delimiter).filter((entry) => {
    if (!path.isAbsolute(entry)) return false;
    if (isPathInside(target, path.resolve(entry))) return isPreparedForgeGuardBin(projectRoot, entry);
    try {
      return !isPathInside(canonicalTarget, fs.realpathSync(entry));
    } catch {
      return false;
    }
  });
  return [trustedBin, ...callerEntries]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join(path.delimiter);
}

function smithersBinaryName(): string {
  return process.platform === "win32" ? "smithers.cmd" : "smithers";
}

function dynamicAncestorGroupsForNode(node: ExpandedNode, nodeById: ReadonlyMap<string, ExpandedNode>): string[] {
  const discovered = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const candidate = nodeById.get(nodeId);
    if (candidate === undefined) return;
    if (candidate.dynamic !== undefined) discovered.add(candidate.id);
    for (const dependency of candidate.dependsOn) visit(dependency);
  };
  visit(node.id);
  return [...discovered].sort();
}

/**
 * Resolves the immutable transformed prompt body that planning hashed and validated.
 *
 * The project file is deliberately never reread: a run-scoped prompt transform makes the on-disk
 * bytes differ from the bytes the plan is bound to, which would either fail compilation for dynamic
 * templates or leave a deferred static descendant rendering stale artifact references.
 */
function snapshotPromptTemplate(runLayout: RunLayout, graph: ExpandedGraph, node: ExpandedNode): string {
  if (node.promptPath === undefined) {
    throw new Error(`runtime-rendered node ${node.id} is missing a prompt path`);
  }
  const digest = graph.fingerprintInputs?.promptDigests?.[node.promptPath] ?? node.dynamic?.templateDigest;
  if (digest === undefined) {
    throw new Error(`deferred prompt template digest is unavailable for ${node.id}`);
  }
  if (node.dynamic?.templateDigest !== undefined && node.dynamic.templateDigest !== digest) {
    throw new Error(`dynamic prompt template digest changed for ${node.id}`);
  }
  const snapshotPath = safeResolveInside(
    runLayout.root,
    `${DEFERRED_PROMPT_TEMPLATE_DIR}/${digest}.md`,
    `deferred prompt template for ${node.id}`
  );
  assertRegularFileInside(runLayout.root, snapshotPath, `deferred prompt template for ${node.id}`);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(snapshotPath, "utf8")).digest("hex");
  if (actual !== digest) {
    throw new Error(`deferred prompt template snapshot digest changed for ${node.id}`);
  }
  return snapshotPath;
}

function compileDynamicGroup(input: {
  input: SmithersCompileInput;
  node: ExpandedNode & { dynamic: NonNullable<ExpandedNode["dynamic"]> };
  nodeById: ReadonlyMap<string, ExpandedNode>;
  attemptsByNodeId: ReadonlyMap<string, string[]>;
  agenticAttemptsByNodeId: ReadonlyMap<string, string[]>;
  referenceAttemptsByNodeId: ReadonlyMap<string, string[]>;
  referenceArtifactManifestAuthorityCache: Map<string, SmithersTaskManifestReferenceArtifactManifestAuthority>;
  sourceRevision?: string;
  sourceRef?: string;
  projectRoot: string;
  workflowName: string;
}): CompiledSmithersDynamicGroup {
  const sourceNodes = input.node.dependsOn
    .map((dependency) => input.nodeById.get(dependency))
    .filter(
      (candidate): candidate is ExpandedNode =>
        candidate !== undefined && candidate.logicalId === input.node.dynamic.from.node
    );
  const sourceAttempts = sourceNodes.flatMap((source) => input.attemptsByNodeId.get(source.id) ?? []);
  if (sourceNodes.length !== 1 || sourceAttempts.length !== 1) {
    throw new Error(
      `dynamic group ${input.node.id} requires exactly one concrete source attempt; found ${sourceAttempts.length}`
    );
  }
  const sourceNode = sourceNodes[0]!;
  const sourceAttemptId = sourceAttempts[0]!;
  const sourcePrimary = sourceNode.outputs.find((output) => output.primary);
  if (sourcePrimary === undefined) {
    throw new Error(`dynamic group ${input.node.id} source has no primary output`);
  }
  const templatePath = snapshotPromptTemplate(input.input.runLayout, input.input.graph, input.node);
  const templateDigest = crypto.createHash("sha256").update(fs.readFileSync(templatePath)).digest("hex");
  const dependencyAttemptIds = input.node.dependsOn.flatMap(
    (dependency) => input.attemptsByNodeId.get(dependency) ?? []
  );
  const dependencyAgenticAttemptIds = input.node.dependsOn.flatMap(
    (dependency) => input.agenticAttemptsByNodeId.get(dependency) ?? []
  );
  // Generated children inherit the group's compiled artifact ancestry; their own sibling artifact
  // directories are added when the controller materializes them.
  const artifactDependencyAttemptIds = artifactAncestorNodeIds(input.node.id, input.input.graph.nodes).flatMap(
    (ancestor) =>
      input.nodeById.get(ancestor)?.dynamic === undefined ? (input.attemptsByNodeId.get(ancestor) ?? []) : []
  );
  const taskTemplates = nodeAttemptsFor(input.node).map((attempt) =>
    compileTask({
      config: input.input.config,
      env: input.input.env ?? {},
      graph: input.input.graph,
      node: input.node,
      attempt,
      runLayout: input.input.runLayout,
      sourceRevision: input.sourceRevision,
      sourceRef: input.sourceRef,
      workflowName: input.workflowName,
      promptTemplatePath: templatePath,
      deferredPromptGroups: [input.node.id],
      dependencyAttemptIds,
      dependencyAgenticAttemptIds,
      artifactDependencyAttemptIds,
      referenceArtifactManifestAuthorities: referenceArtifactManifestAuthoritiesForAncestors(
        artifactAncestorNodeIds(input.node.id, input.input.graph.nodes),
        input.input.graph.nodes,
        input.input.runLayout,
        input.referenceArtifactManifestAuthorityCache
      ),
      dependencyReferenceAttemptIds: input.node.dependsOn.flatMap(
        (dependency) => input.referenceAttemptsByNodeId.get(dependency) ?? []
      ),
      ...(input.input.vulnerabilityDatabase === undefined
        ? {}
        : { vulnerabilityDatabase: input.input.vulnerabilityDatabase })
    })
  );
  const priorities = invariantPropertyPrioritySelection(input.input.config.invariants.propertyPriorityThreshold);
  return {
    groupNodeId: input.node.id,
    logicalNodeId: input.node.logicalId,
    source: {
      concreteNodeId: sourceNode.id,
      attemptId: sourceAttemptId,
      ...(sourceNode.kind === "agentic"
        ? { verifierSmithersNodeId: verifierSmithersNodeIdForAttempt(sourceAttemptId) }
        : {}),
      artifactPath: path
        .relative(
          input.projectRoot,
          path.join(getNodeArtifactDir(input.input.runLayout, sourceAttemptId, { create: true }), sourcePrimary.path)
        )
        .split(path.sep)
        .join("/")
    },
    sourcePath: input.node.dynamic.from.path,
    keyPath: input.node.dynamic.key,
    nodeIdTemplate: input.node.dynamic.nodeIdTemplate,
    templatePath: path.relative(input.projectRoot, templatePath).split(path.sep).join("/"),
    templateDigest,
    templateFingerprint: sha256Stable({
      graph_version: input.input.graph.graphVersion,
      node: input.node,
      template_digest: templateDigest
    }),
    continueOnFail:
      input.node.group !== undefined &&
      input.input.graph.groups[input.node.group]?.defaults?.failure_policy === "continue",
    maxDynamicNodes: input.input.config.run.maxDynamicNodes,
    reservedNodeIds: input.input.graph.nodes.map((node) => node.id).sort(),
    taskTemplates,
    promptContext: {
      projectRoot: input.projectRoot,
      repoPath: path.resolve(input.projectRoot, input.input.config.project.repo),
      artifactsDir: input.input.runLayout.artifactsDir,
      runMetadataPath: input.input.runLayout.runMetadataPath,
      resolvedConfig: {
        triage: {
          quorum: input.input.config.triage.quorum,
          panelSize: input.input.config.triage.panelSize
        },
        dynamicStrategiesEnumerator: input.input.config.dynamicStrategiesEnumerator,
        invariantPropertyPriorityThreshold: input.input.config.invariants.propertyPriorityThreshold,
        invariantPropertyPriorityFilter: priorities.filter,
        invariantPropertyPriorities: priorities.priorities,
        invariantTestingFuzzerTimeout: input.input.config.invariants.invariantTestingFuzzerTimeoutSeconds,
        ...(input.input.vulnerabilityDatabase === undefined
          ? {}
          : {
              vulnerabilityDatabaseRelativePath: input.input.vulnerabilityDatabase.relative_path,
              vulnerabilityDatabaseSha256: input.input.vulnerabilityDatabase.sha256
            })
      }
    }
  };
}

function compileTask(input: {
  config: ResolvedConfig;
  env: NodeJS.ProcessEnv;
  graph: ExpandedGraph;
  node: ExpandedNode;
  attempt: NodeAttemptProvenance;
  runLayout: RunLayout;
  sourceRevision?: string;
  sourceRef?: string;
  workflowName: string;
  renderedPromptPath?: string;
  promptTemplatePath?: string;
  dynamicDependencies?: readonly string[];
  deferredPromptGroups?: readonly string[];
  promptArtifactAuthoritySelectors?: readonly SmithersTaskManifestPromptArtifactAuthoritySelector[];
  referenceArtifactManifestAuthorities?: readonly SmithersTaskManifestReferenceArtifactManifestAuthority[];
  dependencyAttemptIds: readonly string[];
  dependencyAgenticAttemptIds: readonly string[];
  artifactDependencyAttemptIds: readonly string[];
  dependencyReferenceAttemptIds?: readonly string[];
  vulnerabilityDatabase?: { relative_path: string; sha256: string };
}): CompiledSmithersTask {
  const profile = modelProfileFor(input.config, input.attempt);
  const agentChain = agentChainForTask(input.config, profile, input.node.retryPolicy.maxAttempts);
  const timeoutMs =
    (input.node.timeoutSeconds ?? profile.timeoutSeconds ?? input.config.run.defaultTimeoutSeconds) * 1000;
  assertInvariantCampaignTimeoutBudget(input, timeoutMs);
  // Agent subprocesses can spend long stretches inside a provider request where
  // Smithers cannot emit a useful task heartbeat. Keep the watchdog aligned with
  // the configured node deadline so it does not silently replace a longer node
  // timeout with the old ten-minute cap.
  const heartbeatTimeoutMs = timeoutMs;
  const retries = agentChain.length - 1;
  const artifactDir = getNodeArtifactDir(input.runLayout, input.attempt.attemptId, { create: true });
  const workspacePath = getNodeWorkspaceDir(input.runLayout, input.attempt.attemptId);
  const dependencyArtifactDirs = input.artifactDependencyAttemptIds.map((attemptId) =>
    getNodeArtifactDir(input.runLayout, attemptId, { create: true })
  );
  const referenceArtifactDirs = (input.dependencyReferenceAttemptIds ?? []).map((attemptId) =>
    getNodeArtifactDir(input.runLayout, attemptId, { create: true })
  );
  const vulnerabilityDatabaseCatalog =
    input.vulnerabilityDatabase === undefined
      ? undefined
      : {
          path: safeResolveInside(
            input.runLayout.root,
            input.vulnerabilityDatabase.relative_path,
            "materialized vulnerability database catalog"
          ),
          sha256: input.vulnerabilityDatabase.sha256
        };
  const dependencySmithersNodeIds = input.dependencyAgenticAttemptIds.map(verifierSmithersNodeIdForAttempt);
  const executionResources = resolveExecutionResources(input.config, input.node.logicalId);
  const agentCredentialEnv = [
    ...new Set(
      agentChain.flatMap((entry) =>
        cloudAgentCredentialEnv(
          input.config.execution.mode,
          entry.agentRef,
          input.config.agents[entry.agentRef],
          input.config.agents,
          input.env
        )
      )
    )
  ];
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
      attemptIndex: input.attempt.attemptIndex,
      agentChain
    },
    workspace: {
      primitive: "worktree",
      path: workspacePath,
      repoPath: input.config.project.repo,
      trustModel: input.config.permissions.trustModel,
      ...(input.sourceRevision === undefined
        ? {}
        : { sourceRevision: input.sourceRevision, sourceRef: input.sourceRef! })
    },
    artifacts: {
      dir: artifactDir,
      outputs: input.node.outputs,
      manifestPath: path.join(artifactDir, "artifact-manifest.json")
    },
    retryPolicy: {
      maxAttempts: agentChain.length,
      sameAgentAttempts: input.node.retryPolicy.maxAttempts,
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
    agentChain,
    ...(profile.model ? { modelName: profile.model } : {}),
    ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {}),
    dependencies: [...input.dependencyAttemptIds],
    dependencySmithersNodeIds,
    timeoutMs,
    heartbeatTimeoutMs,
    retries,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    ...(input.sourceRevision === undefined
      ? {}
      : { sourceRevision: input.sourceRevision, sourceRef: input.sourceRef! }),
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    ...(referenceArtifactDirs.length === 0 ? {} : { referenceArtifactDirs }),
    ...(vulnerabilityDatabaseCatalog === undefined ? {} : { vulnerabilityDatabaseCatalog }),
    ...(input.referenceArtifactManifestAuthorities === undefined
      ? {}
      : { referenceArtifactManifestAuthorities: [...input.referenceArtifactManifestAuthorities] }),
    ...(input.promptArtifactAuthoritySelectors === undefined
      ? {}
      : { promptArtifactAuthoritySelectors: [...input.promptArtifactAuthoritySelectors] }),
    ...(input.renderedPromptPath ? { renderedPromptPath: input.renderedPromptPath } : {}),
    ...(input.promptTemplatePath ? { promptTemplatePath: input.promptTemplatePath } : {}),
    ...(input.dynamicDependencies && input.dynamicDependencies.length > 0
      ? { dynamicDependencies: [...input.dynamicDependencies] }
      : {}),
    ...(input.deferredPromptGroups && input.deferredPromptGroups.length > 0
      ? { deferredPromptGroups: [...input.deferredPromptGroups] }
      : {}),
    execution,
    metadata
  };
}

function promptArtifactAuthoritySelectorsFor(
  renderedPrompt: RenderedPromptPlan | undefined
): SmithersTaskManifestPromptArtifactAuthoritySelector[] | undefined {
  if (renderedPrompt === undefined) return undefined;
  const selectors = new Map<string, SmithersTaskManifestPromptArtifactAuthoritySelector>();
  for (const reference of renderedPrompt.artifact_references) {
    if (reference.kind === "ancestor_contract_artifact_authority") {
      const contract = reference.contract;
      if (!isArtifactContractId(contract)) {
        throw new Error(
          `rendered prompt ${JSON.stringify(renderedPrompt.attempt_id)} uses an unknown prompt artifact authority contract ${JSON.stringify(contract)}`
        );
      }
      const selector = { kind: "contract", contract } as const;
      selectors.set(promptArtifactAuthoritySelectorKey(selector), selector);
      continue;
    }
    if (reference.kind !== "ancestor_artifact_path_authority") continue;
    const paths = [...reference.relativePaths];
    if (
      paths.length === 0 ||
      reference.selectorId !== promptArtifactAuthorityPathSelectorId(paths) ||
      paths.some((selectedPath, index) => index > 0 && paths[index - 1]!.localeCompare(selectedPath) >= 0)
    ) {
      throw new Error(
        `rendered prompt ${JSON.stringify(renderedPrompt.attempt_id)} uses an invalid prompt artifact authority path selector group`
      );
    }
    const selector = { kind: "path", id: reference.selectorId, paths } as const;
    selectors.set(promptArtifactAuthoritySelectorKey(selector), selector);
  }
  if (selectors.size === 0) return undefined;
  return [...selectors.values()].sort((left, right) =>
    promptArtifactAuthoritySelectorKey(left).localeCompare(promptArtifactAuthoritySelectorKey(right))
  );
}

function promptArtifactAuthoritySelectorKey(selector: SmithersTaskManifestPromptArtifactAuthoritySelector): string {
  return selector.kind === "contract" ? `contract\u0000${selector.contract}` : `path\u0000${selector.id}`;
}

function agentChainForTask(
  config: ResolvedConfig,
  primary: ResolvedConfig["models"]["profiles"][string],
  sameAgentAttempts: number
): SmithersTaskManifestAgentChainEntry[] {
  const entry = (
    profile: ResolvedConfig["models"]["profiles"][string],
    role: SmithersTaskManifestAgentChainEntry["role"]
  ): SmithersTaskManifestAgentChainEntry => ({
    profileId: profile.id,
    agentRef: profile.agent,
    ...(profile.model === undefined ? {} : { modelName: profile.model }),
    ...(profile.reasoning === undefined ? {} : { reasoningEffort: profile.reasoning }),
    role
  });
  retryChainAttemptCount(config, primary.id, sameAgentAttempts);
  return [
    ...Array.from({ length: sameAgentAttempts }, () => entry(primary, "primary")),
    ...retryFallbackProfileIds(config, primary.id).map((profileId) =>
      entry(config.models.profiles[profileId]!, "fallback")
    )
  ];
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
  agent: ResolvedConfig["agents"][string] | undefined,
  configuredAgents: ResolvedConfig["agents"],
  env: NodeJS.ProcessEnv
): string[] {
  if (executionMode !== "cloud" || agent === undefined) return [];
  const names = agent.auth === "api-key" && agent.apiKeyEnv !== undefined ? [agent.apiKeyEnv] : [];
  if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
  const routes = effectiveRouteEnvironment(agentRef, env);
  const configuredCredentials = configuredAgentCredentialEnvironmentVariableNames(configuredAgents);
  let hasSensitiveExtra = false;
  const extra = allowlistedCloudEnvironmentEntries(env).filter(([name, value]) => {
    if (configuredCredentials.has(name.toUpperCase())) return false;
    const sensitive = isCredentialLikeEnvironmentVariableName(name) || isSensitiveSecretValue(value);
    if (sensitive && !routeOwnsCredentialLikeEnvironmentVariable(agentRef, name)) return false;
    if (sensitive) hasSensitiveExtra = true;
    return true;
  });
  names.push(...routes.map(([name]) => name), ...extra.map(([name]) => name));
  if (extra.length > 0) names.push("ULTRAFUZZ_AGENT_ENV_ALLOWLIST");
  if (hasSensitiveExtra) names.push("ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES");
  return [...new Set(names)].sort();
}

export function assertCurrentCloudAgentCredentialEnvironment(
  config: ResolvedConfig,
  tasks: readonly SmithersTaskManifestTask[],
  env: NodeJS.ProcessEnv
): void {
  if (config.execution.mode !== "cloud") return;
  for (const task of tasks) {
    const expected = [
      ...new Set(
        task.agentChain.flatMap((entry) =>
          cloudAgentCredentialEnv(
            config.execution.mode,
            entry.agentRef,
            config.agents[entry.agentRef],
            config.agents,
            env
          )
        )
      )
    ].sort();
    const sealed = [...new Set(task.execution.agentCredentialEnv)].sort();
    if (JSON.stringify(expected) !== JSON.stringify(sealed)) {
      throw new Error(
        `cloud agent credential classification changed after workflow compilation for task ${task.smithersNodeId}; start a new run`
      );
    }
  }
}

function configuredAgentCredentialEnvironmentVariableNames(agents: ResolvedConfig["agents"]): Set<string> {
  const names = new Set<string>();
  for (const [agentRef, agent] of Object.entries(agents)) {
    if (agent.auth !== "api-key" || agent.apiKeyEnv === undefined) continue;
    names.add(agent.apiKeyEnv.toUpperCase());
    if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.add("MOONSHOT_API_KEY");
  }
  return names;
}

function allowlistedCloudEnvironmentEntries(env: NodeJS.ProcessEnv): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const normalizedNames = new Set<string>();
  for (const rawName of (env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",")) {
    const name = rawName.trim();
    if (name.length === 0) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
    }
    normalizedNames.add(name.toUpperCase());
  }
  for (const [name, value] of Object.entries(env)) {
    if (value?.trim() && normalizedNames.has(name.toUpperCase())) entries.push([name, value]);
  }
  return entries;
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

function referenceArtifactManifestAuthoritiesForAncestors(
  ancestorNodeIds: readonly string[],
  nodes: readonly ExpandedNode[],
  runLayout: RunLayout,
  cache: Map<string, SmithersTaskManifestReferenceArtifactManifestAuthority>
): SmithersTaskManifestReferenceArtifactManifestAuthority[] | undefined {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const authorities = ancestorNodeIds
    .flatMap((ancestorNodeId) => {
      const ancestor = nodesById.get(ancestorNodeId);
      if (ancestor === undefined) {
        throw new Error(
          `cannot seal reference artifact manifest for unknown ancestor ${JSON.stringify(ancestorNodeId)}`
        );
      }
      if (ancestor.kind !== "reference") return [];
      return nodeAttemptsFor(ancestor).map((attempt) => {
        const cached = cache.get(attempt.attemptId);
        if (cached !== undefined) return cached;
        const artifactDir = getNodeArtifactDir(runLayout, attempt.attemptId);
        const manifestPath = path.join(artifactDir, "artifact-manifest.json");
        const label = `reference artifact manifest for ${JSON.stringify(attempt.attemptId)}`;
        assertNoSymlinkComponents(runLayout.root, manifestPath, label);
        assertRegularFileInside(runLayout.root, manifestPath, label);
        const bytes = readRegularFileSnapshot(manifestPath, MAX_REFERENCE_ARTIFACT_MANIFEST_AUTHORITY_BYTES);
        if (bytes.byteLength === 0) throw new Error(`${label} must not be empty`);
        const authority = {
          attemptId: attempt.attemptId,
          artifactDir,
          sizeBytes: bytes.byteLength,
          sha256: sha256Bytes(bytes)
        } satisfies SmithersTaskManifestReferenceArtifactManifestAuthority;
        cache.set(attempt.attemptId, authority);
        return authority;
      });
    })
    .sort((left, right) => (left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0));
  return authorities.length === 0 ? undefined : authorities;
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

/**
 * Builds the "## Topology Runtime Context" block injected into every task prompt as
 * `task.runtimeContext`.
 *
 * The relative-seconds lines are unactionable on their own: a language model has no clock, so
 * "stop after 6900 seconds" cannot be checked. Long-running agentic nodes were consequently killed
 * at their timeout with no artifacts written at all (run reliability, #672/#677). Agentic nodes run
 * through a shell, so an ABSOLUTE UTC deadline is measurable where a duration is not.
 *
 * The deadline is expressed as an arithmetic RECIPE over a start time the agent observes itself,
 * never as a wall-clock timestamp resolved here. That is a hard constraint, not a stylistic
 * preference:
 *
 *   - This string is serialized into the generated workflow by `renderWorkflowSource`, and that
 *     file is hashed into the control seal (`workflow-integrity.ts`). Sealed content must be a pure
 *     function of the run inputs.
 *   - `writePreparedWorkflowFile` re-renders the workflow source and throws
 *     "existing generated Smithers workflow conflicts with the prepared workflow start" when the
 *     bytes differ from the file already on disk. A `Date.now()` in this block would therefore make
 *     every re-prepare of an existing run fail.
 *   - Generation happens once; nodes start hours later. A generation-time timestamp would already be
 *     wrong — often expired — by the time the node it governs begins.
 *
 * The same "agent resolves its own absolute deadlines from an observed start time" pattern is
 * already established by the invariant campaign plan (`backend_started_at`, `fuzzing_deadline_utc`,
 * `force_kill_deadline_utc`, `final_artifact_deadline_utc`).
 *
 * The three relative lines are kept verbatim: several strategy prompts instruct the agent to copy
 * the exact `Timeout` and `Finalization reserve` values out of this block.
 *
 * Every byte here is paid once per task in the run, because this block is part of the mandatory
 * prefix prepended to every prompt (`packages/prompts/test/agent-preamble.test.ts` pins its exact
 * length). The template text is therefore deliberately telegraphic; the reasoning lives in this
 * comment, which costs no prompt tokens. Keep new rationale here rather than in the MDX at
 * `.ultrafuzz/prompts/_templates/agent-preamble/topology-runtime-context.mdx`.
 */
export function topologyRuntimeContextForTimeout(timeoutMs: number): string {
  const { timeoutSeconds, finalizationReserveSeconds, workingBudgetSeconds } =
    topologyRuntimeBudgetForTimeout(timeoutMs);
  return renderAgentPreambleTemplate("topology-runtime-context", {
    timeout_seconds: String(timeoutSeconds),
    finalization_reserve_seconds: String(finalizationReserveSeconds),
    working_budget_seconds: String(workingBudgetSeconds)
  });
}

/**
 * The execution-only retained prompt binding for a task, if the compile produced one. Own-property
 * only: an attempt ID is never allowed to reach `Object.prototype` and yield a non-path value.
 */
function retainedTaskPromptPath(compiled: CompiledSmithersWorkflow, attemptId: string): string | undefined {
  const bindings = compiled.retainedPromptPaths;
  if (bindings === undefined || !Object.hasOwn(bindings, attemptId)) return undefined;
  return bindings[attemptId];
}

function renderWorkflowSource(compiled: CompiledSmithersWorkflow, config: ResolvedConfig): string {
  const controllerTasks = compiled.replacePromptSchemas
    ? compiled.tasks.map((task) => taskWithCurrentArtifactSchemas(task))
    : compiled.tasks;
  const controllerDynamicGroups = compiled.replacePromptSchemas
    ? compiled.dynamicGroups.map((group) => ({
        ...group,
        taskTemplates: group.taskTemplates.map((task) => taskWithCurrentArtifactSchemas(task))
      }))
    : compiled.dynamicGroups;
  const compiledTasks = JSON.stringify(controllerTasks, null, 2);
  const dynamicGroups = JSON.stringify(controllerDynamicGroups, null, 2);
  const nonBlockingAttemptIds = new Set(compiled.nonBlockingAttemptIds);
  const taskByArtifactDir = new Map<string, CompiledSmithersTask>();
  for (const task of controllerTasks) {
    const artifactDir = path.resolve(task.artifactDir);
    if (taskByArtifactDir.has(artifactDir)) {
      throw new Error(`multiple compiled tasks share artifact directory ${JSON.stringify(artifactDir)}`);
    }
    taskByArtifactDir.set(artifactDir, task);
  }
  const taskSpecs = JSON.stringify(
    controllerTasks.map((task) => ({
      id: task.smithersNodeId,
      smithersRunId: compiled.smithersRunId,
      preparationId: task.preparationSmithersNodeId,
      verifierId: task.verifierSmithersNodeId,
      attemptId: task.attemptId,
      continueOnFail: nonBlockingAttemptIds.has(task.attemptId),
      dependsOn: task.dependencySmithersNodeIds,
      agentRef: task.agentRef,
      agentChain: task.agentChain,
      modelName: task.modelName ?? null,
      reasoningEffort: task.reasoningEffort ?? null,
      prompt: "",
      promptPath:
        task.renderedPromptPath === undefined
          ? undefined
          : executionPath(
              compiled.projectRoot,
              task,
              retainedTaskPromptPath(compiled, task.attemptId) ?? task.renderedPromptPath,
              "rendered prompt"
            ),
      workspacePath: executionPath(compiled.projectRoot, task, task.workspacePath, "task workspace"),
      artifactDir: executionPath(compiled.projectRoot, task, task.artifactDir, "task artifact directory"),
      dependencyArtifactDirs: task.dependencyArtifactDirs.map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "dependency artifact directory")
      ),
      referenceArtifactDirs: (task.referenceArtifactDirs ?? []).map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "reference artifact directory")
      ),
      ...(task.vulnerabilityDatabaseCatalog === undefined
        ? {}
        : {
            vulnerabilityDatabase: {
              catalogPath: executionPath(
                compiled.projectRoot,
                task,
                task.vulnerabilityDatabaseCatalog.path,
                "vulnerability database catalog"
              ),
              catalogSha256: task.vulnerabilityDatabaseCatalog.sha256
            }
          }),
      optionalDependencyArtifactDirs: (task.optionalDependencyArtifactDirs ?? []).map((directory) =>
        executionPath(compiled.projectRoot, task, directory, "optional dependency artifact directory")
      ),
      dependencyVerificationProducers: dependencyVerificationProducersForTask(task, taskByArtifactDir),
      ...(task.promptArtifactAuthoritySelectors === undefined
        ? {}
        : { promptArtifactAuthoritySelectors: task.promptArtifactAuthoritySelectors }),
      runRoot: executionPath(compiled.projectRoot, task, path.resolve(task.artifactDir, "..", ".."), "run root"),
      workflowPath: executionPath(compiled.projectRoot, task, compiled.workflowPath, "workflow path"),
      sourceTaskManifestPath: compiled.tasksPath,
      sourceProjectRoot: compiled.projectRoot,
      sourceRevision: task.sourceRevision ?? null,
      sourceRef: task.sourceRef ?? null,
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
      dynamicStrategiesEnumeratorPolicy: config.dynamicStrategiesEnumerator,
      heartbeatTimeoutMs: task.heartbeatTimeoutMs,
      retries: task.retries,
      retryPolicy: {
        backoff: task.retryPolicy.backoff,
        initialDelayMs: task.retryPolicy.initialDelayMs
      },
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
    __ULTRAFUZZ_AGENT_PROMPT_TEMPLATE__: JSON.stringify(loadAgentPreambleTemplate("agent-prompt")),
    __ULTRAFUZZ_AUTHORIZED_DEFENSIVE_SECURITY_CONTEXT__: JSON.stringify(
      renderAgentPreambleTemplate("authorized-defensive-security-context")
    ),
    __ULTRAFUZZ_UNTRUSTED_CONTENT_BOUNDARY__: JSON.stringify(renderAgentPreambleTemplate("untrusted-content-boundary")),
    __ULTRAFUZZ_RETRY_FAILURE_TEMPLATE__: JSON.stringify(loadAgentPreambleTemplate("retry-failure")),
    __ULTRAFUZZ_RUN_ID__: compiled.runId,
    __ULTRAFUZZ_RUN_ID_LITERAL__: JSON.stringify(compiled.runId),
    __ULTRAFUZZ_SOURCE_PROJECT_ROOT__: JSON.stringify(compiled.projectRoot),
    __ULTRAFUZZ_RUN_ROOT_RELATIVE__: JSON.stringify(
      relativeProjectPath(compiled.projectRoot, compiled.runRoot, "run root")
    ),
    __ULTRAFUZZ_WORKFLOW_PATH_RELATIVE__: JSON.stringify(
      relativeProjectPath(compiled.projectRoot, compiled.workflowPath, "workflow path")
    ),
    __ULTRAFUZZ_COMPILED_TASKS__: compiledTasks,
    __ULTRAFUZZ_DYNAMIC_GROUPS__: dynamicGroups,
    __ULTRAFUZZ_MAX_DYNAMIC_NODES__: JSON.stringify(compiled.maxDynamicNodes),
    __ULTRAFUZZ_REPLACE_PROMPT_SCHEMAS__: JSON.stringify(compiled.replacePromptSchemas),
    __ULTRAFUZZ_TASK_SPECS__: taskSpecs,
    __ULTRAFUZZ_WORKFLOW_NAME__: JSON.stringify(compiled.workflowName)
  });
}

function taskWithCurrentArtifactSchemas(task: CompiledSmithersTask): CompiledSmithersTask {
  return {
    ...task,
    metadata: {
      ...task.metadata,
      artifacts: {
        ...task.metadata.artifacts,
        outputs: task.metadata.artifacts.outputs.map((output) => {
          const binding = artifactContractSchemaBinding(output.contract);
          return {
            path: output.path,
            contract: output.contract,
            contractDigest: artifactContractDefinition(output.contract).digest,
            primary: output.primary,
            ...(binding === undefined
              ? {}
              : {
                  schemaFile: binding.schema_file,
                  schemaId: binding.schema_id,
                  schemaSha256: binding.schema_sha256,
                  schemaBundleSha256: binding.schema_bundle_sha256,
                  validatorBuild: binding.validator_build
                })
          };
        })
      }
    }
  };
}

function dependencyVerificationProducersForTask(
  task: CompiledSmithersTask,
  taskByArtifactDir: ReadonlyMap<string, CompiledSmithersTask>
): Array<{ attemptId: string; verifierId: string; optional: boolean }> {
  const optionalArtifactDirs = new Set(
    (task.optionalDependencyArtifactDirs ?? []).map((directory) => path.resolve(directory))
  );
  return task.dependencyArtifactDirs.flatMap((directory) => {
    const producer = taskByArtifactDir.get(path.resolve(directory));
    if (producer === undefined) return [];
    return [
      {
        attemptId: producer.attemptId,
        verifierId: producer.verifierSmithersNodeId,
        optional: optionalArtifactDirs.has(path.resolve(directory))
      }
    ];
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
