import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import {
  packagedTopology,
  redactResolvedConfig,
  resolveConfig,
  serializeRedactedResolvedConfigToml
} from "@ultrafuzz/config";
import { builtInPromptRelativePaths, scaffoldPrompts } from "@ultrafuzz/prompts";
import { defaultReferenceCatalogYaml } from "@ultrafuzz/references";
import {
  AGENT_ADAPTER_RECOVERY_JSON_SCHEMA_ID,
  AGENT_ADAPTER_RECOVERY_SCHEMA_VERSION,
  MAX_AGENT_ADAPTER_RECOVERY_MARKER_BYTES,
  type AgentAdapterRecoveryDocument
} from "./runtime-contracts.js";
import { parseRuntimeDocumentBytes, serializeRuntimeDocument } from "./runtime-document-codec.js";
import { loadRuntimeTemplate } from "./runtime-template.js";
import { migrateStockSmithers032PackageManifest, renderSmithersPackageJson } from "./smithers-package.js";
import type { InitProjectInput, InitProjectResult, RuntimeDiagnostic } from "./types.js";
import { configDiagnostics, runtimeFailure, runtimeResult, toProjectRelative } from "./utils.js";
import { AGENT_REGISTRY_RELATIVE_PATH, agentRegistryRegisters, inspectAgentRegistry } from "./agent-registry.js";

const DEFAULT_TOPOLOGY = fs.readFileSync(packagedTopology("full").path, "utf8");

const MAX_STOCK_AGENT_ADAPTER_BYTES = 256 * 1024;
const AGENT_TEMPLATES = [
  {
    file: "claude.ts",
    template: "smithers/agents/claude.tsx",
    ref: "ClaudeAgent",
    stockSha256: new Set([
      "efee33db0341d979a412c2f66559700af4462241667a3f9587af857218b341c4",
      "f2b97c9b57aa45bdc3b42be20d7a3baddc0086a2bae95c161b841599f3262232",
      "6774e116b8efa175a20a53f8a645c7c9046f266bba974d0e4fab01c5d072c28b",
      "2cc5a7a75e23c40d3da5e80438a916e6f3671e794ef6023115d78c94fa03d210"
    ])
  },
  {
    file: "codex.ts",
    template: "smithers/agents/codex.tsx",
    ref: "CodexAgent",
    stockSha256: new Set([
      "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236",
      "b932fb7da3c05fdc662f60359e8a751aaabd236ca4072dfeaade1a7bb25a01b5",
      "f6497ac57506ec1af4c426711197d43fbbe6d5b5122eef9e8c6e438a6bd65c8e",
      "b2469baaaf5a0818dff321017200feef78e1e285c3f9adb96dcb7c958e5e835c",
      "bce18463addcd722bde69f3d1f46a0d98c7417e8b0fbc1dd64eaa81acc934019",
      "a80cc6ec499f983bbc3edae6d2c89682ce8ca7caa9546c6d79f1e80214e3360e",
      "84834b0d2dc0ac69bc7e76b1ac98b4ce7fba436a07c131920c4697a576014632",
      "4bfb080f3a20d758dec358cabd47a0ce7d1d4a6b6b55905c856e0911ae8590dc",
      "8b5c2db5a98f641a77a0c19b50fd94c7edf3dbebedb2de2126f98b878c74c55a",
      "e892c6384591a3324065016ab42d861daa521718183d091206a9032d484c8f6b"
    ])
  },
  {
    file: "deepseek.ts",
    template: "smithers/agents/deepseek.tsx",
    ref: "DeepSeekAgent",
    stockSha256: new Set([
      "c23a03c84e2f62d2e6b23ee7b27b1464a633fe20bb5b91c34d2c93d37dcf7e35",
      "1da0e8300e1b9f5c8311c14414acd3029b750fe70644c9d364c598ea460a08f2",
      "65bf43f333cbced8ff0157e942d3c78267d8245d6c0041e053c8577a463e7407"
    ])
  },
  {
    file: "kimi.ts",
    template: "smithers/agents/kimi.tsx",
    ref: "KimiAgent",
    stockSha256: new Set([
      "fdbeaad6ea55122da50e9c9d86ac58a8b6377f419f8e78df23fb1fb401924e0b",
      "8e9c9fee048d2ac7a04669d8999647ba460c27855959bb77cd2b7eb0ea1ac940",
      "6de5f4b00b54b533f8fc1aa0628f5a402dbb6521a4584852d83786ee59dcb2fd",
      "25c499f8631db6e2529b046b5d2243119b456696c7a4a729345baa6f21f4c4f5",
      "f790a3f121da84049032cfc5bf5d300f7bd56e9e3b15d0a51df5ea1b275de75f",
      "da76b1bedd041d2d0a93172e5d629fac566d0879df9720df1e2d0142439db44d"
    ])
  }
] as const;

export function initProject(input: InitProjectInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const created: string[] = [];
  const preserved: string[] = [];
  const overwritten: string[] = [];
  const upgradedStockAdapters: string[] = [];
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    assertNoSymlinkComponents(projectRoot, path.join(projectRoot, ".ultrafuzz"), "init root");
  } catch (error) {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_ROOT_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime",
        path: ".ultrafuzz"
      }
    ]);
  }

  for (const directory of [
    ".ultrafuzz",
    ".ultrafuzz/runs",
    ".ultrafuzz/workspaces",
    ".ultrafuzz/cache",
    ".ultrafuzz/prompts",
    ".smithers",
    ".smithers/agents",
    ".smithers/workflows"
  ]) {
    const absolute = path.join(projectRoot, directory);
    if (!fs.existsSync(absolute)) {
      fs.mkdirSync(absolute, { recursive: true });
      created.push(directory);
    }
  }

  const resolved = resolveConfig({ env: {} });
  if (!resolved.ok) {
    return runtimeFailure<InitProjectResult>(configDiagnostics(resolved.diagnostics));
  }
  const redacted = redactResolvedConfig(resolved.value);

  try {
    const stockSmithersPackageMigrated =
      input.force !== true && upgradeStockSmithersPackageManifest(projectRoot, created, preserved, overwritten);
    writeProjectFile(
      projectRoot,
      "ultrafuzz.toml",
      serializeRedactedResolvedConfigToml(redacted, { omitAuditProfileManagedSettings: true }),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".ultrafuzz/references.yml",
      defaultReferenceCatalogYaml(),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".ultrafuzz/topology.yml",
      DEFAULT_TOPOLOGY,
      input.force === true,
      created,
      preserved,
      overwritten
    );
    if (!stockSmithersPackageMigrated) {
      writeProjectFile(
        projectRoot,
        ".smithers/package.json",
        renderSmithersPackageJson(),
        input.force === true,
        created,
        preserved,
        overwritten
      );
    }
    writeProjectFile(
      projectRoot,
      ".smithers/agents/index.ts",
      loadRuntimeTemplate("smithers/agents/index.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/toml.ts",
      loadRuntimeTemplate("smithers/agents/toml.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/environment.ts",
      loadRuntimeTemplate("smithers/agents/environment.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/strict-json.ts",
      loadRuntimeTemplate("smithers/agents/strict-json.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    for (const agent of AGENT_TEMPLATES) {
      const relativePath = `.smithers/agents/${agent.file}`;
      const upgraded = writeProjectFile(
        projectRoot,
        relativePath,
        loadRuntimeTemplate(agent.template),
        input.force === true,
        created,
        preserved,
        overwritten,
        agent.stockSha256
      );
      if (upgraded) upgradedStockAdapters.push(relativePath);
    }
  } catch {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_PATH_UNSAFE",
        message: "initialization path is unsafe; remove unsafe generated files or rerun in a clean project",
        severity: "error",
        source: "runtime"
      }
    ]);
  }

  const promptFiles = builtInPromptRelativePaths().map((relativePath) =>
    path.join(projectRoot, ".ultrafuzz", "prompts", ...relativePath.split("/"))
  );
  const existedBefore = new Set(promptFiles.filter((filePath) => fs.existsSync(filePath)));
  let promptReport;
  try {
    promptReport = scaffoldPrompts(projectRoot, { replace: input.force === true });
  } catch (error) {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_PROMPT_PATH_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime",
        path: ".ultrafuzz/prompts"
      }
    ]);
  }
  for (const absolutePath of promptReport.written) {
    const relativePath = toProjectRelative(projectRoot, absolutePath);
    if (existedBefore.has(absolutePath)) {
      overwritten.push(relativePath);
    } else {
      created.push(relativePath);
    }
  }
  for (const absolutePath of promptReport.preserved) {
    preserved.push(toProjectRelative(projectRoot, absolutePath));
  }

  return runtimeResult(
    true,
    {
      project_root: projectRoot,
      created: publicInitPaths(created),
      preserved: publicInitPaths(preserved),
      overwritten: publicInitPaths(overwritten)
    },
    [
      ...upgradedStockAdapterDiagnostics(upgradedStockAdapters),
      ...staleAgentRegistryDiagnostics(projectRoot),
      ...staleAgentAdapterDiagnostics(projectRoot)
    ]
  );
}

function upgradeStockSmithersPackageManifest(
  projectRoot: string,
  created: string[],
  preserved: string[],
  overwritten: string[]
): boolean {
  const relativePath = ".smithers/package.json";
  const filePath = path.join(projectRoot, relativePath);
  const identity = lstatIfPresent(filePath);
  if (identity === undefined || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n) return false;
  try {
    const bytes = readStableInitReviewFile(projectRoot, filePath, 1024 * 1024, "generated Smithers package manifest");
    const parsed = parseStrictJsonBytes(bytes, {
      maxBytes: 1024 * 1024,
      maxDepth: 32,
      maxItems: 10_000,
      maxProperties: 10_000
    });
    const migrated = migrateStockSmithers032PackageManifest(parsed);
    if (migrated === undefined) return false;
    writeProjectFile(projectRoot, relativePath, migrated, true, created, preserved, overwritten);
    return true;
  } catch {
    // A custom or malformed manifest is project-owned: preserve it and let the
    // launch validator report the exact incompatibility without making init
    // destructive or unusable.
    return false;
  }
}

function upgradedStockAdapterDiagnostics(relativePaths: readonly string[]): RuntimeDiagnostic[] {
  return relativePaths.map((relativePath) => ({
    code: "INIT_STOCK_AGENT_ADAPTER_UPGRADED",
    message:
      "a byte-identical stock agent adapter was upgraded to use sealed workflow configuration and to withhold controller-only capabilities from model subprocesses; customized adapters are never upgraded automatically",
    severity: "info" as const,
    source: "runtime",
    path: relativePath
  }));
}

function staleAgentAdapterDiagnostics(projectRoot: string): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const agent of AGENT_TEMPLATES) {
    const relativePath = `.smithers/agents/${agent.file}`;
    const filePath = path.join(projectRoot, relativePath);
    try {
      const lexical = fs.lstatSync(filePath, { bigint: true });
      if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1n) {
        diagnostics.push(
          manualAgentAdapterReviewDiagnostic(
            relativePath,
            "is not a physical single-link file, so init preserved it without inspection; replace it with an ordinary file"
          )
        );
        continue;
      }
      if (lexical.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)) {
        diagnostics.push(
          manualAgentAdapterReviewDiagnostic(
            relativePath,
            "is too large to inspect as a generated adapter and was preserved"
          )
        );
        continue;
      }
      const source = readStableInitReviewFile(
        projectRoot,
        filePath,
        MAX_STOCK_AGENT_ADAPTER_BYTES,
        "generated agent adapter"
      ).toString("utf8");
      if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
        diagnostics.push({
          code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
          message: `${relativePath} was preserved because it is customized and still reads mutable project ultrafuzz.toml; update it to read process.env.ULTRAFUZZ_CONFIG_PATH and use workflowControlChildEnvironment before spawning a model process`,
          severity: "warning",
          source: "runtime",
          path: relativePath
        });
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      diagnostics.push(
        manualAgentAdapterReviewDiagnostic(relativePath, "could not be safely inspected during post-init review")
      );
    }
  }
  return diagnostics;
}

function manualAgentAdapterReviewDiagnostic(relativePath: string, reason: string): RuntimeDiagnostic {
  return {
    code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
    message: `${relativePath} ${reason}; verify manually that it reads process.env.ULTRAFUZZ_CONFIG_PATH and removes controller-only variables before spawning a model process`,
    severity: "warning",
    source: "runtime",
    path: relativePath
  };
}

// init preserves project-owned files, so a project scaffolded before an agent
// was added keeps its old registry: the new adapter lands on disk but nothing
// exports it, and the agent is only rejected later, at launch. Report it here
// instead of leaving the mismatch silent.
function staleAgentRegistryDiagnostics(projectRoot: string): RuntimeDiagnostic[] {
  const registry = inspectAgentRegistry(projectRoot);
  if (!registry.exists) return [];
  if (registry.error !== undefined) {
    // This runs after init may already have written other project files. Keep
    // the warning actionable without reflecting an OS/parser error that can
    // contain sensitive path or injected error details.
    return [
      manualAgentRegistryReviewDiagnostic("was preserved without inspection because it could not be safely inspected")
    ];
  }
  return AGENT_TEMPLATES.filter(
    (agent) =>
      lstatIfPresent(path.join(projectRoot, ".smithers", "agents", agent.file)) !== undefined &&
      !agentRegistryRegisters(registry, agent.ref)
  ).map((agent) => ({
    code: "INIT_AGENT_REGISTRY_STALE",
    message: `${AGENT_REGISTRY_RELATIVE_PATH} does not register ${agent.ref} in agentFactories, so runs cannot select it; rerun ultrafuzz init --force to regenerate the registry, or add the entry by hand`,
    severity: "warning" as const,
    source: "runtime",
    path: AGENT_REGISTRY_RELATIVE_PATH
  }));
}

function manualAgentRegistryReviewDiagnostic(reason: string): RuntimeDiagnostic {
  return {
    code: "INIT_AGENT_REGISTRY_REVIEW_REQUIRED",
    message: `${AGENT_REGISTRY_RELATIVE_PATH} ${reason}; verify manually that agentFactories registers every generated agent before starting a run`,
    severity: "warning",
    source: "runtime",
    path: AGENT_REGISTRY_RELATIVE_PATH
  };
}

function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
  force: boolean,
  created: string[],
  preserved: string[],
  overwritten: string[],
  knownStockSha256?: ReadonlySet<string>
): boolean {
  const filePath = path.join(projectRoot, relativePath);
  if (!force && knownStockSha256 !== undefined) {
    recoverInterruptedStockAgentAdapterPublication(projectRoot, filePath, knownStockSha256);
  }
  const existing = lstatIfPresent(filePath);
  if (existing !== undefined && !force) {
    if (
      knownStockSha256 !== undefined &&
      replaceKnownStockAgentAdapter(projectRoot, filePath, contents, knownStockSha256)
    ) {
      overwritten.push(relativePath);
      return true;
    }
    preserved.push(relativePath);
    return false;
  }
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  writeProjectFileNoFollow(projectRoot, filePath, contents, force, existing);
  if (existing !== undefined) overwritten.push(relativePath);
  else created.push(relativePath);
  return false;
}

function writeProjectFileNoFollow(
  projectRoot: string,
  filePath: string,
  contents: string,
  replaceExisting: boolean,
  expected: fs.BigIntStats | undefined
): void {
  const directoryPath = path.dirname(filePath);
  assertNoSymlinkComponents(projectRoot, directoryPath, "generated project file directory");
  const directoryDescriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    const directory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const lexicalDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !directory.isDirectory() ||
      !lexicalDirectory.isDirectory() ||
      directory.dev !== lexicalDirectory.dev ||
      directory.ino !== lexicalDirectory.ino
    ) {
      throw new Error("generated project file directory changed while it was opened");
    }
    let directoryAccessPath = directoryPath;
    try {
      // Anchor both creation and replacement to the opened directory whenever
      // a verifiable descriptor pseudo-path is available. This closes the
      // parent-directory swap window before an O_EXCL creation as well as the
      // corresponding replacement window.
      directoryAccessPath = agentAdapterDirectoryDescriptorPath(directoryDescriptor, directory);
    } catch (error) {
      // Descriptor pseudo-files are unavailable on Windows and on some
      // restricted Unix environments. The lexical fallback still opens
      // with O_NOFOLLOW where supported, validates the inode before
      // truncating, and rechecks both path and directory identity after the
      // write.
      if (!(error instanceof Error) || !/no verifiable descriptor path/u.test(error.message)) throw error;
      assertStableInitDirectory(directoryPath, directory, "generated project file directory changed");
    }
    const accessPath = path.join(directoryAccessPath, path.basename(filePath));
    const flags =
      expected === undefined
        ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
        : fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fileDescriptor = fs.openSync(accessPath, flags, 0o666);
    const opened = fs.fstatSync(fileDescriptor, { bigint: true });
    // Modal's virtual filesystem can report one device for an opened
    // directory and another for stable children created through that dirfd.
    // The child is authenticated against its lexical dev/ino below; requiring
    // it to share the parent's device rejects that valid, still-anchored shape.
    if (!opened.isFile() || opened.nlink !== 1n || (expected !== undefined && !sameStableInitFile(opened, expected))) {
      throw new Error("generated project file changed while it was opened");
    }
    const lexicalBeforeWrite = fs.lstatSync(filePath, { bigint: true });
    if (!sameStableInitFile(opened, lexicalBeforeWrite)) {
      throw new Error("generated project file changed before its contents could be replaced");
    }
    if (replaceExisting) fs.ftruncateSync(fileDescriptor, 0);
    // Ordinary scaffold files retain writeFileSync's prior durability
    // semantics; only the adapter publication sidecars use descriptor fsync.
    writeDescriptorContents(fileDescriptor, Buffer.from(contents, "utf8"));
    const completed = fs.fstatSync(fileDescriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    const currentDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !sameInitFileContentIdentity(opened, completed) ||
      completed.size !== BigInt(Buffer.byteLength(contents, "utf8")) ||
      !sameInitFileContentIdentity(opened, lexicalCompleted) ||
      lexicalCompleted.size !== BigInt(Buffer.byteLength(contents, "utf8")) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino
    ) {
      throw new Error("generated project file or its directory changed while it was written");
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (fileDescriptor !== undefined) closeDescriptorReliably(fileDescriptor, "generated project file");
  } catch (error) {
    failure ??= error;
  }
  try {
    closeDescriptorReliably(directoryDescriptor, "generated project file directory");
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function recoverInterruptedStockAgentAdapterPublication(
  projectRoot: string,
  filePath: string,
  knownStockSha256: ReadonlySet<string>
): void {
  const directoryPath = path.dirname(filePath);
  assertNoSymlinkComponents(projectRoot, directoryPath, "generated agent adapter recovery directory");
  const directoryDescriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  let failure: unknown;
  try {
    const directory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const lexicalDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !directory.isDirectory() ||
      !lexicalDirectory.isDirectory() ||
      directory.dev !== lexicalDirectory.dev ||
      directory.ino !== lexicalDirectory.ino
    ) {
      throw new Error("generated agent adapter recovery directory changed while it was opened");
    }
    const directoryAccessPath = agentAdapterDirectoryDescriptorPath(directoryDescriptor, directory);
    const basename = agentAdapterRecoveryTargetBasename(path.basename(filePath));
    const targetAccessPath = path.join(directoryAccessPath, basename);
    const preparedBasename = agentAdapterPreparedBasename(basename);
    const preparedAccessPath = path.join(directoryAccessPath, preparedBasename);
    const displacementBasename = agentAdapterDisplacementBasename(basename);
    const markerBasename = agentAdapterRecoveryMarkerBasename(basename);
    const displacementPath = path.join(directoryPath, displacementBasename);
    const displacementAccessPath = path.join(directoryAccessPath, displacementBasename);
    const markerPath = path.join(directoryPath, markerBasename);
    const markerAccessPath = path.join(directoryAccessPath, markerBasename);
    const markerIdentity = lstatIfPresent(markerAccessPath);
    const displacementIdentity = lstatIfPresent(displacementAccessPath);
    const orphanedPreparedIdentity = lstatIfPresent(preparedAccessPath);
    if (markerIdentity !== undefined || displacementIdentity !== undefined || orphanedPreparedIdentity !== undefined) {
      if (markerIdentity === undefined) {
        const targetIdentity = lstatIfPresent(targetAccessPath);
        if (targetIdentity === undefined) {
          throw new Error("generated agent adapter recovery reservation is incomplete");
        }
        if (displacementIdentity !== undefined) {
          if (
            !displacementIdentity.isFile() ||
            displacementIdentity.nlink !== 1n ||
            displacementIdentity.size !== 0n ||
            !removeOwnedAgentAdapterTemporaryFile(displacementAccessPath, displacementIdentity)
          ) {
            throw new Error("generated agent adapter recovery reservation is incomplete");
          }
        }
        if (orphanedPreparedIdentity !== undefined) {
          if (
            !orphanedPreparedIdentity.isFile() ||
            !removeOwnedAgentAdapterTemporaryFile(preparedAccessPath, orphanedPreparedIdentity)
          ) {
            throw new Error("generated agent adapter prepared recovery file is unsafe");
          }
        }
        if (displacementIdentity !== undefined || orphanedPreparedIdentity !== undefined) {
          fs.fsyncSync(directoryDescriptor);
        } else {
          throw new Error("generated agent adapter recovery reservation is incomplete");
        }
      } else {
        if (
          !markerIdentity.isFile() ||
          markerIdentity.nlink !== 1n ||
          markerIdentity.size > BigInt(MAX_AGENT_ADAPTER_RECOVERY_MARKER_BYTES)
        ) {
          throw new Error("generated agent adapter recovery marker is unsafe");
        }
        const markerContents = readStableInitReviewFile(
          projectRoot,
          markerPath,
          MAX_AGENT_ADAPTER_RECOVERY_MARKER_BYTES,
          "generated agent adapter recovery marker"
        );
        const marker = parseAgentAdapterRecoveryMarker(markerContents, basename);

        let targetIdentity = lstatIfPresent(targetAccessPath);
        if (targetIdentity === undefined) {
          if (
            displacementIdentity === undefined ||
            !displacementIdentity.isFile() ||
            displacementIdentity.nlink !== 1n ||
            displacementIdentity.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)
          ) {
            throw new Error("generated agent adapter recovery source is unavailable or unsafe");
          }
          try {
            fs.linkSync(displacementAccessPath, targetAccessPath);
          } catch (error) {
            if (!isNodeError(error) || error.code !== "EEXIST") throw error;
          }
          targetIdentity = fs.lstatSync(targetAccessPath, { bigint: true });
          if (!sameInitFileIdentity(targetIdentity, displacementIdentity)) {
            throw new Error("generated agent adapter recovery destination was concurrently replaced");
          }
          if (!removeOwnedAgentAdapterTemporaryFile(displacementAccessPath, displacementIdentity)) {
            throw new Error("generated agent adapter recovery source could not be removed");
          }
          fs.fsyncSync(directoryDescriptor);
        } else if (displacementIdentity !== undefined) {
          if (sameInitFileIdentity(targetIdentity, displacementIdentity)) {
            if (!removeOwnedAgentAdapterTemporaryFile(displacementAccessPath, displacementIdentity)) {
              throw new Error("generated agent adapter recovery source could not be removed");
            }
          } else {
            if (
              !displacementIdentity.isFile() ||
              displacementIdentity.nlink !== 1n ||
              displacementIdentity.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)
            ) {
              throw new Error("generated agent adapter recovery source is unsafe");
            }
            const displaced = readStableInitReviewFile(
              projectRoot,
              displacementPath,
              MAX_STOCK_AGENT_ADAPTER_BYTES,
              "generated agent adapter recovery source"
            );
            const displacedDigest = crypto.createHash("sha256").update(displaced).digest("hex");
            if (displaced.byteLength !== 0 && !knownStockSha256.has(displacedDigest)) {
              throw new Error("generated agent adapter recovery retained a concurrent customization");
            }
            if (!removeOwnedAgentAdapterTemporaryFile(displacementAccessPath, displacementIdentity)) {
              throw new Error("generated agent adapter recovery source could not be removed");
            }
          }
        }

        const markedPreparedAccessPath = path.join(directoryAccessPath, marker.temporary_basename);
        const preparedIdentity = lstatIfPresent(markedPreparedAccessPath);
        if (preparedIdentity !== undefined) {
          if (
            preparedIdentity.dev.toString() !== marker.temporary_dev ||
            preparedIdentity.ino.toString() !== marker.temporary_ino ||
            !removeOwnedAgentAdapterTemporaryFile(markedPreparedAccessPath, preparedIdentity)
          ) {
            throw new Error("generated agent adapter recovery temporary file is unsafe");
          }
        }
        const currentMarker = fs.lstatSync(markerAccessPath, { bigint: true });
        if (
          !sameInitFileIdentity(currentMarker, markerIdentity) ||
          !removeOwnedAgentAdapterTemporaryFile(markerAccessPath, markerIdentity)
        ) {
          throw new Error("generated agent adapter recovery marker could not be removed");
        }
        fs.fsyncSync(directoryDescriptor);
        assertStableInitDirectory(directoryPath, directory, "generated agent adapter recovery directory changed");
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    closeDescriptorReliably(directoryDescriptor, "generated agent adapter recovery directory");
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function agentAdapterDisplacementBasename(basename: string): string {
  return `.${basename}.ultrafuzz-init-previous`;
}

function agentAdapterPreparedBasename<Basename extends string>(
  basename: Basename
): `.${Basename}.ultrafuzz-init-prepared` {
  return `.${basename}.ultrafuzz-init-prepared`;
}

function agentAdapterRecoveryMarkerBasename(basename: string): string {
  return `.${basename}.ultrafuzz-init-recovery`;
}

function lstatIfPresent(filePath: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseAgentAdapterRecoveryMarker(contents: Buffer, targetBasename: string): AgentAdapterRecoveryDocument {
  try {
    if (contents.byteLength > MAX_AGENT_ADAPTER_RECOVERY_MARKER_BYTES) {
      throw new Error("generated agent adapter recovery marker exceeds its byte limit");
    }
    const parsed = parseRuntimeDocumentBytes(
      AGENT_ADAPTER_RECOVERY_JSON_SCHEMA_ID,
      contents,
      "generated agent adapter recovery marker"
    );
    assertAgentAdapterRecoveryMarkerTargetBinding(parsed, targetBasename);
    return parsed;
  } catch (cause) {
    throw new Error("generated agent adapter recovery marker is malformed", { cause });
  }
}

/** Bind the schema-valid marker to the sidecar path being recovered. */
function assertAgentAdapterRecoveryMarkerTargetBinding(
  marker: AgentAdapterRecoveryDocument,
  targetBasename: string
): void {
  if (
    marker.target_basename !== targetBasename ||
    marker.temporary_basename !== agentAdapterPreparedBasename(targetBasename)
  ) {
    throw new Error("generated agent adapter recovery marker targets a different adapter");
  }
}

function serializeAgentAdapterRecoveryMarker(marker: AgentAdapterRecoveryDocument, targetBasename: string): Buffer {
  const contents = Buffer.from(
    serializeRuntimeDocument(AGENT_ADAPTER_RECOVERY_JSON_SCHEMA_ID, marker, "generated agent adapter recovery marker"),
    "utf8"
  );
  // Validate the exact strict-JSON bytes that will be published, including the
  // contextual binding to this target, before creating the durable sidecar.
  parseAgentAdapterRecoveryMarker(contents, targetBasename);
  return contents;
}

function agentAdapterRecoveryTargetBasename(value: string): AgentAdapterRecoveryDocument["target_basename"] {
  if (!AGENT_TEMPLATES.some((entry) => entry.file === value)) {
    throw new Error(`generated agent adapter recovery target is unsupported: ${value}`);
  }
  return value as AgentAdapterRecoveryDocument["target_basename"];
}

function replaceKnownStockAgentAdapter(
  projectRoot: string,
  filePath: string,
  replacement: string,
  knownStockSha256: ReadonlySet<string>
): boolean {
  assertNoSymlinkComponents(projectRoot, path.dirname(filePath), "generated agent adapter directory");
  const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
  if (
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile() ||
    lexicalBefore.nlink !== 1n ||
    lexicalBefore.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)
  ) {
    return false;
  }

  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableInitFile(opened, lexicalBefore)) {
      throw new Error("generated agent adapter changed while it was opened");
    }
    const original = readBoundedDescriptor(descriptor, MAX_STOCK_AGENT_ADAPTER_BYTES, "generated agent adapter");
    const readCompleted = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    if (
      original.byteLength !== Number(opened.size) ||
      !sameStableInitFile(opened, readCompleted) ||
      !sameStableInitFile(opened, lexicalCompleted)
    ) {
      throw new Error("generated agent adapter changed while it was read");
    }
    const digest = crypto.createHash("sha256").update(original).digest("hex");
    if (!knownStockSha256.has(digest)) return false;

    publishAgentAdapterAtomically(
      projectRoot,
      filePath,
      descriptor,
      opened,
      original,
      Buffer.from(replacement, "utf8")
    );
    return true;
  } finally {
    closeDescriptorReliably(descriptor, "generated agent adapter");
  }
}

function publishAgentAdapterAtomically(
  projectRoot: string,
  filePath: string,
  originalDescriptor: number,
  original: fs.BigIntStats,
  originalContents: Buffer,
  replacement: Buffer
): void {
  const directoryPath = path.dirname(filePath);
  const directoryDescriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  let temporaryPath: string | undefined;
  let temporaryDescriptor: number | undefined;
  let temporaryIdentity: fs.BigIntStats | undefined;
  let displacementPath: string | undefined;
  let displacementDescriptor: number | undefined;
  let displacementIdentity: fs.BigIntStats | undefined;
  let recoveryMarkerPath: string | undefined;
  let recoveryMarkerDescriptor: number | undefined;
  let recoveryMarkerIdentity: fs.BigIntStats | undefined;
  let displacedIdentity: fs.BigIntStats | undefined;
  let displacedWasOriginal = false;
  let targetMoved = false;
  let targetLinked = false;
  // Once the displaced original is gone, the replacement is the only copy.
  // Later cleanup must never remove it: a failed final fsync or stability
  // check is recoverable on the next init, but an unmarked missing target is
  // not.
  let commitRetained = false;
  let commitDurable = false;
  let targetAccessPath: string | undefined;
  let published = false;
  let failure: unknown;
  try {
    const openedDirectory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const lexicalDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !openedDirectory.isDirectory() ||
      !lexicalDirectory.isDirectory() ||
      openedDirectory.dev !== lexicalDirectory.dev ||
      openedDirectory.ino !== lexicalDirectory.ino
    ) {
      throw new Error("generated agent adapter directory changed before atomic publication");
    }
    const directoryAccessPath = agentAdapterDirectoryDescriptorPath(directoryDescriptor, openedDirectory);
    targetAccessPath = path.join(directoryAccessPath, path.basename(filePath));

    temporaryPath = path.join(directoryAccessPath, agentAdapterPreparedBasename(path.basename(filePath)));
    temporaryDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      Number(original.mode & 0o7777n)
    );
    temporaryIdentity = fs.fstatSync(temporaryDescriptor, { bigint: true });
    // Publication uses hard links and renames between sibling files. Require
    // every sidecar to share the target file's device, which is the relevant
    // cross-device boundary even when the parent directory reports another.
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1n ||
      temporaryIdentity.size !== 0n ||
      temporaryIdentity.dev !== original.dev ||
      temporaryIdentity.uid !== original.uid ||
      temporaryIdentity.gid !== original.gid
    ) {
      throw new Error("generated agent adapter temporary publication file is not a matching regular file");
    }
    fs.fchmodSync(temporaryDescriptor, Number(original.mode & 0o7777n));
    temporaryIdentity = fs.fstatSync(temporaryDescriptor, { bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1n ||
      temporaryIdentity.size !== 0n ||
      temporaryIdentity.dev !== original.dev ||
      temporaryIdentity.mode !== original.mode ||
      temporaryIdentity.uid !== original.uid ||
      temporaryIdentity.gid !== original.gid
    ) {
      throw new Error("generated agent adapter temporary publication file is not a matching regular file");
    }

    writeNewDescriptorContents(temporaryDescriptor, replacement);
    const writtenTemporary = fs.fstatSync(temporaryDescriptor, { bigint: true });
    if (!isExpectedPublishedAgentAdapter(writtenTemporary, temporaryIdentity, original, replacement.byteLength)) {
      throw new Error("generated agent adapter temporary publication file changed while it was written");
    }

    displacementPath = path.join(directoryAccessPath, agentAdapterDisplacementBasename(path.basename(filePath)));
    displacementDescriptor = fs.openSync(
      displacementPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      Number(original.mode & 0o7777n)
    );
    displacementIdentity = fs.fstatSync(displacementDescriptor, { bigint: true });
    if (
      !displacementIdentity.isFile() ||
      displacementIdentity.nlink !== 1n ||
      displacementIdentity.size !== 0n ||
      displacementIdentity.dev !== original.dev
    ) {
      throw new Error("generated agent adapter displacement reservation is unsafe");
    }
    const targetBasename = agentAdapterRecoveryTargetBasename(path.basename(filePath));
    const recoveryMarkerContents = serializeAgentAdapterRecoveryMarker(
      {
        schema_version: AGENT_ADAPTER_RECOVERY_SCHEMA_VERSION,
        target_basename: targetBasename,
        temporary_basename: agentAdapterPreparedBasename(targetBasename),
        temporary_dev: temporaryIdentity.dev.toString(),
        temporary_ino: temporaryIdentity.ino.toString()
      },
      targetBasename
    );
    recoveryMarkerPath = path.join(directoryAccessPath, agentAdapterRecoveryMarkerBasename(targetBasename));
    recoveryMarkerDescriptor = fs.openSync(
      recoveryMarkerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600
    );
    writeNewDescriptorContents(recoveryMarkerDescriptor, recoveryMarkerContents);
    recoveryMarkerIdentity = fs.fstatSync(recoveryMarkerDescriptor, { bigint: true });
    if (
      !recoveryMarkerIdentity.isFile() ||
      recoveryMarkerIdentity.nlink !== 1n ||
      recoveryMarkerIdentity.size > BigInt(MAX_AGENT_ADAPTER_RECOVERY_MARKER_BYTES) ||
      recoveryMarkerIdentity.dev !== original.dev
    ) {
      throw new Error("generated agent adapter recovery marker is unsafe");
    }
    fs.fsyncSync(directoryDescriptor);

    const heldOriginal = fs.fstatSync(originalDescriptor, { bigint: true });
    const accessedOriginal = fs.lstatSync(targetAccessPath, { bigint: true });
    const lexicalOriginal = fs.lstatSync(filePath, { bigint: true });
    const lexicalTemporary = fs.lstatSync(temporaryPath, { bigint: true });
    const lexicalDisplacement = fs.lstatSync(displacementPath, { bigint: true });
    const lexicalRecoveryMarker = fs.lstatSync(recoveryMarkerPath, { bigint: true });
    const currentDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !sameStableInitFile(original, heldOriginal) ||
      !sameStableInitFile(original, accessedOriginal) ||
      !sameStableInitFile(original, lexicalOriginal) ||
      !isExpectedPublishedAgentAdapter(lexicalTemporary, temporaryIdentity, original, replacement.byteLength) ||
      !sameStableInitFile(displacementIdentity, lexicalDisplacement) ||
      !sameStableInitFile(recoveryMarkerIdentity, lexicalRecoveryMarker) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== openedDirectory.dev ||
      currentDirectory.ino !== openedDirectory.ino
    ) {
      throw new Error("generated agent adapter or its directory changed before atomic publication");
    }
    assertNoSymlinkComponents(projectRoot, directoryPath, "generated agent adapter directory");

    // Node does not expose renameat2(RENAME_EXCHANGE). Move the named target
    // into an owned reservation first, then validate the displaced inode. If a
    // concurrent customization won the race, restore it with link(2), whose
    // EEXIST behavior is the no-replace primitive used for both rollback and
    // publication. The target can be absent for this bounded synchronous
    // section, but a competing installer is never overwritten.
    fs.renameSync(targetAccessPath, displacementPath);
    targetMoved = true;
    displacedIdentity = fs.lstatSync(displacementPath, { bigint: true });
    const heldAfterMove = fs.fstatSync(originalDescriptor, { bigint: true });
    const heldContentsAfterMove = readBoundedDescriptor(
      originalDescriptor,
      MAX_STOCK_AGENT_ADAPTER_BYTES,
      "generated agent adapter"
    );
    displacedWasOriginal =
      sameInitFileAcrossRename(original, heldAfterMove) &&
      sameStableInitFile(heldAfterMove, displacedIdentity) &&
      heldContentsAfterMove.equals(originalContents);
    if (!displacedWasOriginal) {
      if (restoreDisplacedAgentAdapterNoReplace(displacementPath, targetAccessPath, displacedIdentity)) {
        displacementPath = undefined;
      }
      throw new Error("generated agent adapter changed during compare-and-swap publication");
    }

    try {
      fs.linkSync(temporaryPath, targetAccessPath);
      targetLinked = true;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error("generated agent adapter destination was concurrently replaced before publication", {
          cause: error
        });
      }
      throw error;
    }

    verifyPublishedAgentAdapter(targetAccessPath, filePath, temporaryIdentity, original, replacement, 2n);
    // Make the complete target/prepared/displacement/marker projection
    // durable before any recovery sidecar is removed. A restart can then
    // deterministically finish from the marker at every later boundary.
    fs.fsyncSync(directoryDescriptor);
    if (!removeOwnedAgentAdapterTemporaryFile(temporaryPath, temporaryIdentity)) {
      throw new Error("generated agent adapter temporary publication file could not be removed");
    }
    temporaryPath = undefined;
    verifyPublishedAgentAdapter(targetAccessPath, filePath, temporaryIdentity, original, replacement, 1n);
    if (!removeOwnedAgentAdapterTemporaryFile(displacementPath, displacedIdentity)) {
      throw new Error("generated agent adapter displaced stock file could not be removed");
    }
    displacementPath = undefined;
    commitRetained = true;
    // The target is now the only published copy. Persist that fact before
    // removing the marker; otherwise a crash could leave a durable marker
    // projection with an absent displacement, or (worse) an absent marker
    // with a nondurable displacement removal that recovery cannot classify.
    fs.fsyncSync(directoryDescriptor);
    commitDurable = true;
    if (!removeOwnedAgentAdapterTemporaryFile(recoveryMarkerPath, recoveryMarkerIdentity)) {
      throw new Error("generated agent adapter recovery marker could not be removed");
    }
    recoveryMarkerPath = undefined;
    fs.fsyncSync(directoryDescriptor);
    assertStableInitDirectory(
      directoryPath,
      openedDirectory,
      "generated agent adapter directory changed during publication"
    );
    verifyPublishedAgentAdapter(targetAccessPath, filePath, temporaryIdentity, original, replacement, 1n);
    published = true;
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  const cleanup = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      cleanupFailures.push(error);
    }
  };

  if (
    !published &&
    !commitRetained &&
    targetLinked &&
    temporaryIdentity !== undefined &&
    targetAccessPath !== undefined
  ) {
    const targetIdentity = temporaryIdentity;
    const anchoredTargetPath = targetAccessPath;
    cleanup(() => {
      if (displacementPath === undefined || displacedIdentity === undefined || !displacedWasOriginal) return;
      const displaced = lstatIfPresent(displacementPath);
      if (displaced === undefined || !sameInitFileIdentity(displaced, displacedIdentity)) return;
      const current = lstatIfPresent(anchoredTargetPath);
      if (current !== undefined && !sameInitFileIdentity(current, targetIdentity)) return;
      if (current !== undefined && !removeOwnedAgentAdapterTemporaryFile(anchoredTargetPath, targetIdentity)) return;
      if (!restoreDisplacedAgentAdapterNoReplace(displacementPath, anchoredTargetPath, displacedIdentity)) {
        throw new Error("generated agent adapter stock source could not be restored without replacement");
      }
      displacementPath = undefined;
    });
  }
  if (
    targetMoved &&
    !targetLinked &&
    displacementPath !== undefined &&
    displacedIdentity !== undefined &&
    targetAccessPath !== undefined
  ) {
    if (displacedWasOriginal) {
      const anchoredTargetPath = targetAccessPath;
      cleanup(() => {
        if (!restoreDisplacedAgentAdapterNoReplace(displacementPath!, anchoredTargetPath, displacedIdentity!)) {
          throw new Error("generated agent adapter stock source could not be restored without replacement");
        }
        displacementPath = undefined;
      });
    }
    // A mismatching displaced inode is a concurrent customization. If another
    // writer also occupied the target before restoration, retain this random
    // recovery path rather than deleting project-owned bytes.
  } else if (!targetMoved && displacementPath !== undefined) {
    cleanup(() => {
      displacementIdentity ??= fs.fstatSync(displacementDescriptor!, { bigint: true });
      if (!removeOwnedAgentAdapterTemporaryFile(displacementPath!, displacementIdentity)) {
        throw new Error("generated agent adapter displacement reservation could not be removed");
      }
      displacementPath = undefined;
    });
  }
  if (temporaryPath !== undefined) {
    cleanup(() => {
      temporaryIdentity ??= fs.fstatSync(temporaryDescriptor!, { bigint: true });
      if (!removeOwnedAgentAdapterTemporaryFile(temporaryPath!, temporaryIdentity)) {
        throw new Error("generated agent adapter temporary publication file could not be removed");
      }
      temporaryPath = undefined;
    });
  }
  if (
    recoveryMarkerPath !== undefined &&
    displacementPath === undefined &&
    temporaryPath === undefined &&
    (!commitRetained || commitDurable || published)
  ) {
    cleanup(() => {
      recoveryMarkerIdentity ??= fs.fstatSync(recoveryMarkerDescriptor!, { bigint: true });
      if (!removeOwnedAgentAdapterTemporaryFile(recoveryMarkerPath!, recoveryMarkerIdentity)) {
        throw new Error("generated agent adapter recovery marker could not be removed");
      }
      recoveryMarkerPath = undefined;
    });
  }
  if (temporaryDescriptor !== undefined) {
    cleanup(() => closeDescriptorReliably(temporaryDescriptor!, "generated agent adapter publication file"));
  }
  if (displacementDescriptor !== undefined) {
    cleanup(() => closeDescriptorReliably(displacementDescriptor!, "generated agent adapter displacement file"));
  }
  if (recoveryMarkerDescriptor !== undefined) {
    cleanup(() => closeDescriptorReliably(recoveryMarkerDescriptor!, "generated agent adapter recovery marker"));
  }
  cleanup(() => closeDescriptorReliably(directoryDescriptor, "generated agent adapter directory"));

  if (failure !== undefined) throw failure;
  if (cleanupFailures.length > 0) {
    throw new Error("generated agent adapter publication cleanup failed", { cause: cleanupFailures[0] });
  }
}

function agentAdapterDirectoryDescriptorPath(descriptor: number, directory: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = fs.statSync(candidate, { bigint: true });
      if (accessed.isDirectory() && accessed.dev === directory.dev && accessed.ino === directory.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  throw new Error("generated agent adapter directory has no verifiable descriptor path");
}

function isExpectedPublishedAgentAdapter(
  candidate: fs.BigIntStats,
  identity: fs.BigIntStats,
  original: fs.BigIntStats,
  byteLength: number,
  expectedLinks = 1n
): boolean {
  return (
    candidate.isFile() &&
    candidate.nlink === expectedLinks &&
    candidate.dev === identity.dev &&
    candidate.ino === identity.ino &&
    candidate.mode === original.mode &&
    candidate.uid === original.uid &&
    candidate.gid === original.gid &&
    candidate.size === BigInt(byteLength)
  );
}

function verifyPublishedAgentAdapter(
  accessPath: string,
  lexicalPath: string,
  identity: fs.BigIntStats,
  original: fs.BigIntStats,
  replacement: Buffer,
  expectedLinks: bigint
): void {
  const accessedBefore = fs.lstatSync(accessPath, { bigint: true });
  const lexicalBefore = fs.lstatSync(lexicalPath, { bigint: true });
  if (
    !isExpectedPublishedAgentAdapter(accessedBefore, identity, original, replacement.byteLength, expectedLinks) ||
    !isExpectedPublishedAgentAdapter(lexicalBefore, identity, original, replacement.byteLength, expectedLinks)
  ) {
    throw new Error("generated agent adapter publication did not retain its prepared identity");
  }
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const contents = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const accessedCompleted = fs.lstatSync(accessPath, { bigint: true });
    const lexicalCompleted = fs.lstatSync(lexicalPath, { bigint: true });
    if (
      !isExpectedPublishedAgentAdapter(opened, identity, original, replacement.byteLength, expectedLinks) ||
      !sameStableInitFile(opened, completed) ||
      !sameStableInitFile(opened, accessedCompleted) ||
      !sameStableInitFile(opened, lexicalCompleted) ||
      !contents.equals(replacement)
    ) {
      throw new Error("generated agent adapter publication failed byte and identity verification");
    }
  } finally {
    closeDescriptorReliably(descriptor, "published generated agent adapter");
  }
}

function restoreDisplacedAgentAdapterNoReplace(
  displacedPath: string,
  targetPath: string,
  displacedIdentity: fs.BigIntStats
): boolean {
  try {
    fs.linkSync(displacedPath, targetPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    try {
      const current = fs.lstatSync(targetPath, { bigint: true });
      if (!sameInitFileIdentity(current, displacedIdentity)) return false;
    } catch {
      return false;
    }
  }
  const restored = fs.lstatSync(targetPath, { bigint: true });
  if (!sameInitFileIdentity(restored, displacedIdentity)) return false;
  return removeOwnedAgentAdapterTemporaryFile(displacedPath, displacedIdentity);
}

function removeOwnedAgentAdapterTemporaryFile(filePath: string, identity: fs.BigIntStats): boolean {
  try {
    const lexical = fs.lstatSync(filePath, { bigint: true });
    if (lexical.isFile() && lexical.dev === identity.dev && lexical.ino === identity.ino) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    // Cleanup is best effort and never follows or removes a replacement inode.
    return false;
  }
}

function readStableInitReviewFile(projectRoot: string, filePath: string, maxBytes: number, label: string): Buffer {
  assertNoSymlinkComponents(projectRoot, path.dirname(filePath), `${label} directory`);
  const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
  if (
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile() ||
    lexicalBefore.nlink !== 1n ||
    lexicalBefore.size > BigInt(maxBytes)
  ) {
    throw new Error(`${label} is not a bounded physical single-link file`);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maxBytes)) {
      throw new Error(`${label} is not a bounded physical single-link file`);
    }
    const contents = readBoundedDescriptor(descriptor, maxBytes, label);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      contents.byteLength !== Number(opened.size) ||
      !sameStableInitFile(opened, lexicalBefore) ||
      !sameStableInitFile(opened, completed) ||
      !sameStableInitFile(opened, lexicalCompleted)
    ) {
      throw new Error(`${label} changed while it was inspected`);
    }
    return contents;
  } finally {
    closeDescriptorReliably(descriptor, label);
  }
}

function readBoundedDescriptor(descriptor: number, maxBytes: number, label: string): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const remaining = maxBytes + 1 - offset;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  throw new Error(`${label} exceeds the safe inspection limit`);
}

function closeDescriptorReliably(descriptor: number, label: string): void {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    // POSIX leaves descriptor state unspecified when close(2) reports an
    // error. Retrying can close an unrelated descriptor if the number was
    // already recycled, so callers aggregate this error while continuing all
    // other independent cleanup steps.
    throw new Error(`${label} descriptor could not be closed`, { cause: error });
  }
}

function sameInitFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameInitFileContentIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function sameInitFileAcrossRename(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameInitFileIdentity(left, right) &&
    left.isFile() === right.isFile() &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertStableInitDirectory(directoryPath: string, expected: fs.BigIntStats, message: string): void {
  const current = fs.lstatSync(directoryPath, { bigint: true });
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(message);
  }
}

function sameStableInitFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function writeNewDescriptorContents(descriptor: number, contents: Buffer): void {
  writeDescriptorContents(descriptor, contents);
  fs.fsyncSync(descriptor);
}

function writeDescriptorContents(descriptor: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.byteLength) {
    const written = fs.writeSync(descriptor, contents, offset, contents.byteLength - offset, offset);
    if (written === 0) throw new Error("generated agent adapter stopped accepting replacement bytes");
    offset += written;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function publicInitPaths(values: string[]): string[] {
  return uniqueSorted(values).filter((value) => !value.toLowerCase().includes("smithers"));
}
